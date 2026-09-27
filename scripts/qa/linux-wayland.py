"""GNOME 46 portal smoke: real app, real permission UI, isolated desktop.

Run through linux-wayland.sh. CI runs this against the same Debian package as
the X11 checks. This virtual desktop tests recording, but not hardware GPUs.
No Shell unsafe mode, portal permission overrides, mocks, or Kiri test switches.

Version-specific primary interfaces:
https://github.com/GNOME/mutter/blob/46.2/data/dbus-interfaces/org.gnome.Mutter.RemoteDesktop.xml
https://github.com/GNOME/mutter/blob/46.2/data/dbus-interfaces/org.gnome.Mutter.ScreenCast.xml
https://github.com/GNOME/gnome-shell/blob/46.0/src/gnome-shell-test-tool.in
"""

import argparse
from collections import deque
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstApp", "1.0")
from gi.repository import Gio, GLib, Gst, GstApp
from PIL import Image, ImageChops, ImageStat


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--executable", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
parser.add_argument("--scenario", choices=("allow", "deny", "record-deny"), required=True)
parser.add_argument("--scale", type=float, choices=(1, 1.25, 1.5, 2), default=1)
args = parser.parse_args()
profile = Path(os.environ.get("KIRI_QA_PROFILE", "/missing")).resolve()
if sys.platform != "linux" or not profile.is_dir() or os.environ.get("XDG_SESSION_TYPE") != "wayland":
    raise SystemExit("Use linux-wayland.sh to create a disposable GNOME session")
for key in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "TMPDIR"):
    if not Path(os.environ[key]).resolve().is_relative_to(profile):
        raise SystemExit(f"Refusing an unisolated {key}")

output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
library = Path(os.environ["XDG_DATA_HOME"]) / "kiri"
report = {"success": False, "environment": "GNOME 46 headless / software rendering",
          "scenario": args.scenario, "requested_scale": args.scale, "checks": [],
          "not_tested": ["hardware GPU", "physical displays", "IME"]}
children = []
logs = []
pipeline = None
remote_path = None
screen_path = None
fixture = None
recording_region = (220, 240, 900, 616)  # Even physical dimensions at every tested scale.
connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
context = GLib.MainContext.default()
REMOTE = "org.gnome.Mutter.RemoteDesktop"
CAST = "org.gnome.Mutter.ScreenCast"


def call(name, path, interface, method, signature=None, values=()):
    parameters = GLib.Variant(signature, values) if signature else None
    result = connection.call_sync(name, path, interface, method, parameters,
                                  None, Gio.DBusCallFlags.NONE, 10000, None)
    return result.unpack()


def launch(name, command):
    log = (output / f"{name}.log").open("wb")
    logs.append(log)
    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    children.append((name, child))
    return child


def pump():
    while context.pending():
        context.iteration(False)


def wait_for(label, predicate, timeout=35):
    report["phase"] = label
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pump()
        for name, child in children:
            if child.poll() is not None:
                raise RuntimeError(f"{name} exited during {label}: {child.returncode}")
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError(f"Timed out: {label}")


def pause(seconds=0.6):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pump()
        time.sleep(0.03)


def owns(name):
    return call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "NameHasOwner", "(s)", (name,))[0]


def overview_is_closed():
    active = call("org.gnome.Shell", "/org/gnome/Shell", "org.freedesktop.DBus.Properties",
                  "Get", "(ss)", ("org.gnome.Shell", "OverviewActive"))[0]
    if isinstance(active, GLib.Variant):
        active = active.unpack()
    return active is False


def send(method, signature=None, values=()):
    return call(REMOTE, remote_path, f"{REMOTE}.Session", method, signature, values)


def key(keysym):
    send("NotifyKeyboardKeysym", "(ub)", (keysym, True))
    send("NotifyKeyboardKeysym", "(ub)", (keysym, False))
    pause(0.2)


def move(x, y):
    send("NotifyPointerMotionAbsolute", "(sdd)", (stream_path, x * args.scale, y * args.scale))


def button(pressed):
    send("NotifyPointerButton", "(ib)", (272, pressed))  # Linux BTN_LEFT


def click(x, y):
    move(x, y)
    button(True)
    button(False)
    pause()


def accessible_nodes():
    queue = deque([pyatspi.Registry.getDesktop(0)])
    visited = 0
    while queue and visited < 3000:
        node = queue.popleft()
        visited += 1
        try:
            yield node
            queue.extend(node.getChildAtIndex(i) for i in range(node.childCount))
        except Exception:
            continue

def controls(name, enabled=False):
    for node in accessible_nodes():
        try:
            state = node.getState()
            if node.name != name or not state.contains(pyatspi.STATE_SHOWING):
                continue
            if enabled and not state.contains(pyatspi.STATE_ENABLED):
                continue
            bounds = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
            if bounds.width > 0 and bounds.height > 0:
                return bounds
        except Exception:
            continue
    return None


def click_control(name):
    bounds = wait_for(f"enabled {name} control", lambda: controls(name, enabled=True))
    click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)


def pixel_box(bounds):
    return tuple(round(value * args.scale) for value in bounds)


def screenshot(name):
    sample = sink.emit("try-pull-sample", 5 * Gst.SECOND)
    if sample is None:
        raise RuntimeError("Mutter/PipeWire did not provide a desktop frame")
    structure = sample.get_caps().get_structure(0)
    width, height = structure.get_value("width"), structure.get_value("height")
    buffer = sample.get_buffer()
    pixels = buffer.extract_dup(0, buffer.get_size())
    picture = Image.frombytes("RGB", (width, height), pixels, "raw", "RGB", len(pixels) // height)
    picture.save(output / name)
    return picture


def fixture_frame(name):
    picture = screenshot(name)
    samples = [picture.getpixel(pixel_box(point)) for point in ((330, 470), (510, 470), (690, 470))]
    if all(max(abs(channel - expected) for channel in pixel) <= 1
           for pixel, expected in zip(samples, (17, 119, 221))):
        return picture
    return None


def overlay_frame(name):
    picture = screenshot(name)
    # Accessibility nodes can appear before WebKit paints. Reject a blank
    # overlay; the saved-image comparison below proves the frozen pixels.
    tones = [sum(picture.getpixel(pixel_box(point))) / 3 for point in ((330, 470), (510, 470), (690, 470))]
    return picture if tones[1] - tones[0] > 20 and tones[2] - tones[1] > 20 else None


def assets():
    index = library / "library.json"
    return json.loads(index.read_text()) if index.is_file() else []


def capture():
    subprocess.run([str(args.executable), "--capture"], check=True, timeout=10)


def drag_region(bounds=recording_region):
    move(*bounds[:2])
    button(True)
    pause(0.2)
    move(*bounds[2:])
    pause(0.2)
    button(False)
    pause()


def asset_path(asset):
    filename = Path(asset["filename"])
    if filename.name != str(filename):
        raise RuntimeError("Capture filename escaped the isolated library")
    return library / "Assets" / filename


def clipboard(kind):
    # A second Wayland client acquires focus before requesting the real data.
    click(1240, 760)
    received = []
    selection = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    if kind == "image":
        selection.request_image(lambda _clipboard, image, _data: received.append(image), None)
    else:
        selection.request_text(lambda _clipboard, text, _data: received.append(text), None)
    wait_for(f"Wayland clipboard {kind} delivered to another client", lambda: len(received))
    if received[0] is None:
        raise RuntimeError(f"Wayland clipboard has no {kind}")
    return received[0]


def recording_files(pattern):
    return set(Path(tempfile.gettempdir()).glob(pattern))


def recording_pattern(stage):
    for child in layout.get_children():
        layout.remove(child)
    shade = {"initial": "#222222", "paused": "#888888", "resumed": "#dddddd"}[stage]
    drawing = Gtk.DrawingArea()
    drawing.set_size_request(1280, 800)

    def draw(_widget, cr):
        cr.set_source_rgb(1, 1, 1)
        cr.rectangle(220, 240, 680, 380)
        cr.fill()
        channel = int(shade[1:3], 16) / 255
        cr.set_source_rgb(channel, channel, channel)
        cr.rectangle(255, 340, 240, 185)
        cr.fill()
        cr.set_source_rgb(0.067, 0.067, 0.067)
        cr.select_font_face("Sans")
        cr.set_font_size(24)
        cr.move_to(245, 285)
        cr.show_text("KIRI WAYLAND RECORDING 123")
        cr.set_font_size(28)
        cr.move_to(545, 410)
        cr.show_text(stage.upper())

    drawing.connect("draw", draw)
    layout.put(drawing, 0, 0)
    counter = Gtk.Label(label="0")
    layout.put(counter, 20, 730)
    fixture.show_all()

    def tick():
        if counter.get_parent() is None:
            return False
        # Damage outside the selected region produces real PipeWire frames
        # on a static desktop without changing the recorded scene pixels.
        counter.set_text(str(time.monotonic_ns() % 100000))
        return True

    GLib.timeout_add(33, tick)
    click(1240, 760)
    pause()
    return screenshot(f"recording-source-{stage}.png").crop(pixel_box(recording_region))


def screen_share(approve, label):
    wait_for(f"{label} real ScreenCast chooser", lambda: controls("Share") and controls("Cancel"), timeout=25)
    screenshot(f"{label}-screencast-consent.png")
    # GNOME selects the sole monitor. Never pre-grant portal permissions.
    bounds = wait_for(f"{label} consent action", lambda: controls("Share" if approve else "Cancel", enabled=True))
    started = time.monotonic()
    click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    move(1200, 760)
    wait_for(f"{label} ScreenCast chooser closes", lambda: controls("Share") is None)
    return started


def begin_recording():
    capture()
    wait_for("recording selection overlay", lambda: controls("Record"))
    click_control("Record")
    drag_region()
    click_control("MP4")
    screenshot("recording-options.png")
    click_control("Start Recording")
    move(1200, 760)


def recording_acceptance():
    from linux_recording_review import discover_video, inspect_recording

    pause(7)  # Let the ordinary completion preview expire before capture.
    references = {"initial": recording_pattern("initial")}
    staged_before = recording_files(".kiri-media-*.mp4")
    segments_before = recording_files("kiri-recording-*.mp4")
    count_before = len(assets())
    begin_recording()
    if args.scenario == "record-deny":
        screen_share(False, "denied-recording")
        wait_for("ScreenCast denial reaches Kiri", lambda: "ScreenCast was cancelled or denied" in
                 (output / "kiri.log").read_text(errors="replace"))
        pause(2)
        if len(assets()) != count_before or controls("Share"):
            raise RuntimeError("Denied recording saved an asset or repeated the chooser")
        report["checks"].append("real ScreenCast denial saves nothing and releases the recorder")
        click(1240, 760)
        begin_recording()
    first_started = screen_share(True, "initial-recording")
    wait_for("authorized encoder writes frames", lambda: any(
        path.stat().st_size > 32 for path in recording_files(".kiri-media-*.mp4") - staged_before))
    pause(3)
    screenshot("recording-running.png")
    pause_requested = time.monotonic()
    subprocess.run([str(args.executable), "--toggle-recording-pause"], check=True, timeout=10)
    first_segment = wait_for("pause publishes a complete segment", lambda: next(iter(
        recording_files("kiri-recording-*.mp4") - segments_before), None), timeout=30)
    first_duration = discover_video(first_segment, references["initial"].size)
    references["paused"] = recording_pattern("paused")
    paused_at = time.monotonic()
    pause(3)
    paused_seconds = time.monotonic() - paused_at
    references["resumed"] = recording_pattern("resumed")
    staged_before = recording_files(".kiri-media-*.mp4")
    subprocess.run([str(args.executable), "--toggle-recording-pause"], check=True, timeout=10)
    second_started = screen_share(True, "resumed-recording")
    wait_for("resumed encoder writes frames", lambda: any(
        path.stat().st_size > 32 for path in recording_files(".kiri-media-*.mp4") - staged_before))
    pause(3)
    screenshot("recording-resumed.png")
    stop_requested = time.monotonic()
    subprocess.run([str(args.executable), "--stop-recording"], check=True, timeout=10)
    videos = wait_for("stop imports the merged recording", lambda: [
        asset for asset in assets() if asset["kind"] == "video"], timeout=45)
    if len(videos) != 1 or len(assets()) != count_before + 1:
        raise RuntimeError("Recording must save exactly one merged video")
    saved = output / "native-recording.mp4"
    shutil.copyfile(asset_path(videos[0]), saved)
    report["recording"] = inspect_recording(
        saved, output, references,
        (pause_requested - first_started) + (stop_requested - second_started),
        stop_requested - first_started, paused_seconds,
    )
    report["recording"]["first_segment_seconds"] = round(first_duration, 3)
    if abs(videos[0].get("duration", 0) - report["recording"]["duration_seconds"]) > 0.2:
        raise RuntimeError("Video duration metadata differs from the decoded MP4")
    report["checks"].append("real ScreenCast consent, pause, second consent, resume and stop save a decodable MP4")
    report["checks"].append("every MP4 frame matches an active desktop scene; paused scene and Kiri controls are absent")


def daemon_path(name):
    for directory in ("/usr/libexec", "/usr/lib/xdg-desktop-portal"):
        path = Path(directory) / name
        if path.is_file():
            return str(path)
    raise RuntimeError(f"Missing installed portal daemon: {name}")


def configure_monitor():
    name = "org.gnome.Mutter.DisplayConfig"
    path = "/org/gnome/Mutter/DisplayConfig"
    serial, monitors, _logical, _props = call(name, path, name, "GetCurrentState")
    if len(monitors) != 1:
        raise RuntimeError(f"Expected exactly one GNOME monitor; got {len(monitors)}")
    connector = monitors[0][0][0]
    mode = next(mode for mode in monitors[0][1] if mode[6].get("is-current"))
    if not any(abs(scale - args.scale) < 1e-6 for scale in mode[5]):
        raise RuntimeError(f"GNOME mode does not support requested scale {args.scale}: {mode[5]}")
    call(name, path, name, "ApplyMonitorsConfig", "(uua(iiduba(ssa{sv}))a{sv})",
         (serial, 1, [(0, 0, args.scale, 0, True, [(connector, mode[0], {})])],
          {"layout-mode": GLib.Variant("u", 1)}))
    _serial, monitors, logical, props = call(name, path, name, "GetCurrentState")
    mode = next(mode for mode in monitors[0][1] if mode[6].get("is-current"))
    if len(logical) != 1 or abs(logical[0][2] - args.scale) > 1e-6 or props.get("layout-mode") != 1:
        raise RuntimeError(f"GNOME did not apply the requested logical layout: {logical}, {props}")
    expected = (round(1280 * args.scale), round(800 * args.scale))
    if tuple(mode[1:3]) != expected:
        raise RuntimeError(f"Unexpected GNOME physical display: {mode[1:3]} != {expected}")
    report["display"] = {"logical_size": [1280, 800], "physical_size": list(expected),
                         "scale": logical[0][2], "connector": connector, "layout_mode": props["layout-mode"]}
    (output / "display-config.json").write_text(json.dumps(
        {"monitors": monitors, "logical_monitors": logical, "properties": props}, indent=2) + "\n")
    return connector


try:
    # These settings are stored only in this disposable profile/session bus.
    for schema, setting, value in (
        ("org.gnome.desktop.interface", "toolkit-accessibility", "true"),
        ("org.gnome.desktop.interface", "enable-animations", "false"),
        ("org.gnome.desktop.session", "idle-delay", "0"),
        ("org.gnome.desktop.screensaver", "lock-enabled", "false"),
        ("org.gnome.mutter", "experimental-features", "['scale-monitor-framebuffer']"),
    ):
        subprocess.run(["gsettings", "set", schema, setting, value], check=True, timeout=10)
    report["gnome_shell"] = subprocess.check_output(["gnome-shell", "--version"], text=True).strip()
    launch("pipewire", ["pipewire"])
    wait_for("PipeWire socket", lambda: (Path(os.environ["XDG_RUNTIME_DIR"]) / "pipewire-0").is_socket())
    launch("wireplumber", ["wireplumber"])
    launch("gnome-shell", ["gnome-shell", "--wayland", "--headless", "--virtual-monitor",
                            f"{round(1280 * args.scale)}x{round(800 * args.scale)}",
                            "--wayland-display", os.environ["WAYLAND_DISPLAY"]])
    wait_for("GNOME RemoteDesktop service", lambda: owns(REMOTE))
    wait_for("GNOME Screenshot service", lambda: owns("org.gnome.Shell.Screenshot"))
    # The bus names appear before layoutManager's startup-complete signal.
    # Its cover pane can still swallow input until this Shell 46 message.
    wait_for("GNOME startup completes", lambda: "GNOME Shell started at" in
             (output / "gnome-shell.log").read_text(errors="replace"))
    subprocess.run(["dbus-update-activation-environment", "WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP",
                    "XDG_SESSION_TYPE", "GDK_BACKEND"], check=True, timeout=10)
    launch("portal-gnome", [daemon_path("xdg-desktop-portal-gnome"), "--verbose"])
    wait_for("GNOME portal backend", lambda: owns("org.freedesktop.impl.portal.desktop.gnome"))
    launch("portal", [daemon_path("xdg-desktop-portal"), "--verbose"])
    wait_for("Desktop portal service", lambda: owns("org.freedesktop.portal.Desktop"))

    connector = configure_monitor()
    remote_path = call(REMOTE, "/org/gnome/Mutter/RemoteDesktop", REMOTE, "CreateSession")[0]
    session_id = call(REMOTE, remote_path, "org.freedesktop.DBus.Properties", "Get", "(ss)",
                      (f"{REMOTE}.Session", "SessionId"))[0]
    if isinstance(session_id, GLib.Variant):
        session_id = session_id.unpack()
    screen_path = call(CAST, "/org/gnome/Mutter/ScreenCast", CAST, "CreateSession", "(a{sv})",
                       ({"remote-desktop-session-id": GLib.Variant("s", session_id)},))[0]
    stream_path = call(CAST, screen_path, f"{CAST}.Session", "RecordMonitor", "(sa{sv})",
                       (connector, {"cursor-mode": GLib.Variant("u", 0)}))[0]
    node_ids = []
    connection.signal_subscribe(CAST, f"{CAST}.Stream", "PipeWireStreamAdded", stream_path,
                                None, Gio.DBusSignalFlags.NONE,
                                lambda *event: node_ids.append(event[5].unpack()[0]))
    send("Start")
    wait_for("real desktop PipeWire stream", lambda: node_ids)
    Gst.init(None)
    pipeline = Gst.parse_launch(f"pipewiresrc path={node_ids[0]} ! videoconvert ! "
                                "video/x-raw,format=RGB ! appsink name=qa_sink max-buffers=1 drop=true sync=false")
    sink = pipeline.get_by_name("qa_sink")
    pipeline.set_state(Gst.State.PLAYING)
    report["checks"].append("single-monitor headless GNOME with real PipeWire desktop stream")

    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk
    import pyatspi
    fixture = Gtk.Window(title="Kiri Wayland public QA")
    fixture.fullscreen()
    layout = Gtk.Fixed()
    fixture.add(layout)
    provider = Gtk.CssProvider()
    provider.load_from_data(b"#qa-background { background: #eeeeee; } #qa-paper { background: white; } "
                            b"#qa-ink { background: #111111; } #qa-grey { background: #777777; } "
                            b"#qa-light { background: #dddddd; } label { color: #111111; font-size: 32px; }")
    Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    layout.set_name("qa-background")
    for name, x, y, width, height in (
        ("qa-paper", 200, 180, 800, 520), ("qa-ink", 270, 400, 120, 140),
        ("qa-grey", 450, 400, 120, 140), ("qa-light", 630, 400, 120, 140),
    ):
        patch = Gtk.EventBox()
        patch.set_name(name)
        patch.set_size_request(width, height)
        layout.put(patch, x, y)
    layout.put(Gtk.Label(label="SCREEN CAPTURE 123"), 270, 265)
    fixture.show_all()
    key(0xff1b)  # Dismiss the initial GNOME overview with a real key event.
    wait_for("GNOME overview closes", overview_is_closed)
    launch("kiri", [str(args.executable.resolve())])
    wait_for("Kiri library rendered", lambda: controls("Settings"))
    # GNOME can place the library at the top-left instead of centering it.
    click(1240, 760)  # Exposed corner of the full-screen public test window.
    source = wait_for("public fixture is visible", lambda: fixture_frame("source-desktop.png"))
    if list(source.size) != report["display"]["physical_size"]:
        raise RuntimeError(f"PipeWire desktop dimensions differ from the configured display: {source.size}")
    expected = source.crop(pixel_box((220, 240, 900, 620)))
    expected.save(output / "expected-region.png")
    capture()
    wait_for("real Screenshot permission dialog", lambda: controls("Allow") and controls("Deny"))
    screenshot("portal-permission.png")
    choice = controls("Deny" if args.scenario == "deny" else "Allow")
    click(choice.x + choice.width / 2, choice.y + choice.height / 2)
    wait_for("permission dialog closes", lambda: controls("Allow") is None)

    if args.scenario == "deny":
        wait_for("denial reaches Kiri", lambda: "cancelled or denied" in (output / "kiri.log").read_text(errors="replace"))
        pause(2)
        if assets() or controls("Screenshot"):
            raise RuntimeError("Denied capture must not save an image or open an overlay")
        if controls("Allow") or controls("Deny"):
            raise RuntimeError("Denied capture opened another permission dialog")
        screenshot("denied-desktop.png")
        report["checks"].append("real portal denial reaches Kiri without saving or retrying a dialog")
    else:
        wait_for("Kiri screenshot overlay", lambda: controls("Screenshot"))
        wait_for("capture desktop content is visible", lambda: overlay_frame("capture-overlay.png"))
        key(0xff1b)
        wait_for("Escape closes capture", lambda: controls("Screenshot") is None)
        if assets():
            raise RuntimeError("Cancelled overlay unexpectedly saved an image")
        click(1240, 760)
        wait_for("public fixture is visible again", lambda: fixture_frame("repeat-source-desktop.png"))
        capture()
        wait_for("second screenshot overlay", lambda: controls("Screenshot"))
        wait_for("second capture desktop content is visible", lambda: overlay_frame("repeat-capture-overlay.png"))
        drag_region((220, 240, 900, 620))
        preview = screenshot("selected-region.png")
        # Exclude handles and the selection border. A correct saved crop is
        # insufficient if the frozen desktop was stretched in the overlay.
        preview_difference = ImageChops.difference(
            preview.crop(pixel_box((228, 248, 892, 612))), expected.crop(pixel_box((8, 8, 672, 372))))
        preview_error = sum(ImageStat.Stat(preview_difference).mean) / 3
        report["preview_mean_pixel_error"] = round(preview_error, 4)
        if preview_error > 1.5:
            preview_difference.save(output / "preview-difference.png")
            raise RuntimeError(f"Wayland preview pixel mismatch: {preview_error:.3f}")
        key(0xff0d)
        saved = wait_for("real capture is persisted", lambda: assets() if len(assets()) == 1 else None)
        captured = Image.open(asset_path(saved[0])).convert("RGB")
        captured.save(output / "saved-capture.png")
        if captured.size != expected.size:
            raise RuntimeError(f"Capture dimensions {captured.size} do not match {expected.size}")
        difference = ImageChops.difference(captured, expected)
        error = sum(ImageStat.Stat(difference).mean) / 3
        report["capture_mean_pixel_error"] = round(error, 4)
        if error > 1.5:
            difference.save(output / "pixel-difference.png")
            raise RuntimeError(f"Wayland capture pixel mismatch: {error:.3f}")
        report["checks"].append("real portal approval, overlay cancellation, repeat capture, and saved pixels")
        clipboard("image").savev(str(output / "clipboard.png"), "png", [], [])
        pasted = Image.open(output / "clipboard.png").convert("RGB")
        if pasted.size != captured.size or ImageChops.difference(pasted, captured).getbbox():
            raise RuntimeError("Another Wayland client did not receive the exact captured PNG")
        report["checks"].append("a separate focused Wayland GTK client receives the exact PNG clipboard")
        capture()
        wait_for("OCR selection overlay", lambda: controls("OCR"))
        click_control("OCR")
        drag_region((220, 240, 900, 350))
        click_control("Copy")
        wait_for("OCR copy closes capture", lambda: controls("OCR") is None)
        recognized = clipboard("text")
        report["ocr_text"] = " ".join(recognized.split())
        if "SCREEN CAPTURE 123" not in report["ocr_text"]:
            raise RuntimeError(f"Unexpected OCR clipboard text: {recognized!r}")
        if len(assets()) != 2 or not any("SCREEN CAPTURE 123" in " ".join(asset.get("ocrText", "").split()) for asset in assets()):
            raise RuntimeError("OCR must save exactly one local history item")
        report["checks"].append("real local OCR recognizes desktop text and copies it to another Wayland client")
        recording_acceptance()
    report["success"] = True
except Exception as error:
    report["error"] = str(error)
    try:
        report["accessibility"] = [{"name": node.name, "role": node.getRoleName()} for node in accessible_nodes()]
    except Exception:
        pass
    if pipeline is not None:
        try:
            screenshot("failure-desktop.png")
        except Exception:
            pass
finally:
    if pipeline is not None:
        pipeline.set_state(Gst.State.NULL)
    if remote_path is not None:
        try:
            send("Stop")
        except Exception:
            pass
    if fixture is not None:
        fixture.destroy()
    for _name, child in reversed(children):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
    for log in logs:
        log.close()
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")

if not report["success"]:
    raise SystemExit(report["error"])
print(json.dumps(report, indent=2))
