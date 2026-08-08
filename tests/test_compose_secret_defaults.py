from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DockerComposeSecretAndDefaultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")

    def test_secret_inputs_are_required_and_have_no_fallback_values(self) -> None:
        for name in ("POSTGRES_PASSWORD", "DATABASE_URL", "SESSION_SECRET", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
            self.assertRegex(self.compose, rf"\$\{{{name}:\?[^}}]+\}}", name)
            self.assertNotRegex(self.compose, rf"\$\{{{name}:-", name)
        self.assertRegex(self.compose, r"FREECORD_INITIAL_ADMIN_PASSWORD:\s*\$\{FREECORD_INITIAL_ADMIN_PASSWORD:-\}")

    def test_compose_does_not_inline_secret_literals_or_publish_them_to_web(self) -> None:
        self.assertNotRegex(self.compose, r"(?i)(?:password|secret)\s*:\s*['\"](?:[^$\n]+)")
        self.assertNotRegex(self.compose, r"(?i)\b(?:LIVEKIT_API_SECRET|SESSION_SECRET|DATABASE_URL)\s*:\s*['\"]")

    def test_non_secret_defaults_are_explicit_and_secret_mounts_are_not_used(self) -> None:
        self.assertRegex(self.compose, r"LIVEKIT_URL:\s*\$\{LIVEKIT_URL:\?")
        self.assertNotRegex(self.compose, r"(?i)(?:/run/secrets|secrets:\s*$)")
        self.assertRegex(self.compose, r"POSTGRES_DB:\s*\$\{POSTGRES_DB:-[^}]+\}")

    def test_minio_root_credentials_are_separate_from_the_api_bucket_account(self) -> None:
        for name in ("MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "S3_ACCESS_KEY", "S3_SECRET_KEY"):
            self.assertRegex(self.compose, rf"\$\{{{name}:?\?[^}}]+\}}", name)
        self.assertIn("minio-init:", self.compose)
        self.assertIn("condition: service_completed_successfully", self.compose)
        api = self.compose[self.compose.index("  api:"):]
        self.assertNotIn("MINIO_ROOT_USER:", api)
        self.assertNotIn("MINIO_ROOT_PASSWORD:", api)


if __name__ == "__main__":
    unittest.main()
