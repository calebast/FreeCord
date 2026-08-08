from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ComposeLiveKitServiceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")

    def test_compose_defines_a_pinned_livekit_service_with_healthcheck(self) -> None:
        self.assertRegex(self.compose, r"(?ms)^  livekit:\s*$")
        livekit = self.compose.split("\n  livekit:", 1)[1].split("\n\n", 1)[0]
        self.assertRegex(livekit, r"image:\s*livekit/livekit-server(?::[^\s]+)?")
        self.assertRegex(livekit, r"(?m)^\s+healthcheck:\s*$")

    def test_livekit_signaling_and_media_ports_are_available(self) -> None:
        livekit = self._livekit_section()
        self.assertRegex(livekit, r"\}:7880/tcp")
        self.assertRegex(livekit, r"\}:7881/tcp")
        self.assertRegex(livekit, r"\}:50000-50010/udp")

    def test_api_uses_service_name_and_livekit_is_not_exposed_as_api_secret(self) -> None:
        api = self.compose.split("\n  api:", 1)[1].split("\n\n", 1)[0]
        self.assertRegex(api, r"LIVEKIT_URL:\s*\$\{LIVEKIT_URL:\?")
        self.assertRegex(api, r"LIVEKIT_API_KEY:\s*\$\{LIVEKIT_API_KEY:\?")
        self.assertRegex(api, r"LIVEKIT_API_SECRET:\s*\$\{LIVEKIT_API_SECRET:\?")
        self.assertRegex(api, r"(?ms)depends_on:.*livekit:.*condition:\s*service_healthy")
        self.assertNotRegex(self.compose, r"(?i)livekit_api_secret[^\n]*788")

    def _livekit_section(self) -> str:
        if "\n  livekit:" not in self.compose:
            return ""
        return self.compose.split("\n  livekit:", 1)[1].split("\n\n", 1)[0]


if __name__ == "__main__":
    unittest.main()
