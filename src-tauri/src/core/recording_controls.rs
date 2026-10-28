//! Placement in global logical display coordinates. The recording region is
//! fixed; only the controls adapt to the available desktop and their content.

use super::geometry::Rect;

/// Match display identity before computing the controls' work-area bounds.
/// macOS scales each monitor's origin independently; those physical rectangles
/// can overlap, so compare in the shared logical desktop coordinate space.
pub fn monitor_contains_screen(
    screen: Rect,
    screen_scale: f64,
    monitor_physical: Rect,
    monitor_scale: f64,
) -> bool {
    let (screen_factor, monitor_factor) = if cfg!(target_os = "macos") {
        (1.0, 1.0 / monitor_scale)
    } else {
        (screen_scale, 1.0)
    };
    let x = (screen.x + screen.width / 2.0) * screen_factor;
    let y = (screen.y + screen.height / 2.0) * screen_factor;
    x >= monitor_physical.x * monitor_factor
        && y >= monitor_physical.y * monitor_factor
        && x < (monitor_physical.x + monitor_physical.width) * monitor_factor
        && y < (monitor_physical.y + monitor_physical.height) * monitor_factor
}

pub fn controls_frame(
    work_area: Rect,
    region: Rect,
    size: (f64, f64),
    preferred: Option<(f64, f64)>,
) -> Rect {
    let margin = 8.0_f64
        .min(work_area.width / 4.0)
        .min(work_area.height / 4.0);
    let bounds = Rect::new(
        work_area.x + margin,
        work_area.y + margin,
        (work_area.width - margin * 2.0).max(1.0),
        (work_area.height - margin * 2.0).max(1.0),
    );
    let width = size.0.min(bounds.width);
    let height = size.1.min(bounds.height);
    let right = bounds.x + bounds.width - width;
    let bottom = bounds.y + bounds.height - height;
    let fit = |x: f64, y: f64| {
        Rect::new(
            x.clamp(bounds.x, right),
            y.clamp(bounds.y, bottom),
            width,
            height,
        )
    };
    if let Some((x, y)) = preferred {
        return fit(x, y);
    }

    let x = region.x + region.width - width;
    let y = region.y + region.height - height;
    let below = region.y + region.height + 8.0;
    if below >= bounds.y && below <= bottom {
        return fit(x, below);
    }
    let above = region.y - height - 8.0;
    if above >= bounds.y && above <= bottom {
        return fit(x, above);
    }
    let beside = region.x + region.width + 8.0;
    if beside >= bounds.x && beside <= right {
        return fit(beside, y);
    }
    let left = region.x - width - 8.0;
    if left >= bounds.x && left <= right {
        return fit(left, y);
    }
    // Full-display / near-full-display recording: keep controls accessible
    // inside the work area, above the Dock/taskbar. Capture excludes them.
    fit(x - 8.0, y - 8.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 24.0,
        width: 1440.0,
        height: 812.0,
    };

    #[cfg(target_os = "macos")]
    #[test]
    fn mixed_dpi_macos_monitor_origins_do_not_overlap_logically() {
        let retina_primary = Rect::new(0.0, 0.0, 3024.0, 1964.0);
        let external = Rect::new(1512.0, 0.0, 1920.0, 1080.0);
        // The external center falls inside both physical rectangles.
        assert!(!monitor_contains_screen(external, 1.0, retina_primary, 2.0));
        assert!(monitor_contains_screen(external, 1.0, external, 1.0));
        let retina_left = Rect::new(-3024.0, -200.0, 3024.0, 1964.0);
        let logical_left = Rect::new(-1512.0, -100.0, 1512.0, 982.0);
        assert!(monitor_contains_screen(logical_left, 2.0, retina_left, 2.0));
        assert!(!monitor_contains_screen(logical_left, 2.0, external, 1.0));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn windows_monitor_matching_uses_the_physical_desktop() {
        let physical = Rect::new(3840.0, 0.0, 1920.0, 1080.0);
        let logical = Rect::new(2560.0, 0.0, 1280.0, 720.0);
        assert!(monitor_contains_screen(logical, 1.5, physical, 1.5));
        assert!(!monitor_contains_screen(
            logical,
            1.5,
            Rect::new(0.0, 0.0, 3840.0, 2160.0),
            2.0
        ));
    }

    #[test]
    fn follows_small_selection_instead_of_display_corner() {
        assert_eq!(
            controls_frame(
                SCREEN,
                Rect::new(240.0, 200.0, 440.0, 220.0),
                (280.0, 52.0),
                None
            ),
            Rect::new(400.0, 428.0, 280.0, 52.0)
        );
    }

    #[test]
    fn moves_above_bottom_edge_and_beside_tall_selection() {
        let bottom = controls_frame(
            SCREEN,
            Rect::new(100.0, 700.0, 500.0, 120.0),
            (280.0, 52.0),
            None,
        );
        assert_eq!(bottom.y, 640.0);
        let tall = controls_frame(
            SCREEN,
            Rect::new(200.0, 0.0, 100.0, 900.0),
            (280.0, 52.0),
            None,
        );
        assert_eq!(tall.x, 308.0);
        assert!(tall.y + tall.height <= SCREEN.y + SCREEN.height - 8.0);
    }

    #[test]
    fn full_display_respects_reserved_desktop_areas() {
        let panel = controls_frame(
            SCREEN,
            Rect::new(0.0, 0.0, 1440.0, 900.0),
            (280.0, 52.0),
            None,
        );
        assert_eq!(panel, Rect::new(1152.0, 776.0, 280.0, 52.0));
    }

    #[test]
    fn every_edge_tiny_regions_and_negative_desktops_remain_reachable() {
        for origin in [(0.0, 0.0), (-1536.0, -864.0), (960.0, 0.0)] {
            let work = Rect::new(origin.0, origin.1, 960.0, 600.0);
            for width in [1.0, 16.0, 300.0, 959.0, 960.0] {
                for height in [1.0, 16.0, 599.0, 600.0] {
                    for x in [0.0, (960.0 - width) / 2.0, 960.0 - width] {
                        for y in [0.0, 600.0 - height] {
                            for panel_width in [220.0, 300.0, 480.0] {
                                let result = controls_frame(
                                    work,
                                    Rect::new(origin.0 + x, origin.1 + y, width, height),
                                    (panel_width, 52.0),
                                    None,
                                );
                                assert!(result.x >= work.x && result.y >= work.y);
                                assert!(result.x + result.width <= work.x + work.width);
                                assert!(result.y + result.height <= work.y + work.height);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn user_drag_is_preserved_but_clamped_after_content_or_monitor_change() {
        let region = Rect::new(0.0, 0.0, 1440.0, 900.0);
        assert_eq!(
            controls_frame(SCREEN, region, (350.0, 52.0), Some((200.0, 100.0))),
            Rect::new(200.0, 100.0, 350.0, 52.0)
        );
        assert_eq!(
            controls_frame(SCREEN, region, (350.0, 52.0), Some((2000.0, -200.0))),
            Rect::new(1082.0, 32.0, 350.0, 52.0)
        );
    }

    #[test]
    fn expanded_annotation_controls_fit_narrow_work_areas_and_dragged_edges() {
        for origin in [(0.0, 24.0), (-320.0, -600.0)] {
            let work = Rect::new(origin.0, origin.1, 320.0, 600.0);
            for height in [300.0, 360.0] {
                for preferred in [None, Some((origin.0 + 280.0, origin.1 + 540.0))] {
                    let frame = controls_frame(work, work, (320.0, height), preferred);
                    assert_eq!(frame.width, 304.0);
                    assert_eq!(frame.height, height);
                    assert!(frame.x >= work.x + 8.0 && frame.y >= work.y + 8.0);
                    assert!(frame.x + frame.width <= work.x + work.width - 8.0);
                    assert!(frame.y + frame.height <= work.y + work.height - 8.0);
                }
            }
        }
    }
}
