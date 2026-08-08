type SoundName = "join" | "leave" | "message" | "participant-join" | "participant-leave" | "mute" | "deafen";

const soundFrequencies: Record<SoundName, number[]> = {
  join: [440, 660],
  leave: [660, 440],
  message: [740],
  "participant-join": [520, 780],
  "participant-leave": [520, 360],
  mute: [280, 180],
  deafen: [220, 120],
};

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext === "undefined") return null;
  audioContext ??= new window.AudioContext();
  return audioContext;
}

export function playNotificationSound(name: SoundName): void {
  const context = getAudioContext();
  if (!context) return;
  void context.resume().catch(() => undefined);

  const start = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.07, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
  gain.connect(context.destination);

  soundFrequencies[name].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = name === "message" ? "sine" : "triangle";
    oscillator.frequency.setValueAtTime(frequency, start + index * 0.065);
    oscillator.connect(gain);
    oscillator.start(start + index * 0.065);
    oscillator.stop(start + 0.2 + index * 0.065);
  });
}
