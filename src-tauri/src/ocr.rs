//! Local OCR for screen selections and saved screenshots.

use anyhow::{anyhow, Result};
use std::path::Path;

mod compatibility;
#[cfg(any(target_os = "linux", all(test, unix)))]
mod linux;
mod paddle;
#[cfg(target_os = "linux")]
use linux::recognize_text as recognize_native;
#[cfg(any(windows, test))]
mod windows_small_text;

/// Tauri resolves resource_dir for both installed packages and Cargo builds.
pub fn recognize_text(png: &[u8], resources: Option<&Path>) -> Result<String> {
    let model = recognize_bundled_text(png, resources);
    with_native_fallback(model, compatibility::system_hint, || recognize_native(png))
}

pub(crate) fn recognize_bundled_text(png: &[u8], resources: Option<&Path>) -> Result<String> {
    let root = resources.ok_or_else(|| anyhow!("OCR resource directory unavailable"))?;
    paddle::recognize(&root.join("ocr-runtime"), png)
}

fn with_native_fallback(
    model: Result<String>,
    hint: impl FnOnce() -> Option<compatibility::Script>,
    native: impl FnOnce() -> Result<String>,
) -> Result<String> {
    match model {
        Ok(text) if text.trim().is_empty() => native().or(Ok(String::new())),
        Ok(text) => {
            if let Some(script) = hint() {
                if let Ok(alternate) = native() {
                    if script.confirms(&alternate, &text) {
                        return Ok(alternate);
                    }
                }
            }
            Ok(text)
        }
        Err(_) => {
            log::debug!("Bundled OCR unavailable; using the local system recognizer");
            native()
        }
    }
}

#[cfg(any(windows, test))]
fn run_with_one_retry<T, E>(
    mut operation: impl FnMut() -> Result<T, E>,
) -> (Result<T, E>, Option<E>) {
    match operation() {
        Ok(value) => (Ok(value), None),
        Err(first_error) => (operation(), Some(first_error)),
    }
}

#[cfg(windows)]
fn rgba_to_bgra_in_place(bytes: &mut [u8]) {
    for pixel in bytes.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
}

#[cfg(target_os = "macos")]
fn make_macos_text_request() -> objc2::rc::Retained<objc2_vision::VNRecognizeTextRequest> {
    use objc2_vision::{VNRecognizeTextRequest, VNRequestTextRecognitionLevel};

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);
    request.setAutomaticallyDetectsLanguage(true);
    request
}

#[cfg(target_os = "macos")]
fn recognize_native(png: &[u8]) -> Result<String> {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{VNImageRequestHandler, VNRecognizedTextObservation};

    let data = NSData::with_bytes(png);
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &NSDictionary::new(),
    );

    let request = make_macos_text_request();

    let request_ref: &objc2_vision::VNRequest = &request;
    let requests: Retained<NSArray<objc2_vision::VNRequest>> = NSArray::from_slice(&[request_ref]);
    let result = handler.performRequests_error(&requests);
    if result.is_err() {
        return Err(anyhow!("Text Recognition Failed"));
    }

    let mut lines = Vec::new();
    if let Some(observations) = request.results() {
        for observation in observations.iter() {
            if let Ok(recognized) = observation.downcast::<VNRecognizedTextObservation>() {
                let candidates = recognized.topCandidates(1);
                if let Some(top) = candidates.firstObject() {
                    lines.push(top.string().to_string());
                }
            }
        }
    }
    let text = lines.join("\n");
    // A successful recognition with no characters is a normal empty result.
    Ok(text)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::make_macos_text_request;

    #[test]
    fn blank_image_is_a_successful_empty_local_result() {
        let image = image::RgbaImage::from_pixel(320, 180, image::Rgba([255, 255, 255, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        assert!(super::recognize_native(&png.into_inner())
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn macos_request_uses_automatic_language_detection() {
        let request = make_macos_text_request();
        assert!(request.automaticallyDetectsLanguage());
    }
}

#[cfg(windows)]
fn recognize_native(png: &[u8]) -> Result<String> {
    use windows::Media::Ocr::OcrEngine;

    let rgba = image::load_from_memory(png)
        .map_err(|error| anyhow!("{error}"))?
        .into_rgba8();
    // WinRT can fail on first use while the installed language pack warms up.
    // Only retry the system recognizer, never the already-attempted model.
    let (result, _) = run_with_one_retry(|| {
        let engine =
            OcrEngine::TryCreateFromUserProfileLanguages().map_err(|error| anyhow!("{error}"))?;
        let max_dimension = OcrEngine::MaxImageDimension().map_err(|error| anyhow!("{error}"))?;
        windows_small_text::recognize(&rgba, max_dimension, |image| {
            recognize_windows_image(&engine, image)
        })
    });
    result
}

#[cfg(windows)]
fn recognize_windows_image(
    engine: &windows::Media::Ocr::OcrEngine,
    image: &image::RgbaImage,
) -> Result<String> {
    use windows::Graphics::Imaging::BitmapPixelFormat;
    use windows::Storage::Streams::DataWriter;

    let (width, height) = image.dimensions();
    let mut raw = image.as_raw().clone();
    // Windows.Media.Ocr expects the same BGRA8 SoftwareBitmap shape used by
    // Microsoft's OCR samples. `image` decodes to RGBA8, so swap red and blue
    // before declaring the WinRT buffer as BGRA8. Declaring RGBA8 here causes
    // RecognizeAsync to reject otherwise valid screenshots on Windows 11.
    rgba_to_bgra_in_place(&mut raw);

    // Write the pixel bytes into an IBuffer via DataWriter (the windows crate
    // no longer exposes Buffer::as_mut for raw writes).
    let writer = DataWriter::new().map_err(|error| anyhow!("{error}"))?;
    writer
        .WriteBytes(&raw)
        .map_err(|error| anyhow!("{error}"))?;
    let buffer = writer.DetachBuffer().map_err(|error| anyhow!("{error}"))?;

    let bitmap = windows::Graphics::Imaging::SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
    )
    .map_err(|error| anyhow!("{error}"))?;

    let operation = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| anyhow!("{error}"))?;
    let result = operation.join().map_err(|error| anyhow!("{error}"))?;

    let mut lines = Vec::new();
    let ocr_lines = result.Lines().map_err(|error| anyhow!("{error}"))?;
    for line in ocr_lines {
        lines.push(line.Text().map_err(|error| anyhow!("{error}"))?.to_string());
    }
    // A successful recognition with no characters is a normal empty result.
    Ok(lines.join("\n"))
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::rgba_to_bgra_in_place;

    fn encode_png(image: &image::RgbaImage) -> Vec<u8> {
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        png.into_inner()
    }

    #[test]
    fn windows_native_blank_narrow_crop_is_successful_empty() {
        let image = image::RgbaImage::from_pixel(295, 35, image::Rgba([255; 4]));
        let text = super::recognize_native(&encode_png(&image))
            .expect("Windows OCR and a user-profile OCR language pack must be available");
        assert!(text.trim().is_empty());
    }

    #[test]
    fn windows_native_narrow_text_crop_is_readable() {
        // Reuse public, generated test pixels; no issue screenshot or private
        // capture is stored. Match the reported 295 x 35 crop at 100% scale.
        let source = image::load_from_memory(include_bytes!("../tests/fixtures/linux-ocr.png"))
            .unwrap()
            .to_rgba8();
        let scaled =
            image::imageops::resize(&source, 295, 55, image::imageops::FilterType::Lanczos3);
        let image = image::imageops::crop_imm(&scaled, 0, 10, 295, 35).to_image();
        let text = super::recognize_native(&encode_png(&image))
            .expect("Windows OCR and a user-profile OCR language pack must be available");
        let compact: String = text
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        assert!(
            compact.to_uppercase().contains("KIRI"),
            "Narrow local OCR fixture was not recognized"
        );
    }

    #[test]
    fn converts_decoded_rgba_pixels_to_windows_bgra_order() {
        let mut pixels = vec![1, 2, 3, 4, 10, 20, 30, 40];
        rgba_to_bgra_in_place(&mut pixels);
        assert_eq!(pixels, [3, 2, 1, 4, 30, 20, 10, 40]);
    }
}

#[cfg(test)]
mod routing_tests {
    use super::*;

    #[test]
    fn recognized_model_text_only_uses_the_model() {
        let text = with_native_fallback(
            Ok("bonjour 日本語 中文".into()),
            || None,
            || panic!("unexpected native OCR"),
        )
        .unwrap();
        assert_eq!(text, "bonjour 日本語 中文");
    }

    #[test]
    fn compatibility_hint_only_overrides_with_confirmed_image_text() {
        let recognize = |alternate: &str| {
            with_native_fallback(
                Ok("API 判".into()),
                || Some(compatibility::Script::Hangul),
                || Ok(alternate.into()),
            )
            .unwrap()
        };
        assert_eq!(recognize("API 한국"), "API 한국");
        assert_eq!(recognize("API 한"), "API 判");
        assert_eq!(recognize(""), "API 判");
    }

    #[test]
    fn empty_or_unavailable_model_uses_the_system_recognizer() {
        for result in [Ok(String::new()), Err(anyhow!("model unavailable"))] {
            assert_eq!(
                with_native_fallback(result, || None, || Ok("한글".into())).unwrap(),
                "한글"
            );
        }
        assert_eq!(
            with_native_fallback(
                Ok(String::new()),
                || None,
                || Err(anyhow!("no system engine"))
            )
            .unwrap(),
            ""
        );
        assert!(with_native_fallback(
            Err(anyhow!("model unavailable")),
            || None,
            || Err(anyhow!("no system engine"))
        )
        .is_err());
    }

    #[test]
    fn local_retry_runs_at_most_twice_and_preserves_the_first_error() {
        let mut attempts = 0;
        let (result, first_error) = run_with_one_retry(|| {
            attempts += 1;
            if attempts == 1 {
                Err("cold start")
            } else {
                Ok("recognized")
            }
        });
        assert_eq!(attempts, 2);
        assert_eq!(result, Ok("recognized"));
        assert_eq!(first_error, Some("cold start"));

        let mut successful_attempts = 0;
        let (result, first_error) = run_with_one_retry(|| {
            successful_attempts += 1;
            Ok::<_, &str>("recognized")
        });
        assert_eq!(successful_attempts, 1);
        assert_eq!(result, Ok("recognized"));
        assert_eq!(first_error, None);
    }
}
