"""Export transcript segments to TXT / SRT / VTT for Горизонт."""

from __future__ import annotations

from typing import Any


def _ts_srt(seconds: float) -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{milli:03d}"


def _ts_vtt(seconds: float) -> str:
    return _ts_srt(seconds).replace(",", ".")


def segments_to_txt(segments: list[dict[str, Any]]) -> str:
    parts = [str(seg.get("transcription", "")).strip() for seg in segments]
    return "\n\n".join(p for p in parts if p).strip() + ("\n" if parts else "")


def segments_to_srt(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    index = 1
    for seg in segments:
        text = str(seg.get("transcription", "")).strip()
        if not text:
            continue
        start, end = seg.get("boundaries", (0.0, 0.0))
        lines.append(str(index))
        lines.append(f"{_ts_srt(float(start))} --> {_ts_srt(float(end))}")
        lines.append(text)
        lines.append("")
        index += 1
    return "\n".join(lines)


def segments_to_vtt(segments: list[dict[str, Any]]) -> str:
    lines = ["WEBVTT", ""]
    for seg in segments:
        text = str(seg.get("transcription", "")).strip()
        if not text:
            continue
        start, end = seg.get("boundaries", (0.0, 0.0))
        lines.append(f"{_ts_vtt(float(start))} --> {_ts_vtt(float(end))}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)
