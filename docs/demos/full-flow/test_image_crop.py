"""Built editor crop/export regression, public pixels and isolated native IPC.

One headless browser, sequential contexts. No native GUI or user library access.
The fixture models Save As as export-only; close calls remain an IPC boundary,
so this does not establish native window/ACL or real IME acceptance.
"""
import asyncio
import io
import json
import os
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.async_api import async_playwright, expect
from record import Handler, MEDIA, OUT

ROOT = Path(__file__).resolve().parents[3]
PROJECT = {
    'schemaVersion': 1,
    'canvas': {'width': 500, 'height': 300},
    'sourcePixels': {'width': 1000, 'height': 600},
    'marks': [],
}


async def drag_image_document(page, image, start, end):
    """Prepare input against one stable, hit-tested image, before pressing."""
    for _ in range(5):
        # Tool changes can reflow the toolbar, then ResizeObserver updates fit.
        # Locator actionability waits for stable geometry and actual hit testing.
        await image.hover(trial=True)
        box = await image.bounding_box()
        if box is None or box['width'] <= 4 or box['height'] <= 4:
            raise AssertionError(f'Image has no usable pointer geometry: {box}')
        position = {
            # Stay inside edge handles instead of depending on fractional-edge
            # rounding; the drag destination still uses exact document pixels.
            'x': max(2, min(box['width'] - 2, start[0] * box['width'] / 500)),
            'y': max(2, min(box['height'] - 2, start[1] * box['height'] / 300)),
        }
        await image.hover(position=position)
        observed = await image.bounding_box()
        if observed == box:
            break
    else:
        raise AssertionError('Image pointer geometry did not settle before dragging')
    # Playwright 1.55 locator hover truncates its point to 0.01 CSS pixels.
    # Keep its hit/stability checks, then preserve document-coordinate precision
    # for the actual pointer-down (matching the direct mouse-move endpoint).
    await page.mouse.move(box['x'] + position['x'], box['y'] + position['y'])
    await page.mouse.down()
    try:
        await page.mouse.move(box['x'] + end[0] * box['width'] / 500,
                              box['y'] + end[1] * box['height'] / 300, steps=8)
    finally:
        await page.mouse.up()


async def main():
    picture = Image.new('RGB', (1000, 600), '#707b8d')
    drawing = ImageDraw.Draw(picture)
    for x in range(0, 1000, 100):
        drawing.line((x, 0, x, 600), fill='#8794a8')
    for y in range(0, 600, 100):
        drawing.line((0, y, 1000, y), fill='#8794a8')
    drawing.text((120, 100), 'PUBLIC CROP FIXTURE', fill='white')
    buffer = io.BytesIO()
    picture.save(buffer, format='PNG')
    MEDIA['crop-fixture'] = (buffer.getvalue(), 'image/png')
    before = os.environ.get('KIRI_CROP_BEFORE') == '1'
    results = []
    lifecycle = []
    server = ThreadingHTTPServer(('127.0.0.1', 8791), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/google-chrome'))
            try:
                for language in (['en'] if before else ['en', 'zh-Hans', 'ja']):
                    strings = json.loads((ROOT / 'src/i18n' / f'{language}.json').read_text())
                    for width, height in ([(800, 600)] if before else [(800, 600), (1280, 720)]):
                        for scale in ([1] if before else [1, 1.25, 1.5, 2]):
                            context = await browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=scale, locale=language)
                            case = {'language': language, 'viewport': [width, height], 'backingScale': scale, 'phase': 'loading', 'errors': [], 'events': []}
                            lifecycle.append(case)
                            try:
                                await context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(('http://127.0.0.1:8791/', 'blob:http://127.0.0.1:8791/', 'data:image/')) else r.abort())
                                page = await context.new_page()
                                page.set_default_timeout(8000)
                                errors, outputs = case['errors'], []
                                pending_outputs = asyncio.Queue()
                                print(f'Crop/export: {language} {width}x{height} backing={scale}', flush=True)
                                def trace(event, current=case, **details):
                                    current['events'].append({'event': event, 'time': time.monotonic(), 'phase': current['phase'], **details})

                                # Each callback belongs to this context, including events emitted
                                # during close; the next iteration must not inherit its errors.
                                page.on('pageerror', lambda error, captured=errors, record=trace: (captured.append(str(error)), record('pageerror', message=str(error))))
                                page.on('request', lambda request, record=trace: record('request', url=request.url) if request.resource_type == 'script' else None)
                                page.on('requestfinished', lambda request, record=trace: record('requestfinished', url=request.url) if request.resource_type == 'script' else None)
                                page.on('requestfailed', lambda request, record=trace: record('requestfailed', url=request.url, failure=request.failure))

                                async def backend(source, command, args, captured=outputs, pending=pending_outputs):
                                    assert command == 'editor_output', command
                                    data = bytes(args.pop('bytes'))
                                    with Image.open(io.BytesIO(data)) as png:
                                        args['pngSize'] = list(png.size)
                                    captured.append(args)
                                    pending.put_nowait(args)
                                    return {'revisionSha256': 'a' * 64 if args['action'] == 'save-as' else 'b' * 64, 'actionSucceeded': True}

                                await context.expose_binding('__backend', backend)
                                await page.goto('http://127.0.0.1:8791/desktop.html')
                                # The shell's invoke function exists before its lazy library
                                # module has loaded. Wait for that initial window before editor work.
                                await page.frame_locator('#library').get_by_role('button', name='设置', exact=True).wait_for()
                                case['phase'] = 'editing'
                                trace('fixture-ready')
                                await page.evaluate('''({language, project}) => {
                                    const original = window.invoke;
                                    window.invoke = async (kind, command, args) => {
                                        if (command === 'get_language' || command === 'get_locale') return language;
                                        if (command === 'get_asset_annotation_project') return {state:'valid', documentJson:JSON.stringify(project), revisionSha256:'a'.repeat(64)};
                                        if (command === 'prepare_asset_annotation') {state.cropPrepared = args; return 'isolated-crop';}
                                        if (command === 'save_file_dialog') return state.cancelSaveAs ? null : 'isolated-export';
                                        return original(kind, command, args);
                                    };
                                }''', {'language': language, 'project': PROJECT})

                                async def editor():
                                    await page.evaluate("frame('editor', {id:'crop-fixture'})")
                                    f = page.frame_locator('#editor')
                                    await f.locator('canvas').wait_for()
                                    await f.get_by_role('button',name=strings['Crop (C)'], exact=True).wait_for()
                                    await page.wait_for_timeout(80)
                                    await page.locator('#editor').evaluate('''el => {
                                        const internal = el.contentWindow.__TAURI_INTERNALS__, original = internal.invoke;
                                        internal.invoke = async (command, args, options) => {
                                            if (command === 'update_asset') return parent.__backend('editor_output', {
                                                bytes:Array.from(new Uint8Array(args)), action:options.headers['x-kiri-editor-action'],
                                                document:JSON.parse(parent.state.cropPrepared.documentJson), crop:parent.state.cropPrepared.cropPixels,
                                                revision:parent.state.cropPrepared.revisionSha256
                                            });
                                            return original(command, args, options);
                                        };
                                    }''')
                                    return f

                                async def drag_doc(f, start, end, cropping=False):
                                    if before:
                                        image = f.locator('canvas').first
                                        box = await image.bounding_box()
                                        def point(p):
                                            return box['x'] + p[0] * box['width'] / 500, box['y'] + p[1] * box['height'] / 300
                                        await page.mouse.move(*point(start))
                                        await page.mouse.down()
                                        await page.mouse.move(*point(end), steps=8)
                                        await page.mouse.up()
                                        return
                                    # Crop input belongs to the active overlay, not the canvas
                                    # underneath it. Both cover the full document, including
                                    # areas outside the raster canvas's visible viewport.
                                    image = (f.get_by_label(strings['Crop area'], exact=True) if cropping
                                             else f.locator('.annotation-canvas-root'))
                                    await drag_image_document(page, image, start, end)

                                async def crop(f):
                                    await f.get_by_role('button',name=strings['Crop (C)'], exact=True).click()
                                    if not before:
                                        assert await f.locator('.kiri-image-editor-properties').count() == 0, 'Crop controls must not cover its image handles'
                                    await drag_doc(f, (0, 0), (50, 40), cropping=True)
                                    if not before:
                                        await expect(f.get_by_label(strings['Crop area'], exact=True)).to_contain_text('900 × 520')
                                    await drag_doc(f, (499, 299), (350, 220), cropping=True)
                                    if not before:
                                        await expect(f.get_by_label(strings['Crop area'], exact=True)).to_contain_text('600 × 360')

                                async def output_size(index, expected):
                                    # PNG export is asynchronous and can exceed a fixed 120ms
                                    # on a loaded CI renderer. Await the actual IPC output.
                                    try:
                                        await asyncio.wait_for(pending_outputs.get(), timeout=8)
                                    except TimeoutError:
                                        await page.screenshot(path=str(OUT / 'crop-export-failed.png'))
                                        (OUT / 'crop-export-failure.json').write_text(json.dumps({'language':language, 'viewport':[width,height], 'backingScale':scale, 'errors':errors, 'editorText':await f.locator('body').inner_text()}, ensure_ascii=False, indent=2))
                                        raise
                                    assert outputs[index]['pngSize'] == expected, outputs[index]
                                    assert list(outputs[index]['document']['sourcePixels'].values()) == expected

                                f = await editor()
                                await crop(f)
                                rectangle = f.get_by_role('button',name=strings['Rectangle (R)'], exact=True)
                                if before:
                                    assert await rectangle.is_disabled(), 'baseline no longer reproduces Crop tool interlock'
                                    await page.screenshot(path=str(OUT / 'crop-interlock-before.png'))
                                    # The old export-only bug wrongly permits a clean close after Save As.
                                    f = await editor()
                                    await f.get_by_role('button',name=strings['Rectangle (R)'], exact=True).click()
                                    await drag_doc(f, (80, 60), (160, 110))
                                    await crop(f)
                                    await f.get_by_role('button', name=strings['Save As…'], exact=True).click()
                                    await page.wait_for_timeout(150)
                                    await f.get_by_role('button', name=strings['Cancel'], exact=True).click()
                                    await page.locator('#editor').wait_for(state='detached')
                                    await page.screenshot(path=str(OUT / 'save-as-close-before.png'))
                                    results.append({'language':language, 'viewport':[width,height], 'backingScale':scale, 'reproduced':['Crop disables other tools', 'export incorrectly clears library dirty state']})
                                    continue

                                assert await rectangle.is_enabled()
                                undo = f.get_by_role('button',name=strings['Undo'], exact=True)
                                redo = f.get_by_role('button',name=strings['Redo'], exact=True)
                                await undo.click()
                                await f.get_by_role('button', name=strings['Save As…'], exact=True).click()
                                await page.wait_for_timeout(120)
                                await output_size(-1, [900, 520])
                                await redo.click()
                                await rectangle.focus()
                                await rectangle.press('Enter')
                                # Optional annotation properties float over the image.
                                # Use their real close action before drawing underneath.
                                await f.get_by_role('button', name=strings['Hide tool options'], exact=True).click()
                                await drag_doc(f, (80, 60), (160, 110))
                                await undo.click()
                                await redo.click()
                                if language == 'en' and width == 800 and scale == 1:
                                    # The wrapped toolbar keeps both crop and annotation actions
                                    # visible without scrolling to find either control.
                                    assert await f.get_by_role('button',name=strings['Crop (C)'], exact=True).is_visible()
                                    assert await rectangle.is_visible()
                                    await page.screenshot(path=str(OUT / 'crop-annotate-after.png'))
                                await f.get_by_role('button',name=strings['Crop (C)'], exact=True).click()
                                await undo.click()
                                await redo.click()
                                # Cancelling export cannot drop the pending crop or its history.
                                await page.evaluate('state.cancelSaveAs = true')
                                count = len(outputs)
                                await f.get_by_role('button', name=strings['Save As…'], exact=True).click()
                                await page.wait_for_timeout(100)
                                assert len(outputs) == count
                                await page.evaluate('state.cancelSaveAs = false')
                                await f.get_by_role('button', name=strings['Save As…'], exact=True).press('Enter')
                                await page.wait_for_timeout(120)
                                await output_size(-1, [600, 360])
                                assert outputs[-1]['action'] == 'save-as', outputs[-1]
                                assert outputs[-1]['crop'] == {'x':100, 'y':80, 'width':600, 'height':360}, outputs[-1]
                                mark = outputs[-1]['document']['marks'][0]
                                expected_mark = {'x':30, 'y':20, 'width':80, 'height':50}
                                assert all(abs(mark['rect'][key] - value) < 0.0001 for key, value in expected_mark.items()), mark
                                await f.get_by_role('button', name=strings['Cancel (Esc)'], exact=True).click()
                                dialog = f.get_by_role('dialog', name=strings['Save changes before closing?'], exact=True)
                                await dialog.wait_for()
                                if language == 'en' and width == 800 and scale == 1:
                                    await page.screenshot(path=str(OUT / 'save-as-close-after.png'))
                                await dialog.get_by_role('button', name=strings['Keep editing'], exact=True).click()
                                await rectangle.click()
                                await f.get_by_role('button', name=strings['Cancel crop'], exact=True).press('Enter')
                                await f.locator(f'[aria-label="{strings["Crop area"]}"]').wait_for(state='detached')
                                await f.get_by_role('button', name=strings['Save As…'], exact=True).click()
                                await page.wait_for_timeout(120)
                                await output_size(-1, [1000, 600])
                                assert outputs[-1]['crop'] is None
                                expected_original = {'x':80, 'y':60, 'width':80, 'height':50}
                                actual_original = outputs[-1]['document']['marks'][0]['rect']
                                assert all(abs(actual_original[key] - value) < 0.0001 for key, value in expected_original.items()), actual_original
                                # Escape cancels only a pending crop; annotation and its redo survive.
                                await crop(f)
                                await page.keyboard.press('Escape')
                                await f.locator(f'[aria-label="{strings["Crop area"]}"]').wait_for(state='detached')
                                await crop(f)
                                await rectangle.click()
                                await f.get_by_role('button', name=strings['Save'], exact=True).click()
                                await page.locator('#editor').wait_for(state='detached')
                                await output_size(-1, [600, 360])
                                assert outputs[-1]['action'] == 'save'
                                assert not errors, errors
                                results.append({'language':language, 'viewport':[width,height], 'backingScale':scale, 'savedPixels':[600,360], 'passed':['crop tool switching with focused-button Enter', 'crop undo/redo across tool switch', 'independent annotation undo/redo', 'export-only close guard', 'keyboard Save As exports without library Save', 'cancelled export keeps crop', 'keyboard cancel crop retains original-coordinate marks', 'Escape cancels crop only', 'source-pixel mapping and translated marks', 'final Save PNG dimensions']})
                            finally:
                                case['phase'] = 'closing'
                                await context.close()
                                case['phase'] = 'closed'
                                (OUT / 'crop-lifecycle.json').write_text(json.dumps(lifecycle, ensure_ascii=False, indent=2) + '\n')
            finally:
                await browser.close()
                (OUT / 'crop-lifecycle.json').write_text(json.dumps(lifecycle, ensure_ascii=False, indent=2) + '\n')
            assert not [case for case in lifecycle if case['errors']], lifecycle
    finally:
        server.shutdown()
        server.server_close()
    (OUT / ('image-crop-before.json' if before else 'image-crop-check.json')).write_text(json.dumps({
        'native':False, 'sourceCommit':os.environ.get('KIRI_SOURCE_COMMIT'),
        'closeBoundary':'isolated IPC only; native destroy ACL unresolved',
        'coordinateSpaces':{'document':[500,300], 'sourcePixels':[1000,600]},
        'cases':results,
    }, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    asyncio.run(main())
