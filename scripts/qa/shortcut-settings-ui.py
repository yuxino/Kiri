"""Real settings DOM regression, isolated from native shortcuts and user data.

Uses the same pinned Python Playwright runtime as the existing renderer QA.
Platform labels/UA and CSS zoom are layout fixtures, not native DPI acceptance.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import platform as host_platform
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
LANGUAGES = ["en", "zh-Hans", "zh-Hant", "ja", "de", "ko", "fr"]
AGENTS = {
    "macos": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    "windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    "linux": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
}
GEOMETRY = r"""() => {
  const panel=document.querySelector('.kiri-settings-panel'), content=document.querySelector('.kiri-settings__content');
  // WebKit 26 reports pre-zoom client rects, while Chromium reports painted
  // rects. elementFromPoint and the screenshot viewport use painted pixels in
  // both. A fixed-width real control measures this difference without using an
  // engine name or weakening the clipping/hit-target assertions.
  const probe=document.querySelector('.kiri-shortcut-reset-slot')||content;
  const zoom=Number(getComputedStyle(document.body).zoom)||1;
  const reportedScale=probe.getBoundingClientRect().width/probe.offsetWidth;
  const coordinateScale=zoom/reportedScale;
  const painted=r=>({x:r.x*coordinateScale,y:r.y*coordinateScale,width:r.width*coordinateScale,
    height:r.height*coordinateScale,right:r.right*coordinateScale,bottom:r.bottom*coordinateScale});
  const rect = e => painted(e.getBoundingClientRect());
  const failures=[], internalMetrics=[], focusMetrics=[];
  const within=(r,b)=>r.x>=b.x-1&&r.right<=b.right+1&&r.y>=b.y-1&&r.bottom<=b.bottom+1;
  const visible=e=>getComputedStyle(e).visibility!=='hidden'&&e.getClientRects().length>0;
  const checkText=(e,outer,label)=>{
    if(!visible(e))return;
    const range=document.createRange();range.selectNodeContents(e);
    for(const r of range.getClientRects())if(!within(painted(r),rect(outer)))failures.push(label+' clips: '+e.textContent);
  };
  if(document.documentElement.scrollWidth>innerWidth+1)failures.push('document horizontal overflow');
  if(panel.scrollWidth>panel.clientWidth+1)failures.push('settings horizontal overflow');
  const instruction=document.querySelector('.kiri-shortcut-instruction');
  if(instruction)for(const hint of instruction.querySelectorAll('p'))checkText(hint,instruction,'recording instruction');
  const rows=[...document.querySelectorAll('.kiri-global-shortcut')].map(row=>{
    const r=rect(row), title=row.querySelector('.kiri-global-shortcut__copy strong');
    checkText(title,title.parentElement,'action title');
    for(const e of row.querySelectorAll('.kiri-shortcut-field,.kiri-shortcut-recorder,.kiri-shortcut-clear,.kiri-shortcut-cancel,.kiri-shortcut-feedback,.kiri-shortcut-reset,.kiri-shortcut-retry,.kiri-shortcut-apply,.kiri-shortcut-command')){
      if(visible(e)&&!within(rect(e),r))failures.push(row.dataset.action+' control leaves row: '+e.className);
    }
    const chord=row.querySelector('.kiri-shortcut-chord'), recorder=row.querySelector('.kiri-shortcut-recorder');
    if(chord&&visible(chord)){
      const range=document.createRange();range.selectNodeContents(chord);
      if(range.getClientRects().length!==1)failures.push(row.dataset.action+' chord wraps');
      checkText(chord,recorder,'shortcut text');
      const content=rect(recorder),style=getComputedStyle(recorder);
      content.x+=(parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth))*zoom;
      content.right-=(parseFloat(style.paddingRight)+parseFloat(style.borderRightWidth))*zoom;
      for(const r of range.getClientRects())if(painted(r).x<content.x-1||painted(r).right>content.right+1)
        failures.push(row.dataset.action+' shortcut text invades recorder padding');
    }
    for(const e of row.querySelectorAll('.kiri-shortcut-listening,.kiri-shortcut-unset'))checkText(e,recorder,'shortcut instruction');
    for(const e of row.querySelectorAll('.kiri-shortcut-feedback p'))checkText(e,row,'feedback');
    const command=row.querySelector('.kiri-shortcut-command');
    if(command)checkText(command,row,'Wayland command');
    const trailing=row.querySelector('.kiri-shortcut-clear,.kiri-shortcut-cancel');
    if(recorder&&trailing&&rect(recorder).right>rect(trailing).x+1)failures.push(row.dataset.action+' recorder overlaps field action');
    const field=row.querySelector('.kiri-shortcut-field');
    if(field){
      for(const inner of [field,...field.querySelectorAll('*')]){
        if(!(inner instanceof HTMLElement)||!visible(inner))continue;
        const metric={action:row.dataset.action,element:inner.className,clientWidth:inner.clientWidth,scrollWidth:inner.scrollWidth,
          clientHeight:inner.clientHeight,scrollHeight:inner.scrollHeight};
        internalMetrics.push(metric);
        // Inline text has no client box; its painted Range is checked above.
        if(inner.clientWidth>0&&inner.scrollWidth>inner.clientWidth+1)failures.push(row.dataset.action+' internal horizontal overflow: '+inner.className);
        if(inner.clientHeight>0&&inner.scrollHeight>inner.clientHeight+1)failures.push(row.dataset.action+' internal vertical overflow: '+inner.className);
      }
      const focused=[...row.querySelectorAll('button:focus-visible')];
      const focusTargets=focused.some(button=>field.contains(button))?[field,...focused]:focused;
      for(const target of focusTargets){
        const style=getComputedStyle(target),width=parseFloat(style.outlineWidth)||0;
        focusMetrics.push({action:row.dataset.action,element:target.className,outlineStyle:style.outlineStyle,
          outlineWidth:style.outlineWidth,outlineOffset:style.outlineOffset,shadow:style.boxShadow,border:style.borderColor,bounds:rect(target)});
        const outlineBleed=style.outlineStyle==='none'?0:Math.max(0,width+(parseFloat(style.outlineOffset)||0));
        const bleed={left:outlineBleed,right:outlineBleed,top:outlineBleed,bottom:outlineBleed};
        // Focus may be painted by a solid box-shadow instead of outline.
        // Parse lengths after colors so RGB channels cannot become geometry.
        for(const shadow of style.boxShadow.replace(/[a-z-]+\([^)]*\)/gi,'').split(',')){
          if(shadow.includes('inset'))continue;
          const lengths=(shadow.match(/-?[\d.]+px/g)||[]).map(parseFloat);
          if(lengths.length<2)continue;
          const [x,y,blur=0,spread=0]=lengths,extent=blur*1.5+spread;
          bleed.left=Math.max(bleed.left,extent-x);bleed.right=Math.max(bleed.right,extent+x);
          bleed.top=Math.max(bleed.top,extent-y);bleed.bottom=Math.max(bleed.bottom,extent+y);
        }
        // An inset ring must not hide a partially clipped focused button.
        // Always check the button bounds, even when there is no outer ink.
        const b=rect(target),outline={x:b.x-bleed.left*zoom,y:b.y-bleed.top*zoom,
          right:b.right+bleed.right*zoom,bottom:b.bottom+bleed.bottom*zoom};
        for(let ancestor=target.parentElement;ancestor;ancestor=ancestor.parentElement){
          const clipStyle=getComputedStyle(ancestor),r=rect(ancestor);
          const clip={x:r.x+ancestor.clientLeft*zoom,y:r.y+ancestor.clientTop*zoom};
          clip.right=clip.x+ancestor.clientWidth*zoom;clip.bottom=clip.y+ancestor.clientHeight*zoom;
          const clippedX=clipStyle.overflowX!=='visible'&&(outline.x<clip.x-1||outline.right>clip.right+1);
          const clippedY=clipStyle.overflowY!=='visible'&&(outline.y<clip.y-1||outline.bottom>clip.bottom+1);
          if(clippedX||clippedY)failures.push(row.dataset.action+' keyboard focus indicator is clipped by '+ancestor.className+': '+target.className);
        }
      }
    }
    for(const button of row.querySelectorAll('button')){
      const q=rect(button), p=rect(panel);
      // A button's center can land exactly on the viewport's excluded bottom
      // edge while part of it remains visible. Hit-test inside the visible
      // intersection, including buttons whose center is below the fold.
      const left=Math.max(q.x,p.x,0),right=Math.min(q.right,p.right,innerWidth);
      const top=Math.max(q.y,p.y,0),bottom=Math.min(q.bottom,p.bottom,innerHeight);
      const x=(left+right)/2,y=(top+bottom)/2;
      if(visible(button)&&right>left&&bottom>top&&
        document.elementFromPoint(x,y)?.closest('button')!==button)failures.push(row.dataset.action+' button is covered: '+button.className);
    }
    const controls=row.querySelector('.kiri-global-shortcut__controls');
    return {action:row.dataset.action,...r,controls:controls?rect(controls):null};
  });
  for(const [i,row] of rows.entries())for(const other of rows.slice(i+1))
    if(row.x<other.right-1&&row.right>other.x+1&&row.y<other.bottom-1&&row.bottom>other.y+1)failures.push('action rows overlap');
  const controls=rows.map(row=>row.controls).filter(Boolean);
  if(controls.some(c=>Math.abs(c.x-controls[0].x)>1||Math.abs(c.width-controls[0].width)>1))failures.push('Shortcut controls do not share a column');
  if(document.querySelector('.kiri-shortcut-more,.kiri-shortcut-editor,[role=menu]'))failures.push('Obsolete shortcut menu/editor remains');
  const groups=[...document.querySelectorAll('[data-shortcut-scope]')].map(rect);
  const groupContainer=document.querySelector('.kiri-shortcut-action-groups');
  const reference=document.querySelector('.kiri-shortcut-reference');
  const tab=document.querySelector('.kiri-settings-tabs');
  return {failures,internalMetrics,focusMetrics,rows,groups,availableWidth:groupContainer?.clientWidth,content:rect(content),panel:rect(panel),
    reference:rect(reference),tabs:rect(tab),scrollTop:panel.scrollTop,
    title:rect(document.querySelector('.library-control-panel__title')),
    sidebar:rect(document.querySelector('.library-sidebar')),
    coordinateScale,viewport:{width:innerWidth,height:innerHeight}};
}"""


async def geometry(page, state, checks, baseline=False):
    data = await page.evaluate(GEOMETRY)
    assert not data["failures"], {"state": state, **data}
    assert len(data["rows"]) == 6, data
    assert abs(data["title"]["x"] - data["content"]["x"]) <= 1, "Page title and settings content must align"
    if baseline:
        first, second = data["groups"]
        assert first["bottom"] <= second["y"], data
        assert abs(first["x"] - second["x"]) <= 1, data
        # At the default/roomier logical window, reference groups belong on the
        # first screen. Zoomed and minimum-height layouts may scroll normally.
        zoom = await page.evaluate("Number(new URLSearchParams(location.search).get('zoom')||1)")
        managed = await page.locator(".kiri-portal-shortcuts").count() > 0
        if not managed and data["viewport"]["width"] >= 960 and data["viewport"]["height"] >= 640 and zoom == 1:
            assert data["reference"]["y"] + 60 < data["panel"]["bottom"], data
        checks.append({"state": state, "columns": 1, "availableWidth": data["availableWidth"],
                       "referenceTop": data["reference"]["y"], "sidebarWidth": data["sidebar"]["width"]})
    else:
        checks.append({"state": state, "passed": True, "focus": data["focusMetrics"],
                       "internalDimensions": data["internalMetrics"] if data["focusMetrics"] else []})
    return data


def unchanged_layout(before, after, state):
    # Recording a shortcut must not move any row or the following reference
    # section. Include scroll position so a focus-induced jump cannot hide it.
    assert abs(before["scrollTop"] - after["scrollTop"]) <= 1, state + ": scroll moved"
    assert abs(before["reference"]["y"] - after["reference"]["y"]) <= 1, state + ": reference moved"
    for old, new in zip(before["rows"], after["rows"]):
        assert old["action"] == new["action"]
        assert all(abs(old[key] - new[key]) <= 1 for key in ["x", "y", "width", "height"]), {"state": state, "before": old, "after": new}


async def editable_cases(page, checks, evidence_prefix=None):
    async def screenshot(state):
        if evidence_prefix:
            await page.screenshot(path=str(evidence_prefix) + f"-{state}.png")

    row = page.locator('[data-action="recordingPauseResume"]')
    recorder = row.locator('.kiri-shortcut-recorder')
    original = await row.locator('.kiri-shortcut-chord').inner_text()
    idle_hint = page.locator('.kiri-shortcut-instruction__idle')
    recording_hint = page.locator('.kiri-shortcut-instruction__recording')
    await expect(idle_hint).to_have_attribute("aria-hidden", "false")
    await expect(idle_hint).to_be_visible()
    await expect(recording_hint).to_have_attribute("aria-hidden", "true")
    await expect(recording_hint).to_be_hidden()
    await expect(page.locator('.kiri-shortcut-reset')).to_have_count(0)
    await expect(page.locator('.kiri-shortcut-clear')).to_have_count(6)
    await recorder.scroll_into_view_if_needed()
    before = await geometry(page, "before-editing", checks)
    await row.locator('.kiri-shortcut-clear').focus()
    await page.keyboard.press("Shift+Tab")
    await expect(recorder).to_be_focused()
    assert await recorder.evaluate("e=>e.matches(':focus-visible')")
    await geometry(page, "keyboard-recorder-focus", checks)
    await page.keyboard.press("Enter")
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await expect(recorder).to_be_focused()
    await expect(row.locator('.kiri-shortcut-listening')).to_be_visible()
    await expect(row.locator('.kiri-shortcut-caret')).to_have_count(0)
    assert await page.evaluate("__shortcutSettingsQa.snapshot().find(s=>s.action==='recordingPauseResume').label") == original
    await expect(row.locator('.kiri-shortcut-cancel')).to_be_visible()
    await expect(idle_hint).to_have_attribute("aria-hidden", "true")
    await expect(idle_hint).to_be_hidden()
    await expect(recording_hint).to_have_attribute("aria-hidden", "false")
    await expect(recording_hint).to_be_visible()
    unchanged_layout(before, await geometry(page, "editing", checks), "editing")
    # A mouse click alone does not enable WebKit's :focus-visible. Enter the
    # recorder using the keyboard: the former 3px outline was clipped by the
    # field and appeared as a vertical scrollbar beside Esc.
    assert await recorder.evaluate("e=>e.matches(':focus-visible')"), "Keyboard recording must use the focus-visible state"
    unchanged_layout(before, await geometry(page, "keyboard-editing", checks), "keyboard-editing")
    await screenshot("editing")
    await page.keyboard.press("Escape")
    await expect(recorder).to_have_attribute("aria-pressed", "false")
    await expect(row.locator('.kiri-shortcut-cancel')).to_have_count(0)
    await page.wait_for_function("!__shortcutSettingsQa.editing")
    unchanged_layout(before, await geometry(page, "cancelled", checks), "cancelled")
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await row.locator('.kiri-shortcut-cancel').click()
    await expect(recorder).to_have_attribute("aria-pressed", "false")
    await page.wait_for_function("!__shortcutSettingsQa.editing")
    await expect(row.locator(".kiri-shortcut-chord")).to_have_text(original)
    assert await page.evaluate("__shortcutSettingsQa.calls.length") == 0, "Cancelling must not clear or mutate the binding"
    unchanged_layout(before, await geometry(page, "cancel-button", checks), "cancel-button")
    # Typing/navigation keys require a deliberate confirmation and must leave
    # the saved binding untouched while their candidate is displayed.
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.keyboard.press("a")
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text("A")
    await expect(row.locator('.kiri-shortcut-apply')).to_be_visible()
    assert await page.evaluate("__shortcutSettingsQa.calls.length") == 0
    assert await page.evaluate("__shortcutSettingsQa.snapshot().find(s=>s.action==='recordingPauseResume').label") == original
    assert await recorder.evaluate("e=>e.matches(':focus-visible')")
    await geometry(page, "plain-key-candidate", checks)
    await screenshot("pending")
    await page.keyboard.press("Tab")
    await expect(row.locator('.kiri-shortcut-cancel')).to_be_focused()
    await geometry(page, "keyboard-cancel-focus", checks)
    await page.keyboard.press("Tab")
    await expect(row.locator('.kiri-shortcut-apply')).to_be_focused()
    await expect(row.locator('.kiri-shortcut-apply')).to_be_in_viewport()
    await geometry(page, "keyboard-confirm-focus", checks)
    await screenshot("confirm-focus")
    await page.keyboard.press("Escape")
    await expect(recorder).to_have_attribute("aria-pressed", "false")
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text(original)
    assert await page.evaluate("__shortcutSettingsQa.calls.length") == 0
    # Keyboard focus can legitimately scroll the confirmation button into view
    # in a short window. Compare the next edit/cancel with that current layout,
    # not with the scroll position before the user tabbed to confirmation.
    before_navigation_edit = await geometry(page, "before-navigation-editing", checks)
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.keyboard.press("ArrowRight")
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text("→")
    await expect(row.locator('.kiri-shortcut-apply')).to_be_visible()
    await geometry(page, "navigation-key-candidate", checks)
    await row.locator('.kiri-shortcut-cancel').click()
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text(original)
    assert await page.evaluate("__shortcutSettingsQa.calls.length") == 0, "Cancelling a pending candidate must not clear or mutate the binding"
    unchanged_layout(before_navigation_edit, await geometry(page, "candidate-cancelled", checks), "candidate-cancelled")
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.keyboard.press("a")
    await row.locator('.kiri-shortcut-apply').click()
    await expect(recorder).to_have_attribute("aria-pressed", "false")
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text("A")
    assert await page.evaluate("__shortcutSettingsQa.calls.at(-1).payload.shortcut") == "KeyA"
    await geometry(page, "confirmed-plain-key", checks)
    await row.locator('.kiri-shortcut-reset').click()
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text(original)
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.keyboard.press("F8")
    await expect(recorder).to_have_attribute("aria-pressed", "false")
    await expect(row.locator('.kiri-shortcut-apply')).to_have_count(0)
    assert await page.evaluate("__shortcutSettingsQa.calls.at(-1).payload.shortcut") == "F8"
    await geometry(page, "function-key-direct", checks)
    await row.locator('.kiri-shortcut-reset').click()
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text(original)
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.keyboard.press("Control+Alt+Shift+Meta+PrintScreen")
    await expect(recorder).to_have_attribute("aria-pressed", "false")
    await expect(row.locator('.kiri-shortcut-chord')).to_contain_text("Print Screen")
    await geometry(page, "long-special-key", checks)
    await screenshot("long-special-key")
    await row.locator('.kiri-shortcut-reset').click()
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text(original)
    # Source-derived measurements of every supported key with all modifiers
    # identify Previous Track (Windows/X11) and MediaFastForward (macOS) as
    # the widest native labels. Home and Num 4 also cover the compact-width
    # threshold: a short label can still contain wide glyphs.
    native_cases = [("MediaTrackPrevious", "Previous Track", "long-media-key-native-event"),
                    ("Numpad4", "Num 4", "modified-keypad-native-event")]
    if await page.evaluate("/Macintosh|Mac OS X/i.test(navigator.userAgent)"):
        native_cases += [("MediaFastForward", "MediaFastForward", "long-mac-media-key-native-event"),
                         ("Home", "Home", "modified-home-native-event")]
    for code, label, state in native_cases:
        await recorder.click()
        await expect(recorder).to_have_attribute("aria-pressed", "true")
        # The pinned browser keyboard API has no media key codes. Exercise
        # the same production native-event subscriber for these key fixtures.
        await page.evaluate("""async code=>{
          const {emit}=await import('/node_modules/@tauri-apps/api/event.js');
          await emit('shortcut-recorded',{shortcut:'Control+Alt+Shift+Super+'+code,action:'recordingPauseResume'});
        }""", code)
        await expect(recorder).to_have_attribute("aria-pressed", "false")
        await expect(row.locator('.kiri-shortcut-chord')).to_contain_text(label)
        await geometry(page, state, checks)
        await screenshot(state)
        await row.locator('.kiri-shortcut-reset').click()
        await expect(row.locator('.kiri-shortcut-chord')).to_have_text(original)
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.evaluate("__shortcutSettingsQa.failNext='This shortcut is already assigned to another action.'")
    await page.keyboard.press("Control+Alt+Shift+Meta+K")
    await expect(row.locator('[role=alert]')).to_be_visible()
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text(original)
    await geometry(page, "error", checks)
    await screenshot("error")
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.keyboard.press("Control+Alt+Shift+Meta+K")
    await expect(row.locator('.kiri-shortcut-reset')).to_be_visible()
    await expect(row.locator('[role=alert]')).to_have_count(0)
    await geometry(page, "custom-long-chord", checks)
    await screenshot("custom")
    custom = await row.locator(".kiri-shortcut-chord").inner_text()
    await recorder.scroll_into_view_if_needed()
    before_custom_edit = await geometry(page, "before-custom-editing", checks)
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await expect(row.locator(".kiri-shortcut-listening")).to_be_visible()
    assert await page.evaluate("__shortcutSettingsQa.snapshot().find(s=>s.action==='recordingPauseResume').label") == custom
    unchanged_layout(before_custom_edit, await geometry(page, "custom-editing", checks), "custom-editing")
    await screenshot("custom-editing")
    await page.keyboard.press("Escape")
    await expect(recorder).to_have_attribute("aria-pressed", "false")
    await row.locator('.kiri-shortcut-reset').click()
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text(original)
    await expect(row.locator('.kiri-shortcut-reset')).to_have_count(0)
    await geometry(page, "reset", checks)
    # Clear a custom binding, then restore the actual default, not the last
    # custom value. This control removes a binding rather than pausing it.
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.keyboard.press("Control+Alt+Shift+Meta+K")
    await expect(row.locator('.kiri-shortcut-reset')).to_be_visible()
    await row.locator('.kiri-shortcut-clear').click()
    await expect(row.locator('.kiri-shortcut-unset')).to_be_visible()
    await expect(row.locator('.kiri-shortcut-clear')).to_have_count(0)
    await expect(row.locator('.kiri-shortcut-reset')).to_be_visible()
    await geometry(page, "cleared", checks)
    await screenshot("cleared")
    await row.locator('.kiri-shortcut-reset').click()
    await expect(row.locator('.kiri-shortcut-chord')).to_have_text(original)
    await expect(row.locator('.kiri-shortcut-reset')).to_have_count(0)
    await geometry(page, "clear-restored-default", checks)
    await page.evaluate("__shortcutSettingsQa.status('recordingPauseResume','occupied')")
    await expect(row.locator('.kiri-shortcut-status--error')).to_be_visible()
    await expect(row.locator('.kiri-shortcut-retry')).to_be_visible()
    await geometry(page, "occupied", checks)
    await row.locator('.kiri-shortcut-retry').click()
    await expect(row.locator('.kiri-shortcut-status--error')).to_have_count(0)
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.keyboard.press("Tab")
    await page.wait_for_function("!__shortcutSettingsQa.editing")
    await expect(recorder).to_have_attribute("aria-pressed", "false")
    await recorder.click()
    await expect(recorder).to_have_attribute("aria-pressed", "true")
    await page.locator('#settings-tab-general').click()
    await page.wait_for_function("!__shortcutSettingsQa.editing")
    await page.locator('#settings-tab-shortcuts').click()
    await expect(page.locator('.kiri-global-shortcut')).to_have_count(6)
    capture = page.locator('[data-action="capture"]')
    capture_original = await capture.locator('.kiri-shortcut-chord').inner_text()
    calls_before = await page.evaluate("__shortcutSettingsQa.calls.length")
    await capture.locator('.kiri-shortcut-recorder').click()
    await expect(capture.locator('.kiri-shortcut-recorder')).to_have_attribute("aria-pressed", "true")
    await page.keyboard.press("a")
    await expect(capture.locator('.kiri-shortcut-apply')).to_be_visible()
    await geometry(page, "global-key-candidate", checks)
    await screenshot("global-pending")
    await capture.locator('.kiri-shortcut-cancel').click()
    await expect(capture.locator('.kiri-shortcut-chord')).to_have_text(capture_original)
    assert await page.evaluate("__shortcutSettingsQa.calls.length") == calls_before



async def references(page, checks):
    # The entire reference stays visible in the DOM; no disclosure hides the
    # available shortcuts. Scrolling its final row must leave tabs reachable.
    groups = page.locator('.kiri-shortcut-reference__group')
    await expect(groups).to_have_count(4)
    await expect(page.locator('.kiri-shortcut-reference details,.kiri-shortcut-reference summary')).to_have_count(0)
    before = await page.locator('.kiri-settings-tabs').bounding_box()
    for index in range(4):
        await expect(groups.nth(index).locator('h3')).to_be_visible()
        await expect(groups.nth(index).locator('dl')).to_be_visible()
    await geometry(page, "reference-always-visible", checks)
    result = await page.locator('.kiri-shortcut-reference').evaluate("""root => {
      const r=root.getBoundingClientRect(), failures=[];
      const panel=root.closest('.kiri-settings-panel').getBoundingClientRect();
      const reportedScale=r.width/root.offsetWidth;
      const keyRight=Math.max(...[...root.querySelectorAll('kbd')].map(e=>e.getBoundingClientRect().right));
      const scrollbarClearance=(panel.right-keyRight)/reportedScale;
      if(scrollbarClearance<10)failures.push('Keys need 10 CSS px of overlay scrollbar clearance; got '+scrollbarClearance);
      for(const e of root.querySelectorAll('dt,dd,kbd')){
        const q=e.getBoundingClientRect();
        if(q.width<=0||q.height<=0||q.left<r.left-1||q.right>r.right+1)failures.push(e.textContent);
      }
      for(const row of root.querySelectorAll('dl>div')){
        const label=row.querySelector('dt').getBoundingClientRect(), keys=row.querySelector('dd').getBoundingClientRect();
        if(label.right>keys.left+1)failures.push('Reference label overlaps keys: '+row.textContent);
      }
      return failures;
    }""")
    assert not result, result
    final_row = groups.last.locator('dl>div').last
    await final_row.scroll_into_view_if_needed()
    await expect(final_row).to_be_in_viewport()
    after = await page.locator('.kiri-settings-tabs').bounding_box()
    assert before == after and after["y"] >= 0, "Reference scrolling must not hide or move tabs"
    await expect(page.locator('#settings-tab-general')).to_be_in_viewport()


async def run_case(browser, url, output, spec):
    target, language, width, height, zoom = spec
    name = f"{target}-{language}-{width}x{height}-zoom{zoom}"
    context = await browser.new_context(viewport={"width": width, "height": height},
        user_agent=AGENTS.get(target, AGENTS["linux"]), locale=language.replace("zh-Hans", "zh-CN").replace("zh-Hant", "zh-TW"))
    page = await context.new_page()
    errors, checks = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    result = {"case": name, "platformFixture": target, "language": language,
              "width": width, "height": height, "cssZoom": zoom, "checks": checks, "passed": False}
    try:
        await page.goto(f"{url}?platform={target}&lang={language}&zoom={zoom}")
        await page.locator('#settings-tab-shortcuts').click()
        await expect(page.locator('.kiri-global-shortcut')).to_have_count(6)
        await geometry(page, "default", checks, baseline=True)
        if target == "wayland":
            await expect(page.locator('.kiri-shortcut-recorder')).to_have_count(0)
            await expect(page.locator('.kiri-shortcut-command')).to_have_text([
                "kiri --capture", "kiri --record", "kiri --ocr", "kiri --library",
                "kiri --toggle-recording-pause", "kiri --stop-recording"])
            await geometry(page, "system-managed", checks)
        else:
            representative = (target, language, width, height, zoom) in {
                ("macos", "zh-Hans", 1000, 640, 1), ("windows", "de", 1000, 640, 1),
                ("windows", "de", 1000, 640, 1.25), ("linux", "de", 700, 640, 1),
                ("macos", "de", 1000, 640, 1.25)}
            await editable_cases(page, checks, output / name if representative else None)
        await references(page, checks)
        assert not errors, errors
        result["passed"] = True
        # Keep representative successful evidence, every failed case gets both
        # a full-page screenshot and dimensions below.
        if language in {"zh-Hans", "de"} and width in {700, 1000} and zoom == 1:
            await page.locator('.kiri-settings-panel').evaluate("e=>{e.scrollTop=0;}")
            await page.screenshot(path=str(output / f"{name}.png"))
    except Exception as error:
        result["error"] = str(error)
        result["pageErrors"] = errors
        try:
            result["geometry"] = await page.evaluate(GEOMETRY)
            result["nativeFixture"] = await page.evaluate("({calls:__shortcutSettingsQa.calls,settings:__shortcutSettingsQa.snapshot(),editing:__shortcutSettingsQa.editing})")
            await page.screenshot(path=str(output / f"{name}-failure.png"), full_page=True)
        except Exception as evidence_error:
            result["evidenceError"] = str(evidence_error)
    finally:
        await context.close()
    return result


async def verify(args, url, output):
    cases = [(target, language, width, 640, 1) for target in AGENTS
             for language in (LANGUAGES if not args.quick else ["en", "de", "zh-Hans"])
             for width in [700, 1000, 1280]]
    cases += [(target, "de", width, height, zoom) for target in AGENTS
              for width, height, zoom in [(960, 640, 1), (820, 540, 1), (1000, 640, 1.25), (1280, 800, 1.25)]]
    cases += [("wayland", "de", width, 640, 1) for width in [700, 1000, 1280]]
    if args.case:
        cases = [case for case in cases if args.case in f"{case[0]}-{case[1]}-{case[2]}x{case[3]}-zoom{case[4]}"]
        if not cases:
            raise SystemExit(f"No cases matched {args.case!r}")
    report = {"scope": "Real browser DOM and CSS with isolated native IPC. UA/labels and CSS zoom do not establish native OS shortcuts or DPI acceptance.",
              "host": host_platform.platform(), "engine": args.browser, "cases": []}
    async with async_playwright() as runtime:
        launch = {"headless": True}
        if args.executable:
            launch["executable_path"] = args.executable
        browser = await getattr(runtime, args.browser).launch(**launch)
        try:
            report["browserVersion"] = browser.version
            for spec in cases:
                result = await run_case(browser, url, output, spec)
                report["cases"].append(result)
                print(("PASS " if result["passed"] else "FAIL ") + result["case"], flush=True)
                (output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                if not result["passed"] and args.fail_fast:
                    break
        finally:
            await browser.close()
    failures = [case for case in report["cases"] if not case["passed"]]
    if failures:
        raise SystemExit(f"{len(failures)} layout case(s) failed; see {output / 'results.json'}")
    print(f"{len(report['cases'])} real-browser layout cases passed ({args.browser}).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=["chromium", "webkit"], default="chromium")
    parser.add_argument("--executable", help="Optional local browser executable; CI uses Playwright's pinned engine")
    parser.add_argument("--quick", action="store_true", help="Three representative languages; default checks all seven")
    parser.add_argument("--fail-fast", action="store_true")
    parser.add_argument("--case", help="Rerun cases containing this name fragment, e.g. zoom1.25")
    args = parser.parse_args()
    output = Path(os.environ.get("KIRI_SHORTCUT_QA_OUT", str(ROOT / "output/playwright/shortcut-settings"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with socket.socket() as available:
        available.bind(("127.0.0.1", 0))
        port = available.getsockname()[1]
    url = f"http://127.0.0.1:{port}/scripts/qa/shortcut-settings-harness.html"
    env = {**os.environ, "KIRI_SHORTCUT_QA_PORT": str(port)}
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as log:
        server = subprocess.Popen([shutil.which("node") or "node", str(ROOT / "node_modules/vite/bin/vite.js"),
            "--config", "scripts/qa/shortcut-settings-harness.vite.ts"], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                try:
                    urllib.request.urlopen(url, timeout=1).close()
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError("Isolated settings server did not start")
            asyncio.run(verify(args, url, output))
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            log.seek(0)
            (output / "server.log").write_text(log.read(), encoding="utf-8")


if __name__ == "__main__":
    main()
