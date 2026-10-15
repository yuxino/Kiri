"""A separate GTK desktop page for native scrolling-capture acceptance.

Kiri receives no test switches or injected frames. The fixture paints public,
deterministic pixels and scrolls only in response to ordinary desktop input.
"""

import json
import os
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont
import gi

gi.require_foreign("cairo")
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk


BOUNDS = (80, 120, 840, 600)
STEP = 96
SOURCE_HEIGHT = 4000


def serve(output):
    output.mkdir(parents=True, exist_ok=True)
    width, height = BOUNDS[2] - BOUNDS[0], BOUNDS[3] - BOUNDS[1]
    source = Image.new("RGB", (width, SOURCE_HEIGHT), "white")
    draw = ImageDraw.Draw(source)
    font = ImageFont.load_default(size=22)
    for index, top in enumerate(range(0, SOURCE_HEIGHT, 48)):
        color = ((index * 47 + 181) % 230, (index * 29 + 137) % 230, (index * 83 + 199) % 230)
        draw.rectangle((0, top, width, top + 47), fill=(246, 246, 246) if index % 2 else (231, 237, 243))
        draw.rectangle((12, top + 7, 38, top + 36), fill=color)
        draw.text((55, top + 10), f"ROW {index:03d}  /  KIRI SCROLLING CAPTURE  /  {index * 7919:06d}", font=font, fill=(20, 24, 29))
        # A unique right-hand barcode rejects repeated-row/blank overlap guesses.
        for bit in range(12):
            if (index * 4051 + 17) & (1 << bit):
                draw.rectangle((610 + bit * 10, top + 9, 615 + bit * 10, top + 36), fill=color)
    source_path = output / "public-scroll-source.png"
    source.save(source_path)
    pixbuf = GdkPixbuf.Pixbuf.new_from_file(str(source_path))
    events = (output / "scroll-fixture-events.jsonl").open("w", encoding="utf-8")
    state = {"offset": 0, "fixed": False}
    window = Gtk.Window(title="Kiri QA public scrolling page")
    window.set_default_size(1280, 800)
    if os.environ.get("KIRI_SCROLL_FIXTURE_FULLSCREEN", "1") == "1":
        window.fullscreen()
    else:
        window.set_decorated(False)
        window.move(0, 0)
    fixed = Gtk.Fixed()
    fixed.override_background_color(Gtk.StateFlags.NORMAL, Gdk.RGBA(0.13, 0.15, 0.18, 1))
    window.add(fixed)
    area = Gtk.DrawingArea()
    area.set_size_request(width, height)
    area.add_events(Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK)
    fixed.put(area, BOUNDS[0], BOUNDS[1])

    def paint(_area, context):
        Gdk.cairo_set_source_pixbuf(context, pixbuf, 0, -state["offset"])
        context.paint()
        if state["fixed"]:
            context.set_source_rgb(0.09, 0.12, 0.16)
            context.rectangle(0, 0, width, 36)
            context.fill()
            context.set_source_rgb(1, 1, 1)
            context.move_to(14, 24)
            context.set_font_size(18)
            context.show_text("Fixed page header")
        return False

    def scroll(_area, event):
        delta = -STEP if event.direction == Gdk.ScrollDirection.UP else STEP
        state["offset"] = max(0, min(SOURCE_HEIGHT - height, state["offset"] + delta))
        events.write(json.dumps({"event": "scroll", **state}) + "\n")
        events.flush()
        area.queue_draw()
        return True

    area.connect("draw", paint)
    area.connect("scroll-event", scroll)
    window.show_all()

    def request(_channel, _condition):
        line = sys.stdin.readline()
        if not line:
            Gtk.main_quit()
            return False
        message = json.loads(line)
        action = message["action"]
        if action == "show":
            window.show_all()
            window.present()
        elif action == "hide":
            window.hide()
        elif action == "reset":
            state.update(offset=0, fixed=message.get("fixed", False))
            area.queue_draw()
        elif action == "quit":
            Gtk.main_quit()
        elif action not in {"ready", "status"}:
            raise ValueError(f"Unknown fixture request: {action}")
        print(json.dumps({"id": message["id"], "ok": True, **state}), flush=True)
        return True

    GLib.io_add_watch(sys.stdin, GLib.IO_IN, request)
    Gtk.main()
    events.close()


if __name__ == "__main__":
    serve(Path(sys.argv[1]))
