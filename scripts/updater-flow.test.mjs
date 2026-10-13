import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("downloads and installs remain separate signed user actions", () => {
  const settings = read("src/settings/useAppUpdater.ts");
  const ipc = read("src/lib/ipc.ts");
  const rust = read("src-tauri/src/updates.rs");
  const lib = read("src-tauri/src/lib.rs");

  assert.match(settings, /from "@tauri-apps\/plugin-updater"/);
  assert.match(settings, /await check\(/);
  assert.match(settings, /await update\.download\(/);
  assert.match(settings, /event\.event === "Progress"/);
  assert.match(settings, /await update\.install\(\{ restartAfterInstall: true \}\)/);
  assert.match(settings, /await relaunch\(\)/);
  assert.match(settings, /update\.body/);
  assert.doesNotMatch(settings, /downloadAndInstall/);
  assert.doesNotMatch(ipc, /check_for_updates|checkForUpdates/);
  assert.doesNotMatch(rust, /api\.github\.com|check_for_updates/);
  assert.match(rust, /github\.com\/yuxino\/kiri\/releases\/latest/);
  assert.match(lib, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(lib, /tauri_plugin_process::init\(\)/);
});

test("updater configuration is fixed, HTTPS-only, and least-privileged", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const defaultCapability = JSON.parse(read("src-tauri/capabilities/default.json"));
  const capability = JSON.parse(read("src-tauri/capabilities/updater.json"));
  const packageJson = JSON.parse(read("package.json"));
  const decodedPublicKey = Buffer.from(config.plugins.updater.pubkey, "base64").toString("utf8");

  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.plugins.updater.windows.installMode, "passive");
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/yuxino/kiri/releases/latest/download/latest.json",
  ]);
  assert.match(decodedPublicKey, /^untrusted comment: minisign public key:/);
  assert.equal(decodedPublicKey.includes("PRIVATE KEY"), false);
  assert.deepEqual(defaultCapability.permissions.filter((permission) => /^(?:updater|process):/.test(permission)), []);
  assert.deepEqual(capability.windows, ["library"]);
  assert.deepEqual(
    capability.permissions.filter((permission) => permission.startsWith("updater:")),
    ["updater:allow-check", "updater:allow-download", "updater:allow-install"],
  );
  assert.equal(capability.permissions.includes("process:allow-restart"), true);
  assert.equal(packageJson.dependencies["@tauri-apps/plugin-updater"], "^2.11.0");
  assert.equal(packageJson.dependencies["@tauri-apps/plugin-process"], "^2.3.1");
});

test("CI signs updater artifacts without exposing a private key", () => {
  const build = read(".github/workflows/build.yml");
  const release = read(".github/workflows/release.yml");
  const packager = read("scripts/package-macos-release.sh");

  for (const source of [build, release]) {
    assert.match(source, /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
    assert.match(source, /secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
    assert.doesNotMatch(source, /BEGIN (?:OPENSSH |RSA )?PRIVATE KEY/);
  }
  assert.match(release, /updaterJsonPreferNsis:\s*true/);
  assert.match(release, /uploadUpdaterJson:\s*true/);
  assert.match(release, /uploadUpdaterSignatures:\s*true/);
  assert.match(packager, /security find-generic-password/);
  assert.match(packager, /kiri\.app\.tar\.gz/);
  assert.match(packager, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
});

// Run the actual update component's handlers with isolated IPC and hook state.
// No network, installer or user library is touched by these regressions.
const { createLibraryHarness, nodes, deferred, settleRequests } = await import('./helpers/library-render-harness.mjs');
function updaterHarness(windows = true, portable = false, linux = false, options = {}) {
  const pending = deferred();
  const installs = [];
  let checks = 0;
  let closes = 0;
  let downloads = 0;
  let releaseOpens = 0;
  let progress;
  let restarts = 0;
  const update = { version: '9.9.9', currentVersion: '1.5.0', body: 'Release notes',
    close: async () => { closes++; },
    download: callback => { downloads++; progress = callback; return pending.promise; },
    install: async options => { installs.push(options); },
  };
  const settings = read('src/settings/SettingsView.tsx');
  const source = `import React, {useState, useRef, useEffect} from 'react';
    import {api} from '../lib/ipc';
    import {KiriIcon} from '../components/KiriIcons';
    import { useAppUpdater, stateDetails } from '../settings/useAppUpdater';
    const t = value => value, fmt = (value, arg) => value.replace('%@', arg);
    ${settings.slice(settings.indexOf('function AboutSettingsSection'), settings.indexOf('function GeneralSettingsSection'))}
    export function TestAbout() { return AboutSettingsSection({ updater: useAppUpdater() }); }`;
  const harness = createLibraryHarness({ check: async () => { checks++; return options.check ? options.check(update) : update; },
    getVersion: async () => '1.5.0', isPortableBuild: async () => portable,
    platformCapabilities: options.capabilities ?? (async () => ({ manualUpdates: linux })),
    openReleasePage: async () => { releaseOpens++; },
    relaunch: async () => { restarts++; } }, source, {
      navigator: { userAgent: linux ? 'Linux' : windows ? 'Windows' : 'Macintosh' },
      isVisible: async () => options.visible ?? false,
      globals: options.globals,
    });
  const component = harness.mount('TestAbout');
  const render = () => component.render();
  const button = () => nodes(render()).find(node => node?.type === 'button');
  return { pending, installs, render, button, progress: event => progress(event),
    restarts: () => restarts, checks: () => checks, releaseOpens: () => releaseOpens,
    focus: () => harness.emit("libraryFocus", { payload: true }),
    unmount: () => component.unmount(), closes: () => closes, downloads: () => downloads };
}

test('Windows download reports bytes and cannot install until verification succeeds', async () => {
  const h = updaterHarness();
  h.button();
  await settleRequests();
  h.button().props.onClick(); await settleRequests();
  h.button().props.onClick();
  h.progress({ event: 'Started', data: { contentLength: 4 * 1024 * 1024 } });
  h.progress({ event: 'Progress', data: { chunkLength: 1024 * 1024 } });
  assert.ok(nodes(h.render()).includes('Downloading… 25% · 1.0 MB / 4.0 MB'));
  const progress = nodes(h.render()).find(node => node?.type === 'progress');
  assert.equal(progress.props.value, 1024 * 1024);
  h.progress({ event: 'Finished' });
  assert.ok(nodes(h.render()).includes('Verifying update signature…'));
  assert.equal(h.button().props.disabled, true);
  h.button().props.onClick(); assert.deepEqual(h.installs, []);
  h.pending.resolve(); await settleRequests();
  assert.ok(nodes(h.button()).includes('Install and Restart'));
  h.button().props.onClick(); await settleRequests();
  assert.deepEqual(h.installs, [{ restartAfterInstall: true }]);
  assert.equal(h.restarts(), 0, 'Windows installer owns the restart');
});

test('unknown download size stays indeterminate and failed verification never enables installation', async () => {
  const h = updaterHarness();
  h.button();
  await settleRequests();
  h.button().props.onClick(); await settleRequests(); h.button().props.onClick();
  h.progress({ event: 'Started', data: {} });
  h.progress({ event: 'Progress', data: { chunkLength: 1024 * 1024 } });
  assert.ok(nodes(h.render()).includes('Downloading… 1.0 MB'));
  assert.equal(nodes(h.render()).find(node => node?.type === 'progress').props.value, undefined);
  h.progress({ event: 'Finished' });
  h.pending.reject(new Error('invalid signature')); await settleRequests();
  assert.ok(nodes(h.render()).includes("Couldn't download the update. Try again."));
  assert.deepEqual(h.installs, []);
});

test('macOS installation still waits for its explicit restart action', async () => {
  const h = updaterHarness(false);
  h.button().props.onClick(); await settleRequests(); h.button().props.onClick();
  h.pending.resolve(); await settleRequests();
  assert.ok(nodes(h.button()).includes('Install Update'));
  h.button().props.onClick(); await settleRequests();
  assert.equal(h.restarts(), 0);
  assert.ok(nodes(h.button()).includes('Restart and Finish Update'));
  h.button().props.onClick(); await settleRequests();
  assert.equal(h.restarts(), 1);
});

test('Windows portable build opens Releases and never checks or installs NSIS updates', async () => {
  const h = updaterHarness(true, true);
  assert.equal(h.button().props.disabled, true);
  await settleRequests();
  assert.ok(nodes(h.render()).includes('Portable version: download the latest ZIP from Releases to update.'));
  assert.ok(nodes(h.button()).includes('Open Releases Page'));
  h.button().props.onClick();
  await settleRequests();
  assert.equal(h.releaseOpens(), 1);
  assert.equal(h.checks(), 0);
  assert.deepEqual(h.installs, []);
});


test('Linux packages use manual updates without querying an unsupported manifest target', async () => {
  const h = updaterHarness(false, false, true);
  h.button();
  await settleRequests();
  assert.ok(nodes(h.render()).includes('Linux updates are installed manually from a downloaded package.'));
  assert.ok(nodes(h.button()).includes('Open Releases Page'));
  h.button().props.onClick();
  await settleRequests();
  assert.equal(h.releaseOpens(), 1);
  assert.equal(h.checks(), 0);
  assert.deepEqual(h.installs, []);
});

test('opening a visible panel discovers an update without downloading it', async () => {
  const h = updaterHarness(false, false, false, { visible: true });
  h.render(); await settleRequests(); h.render(); await settleRequests();
  assert.equal(h.checks(), 1);
  assert.ok(nodes(h.render()).includes('Kiri v9.9.9 is available.'));
  assert.equal(h.downloads(), 0);
  assert.deepEqual(h.installs, []);
  h.focus(); h.focus(); await settleRequests();
  assert.equal(h.checks(), 1);
  h.button().props.onClick(); await settleRequests();
  assert.equal(h.downloads(), 1);
  h.focus(); await settleRequests();
  assert.equal(h.checks(), 1, 'focus cannot replace an update being downloaded');
  h.pending.resolve(); await settleRequests();
  assert.ok(nodes(h.button()).includes('Install Update'));
  h.unmount(); await settleRequests(); assert.equal(h.closes(), 1);
});

test('hidden panels and unsupported packages do not check automatically', async () => {
  for (const [windows, portable, linux, visible] of [[false,false,false,false], [true,true,false,true], [false,false,true,true]]) {
    const h = updaterHarness(windows,portable,linux,{visible});
    h.render(); await settleRequests(); h.render(); await settleRequests();
    h.focus(); await settleRequests(); assert.equal(h.checks(),0);
    h.unmount();
  }
});

test('automatic checks are single flight and release native handles after late completion', async () => {
  const pending = deferred();
  const h = updaterHarness(false,false,false,{visible:true,check: update => pending.promise.then(() => update)});
  h.render(); await settleRequests(); h.render(); await settleRequests();
  h.focus(); h.focus(); await settleRequests(); assert.equal(h.checks(),1);
  h.unmount(); pending.resolve(); await settleRequests();
  assert.equal(h.closes(),1); assert.equal(h.downloads(),0);
});

test('automatic failures stay quiet and retry only on a later panel activation', async () => {
  let now = 1000;
  const h = updaterHarness(false,false,false,{visible:true,globals:{Date:{now:()=>now}},check:async()=>{throw Error('offline');}});
  h.render(); await settleRequests(); h.render(); await settleRequests();
  assert.equal(h.checks(),1);
  assert.ok(nodes(h.render()).includes('Opening Kiri checks for updates.'));
  assert.equal(nodes(h.render()).some(n=>n?.props?.role==='alert'),false);
  now += 299999; h.focus(); await settleRequests(); assert.equal(h.checks(),1);
  now += 1; h.focus(); await settleRequests(); assert.equal(h.checks(),2);
  h.unmount();
});

test('a successful no-update check is cached for six hours without a timer', async () => {
  let now = 1000;
  const h = updaterHarness(false,false,false,{visible:true,globals:{Date:{now:()=>now}},check:async()=>null});
  h.render(); await settleRequests(); h.render(); await settleRequests();
  assert.equal(h.checks(),1); assert.ok(nodes(h.render()).includes('Kiri v1.5.0 is up to date.'));
  now += 6*60*60*1000-1; h.focus(); await settleRequests(); assert.equal(h.checks(),1);
  now += 1; h.focus(); await settleRequests(); assert.equal(h.checks(),2);
  h.unmount();
});

test('the settings notification follows discovered availability across navigation', async () => {
  const update = { version:'9.9.9',currentVersion:'1.6.17',body:'notes',close:async()=>{},download:async()=>{},install:async()=>{} };
  const harness = createLibraryHarness({check:async()=>update},null,{isVisible:async()=>true});
  const main = harness.mount('LibraryWindow');
  main.render(); await settleRequests(); main.render(); await settleRequests();
  const picker = () => nodes(main.render()).find(n=>n?.type?.name==='SegmentedPicker');
  assert.equal(picker().props.options[4].notification,'Update available');
  picker().props.onChange(4); main.render();
  picker().props.onChange(1); main.render();
  assert.equal(picker().props.options[4].notification,'Update available');
  main.unmount();
});

test('missing or failed platform capabilities cannot trigger automatic network requests', async () => {
  for (const capabilities of [async()=>({}), async()=>{throw Error('unavailable');}]) {
    const h = updaterHarness(false,false,false,{visible:true,capabilities});
    h.render(); await settleRequests(); h.render(); await settleRequests();
    h.focus(); await settleRequests(); assert.equal(h.checks(),0);
    h.unmount();
  }
});

function supportInfoHarness(copySupportInfo) {
  const settings = read('src/settings/SettingsView.tsx');
  const source = `import React, {useState, useRef, useEffect} from 'react';
    import {api} from '../lib/ipc'; import {KiriIcon} from '../components/KiriIcons';
    import {stateDetails} from '../settings/useAppUpdater';
    const t=value=>value, fmt=(value,arg)=>value.replace('%@',arg);
    ${settings.slice(settings.indexOf('function AboutSettingsSection'), settings.indexOf('function GeneralSettingsSection'))}
    export function TestAbout() { return AboutSettingsSection({ updater: {
      currentVersion:'1.6.18', isWindows:true, isPortable:false, updateState:{kind:'idle'}, hasUpdate:false,
      checkForUpdates:()=>{}, downloadUpdate:()=>{}, installUpdate:()=>{}, restartUpdatedApp:()=>{}, openRecoveryPage:()=>{},
    }}); }`;
  const h=createLibraryHarness({copySupportInfo},source);
  h.window.setTimeout=()=>1; h.window.clearTimeout=()=>{};
  const component=h.mount('TestAbout');
  return {render:()=>component.render(),button:()=>nodes(component.render()).find(n=>n?.props?.['aria-label']==='Copy Info')};
}

test('copying support info is single-flight and shows success only after the clipboard write', async()=>{
  const pending=deferred(); let copies=0;
  const h=supportInfoHarness(()=>{copies++;return pending.promise;});
  h.button().props.onClick(); h.button().props.onClick();
  assert.equal(copies,1);
  assert.equal(h.button().props.disabled,true);
  assert.ok(!nodes(h.render()).includes('Copied'));
  pending.resolve();await settleRequests();
  assert.ok(nodes(h.render()).includes('Copied'));
  assert.equal(h.button().props.disabled,false);
});

test('clipboard failure keeps support copying retryable without claiming success',async()=>{
  let copies=0;
  const h=supportInfoHarness(async()=>{if(++copies===1)throw Error('Clipboard busy');});
  h.button().props.onClick();await settleRequests();
  assert.ok(nodes(h.render()).includes("Couldn't copy info. Try again."));
  assert.ok(!nodes(h.render()).includes('Copied'));
  h.button().props.onClick();await settleRequests();
  assert.equal(copies,2);
  assert.ok(nodes(h.render()).includes('Copied'));
  assert.ok(!nodes(h.render()).includes("Couldn't copy info. Try again."));
});
