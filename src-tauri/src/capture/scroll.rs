//! Fixed-display, lossless BGRA frame sources for scrolling screenshots.
//! These producers share native capture with recording, without an encoder,
//! audio devices, cursor, or the even-dimension video policy.

use anyhow::{bail, Result};

use crate::core::geometry::Rect;

use super::frame_sink::ScrollFrameSender;
use super::{CapturedDisplay, PlatformRecorder};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PixelRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

pub fn supported() -> bool {
    #[cfg(target_os = "linux")]
    return !super::linux::is_wayland();
    #[cfg(not(target_os = "linux"))]
    return cfg!(any(target_os = "macos", windows));
}

pub fn dimensions(display: &CapturedDisplay, region: Rect) -> Result<(u32, u32)> {
    let crop = pixel_region(display, region)?;
    Ok((crop.width, crop.height))
}

/// Validate before rounding, then use exactly the selected physical pixels.
/// An edge at a fractional point is rounded once; odd pixel sizes are retained.
pub(crate) fn pixel_region(display: &CapturedDisplay, region: Rect) -> Result<PixelRegion> {
    let scale = display.backing_scale;
    if ![
        region.x,
        region.y,
        region.width,
        region.height,
        scale,
        display.screen_frame.x,
        display.screen_frame.y,
        display.screen_frame.width,
        display.screen_frame.height,
    ]
    .iter()
    .all(|value| value.is_finite())
        || scale < 1.0
        || region.x < 0.0
        || region.y < 0.0
        || region.width <= 0.0
        || region.height <= 0.0
        || display.pixel_width <= 0
        || display.pixel_height <= 0
        || region.x + region.width > display.screen_frame.width + 0.001
        || region.y + region.height > display.screen_frame.height + 0.001
        || (display.screen_frame.width * scale - display.pixel_width as f64).abs() > 1.0
        || (display.screen_frame.height * scale - display.pixel_height as f64).abs() > 1.0
    {
        bail!("The scrolling capture region or display geometry is invalid.");
    }
    let rounded = [
        region.x * scale,
        region.y * scale,
        region.width * scale,
        region.height * scale,
    ]
    .map(f64::round);
    if rounded.iter().any(|value| *value > u32::MAX as f64) {
        bail!("The scrolling capture region is too large.");
    }
    let crop = PixelRegion {
        x: rounded[0] as u32,
        y: rounded[1] as u32,
        width: rounded[2] as u32,
        height: rounded[3] as u32,
    };
    if crop.width == 0
        || crop.height == 0
        || crop
            .x
            .checked_add(crop.width)
            .is_none_or(|end| i64::from(end) > display.pixel_width)
        || crop
            .y
            .checked_add(crop.height)
            .is_none_or(|end| i64::from(end) > display.pixel_height)
    {
        bail!("The scrolling capture region no longer fits the selected display.");
    }
    Ok(crop)
}

pub(crate) fn start(
    display: &CapturedDisplay,
    region: Rect,
    tx: ScrollFrameSender,
) -> Result<Box<dyn PlatformRecorder>> {
    let crop = pixel_region(display, region)?;
    #[cfg(target_os = "macos")]
    return Ok(Box::new(super::macos::MacRecordingSession::start_scroll(
        display, crop, tx,
    )?));
    #[cfg(windows)]
    return Ok(Box::new(super::windows::WindowsRecorder::start_scroll(
        display, crop, tx,
    )?));
    #[cfg(target_os = "linux")]
    return Ok(Box::new(super::linux::LinuxRecorder::start_scroll(
        display, crop, tx,
    )?));
}

#[cfg(target_os = "linux")]
pub(crate) fn validate_x11_display(expected: &super::DisplayIdentity) -> Result<()> {
    let candidates = xcap::Monitor::all()?
        .into_iter()
        .map(|monitor| {
            Ok(super::DisplayIdentity {
                device_name: monitor.name()?,
                physical_x: monitor.x()?,
                physical_y: monitor.y()?,
                physical_width: monitor.width()?,
                physical_height: monitor.height()?,
                scale_factor: f64::from(monitor.scale_factor()?).max(1.0),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if candidates
        .iter()
        .filter(|candidate| *candidate == expected)
        .count()
        != 1
    {
        bail!("The selected display changed or is no longer uniquely available. Select it again.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(scale: f64) -> CapturedDisplay {
        CapturedDisplay {
            png_data: Vec::new().into(),
            pixel_width: 1920,
            pixel_height: 1080,
            screen_frame: Rect::new(0.0, 0.0, 1920.0 / scale, 1080.0 / scale),
            window_rects: vec![],
            display_id: 7,
            display_identity: None,
            backing_scale: scale,
        }
    }

    #[test]
    fn scrolling_capture_preserves_odd_pixel_dimensions_at_every_scale() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let crop = pixel_region(
                &display(scale),
                Rect::new(3.0 / scale, 5.0 / scale, 301.0 / scale, 505.0 / scale),
            )
            .unwrap();
            assert_eq!(
                crop,
                PixelRegion {
                    x: 3,
                    y: 5,
                    width: 301,
                    height: 505
                }
            );
        }
    }

    #[test]
    fn scrolling_capture_rejects_invalid_or_changed_geometry() {
        for region in [
            Rect::new(-0.1, 0.0, 10.0, 10.0),
            Rect::new(0.0, 0.0, 0.0, 10.0),
            Rect::new(1900.0, 0.0, 21.0, 10.0),
            Rect::new(f64::NAN, 0.0, 10.0, 10.0),
        ] {
            assert!(dimensions(&display(1.0), region).is_err());
        }
        let mut changed = display(2.0);
        changed.pixel_width = 1922;
        assert!(dimensions(&changed, Rect::new(0.0, 0.0, 10.0, 10.0)).is_err());
    }
}
