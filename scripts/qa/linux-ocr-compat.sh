#!/usr/bin/env bash
# Focused OCR acceptance using an installed app and a disposable X11 profile.
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { echo "Linux is required." >&2; exit 1; }
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
executable="$(realpath "${1:-/usr/bin/kiri}")"
output="${KIRI_LINUX_OCR_QA_DIR:-$repository_root/linux-ocr-review}"
mkdir -p "$output"
output="$(realpath "$output")"
test -x "$executable"
for command in xvfb-run dbus-run-session openbox xdotool xclip xprop; do
  command -v "$command" >/dev/null
done
qa_profile="$(mktemp -d "${TMPDIR:-/tmp}/kiri-ocr-qa.XXXXXXXX")"
trap 'rm -rf "$qa_profile"' EXIT
mkdir -p "$qa_profile"/{home,config,data,cache,state,runtime,tmp}
chmod 700 "$qa_profile/runtime"

# Xvfb needs software painting. The optional sandbox override is inherited only
# from the disposable container; neither setting changes the installed app.
env -u DISPLAY -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u DBUS_SESSION_BUS_ADDRESS -u NO_AT_BRIDGE \
  -u HYPRLAND_INSTANCE_SIGNATURE -u SWAYSOCK -u TESSDATA_PREFIX \
  HOME="$qa_profile/home" XDG_CONFIG_HOME="$qa_profile/config" \
  XDG_DATA_HOME="$qa_profile/data" XDG_CACHE_HOME="$qa_profile/cache" \
  XDG_STATE_HOME="$qa_profile/state" XDG_RUNTIME_DIR="$qa_profile/runtime" \
  TMPDIR="$qa_profile/tmp" KIRI_QA_PROFILE="$qa_profile" \
  XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=Openbox \
  GDK_BACKEND=x11 GDK_SCALE=1 GDK_DPI_SCALE=1 GSETTINGS_BACKEND=memory \
  LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 RUST_LOG=info \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- /usr/bin/python3 "$repository_root/scripts/qa/linux-ocr-compat.py" \
  --executable "$executable" --output "$output"
