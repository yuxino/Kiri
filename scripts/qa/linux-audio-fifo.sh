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
# The FIFO reader paces consumption at the sink's native 48kHz stereo s16 rate.
python3 - "$root/output.fifo" <<'PY' &
import sys, time
with open(sys.argv[1], "rb", buffering=0) as stream:
    start = time.monotonic()
    count = 0
    while data := stream.read(1920):
        count += len(data)
        time.sleep(max(0, start + count / 192000 - time.monotonic()))
PY
pids+=("$!")
gst-launch-1.0 -q audiotestsrc is-live=true freq=440 volume=0.15 ! audioconvert ! pulsesink device=fifo_output &
pids+=("$!")
sleep 0.3
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
