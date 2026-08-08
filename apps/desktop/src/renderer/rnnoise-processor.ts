import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import { Track, type AudioProcessorOptions, type TrackProcessor } from "livekit-client";

let rnnoiseBinary: Promise<ArrayBuffer> | null = null;
const registeredContexts = new WeakMap<AudioContext, Promise<void>>();

function loadBinary(): Promise<ArrayBuffer> {
  rnnoiseBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  return rnnoiseBinary;
}

function registerWorklet(audioContext: AudioContext): Promise<void> {
  const existing = registeredContexts.get(audioContext);
  if (existing) return existing;
  const registration = audioContext.audioWorklet.addModule(rnnoiseWorkletUrl);
  registeredContexts.set(audioContext, registration);
  return registration;
}

export class FreeCordRnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "freecord-rnnoise";
  processedTrack?: MediaStreamTrack;

  private source?: MediaStreamAudioSourceNode;
  private suppressor?: RnnoiseWorkletNode;
  private destination?: MediaStreamAudioDestinationNode;
  private audioContext?: AudioContext;

  async init({ track, audioContext }: AudioProcessorOptions): Promise<void> {
    if (!audioContext.audioWorklet) throw new Error("AudioWorklet is unavailable on this system.");
    if (audioContext.sampleRate !== 48_000) {
      throw new Error(`RNNoise requires a 48 kHz audio context (received ${audioContext.sampleRate} Hz).`);
    }

    this.audioContext = audioContext;
    const [wasmBinary] = await Promise.all([loadBinary(), registerWorklet(audioContext)]);
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.suppressor = new RnnoiseWorkletNode(audioContext, { wasmBinary, maxChannels: 1 });
    this.destination = audioContext.createMediaStreamDestination();
    this.source.connect(this.suppressor);
    this.suppressor.connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
    if (!this.processedTrack) throw new Error("RNNoise did not produce an audio track.");
  }

  async restart(options: AudioProcessorOptions): Promise<void> {
    // LiveKit 2.21 omits audioContext from its internal track-restart callback,
    // despite the public AudioProcessorOptions type requiring it.
    const audioContext = options.audioContext ?? this.audioContext;
    if (!audioContext) throw new Error("RNNoise lost its audio context during microphone restart.");
    await this.destroy();
    await this.init({ ...options, audioContext });
  }

  async destroy(): Promise<void> {
    this.processedTrack?.stop();
    this.source?.disconnect();
    this.suppressor?.disconnect();
    this.suppressor?.destroy();
    this.destination?.disconnect();
    this.source = undefined;
    this.suppressor = undefined;
    this.destination = undefined;
    this.processedTrack = undefined;
    this.audioContext = undefined;
  }
}
