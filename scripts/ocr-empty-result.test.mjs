import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createLibraryHarness, nodes, settleRequests } from './helpers/library-render-harness.mjs';
const source = 'import React from "react";\n' + readFileSync(new URL('../src/ocr/TextHistory.tsx', import.meta.url), 'utf8');

test('successful empty saved-image OCR presents the normal reader, without Retry or history claim', async () => {
  let calls = 0;
  const harness = createLibraryHarness({}, source, {
    modules: { '../lib/ipc': {
      api: { recognizeAssetLocal: async () => { calls++; return { text: '', saved: false, asset: null }; } },
      mediaUrl: id => `media:${id}`, onLibraryChanged: async () => () => {},
    } },
    attachRef(node) { if (node.type === 'dialog') node.props.ref.current = { showModal() {}, close() {} }; },
  });
  const component = harness.mount('OcrDialog', { asset: { id: 'blank', kind: 'image' }, onClose() {} });
  component.render(); await settleRequests();
  const tree = component.render();
  assert.equal(calls, 1);
  const reader = nodes(tree).find(node => typeof node?.type === 'function' && node.type.name === 'TextReader');
  assert.equal(reader.props.text, ''); assert.equal(reader.props.saved, false);
  assert.equal(nodes(tree).includes('Retry'), false);
  assert.equal(nodes(tree).includes('Saved to Text History'), false);
  const mountedReader = harness.mount('TextReader', reader.props);
  assert.ok(nodes(mountedReader.render()).includes('No Text Found'));
  mountedReader.unmount(); component.unmount();
});

const overlayPanelSource = 'import React from "react";\n' + readFileSync(new URL('../src/ocr/OcrResultPanel.tsx', import.meta.url), 'utf8');
function resultPanel(props) {
  const harness = createLibraryHarness({}, overlayPanelSource, { modules: {
    '../windows/toolbar-layout.js': { capturePanelLayout: () => ({ left: 0, top: 0, width: 384, maxHeight: 600 }) },
  } });
  return harness.mount('OcrResultPanel', {
    text: '', error: null, saved: false, onReselect() {}, onCopy() {}, ...props,
  });
}
const action = (tree, label) => nodes(tree).find(node => node?.type === 'button' && nodes(node).includes(label));

test('an empty or failed capture offers another region without copying or claiming a history entry', () => {
  for (const [error, heading] of [[null, 'No Text Found'], ['The OCR image exceeds the size limit.', 'Text Recognition Failed']]) {
    let selections = 0;
    const panel = resultPanel({ error, onReselect: () => selections++ });
    const tree = panel.render();
    assert.ok(nodes(tree).includes(heading));
    if (error) assert.ok(nodes(tree).includes(error));
    assert.equal(action(tree, 'Copy Text'), undefined);
    assert.equal(nodes(tree).includes('Saved to Text History'), false);
    action(tree, 'Select Another Region').props.onClick();
    assert.equal(selections, 1);
    panel.unmount();
  }
});

test('a failed clipboard write keeps unsaved text and allows an explicit copy retry', async () => {
  let calls = 0;
  const panel = resultPanel({ text: 'local fixture', onCopy: async () => { if (++calls === 1) throw Error(); } });
  const copy = action(panel.render(), 'Copy Text');
  copy.props.onClick(); copy.props.onClick();
  assert.equal(calls, 1);
  await settleRequests();
  const failed = panel.render();
  assert.ok(nodes(failed).includes('local fixture'));
  assert.ok(nodes(failed).includes("Couldn't copy text."));
  assert.ok(nodes(failed).includes("History wasn't saved. Copy the text before closing."));
  action(failed, 'Copy Text').props.onClick();
  await settleRequests();
  assert.equal(calls, 2);
  panel.unmount();
});
