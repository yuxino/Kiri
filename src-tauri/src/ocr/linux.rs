//! Keep OCR's distribution-specific native libraries in the system executable.

use anyhow::{anyhow, Result};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const MAX_TEXT_BYTES: usize = 1024 * 1024;

fn installed_languages(directory: &Path) -> Option<String> {
    let installed: Vec<_> = ["eng", "chi_sim", "jpn"]
        .into_iter()
        .filter(|language| directory.join(format!("{language}.traineddata")).is_file())
        .collect();
    (!installed.is_empty()).then(|| installed.join("+"))
}

fn model_data(explicit_directory: Option<std::ffi::OsString>) -> Option<(PathBuf, String)> {
    let directories = if let Some(directory) = explicit_directory.filter(|value| !value.is_empty())
    {
        // An explicit directory must not fall back to different models.
        vec![PathBuf::from(directory)]
    } else {
        [
            "/usr/share/tesseract-ocr/5/tessdata",
            "/usr/share/tesseract-ocr/4.00/tessdata",
            "/usr/share/tesseract-ocr/tessdata",
            "/usr/share/tessdata",
            "/usr/local/share/tessdata",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect()
    };
    directories.into_iter().find_map(|directory| {
        installed_languages(&directory).map(|languages| (directory, languages))
    })
}

fn tesseract_command(directory: &Path, languages: &str) -> Command {
    // Use the distribution executable directly, never a shell or a PATH override.
    let mut command = Command::new("/usr/bin/tesseract");
    command
        .args(["stdin", "stdout", "--tessdata-dir"])
        .arg(directory)
        .args(["-l", languages, "--psm", "11"]);
    command
}

#[cfg(target_os = "linux")]
pub fn recognize_text(png: &[u8]) -> Result<String> {
    let (directory, languages) = model_data(std::env::var_os("TESSDATA_PREFIX"))
        .ok_or_else(|| anyhow!("Local OCR needs a Tesseract language pack. Install English, Simplified Chinese, or Japanese language data."))?;
    run(
        tesseract_command(&directory, &languages),
        png,
        Duration::from_secs(60),
    )
}

struct OcrProcess(Child);

impl OcrProcess {
    fn stop(&mut self) {
        // wait() also reaps an already-exited child. No child survives a failure
        // or timeout, including an error while starting the pipe workers.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for OcrProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn wait_for_exit(
    child: &mut Child,
    timeout: Duration,
    io_failed: &AtomicBool,
) -> Result<ExitStatus> {
    let started = Instant::now();
    loop {
        if io_failed.load(Ordering::Relaxed) {
            return Err(anyhow!("Local OCR pipe failed"));
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|_| anyhow!("Local OCR process failed"))?
        {
            return Ok(status);
        }
        let remaining = timeout
            .checked_sub(started.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| anyhow!("Local OCR timed out"))?;
        std::thread::sleep(remaining.min(Duration::from_millis(25)));
    }
}

fn run(mut command: Command, png: &[u8], timeout: Duration) -> Result<String> {
    let io_failed = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let mut child = OcrProcess(
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                // Native diagnostics may contain paths or recognized text.
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| anyhow!("Local OCR could not start system Tesseract. Install the tesseract-ocr package."))?,
        );
        let mut stdin = child
            .0
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Local OCR pipe failed"))?;
        let stdout = child
            .0
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Local OCR pipe failed"))?;
        let failed = &io_failed;
        let writer = std::thread::Builder::new()
            .name("ocr-input".into())
            .spawn_scoped(scope, move || {
                let result = stdin.write_all(png);
                // Closing stdin signals EOF even for an empty image.
                drop(stdin);
                if result.is_err() {
                    failed.store(true, Ordering::Relaxed);
                }
                result
            })
            .map_err(|_| anyhow!("Local OCR worker failed"))?;
        let reader = std::thread::Builder::new()
            .name("ocr-output".into())
            .spawn_scoped(scope, move || {
                let mut text = Vec::new();
                let result = stdout
                    .take(MAX_TEXT_BYTES as u64 + 1)
                    .read_to_end(&mut text);
                if result.is_err() || text.len() > MAX_TEXT_BYTES {
                    failed.store(true, Ordering::Relaxed);
                    return Err(anyhow!(
                        "Local OCR output exceeds its limit or could not be read"
                    ));
                }
                Ok(text)
            })
            .map_err(|_| anyhow!("Local OCR worker failed"))?;

        // Both pipes progress concurrently; a full stdout must never block the
        // PNG writer. Stop/reap before joining if either pipe or the child stalls.
        let status = wait_for_exit(&mut child.0, timeout, &io_failed);
        child.stop();
        let input = writer
            .join()
            .map_err(|_| anyhow!("Local OCR worker failed"))?;
        let output = reader
            .join()
            .map_err(|_| anyhow!("Local OCR worker failed"))?;
        if !status?.success() {
            return Err(anyhow!("Text Recognition Failed"));
        }
        input.map_err(|_| anyhow!("Local OCR pipe failed"))?;
        let text =
            String::from_utf8(output?).map_err(|_| anyhow!("Local OCR returned invalid text"))?;
        Ok(text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_installed_supported_language_models_are_selected() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("eng.traineddata"), []).unwrap();
        std::fs::write(directory.path().join("jpn.traineddata"), []).unwrap();
        std::fs::write(directory.path().join("osd.traineddata"), []).unwrap();
        assert_eq!(
            installed_languages(directory.path()).as_deref(),
            Some("eng+jpn")
        );
    }

    #[test]
    fn explicit_model_directory_never_falls_back() {
        let directory = tempfile::tempdir().unwrap();
        let explicit = directory.path().as_os_str().to_owned();
        assert!(model_data(Some(explicit.clone())).is_none());
        std::fs::write(directory.path().join("chi_sim.traineddata"), []).unwrap();
        assert_eq!(
            model_data(Some(explicit)),
            Some((directory.path().to_owned(), "chi_sim".into()))
        );
    }

    #[test]
    fn a_model_directory_is_not_a_model_file() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("eng.traineddata")).unwrap();
        assert!(installed_languages(directory.path()).is_none());
    }

    #[test]
    fn system_command_preserves_model_path_and_sparse_text_policy() {
        let directory = Path::new("/models with spaces/$(do not execute)");
        let command = tesseract_command(directory, "eng+chi_sim+jpn");
        assert_eq!(command.get_program(), "/usr/bin/tesseract");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "stdin",
                "stdout",
                "--tessdata-dir",
                directory.to_str().unwrap(),
                "-l",
                "eng+chi_sim+jpn",
                "--psm",
                "11",
            ]
        );
    }

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[test]
    fn input_and_output_larger_than_pipes_do_not_deadlock() {
        // The child fills stdout before it reads any input, then echoes the PNG.
        let input = vec![b'x'; 256 * 1024];
        let text = run(
            shell("head -c 262144 /dev/zero | tr '\\000' y; cat"),
            &input,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(
            text,
            format!("{}{}", "y".repeat(256 * 1024), "x".repeat(256 * 1024))
        );
    }

    #[cfg(unix)]
    #[test]
    fn text_is_trimmed_and_empty_recognition_is_successful() {
        assert_eq!(
            run(
                shell("cat"),
                b"  Hello  \n\n World \r\n",
                Duration::from_secs(5)
            )
            .unwrap(),
            "Hello\nWorld"
        );
        assert_eq!(
            run(shell("cat"), b" \n\r\n", Duration::from_secs(5)).unwrap(),
            ""
        );
    }

    #[cfg(unix)]
    #[test]
    fn failures_do_not_return_partial_or_private_output() {
        let error = run(
            shell("printf private-text; printf private-path >&2; exit 1"),
            b"",
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(!error.to_string().contains("private"));
        assert!(run(shell("printf '\\377'"), b"", Duration::from_secs(5)).is_err());
        assert!(run(
            shell("head -c 1048577 /dev/zero"),
            b"",
            Duration::from_secs(5)
        )
        .is_err());
        assert!(run(
            shell("exit 0"),
            &vec![b'x'; 256 * 1024],
            Duration::from_secs(5)
        )
        .is_err());
        assert!(run(
            Command::new("/kiri-missing-tesseract"),
            b"",
            Duration::from_secs(5)
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn timeout_interrupts_blocked_input_and_reaps_the_process() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("pid");
        let mut command = shell("printf '%s' $$ > \"$1\"; exec /bin/sleep 60");
        command.arg("ocr-fixture").arg(&pid_file);
        let started = Instant::now();
        let error = run(command, &vec![b'x'; 256 * 1024], Duration::from_millis(200)).unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid = std::fs::read_to_string(pid_file).unwrap();
        assert!(!Command::new("/bin/kill")
            .args(["-0", &pid])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn system_tesseract_recognizes_the_local_png_fixture() {
        // Exercise the actual system executable, PNG input, models and text.
        let png = include_bytes!("../../tests/fixtures/linux-ocr.png");
        let text =
            recognize_text(png).expect("Linux OCR requires system Tesseract and language data");
        let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            normalized.contains("KIRI LINUX 123"),
            "unexpected OCR output: {normalized:?}"
        );
    }
}
