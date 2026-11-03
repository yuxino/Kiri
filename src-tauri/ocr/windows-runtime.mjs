// Build-time only. The Windows installer and portable ZIP ship these same files.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = "0.2.3";
const filename = "newbee_ocr_cli-x86_64-pc-windows-msvc.zip";
const url = `https://github.com/zibo-chen/newbee-ocr-cli/releases/download/v${version}/${filename}`;
const archiveHash = "78fb6fe4a963fea9e2273c8fb6b8926cb8929ae4a10dd96dba8c549fabd6a8df";
const archiveMembers = {
  "nbocr.exe": "11e8ca14a406f20cc1545b8c4e15a0117a45ea9b5224376407f9b7237102a527",
  "LICENSE": "ff63d2d59027b11a236e5e797ece0a7c2bb8ffeacd98cd6ff2877a34911c7d32",
};
const modelsUrl = "https://raw.githubusercontent.com/zibo-chen/ocr-rs/7368dfa292ab988e8431de4ec952f015bec40635/models";
const models = {
  "PP-OCRv6_small_det.mnn": "2c6277abbbddb4c77a790f4650cdd7f8ab33512db38fac372ed5471538070619",
  "PP-OCRv6_small_rec.mnn": "ed59cc294fe2d564bd64f929b5356b70abd0977f99e7e60e3b08cfeef4ef72be",
  "ppocr_keys_v6_small.txt": "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
};
const members = { ...archiveMembers, ...models };
const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.resolve(here, "../target/ocr-runtime");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function verifyMembers(directory) {
  for (const [name, digest] of Object.entries(members)) {
    if (hash(readFileSync(path.join(directory, name))) !== digest) {
      throw new Error(`Invalid Windows OCR resource: ${name}`);
    }
  }
}

function download(source, destination) {
  execFileSync("curl", ["--proto", "=https", "--proto-redir", "=https", "--fail", "--location",
    "--silent", "--show-error", "--connect-timeout", "15", "--max-time", "120", "--retry", "2",
    "--output", destination, source], { stdio: "inherit" });
}

function prepare() {
  try {
    verifyMembers(cache);
    return;
  } catch {
    // A missing or stale build cache must be reconstructed from the pinned archive.
  }
  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(path.join(cache, ".prepare-"));
  try {
    const archive = path.join(staging, filename);
    download(url, archive);
    if (hash(readFileSync(archive)) !== archiveHash) throw new Error("Windows OCR archive checksum mismatch");
    // Extract only the named regular payloads as bytes, never archive paths.
    for (const name of Object.keys(archiveMembers)) {
      const bytes = process.platform === "win32"
        ? execFileSync(path.join(process.env.SystemRoot, "System32", "tar.exe"), ["-xOf", archive, name], { maxBuffer: 20 * 1024 * 1024 })
        : execFileSync("unzip", ["-p", archive, name], { maxBuffer: 20 * 1024 * 1024 });
      writeFileSync(path.join(staging, name), bytes);
    }
    for (const name of Object.keys(models)) download(`${modelsUrl}/${name}`, path.join(staging, name));
    verifyMembers(staging);
    for (const name of Object.keys(members)) renameSync(path.join(staging, name), path.join(cache, name));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--verify" && process.argv.length === 4) {
  const dir = process.argv[3];
  verifyMembers(dir);
  const contents = readdirSync(dir).sort();
  if (contents.join(",") !== [...Object.keys(members), "NOTICE.txt"].sort().join(",")) {
    throw new Error("Unexpected file in the Windows OCR resource directory");
  }
  const notice = (directory) => readFileSync(path.join(directory, "NOTICE.txt"), "utf8").replaceAll("\r\n", "\n");
  if (notice(dir) !== notice(here)) {
    throw new Error("Windows OCR attribution missing or changed");
  }
} else if (process.argv.length === 2) {
  prepare();
} else {
  throw new Error("Usage: node windows-runtime.mjs [--verify <packaged-ocr-directory>]");
}
