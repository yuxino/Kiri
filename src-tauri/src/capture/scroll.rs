//! Continuous raw frames for free-direction scrolling capture. This boundary
//! never creates an encoder, audio device, input listener, or injected scroll.
use super::scroll_frames::{self, ScrollFrameReceiver};
use super::{CaptureHealth, CapturedDisplay};
use crate::core::geometry::Rect;
use anyhow::{bail, Result};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PixelRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

pub(crate) trait NativeScrollSource: Send {
    fn stop(&mut self) -> Result<()>;
}

/// An immutable content identity retained when a stopped source is resumed.
/// Display capture is currently the Windows/X11 path; it does not isolate
/// unrelated windows. macOS binds one window in the selected display space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ScrollTarget {
    // Retained on macOS so unsupported cross-platform bindings can be rejected.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Display,
    Window {
        window_id: u32,
        owner_pid: i32,
        /// Global top-left logical coordinates at the original selection.
        frame: Rect,
    },
}

pub struct ScrollSource {
    pub target: ScrollTarget,
    pub width: u32,
    pub height: u32,
    pub receiver: ScrollFrameReceiver,
    native: Box<dyn NativeScrollSource>,
    health: Arc<CaptureHealth>,
}

impl ScrollSource {
    pub fn stop(&mut self) -> Result<()> {
        self.health.begin_expected_stop();
        self.native.stop()?;
        if let Some(error) = self.health.unexpected_failure() {
            bail!("Scrolling capture stopped unexpectedly: {error}");
        }
        Ok(())
    }

    pub fn unexpected_failure(&self) -> Option<String> {
        self.health.unexpected_failure()
    }
}

impl Drop for ScrollSource {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Bind the visually selected source before activating any application.
/// Call from a worker; the main event loop must remain available to SCK.
pub fn resolve_target(display: &CapturedDisplay, selection: Rect) -> Result<ScrollTarget> {
    let region = pixel_region(display, selection)?;
    #[cfg(target_os = "macos")]
    {
        super::current::resolve_scroll_target(display, region)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = region;
        Ok(ScrollTarget::Display)
    }
}

/// Start or resume only the explicitly bound source, never reselect by focus.
/// Call from a worker. macOS registers ScreenCaptureKit filters on main and
/// waits on the worker; callers must leave the main event loop running.
pub fn start(
    display: &CapturedDisplay,
    selection: Rect,
    target: &ScrollTarget,
) -> Result<ScrollSource> {
    let region = pixel_region(display, selection)?;
    let (sender, receiver) = scroll_frames::channel();
    let health = Arc::new(CaptureHealth::default());
    #[cfg(target_os = "macos")]
    let (native, target) =
        super::current::start_scroll_source(display, region, *target, sender, Arc::clone(&health))?;
    #[cfg(not(target_os = "macos"))]
    let (native, target) = {
        if *target != ScrollTarget::Display {
            bail!("The scrolling capture source cannot be resumed on this platform.");
        }
        (
            super::current::start_scroll_source(display, region, sender, Arc::clone(&health))?,
            ScrollTarget::Display,
        )
    };
    Ok(ScrollSource {
        target,
        width: region.width,
        height: region.height,
        receiver,
        native,
        health,
    })
}

/// Snap both edges once to the frozen display's physical grid. Unlike the
/// recording policy, raw image dimensions are never rounded to even numbers.
pub(crate) fn pixel_region(display: &CapturedDisplay, selection: Rect) -> Result<PixelRegion> {
    let scale = display.backing_scale;
    if !scale.is_finite()
        || scale < 1.0
        || display.pixel_width <= 0
        || display.pixel_height <= 0
        || ![selection.x, selection.y, selection.width, selection.height]
            .iter()
            .all(|v| v.is_finite())
        || selection.x < 0.0
        || selection.y < 0.0
        || selection.width <= 0.0
        || selection.height <= 0.0
        || selection.x + selection.width > display.screen_frame.width
        || selection.y + selection.height > display.screen_frame.height
    {
        bail!("The scrolling capture region is outside the selected display.");
    }
    let x = (selection.x * scale).round();
    let y = (selection.y * scale).round();
    let right = ((selection.x + selection.width) * scale).round();
    let bottom = ((selection.y + selection.height) * scale).round();
    if right > display.pixel_width as f64
        || bottom > display.pixel_height as f64
        || right > u32::MAX as f64
        || bottom > u32::MAX as f64
        || right <= x
        || bottom <= y
    {
        bail!("The scrolling capture region has invalid pixel dimensions.");
    }
    let region = PixelRegion {
        x: x as u32,
        y: y as u32,
        width: (right - x) as u32,
        height: (bottom - y) as u32,
    };
    let bytes = u64::from(region.width) * u64::from(region.height) * 4;
    // Keep at least two views for matching even at the largest supported size.
    if bytes > (scroll_frames::MAX_QUEUE_BYTES / 2) as u64 {
        bail!("The scrolling capture region is too large. Select a smaller region.");
    }
    Ok(region)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn display() -> CapturedDisplay {
        CapturedDisplay {
            png_data: Arc::from([]),
            pixel_width: 3000,
            pixel_height: 2000,
            screen_frame: Rect::new(-1500.0, 0.0, 1500.0, 1000.0),
            window_rects: vec![],
            display_id: 1,
            display_identity: None,
            backing_scale: 2.0,
        }
    }
    #[test]
    fn pixel_grid_preserves_odd_dimensions_and_display_local_origin() {
        assert_eq!(
            pixel_region(&display(), Rect::new(10.5, 20.0, 100.5, 200.5)).unwrap(),
            PixelRegion {
                x: 21,
                y: 40,
                width: 201,
                height: 401
            }
        );
    }
    #[test]
    fn malformed_and_off_display_regions_fail_closed() {
        for region in [
            Rect::new(-1.0, 0.0, 10.0, 10.0),
            Rect::new(1499.0, 0.0, 2.0, 10.0),
            Rect::new(0.0, f64::NAN, 10.0, 10.0),
            Rect::new(0.0, 0.0, f64::INFINITY, 10.0),
            Rect::new(0.0, 0.0, 0.1, 10.0),
        ] {
            assert!(pixel_region(&display(), region).is_err());
        }
    }
}
