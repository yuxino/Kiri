//! Import user-selected local media into an isolated normalized snapshot.
use crate::core::asset::CaptureKind;
use anyhow::{bail, Context, Result};
use image::{ImageDecoder, ImageEncoder};
use std::io::Read;
use std::path::Path;

pub struct PreparedMedia {
    pub file: tempfile::TempPath,
    pub kind: CaptureKind,
    pub extension: &'static str,
    pub width: i64,
    pub height: i64,
    pub duration: Option<f64>,
}

pub fn display_title(path: &Path) -> Option<String> {
    let name: String = path.file_stem()?.to_string_lossy().chars()
        .filter(|c| !c.is_control()).take(200).collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

pub fn prepare_clipboard_png(png: &[u8]) -> Result<PreparedMedia> {
    if png.is_empty() || png.len() > 32 * 1024 * 1024 {
        bail!("Clipboard image is empty or too large");
    }
    let source = tempfile::Builder::new().suffix(".png").tempfile()?;
    std::fs::write(source.path(), png)?;
    let source = source.into_temp_path();
    prepare(&source)
}

pub fn prepare(path: &Path) -> Result<PreparedMedia> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() {
        bail!("Choose a regular media file");
    }
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "mp4" || extension == "mov" {
        if metadata.len() > 8 * 1024 * 1024 * 1024 {
            bail!("Video exceeds 8 GB");
        }
        let mut file = tempfile::Builder::new()
            .suffix(&format!(".{extension}"))
            .tempfile()?;
        let copied = std::io::copy(
            &mut std::fs::File::open(path)?.take(8 * 1024 * 1024 * 1024 + 1),
            file.as_file_mut(),
        )?;
        if copied > 8 * 1024 * 1024 * 1024 {
            bail!("Video exceeds 8 GB");
        }
        // A native media reader may deny write sharing. Finish the snapshot
        // before probing, retaining only its automatic-cleanup path.
        let file = file.into_temp_path();
        let (width, height, duration) = probe_video(&file)?;
        if width <= 0 || height <= 0 || duration.is_none_or(|d| !d.is_finite() || d <= 0.) {
            bail!("Invalid video");
        }
        // Keep the original container; editing normalizes its exported copy to MP4.
        return Ok(PreparedMedia {
            file,
            kind: CaptureKind::Video,
            extension: if extension == "mov" { "mov" } else { "mp4" },
            width,
            height,
            duration,
        });
    }
    if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str())
        || metadata.len() > 32 * 1024 * 1024
    {
        bail!("Unsupported image");
    }
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let profile = decoder.icc_profile()?;
    let color_managed = profile.is_some();
    let mut image = image::DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    if let Some(profile) = profile {
        image = convert_to_srgb(image, &profile)?;
    }
    let file = tempfile::Builder::new().suffix(".png").tempfile()?;
    let mut encoder = image::codecs::png::PngEncoder::new(file.as_file());
    if color_managed {
        encoder.set_icc_profile(moxcms::ColorProfile::new_srgb().encode()?)?;
    }
    image.write_with_encoder(encoder)?;
    Ok(PreparedMedia {
        file: file.into_temp_path(),
        kind: CaptureKind::Image,
        extension: "png",
        width: i64::from(image.width()),
        height: i64::from(image.height()),
        duration: None,
    })
}

fn convert_to_srgb(image: image::DynamicImage, profile: &[u8]) -> Result<image::DynamicImage> {
    use image::DynamicImage::*;
    use moxcms::{ColorProfile, DataColorSpace, Layout, ParsingOptions, TransformOptions};
    let source = ColorProfile::new_from_slice_with_options(
        profile,
        ParsingOptions {
            max_profile_size: 4 * 1024 * 1024,
            max_allowed_clut_size: 4 * 1024 * 1024,
            max_allowed_trc_size: 40_000,
        },
    )
    .context("Unsupported image color profile")?;
    let expected = if image.color().has_color() {
        DataColorSpace::Rgb
    } else {
        DataColorSpace::Gray
    };
    // Some JPEG decoders already turn CMYK into RGB. Its CMYK profile cannot
    // describe those decoded samples; reject it rather than silently mislabel.
    if source.color_space != expected {
        bail!("Unsupported image color profile");
    }
    let target = ColorProfile::new_srgb();
    // Normalize once at the import boundary. Canvas and later clean-source
    // crops then share sRGB samples even when subsequent PNG writes omit ICC.
    // Keep alpha and 16-bit precision, and cap each output allocation at the
    // same bound used by the image reader.
    macro_rules! convert {
        ($buffer:expr, $input:expr, $output:expr, $pixel:ty, $variant:ident, $method:ident) => {{
            let buffer = $buffer;
            let (width, height) = buffer.dimensions();
            let output_bytes = u64::from(width)
                * u64::from(height)
                * $output.channels() as u64
                * std::mem::size_of::<<$pixel as image::Pixel>::Subpixel>() as u64;
            if output_bytes > 128 * 1024 * 1024 {
                bail!("Image exceeds the color conversion size limit");
            }
            let transform = source
                .$method($input, &target, $output, TransformOptions::default())
                .context("Unsupported image color profile")?;
            let mut output = image::ImageBuffer::<$pixel, Vec<_>>::new(width, height);
            for (input, output) in buffer
                .as_raw()
                .chunks_exact(width as usize * $input.channels())
                .zip(
                    output
                        .as_mut()
                        .chunks_exact_mut(width as usize * $output.channels()),
                )
            {
                transform
                    .transform(input, output)
                    .context("Image color conversion failed")?;
            }
            $variant(output)
        }};
    }
    Ok(match image {
        ImageRgb8(buffer) => convert!(
            buffer,
            Layout::Rgb,
            Layout::Rgb,
            image::Rgb<u8>,
            ImageRgb8,
            create_transform_8bit
        ),
        ImageRgba8(buffer) => convert!(
            buffer,
            Layout::Rgba,
            Layout::Rgba,
            image::Rgba<u8>,
            ImageRgba8,
            create_transform_8bit
        ),
        ImageLuma8(buffer) => convert!(
            buffer,
            Layout::Gray,
            Layout::Rgb,
            image::Rgb<u8>,
            ImageRgb8,
            create_transform_8bit
        ),
        ImageLumaA8(buffer) => convert!(
            buffer,
            Layout::GrayAlpha,
            Layout::Rgba,
            image::Rgba<u8>,
            ImageRgba8,
            create_transform_8bit
        ),
        ImageRgb16(buffer) => convert!(
            buffer,
            Layout::Rgb,
            Layout::Rgb,
            image::Rgb<u16>,
            ImageRgb16,
            create_transform_16bit
        ),
        ImageRgba16(buffer) => convert!(
            buffer,
            Layout::Rgba,
            Layout::Rgba,
            image::Rgba<u16>,
            ImageRgba16,
            create_transform_16bit
        ),
        ImageLuma16(buffer) => convert!(
            buffer,
            Layout::Gray,
            Layout::Rgb,
            image::Rgb<u16>,
            ImageRgb16,
            create_transform_16bit
        ),
        ImageLumaA16(buffer) => convert!(
            buffer,
            Layout::GrayAlpha,
            Layout::Rgba,
            image::Rgba<u16>,
            ImageRgba16,
            create_transform_16bit
        ),
        _ => bail!("Unsupported image color profile"),
    })
}
#[cfg(target_os = "macos")]
fn probe_video(path: &Path) -> Result<(i64, i64, Option<f64>)> {
    crate::macos_media::probe_media(path)
}
#[cfg(windows)]
fn probe_video(path: &Path) -> Result<(i64, i64, Option<f64>)> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::HSTRING,
        Storage::StorageFile,
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    };
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }?;
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    let _apartment = Apartment;
    let path = std::path::absolute(path)?;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .map(|unit| if unit == 47 { 92 } else { unit })
        .collect();
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from_wide(&wide))?.join()?;
    let properties = file.Properties()?.GetVideoPropertiesAsync()?.join()?;
    crate::gif::video_dimensions(&path).context("Video cannot be decoded")?;
    Ok((
        i64::from(properties.Width()?),
        i64::from(properties.Height()?),
        Some(properties.Duration()?.Duration as f64 / 10_000_000.),
    ))
}
#[cfg(target_os = "linux")]
fn probe_video(path: &Path) -> Result<(i64, i64, Option<f64>)> {
    crate::linux_media::probe_video(path).ok_or_else(|| anyhow::anyhow!("Video cannot be decoded"))
}
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn probe_video(_: &Path) -> Result<(i64, i64, Option<f64>)> {
    bail!("Unsupported platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_names_are_readable_bounded_and_do_not_include_paths() {
        assert_eq!(display_title(Path::new("/tmp/海边散步.mp4")).as_deref(), Some("海边散步"));
        assert_eq!(display_title(Path::new("/tmp/ hello\n.mp4")).as_deref(), Some("hello"));
        assert_eq!(display_title(Path::new("/tmp/   .png")), None);
        assert_eq!(display_title(Path::new(&format!("{}.mp4", "界".repeat(300)))).unwrap().chars().count(), 200);
    }
    #[test]
    fn images_are_copied_and_normalized_without_changing_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.jpg");
        image::RgbImage::from_pixel(31, 19, image::Rgb([210, 30, 25]))
            .save(&path)
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let imported = prepare(&path).unwrap();
        assert_eq!((imported.width, imported.height), (31, 19));
        assert_eq!(imported.extension, "png");
        assert!(image::open(&imported.file).is_ok());
        assert_eq!(before, std::fs::read(path).unwrap());
    }
    #[test]
    fn png_and_jpeg_imports_convert_adobe_rgb_to_srgb_without_changing_sources() {
        let profile = include_bytes!("../tests/fixtures/import/adobe-rgb-test.icc");
        let dir = tempfile::tempdir().unwrap();
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(30, 20, |x, _| {
            image::Rgb(if x < 15 {
                [180, 60, 40]
            } else {
                [90, 160, 120]
            })
        }));
        for extension in ["png", "jpg"] {
            let source = dir.path().join(format!("photo.{extension}"));
            let file = std::fs::File::create(&source).unwrap();
            if extension == "png" {
                let mut encoder = image::codecs::png::PngEncoder::new(file);
                encoder.set_icc_profile(profile.to_vec()).unwrap();
                image.write_with_encoder(encoder).unwrap();
            } else {
                let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 100);
                encoder.set_icc_profile(profile.to_vec()).unwrap();
                image.write_with_encoder(encoder).unwrap();
            }
            let before = std::fs::read(&source).unwrap();
            let imported = prepare(&source).unwrap();
            let mut decoder = image::ImageReader::open(&imported.file)
                .unwrap()
                .with_guessed_format()
                .unwrap()
                .into_decoder()
                .unwrap();
            let output_profile = decoder.icc_profile().unwrap().unwrap();
            assert_ne!(output_profile.as_slice(), profile.as_slice());
            assert_eq!(
                moxcms::ColorProfile::new_from_slice(&output_profile)
                    .unwrap()
                    .color_space,
                moxcms::DataColorSpace::Rgb
            );
            let normalized = image::DynamicImage::from_decoder(decoder)
                .unwrap()
                .to_rgb8();
            // Independent Little CMS sRGB reference; JPEG rounding may differ
            // slightly, so compare solid centers within three channel units.
            for (x, reference) in [(5, [208u8, 57, 34]), (25, [0u8, 161, 119])] {
                let converted = normalized.get_pixel(x, 10);
                assert!(
                    converted
                        .0
                        .iter()
                        .zip(reference)
                        .all(|(a, b)| a.abs_diff(b) <= 3),
                    "{extension}: {converted:?} must match {reference:?}"
                );
            }
            assert_eq!(before, std::fs::read(&source).unwrap());
        }
    }
    #[test]
    fn icc_conversion_retains_transparency_and_sixteen_bit_precision() {
        let profile = include_bytes!("../tests/fixtures/import/adobe-rgb-test.icc");
        let original = image::DynamicImage::ImageRgba16(image::ImageBuffer::from_pixel(
            8,
            5,
            image::Rgba([180 * 257, 60 * 257, 40 * 257, 0x1234]),
        ));
        let converted = convert_to_srgb(original, profile).unwrap();
        let image::DynamicImage::ImageRgba16(converted) = converted else {
            panic!("16-bit input must retain its precision");
        };
        assert!(converted.pixels().all(|pixel| pixel[3] == 0x1234));
        assert!(converted.get_pixel(0, 0)[0] > 200 * 257);
        assert!(convert_to_srgb(image::DynamicImage::new_rgb8(1, 1), b"bad profile").is_err());
        let mut oversized = profile.to_vec();
        oversized.resize(4 * 1024 * 1024, 0);
        assert!(convert_to_srgb(image::DynamicImage::new_rgb8(1, 1), &oversized).is_err());
        let mut mismatched = profile.to_vec();
        mismatched[16..20].copy_from_slice(b"CMYK");
        assert!(convert_to_srgb(image::DynamicImage::new_rgb8(1, 1), &mismatched).is_err());
    }
    #[test]
    fn gray_icc_conversion_expands_to_srgb_without_changing_alpha() {
        let profile = moxcms::ColorProfile::new_gray_with_gamma(1.0)
            .encode()
            .unwrap();
        let original = image::DynamicImage::ImageLumaA8(image::GrayAlphaImage::from_pixel(
            2,
            3,
            image::LumaA([128, 37]),
        ));
        let converted = convert_to_srgb(original, &profile).unwrap().to_rgba8();
        for pixel in converted.pixels() {
            assert_eq!(pixel[3], 37);
            assert!(pixel.0[..3]
                .iter()
                .all(|channel| channel.abs_diff(188) <= 2));
        }
    }
    #[test]
    fn directories_and_disguised_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert!(prepare(dir.path()).is_err());
        let path = dir.path().join("bad.png");
        std::fs::write(&path, b"not an image").unwrap();
        assert!(prepare(&path).is_err());
    }
    #[test]
    fn clipboard_image_is_validated_and_normalized() {
        let image = image::RgbaImage::from_pixel(23, 17, image::Rgba([20, 40, 60, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let imported = prepare_clipboard_png(png.get_ref()).unwrap();
        assert_eq!((imported.width, imported.height), (23, 17));
        assert_eq!(imported.kind, CaptureKind::Image);
        assert!(prepare_clipboard_png(b"not an image").is_err());
        assert!(prepare_clipboard_png(&[]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn video_import_probes_a_closed_snapshot_and_keeps_source() -> Result<()> {
        use windows::{
            core::HSTRING,
            Foundation::TimeSpan,
            Media::{
                Editing::{MediaClip, MediaComposition, MediaTrimmingPreference},
                MediaProperties::{MediaEncodingProfile, VideoEncodingQuality},
                Transcoding::TranscodeFailureReason,
            },
            Storage::StorageFile,
            Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        };
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) { unsafe { RoUninitialize(); } }
        }
        let _apartment = Apartment;
        let directory = tempfile::tempdir()?;
        let image = directory.path().join("import-fixture.png");
        image::RgbaImage::from_pixel(320, 180, image::Rgba([210, 30, 25, 255])).save(&image)?;
        let image = StorageFile::GetFileFromPathAsync(&HSTRING::from(image.as_os_str()))?.join()?;
        let composition = MediaComposition::new()?;
        composition.Clips()?.Append(&MediaClip::CreateFromImageFileAsync(
            &image, TimeSpan { Duration: 20_000_000 })?.join()?)?;
        let path = directory.path().join("视频 import.mp4");
        std::fs::File::create(&path)?;
        let destination = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str()))?.join()?;
        let profile = MediaEncodingProfile::CreateMp4(VideoEncodingQuality::HD720p)?;
        profile.Video()?.SetWidth(320)?;
        profile.Video()?.SetHeight(180)?;
        let result = composition.RenderToFileWithProfileAsync(
            &destination, MediaTrimmingPreference::Precise, &profile)?.join()?;
        assert_eq!(result, TranscodeFailureReason::None);
        let original = std::fs::read(&path)?;
        let imported = prepare(&path)?;
        assert_eq!(imported.kind, CaptureKind::Video);
        assert_eq!(imported.extension, "mp4");
        assert_eq!((imported.width, imported.height), (320, 180));
        assert!(imported.duration.is_some_and(|duration| (duration - 2.0).abs() < 0.1));
        assert_eq!(crate::gif::video_dimensions(&imported.file)?, (320, 180));
        assert_eq!(std::fs::read(&imported.file)?, original);
        assert_eq!(std::fs::read(&path)?, original);
        let snapshot = imported.file.to_path_buf();
        drop(imported);
        assert!(!snapshot.exists(), "completed import must remove its temporary snapshot");
        assert_eq!(std::fs::read(&path)?, original);
        Ok(())
    }
}
