//! Recent screenshot geometry is transient, like capture completion feedback.
//! Imported/older images have no screen origin; their reference keeps its fitted size.

use std::collections::VecDeque;

use super::geometry::Rect;

const MAX_RECENT_CAPTURES: usize = 64;

/// Older and imported images have no capture region. Long images need a
/// readable viewport rather than a thumbnail fitted by the full image height.
pub fn fitted_reference_frame(pixel_size: (i64, i64), backing_scale: f64, work_area: Rect) -> Rect {
    let density = if backing_scale.is_finite() && backing_scale > 0.0 {
        backing_scale.max(1.0)
    } else {
        1.0
    };
    let source_width = pixel_size.0.max(1) as f64;
    let source_height = pixel_size.1.max(1) as f64;
    let available_width = work_area.width.max(1.0);
    let available_height = work_area.height.max(1.0);
    let max_width = 680.0_f64.min(available_width);
    let max_height = 480.0_f64.min(available_height);
    let (width, height) = if source_height > source_width * 2.0 {
        (
            (source_width / density).min(max_width),
            (source_height / density).min(max_height),
        )
    } else {
        let scale = (max_width / source_width)
            .min(max_height / source_height)
            .min(1.0 / density);
        (source_width * scale, source_height * scale)
    };
    let width = width.max(80.0_f64.min(available_width));
    let height = height.max(60.0_f64.min(available_height));
    Rect::new(
        work_area.x + (available_width - width) / 2.0,
        work_area.y + (available_height - height) / 2.0,
        width,
        height,
    )
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CapturePinPlacement {
    pub frame: Rect,
    pub backing_scale: f64,
    pub pixel_size: (i64, i64),
}

impl CapturePinPlacement {
    pub fn fits_monitor(&self, physical_frame: Rect, current_scale: f64) -> bool {
        let scale = self.backing_scale;
        (current_scale - scale).abs() < 0.0001
            && self.frame.x * scale >= physical_frame.x - 1.0
            && self.frame.y * scale >= physical_frame.y - 1.0
            && (self.frame.x + self.frame.width) * scale
                <= physical_frame.x + physical_frame.width + 1.0
            && (self.frame.y + self.frame.height) * scale
                <= physical_frame.y + physical_frame.height + 1.0
    }

    /// Selection has already passed the owner-bound annotation validation.
    pub fn new(display: Rect, selection: Rect, backing_scale: f64, pixel_size: (i64, i64)) -> Self {
        // Tiny selections still need room for the reference's close controls.
        // Keep the whole minimum-size window on the originating display.
        let width = selection.width.max(80.0).min(display.width);
        let height = selection.height.max(60.0).min(display.height);
        Self {
            frame: Rect::new(
                (display.x + selection.x).min(display.x + display.width - width),
                (display.y + selection.y).min(display.y + display.height - height),
                width,
                height,
            ),
            backing_scale,
            pixel_size,
        }
    }
}

#[derive(Default)]
pub struct RecentCapturePinPlacements(VecDeque<(uuid::Uuid, CapturePinPlacement)>);

impl RecentCapturePinPlacements {
    pub fn remember(&mut self, id: uuid::Uuid, placement: CapturePinPlacement) {
        self.0.retain(|(existing, _)| *existing != id);
        self.0.push_back((id, placement));
        if self.0.len() > MAX_RECENT_CAPTURES {
            self.0.pop_front();
        }
    }

    pub fn get(&self, id: uuid::Uuid, pixel_size: (i64, i64)) -> Option<CapturePinPlacement> {
        self.0.iter().find_map(|(existing, placement)| {
            (*existing == id && placement.pixel_size == pixel_size).then_some(*placement)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_long_reference_has_readable_width_instead_of_a_thin_thumbnail() {
        let frame = fitted_reference_frame((1080, 12000), 1.0, Rect::new(0.0, 0.0, 1920.0, 1040.0));
        assert_eq!(frame, Rect::new(620.0, 280.0, 680.0, 480.0));
    }

    #[test]
    fn fallback_respects_source_pixel_density_and_negative_monitor_work_area() {
        let frame =
            fitted_reference_frame((1200, 800), 2.0, Rect::new(-1440.0, -80.0, 1440.0, 860.0));
        assert_eq!(frame, Rect::new(-1020.0, 150.0, 600.0, 400.0));
    }

    #[test]
    fn long_reference_never_opens_outside_a_small_work_area() {
        let area = Rect::new(200.0, 30.0, 260.0, 180.0);
        let frame = fitted_reference_frame((1000, 9000), 1.25, area);
        assert_eq!(frame, area);
    }

    #[test]
    fn tiny_fallback_keeps_room_for_controls_without_enlarging_the_image() {
        let frame = fitted_reference_frame((12, 8), 2.0, Rect::new(0.0, 0.0, 1000.0, 800.0));
        assert_eq!(frame, Rect::new(460.0, 370.0, 80.0, 60.0));
    }

    #[test]
    fn ordinary_fallback_still_fits_the_whole_image() {
        let frame = fitted_reference_frame((1280, 960), 1.0, Rect::new(0.0, 0.0, 1920.0, 1040.0));
        assert_eq!((frame.width, frame.height), (640.0, 480.0));
    }

    #[test]
    fn retina_reference_keeps_logical_selection_size_and_negative_display_origin() {
        let placement = CapturePinPlacement::new(
            Rect::new(-1440.0, -200.0, 1440.0, 900.0),
            Rect::new(470.0, 160.0, 680.0, 260.0),
            2.0,
            (1360, 520),
        );
        assert_eq!(placement.frame, Rect::new(-970.0, -40.0, 680.0, 260.0));
        assert_eq!(placement.backing_scale, 2.0);
    }

    #[test]
    fn large_selection_is_not_shrunk_to_the_old_reference_cap() {
        let placement = CapturePinPlacement::new(
            Rect::new(2560.0, 0.0, 1920.0, 1080.0),
            Rect::new(50.0, 30.0, 1400.0, 900.0),
            1.25,
            (1750, 1125),
        );
        assert_eq!(placement.frame, Rect::new(2610.0, 30.0, 1400.0, 900.0));
    }

    #[test]
    fn tiny_reference_is_reachable_at_the_bottom_right_edge() {
        let placement = CapturePinPlacement::new(
            Rect::new(0.0, 0.0, 1920.0, 1080.0),
            Rect::new(1910.0, 1070.0, 10.0, 10.0),
            1.0,
            (10, 10),
        );
        assert_eq!(placement.frame, Rect::new(1840.0, 1020.0, 80.0, 60.0));
    }

    #[test]
    fn recent_origins_are_bounded_and_cropped_images_do_not_reuse_stale_geometry() {
        let placement = CapturePinPlacement::new(
            Rect::new(0.0, 0.0, 1920.0, 1080.0),
            Rect::new(100.0, 200.0, 300.0, 400.0),
            1.0,
            (300, 400),
        );
        let mut recent = RecentCapturePinPlacements::default();
        let oldest = uuid::Uuid::new_v4();
        recent.remember(oldest, placement);
        assert_eq!(recent.get(oldest, (300, 400)), Some(placement));
        assert_eq!(recent.get(oldest, (200, 400)), None);
        for _ in 0..MAX_RECENT_CAPTURES {
            recent.remember(uuid::Uuid::new_v4(), placement);
        }
        assert_eq!(recent.get(oldest, (300, 400)), None);
        assert_eq!(recent.0.len(), MAX_RECENT_CAPTURES);
    }

    #[test]
    fn disconnected_or_rescaled_displays_cannot_open_an_offscreen_reference() {
        let placement = CapturePinPlacement::new(
            Rect::new(-1440.0, 0.0, 1440.0, 900.0),
            Rect::new(200.0, 100.0, 400.0, 300.0),
            2.0,
            (800, 600),
        );
        assert!(placement.fits_monitor(Rect::new(-2880.0, 0.0, 2880.0, 1800.0), 2.0));
        assert!(!placement.fits_monitor(Rect::new(0.0, 0.0, 2880.0, 1800.0), 2.0));
        assert!(!placement.fits_monitor(Rect::new(-2880.0, 0.0, 2880.0, 1800.0), 1.5));
    }
}
