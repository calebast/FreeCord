from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DockerComposeSecretAndDefaultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.initializer = (ROOT / "server" / "config-init.sh").read_text(encoding="utf-8")

    def test_web_editor_stack_uses_public_images_and_has_no_build_contexts(self) -> None:
        self.assertNotRegex(self.compose, r"(?m)^\s+build:")
        self.assertIn("ghcr.io/calebast/freecord-api:${FREECORD_IMAGE_TAG:-latest}", self.compose)
        self.assertIn("ghcr.io/calebast/freecord-minio:${FREECORD_IMAGE_TAG:-latest}", self.compose)

    def test_only_public_url_is_compose_required_and_bootstrap_password_is_removable(self) -> None:
        self.assertRegex(self.compose, r"LIVEKIT_URL:\s*\$\{LIVEKIT_URL:\?")
        self.assertRegex(self.compose, r"FREECORD_INITIAL_ADMIN_PASSWORD:\s*\$\{FREECORD_INITIAL_ADMIN_PASSWORD:-\}")
        for name in ("POSTGRES_PASSWORD", "SESSION_SECRET", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "MINIO_ROOT_PASSWORD", "S3_SECRET_KEY"):
            self.assertNotRegex(self.compose, rf"\$\{{{name}:\?")

    def test_runtime_services_receive_only_their_own_configuration_volume(self) -> None:
        sections = {
            name: self.compose.split(f"\n  {name}:", 1)[1].split("\n\n", 1)[0]
            for name in ("postgres", "livekit", "minio", "minio-init", "api")
        }
        self.assertIn("postgres-config:", sections["postgres"])
        self.assertNotIn("api-config:", sections["postgres"])
        self.assertIn("livekit-config:", sections["livekit"])
        self.assertNotIn("api-config:", sections["livekit"])
        self.assertIn("minio-config:", sections["minio"])
        self.assertNotIn("api-config:", sections["minio"])
        self.assertIn("api-config:", sections["api"])
        self.assertNotIn("minio-config:", sections["api"])
        self.assertNotIn("MINIO_ROOT_", sections["api"])

    def test_initializer_is_offline_fail_closed_and_publishes_private_files(self) -> None:
        config_init = self.compose.split("\n  config-init:", 1)[1].split("\n\n", 1)[0]
        self.assertIn("network_mode: none", config_init)
        self.assertIn('read_only: true', config_init)
        self.assertIn('no-new-privileges:true', config_init)
        self.assertIn("chmod 0400", self.initializer)
        self.assertIn("chmod 0700", self.initializer)
        self.assertRegex(self.initializer, r"configuration is missing while persistent application data exists")
        self.assertIn("manifest-v1", self.initializer)
        self.assertIn("complete-v1", self.initializer)

    def test_first_boot_is_finalized_only_after_both_data_services_initialize(self) -> None:
        finalize = self.compose.split("\n  config-finalize:", 1)[1].split("\n\n", 1)[0]
        self.assertIn("postgres: { condition: service_healthy }", finalize)
        self.assertIn("minio-init: { condition: service_completed_successfully }", finalize)
        api = self.compose.split("\n  api:", 1)[1].split("\n\n", 1)[0]
        self.assertIn("config-finalize: { condition: service_completed_successfully }", api)

    def test_no_secret_literals_are_committed_to_compose(self) -> None:
        self.assertNotRegex(self.compose, r"(?i)(?:password|secret):\s*['\"]?[A-Za-z0-9+/]{12,}")
        self.assertNotRegex(self.compose, r"(?i)DATABASE_URL:\s*postgres")


if __name__ == "__main__":
    unittest.main()
