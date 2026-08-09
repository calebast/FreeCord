# Platform support

| Capability | Windows 10/11 x64 | CachyOS / Arch x64, KDE Wayland |
| --- | --- | --- |
| Package | Unsigned per-user NSIS installer | Unsigned AppImage |
| Audio stack | Windows Core Audio through Chromium | PipeWire/WirePlumber through Chromium |
| Microphone selection | Supported; manual verification required | Supported; manual verification required |
| Speaker selection | Supported where Chromium exposes `setSinkId` | Supported where PipeWire exposes the selected device |
| Mute/deafen and volume | Supported | Supported |
| RNNoise | Supported at 48 kHz; CPU cost varies | Supported at 48 kHz; CPU cost varies |
| Screen selection | In-app Electron picker | KDE xdg-desktop-portal picker |
| Screen audio | Windows loopback where Chromium exposes it | Selectable PipeWire/Pulse output-monitor capture; sink support requires manual verification |
| Wayland | Not applicable | Primary supported session; Vulkan is disabled for stability |
| X11 | Not applicable | Not release-qualified |
| Global push-to-talk | Not release-qualified | Not release-qualified; compositor restrictions apply |
| Signing and automatic updates | Not yet available | Not yet available |

The Windows installer will trigger SmartScreen or reputation warnings because it is unsigned. The AppImage may need executable permission:

```sh
chmod +x FreeCord-*-linux-x86_64.AppImage
./FreeCord-*-linux-x86_64.AppImage
```

On KDE Wayland, ensure `pipewire`, `wireplumber`, `xdg-desktop-portal`, and `xdg-desktop-portal-kde` are active. Do not force Vulkan; FreeCord applies conservative Chromium GPU flags because Wayland/Vulkan combinations have caused hard crashes on tested systems.

The Wayland portal normally provides screen video but may omit desktop audio. FreeCord therefore captures Linux stream audio separately from an input source representing the selected output sink. In Settings → Voice & Audio, choose the PipeWire/Pulse source whose name contains “Monitor” (for example, “Monitor of …”). This stream track bypasses RNNoise, echo cancellation, automatic gain control, and microphone noise suppression.

The helpers under `deploy/cachyos/` can create virtual audio devices for a controlled VM smoke test. They are test-only and do not replace verification on real hardware.
