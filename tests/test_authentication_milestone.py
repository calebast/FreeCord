from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
CLIENT = ROOT / "apps" / "desktop"


def client_files() -> list[Path]:
    roots = [CLIENT / "src", CLIENT / "dist", CLIENT / "dist-main"]
    files = [path for root in roots if root.is_dir() for path in root.rglob("*") if path.is_file() and path.suffix not in {".lock", ".map"}]
    files.extend(path for path in (CLIENT / "package.json", CLIENT / "index.html") if path.is_file())
    return files
MIGRATIONS = ROOT / "database" / "migrations"


def source(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


class BootstrapConfigurationContractTests(unittest.TestCase):
    """The first administrator is an operator-controlled, one-time bootstrap."""

    def test_bootstrap_variable_names_are_documented_and_wired_to_compose(self) -> None:
        env_example = source(ROOT / ".env.example")
        compose = source(ROOT / "compose.yaml")
        server_sources = "\n".join(source(path) for path in SERVER.glob("*.ts"))

        for name in ("FREECORD_INITIAL_ADMIN_USERNAME", "FREECORD_INITIAL_ADMIN_PASSWORD"):
            self.assertIn(name, env_example, f"{name} must be documented in .env.example")
            self.assertRegex(
                compose,
                rf"{name}:\s*\$\{{{name}(?::-[^}}]*)?\}}",
                f"Compose must pass {name} from the protected deployment environment",
            )
            self.assertIn(name, server_sources, f"Server must consume {name}")

    def test_bootstrap_secret_is_not_logged_or_returned_and_is_only_used_when_empty(self) -> None:
        implementation = "\n".join(source(SERVER / name) for name in ("http-server.ts", "env.ts", "postgres-auth.ts"))
        self.assertRegex(implementation, r"(?is)(?:users|user).*count|no users|user.?s?\.length|auth_bootstrap")
        self.assertRegex(implementation, r"(?is)(?:password|bootstrap).*(?:hash|hashPassword)")
        self.assertNotRegex(implementation, r"(?i)console\.(?:log|info|debug)[^\n]*(?:INITIAL_ADMIN_PASSWORD|initialAdminPassword)")
        self.assertNotRegex(implementation, r"(?i)return[^\n]*(?:INITIAL_ADMIN_PASSWORD|initialAdminPassword)")

    def test_example_contains_placeholders_not_bootstrap_credentials(self) -> None:
        env_example = source(ROOT / ".env.example")
        password = re.search(r"^FREECORD_INITIAL_ADMIN_PASSWORD=([^\n]*)$", env_example, re.MULTILINE)
        self.assertIsNotNone(password)
        self.assertRegex(password.group(1).strip().strip("\"'").lower(), r"^(generate|your|change|replace|set)-")
        self.assertRegex(env_example, r"(?m)^FREECORD_INITIAL_ADMIN_USERNAME=admin$")


class DesktopInviteRegistrationSafetyTests(unittest.TestCase):
    def test_registration_validates_inputs_and_storage_before_consuming_invite(self) -> None:
        main = source(CLIENT / "src" / "main" / "main.ts")
        registration = main[main.index('ipcMain.handle("auth:register"'):main.index('ipcMain.handle("auth:refresh"')]
        request = registration.index('requestJson<LoginResponse>')
        self.assertLess(registration.index("input.password.length < 12"), request)
        self.assertLess(registration.index("credentialStorageAvailable()"), request)
        self.assertLess(registration.index("stageRegistrationChatKey"), request)

    def test_post_registration_storage_failure_explains_that_account_exists(self) -> None:
        main = source(CLIENT / "src" / "main" / "main.ts")
        registration = main[main.index('ipcMain.handle("auth:register"'):main.index('ipcMain.handle("auth:refresh"')]
        self.assertIn("accountCreated = true", registration)
        self.assertIn("Your account was created", registration)
        self.assertIn("Switch to Sign in", registration)

    def test_composite_invite_parts_are_strictly_bounded(self) -> None:
        main = source(CLIENT / "src" / "main" / "main.ts")
        parser = main[main.index("function inviteParts"):main.index("function authError")]
        self.assertGreaterEqual(parser.count("{43}"), 2)
        self.assertIn("serverToken", parser)
        self.assertIn("chatKey", parser)


class InviteOnlyRegistrationContractTests(unittest.TestCase):
    def test_registration_contract_requires_invite_and_has_no_open_signup_path(self) -> None:
        contracts = source(SERVER / "contracts.ts")
        all_server = "\n".join(source(path) for path in SERVER.glob("*.ts"))
        self.assertRegex(contracts, r"(?i)register|registration|invite")
        self.assertRegex(all_server, r"(?i)invite")
        self.assertRegex(all_server, r"(?is)(?:invite|registration).*(?:required|invalid|forbidden|used)")
        self.assertNotRegex(all_server, r"(?i)allow.?public.?signup|public.?registration\s*:\s*true")

    def test_invitation_contract_covers_expiry_revocation_and_single_use(self) -> None:
        migration = "\n".join(source(path) for path in MIGRATIONS.glob("*.sql")).lower()
        for field in ("invites", "token_hash", "expires_at", "revoked_at", "used_at"):
            self.assertIn(field, migration, f"Migration must persist invitation {field}")
        server = "\n".join(source(path) for path in SERVER.glob("*.ts")).lower()
        for term in ("invite", "expires", "revoke", "used"):
            self.assertIn(term, server, f"Server contract must enforce invitation {term}")


class RefreshTokenContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.auth = source(SERVER / "auth.ts")
        self.migration = "\n".join(source(path) for path in MIGRATIONS.glob("*.sql")).lower()

    def test_refresh_tokens_are_opaque_random_values_and_only_hashes_are_persisted(self) -> None:
        self.assertRegex(self.auth, r"randomBytes\(\s*32\s*\)")
        self.assertRegex(self.auth, r"createHash\(\s*[\"']sha256[\"']\s*\)")
        self.assertRegex(self.auth, r"refreshTokenHash:\s*hashOpaqueToken\(")
        self.assertIn("refresh_token_hash", self.migration)

    def test_refresh_rotation_revokes_old_session_and_rejects_reuse(self) -> None:
        refresh = self.auth[self.auth.index("async refresh"):]
        self.assertRegex(refresh, r"findByRefreshTokenHash\(\s*hashOpaqueToken")
        self.assertRegex(refresh, r"oldSession\.revokedAt")
        self.assertRegex(refresh, r"await dependencies\.sessions\.create")
        self.assertRegex(refresh, r"await dependencies\.sessions\.revoke\(oldSession\.id")
        self.assertIn("revoked_at", self.migration)

    def test_logout_revokes_the_refresh_session_server_side(self) -> None:
        logout = self.auth[self.auth.index("async logout"):]
        self.assertRegex(logout, r"findByRefreshTokenHash\(\s*hashOpaqueToken")
        self.assertRegex(logout, r"await dependencies\.sessions\.revoke\(")


class ClientSecretBoundaryContractTests(unittest.TestCase):
    SECRET_NAMES = re.compile(
        r"(?:DATABASE_URL|DATABASE_PASSWORD|SESSION_SECRET|LIVEKIT_API_SECRET|"
        r"INITIAL_ADMIN_PASSWORD|JWT_SECRET|SIGNING_SECRET|S3_SECRET_ACCESS_KEY|"
        r"AWS_SECRET_ACCESS_KEY)",
        re.IGNORECASE,
    )

    def test_client_sources_and_generated_artifacts_do_not_reference_server_secrets(self) -> None:
        if not CLIENT.is_dir():
            self.skipTest("desktop client is not present yet")
        violations: list[str] = []
        for path in client_files():
            if self.SECRET_NAMES.search(source(path)):
                violations.append(str(path.relative_to(ROOT)))
        self.assertEqual([], violations, f"Server secret identifiers found in client files: {violations}")

    def test_client_contract_does_not_persist_bearer_credentials_in_local_storage(self) -> None:
        if not CLIENT.is_dir():
            self.skipTest("desktop client is not present yet")
        client_sources = "\n".join(
            source(path)
            for path in client_files()
        )
        self.assertNotRegex(client_sources, r"(?i)localStorage\.(?:setItem|getItem).*?(?:access|refresh|bearer|token)")


class AuthenticationMigrationContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sql = "\n".join(source(path) for path in MIGRATIONS.glob("*.sql")).lower()

    def test_migration_has_auth_tables_and_constraints(self) -> None:
        for table in ("users", "invites", "user_sessions"):
            self.assertRegex(self.sql, rf"create table(?: if not exists)? {table}\b")
        for constraint in ("users_username_idx", "user_sessions_refresh_token_idx"):
            self.assertIn(constraint, self.sql)
        self.assertRegex(self.sql, r"password_hash\s+text\s+not null")
        self.assertRegex(self.sql, r"refresh_token_hash\s+text\s+not null")

    def test_migration_is_transactional_idempotent_and_contains_no_plaintext_secret_defaults(self) -> None:
        self.assertTrue(self.sql.lstrip().startswith("--") or self.sql.lstrip().startswith("begin;"))
        self.assertIn("begin;", self.sql)
        self.assertIn("commit;", self.sql)
        self.assertIn("on conflict", self.sql)
        self.assertNotRegex(self.sql, r"(?:password|token|secret)\s+[^,\n]*default\s+['\"]")


if __name__ == "__main__":
    unittest.main()
