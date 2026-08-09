from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class VoiceRosterAndUiContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.renderer = (ROOT / "apps/desktop/src/renderer/main.tsx").read_text(encoding="utf-8")
        cls.styles = (ROOT / "apps/desktop/src/renderer/styles.css").read_text(encoding="utf-8")
        cls.main = (ROOT / "apps/desktop/src/main/main.ts").read_text(encoding="utf-8")
        cls.server = (ROOT / "server/http-server.ts").read_text(encoding="utf-8")

    def test_voice_rosters_are_permission_filtered_and_do_not_join_hidden_rooms(self) -> None:
        presence = (ROOT / "server/voice-presence.ts").read_text(encoding="utf-8")
        self.assertIn('resolveChannelPermission(this.database, userId, row.channel_id, "voice.connect", "voice")', presence)
        self.assertIn("listParticipants(room)", presence)
        self.assertNotIn("joinRoom", presence)
        self.assertIn('url.pathname === "/v1/community/voice-presence"', self.server)
        self.assertIn('ipcMain.handle("community:get-voice-presence"', self.main)
        self.assertIn("normalizeVoicePresenceResponse", self.main)
        self.assertIn("window.freecord.getVoicePresence()", self.renderer)
        self.assertIn("voicePresenceInFlight", self.renderer)

    def test_sidebar_scrolls_without_moving_voice_and_profile_controls(self) -> None:
        self.assertIn('<div className="sidebar-scroll">', self.renderer)
        scroll_end = self.renderer.index("</div>\n            {voiceState.status", self.renderer.index('<div className="sidebar-scroll">'))
        self.assertGreater(self.renderer.index('className="voice-dock"'), scroll_end)
        self.assertGreater(self.renderer.index('className="sidebar-footer"'), scroll_end)
        self.assertIn(".sidebar-scroll { min-height: 0; flex: 1 1 auto; overflow-y: auto", self.styles)

    def test_reaction_control_is_delayed_and_messages_have_hover_outline(self) -> None:
        self.assertIn("}, 1_000);", self.renderer)
        self.assertIn("onPointerEnter={() => scheduleReactionAffordance", self.renderer)
        self.assertIn(".chat-message:hover, .chat-message:focus-within", self.styles)
        self.assertIn(".message-actions .reaction-add.visible", self.styles)


if __name__ == "__main__":
    unittest.main()
