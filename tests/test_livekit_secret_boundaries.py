from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
CLIENT = ROOT / "apps" / "desktop"


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


class LiveKitTokenSecretBoundaryTests(unittest.TestCase):
    def test_livekit_credentials_are_server_environment_inputs(self) -> None:
        env = text(SERVER / "env.ts")
        self.assertRegex(env, r"LIVEKIT_URL")
        self.assertRegex(env, r"LIVEKIT_API_KEY")
        self.assertRegex(env, r"LIVEKIT_API_SECRET")
        self.assertRegex(env, r"LIVEKIT_TOKEN_TTL_SECONDS")
        self.assertNotRegex(env, r"localStorage|sessionStorage|window\.")

    def test_livekit_secret_is_read_only_by_server_token_issuer(self) -> None:
        source = "\n".join(text(path) for path in SERVER.glob("*.ts"))
        self.assertRegex(source, r"(?i)livekit")
        self.assertRegex(source, r"(?i)(?:LIVEKIT_API_SECRET|apiSecret|secret)")
        self.assertRegex(source, r"(?i)(?:AccessToken|token.*sign|sign.*token)")
        self.assertNotRegex(source, r"(?i)(?:json\([^\n]*LIVEKIT_API_SECRET|return[^\n]*LIVEKIT_API_SECRET)")

    def test_voice_token_input_cannot_select_a_room_or_supply_signing_material(self) -> None:
        contracts = text(SERVER / "contracts.ts")
        request = contracts[contracts.index("export interface VoiceTokenRequest"):contracts.index("export interface VoiceTokenResponse")]
        self.assertIn("channelId", request)
        self.assertNotRegex(request, r"(?i)(?:roomName|livekitRoom|apiSecret|secret|apiKey)")
        adapter = text(SERVER / "local-adapter.ts")
        self.assertRegex(adapter, r"(?i)authorizeVoiceJoin")
        self.assertRegex(adapter, r"livekitRoomName:\s*authorization\.livekitRoomName")

    def test_desktop_sources_and_artifacts_never_contain_livekit_signing_secret(self) -> None:
        paths = [
            path
            for root in (CLIENT / "src", CLIENT / "dist", CLIENT / "dist-main")
            if root.is_dir()
            for path in root.rglob("*")
            if path.is_file() and path.suffix not in {".lock", ".map"}
        ]
        markers = re.compile(r"(?i)(?:LIVEKIT_API_SECRET|livekitApiSecret|livekit\.secret|apiSecret\s*[:=])")
        violations = [str(path.relative_to(ROOT)) for path in paths if markers.search(text(path))]
        self.assertEqual([], violations, f"LiveKit signing-secret markers found in desktop files: {violations}")

    def test_token_endpoint_requires_authorization_before_issuing(self) -> None:
        adapter = text(SERVER / "local-adapter.ts")
        voice = adapter[adapter.index("voice:"):]
        self.assertRegex(voice, r"requireUser\(context\)")
        self.assertRegex(voice, r"authorizeVoiceJoin")

    def test_issued_response_contains_no_signing_credentials(self) -> None:
        contracts = text(SERVER / "contracts.ts")
        response = contracts[
            contracts.index("export interface VoiceTokenResponse"):
            contracts.index("export interface RequestContext")
        ]
        self.assertIn("token: string", response)
        self.assertNotRegex(response, r"(?i)(apiSecret|apiKey|secret|roomName)")


if __name__ == "__main__":
    unittest.main()
