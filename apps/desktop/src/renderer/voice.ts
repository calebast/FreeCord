import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  LocalAudioTrack,
  type RemoteParticipant,
  type LocalTrack,
  type LocalVideoTrack,
  type RemoteAudioTrack,
  type RemoteVideoTrack,
  type RemoteTrack,
  type RoomEventCallbacks,
  type AudioCaptureOptions,
} from "livekit-client";
import type { AudioSettings, VoiceTokenResponse } from "../shared/bridge";
import { FreeCordRnnoiseProcessor } from "./rnnoise-processor";
import { LocalSpeakingSignal, RemoteSpeakingSignals, SPEAKING_SIGNAL_TOPIC } from "./speaking-signal";

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export interface VoiceParticipantState {
  identity: string;
  name: string;
  speaking: boolean;
  volume: number;
  muted: boolean;
  deafened: boolean;
}

export type ScreenShareResolution = 720 | 1080 | 1440;
export type ScreenShareFrameRate = 30 | 60;
export type ScreenShareBitrate = 4 | 6 | 8;
export type ScreenSharePhase = "idle" | "selecting" | "publishing-video" | "publishing-audio" | "active" | "stopping";

export interface ScreenShareSettings {
  resolution: ScreenShareResolution;
  frameRate: ScreenShareFrameRate;
  bitrate: ScreenShareBitrate;
}

export interface VoiceScreenShare {
  identity: string;
  name: string;
  track: RemoteVideoTrack | LocalVideoTrack;
  audioTrack?: RemoteAudioTrack | LocalAudioTrack;
  volume: number;
}

export interface VoiceDevice {
  deviceId: string;
  label: string;
}

export interface VoiceState {
  status: VoiceStatus;
  channelId: string | null;
  error: string | null;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  microphoneDevices: VoiceDevice[];
  outputDevices: VoiceDevice[];
  selectedMicrophoneId: string;
  selectedOutputId: string;
  rnnoiseActive: boolean;
  audioProcessingBusy: boolean;
  audioProcessingError: string | null;
  participants: VoiceParticipantState[];
  screenSharing: boolean;
  screenShareBusy: boolean;
  screenSharePhase: ScreenSharePhase;
  screenShareAudioEnabled: boolean;
  screenShareWarning: string | null;
  audioPlaybackBlocked: boolean;
  audioPlaybackWarning: string | null;
  screenShareSettings: ScreenShareSettings;
  screenShares: VoiceScreenShare[];
}

const defaultScreenShareSettings: ScreenShareSettings = { resolution: 1080, frameRate: 30, bitrate: 4 };

const initialState: VoiceState = {
  status: "idle", channelId: null, error: null, muted: false, deafened: false,
  speaking: false, microphoneDevices: [], outputDevices: [], selectedMicrophoneId: "",
  selectedOutputId: "", rnnoiseActive: false, audioProcessingBusy: false,
  audioProcessingError: null, participants: [], screenSharing: false, screenShareBusy: false,
  screenSharePhase: "idle", screenShareAudioEnabled: true, screenShareWarning: null,
  audioPlaybackBlocked: false, audioPlaybackWarning: null,
  screenShareSettings: defaultScreenShareSettings, screenShares: [],
};

function normalizeLiveKitUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname === "/rtc" || url.pathname === "/rtc/") url.pathname = "/";
  return url.toString().replace(/\/$/, "");
}

export class VoiceClient {
  private room: Room | null = null;
  private readonly volumes = new Map<string, number>();
  private readonly audioTracks = new Map<string, RemoteTrack>();
  private listeners = new Set<(state: VoiceState) => void>();
  private state: VoiceState = initialState;
  private speakingDataAllowed = false;
  private localSpeakingHint = false;
  private readonly remoteSpeakingSignals = new RemoteSpeakingSignals(() => this.refreshParticipants());
  private readonly localSpeakingSignal = new LocalSpeakingSignal(
    async (payload) => {
      const room = this.room;
      if (!room || !this.speakingDataAllowed || room.localParticipant.permissions?.canPublishData === false) return;
      await room.localParticipant.publishData(payload, { reliable: false, topic: SPEAKING_SIGNAL_TOPIC });
    },
    (speaking) => {
      this.localSpeakingHint = speaking;
      this.refreshParticipants();
    },
  );
  private screenShareGeneration = 0;
  private screenSharePhase: ScreenSharePhase = "idle";
  private ownedScreenVideoTrack: LocalVideoTrack | null = null;
  private ownedScreenAudioTrack: LocalAudioTrack | null = null;
  private audioPreferences: AudioSettings = {
    microphoneId: "",
    outputId: "",
    inputSensitivity: 0.5,
    rnnoiseEnabled: false,
    echoCancellation: true,
    automaticGainControl: true,
    nativeNoiseSuppression: true,
  };

  get snapshot(): VoiceState { return this.state; }
  subscribe(listener: (state: VoiceState) => void): () => void { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener); }

  private update(patch: Partial<VoiceState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  async enumerateDevices(): Promise<void> {
    try {
      const [inputs, outputs] = await Promise.all([Room.getLocalDevices("audioinput"), Room.getLocalDevices("audiooutput")]);
      const microphones = inputs.map((device) => ({ deviceId: device.deviceId, label: device.label || "Microphone" }));
      const speakers = outputs.map((device) => ({ deviceId: device.deviceId, label: device.label || "Speaker" }));
      this.update({ microphoneDevices: microphones, outputDevices: speakers, selectedMicrophoneId: this.state.selectedMicrophoneId || microphones[0]?.deviceId || "", selectedOutputId: this.state.selectedOutputId || speakers[0]?.deviceId || "" });
    } catch (error: unknown) { this.update({ error: error instanceof Error ? error.message : "Audio devices are unavailable." }); }
  }

  async join(channelId: string): Promise<void> {
    await this.leave();
    this.update({ status: "connecting", channelId, error: null, muted: false, deafened: false });
    try {
      const response = await window.freecord.issueVoiceToken(channelId);
      if (!("token" in response)) throw new Error(response.message);
      const token: VoiceTokenResponse = response;
      const canPublishMicrophone = token.permissions.canPublishMicrophone ?? token.permissions.canPublish;
      this.speakingDataAllowed = token.permissions.canPublishData;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: this.microphoneCaptureOptions(),
      });
      this.room = room;
      this.bindRoom(room);
      await room.connect(normalizeLiveKitUrl(token.livekitUrl), token.token, { autoSubscribe: token.permissions.canSubscribe });
      if (canPublishMicrophone) {
        await room.localParticipant.setMicrophoneEnabled(true, this.microphoneCaptureOptions());
        await this.applyAudioProcessingPreferences();
      }
      await this.enumerateDevices();
      this.update({ status: "connected", muted: !canPublishMicrophone });
      await this.publishVoiceMetadata(!canPublishMicrophone, false);
      this.refreshParticipants();
    } catch (error: unknown) {
      await this.leave();
      this.update({ status: "error", channelId, error: error instanceof Error ? error.message : "Unable to join voice." });
    }
  }

  async leave(): Promise<void> {
    this.screenShareGeneration += 1;
    this.screenSharePhase = "stopping";
    const room = this.room;
    await this.localSpeakingSignal.stop(true);
    this.localSpeakingHint = false;
    this.remoteSpeakingSignals.clearAll();
    const ownedScreenTracks = this.takeOwnedScreenTracks();
    if (room) await this.releaseScreenTracks(room, ownedScreenTracks);
    this.audioTracks.forEach((track) => track.detach());
    this.audioTracks.clear();
    if (room) await room.disconnect();
    this.room = null;
    this.speakingDataAllowed = false;
    this.screenSharePhase = "idle";
    this.update({ ...initialState, microphoneDevices: this.state.microphoneDevices, outputDevices: this.state.outputDevices });
  }

  async setMuted(muted: boolean): Promise<void> {
    if (!this.room) return;
    try {
      if (muted) await this.localSpeakingSignal.stop(true);
      await this.room.localParticipant.setMicrophoneEnabled(!muted);
      await this.publishVoiceMetadata(muted, this.state.deafened);
      this.update({ muted, error: null });
      if (!muted) await this.restartLocalSpeakingSignal();
    } catch (error: unknown) {
      this.update({ error: error instanceof Error ? `Microphone control failed: ${error.message}` : "Microphone control failed." });
    }
  }

  async setDeafened(deafened: boolean): Promise<void> {
    if (!this.room) return;
    try {
      await this.publishVoiceMetadata(this.state.muted, deafened);
      this.room.remoteParticipants.forEach((participant) => participant.setVolume(deafened ? 0 : (this.volumes.get(participant.identity) ?? 1)));
      this.update({ deafened, error: null });
    } catch (error: unknown) {
      this.update({ error: error instanceof Error ? `Deafen control failed: ${error.message}` : "Deafen control failed." });
    }
  }

  async startScreenShare(settings: ScreenShareSettings = this.state.screenShareSettings): Promise<void> {
    const room = this.room;
    if (!room || this.screenSharePhase !== "idle" || this.state.screenSharing) return;

    const generation = ++this.screenShareGeneration;
    this.setScreenSharePhase("selecting");
    this.update({
      screenShareSettings: settings,
      screenShareBusy: true,
      screenShareWarning: null,
      error: null,
    });

    let capturedTracks: LocalTrack[] = [];
    try {
      const dimensions = settings.resolution === 720 ? { width: 1280, height: 720 } : settings.resolution === 1080 ? { width: 1920, height: 1080 } : { width: 2560, height: 1440 };
      capturedTracks = await room.localParticipant.createScreenTracks({
        video: true,
        audio: this.state.screenShareAudioEnabled ? {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          voiceIsolation: false,
        } : false,
        resolution: { ...dimensions, frameRate: settings.frameRate },
        contentHint: "detail",
        systemAudio: "include",
      });

      if (!this.isCurrentScreenShareOperation(room, generation)) {
        await this.releaseScreenTracks(room, capturedTracks);
        return;
      }

      const videoTrack = capturedTracks.find((track): track is LocalVideoTrack => track.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video);
      const audioTrack = capturedTracks.find((track): track is LocalAudioTrack => track.source === Track.Source.ScreenShareAudio && track.kind === Track.Kind.Audio);
      if (!videoTrack) throw new Error("The selected source did not provide a screen video track.");

      this.ownedScreenVideoTrack = videoTrack;
      this.ownedScreenAudioTrack = audioTrack ?? null;
      this.setScreenSharePhase("publishing-video");
      const videoPublication = await room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
        screenShareEncoding: { maxBitrate: settings.bitrate * 1_000_000, maxFramerate: settings.frameRate },
        degradationPreference: "maintain-resolution",
      });

      if (!this.isCurrentScreenShareOperation(room, generation)) {
        await this.releaseScreenTracks(room, capturedTracks);
        return;
      }
      if (!videoPublication.track || videoPublication.track.kind !== Track.Kind.Video) throw new Error("Screen video was not published.");

      this.update({ screenSharing: true, error: null });
      this.refreshScreenShares();

      let warning: string | null = null;
      if (this.state.screenShareAudioEnabled) {
        if (audioTrack) {
          this.setScreenSharePhase("publishing-audio");
          try {
            await room.localParticipant.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
            if (!this.isCurrentScreenShareOperation(room, generation)) {
              await this.releaseScreenTracks(room, [videoTrack, audioTrack]);
              return;
            }
          } catch (error: unknown) {
            if (!this.isCurrentScreenShareOperation(room, generation)) {
              await this.releaseScreenTracks(room, [videoTrack, audioTrack]);
              return;
            }
            await this.releaseScreenTracks(room, [audioTrack]);
            if (this.ownedScreenAudioTrack === audioTrack) this.ownedScreenAudioTrack = null;
            const detail = error instanceof Error ? `: ${error.message}` : ".";
            warning = `Screen video is live, but desktop audio could not be published${detail}`;
          }
        } else {
          warning = "Screen video is live, but the selected source did not provide desktop audio.";
        }
      } else if (audioTrack) {
        await this.releaseScreenTracks(room, [audioTrack]);
        if (this.ownedScreenAudioTrack === audioTrack) this.ownedScreenAudioTrack = null;
      }

      if (!this.isCurrentScreenShareOperation(room, generation)) return;
      this.setScreenSharePhase("active");
      this.update({ screenShareBusy: false, screenShareWarning: warning, error: warning });
      this.refreshScreenShares();
    } catch (error: unknown) {
      await this.releaseScreenTracks(room, capturedTracks);
      if (!this.isCurrentScreenShareOperation(room, generation)) return;
      this.ownedScreenVideoTrack = null;
      this.ownedScreenAudioTrack = null;
      this.setScreenSharePhase("idle");
      this.update({
        screenSharing: false,
        screenShareBusy: false,
        screenShareWarning: null,
        error: error instanceof Error ? `Screen sharing failed: ${error.message}` : "Screen sharing failed.",
      });
      this.refreshScreenShares();
    }
  }

  async stopScreenShare(): Promise<void> {
    const room = this.room;
    if (!room || this.screenSharePhase === "stopping") return;

    const generation = ++this.screenShareGeneration;
    this.setScreenSharePhase("stopping");
    this.update({ screenShareBusy: true, screenShareWarning: null, error: null });
    const tracks = this.takeOwnedScreenTracks();
    try {
      await this.releaseScreenTracks(room, tracks);
      if (!this.isCurrentScreenShareOperation(room, generation)) return;
      this.setScreenSharePhase("idle");
      this.update({ screenSharing: false, screenShareBusy: false, screenShareWarning: null });
      this.refreshScreenShares();
    } catch (error: unknown) {
      if (!this.isCurrentScreenShareOperation(room, generation)) return;
      this.setScreenSharePhase("idle");
      this.update({
        screenSharing: false,
        screenShareBusy: false,
        error: error instanceof Error ? error.message : "Screen sharing could not be stopped.",
      });
      this.refreshScreenShares();
    }
  }

  async startAudioPlayback(): Promise<void> {
    if (!this.room) return;
    try {
      await this.room.startAudio();
      const error = this.state.error === this.state.audioPlaybackWarning ? this.state.screenShareWarning : this.state.error;
      this.update({ audioPlaybackBlocked: false, audioPlaybackWarning: null, error });
    } catch (error: unknown) {
      const warning = error instanceof Error ? `Audio playback could not start: ${error.message}` : "Audio playback could not start.";
      this.update({ audioPlaybackBlocked: true, audioPlaybackWarning: warning, error: warning });
    }
  }

  setScreenShareSettings(settings: ScreenShareSettings): void {
    this.update({ screenShareSettings: settings });
  }

  setScreenShareAudioEnabled(enabled: boolean): void {
    this.update({ screenShareAudioEnabled: enabled });
  }

  setAudioPreferences(settings: AudioSettings): void {
    this.audioPreferences = { ...settings };
    this.localSpeakingSignal.setSensitivity(settings.inputSensitivity);
    this.update({ selectedMicrophoneId: settings.microphoneId, selectedOutputId: settings.outputId });
  }

  async applyAudioProcessingPreferences(): Promise<void> {
    const microphone = this.microphoneTrack();
    if (!microphone) {
      await this.localSpeakingSignal.stop(false);
      this.localSpeakingHint = false;
      this.update({ rnnoiseActive: false, audioProcessingBusy: false, audioProcessingError: null });
      return;
    }

    this.update({ audioProcessingBusy: true, audioProcessingError: null });
    try {
      const currentProcessor = microphone.getProcessor();
      if (!this.audioPreferences.rnnoiseEnabled && currentProcessor?.name === "freecord-rnnoise") {
        await microphone.stopProcessor();
      }

      await microphone.applyConstraints({
        echoCancellation: this.audioPreferences.echoCancellation,
        autoGainControl: this.audioPreferences.automaticGainControl,
        noiseSuppression: this.audioPreferences.rnnoiseEnabled ? false : this.audioPreferences.nativeNoiseSuppression,
      });

      if (this.audioPreferences.rnnoiseEnabled && microphone.getProcessor()?.name !== "freecord-rnnoise") {
        await microphone.setProcessor(new FreeCordRnnoiseProcessor());
      }

      this.update({
        rnnoiseActive: microphone.getProcessor()?.name === "freecord-rnnoise",
        audioProcessingBusy: false,
        audioProcessingError: null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Audio processing could not be configured.";
      this.update({ rnnoiseActive: false, audioProcessingBusy: false, audioProcessingError: message });
    }
    await this.restartLocalSpeakingSignal();
  }

  async selectMicrophone(deviceId: string): Promise<void> {
    try {
      if (this.room) await this.room.switchActiveDevice("audioinput", deviceId, true);
      this.update({ selectedMicrophoneId: deviceId, error: null });
      await this.applyAudioProcessingPreferences();
    } catch (error: unknown) {
      this.update({ error: error instanceof Error ? `Microphone selection failed: ${error.message}` : "Microphone selection failed." });
    }
  }

  async selectOutput(deviceId: string): Promise<void> {
    try {
      if (this.room) {
        await this.room.switchActiveDevice("audiooutput", deviceId, true);
        await Promise.all([...this.room.remoteParticipants.values()].map((participant) => participant.setAudioOutput({ deviceId })));
      }
      this.update({ selectedOutputId: deviceId, error: null });
    } catch (error: unknown) {
      this.update({ error: error instanceof Error ? `Speaker selection failed: ${error.message}` : "Speaker selection failed." });
    }
  }

  setParticipantVolume(identity: string, volume: number): void {
    const value = Math.max(0, Math.min(1, volume));
    this.volumes.set(identity, value);
    const participant = this.room?.getParticipantByIdentity(identity) as RemoteParticipant | undefined;
    participant?.setVolume(this.state.deafened ? 0 : value);
    this.refreshParticipants();
  }

  private microphoneCaptureOptions(): AudioCaptureOptions {
    return {
      ...(this.audioPreferences.microphoneId ? { deviceId: this.audioPreferences.microphoneId } : {}),
      echoCancellation: this.audioPreferences.echoCancellation,
      autoGainControl: this.audioPreferences.automaticGainControl,
      noiseSuppression: this.audioPreferences.rnnoiseEnabled ? false : this.audioPreferences.nativeNoiseSuppression,
      ...(this.audioPreferences.rnnoiseEnabled ? { sampleRate: 48_000, channelCount: 1 } : {}),
    };
  }

  private microphoneTrack(): LocalAudioTrack | null {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    return track instanceof LocalAudioTrack ? track : null;
  }

  private bindRoom(room: Room): void {
    type EventRoom = { on<E extends keyof RoomEventCallbacks>(event: E, listener: (...args: Parameters<RoomEventCallbacks[E]>) => void): EventRoom };
    const eventRoom = room as unknown as EventRoom;
    eventRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (publication.source === Track.Source.ScreenShareAudio && track.kind === Track.Kind.Audio) {
        (track as RemoteAudioTrack).setVolume(this.volumes.get(`screen:${participant.identity}`) ?? 1);
        this.refreshScreenShares();
      } else if (publication.source === Track.Source.ScreenShare) {
        this.refreshScreenShares();
      } else {
        this.attachAudio(track, participant);
      }
    });
    eventRoom.on(RoomEvent.TrackUnsubscribed, (track) => { track.detach(); if (track.sid) this.audioTracks.delete(track.sid); this.refreshParticipants(); this.refreshScreenShares(); });
    eventRoom.on(RoomEvent.TrackUnpublished, (publication, participant) => {
      if (publication.source === Track.Source.Microphone) this.remoteSpeakingSignals.clear(participant.identity);
      this.refreshParticipants();
      this.refreshScreenShares();
    });
    eventRoom.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio) {
        this.refreshScreenShares();
      } else if (publication.source === Track.Source.Microphone) {
        void this.restartLocalSpeakingSignal();
      }
    });
    eventRoom.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio) {
        const stillSharing = Boolean(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track);
        if (publication.source === Track.Source.ScreenShare && !stillSharing && this.screenSharePhase === "active") {
          this.screenShareGeneration += 1;
          this.screenSharePhase = "idle";
          const remainingTracks = this.takeOwnedScreenTracks();
          void this.releaseScreenTracks(room, remainingTracks);
          this.update({ screenSharing: false, screenShareBusy: false, screenSharePhase: "idle" });
        } else if (publication.source === Track.Source.ScreenShareAudio && stillSharing && this.screenSharePhase === "active" && this.state.screenShareAudioEnabled) {
          this.ownedScreenAudioTrack = null;
          const warning = "Screen video is live, but the desktop-audio publication ended.";
          this.update({ screenShareWarning: warning, error: warning });
        }
        this.refreshScreenShares();
      } else if (publication.source === Track.Source.Microphone) {
        void this.localSpeakingSignal.stop(false);
        this.localSpeakingHint = false;
        this.refreshParticipants();
      }
    });
    eventRoom.on(RoomEvent.ParticipantConnected, () => this.refreshParticipants());
    eventRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.remoteSpeakingSignals.clear(participant.identity);
      this.refreshParticipants();
      this.refreshScreenShares();
    });
    eventRoom.on(RoomEvent.ActiveSpeakersChanged, () => this.refreshParticipants());
    eventRoom.on(RoomEvent.ParticipantMetadataChanged, () => this.refreshParticipants());
    eventRoom.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      this.remoteSpeakingSignals.receive(payload, participant, kind, topic);
    });
    eventRoom.on(RoomEvent.TrackMuted, (publication, participant) => {
      if (publication.source === Track.Source.Microphone) {
        if (participant === room.localParticipant) {
          void this.localSpeakingSignal.stop(false);
          this.localSpeakingHint = false;
        } else {
          this.remoteSpeakingSignals.clear(participant.identity);
        }
      }
      this.refreshParticipants();
    });
    eventRoom.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      if (publication.source === Track.Source.Microphone && participant === room.localParticipant) {
        void this.restartLocalSpeakingSignal();
      }
      this.refreshParticipants();
    });
    eventRoom.on(RoomEvent.Reconnecting, () => this.update({ status: "reconnecting", error: "Voice connection interrupted; reconnecting…" }));
    eventRoom.on(RoomEvent.Reconnected, () => {
      this.update({ status: "connected", error: null });
      void this.restartLocalSpeakingSignal();
    });
    eventRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Disconnected) {
        void this.localSpeakingSignal.stop(false);
        this.localSpeakingHint = false;
        this.remoteSpeakingSignals.clearAll();
        this.update({ status: "error", error: "Voice connection closed." });
      }
    });
    eventRoom.on(RoomEvent.Disconnected, () => {
      void this.localSpeakingSignal.stop(false);
      this.localSpeakingHint = false;
      this.remoteSpeakingSignals.clearAll();
      this.refreshParticipants();
      this.refreshScreenShares();
    });
    eventRoom.on(RoomEvent.MediaDevicesChanged, () => void this.enumerateDevices());
    eventRoom.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
      const warning = playing ? null : "Audio playback is blocked. Use the stream-audio control to enable it.";
      const error = warning ?? (this.state.error === this.state.audioPlaybackWarning ? this.state.screenShareWarning : this.state.error);
      this.update({ audioPlaybackBlocked: !playing, audioPlaybackWarning: warning, error });
    });
  }

  private setScreenSharePhase(phase: ScreenSharePhase): void {
    this.screenSharePhase = phase;
    this.update({ screenSharePhase: phase });
  }

  private isCurrentScreenShareOperation(room: Room, generation: number): boolean {
    return this.room === room && this.screenShareGeneration === generation;
  }

  private takeOwnedScreenTracks(): LocalTrack[] {
    const tracks = [this.ownedScreenVideoTrack, this.ownedScreenAudioTrack].filter(
      (track): track is LocalVideoTrack | LocalAudioTrack => track !== null,
    );
    this.ownedScreenVideoTrack = null;
    this.ownedScreenAudioTrack = null;
    return tracks;
  }

  private async releaseScreenTracks(room: Room, tracks: LocalTrack[]): Promise<void> {
    const uniqueTracks = [...new Set(tracks)];
    await Promise.all(uniqueTracks.map(async (track) => {
      try { await room.localParticipant.unpublishTrack(track, false); } catch { /* A failed/aborted publication may not have reached the room. */ }
      try { track.stop(); } catch { /* Track cleanup is best effort after unpublication. */ }
    }));
  }

  private attachAudio(track: RemoteTrack, participant: RemoteParticipant): void {
    if (track.kind !== Track.Kind.Audio) return;
    try { track.attach(); } catch (error: unknown) {
      this.update({ error: error instanceof Error ? `Audio playback failed: ${error.message}` : "Audio playback failed." });
      return;
    }
    if (track.sid) this.audioTracks.set(track.sid, track);
    void participant.setAudioOutput(this.state.selectedOutputId ? { deviceId: this.state.selectedOutputId } : {}).catch(() => {
      this.update({ error: "The selected speaker is unavailable; using the system default." });
    });
  }

  private refreshParticipants(): void {
    const participants = this.room ? [...this.room.remoteParticipants.values()].map((participant) => {
      let metadata: { deafened?: boolean } = {};
      try { metadata = participant.metadata ? JSON.parse(participant.metadata) as { deafened?: boolean } : {}; } catch { /* Ignore malformed client metadata. */ }
      return {
        identity: participant.identity,
        name: participant.name || participant.identity,
        speaking: participant.isSpeaking || this.remoteSpeakingSignals.isSpeaking(participant.identity),
        volume: this.volumes.get(participant.identity) ?? 1,
        muted: participant.getTrackPublication(Track.Source.Microphone)?.isMuted ?? false,
        deafened: metadata.deafened === true,
      };
    }) : [];
    this.update({ participants, speaking: (this.room?.localParticipant.isSpeaking ?? false) || this.localSpeakingHint });
    this.refreshScreenShares();
  }

  private refreshScreenShares(): void {
    const screenShares: VoiceScreenShare[] = this.room ? [...this.room.remoteParticipants.values()].flatMap((participant): VoiceScreenShare[] => {
      const publication = participant.getTrackPublication(Track.Source.ScreenShare);
      const audioPublication = participant.getTrackPublication(Track.Source.ScreenShareAudio);
      return publication?.track && publication.track.kind === Track.Kind.Video
        ? [{ identity: participant.identity, name: participant.name || participant.identity, track: publication.track as RemoteVideoTrack, ...(audioPublication?.track?.kind === Track.Kind.Audio ? { audioTrack: audioPublication.track as RemoteAudioTrack } : {}), volume: this.volumes.get(`screen:${participant.identity}`) ?? 1 }]
        : [];
    }) : [];
    const localVideo = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (localVideo && localVideo.kind === Track.Kind.Video) {
      const localAudio = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
      screenShares.unshift({ identity: this.room!.localParticipant.identity, name: this.room!.localParticipant.name || "You", track: localVideo as LocalVideoTrack, ...(localAudio?.kind === Track.Kind.Audio ? { audioTrack: localAudio as LocalAudioTrack } : {}), volume: this.volumes.get(`screen:${this.room!.localParticipant.identity}`) ?? 1 });
    }
    this.update({ screenShares });
  }

  setScreenShareVolume(identity: string, volume: number): void {
    const value = Math.max(0, Math.min(1, volume));
    this.volumes.set(`screen:${identity}`, value);
    const participant = this.room?.getParticipantByIdentity(identity) as RemoteParticipant | undefined;
    const audioTrack = participant?.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
    if (audioTrack?.kind === Track.Kind.Audio) (audioTrack as RemoteAudioTrack).setVolume(value);
    participant?.setVolume(value, Track.Source.ScreenShareAudio);
    this.refreshScreenShares();
  }

  private async publishVoiceMetadata(muted: boolean, deafened: boolean): Promise<void> {
    if (!this.room) return;
    try { await this.room.localParticipant.setMetadata(JSON.stringify({ muted, deafened })); } catch { /* Metadata is a presence hint, not a voice-control failure. */ }
  }

  private async restartLocalSpeakingSignal(): Promise<void> {
    const microphone = this.microphoneTrack();
    if (!this.room || !microphone || microphone.isMuted || this.state.muted) {
      await this.localSpeakingSignal.stop(false);
      this.localSpeakingHint = false;
      return;
    }
    try {
      await this.localSpeakingSignal.start(microphone, this.audioPreferences.inputSensitivity);
    } catch {
      await this.localSpeakingSignal.stop(false);
      this.localSpeakingHint = false;
      this.refreshParticipants();
    }
  }
}
