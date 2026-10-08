# Linux FIFO system-audio recording (#101)

Issue [#101](https://github.com/yuxino/Kiri/issues/101) reports immediate
`AudioRecordingStopped` with system audio on, microphone off and countdown off
on Ubuntu 24.04 / GNOME 46 X11, using `fifo_output.monitor` (s16le, stereo,
48 kHz). Silent recording succeeded. The original cloud desktop was deleted;
its exact environment cannot be rerun. No replacement cloud resources are used.

## Controlled reproduction

The private PulseAudio FIFO harness uses the same sink format, a reader paced
at 192,000 bytes/second, authenticated local Unix sockets and generated 440 Hz
PCM. It never accesses desktop sound devices or a user's library.

The [baseline run](https://github.com/yuxino/Kiri/actions/runs/37738661360)
passed ordinary native media tests and private null-sink audio checks, then
failed the FIFO recording after about 715 ms with a native timestamp
discontinuity. The sink reported about 330 ms of playback latency. The old
native receive queue held only 250 ms of F32 stereo PCM.

Future monitor samples deliberately remain unread until their presentation
time, to avoid including future sound after Stop. In the baseline trace, the
read index had already advanced by 40,920 bytes before any PCM was submitted.
At failure it was 188,256 bytes, while only 90,048 bytes had been submitted.
The next presentation timestamp was 832.385 ms versus the previous submitted
end of 685.221 ms: a 147.163 ms gap, exceeding the unchanged 100 ms continuity
limit. This identifies dropped unread PCM before the encoder. It supports a
mechanism matching #101, rather than proving the cause on the deleted desktop.

## Repair and acceptance

The native libpulse receive queue has a separate, finite one-second budget
(384,000 bytes per source). GStreamer appsrc/mixer queues retain their 250 ms
limits. Native overflow, holes, device moves and timestamp discontinuities
still stop recording; the repair does not accept arbitrary timing gaps.
Each segment primes native inputs for at most two seconds before establishing
its shared video/audio origin. Preparation PCM is discarded; queued future
PCM is retained and re-anchored. The encoder drains its bounded video backlog
and prefers a fresh frame. This avoids writing a high-latency source's initial
lead as silence, including after Resume. Cancellation remains checked during
preparation. Preparation and paused time are excluded from the output clock.

Static error reason suffixes distinguish timing, overflow/move and service
disconnection without logging private audio or device information.

The FIFO fixture must prove nonzero generated playback before recording; a
silent fixture is a failed precondition. The same audible source must fail
with the old 250 ms receive budget before testing the repaired budget.
Native acceptance decodes the AAC
from both segments and the merged MP4, checks 440 Hz in 100 ms windows, checks
48 kHz stereo audio metadata and excludes paused time. A separate no-audio
recording must still have no audio track. The installed-app harness checks
the real X11 GUI and CLI controls, decoded desktop frames, control exclusion,
AAC, native playback and isolated-profile restart. A 60-second generated
GStreamer A/V test separately checks shared-clock duration and decoded tones.

These are controlled software and virtual-desktop checks. They do not
establish physical microphone/speaker behavior, PipeWire-Pulse hardware
latency, GNOME Wayland consent, multiple monitors or fractional scaling.

## Recorded comparison

The same audible FIFO route in [run 37742138470](https://github.com/yuxino/Kiri/actions/runs/37742138470)
reported roughly 295–322 ms of sink latency. The legacy 250 ms queue failed
after about 361 ms with a native timestamp discontinuity. A one-second queue
prevented the abort, but the strict decoded-tone test exposed initial silence.

With bounded preparation, the native FIFO check and 60-second A/V test passed
in [run 37742990654](https://github.com/yuxino/Kiri/actions/runs/37742990654).
Both segment starts contained 440 Hz PCM at amplitude 0.14998 in their first
two 100 ms windows, before AAC encoding. The audiorate counters were
`add=0 drop=0` in both segments. These are generated-signal measurements, not
physical-device or speech-quality claims.

The unchanged Debian candidate is replayed through both silent and system-only
installed X11 runs in [run 37745355744](https://github.com/yuxino/Kiri/actions/runs/37745355744).
Package provenance checks the original build attempt, source files and SHA-256
before installation; the microphone remains off.
