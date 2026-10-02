"""Original, deterministic notification sounds; no samples or third-party audio.

Run from any directory: python apps/desktop/scripts/generate-notification-sounds.py
The WAVs are checked-in product assets; Python is not a runtime dependency.
"""

import array
import math
import random
import sys
import wave
from pathlib import Path

RATE = 44100
OUTPUT = Path(__file__).resolve().parents[1] / "src/renderer/public/notification-sounds"
SOUNDS = {
    "soft-rise": (0.68, [(0, 440, 0.31), (0.145, 659.255, 0.43)], 0.09, 0.0),
    "warm-fall": (0.56, [(0, 659.255, 0.26), (0.13, 523.251, 0.36)], 0.16, 0.0),
    "wood-tap": (0.45, [(0, 392, 0.19), (0.105, 493.883, 0.25)], 0.28, 0.055),
    "air-chime": (
        0.80,
        [(0, 523.251, 0.40), (0.10, 659.255, 0.40), (0.20, 783.991, 0.48)],
        0.045,
        0.0,
    ),
    "round-pop": (0.48, [(0, 392, 0.34)], 0.13, 0.0, 0.85),
    "tiny-pluck": (0.36, [(0, 587.33, 0.27)], 0.38, 0.02),
    "soft-bloom": (
        0.94,
        [(0, 261.626, 0.72), (0.035, 329.628, 0.70), (0.065, 391.995, 0.68)],
        0.06,
        0.0,
    ),
    "felt-pulse": (0.50, [(0, 329.628, 0.20), (0.105, 440, 0.28)], 0.22, 0.035),
    "soft-rise-low": (0.68, [(0, 392, 0.31), (0.155, 523.251, 0.43)], 0.09, 0.0),
    "soft-rise-light": (0.60, [(0, 493.883, 0.25), (0.12, 739.989, 0.36)], 0.09, 0.0),
    "soft-rise-close": (0.66, [(0, 440, 0.30), (0.145, 554.365, 0.40)], 0.09, 0.0),
    "soft-rise-relaxed": (0.82, [(0, 349.228, 0.35), (0.21, 523.251, 0.49)], 0.09, 0.0),
}


def synthesize(duration, notes, harmonic, noise, bend=0.0):
    frames = [0.0] * round(duration * RATE)
    rng = random.Random(17)
    for start, frequency, length in notes:
        count = round(length * RATE)
        first = round(start * RATE)
        for i in range(count):
            t = i / RATE
            attack = math.sin(min(1.0, t / 0.012) * math.pi / 2) ** 2
            release = (
                math.sin(min(1.0, (count - 1 - i) / (RATE * 0.055)) * math.pi / 2) ** 2
            )
            envelope = attack * release * math.exp(-5.5 * t / length)
            # Integrate a quick downward pitch glide for the rounded pop.
            phase = (
                math.tau * frequency * (t + bend * 0.018 * (1 - math.exp(-t / 0.018)))
            )
            tone = (
                math.sin(phase)
                + harmonic * math.sin(2 * phase)
                + harmonic * 0.2 * math.sin(3 * phase)
            )
            tone += noise * rng.uniform(-1, 1) * math.exp(-t / 0.018)
            for lag, gain in [
                (0, 1),
                (round(RATE * 0.037), 0.12),
                (round(RATE * 0.073), 0.055),
            ]:
                position = first + i + lag
                if position < len(frames):
                    frames[position] += tone * envelope * gain
    scale = 0.23 / max(abs(value) for value in frames)
    pcm = array.array("h", (round(value * scale * 32767) for value in frames))
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm.tobytes()


if __name__ == "__main__":
    for name, parameters in SOUNDS.items():
        path = OUTPUT / f"{name}.wav"
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(RATE)
            output.writeframes(synthesize(*parameters))
        print(path)
