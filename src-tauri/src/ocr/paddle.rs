//! Bundled offline PP-OCRv6 small. The detector and multilingual recognizer
//! use the same weights for every supported language.

use anyhow::{anyhow, ensure, Result};
use serde::Deserialize;
use std::io::{Read, Seek, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
#[cfg(windows)]
use tempfile::{Builder, NamedTempFile};

pub(super) fn recognize(directory: &Path, png: &[u8]) -> Result<String> {
    #[cfg(windows)]
    let executable = directory.join("nbocr.exe");
    #[cfg(unix)]
    let executable = std::env::current_exe()?.with_file_name("kiri-ocr");
    run(&executable, directory, png)
}

#[cfg(windows)]
fn temporary_file(suffix: &str) -> std::io::Result<NamedTempFile> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_TEMPORARY, FILE_FLAG_DELETE_ON_CLOSE,
    };
    // The helper opens the image by name; Windows deletes it at last close.
    Builder::new()
        .prefix("kiri-ocr-")
        .rand_bytes(16)
        .suffix(suffix)
        .make(|path| {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .custom_flags((FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE).0)
                .open(path)
        })
}

const MODEL_FILES: [&str; 3] = [
    "PP-OCRv6_small_det.mnn",
    "PP-OCRv6_small_rec.mnn",
    "ppocr_keys_v6_small.txt",
];

#[cfg(windows)]
fn open_model_files(directory: &Path) -> Result<Vec<std::fs::File>> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::FILE_SHARE_READ;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).share_mode(FILE_SHARE_READ.0);
    MODEL_FILES
        .iter()
        .map(|name| {
            let file = options
                .open(directory.join(name))
                .map_err(|_| anyhow!("Bundled OCR model file is unavailable"))?;
            ensure!(file.metadata()?.is_file(), "Invalid bundled OCR model file");
            Ok(file)
        })
        .collect()
}

#[cfg(unix)]
fn private_model_directory(directory: &Path) -> Result<tempfile::TempDir> {
    use std::os::unix::fs::PermissionsExt;
    let private = tempfile::Builder::new()
        .prefix("kiri-ocr-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()?;
    // nbocr will download any missing model. A private snapshot keeps all
    // names alive even when a package update removes the installed files.
    for name in MODEL_FILES {
        let source = directory.join(name);
        let destination = private.path().join(name);
        if !source.is_file() {
            return Err(anyhow!("Bundled OCR model file is unavailable"));
        }
        if std::fs::hard_link(&source, &destination).is_err() {
            // Cross-filesystem tempdir, or Linux protected_hardlinks.
            std::fs::copy(&source, &destination)?;
        }
    }
    Ok(private)
}

fn run(executable: &Path, directory: &Path, png: &[u8]) -> Result<String> {
    ensure!(executable.is_file(), "Local model is unavailable");
    #[cfg(windows)]
    let _model_files = open_model_files(directory)?;
    #[cfg(windows)]
    let input = {
        let mut file = temporary_file(".png")?;
        file.write_all(png)?;
        file
    };
    #[cfg(unix)]
    let private = private_model_directory(directory)?;
    #[cfg(unix)]
    let directory = private.path();
    let mut command = Command::new(executable);
    command.args([
        "recognize",
        "--det-model",
        "v6-small",
        "--models-dir",
        ".",
        "--language",
        "zh",
        "--format",
        "jsonl",
    ]);
    #[cfg(windows)]
    command.arg(input.path()).stdin(Stdio::null());
    #[cfg(unix)]
    {
        // The CLI opens a .png by name. Give it an anonymous seekable file
        // through stdin; no captured pixels are left by a Kiri crash.
        let mut input = tempfile::tempfile()?;
        input.write_all(png)?;
        input.rewind()?;
        std::os::unix::fs::symlink("/dev/fd/0", directory.join("input.png"))?;
        command.arg("input.png").stdin(Stdio::from(input));
    }
    let mut output = tempfile::tempfile()?;
    command
        .current_dir(directory)
        .stdout(Stdio::from(output.try_clone()?))
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW.0);
    }
    // JSON includes bounding boxes as well as the recognized text.
    const MAX_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;
    let mut child = command.spawn()?;
    let start = Instant::now();
    loop {
        let status = match child.try_wait() {
            Ok(Some(status)) => status,
            Ok(None) if start.elapsed() < Duration::from_secs(60) => {
                if output
                    .metadata()
                    .is_ok_and(|meta| meta.len() > MAX_OUTPUT_BYTES)
                {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(anyhow!("Local model output exceeded its limit"));
                }
                std::thread::sleep(Duration::from_millis(25));
                continue;
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                result?;
                return Err(anyhow!("Local model timed out"));
            }
        };
        ensure!(status.success(), "Local model failed");
        break;
    }
    let mut bytes = Vec::new();
    output.rewind()?;
    output.take(MAX_OUTPUT_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_OUTPUT_BYTES as usize,
        "Local model output exceeded its limit"
    );
    // MNN may also write CPU diagnostics to stdout. JSONL gives exactly one
    // recognition object on its own line, including when the image is blank.
    let json = bytes
        .split(|byte| *byte == b'\n')
        .find(|line| line.starts_with(b"{"))
        .ok_or_else(|| anyhow!("Missing local model output"))?;
    recognized_text(json)
}

#[derive(Deserialize)]
struct Region {
    text: String,
    bbox: Bounds,
}

#[derive(Deserialize)]
struct Bounds {
    x: i32,
    y: i32,
    height: u32,
}

fn recognized_text(bytes: &[u8]) -> Result<String> {
    #[derive(Deserialize)]
    struct Output {
        results: Vec<Region>,
    }

    let mut regions = serde_json::from_slice::<Output>(bytes)?.results;
    regions.retain(|region| !region.text.trim().is_empty());
    let center = |bounds: &Bounds| 2 * i64::from(bounds.y) + i64::from(bounds.height);
    regions.sort_by_key(|region| center(&region.bbox));
    let mut lines = Vec::new();
    let mut rest = regions.as_mut_slice();
    while let Some(first) = rest.first() {
        // Detection boxes for the same toolbar row can start a few pixels
        // apart. Keep a fixed row anchor so nearby rows do not chain together.
        let start = center(&first.bbox);
        let height = first.bbox.height;
        let end = rest.partition_point(|region| center(&region.bbox) - start <= i64::from(height));
        let (line, next) = rest.split_at_mut(end);
        line.sort_by_key(|region| region.bbox.x);
        lines.push(
            line.iter()
                .map(|region| region.text.trim())
                .collect::<Vec<_>>()
                .join(" "),
        );
        rest = next;
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_model_directory(executable: &Path) -> std::path::PathBuf {
        std::env::var_os("KIRI_TEST_PADDLE_OCR_MODELS")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| executable.parent().unwrap().to_owned())
    }

    #[test]
    fn reads_rows_in_position_order_and_preserves_one_character_results() {
        let bytes = br#"{"results":[
          {"bbox":{"x":90,"y":6,"height":20},"text":"B"},
          {"bbox":{"x":0,"y":7,"height":22},"text":"A"},
          {"bbox":{"x":0,"y":36,"height":18},"text":"C"},
          {"bbox":{"x":95,"y":37,"height":17},"text":" "}
        ]}"#;
        assert_eq!(recognized_text(bytes).unwrap(), "A B\nC");
        assert_eq!(recognized_text(br#"{"results":[]}"#).unwrap(), "");
        assert!(recognized_text(b"").is_err());
    }

    #[test]
    #[ignore = "requires the pinned platform helper at KIRI_TEST_PADDLE_OCR_BIN"]
    fn packaged_helper_reads_a_real_fixture_and_returns_empty_for_blank_pixels() {
        let path = std::env::var_os("KIRI_TEST_PADDLE_OCR_BIN").expect("missing test helper");
        let executable = Path::new(&path);
        let text = run(
            executable,
            &test_model_directory(executable),
            include_bytes!("../../tests/fixtures/linux-ocr.png"),
        )
        .unwrap();
        assert!(text.contains("KIRI LINUX 123"));
        // A full-sized ordinary screenshot also enters the same model.
        let source = image::load_from_memory(include_bytes!("../../tests/fixtures/linux-ocr.png"))
            .unwrap()
            .to_rgba8();
        let mut desktop = image::RgbaImage::from_pixel(1280, 720, image::Rgba([255; 4]));
        image::imageops::replace(&mut desktop, &source, 80, 50);
        let mut encoded = std::io::Cursor::new(Vec::new());
        desktop
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let text = run(
            executable,
            &test_model_directory(executable),
            encoded.get_ref(),
        )
        .unwrap();
        assert!(text.contains("KIRI LINUX 123"));

        let blank = image::RgbaImage::from_pixel(295, 35, image::Rgba([255; 4]));
        let mut encoded = std::io::Cursor::new(Vec::new());
        blank
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        assert_eq!(
            run(
                executable,
                &test_model_directory(executable),
                encoded.get_ref()
            )
            .unwrap(),
            ""
        );
    }

    #[test]
    #[ignore = "requires the packaged helper and the pinned public #193 toolbar image"]
    fn packaged_helper_reads_issue_193_at_both_observed_selection_boundaries() {
        use sha2::{Digest, Sha256};

        let path = std::env::var_os("KIRI_TEST_PADDLE_OCR_BIN").expect("missing test helper");
        let source = std::env::var_os("KIRI_TEST_OCR_193_IMAGE").expect("missing #193 fixture");
        let bytes = std::fs::read(source).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            "51428de50b28f312e39fcb78a31e22276ef026e56f6932869e8aaa1a213248c7"
        );
        let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
        let toolbar = image::imageops::crop_imm(&image, 32, 33, 593, 105).to_image();
        let labels = [
            "新建连接",
            "新建查询",
            "数据传输",
            "驱动管理",
            "插件中心",
            "更多",
            "导入/导出",
            "搜索",
        ];
        // The Windows capture overlay saved these two hand-selected rectangles
        // from the same toolbar, displayed at native resolution on #272727.
        for (width, height, x, y, pixels_sha) in [
            (
                600,
                110,
                4,
                3,
                "9574d09ee913adec91fb5fde82c06a5c9f3b5a24bae7653fe22df974db233d4e",
            ),
            (
                622,
                136,
                14,
                14,
                "31f11544745140d361bb7fa4056eae9099e06cc765c7f7cdfe45cf1f6b1889d6",
            ),
        ] {
            let mut frame =
                image::RgbaImage::from_pixel(width, height, image::Rgba([39, 39, 39, 255]));
            image::imageops::replace(&mut frame, &toolbar, x, y);
            assert_eq!(format!("{:x}", Sha256::digest(frame.as_raw())), pixels_sha);
            let mut encoded = std::io::Cursor::new(Vec::new());
            frame
                .write_to(&mut encoded, image::ImageFormat::Png)
                .unwrap();
            let executable = Path::new(&path);
            let text = run(
                executable,
                &test_model_directory(executable),
                encoded.get_ref(),
            )
            .expect("bundled OCR should handle the selection");
            let mut remaining = text.as_str();
            for (matched, label) in labels.iter().enumerate() {
                remaining = remaining.split_once(label).unwrap_or_else(|| {
                    panic!("{width}x{height} selection matched {matched}/8 labels in reading order")
                }).1;
            }
        }
    }

    #[test]
    fn any_missing_model_is_rejected_before_invoking_the_helper() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path();
        let executable = directory.join("nbocr.exe");
        // An invalid executable would produce an OS error if launched.
        std::fs::write(&executable, b"unused").unwrap();
        for name in MODEL_FILES {
            std::fs::write(directory.join(name), b"fixture").unwrap();
        }
        for missing in MODEL_FILES {
            let path = directory.join(missing);
            std::fs::remove_file(&path).unwrap();
            assert_eq!(
                run(&executable, directory, b"").unwrap_err().to_string(),
                "Bundled OCR model file is unavailable"
            );
            assert!(!path.exists());
            std::fs::write(path, b"fixture").unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_model_snapshot_survives_package_replacement() {
        use std::os::unix::fs::PermissionsExt;
        let install = tempfile::tempdir().unwrap();
        for name in MODEL_FILES {
            std::fs::write(install.path().join(name), b"model").unwrap();
        }
        let snapshot = private_model_directory(install.path()).unwrap();
        assert_eq!(
            std::fs::metadata(snapshot.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        drop(install);
        for name in MODEL_FILES {
            assert_eq!(std::fs::read(snapshot.path().join(name)).unwrap(), b"model");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_holds_every_model_readable_but_not_replaceable_during_recognition() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path();
        for name in MODEL_FILES {
            std::fs::write(directory.join(name), b"model").unwrap();
        }
        let handles = open_model_files(directory).unwrap();
        for name in MODEL_FILES {
            let path = directory.join(name);
            assert_eq!(std::fs::read(&path).unwrap(), b"model");
            assert!(std::fs::write(&path, b"replace").is_err());
            assert!(std::fs::rename(&path, directory.join("moved")).is_err());
            assert!(std::fs::remove_file(&path).is_err());
        }
        drop(handles);
        for name in MODEL_FILES {
            std::fs::write(directory.join(name), b"updated").unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_removes_temp_files_after_the_last_handle_closes() {
        use std::io::{Read, Write};
        let mut image = temporary_file(".png").unwrap();
        image.write_all(b"pixels").unwrap();
        let path = image.path().to_owned();
        let mut child_handle = std::fs::File::open(&path).unwrap();
        drop(image);
        let mut data = String::new();
        child_handle.read_to_string(&mut data).unwrap();
        assert_eq!(data, "pixels");
        drop(child_handle);
        assert!(!path.exists());
    }
}
