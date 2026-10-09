#!/usr/bin/env bash
# Issue #101: private s16le FIFO output monitor, no microphone or desktop audio.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ $# -eq 0 ]]; then
  cargo test --locked --manifest-path src-tauri/Cargo.toml --no-run
fi
root=$(mktemp -d "${TMPDIR:-/tmp}/kiri-fifo-qa.XXXXXX")
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -rf -- "$root"
}
trap cleanup EXIT
mkdir -p "$root/home" "$root/config" "$root/runtime" "$root/pulse"
chmod 700 "$root/runtime" "$root/pulse"
head -c 256 /dev/urandom > "$root/cookie"
chmod 600 "$root/cookie"
cat > "$root/server.pa" <<CONFIG
load-module module-native-protocol-unix socket=$root/pulse/native auth-cookie=$root/cookie
load-module module-pipe-sink sink_name=fifo_output file=$root/output.fifo format=s16le rate=48000 channels=2
set-default-sink fifo_output
CONFIG
HOME="$root/home" XDG_CONFIG_HOME="$root/config" XDG_RUNTIME_DIR="$root/runtime" \
  pulseaudio --daemonize=no --use-pid-file=no --exit-idle-time=-1 --disallow-exit \
  --log-target="file:$root/pulse.log" -nF "$root/server.pa" &
pids+=("$!")
export PULSE_SERVER="unix:$root/pulse/native" PULSE_COOKIE="$root/cookie"
for _ in $(seq 1 100); do
  test -S "$root/pulse/native" && break
  kill -0 "${pids[0]}" 2>/dev/null || { cat "$root/pulse.log"; exit 1; }
  sleep 0.05
done
test -S "$root/pulse/native"
# Pulse's pipe sink estimates latency from unread FIFO bytes, without a
# hardware clock. Drain at 1ms granularity: 10ms reads quantize that estimate
# beyond the native trace's unchanged 5ms continuity limit.
# Keep the sink's native 48kHz stereo s16 rate and high-latency FIFO route.
python3 - "$root/output.fifo" <<'PY' &
import array, sys, time
from pathlib import Path
with open(sys.argv[1], "rb", buffering=0) as stream:
    start = time.monotonic()
    count = 0
    while data := stream.read(192):
        if any(abs(sample) > 1_000 for sample in array.array("h", data)):
            Path(sys.argv[1] + ".audible").touch()
        count += len(data)
        time.sleep(max(0, start + count / 192000 - time.monotonic()))
PY
pids+=("$!")
# Feed native Pulse playback directly and verify actual FIFO output below.
# Fixture startup is independent of a GStreamer playback clock.
python3 - <<'TONE' | pacat --playback --raw --device=fifo_output --format=s16le --rate=48000 --channels=2 --latency-msec=200 &
import array, math, sys
block = array.array("h", (int(32767 * 0.15 * math.sin(2 * math.pi * 440 * frame / 48000))
                         for frame in range(48000) for _ in range(2))).tobytes()
try:
    while True:
        sys.stdout.buffer.write(block)
        sys.stdout.buffer.flush()
except BrokenPipeError:
    pass
TONE
pids+=("$!")
for _ in $(seq 1 100); do
  test -f "$root/output.fifo.audible" && break
  for pid in "${pids[@]}"; do
    kill -0 "$pid" 2>/dev/null || { echo "A FIFO audio fixture process stopped" >&2; exit 1; }
  done
  sleep 0.05
done
test -f "$root/output.fifo.audible" || { echo "FIFO output never delivered the generated tone" >&2; exit 1; }
export KIRI_LINUX_PULSE_QA=1 KIRI_LINUX_PULSE_FIFO_QA=1
if [[ -n "${KIRI_LINUX_MEDIA_QA_DIR:-}" ]]; then
  export KIRI_LINUX_MEDIA_QA_DIR="$KIRI_LINUX_MEDIA_QA_DIR/fifo"
fi
if [[ $# -eq 0 ]]; then
  timeout 45s cargo test --locked --manifest-path src-tauri/Cargo.toml \
    native_pulse_fifo_system_audio_and_pause_merge -- --ignored --nocapture --test-threads=1
else
  KIRI_LINUX_QA_SYSTEM_AUDIO=1 bash scripts/qa/linux-native.sh "$1"
fi
