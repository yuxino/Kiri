#!/usr/bin/env bash
# GNOME 46 capture and recording checks on an isolated virtual desktop.
# Ubuntu 24.04 packages in addition to the installed Kiri package:
# sudo apt install --no-install-recommends gnome-shell gnome-settings-daemon \
#   xdg-desktop-portal xdg-desktop-portal-gnome pipewire wireplumber \
#   libgl1-mesa-dri libegl-mesa0 dbus-x11 at-spi2-core python3-pyatspi \
#   python3-gi python3-gi-cairo python3-pil gir1.2-gtk-3.0 gir1.2-gstreamer-1.0 \
#   gir1.2-gst-plugins-base-1.0 gstreamer1.0-pipewire
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo 'Run this check on an isolated Ubuntu 24.04 runner.' >&2
  exit 1
fi
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
executable="$(realpath "${1:-/usr/bin/kiri}")"
display_scale="${KIRI_QA_DISPLAY_SCALE:-1}"
if [[ -n "${KIRI_LINUX_WAYLAND_QA_DIR:-}" ]]; then
  output="$KIRI_LINUX_WAYLAND_QA_DIR"
else
  output="$(mktemp -d "${TMPDIR:-/tmp}/kiri-linux-wayland-review.XXXXXXXX")"
fi
mkdir -p "$output"
output="$(realpath "$output")"
printf 'Wayland QA evidence: %s (display scale %s)\n' "$output" "$display_scale"
test -x "$executable"
for command in gnome-shell pipewire wireplumber dbus-run-session gsettings; do
  command -v "$command" >/dev/null
done

qa_profile=''

cleanup_profile() {
  # This variable is assigned only by this script's mktemp call below.
  local created_profile="$qa_profile"
  qa_profile=''
  [[ -n "$created_profile" ]] || return 0

  local document_mount="$created_profile/runtime/doc"
  local mount_type unmount_command
  if ! command -v findmnt >/dev/null; then
    printf 'QA profile retained (findmnt unavailable): %s\n' "$created_profile" >&2
    return 0
  fi
  if mount_type="$(findmnt --noheadings --raw --output FSTYPE --mountpoint "$document_mount" 2>/dev/null)"; then
    case "$mount_type" in
      fuse|fuse.*)
        if command -v fusermount3 >/dev/null; then
          unmount_command=fusermount3
        elif command -v fusermount >/dev/null; then
          unmount_command=fusermount
        else
          printf 'QA profile retained (FUSE unmount tool unavailable): %s\n' "$created_profile" >&2
          return 0
        fi
        if ! "$unmount_command" -u -- "$document_mount"; then
          printf 'QA profile retained (document portal unmount failed): %s\n' "$created_profile" >&2
          return 0
        fi
        if findmnt --mountpoint "$document_mount" >/dev/null 2>&1; then
          printf 'QA profile retained (document portal is still mounted): %s\n' "$created_profile" >&2
          return 0
        fi
        ;;
      *)
        printf 'QA profile retained (unexpected mount type %s): %s\n' "$mount_type" "$created_profile" >&2
        return 0
        ;;
    esac
  fi
  if ! rm -rf --one-file-system -- "$created_profile"; then
    printf 'QA profile cleanup incomplete; retained at: %s\n' "$created_profile" >&2
  fi
  return 0
}

cleanup_on_exit() {
  local qa_exit_status=$?
  trap - EXIT
  cleanup_profile
  exit "$qa_exit_status"
}
trap cleanup_on_exit EXIT

# Permission choices are stored by the real desktop services. Separate profiles
# isolate all scenarios without deleting or pre-granting any permissions.
for scenario in deny allow record-deny; do
  qa_profile="$(mktemp -d "${TMPDIR:-/tmp}/kiri-wayland-qa.XXXXXXXX")"
  mkdir -p "$qa_profile"/{home,config,data,cache,state,runtime,tmp}
  chmod 700 "$qa_profile/runtime"
  mkdir -p "$qa_profile/config/xdg-desktop-portal" "$output/$scenario"
  cat > "$qa_profile/config/xdg-desktop-portal/portals.conf" <<'EOF'
[preferred]
default=gnome
EOF
  env -u DISPLAY -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u DBUS_SESSION_BUS_ADDRESS \
    -u HYPRLAND_INSTANCE_SIGNATURE -u SWAYSOCK -u NO_AT_BRIDGE -u GSETTINGS_BACKEND \
    -u GDK_SCALE -u GDK_DPI_SCALE \
    HOME="$qa_profile/home" XDG_CONFIG_HOME="$qa_profile/config" \
    XDG_DATA_HOME="$qa_profile/data" XDG_CACHE_HOME="$qa_profile/cache" \
    XDG_STATE_HOME="$qa_profile/state" XDG_RUNTIME_DIR="$qa_profile/runtime" \
    TMPDIR="$qa_profile/tmp" \
    XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_DESKTOP=gnome XDG_SESSION_TYPE=wayland \
    GDK_BACKEND=wayland WAYLAND_DISPLAY=kiri-wayland-qa \
    LIBGL_ALWAYS_SOFTWARE=1 \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 RUST_LOG=info \
    KIRI_QA_PROFILE="$qa_profile" \
    dbus-run-session -- /usr/bin/python3 "$repository_root/scripts/qa/linux-wayland.py" \
    --executable "$executable" --output "$output/$scenario" --scenario "$scenario" \
    --scale "$display_scale"
  cleanup_profile
done
