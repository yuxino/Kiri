"""Ordinary X11 source window with its own, continuously running Tk loop.

The accessibility/xdotool driver must not own this loop: xdotool's click delay
would stop Expose processing precisely while Kiri unmaps the capture overlay.
This fixture supplies public desktop content only, never pixels to Kiri.
"""

import json
from pathlib import Path
import queue
import select
import subprocess
import sys
import threading
import time


RECORDING_REGION = (300, 10, 980, 390)


class DesktopFixture:
    def __init__(self, output):
        self.log = (output / "desktop-fixture.log").open("wb")
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), str(output / "desktop-fixture-events.jsonl")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True,
        )
        self.sequence = 0
        try:
            self.request("ready")
        except Exception:
            self.shutdown()
            raise

    def request(self, action, **values):
        self.sequence += 1
        if self.process.poll() is not None:
            raise RuntimeError("The public desktop source exited unexpectedly")
        message = {"id": self.sequence, "action": action, **values}
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        if not select.select([self.process.stdout], [], [], 5)[0]:
            raise RuntimeError(f"Public desktop source did not acknowledge {action}")
        response = json.loads(self.process.stdout.readline())
        if response.get("id") != self.sequence or not response.get("ok"):
            raise RuntimeError(f"Public desktop source rejected {action}: {response}")

    def close(self):
        try:
            if self.process.poll() is None:
                self.request("quit")
                self.process.wait(timeout=5)
        finally:
            self.shutdown()

    def shutdown(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()
        self.log.close()


def serve(events_path):
    # Import Tk only in the Linux source process. The controller never owns a
    # Tk object and can wait for accessibility, CLI commands or decoding safely.
    import tkinter as tk

    requests = queue.Queue()
    events = events_path.open("w", encoding="utf-8")
    root = tk.Tk()
    root.withdraw()
    root.title("Kiri Linux QA public pattern")
    root.geometry("1280x800+0+0")
    root.attributes("-fullscreen", True)
    canvas = tk.Canvas(root, width=1280, height=800, highlightthickness=0, background="#eeeeee")
    canvas.pack(fill="both", expand=True)

    def log(event, **values):
        events.write(json.dumps({"monotonic_ns": time.monotonic_ns(), "event": event, **values}) + "\n")
        events.flush()

    def exposure(event):
        log("expose", x=event.x, y=event.y, width=event.width, height=event.height)
        root.after_idle(lambda: log("expose_idle"))

    canvas.bind("<Expose>", exposure)
    canvas.create_text(80, 80, text="KIRI LINUX DESKTOP QA", anchor="w", fill="#222222", font=("Sans", 30))
    canvas.create_rectangle(200, 180, 1000, 700, fill="#ffffff", outline="")
    canvas.create_text(270, 290, text="SCREEN CAPTURE 123", anchor="w", fill="#111111", font=("Sans", 32))
    for x, shade in ((270, "#111111"), (450, "#777777"), (630, "#dddddd")):
        canvas.create_rectangle(x, 400, x + 120, 540, fill=shade, outline="")

    def draw(stage):
        shade = {"initial": "#222222", "paused": "#888888", "resumed": "#dddddd"}[stage]
        left, top, right, bottom = RECORDING_REGION
        canvas.delete("all")
        canvas.create_rectangle(left, top, right, bottom, fill="#ffffff", outline="")
        canvas.create_text(left + 25, top + 40, text="KIRI NATIVE RECORDING 123",
                           anchor="w", fill="#111111", font=("Sans", 24))
        canvas.create_rectangle(left + 35, top + 100, left + 275, top + 285, fill=shade, outline="")
        canvas.create_text(left + 325, top + 150, text=stage.upper(), anchor="w",
                           fill="#111111", font=("Sans", 28))
        canvas.create_text(left + 325, top + 225, text="PUBLIC TEST PATTERN", anchor="w",
                           fill="#555555", font=("Sans", 15))

    def read_requests():
        for line in sys.stdin:
            requests.put(json.loads(line))
        requests.put({"action": "quit", "id": None})

    threading.Thread(target=read_requests, daemon=True).start()

    def dispatch():
        try:
            message = requests.get_nowait()
        except queue.Empty:
            root.after(5, dispatch)
            return
        action = message["action"]
        try:
            if action == "show":
                root.deiconify()
                root.lift()
                root.focus_force()
            elif action == "hide":
                root.withdraw()
            elif action == "windowed":
                root.attributes("-fullscreen", False)
                root.geometry("1000x650+100+80")
            elif action == "draw":
                draw(message["stage"])
            elif action == "probe_expose":
                # A source-only integration probe: unmapping this cover must
                # repaint the real X11 source even when its driver is blocked.
                cover = tk.Toplevel(root)
                cover.overrideredirect(True)
                cover.geometry("680x380+300+10")
                cover.configure(background="#eeeeee")
                cover.lift()
                root.after(100, cover.destroy)
            elif action not in {"ready", "quit"}:
                raise ValueError("Unknown fixture action")
            root.update_idletasks()
            log("command", action=action, id=message["id"], stage=message.get("stage"))
            print(json.dumps({"id": message["id"], "ok": True}), flush=True)
        except Exception as error:
            print(json.dumps({"id": message["id"], "ok": False, "error": str(error)}), flush=True)
        if action == "quit":
            root.destroy()
        else:
            root.after(5, dispatch)

    root.after(0, dispatch)
    try:
        root.mainloop()
    finally:
        events.close()


if __name__ == "__main__":
    serve(Path(sys.argv[1]))
