"""Inspect an installed Linux recorder's MP4 using system GStreamer libraries.

The desktop harness supplies RGB reference crops for the initial, paused, and
resumed scenes. This module neither launches Kiri nor changes desktop state.
"""

import json
import math
from pathlib import Path
import time

from PIL import Image, ImageChops, ImageStat


def _gstreamer():
    # Lazy loading keeps the pixel comparison usable without a Linux desktop.
    import gi

    gi.require_version("Gst", "1.0")
    gi.require_version("GstPbutils", "1.0")
    gi.require_version("GstVideo", "1.0")
    from gi.repository import Gst, GstPbutils, GstVideo

    Gst.init(None)
    return Gst, GstPbutils, GstVideo


def discover_video(path, expected_size):
    """Require a silent, single-video MP4 of the requested size; return seconds."""
    path = Path(path).resolve()
    with path.open("rb") as video:
        header = video.read(12)
    if len(header) != 12 or header[4:8] != b"ftyp":
        raise RuntimeError("The recording is not an MP4 container")

    Gst, GstPbutils, _ = _gstreamer()
    info = GstPbutils.Discoverer.new(5 * Gst.SECOND).discover_uri(path.as_uri())
    if info.get_result() != GstPbutils.DiscovererResult.OK:
        raise RuntimeError(f"GStreamer could not discover the saved MP4: {info.get_result()}")
    container = info.get_stream_info()
    caps = container.get_caps() if container else None
    if (caps is None or caps.is_empty()
            or caps.get_structure(0).get_name() != "video/quicktime"
            or caps.get_structure(0).get_string("variant") != "iso"):
        raise RuntimeError(f"GStreamer did not identify an ISO MP4 container: {caps}")
    streams = info.get_video_streams()
    if len(streams) != 1 or info.get_audio_streams():
        raise RuntimeError("The silent MP4 must contain exactly one video stream and no audio")
    dimensions = (streams[0].get_width(), streams[0].get_height())
    if dimensions != tuple(expected_size):
        raise RuntimeError(f"MP4 dimensions {dimensions} do not match region {tuple(expected_size)}")
    duration = info.get_duration() / Gst.SECOND
    if not 0 < duration < 60:
        raise RuntimeError(f"Invalid MP4 duration: {duration}")
    return duration


def frame_error(actual, expected):
    """Return RGB mean error and fraction whose absolute luma error exceeds 32."""
    if actual.mode != "RGB" or expected.mode != "RGB" or actual.size != expected.size:
        raise ValueError("Recording frames and references must be same-sized RGB images")
    difference = ImageChops.difference(actual, expected)
    mean = sum(ImageStat.Stat(difference).mean) / 3
    # H.264 4:2:0 loses coloured text-edge antialiasing. Compare luminance of
    # each image, rather than luminance of the RGB difference, for UI shapes.
    luminance = ImageChops.difference(actual.convert("L"), expected.convert("L"))
    changed = sum(luminance.histogram()[33:]) / (actual.width * actual.height)
    return mean, changed


def inspect_recording(path, output, references, expected_active_seconds, wall_seconds, paused_seconds):
    """Fully decode and review a short initial/pause/resume QA recording.

    ``references`` contains exactly ``initial``, ``paused``, and ``resumed`` RGB
    PIL images, already cropped to the recording region. Both active sections
    must contain at least 20 frames; the desktop fixture should produce damage
    outside this region when its compositor does not emit unchanged frames.
    Timing begins when capture delivers frames, not while consent is pending.
    The returned dictionary is JSON serializable. Evidence is saved on failure
    as well as success; a failed review raises RuntimeError or ValueError.
    """
    path, output = Path(path).resolve(), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    review = {"success": False, "reached_eos": False}
    pipeline = None
    Gst = None
    try:
        if set(references) != {"initial", "paused", "resumed"}:
            raise ValueError("Recording references must contain initial, paused, and resumed")
        size = references["initial"].size
        if (min(size) <= 0 or any(image.mode != "RGB" or image.size != size
                                  for image in references.values())):
            raise ValueError("Recording references must be same-sized, nonempty RGB images")
        if not all(math.isfinite(value) and value > 0 for value in (
                expected_active_seconds, wall_seconds, paused_seconds)):
            raise ValueError("Recording timing measurements must be finite and positive")
        if paused_seconds >= wall_seconds or expected_active_seconds >= wall_seconds:
            raise ValueError("Active and paused measurements must each be shorter than wall time")
        for stage, reference in references.items():
            reference.save(output / f"recording-reference-{stage}.png")

        duration = discover_video(path, size)
        review.update({
            "container": "MP4", "dimensions": list(size), "audio_streams": 0,
            "duration_seconds": round(duration, 3),
            "active_seconds": round(expected_active_seconds, 3),
            "paused_seconds": round(paused_seconds, 3), "wall_seconds": round(wall_seconds, 3),
            "decoded_frames": {"initial": 0, "resumed": 0},
            "paused_pattern_frames": 0, "unexpected_frames": 0, "stage_sequence": [],
        })
        # Allow capture startup/finalization scheduling, not the deliberately
        # long paused interval. Pixel checks independently reject paused scenes.
        if abs(duration - expected_active_seconds) > 1.5:
            raise RuntimeError(f"MP4 duration {duration:.3f}s differs from active time "
                               f"{expected_active_seconds:.3f}s")
        if duration >= wall_seconds - paused_seconds + 1.0:
            raise RuntimeError("MP4 duration includes the paused interval")

        Gst, _, GstVideo = _gstreamer()
        pipeline = Gst.parse_launch(
            "uridecodebin name=decode ! videoconvert ! video/x-raw,format=RGB ! "
            "appsink name=frames sync=false max-buffers=2 drop=false"
        )
        pipeline.get_by_name("decode").set_property("uri", path.as_uri())
        sink = pipeline.get_by_name("frames")
        bus = pipeline.get_bus()
        largest_mean = largest_changed = 0.0
        previous_pts = None
        final_frame = worst_mean_frame = worst_changed_frame = None
        if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("GStreamer could not start MP4 decoding")
        deadline = time.monotonic() + 25
        with (output / "recording-frames.jsonl").open("w", encoding="utf-8") as evidence:
            while time.monotonic() < deadline:
                sample = sink.emit("try-pull-sample", 200 * Gst.MSECOND)
                message = bus.pop_filtered(Gst.MessageType.ERROR)
                if message:
                    error, debug = message.parse_error()
                    raise RuntimeError(f"GStreamer MP4 decode failed: {error}: {debug}")
                if sample is None:
                    if sink.get_property("eos"):
                        review["reached_eos"] = True
                        break
                    continue
                buffer = sample.get_buffer()
                info = GstVideo.VideoInfo.new_from_caps(sample.get_caps())
                if (info.width, info.height) != size:
                    raise RuntimeError("Decoded frame dimensions changed")
                if (buffer.pts == Gst.CLOCK_TIME_NONE
                        or (previous_pts is not None and buffer.pts <= previous_pts)):
                    raise RuntimeError("Decoded MP4 timestamps are missing or not strictly increasing")
                if previous_pts is None:
                    review["first_pts_seconds"] = buffer.pts / Gst.SECOND
                previous_pts = buffer.pts
                review["last_pts_seconds"] = buffer.pts / Gst.SECOND
                mapped, mapping = buffer.map(Gst.MapFlags.READ)
                if not mapped:
                    raise RuntimeError("Could not read the decoded MP4 frame")
                try:
                    frame = Image.frombytes("RGB", size, bytes(mapping.data)[info.offset[0]:],
                                            "raw", "RGB", info.stride[0], 1)
                finally:
                    buffer.unmap(mapping)
                errors = {stage: frame_error(frame, reference)
                          for stage, reference in references.items()}
                closest = min(errors, key=lambda stage: errors[stage][0])
                mean, changed = errors[closest]
                evidence.write(json.dumps({"pts_seconds": buffer.pts / Gst.SECOND,
                                           "nearest": closest, "errors": errors}) + "\n")
                if closest == "paused" or mean > 3.5 or changed > 0.008:
                    review["paused_pattern_frames"] += int(closest == "paused")
                    review["unexpected_frames"] += 1
                    frame.save(output / "unexpected-recording-frame.png")
                    ImageChops.difference(frame, references[closest]).save(
                        output / "recording-frame-difference.png")
                    raise RuntimeError(f"Unexpected MP4 frame: nearest={closest}, "
                                       f"mean error={mean:.3f}, changed pixels={changed:.4%}")
                counts = review["decoded_frames"]
                if counts[closest] == 0:
                    frame.save(output / f"recording-first-{closest}-frame.png")
                counts[closest] += 1
                sequence = review["stage_sequence"]
                if not sequence or sequence[-1] != closest:
                    sequence.append(closest)
                if worst_mean_frame is None or mean > largest_mean:
                    largest_mean, worst_mean_frame = mean, frame
                if worst_changed_frame is None or changed > largest_changed:
                    largest_changed, worst_changed_frame = changed, frame
                final_frame = frame

        if final_frame is not None:
            final_frame.save(output / "recording-final-frame.png")
            worst_mean_frame.save(output / "recording-maximum-mean-frame.png")
            worst_changed_frame.save(output / "recording-maximum-changed-frame.png")
        review["maximum_frame_mean_error"] = round(largest_mean, 4)
        review["maximum_frame_changed_fraction"] = round(largest_changed, 6)
        if not review["reached_eos"]:
            raise RuntimeError("GStreamer did not decode the complete MP4 before the deadline")
        if min(review["decoded_frames"].values()) < 20:
            raise RuntimeError("Both active recording sections must have at least 20 decoded frames: "
                               f"{review['decoded_frames']}")
        if review["stage_sequence"] != ["initial", "resumed"]:
            raise RuntimeError(f"Recording sections are out of order: {review['stage_sequence']}")
        review["strictly_increasing_pts"] = True
        review["success"] = True
        return review
    except Exception as error:
        review["error"] = str(error)
        raise
    finally:
        if pipeline is not None:
            pipeline.set_state(Gst.State.NULL)
        (output / "recording-review.json").write_text(
            json.dumps(review, indent=2) + "\n", encoding="utf-8")
