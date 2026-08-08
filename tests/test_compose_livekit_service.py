from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ComposeLiveKitServiceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        cls.initializer = (ROOT / "server" / "config-init.sh").read_text(encoding="utf-8")

    def _section(self, name: str) -> str:
        return self.compose.split(f"\n  {name}:", 1)[1].split("\n\n", 1)[0]

    def test_compose_defines_a_pinned_livekit_service_with_healthcheck(self) -> None:
        livekit = self._section("livekit")
        self.assertRegex(livekit, r"image:\s*livekit/livekit-server:v1\.13\.1")
        self.assertRegex(livekit, r"(?m)^\s+healthcheck:\s*$")
        self.assertIn('command: ["--config", "/run/freecord-livekit/livekit.yaml"]', livekit)

    def test_livekit_signaling_and_media_ports_are_available(self) -> None:
        livekit = self._section("livekit")
        self.assertRegex(livekit, r"\}:7880/tcp")
        self.assertRegex(livekit, r"\}:7881/tcp")
        self.assertRegex(livekit, r"\}:50000-50010/udp")

    def test_api_uses_internal_room_service_and_isolated_credentials(self) -> None:
        api = self._section("api")
        self.assertRegex(api, r"LIVEKIT_URL:\s*\$\{LIVEKIT_URL:\?")
        self.assertIn("LIVEKIT_API_URL: http://livekit:7880", api)
        self.assertNotIn("LIVEKIT_API_KEY:", api)
        self.assertNotIn("LIVEKIT_API_SECRET:", api)
        self.assertIn("api-config:/run/freecord-api:ro", api)
        self.assertNotIn("livekit-config:", api)

    def test_generated_livekit_config_supports_public_nat_deployments(self) -> None:
        self.assertIn("use_external_ip: true", self.initializer)
        self.assertRegex(self.initializer, r"keys:\n\s+\$livekit_key: \$livekit_secret")


if __name__ == "__main__":
    unittest.main()
