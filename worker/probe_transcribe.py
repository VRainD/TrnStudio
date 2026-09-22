#!/usr/bin/env python3
"""Minimal GigaAM GPU probe for TrnStudio / Горизонт.

Target acceptance GPU: NVIDIA RTX 2060 (typically 6 GB VRAM; Super often 8 GB).
Measures device info, model-load VRAM, optional short-audio RTF.
Does not change the Gorizont UI. Long-form chunking/jobs land in later PRs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import wave
from pathlib import Path


def _bytes_to_mib(n: int | float) -> float:
    return float(n) / (1024.0 * 1024.0)


def _cuda_snapshot() -> dict:
    import torch

    if not torch.cuda.is_available():
        return {
            "cuda_available": False,
            "device_count": 0,
        }

    index = torch.cuda.current_device()
    props = torch.cuda.get_device_properties(index)
    free_b, total_b = torch.cuda.mem_get_info(index)
    return {
        "cuda_available": True,
        "device_index": index,
        "device_name": props.name,
        "total_vram_mib": round(_bytes_to_mib(total_b), 1),
        "free_vram_mib": round(_bytes_to_mib(free_b), 1),
        "allocated_mib": round(_bytes_to_mib(torch.cuda.memory_allocated(index)), 1),
        "reserved_mib": round(_bytes_to_mib(torch.cuda.memory_reserved(index)), 1),
        "max_allocated_mib": round(_bytes_to_mib(torch.cuda.max_memory_allocated(index)), 1),
        "driver_cuda_capability": f"{props.major}.{props.minor}",
    }


def _write_silence_wav(path: Path, seconds: float = 3.0, sample_rate: int = 16000) -> float:
    """PCM 16-bit mono silence — validates load+decode path without sample assets."""
    frames = int(seconds * sample_rate)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * frames)
    return float(frames) / float(sample_rate)


def _wav_duration_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return float(wf.getnframes()) / float(wf.getframerate())


def _print_help_run() -> int:
    text = """
GigaAM GPU probe (TrnStudio)

Build:
  docker compose --profile gpu-probe build gpu-probe

Smoke (needs NVIDIA Container Toolkit + GPU):
  docker compose --profile gpu-probe run --rm gpu-probe
  docker compose --profile gpu-probe run --rm -v "$PWD/samples:/app/samples:ro" gpu-probe --audio /app/samples/clip.wav

Target GPU for acceptance notes: RTX 2060 (~6 GB VRAM).
UI of Горизонт is unchanged by this profile.
""".strip()
    print(text)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe GigaAM on CUDA for TrnStudio")
    parser.add_argument(
        "--model",
        default=os.environ.get("GIGAAM_MODEL", "v3_e2e_rnnt"),
        help="GigaAM model id (default: v3_e2e_rnnt)",
    )
    parser.add_argument(
        "--audio",
        default=None,
        help="Optional 16 kHz mono WAV path (<= ~25 s for short transcribe)",
    )
    parser.add_argument(
        "--seconds",
        type=float,
        default=3.0,
        help="Synthetic silence length when --audio is omitted (default: 3)",
    )
    parser.add_argument(
        "--download-root",
        default=os.environ.get("GIGAAM_PYTORCH_MODEL_DIR") or None,
        help="Optional GigaAM download/cache root",
    )
    parser.add_argument(
        "--json-out",
        default=None,
        help="Write machine-readable metrics JSON to this path",
    )
    parser.add_argument(
        "--load-only",
        action="store_true",
        help="Load model and report VRAM; skip transcription",
    )
    parser.add_argument(
        "--help-run",
        action="store_true",
        help="Print compose usage and exit",
    )
    args = parser.parse_args(argv)

    if args.help_run:
        return _print_help_run()

    report: dict = {
        "product": "TrnStudio / Горизонт",
        "target_gpu": "RTX 2060 (~6 GB VRAM)",
        "model": args.model,
        "notes": [
            "Short .transcribe is for audio up to ~25 s; long-form/chunking is a later phase-1 step.",
            "Do not treat RTX 3060 Ti / 4090 Laptop numbers as acceptance for this product.",
            "Fill measured_* fields on a real RTX 2060 host after first successful run.",
            "6 GB is tight for GigaAM RNNT vs prior 16 GB budget — watch peak VRAM / chunk size.",
        ],
        "acceptance_hints_rtx2060": {
            "total_vram_mib_expected": 6144,
            "total_vram_mib_super_expected": 8192,
            "peak_vram_budget_mib": "measure on device; headroom is tight on 6 GB — reduce chunk/batch on OOM",
            "rtf_goal": "RTF < 1.0 preferred for interactive local use; record actual RTF here",
            "measured_peak_vram_mib": None,
            "measured_rtf": None,
            "measured_device_name": None,
        },
    }

    try:
        import torch
    except Exception as exc:  # pragma: no cover - environment misconfig
        print(f"ERROR: torch import failed: {exc}", file=sys.stderr)
        return 2

    before = _cuda_snapshot()
    report["cuda_before_load"] = before
    print(json.dumps({"event": "cuda_before_load", **before}, ensure_ascii=False, indent=2))

    if not before.get("cuda_available"):
        print(
            "ERROR: CUDA is not available inside the container. "
            "Install NVIDIA drivers + Container Toolkit, then re-run "
            "`docker compose --profile gpu-probe run --rm gpu-probe`.",
            file=sys.stderr,
        )
        return 3

    import gigaam

    download_root = args.download_root
    if download_root:
        Path(download_root).mkdir(parents=True, exist_ok=True)

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()

    t0 = time.perf_counter()
    model = gigaam.load_model(
        args.model,
        fp16_encoder=True,
        device="cuda",
        download_root=download_root,
    )
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    load_s = time.perf_counter() - t0

    after_load = _cuda_snapshot()
    report["model_load_seconds"] = round(load_s, 3)
    report["cuda_after_load"] = after_load
    print(
        json.dumps(
            {"event": "model_loaded", "seconds": report["model_load_seconds"], **after_load},
            ensure_ascii=False,
            indent=2,
        )
    )

    transcription = None
    rtf = None
    audio_path: Path | None = None
    audio_duration_s = None

    if not args.load_only:
        if args.audio:
            audio_path = Path(args.audio)
            if not audio_path.is_file():
                print(f"ERROR: audio not found: {audio_path}", file=sys.stderr)
                return 4
            audio_duration_s = _wav_duration_seconds(audio_path)
        else:
            audio_path = Path("/tmp/gorizont-probe-silence.wav")
            audio_duration_s = _write_silence_wav(audio_path, seconds=args.seconds)

        if audio_duration_s > 25.0:
            print(
                "WARNING: duration > 25 s; official short transcribe may fail. "
                "Use chunking/longform in a later PR.",
                file=sys.stderr,
            )

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()

        t1 = time.perf_counter()
        transcription = model.transcribe(str(audio_path))
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        infer_s = time.perf_counter() - t1
        rtf = infer_s / audio_duration_s if audio_duration_s > 0 else None

        after_infer = _cuda_snapshot()
        report["audio_path"] = str(audio_path)
        report["audio_duration_seconds"] = round(float(audio_duration_s), 3)
        report["inference_seconds"] = round(infer_s, 3)
        report["rtf"] = round(rtf, 4) if rtf is not None else None
        report["transcription_preview"] = (transcription or "")[:500]
        report["cuda_after_infer"] = after_infer
        print(
            json.dumps(
                {
                    "event": "transcribe_done",
                    "audio_duration_seconds": report["audio_duration_seconds"],
                    "inference_seconds": report["inference_seconds"],
                    "rtf": report["rtf"],
                    "transcription_preview": report["transcription_preview"],
                    **after_infer,
                },
                ensure_ascii=False,
                indent=2,
            )
        )

    hints = report["acceptance_hints_rtx2060"]
    peak = after_load.get("max_allocated_mib")
    if report.get("cuda_after_infer"):
        peak = report["cuda_after_infer"].get("max_allocated_mib", peak)
    hints["measured_peak_vram_mib"] = peak
    hints["measured_rtf"] = report.get("rtf")
    hints["measured_device_name"] = after_load.get("device_name")

    print(json.dumps({"event": "summary", **report}, ensure_ascii=False, indent=2))

    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {out}")

    name = (after_load.get("device_name") or "").lower()
    if "2060" not in name:
        print(
            "NOTE: running device is not reported as 2060. "
            "Record metrics on the acceptance GPU (RTX 2060).",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
