"""Installed native scrolling-capture acceptance; invoke linux-scroll-native.sh."""

import argparse
import io
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time
import traceback

from PIL import Image, ImageChops, ImageGrab, ImageStat
import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, Gio, GLib


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--executable", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
profile = Path(os.environ.get("KIRI_QA_PROFILE", "/missing")).resolve()
if not profile.is_dir() or os.environ.get("XDG_SESSION_TYPE") != "x11":
    raise SystemExit("Use linux-scroll-native.sh for an isolated X11 desktop")
for name in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"):
    if not Path(os.environ[name]).resolve().is_relative_to(profile):
        raise SystemExit(f"{name} must be inside the disposable QA profile")

output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
library = Path(os.environ["XDG_DATA_HOME"]) / "kiri"
report = {"success": False, "checks": [], "session": "Ubuntu X11 / Xvfb / Openbox / 1280x800 / scale 1",
          "rendering": "software GL; WebKit compositing disabled only in this QA process tree",
          "not_tested": ["GNOME Wayland portals", "macOS", "Windows", "mixed scale and multiple monitors"]}
process = fixture = manager = None
sequence = 0
logs = []
BOUNDS = (80, 120, 840, 600)
STEP = 96


def command(*arguments, binary=False, check=True):
    return subprocess.run(arguments, capture_output=True, text=not binary, check=check, timeout=12)


def pause(seconds=0.4):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        context = GLib.MainContext.default()
        for _ in range(40):
            if not context.pending():
                break
            context.iteration(False)
        time.sleep(0.04)


def wait_for(description, predicate, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process and process.poll() is not None:
            raise RuntimeError(f"Kiri exited during {description}: {process.returncode}")
        result = predicate()
        if result:
            return result
        pause(0.1)
    raise RuntimeError(f"Timed out: {description}")


def fixture_request(action, **values):
    global sequence
    sequence += 1
    fixture.stdin.write(json.dumps({"id": sequence, "action": action, **values}) + "\n")
    fixture.stdin.flush()
    if not select.select([fixture.stdout], [], [], 8)[0]:
        raise RuntimeError(f"Fixture did not acknowledge {action}")
    response = json.loads(fixture.stdout.readline())
    if response.get("id") != sequence or not response.get("ok"):
        raise RuntimeError(f"Fixture rejected {action}: {response}")
    return response


def nodes():
    desktop = Atspi.get_desktop(0)
    stack = []
    for index in range(desktop.get_child_count()):
        try:
            application = desktop.get_child_at_index(index)
            if application and application.get_process_id() == process.pid:
                stack.append(application)
        except GLib.Error:
            continue
    for _ in range(2500):
        if not stack:
            break
        node = stack.pop()
        try:
            stack.extend(child for index in range(node.get_child_count())
                         if (child := node.get_child_at_index(index)) is not None)
            yield node
        except GLib.Error:
            continue


def control(label):
    for node in nodes():
        try:
            states = node.get_state_set()
            if node.get_name() != label or "button" not in node.get_role_name():
                continue
            if not states.contains(Atspi.StateType.SHOWING) or not states.contains(Atspi.StateType.ENABLED):
                continue
            bounds = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            if bounds.width > 0 and bounds.height > 0:
                return bounds
        except GLib.Error:
            continue
    return None


def visible_text(label):
    for node in nodes():
        try:
            if node.get_name() == label and node.get_state_set().contains(Atspi.StateType.SHOWING):
                return True
        except GLib.Error:
            continue
    return False


def click(label):
    bounds = wait_for(f"accessible {label} button", lambda: control(label))
    command("xdotool", "mousemove", str(bounds.x + bounds.width // 2), str(bounds.y + bounds.height // 2), "click", "1")
    pause()


def assets():
    index = library / "library.json"
    return json.loads(index.read_text()) if index.is_file() else []


def capture(name):
    image = ImageGrab.grab().convert("RGB")
    image.save(output / name)
    return image


def start_scroll(fixed_header=False):
    fixture_request("reset", fixed=fixed_header)
    fixture_request("show")
    pause(0.5)
    command("xdotool", "key", "--clearmodifiers", "ctrl+shift+a")
    wait_for("Screenshot overlay", lambda: control("Screenshot"))
    command("xdotool", "mousemove", str(BOUNDS[0]), str(BOUNDS[1]), "mousedown", "1")
    pause(0.1)
    command("xdotool", "mousemove", str(BOUNDS[2]), str(BOUNDS[3]))
    pause(0.1)
    command("xdotool", "mouseup", "1")
    click("Scrolling Screenshot")
    wait_for("native scrolling controls", lambda: control("Done"))
    # Remove pointer from the image and wait for the initial native sample.
    command("xdotool", "mousemove", "900", "700")
    pause(1.0)


def stop(child):
    if child and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=6)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)


def compare(actual, expected, description):
    if actual.size != expected.size:
        raise RuntimeError(f"{description}: {actual.size}, expected {expected.size}")
    difference = ImageChops.difference(actual.convert("RGB"), expected.convert("RGB"))
    error = sum(ImageStat.Stat(difference).mean) / 3
    if error > 1.5:
        difference.save(output / "pixel-difference.png")
        raise RuntimeError(f"{description}: mean pixel error {error:.4f}")
    return round(error, 4)


try:
    log = (output / "openbox.log").open("wb")
    logs.append(log)
    manager = subprocess.Popen(["openbox"], stdout=log, stderr=subprocess.STDOUT)
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    for name in ("IsEnabled", "ScreenReaderEnabled"):
        connection.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
                             GLib.Variant("(ssv)", ("org.a11y.Status", name, GLib.Variant("b", True))),
                             None, Gio.DBusCallFlags.NONE, 5000, None)
    Atspi.init()
    log = (output / "fixture.log").open("wb")
    logs.append(log)
    fixture = subprocess.Popen([sys.executable, str(Path(__file__).with_name("linux_scroll_fixture.py")), str(output)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
    fixture_request("ready")
    fixture_request("hide")
    log = (output / "app.log").open("wb")
    logs.append(log)
    process = subprocess.Popen([str(args.executable.resolve())], stdout=log, stderr=subprocess.STDOUT)
    wait_for("installed app library", lambda: control("Settings"))

    start_scroll()
    capture("scroll-initial.png")
    # The source has focus. A native global Escape must cancel without saving.
    command("xdotool", "mousemove", "400", "350", "click", "1", "key", "Escape")
    wait_for("global Escape removes scrolling controls", lambda: control("Done") is None)
    if assets():
        raise RuntimeError("Cancelled scrolling screenshot saved an asset")
    report["checks"].append("global Escape cancels from the external source without saving")

    start_scroll()
    for step in range(5):
        command("xdotool", "mousemove", "400", "350", "click", "5")
        wait_for(f"source wheel step {step + 1}", lambda: fixture_request("status")["offset"] == (step + 1) * STEP)
        pause(0.85)
    command("xdotool", "click", "4")
    wait_for("source scrolls back into captured content", lambda: fixture_request("status")["offset"] == 4 * STEP)
    pause(0.85)
    command("xdotool", "click", "5")
    wait_for("source reconnects at the captured end", lambda: fixture_request("status")["offset"] == 5 * STEP)
    pause(0.85)
    capture("scroll-extended.png")
    click("Done")
    if control("Save captured portion"):
        raise RuntimeError("Ordinary overlapping scrolling unexpectedly needed partial-save confirmation")
    created = wait_for("one saved long image", lambda: assets() if len(assets()) == 1 else None)
    asset = created[0]
    filename = Path(asset["filename"])
    if filename.name != str(filename):
        raise RuntimeError("Saved filename escaped the isolated library")
    saved = Image.open(library / "Assets" / filename).convert("RGB")
    saved.save(output / "saved-scroll.png")
    source = Image.open(output / "public-scroll-source.png").convert("RGB")
    expected = source.crop((0, 0, BOUNDS[2] - BOUNDS[0], BOUNDS[3] - BOUNDS[1] + 5 * STEP))
    expected.save(output / "expected-scroll.png")
    report["saved_dimensions"] = list(saved.size)
    report["native_pixel_error"] = compare(saved, expected, "native stitched image")
    report["checks"].append("five real wheel scrolls append exactly 480 rows; reverse and reconnect introduce no duplicated or missing source pixels")
    clipboard = command("xclip", "-selection", "clipboard", "-t", "image/png", "-o", binary=True)
    copied = Image.open(io.BytesIO(clipboard.stdout)).convert("RGB")
    report["clipboard_pixel_error"] = compare(copied, saved, "native clipboard roundtrip")
    report["checks"].append("native clipboard PNG matches the saved long screenshot")

    start_scroll(fixed_header=True)
    command("xdotool", "mousemove", "400", "350", "click", "5")
    wait_for("fixed header blocks uncertain joining", lambda: visible_text(
        "Scroll back slightly to reconnect the screenshot."))
    capture("fixed-header-rejected.png")
    click("Done")
    wait_for("partial-save confirmation", lambda: control("Save captured portion"))
    if len(assets()) != 1:
        raise RuntimeError("Uncertain fixed-header frame saved without explicit partial confirmation")
    click("Continue adjusting")
    click("Cancel")
    wait_for("cancel closes uncertain scrolling capture", lambda: control("Done") is None)
    if len(assets()) != 1:
        raise RuntimeError("Cancelling uncertain scrolling capture changed the library")
    report["checks"].append("fixed header prevents uncertain joining; Done requires partial confirmation; Continue adjusting and Cancel preserve the library")

    start_scroll(fixed_header=True)
    partial_expected = capture("partial-baseline.png").crop(BOUNDS)
    command("xdotool", "mousemove", "400", "350", "click", "5")
    wait_for("second fixed header blocks uncertain joining", lambda: visible_text(
        "Scroll back slightly to reconnect the screenshot."))
    click("Done")
    click("Save captured portion")
    partial_assets = wait_for("explicitly saved partial image", lambda: assets() if len(assets()) == 2 else None)
    partial_asset = next(item for item in partial_assets if item["filename"] != filename.name)
    partial = Image.open(library / "Assets" / partial_asset["filename"]).convert("RGB")
    partial.save(output / "saved-partial.png")
    report["partial_pixel_error"] = compare(partial, partial_expected, "explicit partial screenshot")
    report["checks"].append("explicit Save captured portion exports exactly the last verified pixels without appending the uncertain frame")
    report["success"] = True
except Exception as error:
    report["error"] = str(error)
    report["traceback"] = traceback.format_exc()
    try:
        capture("failure-desktop.png")
        (output / "failure-accessibility.txt").write_text("\n".join(
            f"{node.get_role_name()}: {node.get_name()}" for node in nodes()), encoding="utf-8")
    except Exception:
        pass
finally:
    stop(process)
    stop(fixture)
    stop(manager)
    for log in logs:
        log.close()
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))

raise SystemExit(0 if report["success"] else 1)
