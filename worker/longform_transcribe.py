#!/usr/bin/env python3
"""Long-form transcription for TrnStudio / Горизонт.

Chunks audio (~20 s with quiet cuts + overlap stitch), following patterns from
dubr1k/GigaAMGUI. Backends:
  - gigaam: real model when CUDA + gigaam are available
  - mock: CI/dev path without GPU (still exercises chunk planning + stitch)

Acceptance GPU sizing target: RTX 2060 (~6 GB VRAM). LICENSE files untouched.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import wave
from pathlib import Path
from typing import Any, Callable

import numpy as np

# Allow `python worker/longform_transcribe.py` from repo root or /app in Docker.
_WORKER_DIR = Path(__file__).resolve().parent
if str(_WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(_WORKER_DIR))

from asr.chunking import plan_audio_chunks, stitch_overlapping_text  # noqa: E402
from asr.exports import segments_to_srt, segments_to_txt, segments_to_vtt  # noqa: E402

SAMPLE_RATE = 16_000
MAX_CHUNK_SECONDS = 20.0
OVERLAP_SECONDS = 2.0


def _load_wav_mono_f32(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if sample_width != 2:
        raise ValueError("Expected PCM 16-bit WAV")
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        # Lightweight linear resample when ffmpeg already targeted 16 kHz but rate differs.
        duration = len(audio) / float(rate)
        target = max(1, int(round(duration * SAMPLE_RATE)))
        positions = np.linspace(0, len(audio) - 1, target, dtype=np.float32)
        audio = np.interp(positions, np.arange(len(audio)), audio).astype(np.float32)
        rate = SAMPLE_RATE
    return audio, rate


def _resolve_backend(requested: str) -> str:
    requested = (requested or "auto").strip().lower()
    if requested in {"mock", "gigaam"}:
        return requested
    if requested != "auto":
        raise ValueError(f"Unknown backend: {requested}")
    try:
        import torch  # noqa: F401
        import gigaam  # noqa: F401

        if torch.cuda.is_available():
            return "gigaam"
    except Exception:
        pass
    return "mock"


def _mock_transcribe_chunk(start_sec: float, end_sec: float, index: int) -> str:
    # Deterministic placeholder so UI/jobs/export path is testable without GPU.
    return f"[фрагмент {index + 1}] {start_sec:.1f}–{end_sec:.1f} с"


def _gigaam_decode_factory(model_name: str, download_root: str | None) -> Callable[[np.ndarray], str]:
    import torch
    import gigaam

    kwargs: dict[str, Any] = {"fp16_encoder": True, "device": "cuda"}
    if download_root:
        Path(download_root).mkdir(parents=True, exist_ok=True)
        kwargs["download_root"] = download_root
    model = gigaam.load_model(model_name, **kwargs)

    def decode(window: np.ndarray) -> str:
        # Write a temporary wav chunk — official short API expects a path.
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            pcm = np.clip(window * 32768.0, -32768, 32767).astype(np.int16)
            with wave.open(str(tmp_path), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(SAMPLE_RATE)
                wf.writeframes(pcm.tobytes())
            with torch.inference_mode():
                text = model.transcribe(str(tmp_path))
            return (text or "").strip()
        finally:
            tmp_path.unlink(missing_ok=True)

    return decode


def transcribe_longform(
    audio_path: Path,
    *,
    backend: str = "auto",
    model_name: str | None = None,
    download_root: str | None = None,
    progress_path: Path | None = None,
) -> dict[str, Any]:
    audio, rate = _load_wav_mono_f32(audio_path)
    duration = float(len(audio)) / float(rate) if rate else 0.0
    resolved = _resolve_backend(backend)
    model_name = model_name or os.environ.get("GIGAAM_MODEL", "v3_e2e_rnnt")
    download_root = download_root or os.environ.get("GIGAAM_PYTORCH_MODEL_DIR") or None

    chunks = plan_audio_chunks(
        audio,
        [(0.0, duration)],
        sample_rate=rate,
        max_chunk_seconds=MAX_CHUNK_SECONDS,
        overlap_seconds=OVERLAP_SECONDS if duration > MAX_CHUNK_SECONDS else 0.0,
    )

    decode: Callable[[np.ndarray], str] | None = None
    if resolved == "gigaam":
        decode = _gigaam_decode_factory(model_name, download_root)

    segments: list[dict[str, Any]] = []
    previous_index: int | None = None
    previous_group: int | None = None

    def write_progress(ratio: float, chunk_i: int) -> None:
        if not progress_path:
            return
        payload = {
            "status": "running",
            "progress": round(min(1.0, max(0.0, ratio)), 4),
            "chunk": chunk_i + 1,
            "chunks": len(chunks),
            "backend": resolved,
        }
        progress_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    for i, chunk in enumerate(chunks):
        start = chunk.decode_start_sample
        end = chunk.decode_end_sample
        if end - start < int(0.1 * rate):
            continue
        window = audio[start:end]
        if resolved == "mock":
            text = _mock_transcribe_chunk(chunk.start_sec, chunk.end_sec, i)
        else:
            assert decode is not None
            text = decode(window)

        if text:
            if (
                chunk.overlaps_previous
                and previous_index is not None
                and previous_group == chunk.group
                and resolved != "mock"
            ):
                prev = segments[previous_index]["transcription"]
                prev, text, _trim = stitch_overlapping_text(prev, text)
                segments[previous_index]["transcription"] = prev
            if text:
                segments.append(
                    {
                        "transcription": text,
                        "boundaries": (
                            max(0.0, float(chunk.start_sec)),
                            min(duration, float(chunk.end_sec)),
                        ),
                    }
                )
                previous_index = len(segments) - 1
                previous_group = chunk.group
        else:
            previous_index = None
            previous_group = None

        write_progress(float(chunk.end_sec) / duration if duration else 1.0, i)

    report = {
        "status": "done",
        "backend": resolved,
        "model": model_name if resolved == "gigaam" else None,
        "audio_path": str(audio_path),
        "duration_seconds": round(duration, 3),
        "chunk_count": len(chunks),
        "max_chunk_seconds": MAX_CHUNK_SECONDS,
        "target_gpu": "RTX 2060 (~6 GB)",
        "segments": segments,
        "text": segments_to_txt(segments).rstrip("\n"),
        "srt": segments_to_srt(segments),
        "vtt": segments_to_vtt(segments),
    }
    if progress_path:
        progress_path.write_text(
            json.dumps({"status": "done", "progress": 1.0, "backend": resolved}, ensure_ascii=False),
            encoding="utf-8",
        )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Long-form Gorizont transcription")
    parser.add_argument("--audio", required=True, help="PCM 16 kHz mono WAV")
    parser.add_argument(
        "--backend",
        default=os.environ.get("TRANSCRIBE_BACKEND", "auto"),
        help="auto | gigaam | mock",
    )
    parser.add_argument("--model", default=os.environ.get("GIGAAM_MODEL", "v3_e2e_rnnt"))
    parser.add_argument("--download-root", default=os.environ.get("GIGAAM_PYTORCH_MODEL_DIR"))
    parser.add_argument("--json-out", required=True, help="Write full result JSON")
    parser.add_argument("--progress-out", default=None, help="Optional progress JSON path")
    args = parser.parse_args(argv)

    audio = Path(args.audio)
    if not audio.is_file():
        print(json.dumps({"error": f"audio not found: {audio}"}), file=sys.stderr)
        return 2

    try:
        report = transcribe_longform(
            audio,
            backend=args.backend,
            model_name=args.model,
            download_root=args.download_root,
            progress_path=Path(args.progress_out) if args.progress_out else None,
        )
    except Exception as exc:  # pragma: no cover - surfaced to job runner
        err = {"status": "failed", "error": str(exc)}
        Path(args.json_out).write_text(json.dumps(err, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(err, ensure_ascii=False), file=sys.stderr)
        return 1

    out = Path(args.json_out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "event": "longform_done",
                "backend": report["backend"],
                "duration_seconds": report["duration_seconds"],
                "chunk_count": report["chunk_count"],
                "segments": len(report["segments"]),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
