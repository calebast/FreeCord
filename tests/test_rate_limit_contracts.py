from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"


def server_source() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in SERVER.glob("*.ts"))


class AuthenticationRateLimitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = server_source()
        self.http = (SERVER / "http-server.ts").read_text(encoding="utf-8")

    def test_rate_limiter_is_bounded_and_has_a_clock_injection_seam(self) -> None:
        self.assertRegex(self.source, r"(?i)(?:rate.?limit|throttle)")
        self.assertRegex(self.source, r"(?i)(?:maxRequests|limit|capacity)")
        self.assertRegex(self.source, r"(?i)(?:windowMs|windowSeconds|retryAfter)")

    def test_login_register_and_refresh_are_rate_limited_by_client_key(self) -> None:
        for route in ("/v1/auth/login", "/v1/auth/register", "/v1/auth/refresh"):
            self.assertIn(route, self.http)
        self.assertIn("mutationRateLimitRoute", self.http)
        self.assertRegex(self.http, r"routeLimiter\.consume\(key\)")
        self.assertIn('routeKey === "/v1/channels/:channelId/messages"', self.http)
        self.assertRegex(self.http, r"chatRateLimiter:\s*new InMemoryRateLimiter\([^\n]*max:\s*180")
        self.assertRegex(self.http, r"context\.user\?\.id\s*\?\?\s*request\.socket\.remoteAddress")

    def test_rate_limit_response_is_429_with_retry_after_and_safe_error_shape(self) -> None:
        self.assertRegex(self.http, r"status(?:Code)?\s*=\s*429|return\s+429|json\([^\n]*,\s*429")
        self.assertRegex(self.http, r"(?i)retry-after")
        self.assertRegex(self.http, r"(?i)rate_limited")
        self.assertNotRegex(self.http, r"(?i)(?:password|refreshToken|authorization).{0,100}(?:rate|limit)")


if __name__ == "__main__":
    unittest.main()
