"""Windows-only experiment. Run with the pinned nbocr checkout and a new output directory."""
import argparse
from collections import Counter
from http.server import BaseHTTPRequestHandler, HTTPServer
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from threading import Thread
import zipfile

from PIL import Image


TARGET = "x86_64-pc-windows-msvc"
REV = "96eacca7ec881227d3f0d705f3678714bc988911"
HELPER = "ocr-runtime/nbocr.exe"
PORTABLE = "Kiri-1.6.36-Windows-x64-Portable"
MODEL_DIGESTS = {
    "PP-OCRv6_small_det.mnn": "2c6277abbbddb4c77a790f4650cdd7f8ab33512db38fac372ed5471538070619",
    "PP-OCRv6_small_rec.mnn": "ed59cc294fe2d564bd64f929b5356b70abd0977f99e7e60e3b08cfeef4ef72be",
    "ppocr_keys_v6_small.txt": "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
}
LABELS = ["新建连接", "新建查询", "数据传输", "驱动管理", "插件中心", "更多", "导入/导出", "搜索"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def download(file, url, digest):
    subprocess.run(["curl.exe", "--proto", "=https", "--proto-redir", "=https", "--fail", "--location",
                    "--silent", "--show-error", "--retry", "3", "--max-time", "120", "--output", file, url],
                   check=True)
    if sha(file.read_bytes()) != digest:
        raise ValueError(f"Invalid {file.name} SHA-256")
    return file


def build_pair(upstream, work):
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=upstream, text=True).strip() != REV:
        raise ValueError("Unexpected upstream source revision")
    archive = download(work / "mnn.zip",
                       "https://github.com/zibo-chen/MNN-Prebuilds/releases/download/dev/mnn-dev-windows-x86_64.zip",
                       "24166165d7451423aef3ebe6694651bad117bcdfc32261652b8f8275961ab91a")
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(work)
    mnn = work / "mnn-dev-windows-x86_64"
    static_lib = work / "static-lib"
    static_lib.mkdir()
    # The upstream MNN.lib is the DLL import library. Supply only the /MT static archive.
    shutil.copyfile(mnn / "lib/MNN_static.lib", static_lib / "MNN.lib")
    env = dict(os.environ, MNN_INCLUDE_DIR=str(mnn / "include"), MNN_LIB_DIR=str(static_lib),
               CARGO_TARGET_DIR=str(work / "target"), CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-C target-feature=+crt-static")
    clang = Path(os.environ["ProgramFiles"]) / "LLVM/bin"
    if "LIBCLANG_PATH" not in env and (clang / "libclang.dll").is_file():
        env["LIBCLANG_PATH"] = str(clang)
    subprocess.run(["cargo", "fetch", "--locked", "--target", TARGET], cwd=upstream, env=env, check=True)
    pair = {}
    for name, features in [("control", "ocr-rs/mnn-static,embed-det-v6-tiny,embed-rec-v6-tiny"),
                           ("lean", "ocr-rs/mnn-static")]:
        subprocess.run(["cargo", "build", "--locked", "--offline", "--profile", "dist", "--target", TARGET,
                        "--no-default-features", "--features", features], cwd=upstream, env=env, check=True)
        pair[name] = work / f"{name}.exe"
        shutil.copyfile(work / "target" / TARGET / "dist/nbocr.exe", pair[name])
    return pair


def fixtures(work):
    source = download(work / "issue.png",
                      "https://github.com/user-attachments/assets/debb425b-1a24-4e25-aa56-b21c139342b3",
                      "51428de50b28f312e39fcb78a31e22276ef026e56f6932869e8aaa1a213248c7")
    toolbar = Image.open(source).convert("RGBA").crop((32, 33, 625, 138))
    for name, size, offset, digest in [
        ("tight", (600, 110), (4, 3), "9574d09ee913adec91fb5fde82c06a5c9f3b5a24bae7653fe22df974db233d4e"),
        ("wide", (622, 136), (14, 14), "31f11544745140d361bb7fa4056eae9099e06cc765c7f7cdfe45cf1f6b1889d6"),
    ]:
        frame = Image.new("RGBA", size, (39, 39, 39, 255))
        frame.paste(toolbar, offset)
        if sha(frame.tobytes()) != digest:
            raise ValueError(f"Incorrect {name} fixture pixels")
        frame.save(work / f"{name}.png")
    Image.new("RGB", (295, 35), "white").save(work / "blank.png")
    return {k: work / f"{k}.png" for k in ("tight", "wide", "blank")} | {
        "latin": Path(__file__).resolve().parents[2] / "src-tauri/tests/fixtures/linux-ocr.png"}


def run_helper(exe, models, png, env):
    return subprocess.run([exe, "recognize", "--det-model", "v6-small", "--models-dir", ".", "--language", "zh",
                        "--format", "jsonl", png], cwd=models, env=env, capture_output=True, timeout=60)


def recognize(exe, models, png, env):
    p = run_helper(exe, models, png, env)
    p.check_returncode()
    records = [json.loads(line) for line in p.stdout.splitlines() if line.startswith(b"{")]
    if len(records) != 1:
        raise ValueError("Expected exactly one recognition record")
    # Match Kiri's fixed row anchor and then ascending x (src-tauri/src/ocr/paddle.rs).
    def center(row):
        return 2 * row["bbox"]["y"] + row["bbox"]["height"]
    regions = sorted((r for r in records[0]["results"] if r["text"].strip()), key=center)
    lines = []
    while regions:
        first = regions[0]
        end = next((i for i, r in enumerate(regions) if center(r) - center(first) > first["bbox"]["height"]), len(regions))
        lines.append(" ".join(r["text"].strip() for r in sorted(regions[:end], key=lambda r: r["bbox"]["x"])))
        regions = regions[end:]
    return "\n".join(lines)


def compare_texts(name, results):
    for counts in results.values():
        for text in counts:
            if name in ("tight", "wide"):
                remaining = text
                for label in LABELS:
                    if label not in remaining:
                        raise ValueError(f"{name} did not contain {label} in reading order")
                    remaining = remaining.split(label, 1)[1]
            if name == "blank" and text:
                raise ValueError("Blank input yielded text")
            if name == "latin" and "KIRI LINUX 123" not in text:
                raise ValueError("Missing Latin text")
    stock, control, lean = (set(results[key]) for key in ("official", "control", "lean"))
    if stock == control == lean:
        return "identical observed output sets"
    # Require every candidate string verbatim, including any icon, in real baseline runs.
    # A known tight-crop example is an optional final ★. No symbols are normalized.
    if lean <= (stock | control):
        return "all lean outputs observed verbatim in measured baselines"
    raise ValueError(f"{name} produced a new candidate output: {lean - stock - control}")


def package(official, helper, dest):
    shutil.copyfile(official, dest)
    update = r"""
        $ErrorActionPreference = 'Stop'
        $zip = [IO.Compression.ZipFile]::Open($env:OCR_ZIP, 'Update')
        try {
            $zip.GetEntry($env:OCR_ENTRY).Delete()
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $env:OCR_HELPER, $env:OCR_ENTRY, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        } finally {$zip.Dispose()}
    """
    subprocess.run(["pwsh", "-NoProfile", "-Command", update], check=True,
                   env=dict(os.environ, OCR_ZIP=str(dest.resolve()), OCR_ENTRY=HELPER, OCR_HELPER=str(helper.resolve())))
    with zipfile.ZipFile(official) as src, zipfile.ZipFile(dest) as out:
        if Counter(src.namelist()) != Counter(out.namelist()) or out.testzip():
            raise ValueError("Bad portable archive")
        for name in src.namelist():
            if name == HELPER:
                if out.read(name) != helper.read_bytes():
                    raise ValueError("Packaged helper differs from the tested helper")
            elif src.getinfo(name).compress_size != out.getinfo(name).compress_size or src.read(name) != out.read(name):
                raise ValueError(f"Unexpected change in {name}")
        return {"zip_bytes": dest.stat().st_size, "zip_sha256": sha(dest.read_bytes()),
                "helper_bytes": helper.stat().st_size, "helper_deflated": out.getinfo(HELPER).compress_size,
                "helper_sha256": sha(helper.read_bytes())}


def verify_tiny_inputs(upstream, helpers):
    tiny_inputs = ["PP-OCRv6_tiny_det.mnn", "PP-OCRv6_tiny_rec.mnn", "ppocr_keys_v6_tiny.txt"]
    for name in tiny_inputs:
        data = (upstream / "models" / name).read_bytes()
        # The official Windows dictionary uses CRLF; checkout settings can yield LF.
        chunks = [data] if name.endswith(".mnn") else [data.replace(b"\r\n", b"\n"), data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")]
        for variant, exe in helpers.items():
            payload = exe.read_bytes()
            if any(chunk in payload for chunk in chunks) != (variant != "lean"):
                raise ValueError(f"Unexpected embedded {name} in {variant}")


class RejectModelDownload(BaseHTTPRequestHandler):
    def do_CONNECT(self):
        self.server.requests.append(self.path)
        self.send_error(403, "Offline OCR test")

    do_GET = do_CONNECT

    def log_message(self, *args):
        pass


def verify_download_block(exe, empty, png, proxy, env):
    before = len(proxy.requests)
    result = run_helper(exe, empty, png, env)
    attempts = proxy.requests[before:]
    if result.returncode == 0 or not attempts or any(empty.iterdir()):
        raise ValueError("Missing-model control did not fail through the rejecting proxy")
    return len(attempts)


def main(args, work):
    zipfile_path = download(work / "official.zip", f"https://github.com/yuxino/Kiri/releases/download/v1.6.36/{PORTABLE}.zip",
                            "97e59195bded0c0f198e20f72660213c4fc3da84491d58e918e0e512c8c7155c")
    with zipfile.ZipFile(zipfile_path) as z:
        released_size = z.getinfo(HELPER).compress_size
        z.extractall(work / "original")
    models = work / "original/ocr-runtime"
    for name, digest in MODEL_DIGESTS.items():
        if sha((models / name).read_bytes()) != digest:
            raise ValueError(f"Invalid external model: {name}")
    samples = fixtures(work)
    empty = work / "missing-models"
    empty.mkdir()
    # nbocr 0.2.3 uses ureq's environment proxy for its sole model download path.
    # Check each real binary with models missing, then require zero requests with models present.
    with HTTPServer(("127.0.0.1", 0), RejectModelDownload) as proxy:
        proxy.requests = []
        thread = Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        address = f"http://127.0.0.1:{proxy.server_port}"
        env = dict(os.environ, HTTPS_PROXY=address, HTTP_PROXY=address, ALL_PROXY=address, NO_PROXY="")
        try:
            probes = {"official": verify_download_block(models / "nbocr.exe", empty, samples["blank"], proxy, env)}
            helpers = {"official": models / "nbocr.exe", **build_pair(args.upstream.resolve(), work)}
            verify_tiny_inputs(args.upstream, helpers)
            report = {"upstream_commit": REV, "target": TARGET, "rustc": subprocess.check_output(["rustc", "-Vv"], text=True).strip(),
                      "official_zip_bytes": zipfile_path.stat().st_size, "official_helper_deflated": released_size,
                      "small_sha256": MODEL_DIGESTS, "packages": {}, "quality": {}}
            for key in ("control", "lean"):
                probes[key] = verify_download_block(helpers[key], empty, samples["blank"], proxy, env)
            before = len(proxy.requests)
            for name, png in samples.items():
                rounds = 20 if name in ("tight", "wide") else 2
                results = {key: Counter(recognize(exe, models, png, env) for _ in range(rounds))
                           for key, exe in helpers.items()}
                report["quality"][name] = {"comparison": compare_texts(name, results), "runs": results}
            real_requests = len(proxy.requests) - before
            if real_requests:
                raise ValueError("Recognition with the bundled small models attempted a download")
            report["download_checks"] = {"rejected_missing_model_requests": probes, "recognition_requests": real_requests}
        finally:
            proxy.shutdown()
            thread.join()
    for name, helper in helpers.items():
        dest = args.output / f"{PORTABLE}-no-tiny-candidate.zip" if name == "lean" else work / f"{name}-repacked.zip"
        report["packages"][name] = package(zipfile_path, helper, dest)
    saving = report["packages"]["control"]["zip_bytes"] - report["packages"]["lean"]["zip_bytes"]
    report["same_source_zip_bytes_saved"] = saving
    if saving <= 0:
        raise ValueError("No measured package saving")
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["packages"], indent=2))


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("upstream", type=Path)
    cli.add_argument("output", type=Path)
    args = cli.parse_args()
    if os.name != "nt":
        cli.error("Use a Windows x64 build desktop with Rust 1.98, MSVC, LLVM, Pillow and pwsh")
    args.output.mkdir()
    with tempfile.TemporaryDirectory(prefix="kiri-ocr-ab-") as scratch:
        main(args, Path(scratch))
