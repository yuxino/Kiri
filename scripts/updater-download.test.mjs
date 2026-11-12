import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function harness(failure) {
  const calls = [], closed = [], events = [];
  const official = { rid: 7, version: '9.9.9', currentVersion: '1.0.0', body: 'Notes', close: async () => closed.push(7) };
  const source = ts.transpileModule(readFileSync(new URL('../src/settings/resumableUpdater.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules = {
    '@tauri-apps/api/core': {
      Channel: class {},
      Resource: class { constructor(rid) { this.rid = rid; } async close() { closed.push(this.rid); } },
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'download_app_update') {
          args.onEvent.onmessage({ event: 'Started', data: { downloaded: 2, contentLength: 4 } });
          if (failure) throw failure;
          args.onEvent.onmessage({ event: 'Finished' });
          return 8;
        }
      },
    },
    '@tauri-apps/plugin-updater': { check: async options => { calls.push({ command: 'check', args: options }); return official; } },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => modules[name], module, module.exports);
  return { check: module.exports.check, calls, closed, events };
}

test('resumable adapter uses the checked native update and installs only its verified resource', async () => {
  const h = harness();
  const update = await h.check({ timeout: 15000 });
  assert.equal(update.version, '9.9.9'); assert.equal(update.body, 'Notes');
  await assert.rejects(update.install(), /Download and verify/);
  await update.download(event => h.events.push(event));
  assert.equal(h.events[0].data.downloaded, 2);
  assert.deepEqual(Object.keys(h.calls[1].args).sort(), ['onEvent', 'rid']);
  assert.equal(h.calls[1].args.rid, 7);
  await update.install();
  assert.deepEqual(h.calls[2], { command: 'install_app_update', args: { updateRid: 7, bytesRid: 8 } });
  await update.close(); assert.deepEqual(h.closed, [7], 'native install already closed the bytes resource');
});

test('transport failure preserves resumable metadata but never creates installable bytes', async () => {
  const failure = { downloaded: 2, total: 4 };
  const h = harness(failure), update = await h.check({ timeout: 15000 });
  await assert.rejects(update.download(() => {}), error => error === failure);
  await assert.rejects(update.install(), /Download and verify/);
  await update.close(); assert.deepEqual(h.closed, [7]);
  assert.equal(h.calls.some(call => call.command === 'install_app_update'), false);
});

test('closing an uninstalled update releases both native resources', async () => {
  const h = harness(), update = await h.check({ timeout: 15000 });
  await update.download(() => {}); await update.close();
  assert.deepEqual(h.closed, [8, 7]);
});
