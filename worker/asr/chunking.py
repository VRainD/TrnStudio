"""Fixed-length chunk planning aligned with VRainD/gigaamui.

Source: https://github.com/VRainD/gigaamui `app.py` (`CHUNK_SECONDS`, long-audio loop).
Official short `transcribe` is used for audio ≤25 s; longer files are split into
non-overlapping windows of `chunk_seconds` (default 20).

LICENSE files in TrnStudio are not modified.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class AudioChunk:
    index: int
    start_sample: int
    end_sample: int
    start_sec: float
    end_sec: float


def plan_fixed_chunks(
    total_samples: int,
    *,
    sample_rate: int,
    chunk_seconds: float = 20.0,
) -> list[AudioChunk]:
    """Plan non-overlapping decode windows like VRainD/gigaamui."""
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    if chunk_seconds <= 0:
        raise ValueError("chunk_seconds must be positive")
    if total_samples <= 0:
        return []

    chunk_size = max(1, int(chunk_seconds * sample_rate))
    total_chunks = max(1, math.ceil(total_samples / chunk_size))
    chunks: list[AudioChunk] = []
    for idx in range(total_chunks):
        start = idx * chunk_size
        end = min((idx + 1) * chunk_size, total_samples)
        if end <= start:
            continue
        chunks.append(
            AudioChunk(
                index=idx,
                start_sample=start,
                end_sample=end,
                start_sec=float(start) / sample_rate,
                end_sec=float(end) / sample_rate,
            )
        )
    return chunks
