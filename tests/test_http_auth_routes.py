from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"


class HttpAuthenticationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.http = (SERVER / "http-server.ts").read_text(encoding="utf-8")
        self.contracts = (SERVER / "contracts.ts").read_text(encoding="utf-8")

    def test_login_refresh_register_routes_are_post_only_and_delegate_to_auth(self) -> None:
        for route, method in (("login", "login"), ("register", "register"), ("refresh", "refresh")):
            self.assertRegex(self.http, rf'request\.method === "POST" && url\.pathname === "/v1/auth/{route}"')
            self.assertRegex(self.http, rf"runtime\.api\.auth\.{method}\(")
        self.assertNotRegex(self.http, r'GET"\s*&&\s*url\.pathname === "/v1/auth/(?:login|register|refresh)"')

    def test_auth_routes_parse_json_and_return_request_correlated_no_store_responses(self) -> None:
        for route in ("login", "register", "refresh"):
            start = self.http.rindex(f'/v1/auth/{route}')
            snippet = self.http[start:start + 500]
            self.assertIn("body(request)", snippet, route)
            self.assertIn("json(response", snippet, route)
        self.assertRegex(self.http, r'cache-control", "no-store"')
        self.assertRegex(self.http, r'x-request-id", requestId')

    def test_error_mapping_does_not_leak_auth_failure_details(self) -> None:
        self.assertRegex(self.http, r'"invalid_credentials"')
        self.assertRegex(self.http, r'"invalid_refresh_token"')
        self.assertRegex(self.http, r"status === 401")
        self.assertRegex(self.http, r'code = status === 400 \? "bad_request" : status === 401 \? "unauthorized"')
        self.assertNotRegex(self.http, r"(?i)json\([^\n]*(?:password|refreshToken)")

    def test_contracts_keep_auth_paths_and_error_code_stable(self) -> None:
        for route in ("login", "register", "refresh"):
            self.assertIn(f'POST /v1/auth/{route}', self.contracts)
        self.assertIn('"rate_limited"', self.contracts)


if __name__ == "__main__":
    unittest.main()
