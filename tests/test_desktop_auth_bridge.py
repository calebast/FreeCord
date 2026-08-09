from __future__ import annotations

import re
import unittest
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps" / "desktop"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class DesktopAuthBridgeInvariantTests(unittest.TestCase):
    def setUp(self) -> None:
        self.preload = read(DESKTOP / "src/preload/preload.ts")
        self.bridge = read(DESKTOP / "src/shared/bridge.ts")
        self.main = read(DESKTOP / "src/main/main.ts")

    def test_auth_bridge_uses_only_explicit_typed_listener_channels(self) -> None:
        self.assertIn("contextBridge.exposeInMainWorld", self.preload)
        self.assertNotRegex(self.preload, r"ipcRenderer\.(?:send|sendSync|once)")
        self.assertEqual(1, self.preload.count('ipcRenderer.on("realtime:event", wrapped)'))
        self.assertEqual(1, self.preload.count('ipcRenderer.removeListener("realtime:event", wrapped)'))
        self.assertIn("onRealtimeEvent(listener:", self.bridge)
        listener_channels = re.findall(r'ipcRenderer\.on\("([^"]+)", wrapped\)', self.preload)
        remove_channels = re.findall(r'ipcRenderer\.removeListener\("([^"]+)", wrapped\)', self.preload)
        self.assertEqual(
            {
                "audio:linux-screen-data",
                "audio:linux-screen-error",
                "realtime:event",
                "window:fullscreen-changed",
            },
            set(listener_channels),
        )
        self.assertEqual(Counter(listener_channels), Counter(remove_channels))
        channels = re.findall(r'ipcRenderer\.invoke\("([^"]+)"', self.preload)
        self.assertTrue(channels, "The preload must expose a concrete IPC surface")
        duplicates = {channel for channel, count in Counter(channels).items() if count > 1}
        self.assertEqual(
            {"files:show"},
            duplicates,
            "Only explicit compatibility aliases may reuse an IPC channel",
        )
        for channel in channels:
            self.assertRegex(
                channel,
                r"^(?:audio|auth|chat|community|files|media|profile|runtime|settings|voice|window):[a-z0-9-]+$",
            )
        self.assertNotRegex(self.preload, r"(?:accessToken|refreshToken|Bearer|LIVEKIT_API_SECRET|SESSION_SECRET)")

    def test_bridge_types_do_not_return_backend_secrets_or_raw_ipc(self) -> None:
        self.assertNotRegex(self.bridge, r"(?i)\b(?:accessToken|refreshToken|apiSecret|bearerToken)\b")
        self.assertNotIn("ipcRenderer", self.bridge)
        # Tokens may exist transiently in the privileged main process; the
        # invariant is that they never cross the typed bridge surface.
        self.assertNotRegex(self.bridge, r"(?i)\b(?:accessToken|refreshToken|apiSecret|bearerToken)\b\s*[:=]")

    def test_auth_storage_is_private_and_restricted_to_non_secret_settings(self) -> None:
        self.assertRegex(self.main, r"app\.getPath\(\"userData\"\)")
        self.assertRegex(self.main, r"mode:\s*0o600")
        self.assertNotRegex(self.main, r"(?i)localStorage|sessionStorage|indexedDB")
        self.assertNotRegex(self.main, r"(?i)writeFile\([^\n]*(?:token|password|secret)")

    def test_auth_requests_are_not_constructed_in_the_renderer_bridge(self) -> None:
        # Authentication belongs to the server API; the preload is only a
        # capability bridge and must not become a second network client.
        self.assertNotRegex(self.preload, r"(?i)(?:fetch|axios|XMLHttpRequest|WebSocket)")

    def test_expired_access_tokens_use_one_non_recursive_single_flight_refresh(self) -> None:
        self.assertIn('endpoint === "/v1/auth/refresh"', self.main)
        self.assertIn("const requestAccessToken = unauthenticatedEndpoint ? null : accessToken", self.main)
        self.assertIn("let refreshInFlight:", self.main)
        self.assertIn("if (refreshInFlight) return refreshInFlight", self.main)
        self.assertIn("accessToken !== requestAccessToken", self.main)
        self.assertIn("requestJson<T>(origin, endpoint, init, timeoutMs, false, requestGeneration)", self.main)
        self.assertIn("authenticationGeneration === generation", self.main)
        self.assertIn("serializeCredentialMutation", self.main)
        self.assertIn('error.name === "Unauthorized" && authenticationGeneration === generation', self.main)
        self.assertIn("authContextStillCurrent(requestGeneration, origin)", self.main)
        self.assertIn("if (signOutInProgress)", self.main)

    def test_native_attachment_picker_exposes_no_arbitrary_path_capability(self) -> None:
        self.assertIn('dialog.showOpenDialog(mainWindow', self.main)
        self.assertIn('ipcRenderer.invoke("media:choose-and-upload")', self.preload)
        self.assertIn("chooseAndUploadMedia():", self.bridge)
        self.assertNotRegex(self.bridge, r"chooseAndUploadMedia\([^)]*(?:path|fileName)")
        self.assertIn("details.size > maxBytes", self.main)
        self.assertIn('const handle = await open(selectedPath, "r")', self.main)
        self.assertIn("await handle.stat()", self.main)
        self.assertIn("await handle.read(", self.main)
        self.assertIn("nativeMediaSelectionInFlight", self.main)
        self.assertNotIn("await stat(selectedPath)", self.main)


if __name__ == "__main__":
    unittest.main()
