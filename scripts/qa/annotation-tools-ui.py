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
    """Tool/action row never paints outside its fixed layout box."""
    result = await page.evaluate("""() => {
      const bar=document.querySelector('.kiri-image-editor-toolbar');
      const r=bar.getBoundingClientRect();
      return [...bar.querySelectorAll('button')].map(b=>{
        const q=b.getBoundingClientRect();return {title:b.title||b.textContent,
          visible:q.width>0&&q.height>0,inside:q.left>=-1&&q.right<=innerWidth+1&&
            q.top>=r.top-1&&q.bottom<=r.bottom+1};
      });
    }""")
    assert all(row["visible"] and row["inside"] for row in result), result


async def editor_cases(browser, report):
    for language in LANGUAGES:
        dictionary = json.loads((ROOT / "src/i18n" / f"{language}.json").read_text())
        for width in [320, 560, 1200]:
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
                await page.get_by_role("button", name=dictionary["Single"], exact=True).click()
                assert await editor.input_value() == "Watermark abcdef"
                await page.locator('input[type=number][aria-label="' + dictionary["Opacity"] + '"]').fill("55")
                await page.locator('input[type=number][aria-label="' + dictionary["Opacity"] + '"]').press("Enter")
                await page.get_by_role("button", name=dictionary["Select (V)"], exact=True).click()
                assert await rect(page, "canvas") == before
                await page.get_by_role("button", name=dictionary["Save As…"], exact=True).click()
                await page.wait_for_function("__annotationToolsQa.exports.length===1")
                mark = await page.evaluate("__annotationToolsQa.document.marks[0]")
                assert mark["kind"] == "watermark" and mark["text"] == "Watermark abcdef", mark
                assert mark["mode"] == "single" and mark["opacity"] == .55, mark
                assert not errors, errors
                if width == 320:
                    await page.screenshot(path=str(OUT / f"editor-{language}-320.png"))
                report["editor"].append({"language": language, "width": width, "passed": True})
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


async def verify():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"scope": "Actual product windows with isolated IPC; no native or IME claim", "editor": [], "overlay": []}
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
