# CachyOS test audio

`freecord-test-audio.conf` creates persistent 48 kHz virtual devices through
PipeWire's PulseAudio compatibility server:

- `FreeCord-Test-Speaker`: stereo output that safely discards playback.
- `FreeCord-Test-Microphone`: mono input sourced from the monitor of the
  `FreeCord-Test-Microphone-Bus` sink.

Install the configuration for the logged-in test user:

```sh
mkdir -p ~/.config/pipewire/pipewire-pulse.conf.d
install -m 0644 deploy/cachyos/freecord-test-audio.conf \
  ~/.config/pipewire/pipewire-pulse.conf.d/99-freecord-test-audio.conf
systemctl --user restart pipewire-pulse.service
pactl set-default-sink freecord_test_speaker
pactl set-default-source freecord_test_microphone
```

On a test system with FFmpeg, inject a short tone into the fake microphone
without changing the default speaker:

```sh
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i 'sine=frequency=440:duration=2:sample_rate=48000' \
  -ac 1 -device freecord_test_microphone_bus -f pulse freecord-test-tone
```

`verify-electron-audio.mjs` can query an explicitly enabled local Electron
DevTools endpoint during a controlled VM smoke test. It requests an audio
stream, lists only device kinds and labels, stops the stream, and never prints
device identifiers or credentials. Do not expose the debugging port beyond
loopback.

Remove only this test setup by deleting the installed drop-in and restarting
`pipewire-pulse.service`. Do not disable PipeWire or WirePlumber.
