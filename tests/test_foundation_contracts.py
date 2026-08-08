from __future__ import annotations

import json
import os
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps" / "desktop"
NON_TEXT_SUFFIXES = {".ico", ".png", ".wasm"}


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class DesktopPackageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.package_path = DESKTOP / "package.json"
        self.assertTrue(self.package_path.is_file(), "Missing desktop package.json")
        self.package = json.loads(read_text(self.package_path))

    def test_desktop_package_has_locked_foundation_dependencies_and_scripts(self) -> None:
        self.assertEqual("freecord-desktop", self.package["name"])
        self.assertEqual("dist-main/main/main.js", self.package["main"])
        self.assertEqual(">=22.12.0", self.package["engines"]["node"])

        dependencies = self.package["dependencies"]
        self.assertIn("react", dependencies)
        self.assertIn("react-dom", dependencies)

        dev_dependencies = self.package["devDependencies"]
        self.assertEqual("43.3.0", dev_dependencies["electron"])
        self.assertIn("typescript", dev_dependencies)
        self.assertIn("vite", dev_dependencies)
        for script in ("dev", "typecheck", "build"):
            self.assertIn(script, self.package["scripts"])

    def test_desktop_build_configuration_and_lockfile_are_present(self) -> None:
        for relative in (
            "package-lock.json",
            "tsconfig.json",
            "tsconfig.main.json",
            "vite.config.ts",
            "index.html",
            "src/main/main.ts",
            "src/preload/preload.ts",
            "src/renderer/main.tsx",
        ):
            self.assertTrue((DESKTOP / relative).is_file(), f"Missing desktop foundation file: {relative}")

        lock = json.loads(read_text(DESKTOP / "package-lock.json"))
        self.assertIn(lock.get("lockfileVersion"), (2, 3), "Unexpected npm lockfile format")
        self.assertEqual(self.package["name"], lock.get("name"))


class DesktopSecurityInvariantTests(unittest.TestCase):
    def setUp(self) -> None:
        self.main = read_text(DESKTOP / "src/main/main.ts")
        self.preload = read_text(DESKTOP / "src/preload/preload.ts")
        self.html = read_text(DESKTOP / "index.html")

    def test_electron_renderer_security_flags_are_explicit(self) -> None:
        for flag in (
            "contextIsolation: true",
            "nodeIntegration: false",
            "sandbox: true",
            "webSecurity: true",
        ):
            self.assertIn(flag, self.main)
        self.assertIn("setWindowOpenHandler", self.main)
        self.assertIn('action: "deny"', self.main)
        self.assertIn("setPermissionRequestHandler", self.main)
        self.assertIn("setPermissionCheckHandler", self.main)

    def test_preload_is_a_narrow_context_bridge(self) -> None:
        self.assertIn("contextBridge.exposeInMainWorld", self.preload)
        self.assertNotIn("remote", self.preload.lower())
        self.assertNotIn("send(", self.preload)
        self.assertNotIn("sendSync(", self.preload)
        self.assertNotIn("require(", self.preload)

    def test_support_link_uses_a_fixed_purpose_ipc_handler(self) -> None:
        self.assertIn('const supportUrl = "https://buymeacoffee.com/calebast"', self.main)
        self.assertIn('ipcMain.handle("runtime:open-support-page"', self.main)
        self.assertIn("shell.openExternal(supportUrl)", self.main)
        self.assertIn('ipcRenderer.invoke("runtime:open-support-page")', self.preload)
        self.assertNotIn("openExternal(url", self.main)

    def test_renderer_csp_is_present_and_does_not_enable_dynamic_code(self) -> None:
        self.assertIn("Content-Security-Policy", self.html)
        self.assertIn("default-src 'self'", self.html)
        self.assertIn("script-src 'self'", self.html)
        self.assertIn("'wasm-unsafe-eval'", self.html)
        self.assertIn("worker-src 'self'", self.html)
        self.assertIn("object-src 'none'", self.html)
        self.assertNotIn("'unsafe-eval'", self.html.replace("'wasm-unsafe-eval'", ""))
        self.assertNotIn("unsafe-inline", self.html)


class ServerSecretBoundaryTests(unittest.TestCase):
    SECRET_PATTERNS = (
        re.compile(r"LIVEKIT_API_SECRET\s*=\s*[^\s,;]+", re.IGNORECASE),
        re.compile(r"DATABASE_(?:URL|PASSWORD)\s*=\s*[^\s,;]+", re.IGNORECASE),
        re.compile(r"(?:JWT|SIGNING|S3|AWS)_SECRET(?:_ACCESS_KEY)?\s*=\s*[^\s,;]+", re.IGNORECASE),
    )

    def _source_files(self, directory: Path) -> list[Path]:
        files: list[Path] = []
        for current, directories, names in os.walk(directory):
            directories[:] = [name for name in directories if name not in {"node_modules", "release"}]
            files.extend(
                Path(current) / name
                for name in names
                if Path(name).suffix not in {".lock", ".map", *NON_TEXT_SUFFIXES}
            )
        return files

    def test_desktop_source_and_generated_artifacts_do_not_contain_server_secret_assignments(self) -> None:
        violations: list[str] = []
        for path in self._source_files(DESKTOP):
            text = read_text(path)
            if any(pattern.search(text) for pattern in self.SECRET_PATTERNS):
                violations.append(str(path.relative_to(ROOT)))
        self.assertEqual([], violations, f"Server-secret assignments found in desktop files: {violations}")

    def test_backend_contract_scaffold_does_not_embed_livekit_or_database_secrets(self) -> None:
        server_files = self._source_files(ROOT / "server")
        self.assertTrue(server_files, "Expected backend foundation files")
        violations = [
            str(path.relative_to(ROOT))
            for path in server_files
            if any(pattern.search(read_text(path)) for pattern in self.SECRET_PATTERNS)
        ]
        self.assertEqual([], violations, f"Secret assignments found in backend contract files: {violations}")


class MigrationSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.migration_path = ROOT / "database/migrations/0001_initial.sql"
        self.assertTrue(self.migration_path.is_file(), "Missing initial PostgreSQL migration")
        self.sql = read_text(self.migration_path)
        self.lower_sql = self.sql.lower()

    def test_migration_is_transactional_and_clean_install_oriented(self) -> None:
        self.assertIn("\nbegin;\n", self.lower_sql)
        self.assertTrue(self.lower_sql.rstrip().endswith("commit;"))
        self.assertIn("create extension if not exists pgcrypto", self.lower_sql)
        self.assertIn("schema_migrations", self.lower_sql)
        self.assertIn("no legacy sqlite compatibility layer", self.lower_sql)

    def test_single_community_and_session_safety_patterns_exist(self) -> None:
        self.assertIn("communities_singleton_key check", self.lower_sql)
        self.assertIn("communities_singleton_idx", self.lower_sql)
        self.assertIn("refresh_token_hash", self.lower_sql)
        self.assertIn("user_sessions_refresh_token_idx", self.lower_sql)
        self.assertIn("revoked_at", self.lower_sql)

    def test_cross_scope_and_voice_channel_integrity_are_enforced(self) -> None:
        self.assertIn("member_roles_role_fk", self.lower_sql)
        self.assertIn("references roles (community_id, id)", self.lower_sql)
        self.assertIn("channel_permission_overrides_role_fk", self.lower_sql)
        self.assertIn("voice_channel_bindings_type_trigger", self.lower_sql)
        self.assertIn("prevent_bound_channel_type_change", self.lower_sql)
        self.assertIn("type = 'voice'", self.lower_sql)

    def test_seed_inserts_are_idempotent(self) -> None:
        self.assertRegex(self.lower_sql, r"insert into permissions[\s\S]+on conflict \(key\) do nothing")
        self.assertRegex(self.lower_sql, r"insert into schema_migrations[\s\S]+on conflict \(version\) do nothing")

    def test_community_bootstrap_never_recreates_default_channels(self) -> None:
        runner = read_text(ROOT / "database/migrate.sh")
        self.assertEqual(1, runner.count("INSERT INTO public.voice_channel_bindings"))
        self.assertEqual(1, runner.count("'general-voice'"))
        self.assertIn("Default channels belong only to first initialization", runner)
        self.assertIn("First active voice channel ID", runner)


class GeneratedArtifactTests(unittest.TestCase):
    def test_declared_electron_entry_and_compiled_outputs_exist(self) -> None:
        package = json.loads(read_text(DESKTOP / "package.json"))
        entry = DESKTOP / package["main"]
        self.assertTrue(entry.is_file(), f"Declared Electron entry is missing: {entry}")
        self.assertTrue((DESKTOP / "dist-main/preload/preload.js").is_file())
        self.assertTrue((DESKTOP / "dist/index.html").is_file())

    def test_compiled_desktop_artifacts_have_no_secret_material(self) -> None:
        artifact_paths = [
            path
            for directory in (DESKTOP / "dist", DESKTOP / "dist-main")
            for path in directory.rglob("*")
            if path.is_file() and path.suffix not in {".map", ".lock", *NON_TEXT_SUFFIXES}
        ]
        self.assertTrue(artifact_paths, "Expected compiled desktop artifacts")
        secret_tokens = re.compile(
            r"(?:LIVEKIT_API_SECRET|DATABASE_PASSWORD|JWT_SECRET|SIGNING_SECRET|"
            r"S3_SECRET_ACCESS_KEY|AWS_SECRET_ACCESS_KEY)\s*[:=]",
            re.IGNORECASE,
        )
        violations = [
            str(path.relative_to(ROOT))
            for path in artifact_paths
            if secret_tokens.search(read_text(path))
        ]
        self.assertEqual([], violations, f"Secret material markers found in generated artifacts: {violations}")

    def test_generated_preload_exposes_only_expected_bridge_surface(self) -> None:
        preload = read_text(DESKTOP / "dist-main/preload/preload.js")
        self.assertIn("runtime:get-info", preload)
        self.assertIn("freecord", preload)
        self.assertNotIn("nodeIntegration", preload)
        self.assertNotIn("process.env", preload)


if __name__ == "__main__":
    unittest.main()
