#!/usr/bin/env python3
"""Smoke test for gigaamui-aligned longform + mock backend (no GPU)."""

from __future__ import annotations

import json
import math
import struct
import sys
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

from longform_transcribe import transcribe_longform  # noqa: E402


def write_wav(path: Path, seconds: float = 45.0, rate: int = 16000) -> None:
    frames = int(seconds * rate)
    pcm = bytearray()
    for i in range(frames):
        t = i / rate
        amp = 2000
        sample = int(amp * math.sin(2 * math.pi * 440 * t))
        pcm.extend(struct.pack("<h", max(-32767, min(32767, sample))))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(bytes(pcm))


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        long_wav = Path(tmp) / "long.wav"
        write_wav(long_wav, seconds=45.0)
        long_report = transcribe_longform(long_wav, backend="mock", chunk_seconds=20)
        assert long_report["status"] == "done"
        assert long_report["backend"] == "mock"
        assert long_report["mode"] == "fixed_chunks"
        assert long_report["engine_source"].endswith("VRainD/gigaamui")
        assert long_report["chunk_count"] >= 2, long_report
        assert len(long_report["segments"]) >= 2, long_report
        assert "фрагмент" in long_report["text"]
        assert "WEBVTT" in long_report["vtt"]
        assert "-->" in long_report["srt"]

        short_wav = Path(tmp) / "short.wav"
        write_wav(short_wav, seconds=10.0)
        short_report = transcribe_longform(short_wav, backend="mock")
        assert short_report["mode"] == "short"
        assert short_report["chunk_count"] == 1

        print(
            "PASS gigaamui-aligned longform mock:",
            "long chunks=",
            long_report["chunk_count"],
            "short mode=",
            short_report["mode"],
        )
        Path(tmp, "out.json").write_text(
            json.dumps(long_report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
