import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as parser from "../src/settings/release-notes.js";
import { createLibraryHarness, nodes } from "./helpers/library-render-harness.mjs";

const { splitReleaseNotes, preferredReleaseNotesLanguage, releaseNotesBlocks, releaseNotesInline } = parser;

const bilingual = `Shared installation requirement.

## English
- Improve **scrolling capture**.
- Keep the original app focused.

## 中文
- 改善**滚动截图**。
- 保持原应用焦点。

## Downloads
Use the signed package. SHA256: abc123`;

test("bilingual release notes follow Chinese locales and otherwise fall back to English", () => {
  const { languages } = splitReleaseNotes(bilingual);
  assert.deepEqual(languages, [{ id: "en", label: "English" }, { id: "zh", label: "中文" }]);
  for (const locale of ["zh-Hans", "zh-Hant", "zh-CN", "zh_TW"]) {
    assert.equal(preferredReleaseNotesLanguage(languages, locale), "zh");
  }
  for (const locale of ["en", "ja", "de", "fr", "ko"]) {
    assert.equal(preferredReleaseNotesLanguage(languages, locale), "en");
  }
  assert.equal(preferredReleaseNotesLanguage([{ id: "zh", label: "中文" }], "fr"), "zh");
  assert.equal(preferredReleaseNotesLanguage([], "zh-Hant"), null);
});

test("shared introductions and sections survive language selection, including CRLF input", () => {
  const { parts } = splitReleaseNotes(bilingual.replaceAll("\n", "\r\n"));
  const selected = (language) => parts.filter((part) => !part.language || part.language === language).map((part) => part.text).join("\n");
  for (const language of ["en", "zh"]) {
    assert.match(selected(language), /Shared installation requirement/);
    assert.match(selected(language), /SHA256: abc123/);
  }
  assert.doesNotMatch(selected("zh"), /Improve/);
  assert.doesNotMatch(selected("en"), /改善/);
  assert.match(selected("en"), /\*\*scrolling capture\*\*/);
});

test("unsectioned notes and fenced language-like headings retain their content", () => {
  const notes = "# Release 1.2\nPlain content.\n\n```text\n## 中文\nNot a language boundary\n```";
  const parsed = splitReleaseNotes(notes);
  assert.deepEqual(parsed.languages, []);
  assert.deepEqual(parsed.parts, [{ language: null, text: notes }]);
  assert.deepEqual(releaseNotesBlocks(parsed.parts[0].text), [
    { type: "heading", text: "Release 1.2" },
    { type: "paragraph", text: "Plain content." },
    { type: "code", text: "## 中文\nNot a language boundary" },
  ]);
});

test("headings, paragraphs, lists and continuation lines render as separate readable blocks", () => {
  assert.deepEqual(releaseNotesBlocks("### Fixes\nTwo lines\nform a paragraph.\n\n- First item\n  continued\n- Second item\n\n1. Download\n2. Install"), [
    { type: "heading", text: "Fixes" },
    { type: "paragraph", text: "Two lines form a paragraph." },
    { type: "list", ordered: false, items: ["First item continued", "Second item"] },
    { type: "list", ordered: true, items: ["Download", "Install"] },
  ]);
});

test("inline formatting keeps links and images inert and preserves destinations", () => {
  assert.deepEqual(releaseNotesInline("Use **Kiri** and `file.dmg`: [Download](https://example.test/file) ![Preview](https://example.test/image.png)"), [
    { type: "text", text: "Use " }, { type: "strong", text: "Kiri" },
    { type: "text", text: " and " }, { type: "code", text: "file.dmg" },
    { type: "text", text: ": " }, { type: "link", text: "Download", destination: "https://example.test/file" },
    { type: "text", text: " " }, { type: "link", text: "Preview", destination: "https://example.test/image.png" },
  ]);
});

const require = createRequire(import.meta.url);
let locale = "en";
const module = { exports: {} };
const source = readFileSync(new URL("../src/settings/ReleaseNotes.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
new Function("require", "module", "exports", compiled)((name) => {
  if (name === "../i18n") return { t: (key) => key, getLanguage: () => locale, onLanguageChange: () => () => {} };
  if (name === "./release-notes.js") return parser;
  return require(name);
}, module, module.exports);
const { ReleaseNotes } = module.exports;
const render = (notes) => renderToStaticMarkup(React.createElement(ReleaseNotes, { notes }));

test("real release-notes markup selects locale, exposes both languages and retains common info", () => {
  locale = "zh-Hant";
  const chinese = render(bilingual);
  assert.match(chinese, /aria-pressed="true" lang="zh"/);
  assert.match(chinese, /改善<strong>滚动截图<\/strong>/);
  assert.doesNotMatch(chinese, /Improve/);
  assert.match(chinese, /Shared installation requirement/);
  assert.match(chinese, /SHA256: abc123/);
  assert.match(chinese, /aria-pressed="false" lang="en"/);
  locale = "de";
  const english = render(bilingual);
  assert.match(english, /Improve <strong>scrolling capture<\/strong>/);
  assert.doesNotMatch(english, /改善/);
});

test("release-note HTML and URL payloads cannot create executable markup or fetch media", () => {
  const html = render('<img src="https://example.test/tracker" onerror="alert(1)">\n\n**<script>alert(1)</script>**\n\n[click](javascript:evil) ![pixel](https://example.test/pixel)');
  assert.doesNotMatch(html, /<(?:img|script|a)\b|<[^>]+\s(?:href|src|onerror)=/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /title="javascript:evil"/);
  assert.match(html, /title="https:\/\/example.test\/pixel"/);
});

test("language switching retains common notes and follows later locale or release changes", () => {
  let currentLocale = "zh-Hans";
  // The hook harness models state and handlers. Supply its external snapshot
  // explicitly; browser QA verifies real subscriptions and element geometry.
  const clientSource = source.replace(
    'import { useMemo, useState, useSyncExternalStore } from "react";',
    'import React, { useMemo, useState } from "react"; const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();',
  );
  const h = createLibraryHarness({}, clientSource, { modules: {
    "./release-notes.js": parser,
    "../i18n": { t: (key) => key, getLanguage: () => currentLocale, onLanguageChange: () => () => {} },
  } });
  const c = h.mount("ReleaseNotes", { notes: bilingual });
  const text = () => nodes(c.render()).filter((node) => typeof node === "string").join(" ");
  assert.match(text(), /改善/);
  nodes(c.render()).find((node) => node?.type === "button" && node.props.lang === "en").props.onClick();
  assert.match(text(), /Improve/);
  assert.doesNotMatch(text(), /改善/);
  assert.match(text(), /SHA256: abc123/);
  currentLocale = "zh-Hant";
  assert.match(text(), /改善/);
  nodes(c.render()).find((node) => node?.type === "button" && node.props.lang === "en").props.onClick();
  assert.match(text(), /Improve/);
  c.render({ notes: `${bilingual}\nUpdated common requirement.` });
  assert.match(text(), /改善/);
  assert.match(text(), /Updated common requirement/);
  c.unmount();
});
