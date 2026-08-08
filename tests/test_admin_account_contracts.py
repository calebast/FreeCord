from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AdminAccountContracts(unittest.TestCase):
    def test_migration_adds_dedicated_permissions_without_destructive_user_delete(self) -> None:
        migration = (ROOT / "database/migrations/0010_admin_accounts.sql").read_text(encoding="utf-8")
        for permission in ("members.password.reset", "members.deactivate", "voice.restrictions.manage"):
            self.assertIn(permission, migration)
        self.assertIn("0010_admin_accounts", migration)
        self.assertNotIn("DELETE FROM users", migration)

    def test_backend_enforces_hierarchy_sessions_audit_and_tombstones(self) -> None:
        service = (ROOT / "server/account-admin.ts").read_text(encoding="utf-8")
        for contract in (
            "actorId === targetId",
            "target.is_owner",
            "target.is_admin",
            "target.highest_position",
            "members.password.reset",
            "members.deactivate",
            "voice.restrictions.manage",
            "admin_password_reset",
            "account.password_reset",
            "account.deactivated",
            "voice.restrictions_cleared",
            "is_active = false",
        ):
            self.assertIn(contract, service)
        self.assertNotIn("DELETE FROM users", service)

    def test_api_and_electron_bridge_use_narrow_validated_operations(self) -> None:
        http = (ROOT / "server/http-server.ts").read_text(encoding="utf-8")
        bridge = (ROOT / "apps/desktop/src/shared/bridge.ts").read_text(encoding="utf-8")
        preload = (ROOT / "apps/desktop/src/preload/preload.ts").read_text(encoding="utf-8")
        main = (ROOT / "apps/desktop/src/main/main.ts").read_text(encoding="utf-8")
        for path in ("password-reset", "deactivate", "voice-restrictions"):
            self.assertIn(path, http)
            self.assertIn(path, main)
        for operation in ("resetMemberPassword", "deactivateMember", "clearMemberVoiceRestrictions"):
            self.assertIn(operation, bridge)
            self.assertIn(operation, preload)
        self.assertIn("isTrustedIpcEvent(event)", main)
        self.assertIn("validOpaqueId(value.userId)", main)
        self.assertIn('value.newPassword.length < 12', main)

    def test_admin_ui_requires_explicit_deactivation_confirmation(self) -> None:
        renderer = (ROOT / "apps/desktop/src/renderer/main.tsx").read_text(encoding="utf-8")
        self.assertIn("memberDeactivateConfirm !== managedMember.username", renderer)
        self.assertIn("Reset password and sign out", renderer)
        self.assertIn("Clear voice restrictions", renderer)
        self.assertIn("This is server state, not a desktop cache", renderer)
        self.assertIn("Messages and audit records remain", renderer)


if __name__ == "__main__":
    unittest.main()
