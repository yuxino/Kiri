"""Exercise an installed Kiri's actual OCR UI on an isolated X11 desktop.

Invoke through linux-ocr-compat.sh. This focused package check does not claim
GNOME/Wayland, physical hardware, recording, or full distribution acceptance.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback

from PIL import ImageGrab, ImageStat
from linux_desktop_fixture import DesktopFixture


def command(*arguments, check=True):
    return subprocess.run(arguments, check=check, capture_output=True, text=True, timeout=12)


def stop(child):
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


def enable_accessibility(connection, variant, flags, report):
    properties = connection.call_sync(
        "org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "GetAll",
        variant("(s)", ("org.a11y.Status",)), None, flags, 5000, None,
    ).unpack()[0]
    report["accessibility_properties"] = sorted(properties)
    if "IsEnabled" not in properties:
        raise RuntimeError("The accessibility bus does not expose required IsEnabled")
    for property_name in ("IsEnabled", "ScreenReaderEnabled"):
        if property_name in properties:
            connection.call_sync(
                "org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
                variant("(ssv)", ("org.a11y.Status", property_name, variant("b", True))),
                None, flags, 5000, None,
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    profile = Path(os.environ.get("KIRI_QA_PROFILE", "/missing")).resolve()
    if sys.platform != "linux" or not profile.is_dir() or os.environ.get("XDG_SESSION_TYPE") != "x11":
        raise SystemExit("Use linux-ocr-compat.sh to create an isolated desktop")
    for variable in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"):
        if not Path(os.environ[variable]).resolve().is_relative_to(profile):
            raise SystemExit(f"{variable} must be inside the disposable QA profile")

    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, Gio, GLib

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    index = Path(os.environ["XDG_DATA_HOME"]) / "kiri/library.json"
    report = {"success": False, "session": "X11 / Xvfb / Openbox / 1280x800 / scale 1",
              "checks": [], "rendering": "software GL; WebKit compositing disabled for Xvfb",
              "container_sandbox_override": os.environ.get("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS") == "1",
              "not_tested": ["physical Kali installation", "GNOME Wayland/portal consent",
                             "recording and audio", "multiple displays and fractional scaling"]}
    process = manager = fixture = None
    logs = []

    def pump():
        context = GLib.MainContext.default()
        for _ in range(50):
            if not context.pending():
                break
            context.iteration(False)

    def wait_for(description, predicate, timeout=35):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            if process is not None and process.poll() is not None:
                raise RuntimeError(f"Kiri exited during {description}: {process.returncode}")
            result = predicate()
            if result:
                return result
            time.sleep(0.1)
        raise RuntimeError(f"Timed out: {description}")

    def windows():
        result = command("xdotool", "search", "--onlyvisible", "--pid", str(process.pid), check=False)
        return result.stdout.split() if result.returncode == 0 else []

    def control(label):
        desktop = Atspi.get_desktop(0)
        stack = []
        for offset in range(desktop.get_child_count()):
            try:
                application = desktop.get_child_at_index(offset)
                if application is not None and application.get_process_id() == process.pid:
                    stack.append(application)
            except GLib.Error:
                continue
        visited = 0
        while stack and visited < 2000:
            node = stack.pop()
            visited += 1
            try:
                stack.extend(child for offset in range(node.get_child_count())
                             if (child := node.get_child_at_index(offset)) is not None)
                states = node.get_state_set()
                if (node.get_name() != label or "button" not in node.get_role_name()
                        or not states.contains(Atspi.StateType.SHOWING)
                        or not states.contains(Atspi.StateType.ENABLED)):
                    continue
                bounds = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
                if bounds.width <= 0 or bounds.height <= 0 or bounds.x < 0 or bounds.y < 0:
                    continue
                pixels = ImageGrab.grab().convert("L").crop((bounds.x, bounds.y,
                                                             bounds.x + bounds.width, bounds.y + bounds.height))
                low, high = pixels.getextrema()
                if high - low >= 48 and ImageStat.Stat(pixels).stddev[0] >= 8:
                    return bounds
            except (GLib.Error, AttributeError):
                continue
        return None

    def assets():
        return json.loads(index.read_text(encoding="utf-8")) if index.is_file() else []

    try:
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        enable_accessibility(connection, GLib.Variant, Gio.DBusCallFlags.NONE, report)
        Atspi.init()
        manager_log = (output / "openbox.log").open("wb")
        logs.append(manager_log)
        manager = subprocess.Popen(["openbox"], stdout=manager_log, stderr=subprocess.STDOUT)
        wait_for("window manager", lambda: "window id" in command("xprop", "-root", "_NET_SUPPORTING_WM_CHECK", check=False).stdout)
        fixture = DesktopFixture(output)
        app_log = (output / "app.log").open("wb")
        logs.append(app_log)
        process = subprocess.Popen([str(args.executable.resolve())], stdout=app_log, stderr=subprocess.STDOUT)
        wait_for("painted library Settings button", lambda: control("Settings"))
        if assets():
            raise RuntimeError("QA requires an empty isolated library")
        ImageGrab.grab().save(output / "library-launch.png")
        report["checks"].append("installed package starts and paints its actual library")

        for window in windows():
            command("xdotool", "windowminimize", window)
        fixture.request("show")
        wait_for("public desktop fixture", lambda: ImageGrab.grab().convert("RGB").getpixel((300, 450))[0] < 40)
        command("xdotool", "key", "--clearmodifiers", "ctrl+alt+shift+o")
        wait_for("painted OCR overlay", lambda: control("Screenshot"))
        command("xdotool", "mousemove", "220", "240", "mousedown", "1")
        time.sleep(0.15)
        command("xdotool", "mousemove", "--sync", "900", "350")
        time.sleep(0.15)
        command("xdotool", "mouseup", "1")
        bounds = wait_for("recognized text Copy button", lambda: control("Copy"), timeout=65)
        ImageGrab.grab().save(output / "ocr-recognized-text.png")
        command("xdotool", "mousemove", str(bounds.x + bounds.width // 2), str(bounds.y + bounds.height // 2), "click", "1")
        recognized = wait_for("recognized text in clipboard", lambda: (
            result.stdout if (result := command("xclip", "-selection", "clipboard", "-t", "UTF8_STRING", "-o", check=False)).returncode == 0
            and "SCREEN CAPTURE 123" in " ".join(result.stdout.split()) else None))
        history = wait_for("one persisted OCR history asset", lambda: [
            item for item in assets() if "SCREEN CAPTURE 123" in " ".join((item.get("ocrText") or "").split())])
        if len(history) != 1 or len(assets()) != 1:
            raise RuntimeError("Recognition must save exactly one source in Text History")
        (output / "ocr-clipboard.txt").write_text(recognized, encoding="utf-8")
        report["recognized_text"] = " ".join(recognized.split())
        report["checks"].append("actual Kiri OCR shortcut, region selection, local recognition, Copy and Text History succeed")
        report["success"] = True
    except Exception as error:
        report["error"] = str(error)
        report["traceback"] = traceback.format_exc()
        try:
            ImageGrab.grab().save(output / "failure.png")
        except Exception:
            pass
    finally:
        stop(process)
        if fixture is not None:
            try:
                fixture.close()
            except Exception as error:
                report["success"] = False
                report.setdefault("error", f"Fixture cleanup failed: {error}")
        stop(manager)
        for log in logs:
            log.close()
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
