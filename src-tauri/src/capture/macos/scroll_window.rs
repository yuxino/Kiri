//! Bind scrolling capture to one application window while preserving the
//! user's display-space crop. Other windows never enter the SCK filter.
use anyhow::{anyhow, bail, Result};
use objc2::rc::Retained;
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFString, CFType, CGRect};
use objc2_core_graphics::{
    kCGWindowAlpha, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowNumber, kCGWindowOwnerPID,
    CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
};
use objc2_screen_capture_kit::{SCShareableContent, SCWindow};

use crate::capture::scroll::ScrollTarget;
use crate::core::geometry::Rect;

const CHANGED: &str =
    "The source window moved, resized, or became unavailable. Start a new scrolling capture.";
const NO_SOURCE: &str = "Select a scrolling area fully inside one application window.";

#[derive(Clone, Copy, Debug)]
struct Candidate {
    id: u32,
    pid: i32,
    frame: Rect,
    order: usize,
}

fn contains(outer: Rect, inner: Rect) -> bool {
    [
        outer.x,
        outer.y,
        outer.width,
        outer.height,
        inner.x,
        inner.y,
        inner.width,
        inner.height,
    ]
    .iter()
    .all(|v| v.is_finite())
        && outer.width > 0.0
        && outer.height > 0.0
        && inner.width > 0.0
        && inner.height > 0.0
        && inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height
}

fn target(candidate: Candidate) -> ScrollTarget {
    ScrollTarget::Window {
        window_id: candidate.id,
        owner_pid: candidate.pid,
        frame: candidate.frame,
    }
}

fn choose(
    candidates: &[Candidate],
    selection: Rect,
    previous: Option<ScrollTarget>,
) -> Result<ScrollTarget> {
    if let Some(previous) = previous {
        // Resuming must not guess a replacement window with similar geometry.
        return candidates
            .iter()
            .copied()
            .find(|candidate| {
                target(*candidate) == previous && contains(candidate.frame, selection)
            })
            .map(target)
            .ok_or_else(|| anyhow!(CHANGED));
    }
    let front = candidates
        .iter()
        .filter(|candidate| contains(candidate.frame, selection))
        .min_by_key(|candidate| candidate.order)
        .copied()
        .ok_or_else(|| anyhow!(NO_SOURCE))?;
    // Foreground application identity is not visual stacking order: a raised
    // window can belong to an inactive app, including two coincident windows.
    Ok(target(front))
}

fn eligible_window(
    layer: isize,
    pid: i32,
    on_screen: bool,
    alpha: f64,
    bundle_id: &str,
    own_pid: u32,
) -> bool {
    layer == 0
        && pid > 0
        && pid as u32 != own_pid
        && on_screen
        && alpha.is_finite()
        && alpha > 0.0
        && !super::window_selection::is_system_chrome(bundle_id)
}

/// SCShareableContent is inspected only in its caller's main-thread closure.
pub(super) fn resolve(
    content: &SCShareableContent,
    selection: Rect,
    previous: Option<ScrollTarget>,
) -> Result<(Retained<SCWindow>, ScrollTarget)> {
    let order = super::window_selection::visible_window_order();
    if order.is_empty() {
        bail!("The source window stacking order is unavailable. Try again.");
    }
    let windows = unsafe { content.windows() };
    let mut candidates = Vec::new();
    for window in windows.iter() {
        // Normal application windows exclude desktop-sized floating helpers,
        // including pointer/highlight overlays whose window alpha can be 1.
        let Some(app) = (unsafe { window.owningApplication() }) else {
            continue;
        };
        let pid = unsafe { app.processID() };
        let id = unsafe { window.windowID() };
        let Some((z, (_, alpha))) = order
            .iter()
            .enumerate()
            .find(|(_, (candidate, _))| *candidate == id)
        else {
            continue;
        };
        if !eligible_window(
            unsafe { window.windowLayer() },
            pid,
            unsafe { window.isOnScreen() },
            *alpha,
            &unsafe { app.bundleIdentifier() }.to_string(),
            std::process::id(),
        ) {
            continue;
        }
        let frame = unsafe { window.frame() };
        candidates.push(Candidate {
            id,
            pid,
            order: z,
            frame: Rect::new(
                frame.origin.x,
                frame.origin.y,
                frame.size.width,
                frame.size.height,
            ),
        });
    }
    let selected = choose(&candidates, selection, previous)?;
    let ScrollTarget::Window { window_id, .. } = selected else {
        unreachable!()
    };
    let window = windows
        .iter()
        .find(|window| unsafe { window.windowID() } == window_id)
        .ok_or_else(|| anyhow!(CHANGED))?;
    validate(selected)?;
    Ok((window, selected))
}

fn number(info: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i64> {
    info.get(key)?.downcast_ref::<CFNumber>()?.as_i64()
}

fn same_window(
    expected: ScrollTarget,
    id: u32,
    pid: i32,
    frame: Rect,
    on_screen: bool,
    alpha: f64,
) -> bool {
    let ScrollTarget::Window {
        window_id,
        owner_pid,
        frame: expected_frame,
    } = expected
    else {
        return false;
    };
    on_screen
        && alpha.is_finite()
        && alpha > 0.0
        && id == window_id
        && pid == owner_pid
        && frame == expected_frame
}

/// Quartz's one-window query is synchronous and safe off the main thread.
/// Validate every delivered image, including tail frames during stop/drain.
pub(super) fn validate(expected: ScrollTarget) -> Result<()> {
    let ScrollTarget::Window { window_id, .. } = expected else {
        bail!(CHANGED);
    };
    let windows = CGWindowListCopyWindowInfo(CGWindowListOption::OptionIncludingWindow, window_id)
        .ok_or_else(|| anyhow!(CHANGED))?;
    let windows = unsafe { windows.cast_unchecked::<CFType>() };
    for entry in windows.iter() {
        let Some(info) = entry.downcast_ref::<CFDictionary>() else {
            continue;
        };
        let info = unsafe { info.cast_unchecked::<CFString, CFType>() };
        let Some(id) =
            number(info, unsafe { kCGWindowNumber }).and_then(|id| u32::try_from(id).ok())
        else {
            continue;
        };
        let Some(pid) =
            number(info, unsafe { kCGWindowOwnerPID }).and_then(|pid| i32::try_from(pid).ok())
        else {
            continue;
        };
        let on_screen = info
            .get(unsafe { kCGWindowIsOnscreen })
            .and_then(|v| v.downcast_ref::<CFBoolean>().map(|v| v.value()))
            .unwrap_or(false);
        let alpha = info
            .get(unsafe { kCGWindowAlpha })
            .and_then(|v| v.downcast_ref::<CFNumber>()?.as_f64())
            .unwrap_or(0.0);
        let Some(bounds) = info.get(unsafe { kCGWindowBounds }) else {
            continue;
        };
        let Some(bounds) = bounds.downcast_ref::<CFDictionary>() else {
            continue;
        };
        let mut rect = CGRect::ZERO;
        if !unsafe { CGRectMakeWithDictionaryRepresentation(Some(bounds), &mut rect) } {
            continue;
        }
        let frame = Rect::new(
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
        );
        if same_window(expected, id, pid, frame, on_screen, alpha) {
            return Ok(());
        }
    }
    bail!(CHANGED)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(id: u32, pid: i32, frame: Rect, order: usize) -> Candidate {
        Candidate {
            id,
            pid,
            frame,
            order,
        }
    }
    const WINDOW: Rect = Rect {
        x: -900.0,
        y: 40.0,
        width: 800.0,
        height: 700.0,
    };
    const REGION: Rect = Rect {
        x: -880.5,
        y: 80.0,
        width: 760.5,
        height: 600.5,
    };

    #[test]
    fn source_window_is_eligible_but_same_app_timer_and_pointer_helpers_are_not() {
        assert!(eligible_window(0, 42, true, 1.0, "test.fixture", 99));
        for layer in [3, 8, 25, 1000] {
            assert!(!eligible_window(layer, 42, true, 1.0, "test.fixture", 99));
        }
        assert!(!eligible_window(0, 99, true, 1.0, "io.yuxino.kiri", 99));
        assert!(!eligible_window(
            0,
            42,
            true,
            1.0,
            "com.apple.WindowManager",
            99
        ));
        assert!(!eligible_window(0, 42, false, 1.0, "test.fixture", 99));
        assert!(!eligible_window(0, 42, true, 0.0, "test.fixture", 99));
    }

    #[test]
    fn ignores_partial_floating_overlap_and_selects_frontmost_containing_window() {
        let windows = [
            candidate(1, 10, Rect::new(-200.0, 200.0, 100.0, 100.0), 0),
            candidate(2, 20, WINDOW, 1),
            candidate(3, 30, Rect::new(-950.0, 0.0, 1000.0, 800.0), 2),
        ];
        assert_eq!(choose(&windows, REGION, None).unwrap(), target(windows[1]));
        assert!(choose(&windows[..1], REGION, None).is_err());
    }

    #[test]
    fn coincident_windows_follow_visual_stack_and_activation_cannot_switch_bound_source() {
        // Array order and foreground PID do not identify the visible window.
        let windows = [candidate(1, 10, WINDOW, 1), candidate(2, 20, WINDOW, 0)];
        let selected = choose(&windows, REGION, None).unwrap();
        assert_eq!(selected, target(windows[1]));
        // Activating an app can change z-order after the initial binding.
        let reordered = [candidate(1, 10, WINDOW, 0), candidate(2, 20, WINDOW, 1)];
        assert_eq!(
            choose(&reordered, REGION, Some(selected)).unwrap(),
            selected
        );
        assert!(choose(&reordered[..1], REGION, Some(selected)).is_err());
        assert!(choose(&windows, REGION, Some(ScrollTarget::Display)).is_err());
    }

    #[test]
    fn window_identity_geometry_and_visibility_changes_fail_closed() {
        let bound = target(candidate(1, 20, WINDOW, 0));
        assert!(same_window(bound, 1, 20, WINDOW, true, 1.0));
        for (id, pid, frame, visible, alpha) in [
            (2, 20, WINDOW, true, 1.0),
            (1, 21, WINDOW, true, 1.0),
            (1, 20, Rect::new(-899.5, 40.0, 800.0, 700.0), true, 1.0),
            (1, 20, Rect::new(-900.0, 40.0, 801.0, 700.0), true, 1.0),
            (1, 20, WINDOW, false, 1.0),
            (1, 20, WINDOW, true, 0.0),
            (1, 20, WINDOW, true, f64::NAN),
        ] {
            assert!(!same_window(bound, id, pid, frame, visible, alpha));
        }
    }

    #[test]
    fn selection_must_fit_one_finite_window_without_clipping_or_expanding() {
        let windows = [candidate(1, 20, WINDOW, 0)];
        for region in [
            Rect::new(-901.0, 80.0, 500.0, 200.0),
            Rect::new(-880.0, 80.0, 900.0, 200.0),
            Rect::new(-880.0, f64::NAN, 100.0, 100.0),
            Rect::new(-880.0, 80.0, 0.0, 100.0),
        ] {
            assert!(choose(&windows, region, None).is_err());
        }
        assert_eq!(choose(&windows, WINDOW, None).unwrap(), target(windows[0]));
    }
}
