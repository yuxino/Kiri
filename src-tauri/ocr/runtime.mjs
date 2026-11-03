// Build-time only. The same verified model files are used on every desktop.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.resolve(here, "../target/ocr-runtime");
const windows = "x86_64-pc-windows-msvc";
const universal = "universal-apple-darwin";
const helperVersion = "0.2.3";
const builds = {
  [windows]: [
    "78fb6fe4a963fea9e2273c8fb6b8926cb8929ae4a10dd96dba8c549fabd6a8df",
    "11e8ca14a406f20cc1545b8c4e15a0117a45ea9b5224376407f9b7237102a527",
  ],
  "aarch64-apple-darwin": [
    "cf587aeb9ce7df44eb6d89d515d06ceef3ac5566dee81936f15d0e37b6c20744",
    "42c7c86a8a133c83f599ce1079fa710daf2902a88503420dc40ba1a59ecb1129",
  ],
  "x86_64-apple-darwin": [
    "a7f89f50897d8bfd00f020e205fb9c5265ac2807d146ca87e7898a67675cb4b0",
    "f5938ca888358e631c5eec1fb38af347567c55e4bcb5e36024c2ad84c8068abb",
  ],
  "aarch64-unknown-linux-gnu": [
    "555145384af2c004fdc2bde25226ccc60b03669e2f3f6b222605dfa882b2d7ea",
    "c5c63745f17a9025ade874095506bf3b6af82d8143e3de6b555739d41d51d08f",
  ],
  "x86_64-unknown-linux-gnu": [
    "5e34f9c4d076e2e7034f655836e1031ec99abe287ffd0d375fda35cdec10eabc",
    "966fab697dc5f4c3f79fc04aae77468ed12c6cc13a416ba1a67c491e193f8bdf",
  ],
};
const modelsUrl = "https://raw.githubusercontent.com/zibo-chen/ocr-rs/7368dfa292ab988e8431de4ec952f015bec40635/models";
const models = {
  "PP-OCRv6_small_det.mnn": "2c6277abbbddb4c77a790f4650cdd7f8ab33512db38fac372ed5471538070619",
  "PP-OCRv6_small_rec.mnn": "ed59cc294fe2d564bd64f929b5356b70abd0977f99e7e60e3b08cfeef4ef72be",
  "ppocr_keys_v6_small.txt": "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
};

function verifyFile(file, digest) {
  if (createHash("sha256").update(readFileSync(file)).digest("hex") !== digest) {
    throw new Error(`Invalid OCR resource: ${path.basename(file)}`);
  }
}

function download(source, destination) {
  execFileSync("curl", ["--proto", "=https", "--proto-redir", "=https", "--fail", "--location",
    "--silent", "--show-error", "--connect-timeout", "15", "--max-time", "120", "--retry", "2",
    "--output", destination, source], { stdio: "inherit" });
}

// A build sees either a previously verified complete file or the new one.
// Keep immutable target-specific sidecars separate for concurrent cross builds.
function materialize(file, digest, create) {
  try {
    verifyFile(file, digest);
    return;
  } catch {
    // Missing or stale cache entry.
  }
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const stage = mkdtempSync(path.join(dir, ".prepare-"));
  try {
    const candidate = path.join(stage, path.basename(file));
    create(candidate, stage);
    verifyFile(candidate, digest);
    renameSync(candidate, file);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function prepareHelper(target) {
  const win = target === windows;
  const file = path.join(cache, win ? "nbocr.exe" : `kiri-ocr-${target}`);
  const [archiveDigest, executableDigest] = builds[target];
  materialize(file, executableDigest, (candidate, stage) => {
    const stem = `newbee_ocr_cli-${target}`;
    const filename = stem + (win ? ".zip" : ".tar.xz");
    const archive = path.join(stage, filename);
    download(`https://github.com/zibo-chen/newbee-ocr-cli/releases/download/v${helperVersion}/${filename}`, archive);
    verifyFile(archive, archiveDigest);
    const limits = { maxBuffer: 32 * 1024 * 1024 };
    const bytes = win && process.platform !== "win32"
      ? execFileSync("unzip", ["-p", archive, "nbocr.exe"], limits)
      : execFileSync(process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar",
        ["-xOf", archive, win ? "nbocr.exe" : `${stem}/nbocr`], limits);
    writeFileSync(candidate, bytes);
    if (!win) chmodSync(candidate, 0o755);
  });
  return file;
}

function prepare(target) {
  for (const [name, digest] of Object.entries(models)) {
    materialize(path.join(cache, "models", name), digest, dest => download(`${modelsUrl}/${name}`, dest));
  }
  if (target !== universal) {
    prepareHelper(target);
    return;
  }
  // The CLI builds the app slices separately. Its bundle hook supplies the
  // final universal target needed by Tauri's externalBin naming convention.
  const slices = ["aarch64-apple-darwin", "x86_64-apple-darwin"].map(prepareHelper);
  const stage = mkdtempSync(path.join(cache, ".universal-"));
  try {
    const file = path.join(stage, `kiri-ocr-${target}`);
    execFileSync("/usr/bin/lipo", ["-create", ...slices, "-output", file]);
    execFileSync("/usr/bin/lipo", [file, "-verify_arch", "arm64", "x86_64"]);
    renameSync(file, path.join(cache, path.basename(file)));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function verifyPackage(target, dir, helper) {
  const expected = [...Object.keys(models), "LICENSE", "NOTICE.txt"];
  if (target === windows) expected.push("nbocr.exe");
  if (readdirSync(dir).sort().join(",") !== expected.sort().join(",")) throw new Error("Unexpected OCR resource set");
  for (const [name, digest] of Object.entries(models)) verifyFile(path.join(dir, name), digest);
  for (const name of ["LICENSE", "NOTICE.txt"]) {
    const readText = root => readFileSync(path.join(root, name), "utf8").replaceAll("\r\n", "\n");
    if (readText(dir) !== readText(here)) throw new Error(`Incorrect OCR attribution: ${name}`);
  }
  // The Universal helper is re-signed inside the .app and checked by the DMG gate.
  if (target !== universal) verifyFile(target === windows ? path.join(dir, "nbocr.exe") : helper, builds[target][1]);
}

// Exercise the binary shipped beside the app using only a public test fixture.
function smoke(helper, dir, architecture) {
  const fixture = path.resolve(here, "../tests/fixtures/linux-ocr.png");
  const args = ["recognize", "--det-model", "v6-small", "--models-dir", ".", "--language", "zh", "--format", "jsonl", fixture];
  const output = execFileSync(architecture ? "/usr/bin/arch" : helper,
    architecture ? [`-${architecture}`, helper, ...args] : args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
  const json = output.split(/\r?\n/).find(line => line.startsWith("{"));
  if (!json || !JSON.parse(json).results.some(row => row.text.includes("KIRI LINUX 123"))) {
    throw new Error("Packaged OCR helper did not recognize the smoke fixture");
  }
}

const [action, target, directory, helper, architecture] = process.argv.slice(2);
const triple = target || process.env.TAURI_ENV_TARGET_TRIPLE;
if (triple !== universal && !Object.hasOwn(builds, triple)) throw new Error(`Unsupported OCR build target: ${triple}`);
if (action === "--smoke" && directory && helper) {
  verifyPackage(triple, directory, helper);
  smoke(path.resolve(helper), path.resolve(directory), architecture);
} else if (action === "--verify" && directory) verifyPackage(triple, directory, helper);
else if (action === "--prepare") prepare(triple);
else throw new Error("Usage: runtime.mjs --prepare [target] | --verify <target> <resources> [helper] | --smoke <target> <resources> <helper> [mac-arch]");
