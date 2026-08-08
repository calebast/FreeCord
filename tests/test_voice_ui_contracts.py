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


if __name__ == "__main__":
    unittest.main()
