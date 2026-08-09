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
| Screen audio | Electron/Chromium system loopback capture with best-effort own-app exclusion | Experimental and not release-qualified; physical testing can still capture microphone/self audio instead of application playback |
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

The Wayland portal provides screen video but not a dependable desktop-audio track. FreeCord currently contains an experimental native PipeWire capture path, but physical CachyOS testing still reproduced microphone/self-audio publication instead of the intended application playback. Treat Linux screen audio as unsupported for release acceptance until that directional capture is replaced or proven on physical systems. Screen video remains supported through the KDE portal. PipeWire, `pipewire-pulse`, WirePlumber, and the KDE portal must be active.

The helpers under `deploy/cachyos/` can create virtual audio devices for a controlled VM smoke test. They are test-only and do not replace verification on real hardware.
