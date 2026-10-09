import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

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
