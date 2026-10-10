"""Isolated product-window regressions; generated pixels, no user's native data.

CI uses its existing Playwright runtime. Interactive local acceptance uses Ego.
"""
import asyncio
import json
import os
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("KIRI_ANNOTATION_QA_OUT", "annotation-tools-review"))
URL = "http://127.0.0.1:5198/scripts/qa/annotation-tools-harness.html"
LANGUAGES = ["en", "zh-Hans", "zh-Hant", "ja", "de", "ko", "fr"]


async def rect(page, selector):
    return await page.locator(selector).bounding_box()


async def assert_actions(page):
    """Wrapped tool/action rows stay inside the toolbar and remain reachable."""
    result = await page.evaluate("""() => {
      const bar=document.querySelector('.kiri-image-editor-toolbar');
      const r=bar.getBoundingClientRect();
      return [...bar.querySelectorAll('button')].map(b=>{
        const q=b.getBoundingClientRect();return {title:b.title||b.textContent,
          visible:q.width>0&&q.height>0,inside:q.left>=-1&&q.right<=innerWidth+1&&
            q.top>=r.top-1&&q.bottom<=r.bottom+1,
          hit:b.disabled||document.elementFromPoint(q.x+q.width/2,q.y+q.height/2)?.closest('button')===b};
      });
    }""")
    assert all(row["visible"] and row["inside"] and row["hit"] for row in result), result


async def assert_properties(page):
    """Every normal property control is visible without a hidden partial row."""
    result = await page.evaluate("""() => {
      const panel=document.querySelector('.kiri-image-editor-properties');
      const r=panel.getBoundingClientRect();
      return [...panel.querySelectorAll('button,input')].map(e=>{
        const q=e.getBoundingClientRect();return {title:e.ariaLabel||e.title||e.textContent,
          inside:q.width>0&&q.height>0&&q.left>=r.left-1&&q.right<=r.right+1&&
            q.top>=r.top-1&&q.bottom<=r.bottom+1,
          hit:document.elementFromPoint(q.x+q.width/2,q.y+q.height/2)?.closest('button,input')===e};
      });
    }""")
    assert all(row["inside"] and row["hit"] for row in result), result


async def editor_cases(browser, report):
    for language in LANGUAGES:
        dictionary = json.loads((ROOT / "src/i18n" / f"{language}.json").read_text())
        for width in [320, 480, 560, 741, 1200]:
            context = await browser.new_context(viewport={"width": width, "height": 720})
            page = await context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                await page.goto(f"{URL}?lang={language}")
                await page.locator("canvas").wait_for()
                await assert_actions(page)
                before = await rect(page, "canvas")
                await page.get_by_role("button", name=dictionary["Watermark (W)"], exact=True).click()
                editor = page.locator("textarea")
                await editor.wait_for()
                await editor.press_sequentially("Watermark abcdef", delay=2)
                assert await editor.input_value() == "Watermark abcdef"
                assert await editor.evaluate("e=>getComputedStyle(e).backgroundColor") == "rgba(0, 0, 0, 0)"
                assert await rect(page, "canvas") == before, "Editing must not move the image"
                assert await page.locator('.kiri-image-editor-properties .kiri-annotation-choices').count() == 0
                await assert_properties(page)
                await page.get_by_role("button", name=dictionary["Watermark (W)"], exact=True).click()
                assert await editor.input_value() == "Watermark abcdef"
                assert await page.get_by_role("button", name=dictionary["Undo (⌘Z)"], exact=True).is_disabled(), "Repeated tool entry must keep the uncommitted native draft"
                await page.get_by_role("button", name=dictionary["Edit watermark"], exact=True).click()
                assert await editor.input_value() == "Watermark abcdef"
                assert await page.evaluate("document.activeElement === document.querySelector('textarea')")
                await page.locator('input[type=number][aria-label="' + dictionary["Opacity"] + '"]').fill("55")
                await page.locator('input[type=number][aria-label="' + dictionary["Opacity"] + '"]').press("Enter")
                await page.get_by_role("button", name=dictionary["Select (V)"], exact=True).click()
                assert await rect(page, "canvas") == before
                await page.get_by_role("button", name=dictionary["Save As…"], exact=True).click()
                await page.wait_for_function("__annotationToolsQa.exports.length===1")
                mark = await page.evaluate("__annotationToolsQa.document.marks[0]")
                assert mark["kind"] == "watermark" and mark["text"] == "Watermark abcdef", mark
                assert mark["mode"] == "tiled" and mark["opacity"] == .55, mark
                await page.get_by_role("button", name=dictionary["Watermark (W)"], exact=True).click()
                await editor.wait_for()
                assert await editor.input_value() == mark["text"]
                assert await page.evaluate("document.activeElement === document.querySelector('textarea')")
                await page.keyboard.press("ArrowRight")
                await page.keyboard.type(" second edit")
                await page.keyboard.press("Enter")
                await page.get_by_role("button", name=dictionary["Save As…"], exact=True).click()
                await page.wait_for_function("__annotationToolsQa.exports.length===2")
                marks = await page.evaluate("__annotationToolsQa.document.marks")
                assert len(marks) == 1 and marks[0]["id"] == mark["id"], marks
                assert marks[0]["text"] == "Watermark abcdef second edit", marks
                assert await rect(page, "canvas") == before
                assert not errors, errors
                if width == 320:
                    await page.screenshot(path=str(OUT / f"editor-{language}-320.png"))
                report["editor"].append({"language": language, "width": width, "passed": True,
                                         "completeProperties": True, "tiledOnly": True, "secondEdit": True})
            finally:
                await context.close()


async def overlay_cases(browser, report):
    for width, height, language in [(320, 480, "zh-Hans"), (480, 640, "fr"), (1280, 800, "en")]:
        dictionary = json.loads((ROOT / "src/i18n" / f"{language}.json").read_text())
        for corner in ["top-left", "top-right", "bottom-left", "bottom-right"]:
            context = await browser.new_context(viewport={"width": width, "height": height})
            page = await context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                await page.goto(f"{URL}?lang={language}&window=overlay")
                await page.wait_for_function("document.querySelector('img')?.complete")
                x = 10 if "left" in corner else width - 90
                y = 135 if "top" in corner else height - 90
                await page.mouse.move(x, y)
                await page.mouse.down()
                await page.mouse.move(x + 70, y + 60, steps=6)
                await page.mouse.up()
                await page.get_by_role("button", name=dictionary["Watermark (W)"], exact=True).click()
                await page.locator("textarea").wait_for()
                await page.locator("textarea").press_sequentially("QA")
                layout = await page.evaluate("""() => {
                  const mode=document.querySelector('.kiri-mode-select');
                  const row=document.querySelector('.kiri-capture-toolbar .kiri-hud');
                  const r=row.getBoundingClientRect(), m=mode?.getBoundingClientRect();
                  const buttons=[...row.querySelectorAll('button')].map(b=>{
                    const q=b.getBoundingClientRect();return {title:b.title,
                      inside:q.left>=0&&q.right<=innerWidth&&q.top>=0&&q.bottom<=innerHeight,
                      hit:document.elementFromPoint(q.x+q.width/2,q.y+q.height/2)?.closest('button')===b};
                  });
                  return {buttons,clearOfMode:!m||r.right<=m.left||r.left>=m.right||r.bottom<=m.top||r.top>=m.bottom};
                }""")
                assert layout["clearOfMode"], layout
                assert all(b["inside"] and b["hit"] for b in layout["buttons"]), layout
                await page.get_by_role("button", name=dictionary["Done — Copy to clipboard · Return"], exact=True).click()
                await page.wait_for_function("__annotationToolsQa.exports.length===1")
                mark = await page.evaluate("__annotationToolsQa.document.marks[0]")
                assert mark["text"] == "QA" and mark["kind"] == "watermark", mark
                assert not errors, errors
                if corner == "top-left":
                    await page.screenshot(path=str(OUT / f"overlay-{language}-{width}.png"))
                report["overlay"].append({"language": language, "width": width, "corner": corner, "passed": True})
            finally:
                await context.close()


async def existing_text_case(browser, report):
    context = await browser.new_context(viewport={"width": 1200, "height": 720})
    page = await context.new_page()
    try:
        await page.goto(f"{URL}?lang=en&seed")
        canvas = page.locator("canvas")
        await canvas.wait_for()
        box = await canvas.bounding_box()
        await page.mouse.dblclick(box["x"] + 390 * box["width"] / 960,
                                 box["y"] + 201 * box["height"] / 600)
        await page.wait_for_function("document.querySelector('textarea') !== null")
        assert await page.evaluate("document.activeElement === document.querySelector('textarea')"), "Reopened text must own the next key"
        # Use the keyboard without locator focus so a missing focus cannot be
        # masked by the test framework's automatic textbox focusing.
        await page.keyboard.press("ArrowRight")
        await page.keyboard.type(" abcdef")
        await page.keyboard.press("Shift+Enter")
        await page.keyboard.type("second line")
        expected = "Editable text abcdef\nsecond line"
        assert await page.locator("textarea").input_value() == expected
        assert await page.evaluate("__annotationToolsQa.exports.length") == 0
        await page.keyboard.press("Enter")
        await page.locator("textarea").wait_for(state="detached")
        await page.get_by_role("button", name="Save As…", exact=True).click()
        await page.wait_for_function("__annotationToolsQa.exports.length===1")
        mark = await page.evaluate("__annotationToolsQa.document.marks.find(mark=>mark.id===2)")
        assert mark["text"] == expected and mark["background"] == "transparent", mark
        report["existingText"] = {"passed": True, "immediateTyping": True, "multiline": True}
    finally:
        await context.close()


async def callout_pointer_case(browser, report):
    context = await browser.new_context(viewport={"width": 1200, "height": 720})
    page = await context.new_page()
    try:
        await page.goto(f"{URL}?lang=en")
        canvas = page.locator("canvas")
        await canvas.wait_for()
        await page.get_by_role("button", name="Numbered callout (N)", exact=True).click()
        box = await canvas.bounding_box()
        await page.mouse.click(box["x"] + box["width"] * .3, box["y"] + box["height"] * .45)
        editor = page.locator("textarea")
        await editor.wait_for()
        await page.keyboard.type("Callout drag test")
        slider = page.locator('input[type=range][aria-label="Number size"]')
        track = await slider.bounding_box()
        limits = await slider.evaluate("e => ({min: Number(e.min), max: Number(e.max)})")
        # The custom control leaves 6px at each end of its pointer track.
        # A percentage of the whole flex-sized element is not a fixed value.
        # Chromium exposes host styles for its private thumb pseudo-element,
        # so getComputedStyle cannot measure that thumb's width here.
        def slider_x(value):
            return track["x"] + 6 + (track["width"] - 12) * (value - limits["min"]) / (limits["max"] - limits["min"])
        await page.mouse.move(slider_x(38), track["y"] + track["height"] / 2)
        await page.mouse.down()
        await page.mouse.move(slider_x(66), track["y"] + track["height"] / 2, steps=8)
        await page.mouse.up()
        assert await editor.input_value() == "Callout drag test"
        try:
            await page.wait_for_function("document.querySelector('input[type=range][aria-label=\"Number size\"]').value === '66'", timeout=1000)
        except Exception:
            report["calloutSliderFailure"] = {"track": track, "limits": limits,
                "actual": await slider.input_value(), "target": 66}
            await page.screenshot(path=str(OUT / "callout-slider-failure.png"))
            raise
        assert await slider.input_value() == "66"
        assert await slider.evaluate("e=>getComputedStyle(e).outlineStyle") == "none"
        assert await page.get_by_role("button", name="Move description", exact=True).count() == 0
        save = page.get_by_role("button", name="Save As…", exact=True)
        await save.click()
        await page.wait_for_function("__annotationToolsQa.exports.length===1")
        before = await page.evaluate("__annotationToolsQa.document.marks[0]")
        assert before["size"] == 66 and before["text"] == "Callout drag test", before
        await page.get_by_role("button", name="Edit text", exact=True).click()
        await editor.wait_for()
        frame = await editor.bounding_box()
        await page.mouse.move(frame["x"] + 1, frame["y"] + frame["height"] / 2)
        await page.mouse.down()
        await page.mouse.move(frame["x"] + 41, frame["y"] + frame["height"] / 2 + 20, steps=8)
        await page.mouse.up()
        await save.click()
        await page.wait_for_function("__annotationToolsQa.exports.length===2")
        description_moved = await page.evaluate("__annotationToolsQa.document.marks[0]")
        scale = box["width"] / 960
        assert description_moved["center"] == before["center"], description_moved
        assert abs(description_moved["labelRect"]["x"] - before["labelRect"]["x"] - 40 / scale) < 1
        assert abs(description_moved["labelRect"]["y"] - before["labelRect"]["y"] - 20 / scale) < 1
        assert description_moved["text"] == before["text"]
        await page.get_by_role("button", name="Select (V)", exact=True).click()
        center = description_moved["center"]
        x, y = box["x"] + center["x"] * scale, box["y"] + center["y"] * scale
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 35, y + 15, steps=8)
        await page.mouse.up()
        await save.click()
        await page.wait_for_function("__annotationToolsQa.exports.length===3")
        badge_moved = await page.evaluate("__annotationToolsQa.document.marks[0]")
        assert badge_moved["labelRect"] == description_moved["labelRect"]
        assert abs(badge_moved["center"]["x"] - center["x"] - 35 / scale) < 1
        assert abs(badge_moved["center"]["y"] - center["y"] - 15 / scale) < 1
        await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
        await save.click()
        await page.wait_for_function("__annotationToolsQa.exports.length===4")
        assert await page.evaluate("__annotationToolsQa.document.marks[0]") == description_moved
        await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
        await save.click()
        await page.wait_for_function("__annotationToolsQa.exports.length===5")
        assert await page.evaluate("__annotationToolsQa.document.marks[0]") == badge_moved
        report["calloutPointer"] = {"passed": True, "liveSize": 66, "directFrameDrag": True, "firstBadgeDrag": True, "singleUndo": True}
    finally:
        await context.close()


async def anchored_label_case(browser, report):
    context = await browser.new_context(viewport={"width": 1200, "height": 720})
    page = await context.new_page()
    try:
        await page.goto(f"{URL}?lang=en")
        await page.locator("canvas").wait_for()
        await page.get_by_role("button", name="Label bubble (B)", exact=True).click()
        box = await page.locator("canvas").bounding_box()
        await page.mouse.click(box["x"] + box["width"] * .6, box["y"] + box["height"] * .3)
        await page.locator("textarea").wait_for()
        await page.wait_for_function("document.activeElement === document.querySelector('textarea')")
        await page.keyboard.type("line one")
        await page.keyboard.press("Shift+Enter")
        await page.keyboard.type("line two!!")
        await page.keyboard.press("Enter")
        await page.locator("textarea").wait_for(state="detached")
        dot = page.locator(".kiri-label-dot")
        before = await dot.bounding_box()
        await dot.click()
        after = await dot.bounding_box()
        assert abs(after["x"] - before["x"]) < .5 and abs(after["y"] - before["y"]) < .5, (before, after)
        await page.get_by_role("button", name="Save As…", exact=True).click()
        await page.wait_for_function("__annotationToolsQa.exports.length===1")
        mark = await page.evaluate("__annotationToolsQa.document.marks[0]")
        assert mark["text"] == "line one\nline two!!" and mark["labelDirection"] == "right", mark
        await dot.click()
        restored = await dot.bounding_box()
        assert abs(restored["x"] - before["x"]) < .5 and abs(restored["y"] - before["y"]) < .5
        direction = await dot.get_attribute("aria-label")
        x, y = restored["x"] + restored["width"] / 2, restored["y"] + restored["height"] / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 20, y + 10, steps=5)
        await page.mouse.up()
        assert await dot.get_attribute("aria-label") == direction, "Dragging the dot must not flip"
        assert await dot.bounding_box() == restored, "Dragging the dot must not move the annotation"
        await page.get_by_role("button", name="Save As…", exact=True).click()
        await page.wait_for_function("__annotationToolsQa.exports.length===2")
        initial = await page.evaluate("__annotationToolsQa.document.marks[0]")
        scale = box["width"] / 960
        x = box["x"] + (initial["rect"]["x"] + initial["rect"]["width"] / 2) * scale
        y = box["y"] + (initial["rect"]["y"] + initial["rect"]["height"] / 2) * scale
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 25, y + 15, steps=5)
        await page.mouse.up()
        assert await page.locator("textarea").count() == 0, "The active label tool must drag directly"
        await page.get_by_role("button", name="Save As…", exact=True).click()
        await page.wait_for_function("__annotationToolsQa.exports.length===3")
        moved = await page.evaluate("__annotationToolsQa.document.marks[0]")
        assert moved["id"] == initial["id"] and moved["text"] == initial["text"]
        assert abs(moved["rect"]["x"] - initial["rect"]["x"] - 25 / scale) < 1
        assert abs(moved["rect"]["y"] - initial["rect"]["y"] - 15 / scale) < 1
        report["anchoredLabel"] = {"passed": True, "fixedDot": True, "roundTrip": True,
                                    "unchangedText": True, "dotDragSuppressed": True, "activeToolDrag": True}
    finally:
        await context.close()


async def placement_source_hash(page):
    return await page.evaluate("""async () => {
      const source=__annotationToolsQa.source;
      const bytes=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
        .map(value=>value.toString(16).padStart(2,'0')).join('');
    }""")


async def placement_canvas_hash(page):
    # Wait for the committed React layout and its canvas paint, rather than
    # assuming a detached textarea means the passive redraw has already run.
    return await page.evaluate("""async () => {
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const canvas=document.querySelector('canvas');
      const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
        .map(value=>value.toString(16).padStart(2,'0')).join('');
    }""")


async def placement_point(page, fx, fy):
    box = await page.locator("canvas").bounding_box()
    point = {"x": box["x"] + box["width"] * fx, "y": box["y"] + box["height"] * fy}
    hit = await page.evaluate("""p => document.elementFromPoint(p.x,p.y)===document.querySelector('canvas')""", point)
    assert hit, {"message": "A real canvas gesture must not hit the HUD or native input", "point": point, "box": box}
    return point


async def placement_drag(page, start, end):
    await page.mouse.move(start["x"], start["y"])
    await page.mouse.down()
    await page.mouse.move(end["x"], end["y"], steps=8)
    await page.mouse.up()


async def placement_input(page, expected=""):
    editor = page.locator("textarea")
    await editor.wait_for(state="visible")
    await page.wait_for_function("document.activeElement===document.querySelector('textarea')")
    assert await editor.input_value() == expected
    assert await editor.evaluate("e=>getComputedStyle(e).backgroundColor") == "rgba(0, 0, 0, 0)"
    return editor


async def placement_finished(page, title, source_hash):
    # These assertions precede every save: exportResult itself can commit a
    # pending editor and would otherwise conceal an incorrect canvas click.
    await page.locator("textarea").wait_for(state="detached")
    await page.wait_for_function("[...document.querySelectorAll('.kiri-annotation-controls-heading span')].every(e=>e.textContent!=='Selected object')")
    assert await page.get_by_role("button", name=title, exact=True).get_attribute("aria-pressed") == "true"
    assert await page.evaluate("__annotationToolsQa.exports.length") == 0
    assert await placement_source_hash(page) == source_hash, "Annotation gestures must never alter the clean source"


async def placement_export(page, surface, source_hash):
    await page.locator("textarea").wait_for(state="detached")
    assert await page.evaluate("__annotationToolsQa.exports.length") == 0
    assert await placement_source_hash(page) == source_hash
    title = "Save As…" if surface == "editor" else "Done — Copy to clipboard · Return"
    await page.get_by_role("button", name=title, exact=True).click()
    await page.wait_for_function("__annotationToolsQa.exports.length===1")
    result = await page.evaluate("""async () => {
      const qa=__annotationToolsQa, bytes=qa.exports[0];
      const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const result={document:qa.document,signature:Array.from(bytes.slice(0,8)),
        pixels:{width:image.width,height:image.height},exports:qa.exports.length};
      image.close();return result;
    }""")
    assert result["signature"] == [137, 80, 78, 71, 13, 10, 26, 10], result
    assert result["pixels"] == result["document"]["sourcePixels"], result
    assert result["exports"] == 1
    assert await placement_source_hash(page) == source_hash
    return result["document"]


async def placement_setup(browser, surface):
    context = await browser.new_context(viewport={"width": 1280, "height": 1200})
    page = await context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        await page.goto(f"{URL}?lang=en" + ("&window=overlay" if surface == "overlay" else ""))
        if surface == "overlay":
            await page.wait_for_function("document.querySelector('img')?.complete")
            await placement_drag(page, {"x": 160, "y": 300}, {"x": 1120, "y": 900})
        await page.get_by_role("button", name="Select (V)", exact=True).click()
        await page.locator("canvas").wait_for(state="visible")
        source_hash = await placement_source_hash(page)
        empty_hash = await placement_canvas_hash(page)
        # This buffer belongs only to this isolated page and lets the watermark
        # test click a visibly rendered repeat, rather than an assumed grid point.
        await page.evaluate("""() => {
          const canvas=document.querySelector('canvas');
          __annotationToolsQa.placementBaseline=canvas.getContext('2d')
            .getImageData(0,0,canvas.width,canvas.height).data.slice();
        }""")
        return context, page, errors, source_hash, empty_hash
    except Exception:
        await context.close()
        raise


async def placement_text_case(page, surface, tool, title, source_hash, empty_hash, case):
    await page.get_by_role("button", name=title, exact=True).click()
    first = await placement_point(page, .18, .27)
    await page.mouse.click(first["x"], first["y"])
    await placement_input(page)
    first_text, second_text = f"First {tool}", f"Second {tool}"
    await page.keyboard.type(first_text)
    assert await page.locator("textarea").input_value() == first_text
    case["phase"] = "first blank click finishes input"
    blank = await placement_point(page, .76, .72)
    await page.mouse.click(blank["x"], blank["y"])
    await placement_finished(page, title, source_hash)
    committed = await placement_canvas_hash(page)
    assert committed != empty_hash, "The first note must remain visibly painted"
    case["phase"] = "second click creates the next note"
    # No intervening tool/history action may reset the consumed-gesture state.
    await page.mouse.click(blank["x"], blank["y"])
    await placement_input(page)
    await page.keyboard.type(second_text)
    assert await page.locator("textarea").input_value() == second_text
    finish = await placement_point(page, .12, .82)
    await page.mouse.click(finish["x"], finish["y"])
    await placement_finished(page, title, source_hash)
    two_pixels = await placement_canvas_hash(page)
    assert two_pixels != committed
    case["phase"] = "undo preserves only the two intended notes"
    # A callout first creates its badge, then records its description edit.
    # Text and labels append only when their native input is committed.
    entries = 2 if tool == "callout" else 1
    for _ in range(entries):
        await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == committed
    for _ in range(entries):
        await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == empty_hash, "Consumed clicks must not add empty marks or history"
    assert await page.get_by_role("button", name="Undo (⌘Z)", exact=True).is_disabled()
    for _ in range(entries):
        await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == committed
    for _ in range(entries):
        await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == two_pixels
    await placement_finished(page, title, source_hash)
    case["phase"] = "export finished notes"
    document = await placement_export(page, surface, source_hash)
    marks = document["marks"]
    assert len(marks) == 2 and marks[0]["id"] != marks[1]["id"], marks
    assert [mark["text"] for mark in marks] == [first_text, second_text], marks
    assert all(mark["kind"] == ("callout" if tool == "callout" else "text") for mark in marks), marks
    if tool != "callout":
        assert all(mark["background"] == "transparent" for mark in marks), marks
        assert all(bool(mark.get("labelDirection")) == (tool == "label") for mark in marks), marks
    case.update(firstClickCommitted=True, secondClickCreated=True, deselected=True,
                activeToolRetained=True, undoRedoPixels=True, exportedMarks=2)


async def placement_shape_case(page, surface, tool, title, source_hash, empty_hash, case):
    await page.get_by_role("button", name=title, exact=True).click()
    start, end = await placement_point(page, .18, .27), await placement_point(page, .36, .42)
    await placement_drag(page, start, end)
    await page.get_by_text("Selected object", exact=True).wait_for(state="visible")
    case["phase"] = "first blank drag only deselects"
    second_start, second_end = await placement_point(page, .68, .62), await placement_point(page, .83, .77)
    await placement_drag(page, second_start, second_end)
    await placement_finished(page, title, source_hash)
    first_pixels = await placement_canvas_hash(page)
    assert first_pixels != empty_hash
    case["phase"] = "second blank drag creates another shape"
    await placement_drag(page, second_start, second_end)
    await page.get_by_text("Selected object", exact=True).wait_for(state="visible")
    blank = await placement_point(page, .12, .82)
    await page.mouse.click(blank["x"], blank["y"])
    await placement_finished(page, title, source_hash)
    two_pixels = await placement_canvas_hash(page)
    assert two_pixels != first_pixels
    await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == first_pixels
    await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == empty_hash, "The entire first blank drag must be consumed"
    assert await page.get_by_role("button", name="Undo (⌘Z)", exact=True).is_disabled()
    await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == first_pixels
    await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == two_pixels
    case["phase"] = "own existing shape moves on its first drag"
    middle = {"x": (start["x"] + end["x"]) / 2, "y": (start["y"] + end["y"]) / 2}
    await placement_drag(page, middle, {"x": middle["x"] + 30, "y": middle["y"] + 18})
    await page.get_by_text("Selected object", exact=True).wait_for(state="visible")
    await page.mouse.click(blank["x"], blank["y"])
    await placement_finished(page, title, source_hash)
    moved_pixels = await placement_canvas_hash(page)
    assert moved_pixels != two_pixels
    await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == two_pixels, "A direct move must be a single undo step"
    await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == moved_pixels
    box = await page.locator("canvas").bounding_box()
    case["phase"] = "export moved and newly placed shapes"
    document = await placement_export(page, surface, source_hash)
    marks, size = document["marks"], document["canvas"]
    assert len(marks) == 2 and all(mark["kind"] == tool for mark in marks), marks
    assert marks[0]["id"] != marks[1]["id"], marks
    dx, dy = 30 * size["width"] / box["width"], 18 * size["height"] / box["height"]
    if tool == "rectangle":
        expected = {"x": .18 * size["width"] + dx, "y": .27 * size["height"] + dy,
                    "width": .18 * size["width"], "height": .15 * size["height"]}
        assert all(abs(marks[0]["rect"][key] - value) < 1 for key, value in expected.items()), marks
    else:
        for key, fx, fy in [("start", .18, .27), ("end", .36, .42)]:
            assert abs(marks[0][key]["x"] - fx * size["width"] - dx) < 1, marks
            assert abs(marks[0][key]["y"] - fy * size["height"] - dy) < 1, marks
    case.update(firstBlankDragConsumed=True, secondDragCreated=True, ownShapeFirstDragMoved=True,
                activeToolRetained=True, undoRedoPixels=True, exportedMarks=2)


async def placement_continuous_case(page, surface, tool, title, source_hash, empty_hash, case):
    await page.get_by_role("button", name=title, exact=True).click()
    if tool == "mosaic":
        freehand = page.get_by_role("button", name="Freehand", exact=True)
        assert await freehand.get_attribute("aria-pressed") == "true"
    case["phase"] = "two consecutive strokes with the same active tool"
    for start, end in [((.18, .27), (.40, .39)), ((.62, .65), (.84, .77))]:
        await placement_drag(page, await placement_point(page, *start), await placement_point(page, *end))
        await page.get_by_text("Selected object", exact=True).wait_for(state="visible")
        assert await page.get_by_role("button", name=title, exact=True).get_attribute("aria-pressed") == "true"
    # Switch to Select only after both strokes: otherwise a tool switch could
    # clear the selection and hide a swallowed second-stroke regression.
    await page.get_by_role("button", name="Select (V)", exact=True).click()
    blank = await placement_point(page, .12, .82)
    await page.mouse.click(blank["x"], blank["y"])
    two_pixels = await placement_canvas_hash(page)
    assert two_pixels != empty_hash
    case["phase"] = "undo verifies exactly two stroke entries"
    await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
    first_pixels = await placement_canvas_hash(page)
    assert first_pixels != two_pixels and first_pixels != empty_hash
    await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == empty_hash
    assert await page.get_by_role("button", name="Undo (⌘Z)", exact=True).is_disabled()
    await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == first_pixels
    await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == two_pixels
    await page.get_by_role("button", name=title, exact=True).click()
    await placement_finished(page, title, source_hash)
    case["phase"] = "export both continuous strokes"
    marks = (await placement_export(page, surface, source_hash))["marks"]
    assert len(marks) == 2 and all(mark["kind"] == tool and len(mark["points"]) > 2 for mark in marks), marks
    assert marks[0]["id"] != marks[1]["id"], marks
    if tool == "mosaic":
        assert all(mark.get("shape") == "brush" for mark in marks), marks
    case.update(consecutiveStrokes=True, secondStrokeNotConsumed=True, undoRedoPixels=True, exportedMarks=2)


async def placement_watermark_point(page, target):
    await placement_canvas_hash(page)
    point = await page.evaluate("""target => {
      const canvas=document.querySelector('canvas'), box=canvas.getBoundingClientRect();
      const editor=document.querySelector('textarea').getBoundingClientRect();
      const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      const original=__annotationToolsQa.placementBaseline;
      for(let y=30;y<canvas.height-30;y+=3) for(let x=30;x<canvas.width-30;x+=3) {
        const px=box.x+(x+.5)*box.width/canvas.width, py=box.y+(y+.5)*box.height/canvas.height;
        if(px>editor.left-60&&px<editor.right+60&&py>editor.top-60&&py<editor.bottom+60) continue;
        if(document.elementFromPoint(px,py)!==canvas) continue;
        const i=(y*canvas.width+x)*4;
        const difference=Math.max(...[0,1,2].map(c=>Math.abs(bytes[i+c]-original[i+c])));
        if(target==='tile' ? difference>=12 : difference===0) return {x:px,y:py,pixelDifference:difference};
      }
      return null;
    }""", target)
    assert point is not None, f"No visible watermark {target} target outside its native input"
    return point


async def placement_watermark_case(page, surface, target, source_hash, empty_hash, case):
    title = "Watermark (W)"
    await page.get_by_role("button", name=title, exact=True).click()
    await placement_input(page)
    await page.keyboard.type("Watermark first")
    assert await page.locator("textarea").input_value() == "Watermark first"
    point = await placement_watermark_point(page, target)
    case["targetPoint"] = point
    case["phase"] = f"click visible watermark {target} to finish"
    await page.mouse.click(point["x"], point["y"])
    await placement_finished(page, title, source_hash)
    first_pixels = await placement_canvas_hash(page)
    assert first_pixels != empty_hash
    case["phase"] = "second click reopens the same watermark content"
    await page.mouse.click(point["x"], point["y"])
    await placement_input(page, "Watermark first")
    await page.keyboard.press("End")
    await page.keyboard.type(" again")
    assert await page.locator("textarea").input_value() == "Watermark first again"
    finish = await placement_point(page, .12, .82)
    await page.mouse.click(finish["x"], finish["y"])
    await placement_finished(page, title, source_hash)
    second_pixels = await placement_canvas_hash(page)
    assert second_pixels != first_pixels
    await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == first_pixels
    await page.get_by_role("button", name="Undo (⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == empty_hash
    assert await page.get_by_role("button", name="Undo (⌘Z)", exact=True).is_disabled()
    await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == first_pixels
    await page.get_by_role("button", name="Redo (⇧⌘Z)", exact=True).click()
    assert await placement_canvas_hash(page) == second_pixels
    case["phase"] = "export exactly one reedited watermark"
    marks = (await placement_export(page, surface, source_hash))["marks"]
    assert len(marks) == 1 and marks[0]["kind"] == "watermark", marks
    assert marks[0]["text"] == "Watermark first again" and marks[0]["mode"] == "tiled", marks
    case.update(firstClickFinished=True, secondClickReusedContent=True, noDuplicateWatermark=True,
                deselected=True, activeToolRetained=True, undoRedoPixels=True, exportedMarks=1)


async def finish_before_placement_cases(browser, report):
    cases = [("text", "Text (T)", placement_text_case),
             ("label", "Label bubble (B)", placement_text_case),
             ("callout", "Numbered callout (N)", placement_text_case),
             ("rectangle", "Rectangle (R)", placement_shape_case),
             ("line", "Line (L)", placement_shape_case),
             ("arrow", "Arrow (A)", placement_shape_case),
             ("pen", "Pen (P)", placement_continuous_case),
             ("mosaic", "Mosaic (M)", placement_continuous_case)]
    for surface in ["editor", "overlay"]:
        for tool, title, run in cases + [("watermark", target, placement_watermark_case) for target in ["blank", "tile"]]:
            case = {"surface": surface, "tool": tool, "target": title, "passed": False, "phase": "setup"}
            report["finishBeforePlacement"].append(case)
            context, page, errors = None, None, []
            try:
                context, page, errors, source_hash, empty_hash = await placement_setup(browser, surface)
                if tool == "watermark":
                    await run(page, surface, title, source_hash, empty_hash, case)
                else:
                    await run(page, surface, tool, title, source_hash, empty_hash, case)
                assert not errors, errors
                case.update(passed=True, phase="complete", unchangedSourceSha256=source_hash,
                            exports=1, detachedBeforeExport=True)
            except Exception as error:
                case["failure"] = {"type": type(error).__name__, "message": str(error), "pageErrors": errors,
                    "ui": await page.evaluate("""() => ({inputs:[...document.querySelectorAll('textarea')].map(e=>({value:e.value,focused:document.activeElement===e})),
                      exports:__annotationToolsQa.exports.length,lastExportDocumentMarks:__annotationToolsQa.document.marks,
                      selected:[...document.querySelectorAll('button[aria-pressed=true]')].map(e=>e.ariaLabel||e.title||e.textContent)})""") if page else None}
                if page:
                    await page.screenshot(path=str(OUT / f"finish-placement-{surface}-{tool}-{title.split()[0]}-failure.png"))
                raise
            finally:
                if context:
                    await context.close()


async def verify():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"scope": "Actual product windows with isolated IPC; no native or IME claim", "editor": [], "overlay": [], "finishBeforePlacement": []}
    try:
        async with async_playwright() as runtime:
            browser = await runtime.chromium.launch(headless=True, executable_path=os.environ.get("CHROME_BIN", "/usr/bin/google-chrome"))
            page = await browser.new_page()
            await page.goto(URL)
            await page.locator("canvas").wait_for()
            report["mosaicPixels"] = await page.evaluate("__annotationToolsQa.mosaicPixels()")
            assert all(value == (255 if key == "edgeAlpha" else 0) for key, value in report["mosaicPixels"].items()), report["mosaicPixels"]
            report["watermarkPixels"] = await page.evaluate("__annotationToolsQa.watermarkPixels()")
            assert report["watermarkPixels"]["success"], report["watermarkPixels"]
            await page.close()
            await editor_cases(browser, report)
            await overlay_cases(browser, report)
            await existing_text_case(browser, report)
            await callout_pointer_case(browser, report)
            await anchored_label_case(browser, report)
            await finish_before_placement_cases(browser, report)
            await browser.close()
            report["passed"] = True
    finally:
        (OUT / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


def main():
    with tempfile.TemporaryFile(mode="w+") as log:
        server = subprocess.Popen(["pnpm", "exec", "vite", "--config", "scripts/qa/annotation-tools-harness.vite.ts"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                try:
                    urllib.request.urlopen(URL, timeout=1).close()
                    break
                except OSError:
                    import time
                    time.sleep(.1)
            else:
                raise RuntimeError("Isolated QA server did not start")
            asyncio.run(verify())
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    main()
