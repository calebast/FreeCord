from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "apps" / "desktop" / "src" / "renderer" / "main.tsx"
VOICE = ROOT / "apps" / "desktop" / "src" / "renderer" / "voice.ts"
SPEAKING = ROOT / "apps" / "desktop" / "src" / "renderer" / "speaking-signal.ts"
MAIN = ROOT / "apps" / "desktop" / "src" / "main" / "main.ts"
BRIDGE = ROOT / "apps" / "desktop" / "src" / "shared" / "bridge.ts"
STYLES = ROOT / "apps" / "desktop" / "src" / "renderer" / "styles.css"


class VoiceUiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = "\n".join(path.read_text(encoding="utf-8") for path in (RENDERER, VOICE, MAIN))
        cls.bridge = BRIDGE.read_text(encoding="utf-8")

    def test_ui_uses_the_versioned_auth_and_channel_endpoints(self) -> None:
        self.assertIn("/v1/auth/login", self.source)
        self.assertNotRegex(self.source, r"/v1/(accounts|sessions|rooms)")

    def test_voice_join_posts_route_channel_id_and_only_uses_server_token_response(self) -> None:
        self.assertRegex(self.source, r"/v1/channels/\$\{[^}]+\}/voice-token")
        self.assertNotRegex(self.source, r"/v1/rooms/\$\{")
        self.assertIn("issueVoiceToken(channelId)", self.source)
        self.assertRegex(self.source, r"room\.connect\((?:normalizeLiveKitUrl\()?token\.livekitUrl\)?\s*,\s*token\.token")

    def test_ui_does_not_construct_or_submit_livekit_signing_material(self) -> None:
        self.assertNotRegex(self.source, r"(?i)(LIVEKIT_API_SECRET|livekitApiSecret|apiSecret|livekit\.secret)")
        self.assertNotRegex(self.source, r"(?i)(roomName|livekitRoom)\s*:")

    def test_voice_token_response_is_used_for_connection_without_exposing_secret_fields(self) -> None:
        self.assertRegex(self.source, r"room\.connect\((?:normalizeLiveKitUrl\()?token\.livekitUrl\)?\s*,\s*token\.token")
        self.assertNotRegex(self.source, r"response\.(apiSecret|secret|apiKey)")

    def test_client_speaking_hints_are_lossy_bounded_and_cosmetic(self) -> None:
        speaking = SPEAKING.read_text(encoding="utf-8")
        self.assertIn('SPEAKING_SIGNAL_TOPIC = "freecord.voice.speaking.v1"', speaking)
        self.assertIn("const MAX_PAYLOAD_BYTES = 64", speaking)
        self.assertIn("const SAMPLE_INTERVAL_MS = 40", speaking)
        self.assertIn("const REMOTE_HINT_TTL_MS = 1_500", speaking)
        self.assertIn("kind !== DataPacket_Kind.LOSSY", speaking)
        self.assertIn("participant.getTrackPublication(Track.Source.Microphone)", speaking)
        self.assertIn("participant.isSpeaking || this.remoteSpeakingSignals.isSpeaking", self.source)
        self.assertRegex(self.source, r"publishData\(payload, \{ reliable: false, topic: SPEAKING_SIGNAL_TOPIC \}\)")

    def test_client_speaking_hints_are_cleaned_up_without_replacing_livekit(self) -> None:
        speaking = SPEAKING.read_text(encoding="utf-8")
        self.assertIn("RoomEvent.ActiveSpeakersChanged", self.source)
        self.assertIn("RoomEvent.DataReceived", self.source)
        self.assertIn("remoteSpeakingSignals.clearAll()", self.source)
        self.assertIn("localSpeakingSignal.stop", self.source)
        self.assertIn("clearTimeout", speaking)
        self.assertIn("clearInterval", speaking)

    def test_remote_participant_actions_are_in_a_bounded_context_menu(self) -> None:
        renderer = RENDERER.read_text(encoding="utf-8")
        styles = STYLES.read_text(encoding="utf-8")
        self.assertIn("onContextMenu={(event)", renderer)
        self.assertIn("voiceParticipantMenu", renderer)
        self.assertIn('className="voice-participant-menu"', renderer)
        self.assertNotIn('className="voice-volume"', renderer)
        self.assertIn("position: fixed", styles[styles.index(".voice-participant-menu"):])

    def test_channel_management_uses_an_admin_context_menu(self) -> None:
        renderer = RENDERER.read_text(encoding="utf-8")
        styles = STYLES.read_text(encoding="utf-8")
        self.assertIn("openChannelMenu", renderer)
        self.assertIn('className="channel-context-menu"', renderer)
        self.assertIn("Rename channel", renderer)
        self.assertIn("Delete channel", renderer)
        self.assertNotIn("channel-delete-button", renderer)
        self.assertNotIn("channel-editor-list", renderer)
        self.assertIn("position: fixed", styles[styles.index(".channel-context-menu"):])

    def test_stream_viewer_fullscreen_hides_chrome_and_has_a_corner_exit(self) -> None:
        renderer = RENDERER.read_text(encoding="utf-8")
        styles = STYLES.read_text(encoding="utf-8")
        main = MAIN.read_text(encoding="utf-8")
        preload = (ROOT / "apps" / "desktop" / "src" / "preload" / "preload.ts").read_text(encoding="utf-8")
        self.assertNotIn("requestFullscreen", renderer)
        self.assertNotIn("document.fullscreen", renderer)
        self.assertIn("setWindowFullscreen", renderer)
        self.assertIn("onWindowFullscreenChanged", renderer)
        self.assertIn('mainWindow.on("enter-full-screen", publishFullscreenState)', main)
        self.assertIn('mainWindow.on("leave-full-screen", publishFullscreenState)', main)
        self.assertIn('ipcRenderer.on("window:fullscreen-changed", wrapped)', preload)
        self.assertIn('ipcRenderer.removeListener("window:fullscreen-changed", wrapped)', preload)
        self.assertIn('className="screen-viewer-exit-fullscreen"', renderer)
        fullscreen_styles = styles[styles.index(".screen-viewer-overlay.fullscreen") :]
        self.assertIn(".screen-viewer-overlay.fullscreen > header { display: none; }", fullscreen_styles)
        self.assertIn(".screen-viewer-overlay.fullscreen .screen-share-controls { display: none; }", fullscreen_styles)
        self.assertRegex(fullscreen_styles, r"\.screen-viewer-exit-fullscreen\s*\{[^}]*right:\s*14px;[^}]*bottom:\s*14px;")

    def test_screen_media_permissions_and_audio_processing_are_source_scoped(self) -> None:
        postgres_voice = (ROOT / "server" / "postgres-voice.ts").read_text(encoding="utf-8")
        voice = VOICE.read_text(encoding="utf-8")
        for source in ("TrackSource.MICROPHONE", "TrackSource.SCREEN_SHARE", "TrackSource.SCREEN_SHARE_AUDIO"):
            self.assertIn(source, postgres_voice)
        self.assertNotIn("TrackSource.CAMERA,", postgres_voice)
        self.assertNotIn("TrackSource.CAMERA,", (ROOT / "server" / "voice-moderation.ts").read_text(encoding="utf-8"))
        screen_capture = voice[voice.index("createScreenTracks") : voice.index("this.ownedScreenVideoTrack")]
        for setting in ("echoCancellation: false", "autoGainControl: false", "noiseSuppression: false", "voiceIsolation: false"):
            self.assertIn(setting, screen_capture)
        self.assertIn("(track as RemoteAudioTrack).setVolume", voice)
        self.assertNotIn("disabled={!share.audioTrack}", RENDERER.read_text(encoding="utf-8"))
        self.assertIn("canPublishMicrophone", postgres_voice)
        self.assertIn("canPublishMicrophone?: boolean", self.bridge)
        self.assertIn("token.permissions.canPublishMicrophone ?? token.permissions.canPublish", self.source)
        self.assertIn("if (canPublishMicrophone)", self.source)

    def test_linux_desktop_audio_uses_an_automatic_native_pipewire_capture(self) -> None:
        voice = VOICE.read_text(encoding="utf-8")
        renderer = RENDERER.read_text(encoding="utf-8")
        main = MAIN.read_text(encoding="utf-8")
        preload = (ROOT / "apps" / "desktop" / "src" / "preload" / "preload.ts").read_text(encoding="utf-8")
        worklet = (ROOT / "apps" / "desktop" / "src" / "renderer" / "pipewire-screen-audio-worklet.js").read_text(encoding="utf-8")
        self.assertIn("captureLinuxPipeWireAudio", voice)
        self.assertIn('require(path.join(process.resourcesPath, "venmic.node"))', main)
        self.assertIn("freeCordPipeWireExclusions", main)
        self.assertIn("app.getAppMetrics()", main)
        self.assertIn("String(process.pid)", main)
        self.assertIn('{ "application.process.id": pid }', main)
        self.assertIn('{ "application.name": name }', main)
        self.assertIn('{ "application.process.binary": binary }', main)
        self.assertIn('{ "node.name": "freecord-desktop" }', main)
        self.assertIn('"FreeCord", "freecord-desktop"', main)
        self.assertIn('{ "media.class": "Stream/Output/Audio" }', main)
        self.assertIn('{ "media.class": "Stream/Input/Audio" }', main)
        self.assertIn("only_speakers: false", main)
        self.assertIn("only_default_speakers: false", main)
        self.assertIn("mute: false", main)
        self.assertNotIn('"media.name": "RecordStream"', main)
        self.assertIn("ignore_devices: true", main)
        self.assertIn('spawn("pw-record"', main)
        self.assertIn('`--target=${linuxScreenAudioSourceName}`', main)
        self.assertIn('mainWindow.webContents.send("audio:linux-screen-data"', main)
        self.assertIn("audioContext.audioWorklet.addModule(pipewireScreenAudioWorkletUrl)", voice)
        self.assertIn('pipewire-screen-audio-worklet.js?url&no-inline', voice)
        self.assertIn('new AudioWorkletNode(audioContext, "freecord-pipewire-source"', voice)
        self.assertIn('registerProcessor("freecord-pipewire-source"', worklet)
        self.assertIn('ipcRenderer.on("audio:linux-screen-data", wrapped)', preload)
        self.assertNotIn("navigator.mediaDevices.getUserMedia", voice[voice.index("private async captureLinuxPipeWireAudio"):voice.index("private microphoneTrack")])
        self.assertIn("if (usePipeWireAudio) await window.freecord.unmuteLinuxScreenAudio()", voice)
        self.assertIn("echoCancellation: false", voice)
        self.assertIn("autoGainControl: false", voice)
        self.assertIn("noiseSuppression: false", voice)
        self.assertIn("new LocalAudioTrack(mediaTrack", voice)
        self.assertIn("endedAudioTrack", voice)
        self.assertIn("orphanedScreenTracks", voice)
        self.assertIn("Application audio is captured automatically", renderer)
        self.assertIn("No KDE audio routing changes are needed", renderer)
        self.assertNotIn("module-null-sink", self.source)
        self.assertNotIn("screenAudioInputId", self.source)

    def test_screen_audio_uses_platform_specific_capture_paths(self) -> None:
        voice = VOICE.read_text(encoding="utf-8")
        main = MAIN.read_text(encoding="utf-8")
        self.assertIn('this.runtimePlatform === "linux"', voice)
        self.assertIn("this.state.screenShareAudioEnabled && !usePipeWireAudio", voice)
        self.assertIn("if (usePipeWireAudio && !audioTrack)", voice)
        self.assertGreaterEqual(voice.count("if (usePipeWireAudio) await this.releasePipeWireAudioCapture()"), 6)
        self.assertIn("restrictOwnAudio: true", voice)
        self.assertNotIn("getSettings().restrictOwnAudio", voice)
        self.assertIn('process.platform === "win32" && request.audioRequested', main)
        self.assertIn('{ audio: "loopback" as const }', main)
        self.assertIn("excluding microphones and FreeCord voice", RENDERER.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
