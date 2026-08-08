from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "apps" / "desktop" / "src" / "main" / "main.ts"
VOICE = ROOT / "apps" / "desktop" / "src" / "renderer" / "voice.ts"
RNNOISE = ROOT / "apps" / "desktop" / "src" / "renderer" / "rnnoise-processor.ts"
RENDERER = ROOT / "apps" / "desktop" / "src" / "renderer" / "main.tsx"
STYLES = ROOT / "apps" / "desktop" / "src" / "renderer" / "styles.css"


class FilesSurfaceSecurityContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Read only the two authoritative source files. Never recurse through
        # release/, node_modules/, or generated package output.
        cls.main = MAIN.read_text(encoding="utf-8")

    def test_files_surface_uses_an_isolated_sandboxed_webcontents_view(self) -> None:
        self.assertIn("new WebContentsView", self.main)
        self.assertNotIn("new BrowserView", self.main)
        self.assertRegex(self.main, r'partition:\s*"freecord-copyparty"')
        self.assertNotIn('partition: "persist:freecord-copyparty"', self.main)
        for safeguard in (
            "contextIsolation: true",
            "nodeIntegration: false",
            "nodeIntegrationInWorker: false",
            "nodeIntegrationInSubFrames: false",
            "sandbox: true",
            "webSecurity: true",
            "webviewTag: false",
            "allowRunningInsecureContent: false",
            "navigateOnDragDrop: false",
        ):
            self.assertIn(safeguard, self.main)

    def test_files_origin_navigation_permissions_and_popups_are_denied_by_default(self) -> None:
        self.assertRegex(self.main, r'parsed\.protocol === "https:"')
        self.assertIn("parsed.origin === filesOrigin", self.main)
        self.assertIn('setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))', self.main)
        self.assertIn("setPermissionCheckHandler(() => false)", self.main)
        self.assertIn('setWindowOpenHandler(() => ({ action: "deny" }))', self.main)
        self.assertRegex(self.main, r'will-navigate[\s\S]{0,180}isAllowedFilesNavigation')
        self.assertRegex(self.main, r'will-redirect[\s\S]{0,180}isAllowedFilesNavigation')
        self.assertIn("urlChain.every(isAllowedFilesNavigation)", self.main)

    def test_files_ipc_validates_sender_and_clamps_renderer_bounds(self) -> None:
        trusted_body = re.search(
            r"function isTrustedIpcEvent\([\s\S]+?\n}\n\n",
            self.main,
        )
        self.assertIsNotNone(trusted_body)
        trusted = trusted_body.group(0) if trusted_body else ""
        self.assertIn("event.sender === mainWindow.webContents", trusted)
        self.assertIn("event.senderFrame === mainWindow.webContents.mainFrame", trusted)
        self.assertIn("isAllowedNavigation(event.senderFrame.url)", trusted)
        self.assertRegex(
            self.main,
            r"rawIpcMain\.handle\(channel,[\s\S]{0,180}!isTrustedIpcEvent\(event\)",
        )
        self.assertIn("Number.isFinite(value)", self.main)
        self.assertIn("mainWindow.getContentBounds()", self.main)
        for channel in ("files:show", "files:update-bounds", "files:hide"):
            start = self.main.find(f'ipcMain.handle("{channel}"')
            self.assertGreaterEqual(start, 0, channel)


class WindowsScreenShareStateContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.main = MAIN.read_text(encoding="utf-8")
        cls.voice = VOICE.read_text(encoding="utf-8")

    def test_electron_capture_grants_loopback_only_for_requested_windows_audio(self) -> None:
        self.assertIn('process.platform === "win32" && request.audioRequested', self.main)
        self.assertRegex(self.main, r"let completed = false;[\s\S]{0,180}if \(completed\) return;[\s\S]{0,100}callback\(streams\)")
        self.assertIn("request.frame !== mainWindow.webContents.mainFrame", self.main)
        self.assertIn("isAllowedNavigation(requestingUrl)", self.main)

    def test_picker_handles_source_selection_in_both_navigation_events(self) -> None:
        self.assertIn('picker.webContents.on("will-navigate", handlePickerNavigation)', self.main)
        self.assertIn(
            'picker.webContents.on("will-frame-navigate", (details) => '
            'handlePickerNavigation(details, details.url))',
            self.main,
        )
        self.assertRegex(self.main, r"const handlePickerNavigation = [\s\S]{0,650}freecord-source:")
        self.assertNotIn('on("will-frame-navigate", (event) => event.preventDefault())', self.main)

    def test_screen_share_is_generation_guarded_and_publishes_video_before_audio(self) -> None:
        self.assertIn(
            'export type ScreenSharePhase = "idle" | "selecting" | "publishing-video" | "publishing-audio" | "active" | "stopping"',
            self.voice,
        )
        capture = self.voice.index("createScreenTracks(")
        video_phase = self.voice.index('setScreenSharePhase("publishing-video")', capture)
        video_publish = self.voice.index("publishTrack(videoTrack", video_phase)
        video_active = self.voice.index("screenSharing: true", video_publish)
        audio_phase = self.voice.index('setScreenSharePhase("publishing-audio")', video_active)
        audio_publish = self.voice.index("publishTrack(audioTrack", audio_phase)
        self.assertLess(capture, video_phase)
        self.assertLess(video_phase, video_publish)
        self.assertLess(video_publish, video_active)
        self.assertLess(video_active, audio_phase)
        self.assertLess(audio_phase, audio_publish)
        self.assertGreaterEqual(self.voice.count("isCurrentScreenShareOperation(room, generation)"), 6)
        self.assertRegex(self.voice, r"catch \(error: unknown\) \{\s*await this\.releaseScreenTracks\(room, capturedTracks\)")

    def test_screen_audio_publication_cannot_mark_video_sharing_active(self) -> None:
        published_handler = re.search(
            r"RoomEvent\.LocalTrackPublished[\s\S]+?RoomEvent\.LocalTrackUnpublished",
            self.voice,
        )
        self.assertIsNotNone(published_handler)
        handler = published_handler.group(0) if published_handler else ""
        screen_audio_branch = re.search(r"ScreenShareAudio[\s\S]{0,420}", handler)
        self.assertIsNotNone(screen_audio_branch)
        self.assertNotIn("screenSharing: true", screen_audio_branch.group(0) if screen_audio_branch else "")


class CommunityEmotePickerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.renderer = RENDERER.read_text(encoding="utf-8")
        cls.styles = STYLES.read_text(encoding="utf-8")

    def test_composer_picker_refreshes_and_renders_community_emotes(self) -> None:
        self.assertIn("refreshCommunityEmotes", self.renderer)
        self.assertRegex(self.renderer, r'emoji-picker[\s\S]{0,1000}emotes\.map\(\(emote\)')
        self.assertIn("insertCustomEmote(emote)", self.renderer)
        self.assertIn("renderMessageText(chatMessage.content", self.renderer)

    def test_custom_emotes_use_the_authenticated_bounded_image_component(self) -> None:
        self.assertIn("function CustomEmoteImage", self.renderer)
        self.assertIn("getMediaImageData(emote.asset.assetId)", self.renderer)
        self.assertIn("customEmoteImageCache", self.renderer)
        self.assertIn("emote.asset.version", self.renderer)
        self.assertGreaterEqual(self.renderer.count("<CustomEmoteImage"), 5)
        self.assertNotRegex(self.renderer, r'<img[^>]+src=\{`freecord-media://asset/\$\{emote')

    def test_emote_pickers_are_viewport_bounded_and_scrollable(self) -> None:
        for selector in (".emoji-picker", ".reaction-picker"):
            rule = re.search(re.escape(selector) + r"\s*\{([^}]+)\}", self.styles)
            self.assertIsNotNone(rule, selector)
            body = rule.group(1) if rule else ""
            self.assertIn("max-height:", body)
            self.assertIn("overflow-y: auto", body)
            self.assertIn("calc(100vh", body)

    def test_reaction_picker_opens_into_the_chat_panel(self) -> None:
        rule = re.search(r"\.reaction-picker\s*\{([^}]+)\}", self.styles)
        self.assertIsNotNone(rule)
        body = rule.group(1) if rule else ""
        self.assertIn("left: 0", body)
        self.assertNotIn("right: 0", body)


class AuthenticatedMediaProtocolContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.main = MAIN.read_text(encoding="utf-8")

    def test_custom_media_scheme_explicitly_supports_cross_protocol_images(self) -> None:
        registration = re.search(r"registerSchemesAsPrivileged\(\[\{ scheme: mediaScheme[\s\S]{0,320}?\}\]\)", self.main)
        self.assertIsNotNone(registration)
        body = registration.group(0) if registration else ""
        self.assertIn("standard: true", body)
        self.assertIn("secure: true", body)
        self.assertIn("corsEnabled: true", body)
        self.assertNotIn("bypassCSP: true", body)
        self.assertIn('responseHeaders.set("access-control-allow-origin", "*")', self.main)
        self.assertIn('responseHeaders.set("cross-origin-resource-policy", "cross-origin")', self.main)

    def test_small_image_ipc_fallback_is_authenticated_typed_and_bounded(self) -> None:
        bridge = (ROOT / "apps" / "desktop" / "src" / "shared" / "bridge.ts").read_text(encoding="utf-8")
        preload = (ROOT / "apps" / "desktop" / "src" / "preload" / "preload.ts").read_text(encoding="utf-8")
        self.assertIn("getMediaImageData(assetId: string)", bridge)
        self.assertIn('ipcRenderer.invoke("media:get-image-data", assetId)', preload)
        self.assertIn('ipcMain.handle("media:get-image-data"', self.main)
        self.assertIn("fetchMediaFromServer(new Request", self.main)
        self.assertIn("const maxImageBytes = 2 * 1024 * 1024", self.main)
        self.assertRegex(self.main, r'contentType !== "image/jpeg"[\s\S]{0,260}contentType !== "image/gif"')


class SettingsScrollContainmentContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.renderer = RENDERER.read_text(encoding="utf-8")
        cls.styles = STYLES.read_text(encoding="utf-8")

    def css_rule(self, selector: str) -> str:
        rule = re.search(re.escape(selector) + r"\s*\{([^}]+)\}", self.styles)
        self.assertIsNotNone(rule, selector)
        return rule.group(1) if rule else ""

    def test_settings_header_is_separate_from_bounded_scroll_body(self) -> None:
        self.assertIn('className="settings-scroll"', self.renderer)
        panel = self.css_rule(".settings-panel")
        self.assertIn("grid-template-rows: auto minmax(0, 1fr)", panel)
        self.assertIn("overflow: hidden", panel)
        scroll = self.css_rule(".settings-scroll")
        self.assertIn("min-height: 0", scroll)
        self.assertIn("overflow-y: auto", scroll)
        self.assertIn("overscroll-behavior: contain", scroll)

    def test_emote_list_cannot_expand_the_application_layout(self) -> None:
        shell = self.css_rule(".app-shell")
        self.assertIn("position: relative", shell)
        emotes = self.css_rule(".emote-admin-grid")
        self.assertIn("max-height:", emotes)
        self.assertIn("overflow-y: auto", emotes)
        self.assertIn("overscroll-behavior: contain", emotes)

    def test_settings_can_always_be_closed_with_escape(self) -> None:
        self.assertRegex(
            self.renderer,
            r'if \(!settingsOpen\) return;[\s\S]{0,260}event\.key === "Escape"[\s\S]{0,100}setSettingsOpen\(false\)',
        )


class SettingsAccountAndAdministrationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.renderer = RENDERER.read_text(encoding="utf-8")
        cls.main = MAIN.read_text(encoding="utf-8")
        cls.bridge = (ROOT / "apps" / "desktop" / "src" / "shared" / "bridge.ts").read_text(encoding="utf-8")
        cls.preload = (ROOT / "apps" / "desktop" / "src" / "preload" / "preload.ts").read_text(encoding="utf-8")
        cls.server = (ROOT / "server" / "http-server.ts").read_text(encoding="utf-8")

    def test_settings_has_profile_audio_and_permission_gated_admin_tabs(self) -> None:
        self.assertIn('settingsTab === "profile"', self.renderer)
        self.assertIn('settingsTab === "audio"', self.renderer)
        self.assertIn('canAccessAdmin && <button', self.renderer)
        self.assertIn('Members and roles', self.renderer)

    def test_profile_and_password_mutations_cross_only_the_typed_bridge(self) -> None:
        self.assertIn("updateProfile(input: UpdateProfileInput)", self.bridge)
        self.assertIn("changePassword(input: ChangePasswordInput)", self.bridge)
        self.assertIn('ipcRenderer.invoke("profile:update", input)', self.preload)
        self.assertIn('ipcRenderer.invoke("profile:change-password", input)', self.preload)
        self.assertIn('ipcMain.handle("profile:update"', self.main)
        self.assertIn('ipcMain.handle("profile:change-password"', self.main)

    def test_channel_rename_requires_the_server_manage_permission(self) -> None:
        self.assertIn("updateChannel(channelId: string, name: string)", self.bridge)
        self.assertIn('ipcMain.handle("community:update-channel"', self.main)
        self.assertRegex(self.server, r"UPDATE channels c SET name[\s\S]{0,650}permission_key = 'channels\.manage'")

    def test_emote_uploader_stays_in_profile_and_is_permission_gated(self) -> None:
        profile_emotes = re.search(
            r'settingsTab === "profile"[\s\S]+?hasPermission\("emotes\.create"\)[\s\S]+?Upload emote',
            self.renderer,
        )
        self.assertIsNotNone(profile_emotes)


class RnnoiseAudioProcessingContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.main = MAIN.read_text(encoding="utf-8")
        cls.voice = VOICE.read_text(encoding="utf-8")
        cls.processor = RNNOISE.read_text(encoding="utf-8")
        cls.renderer = RENDERER.read_text(encoding="utf-8")
        cls.package = (ROOT / "apps" / "desktop" / "package.json").read_text(encoding="utf-8")

    def test_rnnoise_dependency_and_assets_are_pinned_and_bundled(self) -> None:
        self.assertIn('"@sapphi-red/web-noise-suppressor": "0.3.5"', self.package)
        self.assertIn('rnnoise.wasm?url', self.processor)
        self.assertIn('rnnoise_simd.wasm?url', self.processor)
        self.assertIn('rnnoiseWorklet.js?url', self.processor)
        self.assertIn('readonly name = "freecord-rnnoise"', self.processor)
        self.assertIn("options.audioContext ?? this.audioContext", self.processor)
        self.assertIn("this.processedTrack?.stop()", self.processor)

    def test_rnnoise_uses_livekit_track_processing_and_avoids_double_suppression(self) -> None:
        self.assertIn("microphone.setProcessor(new FreeCordRnnoiseProcessor())", self.voice)
        self.assertIn("await microphone.stopProcessor()", self.voice)
        self.assertRegex(
            self.voice,
            r"noiseSuppression:\s*this\.audioPreferences\.rnnoiseEnabled\s*\?\s*false\s*:\s*this\.audioPreferences\.nativeNoiseSuppression",
        )
        self.assertIn("sampleRate: 48_000", self.voice)
        self.assertIn("channelCount: 1", self.voice)

    def test_existing_settings_migrate_to_safe_audio_defaults(self) -> None:
        self.assertIn("rnnoiseEnabled: value.rnnoiseEnabled === true", self.main)
        self.assertIn("echoCancellation: value.echoCancellation !== false", self.main)
        self.assertIn("automaticGainControl: value.automaticGainControl !== false", self.main)
        self.assertIn("nativeNoiseSuppression: value.nativeNoiseSuppression !== false", self.main)

    def test_voice_settings_expose_processing_controls_and_runtime_status(self) -> None:
        for label in (
            "RNNoise suppression",
            "Echo cancellation",
            "Automatic gain control",
            "Built-in noise suppression",
            "RNNoise active",
        ):
            self.assertIn(label, self.renderer)


if __name__ == "__main__":
    unittest.main()
