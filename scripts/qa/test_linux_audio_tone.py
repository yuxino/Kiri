#!/usr/bin/env python3
"""Regression signals for the installed Linux FIFO audio acceptance check."""

import math
import unittest

from linux_audio_tone import RATE, inspect_tone


def tone(frequency=440, seconds=3, phase_join=None):
    return [0.15 * math.sin(2 * math.pi * frequency * index / RATE
                           + (math.pi if phase_join is not None and index >= phase_join * RATE else 0))
            for index in range(seconds * RATE)]


class PausedRecordingTone(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.join = 1.4586666666666667
        cls.join_range = (cls.join, cls.join)
        cls.steady = tone()
        cls.phase_changed = tone(phase_join=cls.join)

    def test_steady_tone_retains_coherent_checks_and_the_original_threshold(self):
        report = inspect_tone(self.steady, self.join_range)
        self.assertAlmostEqual(report["minimum_100ms_amplitude"], 0.15)
        self.assertGreater(report["coherent_windows"], 20)
        self.assertLessEqual(report["phase_insensitive_windows"], 4)

    def test_phase_discontinuity_only_passes_at_the_measured_pause_join(self):
        report = inspect_tone(self.phase_changed, self.join_range)
        self.assertGreater(report["minimum_100ms_amplitude"], 0.08)
        with self.assertRaisesRegex(RuntimeError, "lost its 440Hz tone"):
            inspect_tone(self.phase_changed, (2.15, 2.15))

    def test_nine_ms_aac_join_gap_and_phase_jump_do_not_imply_a_missing_100ms_tone(self):
        samples = self.phase_changed.copy()
        start = round(self.join * RATE)
        samples[start:start + 449] = [0.0] * 449
        self.assertGreater(inspect_tone(samples, self.join_range)["minimum_100ms_amplitude"], 0.08)

    def test_short_and_long_silence_are_rejected_at_multiple_join_alignments(self):
        for milliseconds in (50, 60, 75, 100):
            for shift in (-0.049, -0.037, -0.025, -0.013, 0, 0.013, 0.025, 0.037, 0.049):
                with self.subTest(milliseconds=milliseconds, shift=shift):
                    samples = self.phase_changed.copy()
                    start = round((self.join + shift) * RATE)
                    length = milliseconds * 48
                    samples[start:start + length] = [0.0] * length
                    with self.assertRaisesRegex(RuntimeError, "lost its 440Hz tone"):
                        inspect_tone(samples, self.join_range)

    def test_nearby_wrong_frequencies_still_fail_the_non_join_coherent_windows(self):
        # 25ms alone would pass 420/430/450/460Hz at 0.08. Keeping the original
        # 100ms windows outside the measured join preserves their rejection.
        for frequency in (420, 430, 450, 460, 880):
            with self.subTest(frequency=frequency):
                with self.assertRaisesRegex(RuntimeError, "lost its 440Hz tone"):
                    inspect_tone(tone(frequency), self.join_range)

    def test_a_single_non_join_100ms_wrong_tone_is_not_hidden_by_the_rest(self):
        for frequency in (420, 430, 450, 460, 880):
            for start in (0.7, 2.1):
                with self.subTest(frequency=frequency, start=start):
                    samples = self.steady.copy()
                    offset = round(start * RATE)
                    samples[offset:offset + 4800] = tone(frequency, seconds=1)[:4800]
                    with self.assertRaisesRegex(RuntimeError, "lost its 440Hz tone"):
                        inspect_tone(samples, self.join_range)

    def test_total_silence_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "lost its 440Hz tone"):
            inspect_tone([0.0] * len(self.steady), self.join_range)

    def test_unbounded_or_invalid_join_cannot_expand_the_local_exception(self):
        for join_range in ((1.0, 1.101), (0.1, 0.1), (2.9, 2.9),
                           (math.nan, 1.0), (1.0, math.inf)):
            with self.subTest(join_range=join_range):
                with self.assertRaisesRegex(RuntimeError, "not a bounded interior interval"):
                    inspect_tone(self.steady, join_range)


if __name__ == "__main__":
    unittest.main()
