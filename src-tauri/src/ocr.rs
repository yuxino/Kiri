//! Local OCR — Vision on macOS, Windows.Media.Ocr on Windows, Tesseract on Linux.
//! Uses accurate recognition with language correction and automatic language
//! detection, returning the top candidate per line.

#[cfg(any(target_os = "macos", windows))]
use anyhow::{anyhow, Result};

#[cfg(any(target_os = "linux", all(test, unix)))]
mod linux;

#[cfg(target_os = "linux")]
pub use linux::recognize_text;

#[cfg(any(windows, test))]
mod windows_small_text;

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
pub fn recognize_text(png: &[u8]) -> Result<String> {
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
        assert!(super::recognize_text(&png.into_inner()).unwrap().trim().is_empty());
    }

    #[test]
    fn macos_request_uses_automatic_language_detection() {
        let request = make_macos_text_request();
        assert!(request.automaticallyDetectsLanguage());
    }
}

#[cfg(windows)]
pub fn recognize_text(png: &[u8]) -> Result<String> {
    use windows::Media::Ocr::OcrEngine;

    let rgba = image::load_from_memory(png)
        .map_err(|error| anyhow!("{error}"))?
        .into_rgba8();
    let engine =
        OcrEngine::TryCreateFromUserProfileLanguages().map_err(|error| anyhow!("{error}"))?;
    let max_dimension = OcrEngine::MaxImageDimension().map_err(|error| anyhow!("{error}"))?;
    windows_small_text::recognize(&rgba, max_dimension, |image| {
        recognize_windows_image(&engine, image)
    })
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
        let text = super::recognize_text(&encode_png(&image))
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
        let text = super::recognize_text(&encode_png(&image))
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
