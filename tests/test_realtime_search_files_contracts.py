from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / "apps/desktop/src/main/main.ts").read_text(encoding="utf-8")
PRELOAD = (ROOT / "apps/desktop/src/preload/preload.ts").read_text(encoding="utf-8")
BRIDGE = (ROOT / "apps/desktop/src/shared/bridge.ts").read_text(encoding="utf-8")
RENDERER = (ROOT / "apps/desktop/src/renderer/main.tsx").read_text(encoding="utf-8")
SEARCH = (ROOT / "apps/desktop/src/renderer/chat-search.ts").read_text(encoding="utf-8")
CONTENT = (ROOT / "apps/desktop/src/renderer/chat-content.tsx").read_text(encoding="utf-8")
STYLES = (ROOT / "apps/desktop/src/renderer/styles.css").read_text(encoding="utf-8")


class RealtimeDesktopBoundaryTests(unittest.TestCase):
    def test_main_process_owns_authenticated_sse_and_validates_events(self) -> None:
        self.assertIn("/v1/realtime/events", MAIN)
        self.assertIn('authorization: `Bearer ${requestAccessToken}`', MAIN)
        self.assertIn("normalizeRealtimeEvent", MAIN)
        self.assertIn('mainWindow.webContents.send("realtime:event", event)', MAIN)
        self.assertNotIn("/v1/realtime/events", PRELOAD)
        self.assertNotRegex(PRELOAD, r"(?i)accessToken|Bearer")

    def test_preload_exposes_only_one_static_listener_with_cleanup(self) -> None:
        self.assertIn('ipcRenderer.on("realtime:event", wrapped)', PRELOAD)
        self.assertIn('ipcRenderer.removeListener("realtime:event", wrapped)', PRELOAD)
        self.assertIn("onRealtimeEvent(listener:", BRIDGE)
        self.assertNotRegex(BRIDGE, r"\bon\(channel")


class PrivateSearchAndMentionTests(unittest.TestCase):
    def test_search_decrypts_existing_pages_locally_without_a_search_endpoint(self) -> None:
        self.assertIn("decryptChatMessage", SEARCH)
        self.assertIn("getMessages(channel.id, cursor)", SEARCH)
        self.assertIn("signal.aborted", SEARCH)
        self.assertNotRegex(MAIN + PRELOAD + BRIDGE, r"/v1/(?:search|messages/search)")
        self.assertNotIn("searchMessages(", BRIDGE)

    def test_mentions_are_tokenized_from_decrypted_text_and_known_members(self) -> None:
        for symbol in ("mentionQueryAtCursor", "mentionSuggestions", "containsMention", "ChatRichText"):
            self.assertIn(symbol, CONTENT)
        self.assertIn("@${username}", CONTENT)
        self.assertNotRegex(BRIDGE, r"mention(?:Ids|Users|Metadata)")


class FilesAndAuditUiTests(unittest.TestCase):
    def test_copyparty_and_server_files_are_separate_bounded_views(self) -> None:
        self.assertIn('"chat" | "copyparty" | "server-files"', RENDERER)
        self.assertIn(">Server Files<", RENDERER)
        self.assertIn(">Copyparty<", RENDERER)
        self.assertIn('activeView !== "copyparty"', RENDERER)
        self.assertIn("getSharedFiles", BRIDGE)
        self.assertNotIn("messageCiphertext", BRIDGE)
        self.assertIn("window.freecord.getMessage(file.channelId, file.messageId)", RENDERER)

    def test_returning_to_chat_restores_bottom_and_successful_send_restores_focus(self) -> None:
        self.assertIn("previousActiveViewRef", RENDERER)
        self.assertIn('activeView !== "chat" || previousView === "chat"', RENDERER)
        self.assertIn("element.scrollTop = element.scrollHeight", RENDERER)
        self.assertIn("chatInputRef.current?.focus()", RENDERER)

    def test_attachment_upload_is_linux_tolerant_and_composer_remains_bounded(self) -> None:
        self.assertIn("chooseAndUploadMedia", RENDERER)
        self.assertIn("selectedMediaMimeByExtension", MAIN)
        self.assertIn('properties: ["openFile"]', MAIN)
        self.assertIn('className="workspace-toast"', RENDERER)
        self.assertIn('role="status"', RENDERER)
        self.assertIn("Attachment selection canceled.", RENDERER)
        self.assertIn("FreeCord attachment operation failed", MAIN)
        self.assertIn("180_000", MAIN)
        self.assertIn("grid-template-rows: 66px minmax(0, 1fr) auto", STYLES)
        self.assertIn(".chat-composer.has-preview", STYLES)
        self.assertIn('button[type="submit"] { grid-row: 2; grid-column: 5; }', STYLES)
        self.assertIn("screenViewerOpen || voiceParticipantMenu", RENDERER)

    def test_composer_supports_shift_enter_without_changing_normal_send(self) -> None:
        self.assertIn("<textarea ref={chatInputRef}", RENDERER)
        self.assertIn('event.key === "Enter" && !event.shiftKey', RENDERER)
        self.assertIn("event.currentTarget.form?.requestSubmit()", RENDERER)

    def test_private_search_state_is_cleared_and_generation_guarded(self) -> None:
        for cleanup in ('setSearchQuery("")', "setSearchResults([])", "setSearchProgress(null)"):
            self.assertIn(cleanup, RENDERER)
        self.assertIn("sessionGenerationRef.current", RENDERER)
        self.assertIn("sessionGenerationRef.current === generation", RENDERER)

    def test_audit_table_rejects_truncate(self) -> None:
        migration = (ROOT / "database/migrations/0009_audit_events.sql").read_text(encoding="utf-8")
        self.assertIn("BEFORE TRUNCATE ON audit_events", migration)

    def test_audit_log_is_permission_gated_and_contains_no_message_content(self) -> None:
        self.assertIn('hasPermission("audit.view")', RENDERER)
        self.assertIn("getAuditLog", BRIDGE)
        self.assertIn("Message contents and secrets are never shown.", RENDERER)
        audit_block = re.search(r'settingsTab === "audit"[\s\S]{0,2500}', RENDERER)
        self.assertIsNotNone(audit_block)
        self.assertNotRegex(audit_block.group(0) if audit_block else "", r"ciphertext|nonce|chatMessage\.content")


if __name__ == "__main__":
    unittest.main()
