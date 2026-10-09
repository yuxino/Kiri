"""Check the private FIFO's generated 440Hz PCM without hiding missing audio."""

from functools import lru_cache
import math


RATE = 48_000
WINDOW = 4_800
QUARTER = 1_200
EDGE = 9_600
MINIMUM_AMPLITUDE = 0.08


@lru_cache(maxsize=2)
def _basis(length):
    phases = [2 * math.pi * 440 * index / RATE for index in range(length)]
    return tuple(map(math.cos, phases)), tuple(map(math.sin, phases))


def _amplitude(window):
    cosine, sine = _basis(len(window))
    real = sum(value * basis for value, basis in zip(window, cosine))
    imaginary = sum(value * basis for value, basis in zip(window, sine))
    return 2 * math.hypot(real, imaginary) / len(window)


def inspect_tone(samples, join_range):
    """Preserve coherent 100ms checks except at the measured pause join.

    The first segment's discovered duration and the first resumed video PTS
    bound that join. Only intersecting windows can contain an arbitrary source
    phase discontinuity. The shorter projections have less frequency
    selectivity; elsewhere, the original coherent checks must stay in place.
    """
    lower, upper = sorted(join_range)
    if (not all(math.isfinite(value) for value in (lower, upper))
            or not EDGE / RATE < lower <= upper < (len(samples) - EDGE) / RATE
            or upper - lower > WINDOW / RATE):
        raise RuntimeError("The measured audio pause join is not a bounded interior interval")
    lower *= RATE
    upper *= RATE
    quarters = {}

    def crosses_join(offset):
        return offset < upper and offset + WINDOW > lower

    def local_amplitude(offset):
        for start in range(offset, offset + WINDOW, QUARTER):
            if start not in quarters:
                quarters[start] = _amplitude(samples[start:start + QUARTER])
        # Arithmetic amplitude, not RMS power: 50ms missing from a 0.15 tone
        # must still fall below 0.08. Each quarter has 11 full 440Hz cycles.
        return sum(quarters[start] for start in range(offset, offset + WINDOW, QUARTER)) / 4

    windows = {}
    local_offsets = set()
    for offset in range(EDGE, len(samples) - EDGE, WINDOW):
        if crosses_join(offset):
            windows[offset] = local_amplitude(offset)
            local_offsets.add(offset)
        else:
            windows[offset] = _amplitude(samples[offset:offset + WINDOW])
    # Near the join, also catch silence straddling the original 100ms grid.
    # These additional assertions never replace a non-join coherent check.
    for offset in range(EDGE, len(samples) - EDGE, QUARTER):
        if crosses_join(offset):
            windows[offset] = local_amplitude(offset)
            local_offsets.add(offset)
    if not windows or min(windows.values()) < MINIMUM_AMPLITUDE:
        failed = {offset / RATE: amplitude for offset, amplitude in windows.items()
                  if amplitude < MINIMUM_AMPLITUDE}
        raise RuntimeError(f"The FIFO AAC lost its 440Hz tone: {failed}")
    return {"minimum_100ms_amplitude": min(windows.values()),
            "pause_join_range_seconds": [lower / RATE, upper / RATE],
            "phase_insensitive_windows": len(local_offsets),
            "coherent_windows": len(windows) - len(local_offsets)}
