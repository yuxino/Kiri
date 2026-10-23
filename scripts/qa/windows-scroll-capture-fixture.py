"""A separate, ordinary desktop window for native scrolling screenshot QA."""
import ctypes
import json
import os
from pathlib import Path
import sys
import time

if (os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
    raise SystemExit("Use a disposable GitHub-hosted Windows desktop")
ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

import tkinter as tk
from PIL import Image, ImageDraw, ImageTk

width, height = map(int, sys.argv[1:3])
workspace = Path(sys.argv[3])
# Distinct content in both axes prevents repeated stripes from making a bad
# seam look correct. The reference never enters Kiri; only this window paints it.
document = Image.new("RGB", (width, height * 3), "white")
paint = ImageDraw.Draw(document)
for y in range(0, document.height, 32):
    for x in range(0, width, 48):
        tile = y // 32 * 53 + x // 48 * 17
        color = tuple(80 + (tile * factor) % 160 for factor in (7, 11, 19))
        paint.rectangle((x, y, x + 47, y + 31), fill=color)
        paint.text((x + 3, y + 9), f"{x // 48}:{y // 32}", fill="#111111")
document.save(workspace / "reference.png")
root = tk.Tk()
root.title("Kiri public scrolling QA")
root.overrideredirect(True)
root.geometry(f"{width}x{height}+0+0")
canvas = tk.Canvas(root, highlightthickness=0, borderwidth=0)
canvas.pack(fill="both", expand=True)
state = {"offset": 0, "clicks": 0, "wheel_events": 0, "pid": os.getpid()}
photo = item = None


def publish():
    temporary = workspace / "state.next"
    temporary.write_text(json.dumps(state), encoding="utf-8")
    for attempt in range(20):
        try:
            os.replace(temporary, workspace / "state.json")
            return
        except OSError as error:
            # The reader briefly holds a non-share-delete Windows handle.
            # Retry only sharing/access conflicts, never swallow other I/O errors.
            if getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 19:
                raise
            time.sleep(0.01)


def render():
    global photo, item
    photo = ImageTk.PhotoImage(document.crop((0, state["offset"], width, height + state["offset"])))
    if item is None:
        item = canvas.create_image(0, 0, image=photo, anchor="nw")
    else:
        canvas.itemconfigure(item, image=photo)
    root.update_idletasks()
    publish()


def wheel(event):
    if not event.delta:
        return
    state["offset"] = max(0, min(document.height - height,
        state["offset"] + (-96 if event.delta > 0 else 96)))
    state["wheel_events"] += 1
    render()
    return "break"


def click(_event):
    state["clicks"] += 1
    publish()


canvas.bind("<MouseWheel>", wheel)
canvas.bind("<Button-1>", click)
root.after(100, render)
root.after(240000, root.destroy)
root.mainloop()
