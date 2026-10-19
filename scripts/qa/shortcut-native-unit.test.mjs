import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertApplicationDependencies, libraryManifest } from "./shortcut-native-unit.mjs";

test("native shortcut unit manifest keeps actual library dependencies and skips GUI examples", () => {
  const original = readFileSync(new URL("../../src-tauri/vendor/global-hotkey/Cargo.toml", import.meta.url), "utf8");
  const manifest = libraryManifest(original, "C:\\source checkout\\global-hotkey\\src\\lib.rs");
  assert.match(manifest, /path = "C:\/source checkout\/global-hotkey\/src\/lib.rs"/);
  assert.doesNotMatch(manifest, /\[\[example\]\]|\[dev-dependencies/);
  for (const platform of ["windows", "macos", "linux"]) assert.ok(manifest.includes(`target_os = "${platform}"`));
  assert.ok(manifest.includes("[dependencies.keyboard-types]"));
  assert.ok(manifest.includes("[features]"));
  assert.throws(() => libraryManifest("[lib]\npath = \"other.rs\"", "/src/lib.rs"), /library path changed/);
});

test("native shortcut dependency pruning cannot change locked version, origin or checksum", () => {
  const entry = (name, version, source = "registry+https://example.test", checksum = "abc") =>
    `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "${source}"\nchecksum = "${checksum}"\n`;
  const used = entry("used", "1.0.0");
  const application = used + entry("unused", "2.0.0");
  assert.doesNotThrow(() => assertApplicationDependencies(application, used));
  for (const changed of [entry("used", "1.0.1"), entry("used", "1.0.0", "other"), entry("used", "1.0.0", undefined, "xyz")]) {
    assert.throws(() => assertApplicationDependencies(application, changed), /absent from the application Cargo.lock/);
  }
  assert.throws(() => assertApplicationDependencies(application, ""), /no packages/);
});
