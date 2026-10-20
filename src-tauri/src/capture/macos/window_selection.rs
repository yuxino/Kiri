//! Window hover includes floating/nonactivating panels, regardless of title.
//! ScreenCaptureKit supplies eligible content; Quartz supplies stacking order.

use std::cmp::Reverse;
use std::collections::HashMap;

use objc2_core_foundation::{CFDictionary, CFNumber, CFString, CFType};
use objc2_core_graphics::{
    kCGWindowAlpha, kCGWindowNumber, CGWindowListCopyWindowInfo, CGWindowListOption,
};

use crate::core::geometry::Rect;

pub(super) struct Candidate {
    pub id: u32,
    pub layer: isize,
    pub owner_pid: i32,
    pub owner_bundle_id: String,
    pub on_screen: bool,
    pub frame: Rect,
}

pub(super) fn visible_window_order() -> Vec<(u32, f64)> {
    let Some(windows) = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    ) else {
        return Vec::new();
    };
    // CGWindowListCopyWindowInfo returns retained CFDictionary objects (unlike
    // CGWindowListCreate, whose array contains raw numeric window IDs).
    let windows = unsafe { windows.cast_unchecked::<CFType>() };
    windows
        .iter()
        .filter_map(|entry| {
            let info = entry.downcast_ref::<CFDictionary>()?;
            let info = unsafe { info.cast_unchecked::<CFString, CFType>() };
            // Quartz returns dictionaries of CFString keys and CFType values.
            let number = info.get(unsafe { kCGWindowNumber })?;
            let id = u32::try_from(number.downcast_ref::<CFNumber>()?.as_i64()?).ok()?;
            let alpha = info
                .get(unsafe { kCGWindowAlpha })
                .and_then(|value| value.downcast_ref::<CFNumber>()?.as_f64())
                .unwrap_or(1.0);
            Some((id, alpha))
        })
        .collect()
}

pub(super) fn candidate_rects(
    mut windows: Vec<Candidate>,
    display: Rect,
    own_pid: i32,
    order: &[(u32, f64)],
) -> Vec<Rect> {
    let stacking: HashMap<_, _> = order
        .iter()
        .enumerate()
        .map(|(index, &(id, alpha))| (id, (index, alpha)))
        .collect();
    windows.retain(|window| {
        window.on_screen
            && window.layer >= 0
            && window.owner_pid > 0
            && window.owner_pid != own_pid
            // Dock and other desktop UI can publish screen-sized helper windows
            // with alpha=1 even when their pixels are mostly transparent. Their
            // positive levels must not steal hover from actual app windows.
            && !is_system_chrome(&window.owner_bundle_id)
            && (order.is_empty()
                || stacking.get(&window.id).is_some_and(|(_, alpha)| *alpha > 0.0))
    });
    // Quartz is the authoritative visible stacking order. Only fall back to
    // layer and stable SCK order when that snapshot is unavailable altogether.
    windows.sort_by_key(|window| {
        (
            stacking
                .get(&window.id)
                .map(|(index, _)| *index)
                .unwrap_or(usize::MAX),
            Reverse(window.layer),
        )
    });
    windows
        .into_iter()
        .filter_map(|window| {
            let frame = window.frame;
            if ![frame.x, frame.y, frame.width, frame.height]
                .iter()
                .all(|v| v.is_finite())
            {
                return None;
            }
            let x = frame.x.max(display.x);
            let y = frame.y.max(display.y);
            let width = (frame.x + frame.width).min(display.x + display.width) - x;
            let height = (frame.y + frame.height).min(display.y + display.height) - y;
            // Both APIs use global top-left coordinates. Only translate to display
            // local coordinates; flipping y would mirror the hover rectangle.
            (width >= 8.0 && height >= 8.0)
                .then(|| Rect::new(x - display.x, y - display.y, width, height))
        })
        .collect()
}

pub(super) fn is_system_chrome(bundle_id: &str) -> bool {
    matches!(
        bundle_id,
        "com.apple.dock"
            | "com.apple.WindowManager"
            | "com.apple.systemuiserver"
            | "com.apple.controlcenter"
            | "com.apple.notificationcenterui"
            | "com.apple.screencaptureui"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(id: u32, layer: isize) -> Candidate {
        Candidate {
            id,
            layer,
            owner_pid: 20,
            owner_bundle_id: "io.yuxino.mimi".into(),
            on_screen: true,
            frame: Rect::new(100.0 + f64::from(id), 100.0, 300.0, 120.0),
        }
    }
    const DISPLAY: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };

    #[test]
    fn floating_panels_and_mimi_level_overlay_precede_normal_windows() {
        let layers = [0, 3, 8, 25, 101, 1000];
        let windows = layers
            .iter()
            .enumerate()
            .map(|(id, &layer)| window(id as u32, layer))
            .collect();
        let rects = candidate_rects(windows, DISPLAY, 99, &[]);
        assert_eq!(
            rects.iter().map(|rect| rect.x).collect::<Vec<_>>(),
            vec![105.0, 104.0, 103.0, 102.0, 101.0, 100.0]
        );
    }

    #[test]
    fn same_layer_uses_actual_front_to_back_order_and_falls_back_stably() {
        let make = || vec![window(1, 0), window(2, 0), window(3, 0)];
        let ordered = candidate_rects(make(), DISPLAY, 99, &[(3, 1.0), (1, 1.0), (2, 1.0)]);
        assert_eq!(
            ordered.iter().map(|rect| rect.x).collect::<Vec<_>>(),
            vec![103.0, 101.0, 102.0]
        );
        let fallback = candidate_rects(make(), DISPLAY, 99, &[]);
        assert_eq!(
            fallback.iter().map(|rect| rect.x).collect::<Vec<_>>(),
            vec![101.0, 102.0, 103.0]
        );
    }

    #[test]
    fn visible_quartz_order_wins_over_reported_window_levels() {
        let mut chrome = window(1, 0);
        chrome.owner_bundle_id = "com.google.Chrome".into();
        let floating = window(2, 1000);
        let rects = candidate_rects(
            vec![floating, chrome, window(3, 3)],
            DISPLAY,
            99,
            &[(1, 1.0), (3, 1.0), (2, 1.0)],
        );
        // A level-based sort would put the floating panel first, even though
        // the visible snapshot says Chrome is in front at this capture.
        assert_eq!(
            rects,
            vec![
                window(1, 0).frame,
                window(3, 3).frame,
                window(2, 1000).frame
            ]
        );
    }

    #[test]
    fn normal_apps_remain_selectable_with_or_without_quartz_metadata() {
        for bundle in [
            "com.google.Chrome",
            "com.apple.Safari",
            "com.apple.finder",
            "app.yuxino.mimi",
            "", // A valid owner PID can belong to an unbundled application.
        ] {
            for order in [vec![], vec![(1, 1.0)]] {
                let mut app = window(1, 0);
                app.owner_bundle_id = bundle.into();
                assert_eq!(
                    candidate_rects(vec![app], DISPLAY, 99, &order),
                    vec![window(1, 0).frame],
                    "bundle={bundle}, order={order:?}"
                );
            }
        }
    }

    #[test]
    fn excludes_own_hidden_desktop_transparent_and_invalid_windows() {
        let mut own = window(1, 1000);
        own.owner_pid = 99;
        let mut hidden = window(2, 1000);
        hidden.on_screen = false;
        let mut ownerless = window(3, 1000);
        ownerless.owner_pid = 0;
        let mut tiny = window(4, 1000);
        tiny.frame.width = 7.0;
        let mut outside = window(5, 1000);
        outside.frame.x = 1500.0;
        let mut invalid = window(6, 1000);
        invalid.frame.x = f64::NAN;
        let rects = candidate_rects(
            vec![
                own,
                hidden,
                ownerless,
                tiny,
                outside,
                invalid,
                window(7, -1),
                window(8, 1000),
                window(9, 1000),
            ],
            DISPLAY,
            99,
            &[(8, 0.0), (9, 0.2)],
        );
        assert_eq!(rects, vec![window(9, 1000).frame]);
    }

    #[test]
    fn system_desktop_helpers_do_not_steal_normal_app_or_floating_panel_hits() {
        let mut dock = window(1, 20);
        dock.owner_bundle_id = "com.apple.dock".into();
        dock.frame = DISPLAY;
        let mut chrome = window(2, 0);
        chrome.owner_bundle_id = "com.google.Chrome".into();
        chrome.frame = Rect::new(100.0, 50.0, 1200.0, 800.0);
        let mut mimi = window(3, 1000);
        mimi.frame = Rect::new(300.0, 400.0, 500.0, 100.0);
        let rects = candidate_rects(
            vec![dock, chrome, mimi],
            DISPLAY,
            99,
            &[(3, 1.0), (1, 1.0), (2, 1.0)],
        );
        let hit = |x, y| {
            rects
                .iter()
                .find(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
                .copied()
        };
        assert_eq!(
            hit(400.0, 450.0),
            Some(Rect::new(300.0, 400.0, 500.0, 100.0))
        );
        assert_eq!(
            hit(200.0, 200.0),
            Some(Rect::new(100.0, 50.0, 1200.0, 800.0))
        );
        assert_eq!(hit(20.0, 20.0), None);
    }

    #[test]
    fn stale_sck_helpers_missing_from_the_visible_snapshot_are_not_selectable() {
        let mut stale = window(1, 1000);
        stale.frame = DISPLAY;
        assert_eq!(
            candidate_rects(vec![stale, window(2, 0)], DISPLAY, 99, &[(2, 1.0)]),
            vec![window(2, 0).frame]
        );
        for bundle in [
            "com.apple.dock",
            "com.apple.WindowManager",
            "com.apple.systemuiserver",
            "com.apple.controlcenter",
            "com.apple.notificationcenterui",
            "com.apple.screencaptureui",
        ] {
            let mut helper = window(1, 20);
            helper.owner_bundle_id = bundle.into();
            assert!(candidate_rects(vec![helper], DISPLAY, 99, &[]).is_empty());
        }
        assert!(!is_system_chrome("com.apple.Safari"));
        assert!(!is_system_chrome("com.apple.finder"));
    }

    #[test]
    fn clips_cross_display_panels_without_mirroring_negative_coordinates() {
        let display = Rect::new(-1440.0, -100.0, 1440.0, 900.0);
        let mut panel = window(1, 1000);
        panel.frame = Rect::new(-100.0, -120.0, 200.0, 140.0);
        assert_eq!(
            candidate_rects(vec![panel], display, 99, &[]),
            vec![Rect::new(1340.0, 0.0, 100.0, 120.0)]
        );
    }
}
