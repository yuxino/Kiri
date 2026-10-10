import assert from 'node:assert/strict';
import test from 'node:test';
import { AppearanceUpdates } from '../src/annotation/appearance-updates.js';
const initial = { colorPreset: 'cherry', penWidth: 3, textFontSize: 18 };

test('stale editor color changes preserve another editor width', () => {
  const a = new AppearanceUpdates(initial), b = new AppearanceUpdates(initial);
  a.update({ ...a.current, penWidth: 24 });
  const first = a.beginSave();
  const saved = { ...initial, ...first };
  a.receive(saved); a.finishSave(saved);
  // B has not received the update; its write still contains only color.
  b.update({ ...b.current, colorPreset: 'blue' });
  const patch = b.beginSave();
  assert.deepEqual(patch, { colorPreset: 'blue' });
  const combined = { ...saved, ...patch };
  b.receive(combined); a.receive(combined); b.finishSave(combined);
  assert.equal(b.current.penWidth, 24);
  assert.deepEqual(a.current, b.current);
});
test('in-flight writes preserve newer local edits and external fields', () => {
  const window = new AppearanceUpdates(initial);
  window.update({ ...window.current, penWidth: 24 });
  window.beginSave();
  window.update({ ...window.current, penWidth: 13 });
  window.receive({ ...initial, penWidth: 24, colorPreset: 'orange' });
  window.finishSave({ ...initial, penWidth: 24 });
  assert.deepEqual(window.current, { ...initial, penWidth: 13, colorPreset: 'orange' });
  assert.deepEqual(window.beginSave(), { penWidth: 13 });
});
test('failed writes retry their fields without losing edits made during the request', () => {
  const window = new AppearanceUpdates(initial);
  window.update({ ...window.current, penWidth: 24 }); window.beginSave();
  window.update({ ...window.current, colorPreset: 'blue' });
  window.failSave();
  assert.deepEqual(window.beginSave(), { penWidth: 24, colorPreset: 'blue' });
});

test('a stale rendered callback changes only its intended field after a native event', () => {
  const window = new AppearanceUpdates(initial);
  const rendered = {...window.current};
  window.receive({...initial, penWidth: 24});
  window.update({...rendered, colorPreset: 'blue'}, rendered);
  assert.equal(window.current.penWidth, 24);
  assert.equal(window.current.colorPreset, 'blue');
  assert.deepEqual(window.beginSave(), {colorPreset: 'blue'});
});

test('several callbacks from one render preserve both unsaved changes', () => {
  const window = new AppearanceUpdates(initial);
  const rendered = {...window.current};
  window.update({...rendered, penWidth: 24}, rendered);
  window.update({...rendered, colorPreset: 'blue'}, rendered);
  assert.equal(window.current.penWidth, 24);
  assert.deepEqual(window.beginSave(), {penWidth: 24, colorPreset: 'blue'});
});

test('watermark and mosaic preferences from independent windows merge field by field',()=>{
  const initial={watermarkColor:'black',watermarkFontSize:28,watermarkOpacity:20,watermarkRotation:-30,
    watermarkMode:'tiled',watermarkSpacing:80,mosaicShape:'brush'};
  const overlay=new AppearanceUpdates(initial),editor=new AppearanceUpdates(initial);
  const editorRender={...editor.current};
  overlay.update({...overlay.current,watermarkSpacing:160,watermarkRotation:45});
  const first=overlay.beginSave(),saved={...initial,...first};
  overlay.finishSave(saved);editor.receive(saved);
  editor.update({...editorRender,watermarkOpacity:55,mosaicShape:'ellipse'},editorRender);
  assert.deepEqual(editor.beginSave(),{watermarkOpacity:55,mosaicShape:'ellipse'});
  const combined={...saved,watermarkOpacity:55,mosaicShape:'ellipse'};
  editor.finishSave(combined);overlay.receive(combined);
  assert.deepEqual(overlay.current,editor.current);
  assert.equal(editor.current.watermarkSpacing,160);assert.equal(editor.current.watermarkRotation,45);
});
