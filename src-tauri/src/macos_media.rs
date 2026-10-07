use std::ffi::{c_char, c_double, c_int, c_longlong, c_uint, c_void, CString};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;

use anyhow::{bail, Context, Result};

const ERROR_CAPACITY: usize = 1024;

unsafe extern "C" {
    fn kiri_macos_encoder_create(
        path: *const c_char,
        width: c_uint,
        height: c_uint,
        fps: c_uint,
        bitrate: c_longlong,
        audio_enabled: bool,
        error: *mut c_char,
        error_capacity: usize,
    ) -> *mut c_void;
    fn kiri_macos_encoder_append_video(
        encoder: *mut c_void,
        bytes: *const u8,
        length: usize,
        frame_index: c_longlong,
        error: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    fn kiri_macos_encoder_append_audio(
        encoder: *mut c_void,
        bytes: *const u8,
        length: usize,
        error: *mut c_char,
        error_capacity: usize,
    ) -> bool;
    fn kiri_macos_encoder_finish(
        encoder: *mut c_void,
        error: *mut c_char,
        error_capacity: usize,
    ) -> bool;
    fn kiri_macos_encoder_cancel(encoder: *mut c_void);
    fn kiri_macos_encoder_release(encoder: *mut c_void);
    fn kiri_macos_probe_media(
        path: *const c_char,
        width: *mut c_longlong,
        height: *mut c_longlong,
        duration: *mut c_double,
        error: *mut c_char,
        error_capacity: usize,
    ) -> bool;
    #[cfg(test)]
    fn kiri_macos_has_audio_track(
        path: *const c_char,
        has_audio: *mut bool,
        error: *mut c_char,
        error_capacity: usize,
    ) -> bool;
    fn kiri_macos_merge_segments(
        paths: *const *const c_char,
        path_count: usize,
        output_path: *const c_char,
        error: *mut c_char,
        error_capacity: usize,
    ) -> bool;
    // Calls write_frame serially and synchronously; pixel bytes live only for
    // that call. Neither the context nor callback is retained by AVFoundation.
    fn kiri_macos_decode_gif_frames(
        source_path: *const c_char,
        max_long_edge: c_uint,
        fps: c_uint,
        write_frame: extern "C" fn(*mut c_void, *const u8, u32, u32, u64, u64) -> bool,
        context: *mut c_void,
        error: *mut c_char,
        error_capacity: usize,
    ) -> bool;
    fn kiri_macos_video_first_frame_png(
        source_path: *const c_char,
        output_path: *const c_char,
        max_long_edge: c_uint,
        error: *mut c_char,
        error_capacity: usize,
    ) -> bool;
}

fn c_path(path: &Path) -> Result<CString> {
    CString::new(
        path.to_str()
            .context("macOS media path is not valid UTF-8")?
            .as_bytes(),
    )
    .context("macOS media path contains a null byte")
}

fn error_buffer() -> Vec<c_char> {
    vec![0; ERROR_CAPACITY]
}

fn error_message(buffer: &[c_char], fallback: &str) -> anyhow::Error {
    let bytes = buffer
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect::<Vec<_>>();
    let message = String::from_utf8_lossy(&bytes);
    anyhow::anyhow!(if message.is_empty() {
        fallback.to_string()
    } else {
        message.into_owned()
    })
}

pub struct MacosSegmentEncoder {
    raw: Option<NonNull<c_void>>,
}

unsafe impl Send for MacosSegmentEncoder {}

impl MacosSegmentEncoder {
    pub fn new(
        path: &Path,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: i64,
        audio_enabled: bool,
    ) -> Result<Self> {
        let path = c_path(path)?;
        let mut error = error_buffer();
        let raw = unsafe {
            kiri_macos_encoder_create(
                path.as_ptr(),
                width,
                height,
                fps,
                bitrate,
                audio_enabled,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        let raw = NonNull::new(raw)
            .ok_or_else(|| error_message(&error, "could not initialize AVAssetWriter"))?;
        Ok(Self { raw: Some(raw) })
    }

    pub fn append_video(&mut self, frame: &[u8], frame_index: i64) -> Result<bool> {
        let mut error = error_buffer();
        let status = unsafe {
            kiri_macos_encoder_append_video(
                self.raw.expect("native encoder is available").as_ptr(),
                frame.as_ptr(),
                frame.len(),
                frame_index,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        match status {
            1 => Ok(true),
            0 => Ok(false),
            _ => Err(error_message(
                &error,
                "AVAssetWriter rejected a video frame",
            )),
        }
    }

    pub fn append_audio(&mut self, bytes: &[u8]) -> Result<()> {
        let mut error = error_buffer();
        let success = unsafe {
            kiri_macos_encoder_append_audio(
                self.raw.expect("native encoder is available").as_ptr(),
                bytes.as_ptr(),
                bytes.len(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if success {
            Ok(())
        } else {
            Err(error_message(
                &error,
                "AVAssetWriter rejected an audio buffer",
            ))
        }
    }

    pub fn finish(mut self) -> Result<()> {
        let mut error = error_buffer();
        let raw = self.raw.take().expect("native encoder is available");
        let success =
            unsafe { kiri_macos_encoder_finish(raw.as_ptr(), error.as_mut_ptr(), error.len()) };
        unsafe { kiri_macos_encoder_release(raw.as_ptr()) };
        if success {
            Ok(())
        } else {
            Err(error_message(
                &error,
                "AVAssetWriter could not finalize the MP4",
            ))
        }
    }

    pub fn cancel(mut self) {
        let raw = self.raw.take().expect("native encoder is available");
        unsafe {
            kiri_macos_encoder_cancel(raw.as_ptr());
            kiri_macos_encoder_release(raw.as_ptr());
        }
    }
}

impl Drop for MacosSegmentEncoder {
    fn drop(&mut self) {
        if let Some(raw) = self.raw.take() {
            unsafe {
                kiri_macos_encoder_cancel(raw.as_ptr());
                kiri_macos_encoder_release(raw.as_ptr());
            }
        }
    }
}

pub fn probe_media(path: &Path) -> Result<(i64, i64, Option<f64>)> {
    let path = c_path(path)?;
    let mut width = 0;
    let mut height = 0;
    let mut duration = 0.0;
    let mut error = error_buffer();
    let success = unsafe {
        kiri_macos_probe_media(
            path.as_ptr(),
            &mut width,
            &mut height,
            &mut duration,
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if !success {
        return Err(error_message(&error, "AVFoundation could not read the MP4"));
    }
    if width <= 0 || height <= 0 {
        bail!("AVFoundation reported invalid video dimensions");
    }
    Ok((
        width,
        height,
        (duration.is_finite() && duration > 0.0).then_some(duration),
    ))
}

#[cfg(test)]
fn has_audio_track(path: &Path) -> Result<bool> {
    let path = c_path(path)?;
    let mut has_audio = false;
    let mut error = error_buffer();
    let success = unsafe {
        kiri_macos_has_audio_track(
            path.as_ptr(),
            &mut has_audio,
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if success {
        Ok(has_audio)
    } else {
        Err(error_message(
            &error,
            "AVFoundation could not inspect the audio track",
        ))
    }
}

pub fn merge_segments(segments: &[PathBuf], output: &Path) -> Result<()> {
    if segments.is_empty() {
        bail!("No recording segments are available.");
    }
    if segments.len() == 1 {
        std::fs::copy(&segments[0], output)?;
        return Ok(());
    }
    let paths = segments
        .iter()
        .map(|path| c_path(path))
        .collect::<Result<Vec<_>>>()?;
    let pointers = paths.iter().map(|path| path.as_ptr()).collect::<Vec<_>>();
    let output = c_path(output)?;
    let mut error = error_buffer();
    let success = unsafe {
        kiri_macos_merge_segments(
            pointers.as_ptr(),
            pointers.len(),
            output.as_ptr(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if success {
        Ok(())
    } else {
        Err(error_message(
            &error,
            "AVFoundation could not merge the recording segments",
        ))
    }
}

#[cfg(test)]
pub fn export_gif(
    source: &Path,
    max_long_edge: u32,
    fps: u32,
) -> Result<(PathBuf, i64, i64, Option<f64>)> {
    export_gif_with_progress(source, max_long_edge, fps, &mut |_| {})
}

pub fn export_gif_with_progress(
    source: &Path,
    max_long_edge: u32,
    fps: u32,
    progress: &mut dyn FnMut(f64),
) -> Result<(PathBuf, i64, i64, Option<f64>)> {
    use image::codecs::gif::{GifEncoder, Repeat};
    use std::io::Write;

    struct FrameSink<'a> {
        encoder: GifEncoder<&'a mut std::io::BufWriter<std::fs::File>>,
        clock: crate::core::gif_timing::GifFrameClock,
        progress: &'a mut dyn FnMut(f64),
        dimensions: Option<(u32, u32)>,
        error: Option<anyhow::Error>,
    }
    extern "C" fn write_frame(
        context: *mut c_void,
        pixels: *const u8,
        width: u32,
        height: u32,
        index: u64,
        total: u64,
    ) -> bool {
        let sink = unsafe { &mut *context.cast::<FrameSink<'_>>() };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
            let length = (width as usize)
                .checked_mul(height as usize)
                .and_then(|count| count.checked_mul(4))
                .context("GIF frame is too large")?;
            if pixels.is_null() || length == 0 {
                bail!("The GIF frame is invalid.");
            }
            let mut rgba = unsafe { std::slice::from_raw_parts(pixels, length) }.to_vec();
            for pixel in rgba.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            let rgba = image::RgbaImage::from_raw(width, height, rgba)
                .context("Invalid GIF frame dimensions")?;
            sink.encoder
                .encode_frame(image::Frame::from_parts(
                    rgba,
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(sink.clock.next_delay_ms(), 1),
                ))
                .with_context(|| format!("Could not write GIF frame {}/{}", index + 1, total))?;
            sink.dimensions = Some((width, height));
            (sink.progress)((index + 1) as f64 / total.max(1) as f64);
            Ok(())
        }))
        .unwrap_or_else(|_| {
            Err(anyhow::anyhow!(
                "The GIF frame encoder stopped unexpectedly."
            ))
        });
        match result {
            Ok(()) => true,
            Err(error) => {
                sink.error = Some(error);
                false
            }
        }
    }

    let clock = crate::core::gif_timing::GifFrameClock::new(fps)
        .context("GIF frame rate must be between 1 and 60")?;
    let source_c = c_path(source)?;
    let output = tempfile::Builder::new()
        .prefix("kiri-gif-")
        .suffix(".gif")
        .tempfile()?;
    let mut writer = std::io::BufWriter::new(output.reopen()?);
    let (width, height, duration) = {
        let mut encoder = GifEncoder::new_with_speed(&mut writer, 10);
        encoder.set_repeat(Repeat::Infinite)?;
        let mut sink = FrameSink {
            encoder,
            clock,
            progress,
            dimensions: None,
            error: None,
        };
        let mut error = error_buffer();
        let success = unsafe {
            kiri_macos_decode_gif_frames(
                source_c.as_ptr(),
                max_long_edge,
                fps,
                write_frame,
                (&mut sink as *mut FrameSink<'_>).cast(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if let Some(error) = sink.error {
            return Err(error);
        }
        if !success {
            return Err(error_message(
                &error,
                "AVFoundation could not decode the GIF video",
            ));
        }
        let (width, height) = sink.dimensions.context("GIF encoding produced no frames")?;
        (width, height, sink.clock.duration_seconds())
    };
    writer
        .flush()
        .context("Could not finish writing the GIF; check available disk space")?;
    drop(writer);
    let (_, path) = output
        .keep()
        .context("Could not retain the completed GIF")?;
    Ok((path, i64::from(width), i64::from(height), Some(duration)))
}

pub fn video_first_frame_png(source: &Path, max_long_edge: u32) -> Result<Vec<u8>> {
    let output = std::env::temp_dir().join(format!(
        "kiri-video-thumbnail-{}.png",
        uuid::Uuid::new_v4().to_string().to_lowercase()
    ));
    let source = c_path(source)?;
    let output_c = c_path(&output)?;
    let mut error = error_buffer();
    let success = unsafe {
        kiri_macos_video_first_frame_png(
            source.as_ptr(),
            output_c.as_ptr(),
            max_long_edge,
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if !success {
        let _ = std::fs::remove_file(&output);
        return Err(error_message(
            &error,
            "AVFoundation could not create the video thumbnail",
        ));
    }
    let bytes = std::fs::read(&output).context("could not read the native video thumbnail")?;
    let _ = std::fs::remove_file(output);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_media_round_trip_needs_no_external_encoder() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.mp4");
        let second = directory.path().join("second.mp4");
        for video in [&first, &second] {
            let mut encoder = MacosSegmentEncoder::new(video, 64, 64, 30, 500_000, true).unwrap();
            let mut frame = vec![0_u8; 64 * 64 * 4];
            for (index, pixel) in frame.chunks_exact_mut(4).enumerate() {
                pixel.copy_from_slice(if index / 64 < 32 {
                    &[0, 0, 255, 255]
                } else {
                    &[255, 0, 0, 255]
                });
            }
            for frame_index in 0..60 {
                assert!(encoder.append_video(&frame, frame_index).unwrap());
            }
            let audio = vec![0_u8; 4_800 * 4];
            encoder.append_audio(&audio).unwrap();
            encoder.finish().unwrap();
        }

        let video = directory.path().join("merged.mp4");
        merge_segments(&[first, second], &video).unwrap();

        let (width, height, duration) = probe_media(&video).unwrap();
        assert_eq!((width, height), (64, 64));
        assert!(duration.is_some_and(|seconds| seconds >= 3.9));
        assert!(has_audio_track(&video).unwrap());

        let thumbnail = video_first_frame_png(&video, 64).unwrap();
        let decoded =
            image::load_from_memory_with_format(&thumbnail, image::ImageFormat::Png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64, 64));
        let top = decoded.to_rgb8().get_pixel(32, 8).0;
        let bottom = decoded.to_rgb8().get_pixel(32, 56).0;
        assert!(top[0] > top[2], "top half should remain red: {top:?}");
        assert!(
            bottom[2] > bottom[0],
            "bottom half should remain blue: {bottom:?}"
        );

        let (gif, gif_width, gif_height, gif_duration) = export_gif(&video, 32, 12).unwrap();
        assert_eq!((gif_width, gif_height), (32, 32));
        assert!(gif_duration.is_some_and(|seconds| seconds > 0.0));
        let bytes = std::fs::read(&gif).unwrap();
        assert!(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"));
        use image::AnimationDecoder;
        let frames = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes))
            .unwrap()
            .into_frames()
            .collect_frames()
            .unwrap();
        let encoded_seconds: f64 = frames
            .iter()
            .map(|frame| {
                let (numerator, denominator) = frame.delay().numer_denom_ms();
                f64::from(numerator) / f64::from(denominator) / 1000.0
            })
            .sum();
        assert!((encoded_seconds - frames.len() as f64 / 12.0).abs() <= 0.005_000_001);
        assert!((gif_duration.unwrap() - encoded_seconds).abs() < 0.000_001);
        assert!((encoded_seconds - duration.unwrap()).abs() < 1.0 / 12.0 + 0.01);
        let top = frames[0].buffer().get_pixel(16, 4).0;
        let bottom = frames[0].buffer().get_pixel(16, 28).0;
        assert!(top[0] > top[2], "GIF top should remain red: {top:?}");
        assert!(
            bottom[2] > bottom[0],
            "GIF bottom should remain blue: {bottom:?}"
        );
        let _ = std::fs::remove_file(gif);
    }

    #[test]
    fn invalid_gif_source_returns_native_reason() {
        let directory = tempfile::tempdir().unwrap();
        let video = directory.path().join("invalid.mp4");
        std::fs::write(&video, b"invalid video").unwrap();
        let mut progress = Vec::new();
        let error = export_gif_with_progress(&video, 720, 12, &mut |value| progress.push(value))
            .unwrap_err();
        assert!(
            error.to_string().contains("source video is invalid"),
            "{error:#}"
        );
        assert!(progress.is_empty());
    }

    #[test]
    #[ignore = "requires KIRI_TEST_MP4 pointing to a generated local fixture"]
    fn native_gif_long_fixture_streams_frames_and_progress() {
        use image::AnimationDecoder;
        let source = std::env::var_os("KIRI_TEST_MP4").unwrap();
        let mut progress = Vec::new();
        let (gif, width, height, duration) =
            export_gif_with_progress(Path::new(&source), 720, 12, &mut |value| {
                progress.push(value)
            })
            .unwrap();
        assert!(progress.len() > 12);
        assert!(progress.windows(2).all(|pair| pair[1] > pair[0]));
        assert_eq!(progress.last(), Some(&1.0));
        let decoder = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(
            std::fs::File::open(&gif).unwrap(),
        ))
        .unwrap();
        let mut encoded_ms = 0.0;
        let mut count = 0;
        for frame in decoder.into_frames() {
            let frame = frame.unwrap();
            assert_eq!(frame.buffer().dimensions(), (width as u32, height as u32));
            let (numerator, denominator) = frame.delay().numer_denom_ms();
            encoded_ms += numerator as f64 / denominator as f64;
            count += 1;
        }
        assert_eq!(count, progress.len());
        assert!((encoded_ms / 1000.0 - duration.unwrap()).abs() < 0.001);
        println!(
            "GIF: {width}x{height}, {count} frames, {} s, {} bytes",
            duration.unwrap(),
            std::fs::metadata(&gif).unwrap().len()
        );
        std::fs::remove_file(gif).unwrap();
    }
}
