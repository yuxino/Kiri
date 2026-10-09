import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createLibraryHarness, nodes, settleRequests, testAsset } from "./helpers/library-render-harness.mjs";

const languages = ["en", "zh-Hans", "zh-Hant", "ja", "de", "ko", "fr"];
const dictionaries = Object.fromEntries(languages.map(language => [language,
  JSON.parse(readFileSync(new URL(`../src/i18n/${language}.json`, import.meta.url))),
]));
function moduleAt(path, document = { documentElement: { lang: "" } }) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  vm.runInNewContext(code, { exports, document, navigator: { language: "en" },
    require: path => ({ default: dictionaries[path.slice(2, -5)] }),
  });
  return exports;
}

test("all seven complete dictionaries preserve placeholders and their order", () => {
  const keys = Object.keys(dictionaries.en);
  const placeholders = text => text.match(/%[@d]|\{\w+\}/g) ?? [];
  for (const language of languages) {
    assert.deepEqual(Object.keys(dictionaries[language]), keys, language);
    for (const key of keys) {
      const value = dictionaries[language][key];
      assert.ok(typeof value === "string" && value.trim(), `${language}: ${key}`);
      assert.deepEqual(placeholders(value), placeholders(dictionaries.en[key]), `${language}: ${key}`);
    }
  }
});

test("locale resolution and live formatting cover every selectable language", () => {
  const document = { documentElement: { lang: "" } };
  const locale = moduleAt("../src/i18n/index.ts", document);
  assert.equal(document.documentElement.lang, "en");
  assert.deepEqual(Array.from(locale.languages), languages);
  for (const [input, expected] of [
    ["en-GB", "en"], ["zh", "zh-Hans"], ["zh-CN", "zh-Hans"],
    ["zh_TW", "zh-Hant"], ["zh-Hant-HK", "zh-Hant"], ["zh-HK", "zh-Hant"],
    ["zh-Hans-TW", "zh-Hans"], ["zh-Hans-HK", "zh-Hans"], ["zh-Hant-CN", "zh-Hant"],
    ["de-AT", "de"], ["ko_KR", "ko"], ["fr-CA", "fr"], ["ja-JP", "ja"], ["es", "en"],
  ]) assert.equal(locale.languageForLocale(input), expected, input);
  let changed = 0;
  const dispose = locale.onLanguageChange(() => changed++);
  for (const language of languages) {
    assert.equal(locale.isLanguage(language), true);
    locale.setLanguage(language);
    assert.equal(document.documentElement.lang, language);
    assert.equal(locale.t("Language"), dictionaries[language].Language);
    assert.equal(locale.fmt("Checking video… %d%", 53.9), dictionaries[language]["Checking video… %d%"].replace("%d", "53"));
  }
  dispose();
  assert.equal(changed, 6);
  assert.equal(locale.isLanguage("de-DE"), false);
  document.documentElement.lang = "en";
  locale.setLanguage("fr");
  assert.equal(document.documentElement.lang, "fr", "same-language startup updates the document language");
});

test("a language change received during startup wins over the stale saved preference", async () => {
  const { initializeLanguage } = moduleAt("../src/i18n/language-sync.ts");
  let listener, resolveSaved;
  let localeReads = 0;
  const accepted = [];
  const startup = initializeLanguage({
    subscribe: async change => { listener = change; },
    getSaved: () => new Promise(resolve => { resolveSaved = resolve; }),
    getLocale: async () => { localeReads++; return "en"; },
    accept: language => { if (!languages.includes(language)) return false; accepted.push(language); return true; },
  });
  while (!resolveSaved) await Promise.resolve();
  listener("ko");
  resolveSaved("de");
  await startup;
  assert.deepEqual(accepted, ["ko"]);
  assert.equal(localeReads, 0);
  listener("fr");
  assert.deepEqual(accepted, ["ko", "fr"]);
});

test("OS locale is used only without a saved choice and cannot overwrite a newer event", async () => {
  const { initializeLanguage } = moduleAt("../src/i18n/language-sync.ts");
  let listener, resolveLocale;
  const accepted = [];
  const startup = initializeLanguage({
    subscribe: async change => { listener = change; },
    getSaved: async () => "invalid",
    getLocale: () => new Promise(resolve => { resolveLocale = resolve; }),
    accept: language => { if (!languages.includes(language)) return false; accepted.push(language); return true; },
  });
  // Allow the subscription and saved-preference reads to settle.
  while (!resolveLocale) await Promise.resolve();
  listener("zh-Hant");
  resolveLocale("en");
  await startup;
  assert.deepEqual(accepted, ["zh-Hant"]);
  let readLocale = false;
  await initializeLanguage({ subscribe: async () => {}, getSaved: async () => "ja",
    getLocale: async () => { readLocale = true; return "en"; },
    accept: language => languages.includes(language),
  });
  assert.equal(readLocale, false);
});

test("native Portal labels match each complete UI dictionary without embedding the dictionaries", () => {
  const source = readFileSync(new URL("../src-tauri/src/core/locale.rs", import.meta.url), "utf8");
  const native = source.slice(source.indexOf("pub fn shortcut_descriptions"), source.indexOf("#[cfg(test)]"));
  const keys = ["Capture", "Pause/Resume Recording", "Stop Recording"];
  for (const language of languages.filter(language => language !== "en")) {
    const match = native.match(new RegExp(`"${language}" => \\[([\\s\\S]*?)\\]`));
    assert.ok(match, language);
    const values = [...match[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(match => JSON.parse('"' + match[1] + '"'));
    assert.deepEqual(values, keys.map(key => dictionaries[language][key]), language);
  }
  const portal = readFileSync(new URL("../src-tauri/src/portal_shortcuts/linux.rs", import.meta.url), "utf8");
  assert.match(portal, /preferred_language/);
  assert.match(portal, /shortcut_descriptions\(language\)/);
  assert.doesNotMatch(portal, /include_str!.*i18n/);
  const commands = readFileSync(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");
  const dialog = commands.slice(commands.indexOf("pub async fn save_file_dialog"), commands.indexOf("pub async fn save_file_dialog") + 1600);
  assert.match(dialog, /preferred_language[\s\S]*&get_locale\(\)/);
  assert.match(dialog, /png_filter_label\(language\)/);
});

test("an open confirmation follows language changes without freezing the library's translated copy", async () => {
  const libraryLocale = moduleAt("../src/i18n/index.ts");
  const dialogLocale = moduleAt("../src/i18n/index.ts");
  const { initializeLanguage } = moduleAt("../src/i18n/language-sync.ts");
  const listeners = [];
  for (const locale of [libraryLocale, dialogLocale]) await initializeLanguage({
    subscribe: async listener => { listeners.push(listener); },
    getSaved: async () => "fr", getLocale: async () => "en",
    accept: language => {
      if (!locale.isLanguage(language)) return false;
      locale.setLanguage(language); return true;
    },
  });
  let request;
  const libraryHarness = createLibraryHarness({ showConfirmDialog: (...args) => { request = args; return Promise.resolve(); } },
    null, { modules: { "../i18n": libraryLocale } });
  const library = libraryHarness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  nodes(library.render()).find(node => node?.type?.name === "SegmentedPicker").props.onChange(3);
  library.render(); await settleRequests();
  nodes(library.render()).find(node => node?.type === "button" && node.props.title === libraryLocale.t("Empty Trash")).props.onClick();
  const [kind, title, message, confirmLabel, ids, localize] = request;
  const source = 'import React from "react";\n' + readFileSync(new URL("../src/windows/ConfirmWindow.tsx", import.meta.url), "utf8");
  const dialogHarness = createLibraryHarness({}, source, { modules: {
    "../i18n": dialogLocale,
    "@tauri-apps/api/window": { getCurrentWindow: () => ({ close: async () => {} }) },
  } });
  const dialog = dialogHarness.mount("ConfirmWindow", { kind, title, message, confirmLabel, ids, localize });
  for (const language of languages) {
    listeners.forEach(listener => listener(language));
    const text = nodes(dialog.render());
    for (const key of ["Empty Trash?", "All captures in Trash will be permanently deleted. This cannot be undone.", "Empty Trash", "Cancel"])
      assert.ok(text.includes(dictionaries[language][key]), `${language}: ${key}`);
  }
  library.unmount(); dialog.unmount();
});

test("confirmation localizes the batch count while preserving caller-owned raw text", async () => {
  const locale = moduleAt("../src/i18n/index.ts");
  locale.setLanguage("fr");
  const assets = [testAsset, { ...testAsset, id: "second" }];
  const grid = { scrollTop: 0, scrollLeft: 0, clientLeft: 0, clientTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    scrollTo() {}, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {},
  };
  let request;
  const libraryHarness = createLibraryHarness({ listAssets: async () => assets,
    showConfirmDialog: (...args) => { request = args; return Promise.resolve(); },
  }, null, { modules: { "../i18n": locale }, attachRef(node) {
    if (node.props.onPointerDown && node.props.ref) node.props.ref.current = grid;
    if (node.type?.name === "AssetCard") node.props.registerRef({ offsetLeft: 10, offsetTop: 10, offsetWidth: 20, offsetHeight: 20 });
  } });
  const library = libraryHarness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  nodes(library.render()).find(node => node?.type?.name === "SegmentedPicker").props.onChange(3);
  library.render(); await settleRequests();
  const band = nodes(library.render()).find(node => node?.props?.onPointerDown);
  const event = { button: 0, pointerId: 1, clientX: 0, clientY: 0, currentTarget: grid, preventDefault() {} };
  band.props.onPointerDown(event);
  band.props.onPointerUp({ ...event, clientX: 100, clientY: 100 });
  nodes(library.render()).find(node => node?.type?.name === "BatchActionBar").props.onDelete();
  const [kind, title, message, confirmLabel, ids, localize] = request;
  const source = 'import React from "react";\n' + readFileSync(new URL("../src/windows/ConfirmWindow.tsx", import.meta.url), "utf8");
  const deleted = [];
  const harness = createLibraryHarness({ batchPermanentlyDelete: async ids => { deleted.push(ids); } }, source, { modules: {
    "../i18n": locale,
    "@tauri-apps/api/window": { getCurrentWindow: () => ({ close: async () => {} }) },
  } });
  const props = { kind, title, message, confirmLabel, ids, localize };
  const dialog = harness.mount("ConfirmWindow", props);
  for (const language of languages) {
    locale.setLanguage(language);
    assert.ok(nodes(dialog.render()).includes(dictionaries[language][props.confirmLabel].replace("{n}", "2")));
  }
  nodes(dialog.render()).find(node => node?.type === "button" && node.props.className.includes("destructive")).props.onClick();
  await settleRequests();
  assert.deepEqual(deleted, [assets.map(asset => asset.id)], "language changes must preserve the selected delete IDs");
  locale.setLanguage("fr");
  for (const localize of [false, undefined]) {
    const raw = { ...props, kind: "custom", title: "Empty Trash?", message: "Keep {n} and /capture/path.png verbatim", confirmLabel: "Delete Permanently (N)", localize };
    const text = nodes(dialog.render(raw));
    assert.ok(text.includes(raw.title)); assert.ok(text.includes(raw.message)); assert.ok(text.includes(raw.confirmLabel));
    assert.ok(text.includes(dictionaries.fr.Cancel));
  }
  library.unmount(); dialog.unmount();
});
