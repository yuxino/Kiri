"""Built screenshot gestures and completion cards with isolated IPC and images.

This proves renderer behavior, not native capture, focus, or window levels.
"""
import asyncio
import io
import json
import os
import threading
from http.server import ThreadingHTTPServer

from PIL import Image
from playwright.async_api import async_playwright
from record import Handler, MEDIA, OUT


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 8791), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(executable_path=os.environ.get('CHROME_BIN', '/usr/bin/google-chrome'))
            try:
                context = await browser.new_context(viewport={'width': 1280, 'height': 720}, locale='en-US')
                await context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(
                    ('http://127.0.0.1:8791/', 'blob:http://127.0.0.1:8791/', 'data:image/')) else r.abort())
                page = await context.new_page()
                page.set_default_timeout(8000)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))

                async def backend(source, command, args):
                    if command == 'freeze':
                        image = io.BytesIO()
                        Image.new('RGB', (1280, 720), '#c8c8c8').save(image, format='PNG')
                        MEDIA['frozen'] = (image.getvalue(), 'image/png')
                    elif command == 'save_png':
                        data = bytes(args['bytes'])
                        Image.open(io.BytesIO(data)).verify()
                        MEDIA[args['id']] = MEDIA['thumb-' + args['id']] = (data, 'image/png')
                    else:
                        raise AssertionError(command)

                await context.expose_binding('__backend', backend)
                await page.goto('http://127.0.0.1:8791/desktop.html')
                await page.wait_for_function('typeof window.invoke === "function"')
                await page.evaluate('''() => {
                    const original = window.invoke;
                    state.language = 'en'; state.pinCalls = [];
                    window.invoke = async (kind, command, args) => {
                        if (command === 'get_language' || command === 'get_locale') return state.language;
                        if (command === 'pin_asset') {
                            state.pinCalls.push(args.id);
                            if (state.pinFails) throw 'Could not pin this screenshot.';
                            return null;
                        }
                        return original(kind, command, args);
                    };
                }''')

                async def confirms():
                    return await page.evaluate("state.calls.filter(x => x.c === 'confirm_capture').length")

                async def capture(mode='Screenshot'):
                    await page.evaluate('launchCapture()')
                    frame = page.frame_locator('#overlay')
                    await frame.locator('img').first.evaluate('(image) => image.decode()')
                    if mode != 'Screenshot':
                        await frame.get_by_role('button', name=mode, exact=True).click()
                    return frame

                async def drag(start, end):
                    await page.mouse.move(*start)
                    await page.mouse.down()
                    await page.mouse.move(*end, steps=12)
                    await page.mouse.up()

                async def cancel():
                    await page.keyboard.press('Escape')
                    await page.locator('#overlay').wait_for(state='detached')

                # A window double-click selects on the first click and finishes once.
                await capture()
                await page.mouse.dblclick(400, 250)
                await page.locator('#overlay').wait_for(state='detached')
                assert await confirms() == 1
                assert await page.evaluate('state.pendingAnnotation.selection') == {
                    'x': 170, 'y': 76, 'width': 940, 'height': 570}

                # Completion pin uses the saved asset, preserves failures, and fits all languages.
                for language, title in [('en', 'Pin Screenshot on Top'), ('zh-Hans', '置顶截图'),
                                        ('ja', 'スクリーンショットを最前面に固定')]:
                    await page.evaluate('''language => {
                        state.language = language; state.pinFails = true;
                        toast(state.assets[0]);
                    }''', language)
                    toast = page.frame_locator('#toast')
                    pin = toast.get_by_role('button', name=title, exact=True)
                    await pin.click()
                    await toast.get_by_text({'en': 'Could not pin this screenshot.',
                        'zh-Hans': '无法置顶这张截图。', 'ja': 'このスクリーンショットを固定できませんでした。'}[language], exact=True).wait_for()
                    assert await toast.locator('.kiri-completion-actions').evaluate('''row =>
                        row.scrollWidth <= row.clientWidth && [...row.children].every(button =>
                            button.scrollWidth <= button.clientWidth && button.getBoundingClientRect().right <= row.getBoundingClientRect().right)''')
                    await page.screenshot(path=str(OUT / ('completion-pin-' + language + '.png')))
                    await page.evaluate('state.pinFails = false')
                    await page.wait_for_timeout(500)  # Completion actions share a 450 ms cooldown.
                    await pin.click()
                    await page.locator('#toast').wait_for(state='detached')
                assert await page.evaluate('state.pinCalls.every(id => id === state.assets[0].id)')
                await page.evaluate("state.language = 'en'")

                frame = await capture()
                await drag((200, 160), (1050, 570))
                await page.mouse.dblclick(70, 60)  # Outside selection.
                await page.mouse.dblclick(200, 160)  # Resize handle.
                await frame.get_by_title('Rectangle (R)', exact=True).dblclick()  # Toolbar.
                assert await confirms() == 1
                await drag((300, 240), (500, 330))
                await frame.get_by_title('Select (V)', exact=True).click()
                await page.mouse.dblclick(300, 270)  # Existing annotation.
                assert await confirms() == 1
                await frame.get_by_title('Text (T)', exact=True).click()
                await page.mouse.click(650, 300)
                text = frame.get_by_role('textbox', name='Text content', exact=True)
                await text.fill('editable reference')
                await page.mouse.click(950, 470)  # Commit without confirming.
                await frame.get_by_title('Select (V)', exact=True).click()
                await page.mouse.dblclick(680, 315)
                await text.wait_for()
                assert await text.input_value() == 'editable reference'
                assert await confirms() == 1
                await page.mouse.dblclick(950, 470)  # First click leaves a text edit.
                assert await confirms() == 1
                await page.mouse.dblclick(850, 420)  # Unmarked Select canvas.
                await page.locator('#overlay').wait_for(state='detached')
                assert await confirms() == 2

                frame = await capture()
                await drag((200, 160), (1050, 570))
                await frame.get_by_title('Pen (P)', exact=True).click()
                await page.mouse.dblclick(750, 400)
                assert await confirms() == 2
                await cancel()
                for mode in ['Record', 'OCR']:
                    await capture(mode)
                    await page.mouse.dblclick(400, 250)
                    assert await confirms() == 2
                    assert await page.evaluate("state.calls.filter(x => x.c === 'start_recording_flow').length") == 0
                    await cancel()

                # Saved-image re-editing shares the canvas but no completion callback.
                image = io.BytesIO()
                Image.new('RGB', (1000, 600), '#cccccc').save(image, format='PNG')
                MEDIA['editor-second-edit'] = (image.getvalue(), 'image/png')
                await page.evaluate('''() => {
                    const original = window.invoke;
                    state.editorProject = {schemaVersion: 1,
                        canvas: {width: 1000, height: 600},
                        sourcePixels: {width: 1000, height: 600}, marks: [
                        {kind: 'text', id: 501, text: 'saved text',
                         rect: {x: 200, y: 150, width: 200, height: 40},
                         color: 'cherry', background: 'transparent', fontSize: 24},
                        {kind: 'rectangle', id: 502,
                         rect: {x: 500, y: 130, width: 180, height: 140},
                         color: 'cherry', width: 3}]};
                    state.editorSaveCalls = 0;
                    state.editorRevision = 'a'.repeat(64);
                    state.editorCloseEvents = true;
                    state.editorDestroyCalls = 0;
                    window.invoke = async (kind, command, args) => {
                        if (command === 'get_asset_annotation_project' && args.id === 'editor-second-edit') {
                            return {state: 'valid', documentJson: JSON.stringify(state.editorProject),
                                revisionSha256: state.editorRevision};
                        }
                        if (command === 'prepare_asset_annotation') {
                            state.editorPrepared = JSON.parse(args.documentJson);
                            return 'fixture-editor-update';
                        }
                        if (command === 'update_asset') {
                            state.editorSaveCalls++;
                            state.editorProject = structuredClone(state.editorPrepared);
                            state.editorRevision = 'b'.repeat(64);
                            return {revisionSha256: state.editorRevision, actionSucceeded: true};
                        }
                        return original(kind, command, args);
                    };
                }''')

                async def saved_editor():
                    await page.evaluate("showSubject(); frame('editor', {id: 'editor-second-edit'})")
                    editor = page.frame_locator('#editor')
                    await editor.locator('canvas').wait_for()
                    await editor.locator('canvas').evaluate('''() => new Promise(resolve =>
                        requestAnimationFrame(() => requestAnimationFrame(resolve)))''')
                    box = await editor.locator('canvas').bounding_box()
                    assert box
                    def point(x, y):
                        return box['x'] + x * box['width'] / 1000, box['y'] + y * box['height'] / 600
                    return editor, point

                editor, point = await saved_editor()
                await page.mouse.dblclick(*point(850, 470))
                await page.mouse.dblclick(*point(550, 190))
                assert await page.evaluate('state.editorSaveCalls') == 0
                assert await page.locator('#editor').count() == 1
                await page.mouse.dblclick(*point(240, 170))
                text = editor.get_by_role('textbox', name='Text content', exact=True)
                await text.wait_for()
                assert await text.input_value() == 'saved text'
                await text.fill('edited saved text')
                await text.press('Enter')
                await text.wait_for(state='detached')
                assert await page.locator('#editor').count() == 1
                assert await page.evaluate('state.editorSaveCalls') == 0
                await page.mouse.dblclick(*point(850, 470))
                assert await page.locator('#editor').count() == 1
                assert await page.evaluate('state.editorSaveCalls') == 0
                await editor.get_by_role('button', name='Cancel', exact=True).click()
                dialog = editor.get_by_role('dialog', name='Save changes before closing?', exact=True)
                await dialog.wait_for()
                await dialog.get_by_role('button', name='Keep editing', exact=True).click()
                await editor.get_by_role('button', name='Save', exact=True).click()
                await page.locator('#editor').wait_for(state='detached')
                assert await page.evaluate('state.editorSaveCalls') == 1
                assert await page.evaluate('state.editorProject.marks.map(mark => mark.id)') == [501, 502]
                editor, point = await saved_editor()
                await page.mouse.dblclick(*point(240, 170))
                text = editor.get_by_role('textbox', name='Text content', exact=True)
                await text.wait_for()
                assert await text.input_value() == 'edited saved text'
                await text.press('Escape')
                await text.wait_for(state='detached')
                await editor.get_by_role('button', name='Cancel', exact=True).click()
                await page.locator('#editor').wait_for(state='detached')
                assert await page.evaluate('state.editorSaveCalls') == 1
                assert await confirms() == 2
                assert not errors, errors
                (OUT / 'quick-capture-check.json').write_text(json.dumps({
                    'native': False, 'passed': ['window double-click confirms once',
                    'completion pins saved asset', 'pin error and retry', 'three-language action layout',
                    'outside/handle/toolbar/annotation guards', 'text double-click edits',
                    'editing gesture does not confirm', 'Select blank canvas confirms',
                    'drawing tools do not confirm', 'OCR and recording guards',
                    'saved editor blank/shape double-click does not save or close',
                    'saved text double-click edits without capture completion',
                    'text Enter leaves saved editor open', 'saved editor dirty-close guard',
                    'explicit save preserves annotation IDs and reopens edited text']}, indent=2) + '\n')
                await context.close()
            finally:
                await browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    asyncio.run(main())
