#!/usr/bin/env node
// Exercise the vendored platform mappings without resolving GUI example crates.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function libraryManifest(manifest, sourcePath) {
  const libraryPath = /^path = "src\/lib\.rs"\r?$/m;
  if (!libraryPath.test(manifest)) throw new Error("Vendored library path changed; update the test harness.");
  return manifest
    .replace(/^\[\[example\]\]\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/gm, "")
    .replace(/^\[dev-dependencies(?:\.[^\]]+)?\]\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/gm, "")
    .replace(libraryPath, `path = ${JSON.stringify(sourcePath.replaceAll("\\", "/"))}`);
}

function packageIdentities(lockfile) {
  // Cargo writes these scalar fields in a stable format. Dependencies may be
  // pruned for this smaller crate; package versions, sources and checksums may not.
  const identities = lockfile.split(/^\[\[package\]\]\r?$/m).slice(1).map((block) => {
    const fields = ["name", "version", "source", "checksum"].map((key) =>
      block.match(new RegExp(`^${key} = (.+)$`, "m"))?.[1]?.trim() ?? "");
    if (!fields[0] || !fields[1]) throw new Error("Invalid Cargo lockfile package.");
    return JSON.stringify(fields);
  });
  if (!identities.length) throw new Error("Cargo lockfile has no packages.");
  return new Set(identities);
}

export function assertApplicationDependencies(applicationLock, testLock) {
  const applicationPackages = packageIdentities(applicationLock);
  for (const identity of packageIdentities(testLock)) {
    if (!applicationPackages.has(identity)) {
      throw new Error(`Shortcut test dependency is absent from the application Cargo.lock: ${identity}`);
    }
  }
}

function runCargo(args, env) {
  const result = spawnSync("cargo", args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cargo shortcut checks failed (${result.signal ?? result.status}).`);
}

export function main() {
  const temporary = mkdtempSync(join(tmpdir(), "kiri-shortcut-native-unit-"));
  try {
    const vendor = join(root, "src-tauri/vendor/global-hotkey");
    const manifest = join(temporary, "Cargo.toml");
    const lock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
    writeFileSync(manifest, libraryManifest(readFileSync(join(vendor, "Cargo.toml"), "utf8"), join(vendor, "src/lib.rs")));
    writeFileSync(join(temporary, "Cargo.lock"), lock);
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(root, "src-tauri/target"),
    };
    const common = ["--offline", "--manifest-path", manifest, "--features", "serde"];
    // An independent root needs Cargo to prune the copied application lockfile.
    // Resolve offline, reject dependency drift, then run with the lock frozen.
    runCargo(["tree", ...common, "--depth", "0"], env);
    assertApplicationDependencies(lock, readFileSync(join(temporary, "Cargo.lock"), "utf8"));
    runCargo(["test", ...common, "--locked", "--lib"], env);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
