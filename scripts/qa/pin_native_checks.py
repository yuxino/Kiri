"""Shared assertions for real, isolated screenshot pinning acceptance."""

import json
from pathlib import Path
import re


def pin_open_log_marker(asset_id):
    # The Swift-compatible library index writes uppercase UUIDs, whereas Rust
    # Display uses lowercase in the native diagnostics.
    return f"[pin] screenshot opened asset_id={asset_id.lower()}"


def pin_lifecycle_evidence(log, asset_id):
    """Use only the log suffix recorded before clicking this capture's Pin."""
    queued = list(re.finditer(r"completion queued until overlay destruction labels=(\d+)", log))
    opened = list(re.finditer(re.escape(pin_open_log_marker(asset_id)) + r"\b", log))
    if len(queued) != 1 or len(opened) != 1:
        raise RuntimeError("Direct pin must queue one completion and open its saved asset once")
    destroyed = list(re.finditer(r"\[window\] destroyed label=(overlay[^\s]*)", log))
    count = int(queued[0].group(1))
    labels = [event.group(1) for event in destroyed]
    if count < 1 or len(labels) != count or len(set(labels)) != count:
        raise RuntimeError(f"Expected destruction of all {count} capture overlays, got {labels}")
    if not all(queued[0].start() < event.start() < opened[0].start() for event in destroyed):
        raise RuntimeError("A pin opened before every confirmed capture overlay was destroyed")
    return {"queued_overlay_count": count, "destroyed_overlays": labels,
            "pin_after_all_overlay_destroyed": True, "opened_once": True}


def proportional_resize_evidence(before, after):
    if min(before) <= 0 or min(after) <= 0:
        raise RuntimeError("Pin dimensions must be positive")
    if after[0] < before[0] + 20 or after[1] < before[1] + 10:
        raise RuntimeError(f"The corner drag did not grow the pin: {before} -> {after}")
    relative_error = abs((after[0] / after[1]) / (before[0] / before[1]) - 1)
    if relative_error > 0.015:
        raise RuntimeError(f"Corner resizing changed aspect: {before} -> {after}")
    return {"before": list(before), "after": list(after), "relative_aspect_error": relative_error}


def annotated_capture_evidence(library, asset, source, copied):
    from PIL import Image, ImageChops, ImageStat

    filename = Path(asset["filename"])
    if filename.name != str(filename):
        raise RuntimeError("QA capture must stay inside its isolated library")
    image = Image.open(Path(library) / "Assets" / filename).convert("RGB")
    if image.size != source.size or image.size != copied.size:
        raise RuntimeError("Annotated screenshot changed the selected region dimensions")
    clipboard_error = sum(ImageStat.Stat(ImageChops.difference(image, copied.convert("RGB"))).mean) / 3
    if clipboard_error > 1.5:
        raise RuntimeError("Pinned capture's saved PNG differs from its clipboard image")
    changed = ImageChops.difference(image, source.convert("RGB"))
    colored = sum(r > 180 and r > g + 60 and r > b + 40 and max(delta) > 25
                  for (r, g, b), delta in zip(image.getdata(), changed.getdata()))
    if colored < 200:
        raise RuntimeError("Saved PNG is missing the rectangle drawn on the native overlay")
    project = json.loads((Path(library) / "Annotations" / f"{asset['id'].lower()}.json").read_text())
    marks = project["document"]["marks"]
    if len(marks) != 1 or marks[0]["kind"] != "rectangle":
        raise RuntimeError("Direct pin must retain its one editable rectangle annotation")
    return image, {"dimensions": list(image.size), "annotation_pixels": colored,
                   "clipboard_mean_pixel_error": clipboard_error, "editable_rectangle_retained": True}
