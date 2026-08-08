import {
  createAudioAnalyser,
  DataPacket_Kind,
  Track,
  type LocalAudioTrack,
  type RemoteParticipant,
} from "livekit-client";

export const SPEAKING_SIGNAL_TOPIC = "freecord.voice.speaking.v1";

const MAX_PAYLOAD_BYTES = 64;
const SAMPLE_INTERVAL_MS = 40;
const SPEAKING_HEARTBEAT_MS = 600;
const REMOTE_HINT_TTL_MS = 1_500;
const MAX_PACKETS_PER_SECOND = 10;
const ATTACK_SAMPLES = 2;
const RELEASE_SAMPLES = 5;

interface SpeakingPacket {
  v: 1;
  s: 0 | 1;
  n: number;
}

interface RemoteSpeakingHint {
  sequence: number;
  speaking: boolean;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface PacketRateWindow {
  startedAt: number;
  count: number;
}

function sensitivityThresholdDb(inputSensitivity: number): number {
  const sensitivity = Math.max(0, Math.min(1, inputSensitivity));
  return -32 - (28 * sensitivity);
}

function parseSpeakingPacket(payload: Uint8Array): SpeakingPacket | null {
  if (payload.byteLength === 0 || payload.byteLength > MAX_PAYLOAD_BYTES) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 3 || !keys.every((key) => key === "v" || key === "s" || key === "n")) return null;
    const parsed = value as Partial<SpeakingPacket>;
    if (parsed.v !== 1 || (parsed.s !== 0 && parsed.s !== 1)) return null;
    if (!Number.isSafeInteger(parsed.n) || (parsed.n ?? -1) < 0) return null;
    return parsed as SpeakingPacket;
  } catch {
    return null;
  }
}

export class LocalSpeakingSignal {
  private generation = 0;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private analyserCleanup: (() => Promise<void>) | null = null;
  private timeDomainData: Float32Array<ArrayBuffer> | null = null;
  private thresholdDb = sensitivityThresholdDb(0.5);
  private positiveSamples = 0;
  private negativeSamples = 0;
  private speaking = false;
  private sequence = 0;

  constructor(
    private readonly publish: (payload: Uint8Array<ArrayBuffer>) => Promise<void>,
    private readonly onSpeakingChanged: (speaking: boolean) => void,
  ) {}

  get active(): boolean {
    return this.speaking;
  }

  setSensitivity(inputSensitivity: number): void {
    this.thresholdDb = sensitivityThresholdDb(inputSensitivity);
  }

  async start(track: LocalAudioTrack, inputSensitivity: number): Promise<void> {
    const generation = ++this.generation;
    await this.clearCurrent(false);
    if (generation !== this.generation) return;
    this.setSensitivity(inputSensitivity);

    const { analyser, cleanup } = createAudioAnalyser(track, {
      cloneTrack: false,
      fftSize: 512,
      smoothingTimeConstant: 0.15,
      minDecibels: -100,
      maxDecibels: -10,
    });
    if (generation !== this.generation) {
      await cleanup();
      return;
    }

    this.analyserCleanup = cleanup;
    this.timeDomainData = new Float32Array(analyser.fftSize);
    const audioContext = analyser.context as AudioContext;
    if (audioContext.state === "suspended") void audioContext.resume().catch(() => undefined);
    this.sampleTimer = setInterval(() => {
      if (generation !== this.generation || !this.timeDomainData) return;
      analyser.getFloatTimeDomainData(this.timeDomainData);
      let sumSquares = 0;
      for (const sample of this.timeDomainData) sumSquares += sample * sample;
      const rms = Math.sqrt(sumSquares / this.timeDomainData.length);
      const levelDb = 20 * Math.log10(Math.max(rms, 1e-8));
      this.observe(levelDb >= this.thresholdDb);
    }, SAMPLE_INTERVAL_MS);
  }

  async stop(publishStop = true): Promise<void> {
    this.generation += 1;
    await this.clearCurrent(publishStop);
  }

  private async clearCurrent(publishStop: boolean): Promise<void> {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.sampleTimer = null;
    this.heartbeatTimer = null;
    this.timeDomainData = null;
    this.positiveSamples = 0;
    this.negativeSamples = 0;
    const cleanup = this.analyserCleanup;
    this.analyserCleanup = null;
    if (this.speaking) {
      this.speaking = false;
      this.onSpeakingChanged(false);
      if (publishStop) await this.send(false);
    }
    if (cleanup) await cleanup().catch(() => undefined);
  }

  private observe(positive: boolean): void {
    if (positive) {
      this.positiveSamples += 1;
      this.negativeSamples = 0;
      if (!this.speaking && this.positiveSamples >= ATTACK_SAMPLES) this.setSpeaking(true);
      return;
    }

    this.negativeSamples += 1;
    this.positiveSamples = 0;
    if (this.speaking && this.negativeSamples >= RELEASE_SAMPLES) this.setSpeaking(false);
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.onSpeakingChanged(speaking);
    void this.send(speaking);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = speaking
      ? setInterval(() => void this.send(true), SPEAKING_HEARTBEAT_MS)
      : null;
  }

  private async send(speaking: boolean): Promise<void> {
    const packet: SpeakingPacket = { v: 1, s: speaking ? 1 : 0, n: this.sequence++ };
    const payload = new TextEncoder().encode(JSON.stringify(packet));
    if (payload.byteLength <= MAX_PAYLOAD_BYTES) await this.publish(payload).catch(() => undefined);
  }
}

export class RemoteSpeakingSignals {
  private readonly hints = new Map<string, RemoteSpeakingHint>();
  private readonly packetRates = new Map<string, PacketRateWindow>();

  constructor(private readonly onChanged: () => void) {}

  isSpeaking(identity: string): boolean {
    const hint = this.hints.get(identity);
    return Boolean(hint?.speaking && hint.expiresAt > Date.now());
  }

  receive(
    payload: Uint8Array,
    participant: RemoteParticipant | undefined,
    kind: DataPacket_Kind | undefined,
    topic: string | undefined,
  ): boolean {
    if (topic !== SPEAKING_SIGNAL_TOPIC || kind !== DataPacket_Kind.LOSSY || !participant) return false;

    const now = Date.now();
    const previousRate = this.packetRates.get(participant.identity);
    const inCurrentWindow = Boolean(previousRate && now - previousRate.startedAt < 1_000);
    const rate = inCurrentWindow
      ? { startedAt: previousRate!.startedAt, count: previousRate!.count + 1 }
      : { startedAt: now, count: 1 };
    this.packetRates.set(participant.identity, rate);
    if (rate.count > MAX_PACKETS_PER_SECOND) return false;

    const current = this.hints.get(participant.identity);
    const microphone = participant.getTrackPublication(Track.Source.Microphone);
    if (!microphone || microphone.isMuted || !microphone.track) return false;
    const packet = parseSpeakingPacket(payload);
    if (!packet || (current && packet.n <= current.sequence)) return false;

    if (current?.expiryTimer) clearTimeout(current.expiryTimer);
    const speaking = packet.s === 1;
    const next: RemoteSpeakingHint = {
      sequence: packet.n,
      speaking,
      expiresAt: speaking ? now + REMOTE_HINT_TTL_MS : now,
      expiryTimer: null,
    };
    if (speaking) {
      next.expiryTimer = setTimeout(() => {
        const latest = this.hints.get(participant.identity);
        if (!latest || latest.sequence !== packet.n) return;
        latest.speaking = false;
        latest.expiryTimer = null;
        this.onChanged();
      }, REMOTE_HINT_TTL_MS);
    }
    this.hints.set(participant.identity, next);
    if (current?.speaking !== speaking) this.onChanged();
    return true;
  }

  clear(identity: string): void {
    const current = this.hints.get(identity);
    this.packetRates.delete(identity);
    if (!current) return;
    if (current.expiryTimer) clearTimeout(current.expiryTimer);
    this.hints.delete(identity);
    if (current.speaking) this.onChanged();
  }

  clearAll(): void {
    let changed = false;
    this.hints.forEach((hint) => {
      if (hint.expiryTimer) clearTimeout(hint.expiryTimer);
      changed ||= hint.speaking;
    });
    this.hints.clear();
    this.packetRates.clear();
    if (changed) this.onChanged();
  }
}
