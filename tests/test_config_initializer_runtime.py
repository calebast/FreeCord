from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INIT = ROOT / "server" / "config-init.sh"
FINALIZE = ROOT / "server" / "config-finalize.sh"


class ConfigInitializerRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="freecord-config-test-")
        self.root = Path(self.temporary.name)
        self.paths = {
            name: self.root / name
            for name in (
                "state", "postgres-config", "api-config", "livekit-config",
                "minio-config", "postgres-data", "minio-data",
            )
        }
        for path in self.paths.values():
            path.mkdir()
        uid = str(os.getuid())
        gid = str(os.getgid())
        self.env = {
            **os.environ,
            "FREECORD_STATE_DIR": str(self.paths["state"]),
            "FREECORD_POSTGRES_CONFIG_DIR": str(self.paths["postgres-config"]),
            "FREECORD_API_CONFIG_DIR": str(self.paths["api-config"]),
            "FREECORD_LIVEKIT_CONFIG_DIR": str(self.paths["livekit-config"]),
            "FREECORD_MINIO_CONFIG_DIR": str(self.paths["minio-config"]),
            "FREECORD_POSTGRES_DATA_DIR": str(self.paths["postgres-data"]),
            "FREECORD_MINIO_DATA_DIR": str(self.paths["minio-data"]),
            "FREECORD_POSTGRES_CONFIG_UID": uid,
            "FREECORD_POSTGRES_CONFIG_GID": gid,
            "FREECORD_API_CONFIG_UID": uid,
            "FREECORD_API_CONFIG_GID": gid,
            "FREECORD_LIVEKIT_CONFIG_UID": uid,
            "FREECORD_LIVEKIT_CONFIG_GID": gid,
            "FREECORD_MINIO_CONFIG_UID": uid,
            "FREECORD_MINIO_CONFIG_GID": gid,
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_script(self, script: Path, *, env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["sh", str(script)],
            cwd=ROOT,
            env=env or self.env,
            check=check,
            capture_output=True,
            text=True,
        )

    def snapshot(self) -> dict[str, bytes]:
        return {
            str(path.relative_to(self.root)): path.read_bytes()
            for directory in self.paths.values()
            for path in directory.iterdir()
            if path.is_file() and path.name != ".init.lock"
        }

    def test_generation_is_isolated_private_and_stable_across_redeploy(self) -> None:
        first = self.run_script(INIT)
        self.assertNotIn("secret", first.stdout.lower())
        expected = {
            "postgres-config": {"postgres-password"},
            "api-config": {"postgres-password", "session-secret", "livekit-api-key", "livekit-api-secret", "s3-access-key", "s3-secret-key"},
            "livekit-config": {"livekit.yaml"},
            "minio-config": {"minio-root-user", "minio-root-password", "s3-access-key", "s3-secret-key"},
        }
        for name, filenames in expected.items():
            self.assertEqual(filenames, {path.name for path in self.paths[name].iterdir()})
            self.assertEqual(0o700, stat.S_IMODE(self.paths[name].stat().st_mode))
            for path in self.paths[name].iterdir():
                self.assertEqual(0o400, stat.S_IMODE(path.stat().st_mode))

        (self.paths["postgres-data"] / "initialized").write_text("x", encoding="utf-8")
        self.run_script(INIT)  # Interrupted first boot may resume.
        (self.paths["minio-data"] / "initialized").write_text("x", encoding="utf-8")
        self.run_script(FINALIZE)
        before = self.snapshot()
        self.run_script(INIT)
        self.run_script(FINALIZE)
        self.assertEqual(before, self.snapshot())

    def test_established_installation_fails_closed_when_one_store_is_missing(self) -> None:
        self.run_script(INIT)
        (self.paths["postgres-data"] / "initialized").write_text("x", encoding="utf-8")
        (self.paths["minio-data"] / "initialized").write_text("x", encoding="utf-8")
        self.run_script(FINALIZE)
        empty_minio = self.root / "missing-minio-data"
        empty_minio.mkdir()
        broken_env = {**self.env, "FREECORD_MINIO_DATA_DIR": str(empty_minio)}
        result = self.run_script(INIT, env=broken_env, check=False)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("initialized data store is missing", result.stderr)


if __name__ == "__main__":
    unittest.main()
