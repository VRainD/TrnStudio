#!/usr/bin/env python3
"""Smoke test for longform chunking + mock backend (no GPU)."""

from __future__ import annotations

import json
import struct
import tempfile
import wave
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

from longform_transcribe import transcribe_longform  # noqa: E402


def write_wav(path: Path, seconds: float = 45.0, rate: int = 16000) -> None:
    frames = int(seconds * rate)
    # Quiet mid-points help energy-cut planner.
    pcm = bytearray()
    for i in range(frames):
        # Soft tone with quieter valleys every ~10 s
        t = i / rate
        amp = 2000 if int(t) % 10 != 0 else 200
        sample = int(amp * __import__("math").sin(2 * 3.14159 * 440 * t))
        pcm.extend(struct.pack("<h", max(-32767, min(32767, sample))))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(bytes(pcm))


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "long.wav"
        write_wav(wav, seconds=45.0)
        report = transcribe_longform(wav, backend="mock")
        assert report["status"] == "done"
        assert report["backend"] == "mock"
        assert report["chunk_count"] >= 2, report
        assert len(report["segments"]) >= 2, report
        assert "фрагмент" in report["text"]
        assert "WEBVTT" in report["vtt"]
        assert "-->" in report["srt"]
        out = Path(tmp) / "out.json"
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("PASS longform mock chunks:", report["chunk_count"], "segments:", len(report["segments"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
