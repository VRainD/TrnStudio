#!/usr/bin/env python3
"""Long-form transcription for TrnStudio / Горизонт.

Engine behavior aligned with **VRainD/gigaamui** (`app.py`):
  - duration ≤ 25 s → single official `model.transcribe`
  - longer → fixed non-overlapping chunks (`CHUNK_SECONDS`, default 20)
  - exports TXT / SRT (+ VTT for Горизонт)

Backends:
  - gigaam: when CUDA + gigaam are available
  - mock: CI/dev without GPU

Acceptance GPU: RTX 2060 (~6 GB). LICENSE files untouched. UI stays Горизонт.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import wave
from pathlib import Path
from typing import Any, Callable

import numpy as np

_WORKER_DIR = Path(__file__).resolve().parent
if str(_WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(_WORKER_DIR))

from asr.chunking import plan_fixed_chunks  # noqa: E402
from asr.exports import segments_to_srt, segments_to_txt, segments_to_vtt  # noqa: E402

SAMPLE_RATE = 16_000
SHORT_LIMIT_SECONDS = 25.0
DEFAULT_CHUNK_SECONDS = float(os.environ.get("CHUNK_SECONDS", "20"))


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


def _mock_text(start_sec: float, end_sec: float, index: int) -> str:
    return f"[фрагмент {index + 1}] {start_sec:.1f}–{end_sec:.1f} с"


def _result_to_text(result: Any) -> str:
    text = getattr(result, "text", None)
    if text is not None:
        return str(text).strip()
    return str(result).strip()


def _gigaam_model(model_name: str, download_root: str | None):
    import torch
    import gigaam

    kwargs: dict[str, Any] = {}
    if download_root:
        Path(download_root).mkdir(parents=True, exist_ok=True)
        kwargs["download_root"] = download_root
    model = gigaam.load_model(model_name, **kwargs)
    if torch.cuda.is_available():
        try:
            model = model.cuda()
        except Exception:
            pass
    return model


def _write_chunk_wav(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    pcm = np.clip(audio * 32768.0, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())


def _segments_for_report(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map gigaamui-style {start,end,text} to Горизонт export shape."""
    out = []
    for seg in segments:
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        start = float(seg["start"])
        end = float(seg["end"])
        out.append({"transcription": text, "boundaries": (start, end)})
    return out


def transcribe_longform(
    audio_path: Path,
    *,
    backend: str = "auto",
    model_name: str | None = None,
    download_root: str | None = None,
    chunk_seconds: float | None = None,
    progress_path: Path | None = None,
) -> dict[str, Any]:
    audio, rate = _load_wav_mono_f32(audio_path)
    duration = float(len(audio)) / float(rate) if rate else 0.0
    resolved = _resolve_backend(backend)
    model_name = model_name or os.environ.get("GIGAAM_MODEL", "v3_e2e_rnnt")
    download_root = download_root or os.environ.get("GIGAAM_PYTORCH_MODEL_DIR") or None
    chunk_seconds = float(chunk_seconds if chunk_seconds is not None else DEFAULT_CHUNK_SECONDS)

    def write_progress(payload: dict[str, Any]) -> None:
        if not progress_path:
            return
        progress_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    write_progress(
        {"status": "running", "progress": 0.05, "stage": "preparing", "backend": resolved}
    )

    model = None
    decode_path: Callable[[str], str] | None = None
    if resolved == "gigaam":
        model = _gigaam_model(model_name, download_root)

        def decode_path(path: str) -> str:  # noqa: F811
            return _result_to_text(model.transcribe(path))

    segments: list[dict[str, Any]] = []
    mode: str

    # Match VRainD/gigaamui: short official path vs fixed chunk loop.
    if duration <= SHORT_LIMIT_SECONDS:
        mode = "short"
        write_progress(
            {
                "status": "running",
                "progress": 0.4,
                "stage": "transcribing",
                "backend": resolved,
                "mode": mode,
            }
        )
        if resolved == "mock":
            text = _mock_text(0.0, duration, 0)
        else:
            assert decode_path is not None
            text = decode_path(str(audio_path))
        segments = [{"start": 0.0, "end": round(duration, 3), "text": text}]
        chunk_count = 1
    else:
        mode = "fixed_chunks"
        chunks = plan_fixed_chunks(len(audio), sample_rate=rate, chunk_seconds=chunk_seconds)
        chunk_count = len(chunks)
        write_progress(
            {
                "status": "running",
                "progress": 0.2,
                "stage": "chunking",
                "backend": resolved,
                "chunks": chunk_count,
                "mode": mode,
            }
        )
        for chunk in chunks:
            window = audio[chunk.start_sample : chunk.end_sample]
            if resolved == "mock":
                text = _mock_text(chunk.start_sec, chunk.end_sec, chunk.index)
            else:
                assert decode_path is not None
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp_path = Path(tmp.name)
                try:
                    _write_chunk_wav(tmp_path, window, rate)
                    text = decode_path(str(tmp_path))
                finally:
                    tmp_path.unlink(missing_ok=True)
            if text:
                segments.append(
                    {
                        "start": round(chunk.start_sec, 3),
                        "end": round(chunk.end_sec, 3),
                        "text": text,
                    }
                )
            ratio = 0.2 + 0.7 * ((chunk.index + 1) / max(1, chunk_count))
            write_progress(
                {
                    "status": "running",
                    "progress": round(min(0.95, ratio), 4),
                    "stage": "transcribing",
                    "chunk": chunk.index + 1,
                    "chunks": chunk_count,
                    "backend": resolved,
                    "mode": mode,
                }
            )

    export_segments = _segments_for_report(segments)
    report = {
        "status": "done",
        "backend": resolved,
        "engine_source": "https://github.com/VRainD/gigaamui",
        "mode": mode,
        "model": model_name if resolved == "gigaam" else None,
        "audio_path": str(audio_path),
        "duration_seconds": round(duration, 3),
        "chunk_count": chunk_count,
        "chunk_seconds": chunk_seconds,
        "max_chunk_seconds": chunk_seconds,
        "target_gpu": "RTX 2060 (~6 GB)",
        "segments": export_segments,
        "text": segments_to_txt(export_segments).rstrip("\n"),
        "srt": segments_to_srt(export_segments),
        "vtt": segments_to_vtt(export_segments),
    }
    write_progress(
        {"status": "done", "progress": 1.0, "backend": resolved, "mode": mode}
    )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Long-form Gorizont transcription (gigaamui engine)")
    parser.add_argument("--audio", required=True, help="PCM 16 kHz mono WAV")
    parser.add_argument(
        "--backend",
        default=os.environ.get("TRANSCRIBE_BACKEND", "auto"),
        help="auto | gigaam | mock",
    )
    parser.add_argument("--model", default=os.environ.get("GIGAAM_MODEL", "v3_e2e_rnnt"))
    parser.add_argument("--download-root", default=os.environ.get("GIGAAM_PYTORCH_MODEL_DIR"))
    parser.add_argument(
        "--chunk-seconds",
        type=float,
        default=DEFAULT_CHUNK_SECONDS,
        help="Long-audio chunk size (VRainD/gigaamui CHUNK_SECONDS)",
    )
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
            chunk_seconds=args.chunk_seconds,
            progress_path=Path(args.progress_out) if args.progress_out else None,
        )
    except Exception as exc:  # pragma: no cover
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
                "mode": report["mode"],
                "engine_source": report["engine_source"],
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
