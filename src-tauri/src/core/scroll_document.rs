//! A scrolling capture is a document with a movable viewport, not a sequence
//! of images to concatenate. Positions remain signed so growing its top never
//! moves existing pixels or invalidates the search index.
//!
//! The index only proposes positions. Every position is checked against native
//! pixels before any content is committed. Unknown/ambiguous frames leave both
//! the document and the last confirmed viewport intact.

use std::collections::{HashMap, VecDeque};

use anyhow::{bail, Result};
use image::RgbaImage;

pub const MAX_SCROLL_WIDTH: u32 = 8192;
pub const MAX_SCROLL_HEIGHT: u32 = 32768;
pub const MAX_SCROLL_PIXELS: u64 = 32 * 1024 * 1024;
const MAX_PREVIEW_REGION_PIXELS: u64 = 4 * 1024 * 1024;
const MAX_REJECTED_FRAME_PIXELS: u64 = 4 * 1024 * 1024;
// Keep the last few proved native rows out of the matching body. At the
// beginning of a translucent fade, raster rounding can make a few affected
// rows coincidentally equal. These pixels remain visible and repairable.
const EDGE_PROOF_MARGIN: u32 = 8;

const BANDS: usize = 3;
const SAMPLES_PER_BAND: u32 = 24;
const MAX_KEY_POSITIONS: usize = 48;
const MAX_CANDIDATES: usize = 128;
const CHANNEL_TOLERANCE: u8 = 20;
const KEY_HEIGHT: u32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollUpdate {
    Started,
    Extended {
        top: u32,
        bottom: u32,
    },
    /// Fixed viewport edges were removed, or provisional pixels were repaired.
    Reframed,
    Located,
    Unchanged,
    Unmatched,
    LimitReached,
}

#[derive(Debug)]
struct Strip {
    start: i64,
    image: RgbaImage,
    observed_at: Vec<i64>,
    confirmed: Vec<bool>,
    provisional_edge: Vec<bool>,
}

#[derive(Debug)]
struct RowObservation {
    position: i64,
    pixels: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Body {
    top: u32,
    bottom: u32,
}

impl Strip {
    fn end(&self) -> i64 {
        self.start + i64::from(self.image.height())
    }
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct RowKey {
    band: u8,
    hash: u64,
    informative: bool,
}

/// A saturated key is deliberately no longer searchable: a repeated pattern
/// must not look unique just because the index stopped storing its occurrences.
#[derive(Debug)]
enum Occurrences {
    Positions(Vec<i64>),
    Repetitive,
}

#[derive(Debug)]
struct Candidate {
    position: i64,
    votes: usize,
    first_row: u32,
    last_row: u32,
    distinct_rows: usize,
    previous_row: u32,
}

impl Candidate {
    fn new(position: i64, row: u32) -> Self {
        Self {
            position,
            votes: 0,
            first_row: row,
            last_row: row,
            distinct_rows: 0,
            previous_row: u32::MAX,
        }
    }

    fn vote(&mut self, row: u32) {
        self.votes += 1;
        self.first_row = self.first_row.min(row);
        self.last_row = self.last_row.max(row);
        if row != self.previous_row {
            self.distinct_rows += 1;
            self.previous_row = row;
        }
    }
}

/// Accumulates the connected, verified part of a vertically scrolling surface.
///
/// Native motion identifies a contiguous scrolling body and removes stationary
/// top/bottom chrome. Blank margins can reopen when text proves they scroll.
/// Reflow, zoom changes and horizontal motion still require a new capture.
#[derive(Debug)]
pub struct ScrollDocument {
    width: u32,
    frame_height: u32,
    top: i64,
    bottom: i64,
    viewport_top: i64,
    strips: VecDeque<Strip>,
    index: HashMap<RowKey, Occurrences>,
    frames: u64,
    body: Body,
    visible: Body,
    last_frame: Option<RgbaImage>,
    last_unmatched: Option<RgbaImage>,
    body_locked: bool,
    unresolved: HashMap<i64, RowObservation>,
}

impl ScrollDocument {
    pub fn new(width: u32, height: u32) -> Result<Self> {
        if width < 16 || height < 32 {
            bail!("The scrolling capture region is too small");
        }
        if width > MAX_SCROLL_WIDTH || !within_limits(width, height) {
            bail!("The scrolling capture region exceeds the image limit");
        }
        Ok(Self {
            width,
            frame_height: height,
            top: 0,
            bottom: 0,
            viewport_top: 0,
            strips: VecDeque::new(),
            index: HashMap::new(),
            frames: 0,
            body: Body {
                top: 0,
                bottom: height,
            },
            visible: Body {
                top: 0,
                bottom: height,
            },
            last_frame: None,
            last_unmatched: None,
            body_locked: false,
            unresolved: HashMap::new(),
        })
    }

    pub fn push(&mut self, frame: RgbaImage) -> Result<ScrollUpdate> {
        if frame.dimensions() != (self.width, self.frame_height) {
            bail!("The scrolling capture frame dimensions changed");
        }
        self.frames = self.frames.saturating_add(1);
        // Rejection does not change document state. An identical stopped view
        // cannot acquire new evidence merely because the stream repeats it.
        // Clear the cache on any different input, including a bridge/revisit.
        if self.last_unmatched.as_ref() == Some(&frame) {
            return Ok(ScrollUpdate::Unmatched);
        }
        self.last_unmatched = None;
        if self.strips.is_empty() {
            self.bottom = i64::from(self.frame_height);
            self.last_frame = Some(frame.clone());
            self.strips.push_back(Strip {
                start: 0,
                image: frame,
                observed_at: vec![0; self.frame_height as usize],
                confirmed: vec![false; self.frame_height as usize],
                provisional_edge: vec![false; self.frame_height as usize],
            });
            self.index_rows(0, self.bottom - i64::from(KEY_HEIGHT));
            return Ok(ScrollUpdate::Started);
        }

        // An identical viewport has no measurable displacement. In particular,
        // a blank/repeated page must never extend merely because time passed.
        if self.last_frame.as_ref() == Some(&frame)
            && self.viewport_equals(&frame)
            && self.unresolved.is_empty()
        {
            return Ok(ScrollUpdate::Unchanged);
        }

        let candidates = self.candidates(&frame);
        let mut verified = Vec::new();
        let mut exact_without_detail = false;
        let stationary = self.stationary_rows(&frame);
        // An exact overlap wins over every nonzero error under the rules below.
        // Check exact candidates first so repeated paragraphs do not force full
        // channel-distance scans at dozens of already disproven positions.
        // Still inspect every proposal: a second exact overlap is ambiguous.
        for candidate in &candidates {
            let (body, visible) = self.body_for_motion(&frame, candidate.position, &stationary);
            let evidence = self.evidence_body(&frame, candidate.position, body, visible);
            if self.overlap_equals(&frame, candidate.position, evidence) {
                if self
                    .verification_error(&frame, candidate.position, evidence)
                    .is_some()
                {
                    verified.push((candidate.position, 0.0, body, visible, evidence));
                    if verified.len() == 2 {
                        return self.unmatched(frame);
                    }
                } else {
                    exact_without_detail = true;
                }
            }
        }
        // A plausible exact overlap with insufficient detail is unresolved
        // evidence, not permission to select a worse noisy repeated paragraph.
        if exact_without_detail {
            return self.unmatched(frame);
        }
        if verified.is_empty() {
            for candidate in &candidates {
                let (body, visible) = self.body_for_motion(&frame, candidate.position, &stationary);
                let evidence = self.evidence_body(&frame, candidate.position, body, visible);
                if let Some(error) = self.verification_error(&frame, candidate.position, evidence) {
                    verified.push((candidate.position, error, body, visible, evidence));
                }
            }
        }
        verified.sort_unstable_by(|left, right| left.1.total_cmp(&right.1));
        let Some(&(position, error, body, visible, evidence)) = verified.first() else {
            return self.unmatched(frame);
        };
        if error == 0.0 && self.overlap_evidence_repeats(position, evidence) {
            return self.unmatched(frame);
        }
        // The byte-identical case returned above. A small changed identifier in
        // an otherwise repeated page must not be mistaken for staying here.
        if position == self.viewport_top && error != 0.0 {
            return self.unmatched(frame);
        }
        // Quantized proposal keys can nominate nearby raster rows around
        // low-contrast curves. Refine using native-pixel error, rather than
        // treating every position inside the noise tolerance as equally good.
        // Exact repeats remain ambiguous; noisy matches need a clear margin.
        let ambiguity_threshold = if error == 0.0 {
            0.0
        } else {
            error * 1.5 + 0.05
        };
        if verified
            .iter()
            .skip(1)
            .any(|&(other_position, other_error, _, _, _)| {
                other_error <= ambiguity_threshold
                    // Small fields in repeated paragraphs must not decide
                    // between distant positions using a global average error.
                    // A truly exact numbered overlap can distinguish them;
                    // noise-tolerant refinement only applies to one local peak.
                    || (error != 0.0 && other_position.abs_diff(position) > 8)
            })
        {
            return self.unmatched(frame);
        }
        if position != self.viewport_top
            && self.body_locked
            && (position + i64::from(visible.top) < self.top
                || position + i64::from(visible.bottom) > self.bottom)
            && self.has_stationary_edge(&frame, position)
        {
            return self.unmatched(frame);
        }

        let reframed = body != self.body || visible != self.visible;
        let initial_reframe = reframed && !self.body_locked;
        let base_top = if initial_reframe {
            i64::from(visible.top)
        } else {
            self.top
        };
        let base_bottom = if initial_reframe {
            i64::from(visible.bottom)
        } else {
            self.bottom
        };
        let start = position + i64::from(visible.top);
        let end = position + i64::from(visible.bottom);
        let new_top = base_top.min(start);
        let new_bottom = base_bottom.max(end);
        let new_height = (new_bottom - new_top) as u32;
        if !within_limits(self.width, new_height) {
            return Ok(ScrollUpdate::LimitReached);
        }
        if initial_reframe {
            self.reframe_initial(body, visible);
        } else {
            self.body = body;
            self.visible = visible;
        }
        let repaired = self.observe_overlap(&frame, position);
        let added_top = (self.top - new_top) as u32;
        let added_bottom = (new_bottom - self.bottom) as u32;

        // Only new strips are copied here. Confirmed rows remain immutable;
        // provisional rows require independent displaced observations to repair.
        if added_top != 0 {
            let image =
                image::imageops::crop_imm(&frame, 0, visible.top, self.width, added_top).to_image();
            self.strips.push_front(Strip {
                start: new_top,
                image,
                observed_at: vec![position; added_top as usize],
                confirmed: vec![false; added_top as usize],
                provisional_edge: (visible.top..visible.top + added_top)
                    .map(|y| y < body.top || y >= body.bottom)
                    .collect(),
            });
            self.index_rows(new_top, self.top);
        }
        if added_bottom != 0 {
            let from = visible.bottom - added_bottom;
            let image =
                image::imageops::crop_imm(&frame, 0, from, self.width, added_bottom).to_image();
            self.strips.push_back(Strip {
                start: self.bottom,
                image,
                observed_at: vec![position; added_bottom as usize],
                confirmed: vec![false; added_bottom as usize],
                provisional_edge: (from..visible.bottom)
                    .map(|y| y < body.top || y >= body.bottom)
                    .collect(),
            });
            self.index_rows(
                self.bottom - i64::from(KEY_HEIGHT),
                new_bottom - i64::from(KEY_HEIGHT),
            );
        }

        let moved = position != self.viewport_top;
        self.top = new_top;
        self.bottom = new_bottom;
        self.viewport_top = position;
        self.last_frame = Some(frame);
        self.body_locked |= moved;
        Ok(if reframed || repaired {
            ScrollUpdate::Reframed
        } else if added_top != 0 || added_bottom != 0 {
            ScrollUpdate::Extended {
                top: added_top,
                bottom: added_bottom,
            }
        } else if moved {
            ScrollUpdate::Located
        } else {
            ScrollUpdate::Unchanged
        })
    }

    /// Dimensions of the connected native image, or `(width, 0)` initially.
    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, (self.bottom - self.top) as u32)
    }

    pub fn frame_count(&self) -> u64 {
        self.frames
    }

    pub fn origin(&self) -> i64 {
        self.top
    }

    /// A later displaced observation contradicted provisional pixels. Keep
    /// tracking, but do not call the current image a complete verified result.
    pub fn has_unresolved_patches(&self) -> bool {
        !self.unresolved.is_empty()
    }

    /// Top and height of the last confirmed viewport in exported coordinates.
    pub fn viewport(&self) -> (u32, u32) {
        if self.strips.is_empty() {
            return (0, 0);
        }
        (
            (self.viewport_top + i64::from(self.body.top) - self.top) as u32,
            self.body.bottom - self.body.top,
        )
    }

    /// Materialize only when saving; matching does not clone the accumulated
    /// document. Every output byte comes from an accepted native frame.
    pub fn image(&self) -> Option<RgbaImage> {
        if self.strips.is_empty() {
            return None;
        }
        let (_, height) = self.dimensions();
        let mut bytes = Vec::with_capacity(self.width as usize * height as usize * 4);
        for strip in &self.strips {
            bytes.extend_from_slice(strip.image.as_raw());
        }
        RgbaImage::from_raw(self.width, height, bytes)
    }

    /// Copy a native-pixel region using document-relative coordinates.
    ///
    /// The rectangle is clipped to the current document. Empty rectangles and
    /// clipped rectangles exceeding 4 Mi pixels return `None`; callers should
    /// bound requests to the visible preview viewport. No full image is made.
    pub fn preview_region(&self, x: u32, y: u32, width: u32, height: u32) -> Option<RgbaImage> {
        let (document_width, document_height) = self.dimensions();
        let width = width.min(document_width.checked_sub(x)?);
        let height = height.min(document_height.checked_sub(y)?);
        if width == 0
            || height == 0
            || u64::from(width) * u64::from(height) > MAX_PREVIEW_REGION_PIXELS
        {
            return None;
        }
        let start = x as usize * 4;
        let end = start + width as usize * 4;
        let mut bytes = Vec::with_capacity(width as usize * height as usize * 4);
        for row_y in y..y + height {
            bytes.extend_from_slice(&self.row(self.top + i64::from(row_y))?[start..end]);
        }
        RgbaImage::from_raw(width, height, bytes)
    }

    fn minimum_overlap(&self) -> u32 {
        Self::minimum_overlap_for(self.body)
    }

    fn minimum_overlap_for(body: Body) -> u32 {
        ((body.bottom - body.top) / 5).clamp(16, 192)
    }

    fn unmatched(&mut self, frame: RgbaImage) -> Result<ScrollUpdate> {
        if u64::from(frame.width()) * u64::from(frame.height()) <= MAX_REJECTED_FRAME_PIXELS {
            self.last_unmatched = Some(frame);
        }
        Ok(ScrollUpdate::Unmatched)
    }

    fn stationary_rows(&self, frame: &RgbaImage) -> Vec<bool> {
        let Some(previous) = &self.last_frame else {
            return vec![false; self.frame_height as usize];
        };
        let stride = self.width as usize * 4;
        previous
            .as_raw()
            .chunks_exact(stride)
            .zip(frame.as_raw().chunks_exact(stride))
            .map(|(left, right)| left == right)
            .collect()
    }

    /// Equal screen coordinates alone are not evidence of a fixed bar: blank
    /// paragraphs also stay white. A stationary row must additionally disagree
    /// with BOTH available displacement correspondences. Ordinary translated
    /// content satisfies each correspondence, including its blank margins.
    fn contradicts_motion(&self, frame: &RgbaImage, y: u32, delta: i64) -> bool {
        let Some(previous) = &self.last_frame else {
            return false;
        };
        let stride = self.width as usize * 4;
        let mut comparisons = 0;
        for (left, right, shifted) in [
            (frame, previous, i64::from(y) + delta),
            (previous, frame, i64::from(y) - delta),
        ] {
            if shifted >= 0 && shifted < i64::from(self.frame_height) {
                comparisons += 1;
                let a = y as usize * stride;
                let b = shifted as usize * stride;
                if left.as_raw()[a..a + stride] == right.as_raw()[b..b + stride] {
                    return false;
                }
            }
        }
        comparisons != 0
    }

    fn body_for_motion(&self, frame: &RgbaImage, position: i64, same: &[bool]) -> (Body, Body) {
        let delta = position - self.viewport_top;
        if delta == 0 || delta.abs() >= i64::from(self.frame_height) {
            return (self.body, self.visible);
        }
        if self.body_locked {
            return self.expand_body(frame, delta, same);
        }
        let edge_limit = self.frame_height / 3;
        let prefix = (same.iter().take_while(|&&equal| equal).count() as u32).min(edge_limit);
        let suffix = (same.iter().rev().take_while(|&&equal| equal).count() as u32).min(edge_limit);
        let anchored =
            |start: u32, end: u32| (start..end).any(|y| self.contradicts_motion(frame, y, delta));
        let mut body = self.body;
        if prefix > 0 && prefix <= edge_limit && anchored(0, prefix) {
            body.top = prefix;
        }
        if suffix > 0
            && suffix <= edge_limit
            && anchored(self.frame_height - suffix, self.frame_height)
        {
            body.bottom = self.frame_height - suffix;
        }
        // Repeated text can occupy the same screen rows in two different
        // paragraphs. A detailed row that also follows the measured motion is
        // body content, even if it happens to lie in a stationary white run.
        let whole_frame = Body {
            top: 0,
            bottom: self.frame_height,
        };
        if body.top != 0 {
            if let Some(y) = (0..body.top)
                .find(|&y| self.proven_translated_detail(frame, y, delta, whole_frame, 1))
            {
                body.top = y;
            }
        }
        if body.bottom != self.frame_height {
            if let Some(y) = (body.bottom..self.frame_height)
                .rev()
                .find(|&y| self.proven_translated_detail(frame, y, delta, whole_frame, 1))
            {
                body.bottom = y + 1;
            }
        }
        let visible = body;

        // A translucent shadow can vary with the text underneath while its
        // opaque composer remains stationary. Once an edge is independently
        // anchored, exclude its adjoining disagreement from matching, using
        // the unshadowed displaced observation. Retain visible fringe pixels
        // for later repair instead of deleting text that just left the view.
        if body != self.body {
            let previous = self.last_frame.as_ref().expect("started frame");
            let stride = self.width as usize * 4;
            let probe_height = (self.frame_height / 8).clamp(32, 192);
            let mut top = body.top;
            let mut bottom = body.bottom;
            // Stop at the first detailed row that already proves normal
            // translation. A different paragraph number farther inside the
            // body is contradictory content, not permission to keep cropping
            // until a repeated paragraph becomes an apparently exact overlap.
            let top_proof = (body.top..body.top.saturating_add(probe_height).min(body.bottom))
                .find(|&y| self.proven_translated_detail(frame, y, delta, body, 24));
            let bottom_proof = (body.bottom.saturating_sub(probe_height).max(body.top)
                ..body.bottom)
                .rev()
                .find(|&y| self.proven_translated_detail(frame, y, delta, body, 24));
            for y in body.top..body.bottom {
                let near_top =
                    body.top != 0 && y < top_proof.unwrap_or(body.top.saturating_add(probe_height));
                if !near_top {
                    continue;
                }
                for (left, right, shifted) in [
                    (previous, frame, i64::from(y) - delta),
                    (frame, previous, i64::from(y) + delta),
                ] {
                    if shifted >= i64::from(body.top) && shifted < i64::from(body.bottom) {
                        let a = y as usize * stride;
                        let b = shifted as usize * stride;
                        if left.as_raw()[a..a + stride] != right.as_raw()[b..b + stride] && near_top {
                            top = top.max(y + 1);
                        }
                    }
                }
            }
            if top != body.top {
                top = top_proof.unwrap_or(body.top.saturating_add(probe_height).min(body.bottom));
            }
            if body.bottom != self.frame_height {
                bottom = bottom_proof.map_or(
                    body.bottom.saturating_sub(probe_height).max(body.top),
                    |y| y + 1,
                );
            }
            body.top = top;
            body.bottom = bottom;
        }
        if body.bottom.saturating_sub(body.top) < self.minimum_overlap().max(32) {
            (self.body, self.visible)
        } else {
            (body, visible)
        }
    }

    fn proven_translated_detail(
        &self,
        frame: &RgbaImage,
        y: u32,
        delta: i64,
        body: Body,
        minimum_contrast: u8,
    ) -> bool {
        let previous = self.last_frame.as_ref().expect("started frame");
        let stride = self.width as usize * 4;
        for (left, right, shifted) in [
            (previous, frame, i64::from(y) - delta),
            (frame, previous, i64::from(y) + delta),
        ] {
            if shifted < i64::from(body.top) || shifted >= i64::from(body.bottom) {
                continue;
            }
            let a = y as usize * stride;
            let b = shifted as usize * stride;
            let row = &left.as_raw()[a..a + stride];
            if row == &right.as_raw()[b..b + stride] && row_has_detail(row, minimum_contrast) {
                return true;
            }
        }
        false
    }

    fn displaced_row_equals(&self, frame: &RgbaImage, y: u32, delta: i64, body: Body) -> bool {
        let previous = self.last_frame.as_ref().expect("started frame");
        let stride = self.width as usize * 4;
        let mut compared = false;
        for (left, right, shifted) in [
            (previous, frame, i64::from(y) - delta),
            (frame, previous, i64::from(y) + delta),
        ] {
            if shifted >= i64::from(body.top) && shifted < i64::from(body.bottom) {
                compared = true;
                let a = y as usize * stride;
                let b = shifted as usize * stride;
                if left.as_raw()[a..a + stride] != right.as_raw()[b..b + stride] {
                    return false;
                }
            }
        }
        compared
    }

    /// Exact blank rows after proved text can support this pair's displacement
    /// without proving where a white translucent overlay ends on future frames.
    /// Use them only as matching evidence; never promote them to the stored body.
    fn evidence_body(&self, frame: &RgbaImage, position: i64, body: Body, visible: Body) -> Body {
        if self.body_locked || position == self.viewport_top || visible.bottom == self.frame_height
        {
            return body;
        }
        let mut end = body.bottom;
        while end < visible.bottom
            && self.displaced_row_equals(frame, end, position - self.viewport_top, visible)
        {
            end += 1;
        }
        if end < visible.bottom {
            Body {
                top: body.top,
                bottom: end.saturating_sub(EDGE_PROOF_MARGIN).max(body.bottom),
            }
        } else {
            body
        }
    }

    /// A blank gap adjoining a fixed bar can initially look like part of that
    /// bar. Widen the body again as soon as native pixels in the excluded gap
    /// demonstrably translate. This prevents a generous initial white margin
    /// from permanently cutting off text when the user returns to the top.
    fn expand_body(&self, frame: &RgbaImage, delta: i64, same: &[bool]) -> (Body, Body) {
        let previous = self.last_frame.as_ref().expect("started frame");
        let stride = self.width as usize * 4;
        let mut body = self.body;
        let mut visible = self.visible;
        for y in (0..body.top).chain(body.bottom..self.frame_height) {
            if same[y as usize] {
                continue;
            }
            let shifted = i64::from(y) + delta;
            if shifted < 0 || shifted >= i64::from(self.frame_height) {
                continue;
            }
            let source = y as usize * stride;
            let known = shifted as usize * stride;
            if frame.as_raw()[source..source + stride] == previous.as_raw()[known..known + stride]
                && row_has_detail(&frame.as_raw()[source..source + stride], 24)
            {
                if y < self.body.top {
                    body.top = body.top.min(y.saturating_add(EDGE_PROOF_MARGIN));
                    visible.top = visible.top.min(y);
                } else {
                    body.bottom = body.bottom.max((y + 1).saturating_sub(EDGE_PROOF_MARGIN));
                    visible.bottom = visible.bottom.max(y + 1);
                }
            }
        }
        (body, visible)
    }

    fn reframe_initial(&mut self, body: Body, visible: Body) {
        debug_assert!(!self.body_locked && self.strips.len() == 1);
        let first = self.strips.front_mut().expect("started frame");
        first.image = image::imageops::crop_imm(
            &first.image,
            0,
            visible.top,
            self.width,
            visible.bottom - visible.top,
        )
        .to_image();
        first.start = i64::from(visible.top);
        first.confirmed = vec![false; first.image.height() as usize];
        first.observed_at = vec![0; first.image.height() as usize];
        first.provisional_edge = (visible.top..visible.bottom)
            .map(|y| y < body.top || y >= body.bottom)
            .collect();
        self.body = body;
        self.visible = visible;
        self.top = i64::from(visible.top);
        self.bottom = i64::from(visible.bottom);
        self.index.clear();
        self.index_rows(self.top, self.bottom - i64::from(KEY_HEIGHT));
    }

    fn observe_overlap(&mut self, frame: &RgbaImage, position: i64) -> bool {
        let start = self.top.max(position + i64::from(self.body.top));
        let end = self.bottom.min(position + i64::from(self.body.bottom));
        let stride = self.width as usize * 4;
        let mut repaired = false;
        let mut stored_rows = self
            .unresolved
            .values()
            .filter(|observation| observation.pixels.is_some())
            .count();
        let maximum_rows = (MAX_PREVIEW_REGION_PIXELS / u64::from(self.width)) as usize;
        for strip in &mut self.strips {
            for y in start.max(strip.start)..end.min(strip.end()) {
                let local_y = (y - strip.start) as usize;
                if strip.confirmed[local_y] {
                    continue;
                }
                let offset = local_y * stride;
                let source = (y - position) as usize * stride;
                let known = &mut strip.image.as_mut()[offset..offset + stride];
                let incoming = &frame.as_raw()[source..source + stride];
                // Returning to the original noisy position is not new proof.
                // It may confirm a clean repair retained at a different
                // position, but must not confirm the old noisy pixels.
                if strip.observed_at[local_y] == position
                    && !self.unresolved.get(&y).is_some_and(|observation| {
                        observation.position != position
                            && observation.pixels.as_deref() == Some(incoming)
                            && known != incoming
                    })
                {
                    continue;
                }
                if known == incoming {
                    strip.confirmed[local_y] = true;
                    strip.provisional_edge[local_y] = false;
                    if self
                        .unresolved
                        .remove(&y)
                        .is_some_and(|row| row.pixels.is_some())
                    {
                        stored_rows -= 1;
                    }
                } else if strip.provisional_edge[local_y] {
                    // A visible fringe is retained, never guessed away. Once
                    // it enters the proven moving body, prefer the unobscured
                    // native row. Keep this replacement provisional until a
                    // further displaced observation confirms it.
                    known.copy_from_slice(incoming);
                    strip.provisional_edge[local_y] = false;
                    strip.observed_at[local_y] = position;
                    if self
                        .unresolved
                        .remove(&y)
                        .is_some_and(|row| row.pixels.is_some())
                    {
                        stored_rows -= 1;
                    }
                    repaired = true;
                } else if let Some(observation) = self.unresolved.get_mut(&y) {
                    if observation.position != position {
                        if observation.pixels.as_deref() == Some(incoming) {
                            known.copy_from_slice(incoming);
                            strip.confirmed[local_y] = true;
                            self.unresolved.remove(&y);
                            stored_rows -= 1;
                            repaired = true;
                        } else if observation.pixels.is_none() && stored_rows < maximum_rows {
                            observation.pixels = Some(incoming.to_vec());
                            observation.position = position;
                            stored_rows += 1;
                        }
                    }
                } else {
                    let pixels = (stored_rows < maximum_rows).then(|| incoming.to_vec());
                    stored_rows += usize::from(pixels.is_some());
                    self.unresolved
                        .insert(y, RowObservation { position, pixels });
                }
            }
        }
        if repaired {
            // Repairs are exceptional; rebuilding removes old proposal keys
            // rather than allowing invalidated pixels to poison uniqueness.
            self.index.clear();
            self.index_rows(self.top, self.bottom - i64::from(KEY_HEIGHT));
        }
        repaired
    }

    fn has_stationary_edge(&self, frame: &RgbaImage, position: i64) -> bool {
        let same = self.stationary_rows(frame);
        let edge_height = (self.body.bottom - self.body.top) / 3;
        let delta = position - self.viewport_top;
        for edge_start in [self.body.top, self.body.bottom - edge_height] {
            let mut stationary_rows = 0;
            for y in edge_start..edge_start + edge_height {
                if same[y as usize] && self.contradicts_motion(frame, y, delta) {
                    stationary_rows += 1;
                    if stationary_rows >= 3 {
                        return true;
                    }
                } else {
                    stationary_rows = 0;
                }
            }
        }
        false
    }

    fn strip_at(&self, y: i64) -> Option<&Strip> {
        let mut left = 0;
        let mut right = self.strips.len();
        while left < right {
            let middle = left + (right - left) / 2;
            let strip = &self.strips[middle];
            if y < strip.start {
                right = middle;
            } else if y >= strip.end() {
                left = middle + 1;
            } else {
                return Some(strip);
            }
        }
        None
    }

    fn row(&self, y: i64) -> Option<&[u8]> {
        let strip = self.strip_at(y)?;
        let start = (y - strip.start) as usize * self.width as usize * 4;
        Some(&strip.image.as_raw()[start..start + self.width as usize * 4])
    }

    fn matching_row(&self, y: i64) -> Option<&[u8]> {
        let strip = self.strip_at(y)?;
        let local = (y - strip.start) as usize;
        if strip.provisional_edge[local] {
            return None;
        }
        let start = local * self.width as usize * 4;
        Some(&strip.image.as_raw()[start..start + self.width as usize * 4])
    }

    fn viewport_equals(&self, frame: &RgbaImage) -> bool {
        let stride = self.width as usize * 4;
        (self.body.top..self.body.bottom).all(|y| {
            self.row(self.viewport_top + i64::from(y))
                == Some(&frame.as_raw()[y as usize * stride..(y as usize + 1) * stride])
        })
    }

    fn overlap_equals(&self, frame: &RgbaImage, position: i64, body: Body) -> bool {
        let top = self
            .top
            .max(if self.body_locked {
                self.top
            } else {
                i64::from(body.top)
            })
            .max(position + i64::from(body.top));
        let bottom = self
            .bottom
            .min(if self.body_locked {
                self.bottom
            } else {
                i64::from(body.bottom)
            })
            .min(position + i64::from(body.bottom));
        let stride = self.width as usize * 4;
        let mut compared = 0;
        for y in top..bottom {
            let Some(known) = self.matching_row(y) else {
                continue;
            };
            let source_start = (y - position) as usize * stride;
            if known != &frame.as_raw()[source_start..source_start + stride] {
                return false;
            }
            compared += 1;
        }
        compared >= self.minimum_overlap()
    }

    /// Different candidates can cover different amounts of known content.
    /// A short exact repeated paragraph must not beat a longer noisy candidate
    /// merely because the distinguishing number lies outside the short overlap.
    /// Compare the winning evidence itself at the other proposed locations.
    fn overlap_evidence_repeats(&self, position: i64, body: Body) -> bool {
        let top = self
            .top
            .max(if self.body_locked {
                self.top
            } else {
                i64::from(body.top)
            })
            .max(position + i64::from(body.top));
        let bottom = self
            .bottom
            .min(if self.body_locked {
                self.bottom
            } else {
                i64::from(body.bottom)
            })
            .min(position + i64::from(body.bottom));
        let keys: Vec<_> = (top..bottom)
            .map(|y| {
                self.matching_row(y)
                    .map(|row| row_keys(row, self.width))
                    .unwrap_or([None; BANDS])
            })
            .collect();
        let mut anchor: Option<(i64, &[i64])> = None;
        for y in top..bottom - i64::from(KEY_HEIGHT) {
            for key in compound_keys(&keys, (y - top) as usize)
                .into_iter()
                .flatten()
            {
                if let Some(Occurrences::Positions(positions)) = self.index.get(&key) {
                    if anchor.is_none_or(|(_, previous)| positions.len() < previous.len()) {
                        anchor = Some((y, positions));
                    }
                }
            }
        }
        // One unsaturated key covers every byte-identical copy of the whole
        // evidence interval. Saturated keys or the candidate shortlist cannot
        // establish uniqueness by silently omitting other occurrences.
        let Some((y, positions)) = anchor else {
            return true;
        };
        positions.iter().any(|&other| {
            if other == y {
                return false;
            }
            let offset = other - y;
            let mut compared = 0;
            for row_y in top..bottom {
                let Some(known) = self.matching_row(row_y) else {
                    continue;
                };
                if self.matching_row(row_y + offset) != Some(known) {
                    return false;
                }
                compared += 1;
            }
            compared >= self.minimum_overlap()
        })
    }

    fn index_rows(&mut self, start: i64, end: i64) {
        let keys: Vec<_> = (start..end + i64::from(KEY_HEIGHT))
            .map(|y| {
                self.row(y)
                    .map(|row| row_keys(row, self.width))
                    .unwrap_or([None; BANDS])
            })
            .collect();
        for y in start..end {
            for key in compound_keys(&keys, (y - start) as usize)
                .into_iter()
                .flatten()
            {
                let occurrences = self
                    .index
                    .entry(key)
                    .or_insert_with(|| Occurrences::Positions(Vec::new()));
                if let Occurrences::Positions(positions) = occurrences {
                    if positions.len() == MAX_KEY_POSITIONS {
                        *occurrences = Occurrences::Repetitive;
                    } else {
                        positions.push(y);
                    }
                }
            }
        }
    }

    fn candidates(&self, frame: &RgbaImage) -> Vec<Candidate> {
        let minimum = i64::from(self.minimum_overlap());
        let earliest = self.top - i64::from(self.frame_height) + minimum;
        let latest = self.bottom - minimum;
        let stride = self.width as usize * 4;
        let mut votes: HashMap<i64, Candidate> = HashMap::new();
        let keys: Vec<_> = frame
            .as_raw()
            .chunks_exact(stride)
            .map(|row| row_keys(row, self.width))
            .collect();
        for y in 0..self.frame_height - KEY_HEIGHT {
            for key in compound_keys(&keys, y as usize).into_iter().flatten() {
                let Some(Occurrences::Positions(positions)) = self.index.get(&key) else {
                    continue;
                };
                for known in positions {
                    let position = known - i64::from(y);
                    if position >= earliest && position <= latest {
                        votes
                            .entry(position)
                            .or_insert_with(|| Candidate::new(position, y))
                            .vote(y);
                    }
                }
            }
        }
        // Before learning fixed edges, use the smallest possible body only for
        // nomination. Every proposal still proves the actual body-sized overlap
        // below; otherwise whitespace beside a composer can hide a valid first
        // movement before its fixed edges have even been inspected.
        let proposal_overlap = if self.body_locked {
            self.minimum_overlap()
        } else {
            (self.frame_height / 15).clamp(16, 192)
        };
        let minimum_rows = (proposal_overlap / 8).clamp(3, 12) as usize;
        let minimum_spread = (proposal_overlap / 3).max(8);
        let mut candidates: Vec<_> = votes
            .into_values()
            .filter(|candidate| {
                candidate.distinct_rows >= minimum_rows
                    && candidate.last_row - candidate.first_row >= minimum_spread
            })
            .collect();
        candidates.sort_unstable_by(|left, right| {
            right
                .votes
                .cmp(&left.votes)
                .then_with(|| left.position.cmp(&right.position))
        });
        // Do not silently truncate ambiguous repeated patterns into a seemingly
        // unique match. No position is accepted when the shortlist is saturated.
        if candidates.len() > MAX_CANDIDATES
            && candidates[MAX_CANDIDATES].votes * 2 >= candidates[0].votes
        {
            return Vec::new();
        }
        candidates.truncate(MAX_CANDIDATES);
        candidates
    }

    fn verification_error(&self, frame: &RgbaImage, position: i64, body: Body) -> Option<f64> {
        let minimum_overlap = Self::minimum_overlap_for(body);
        let overlap_top = self
            .top
            .max(if self.body_locked {
                self.top
            } else {
                i64::from(body.top)
            })
            .max(position + i64::from(body.top));
        let overlap_bottom = self
            .bottom
            .min(if self.body_locked {
                self.bottom
            } else {
                i64::from(body.bottom)
            })
            .min(position + i64::from(body.bottom));
        if overlap_bottom <= overlap_top {
            return None;
        }
        let overlap_height = (overlap_top..overlap_bottom)
            .filter(|&y| self.matching_row(y).is_some())
            .count() as u32;
        // Keep the original geometric-overlap requirement while learning
        // edges. Only the distribution of detailed pixels is body-relative:
        // cropping chrome must not make a tiny repeated fragment sufficient.
        if overlap_height < self.minimum_overlap() {
            return None;
        }
        let stride = self.width as usize * 4;

        // Reject poor hypotheses cheaply before visiting every native pixel.
        let step_x = (self.width / 64).max(1);
        let step_y = (overlap_height / 96).max(1);
        let mut coarse_bad = 0_u64;
        let mut coarse_total = 0_u64;
        for y in (overlap_top..overlap_bottom).step_by(step_y as usize) {
            let Some(known) = self.matching_row(y) else {
                continue;
            };
            let source_start = (y - position) as usize * stride;
            let source = &frame.as_raw()[source_start..source_start + stride];
            for x in (0..self.width).step_by(step_x as usize) {
                let offset = x as usize * 4;
                coarse_total += 1;
                coarse_bad += u64::from(pixel_differs(
                    &known[offset..offset + 4],
                    &source[offset..offset + 4],
                ));
            }
        }
        if coarse_bad * 100 > coarse_total * 4 {
            return None;
        }

        let maximum_bad_pixels = u64::from(self.width) * u64::from(overlap_height) / 40;
        let maximum_bad_rows = (overlap_height / 12).max(2);
        let mut bad_pixels = 0_u64;
        let mut bad_rows = 0_u32;
        let mut informative_rows = 0_u32;
        let mut informative_top = overlap_bottom;
        let mut informative_bottom = overlap_top;
        let mut total_error = 0_u64;
        for y in overlap_top..overlap_bottom {
            let Some(known) = self.matching_row(y) else {
                continue;
            };
            let source_start = (y - position) as usize * stride;
            let source = &frame.as_raw()[source_start..source_start + stride];
            // Most correctly aligned rows are byte-identical. A native memcmp
            // checks all their pixels; do not recompute four channel distances
            // for every pixel of an already exact row on every captured frame.
            if known == source {
                let mut low = u8::MAX;
                let mut high = 0_u8;
                for pixel in known
                    .chunks_exact(4)
                    .step_by((self.width as usize / 96).max(1))
                {
                    let light = luminance(pixel);
                    low = low.min(light);
                    high = high.max(light);
                }
                if high - low >= 24 {
                    informative_rows += 1;
                    informative_top = informative_top.min(y);
                    informative_bottom = informative_bottom.max(y);
                }
                continue;
            }
            let mut row_bad = 0_u32;
            let mut low = u8::MAX;
            let mut high = 0_u8;
            for x in 0..self.width as usize {
                let offset = x * 4;
                let a = &known[offset..offset + 4];
                let b = &source[offset..offset + 4];
                row_bad += u32::from(pixel_differs(a, b));
                total_error += a
                    .iter()
                    .zip(b)
                    .map(|(left, right)| u64::from(left.abs_diff(*right)))
                    .sum::<u64>();
                let light = luminance(a);
                low = low.min(light);
                high = high.max(light);
            }
            bad_pixels += u64::from(row_bad);
            if row_bad > (self.width / 16).max(2) {
                bad_rows += 1;
            } else if high - low >= 24 {
                informative_rows += 1;
                informative_top = informative_top.min(y);
                informative_bottom = informative_bottom.max(y);
            }
            if bad_pixels > maximum_bad_pixels || bad_rows > maximum_bad_rows {
                return None;
            }
        }
        (informative_rows >= (minimum_overlap / 8).clamp(3, 12)
            && informative_bottom - informative_top >= i64::from(minimum_overlap / 3))
        .then_some(total_error as f64 / (f64::from(self.width) * f64::from(overlap_height)))
    }
}

fn within_limits(width: u32, height: u32) -> bool {
    height <= MAX_SCROLL_HEIGHT && u64::from(width) * u64::from(height) <= MAX_SCROLL_PIXELS
}

fn luminance(pixel: &[u8]) -> u8 {
    ((u16::from(pixel[0]) * 3 + u16::from(pixel[1]) * 6 + u16::from(pixel[2])) / 10) as u8
}

fn row_has_detail(row: &[u8], minimum_contrast: u8) -> bool {
    let mut low = u8::MAX;
    let mut high = 0;
    for pixel in row.chunks_exact(4) {
        let light = luminance(pixel);
        low = low.min(light);
        high = high.max(light);
        if high - low >= minimum_contrast {
            return true;
        }
    }
    false
}

fn pixel_differs(left: &[u8], right: &[u8]) -> bool {
    left.iter()
        .zip(right)
        .any(|(left, right)| left.abs_diff(*right) > CHANNEL_TOLERANCE)
}

fn row_keys(row: &[u8], width: u32) -> [Option<RowKey>; BANDS] {
    std::array::from_fn(|band| {
        let start = width * band as u32 / BANDS as u32;
        let end = width * (band + 1) as u32 / BANDS as u32;
        let band_width = end - start;
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        let mut low = u8::MAX;
        let mut high = 0_u8;
        for sample in 0..SAMPLES_PER_BAND {
            let x = start
                + ((u64::from(sample * 2 + 1) * u64::from(band_width))
                    / u64::from(SAMPLES_PER_BAND * 2)) as u32;
            let pixel = &row[x as usize * 4..x as usize * 4 + 4];
            let light = luminance(pixel);
            low = low.min(light);
            high = high.max(light);
            for channel in &pixel[..3] {
                hash ^= u64::from(channel >> 3);
                hash = hash.wrapping_mul(0x100_0000_01b3);
            }
        }
        Some(RowKey {
            band: band as u8,
            hash,
            informative: high - low >= 24,
        })
    })
}

fn compound_keys(rows: &[[Option<RowKey>; BANDS]], y: usize) -> [Option<RowKey>; BANDS] {
    std::array::from_fn(|band| {
        let first = rows[y][band];
        let middle = rows[y + 2][band];
        let last = rows[y + KEY_HEIGHT as usize][band];
        let informative = [first, middle, last]
            .into_iter()
            .flatten()
            .any(|key| key.informative);
        if !informative && first == middle && middle == last {
            return None;
        }
        // A single raster line of two different words can look identical.
        // Three lines retain the glyph's vertical shape without resizing it.
        let hash = first.map_or(0, |key| key.hash)
            ^ middle.map_or(0, |key| key.hash).rotate_left(21)
            ^ last.map_or(0, |key| key.hash).rotate_left(43);
        Some(RowKey {
            band: band as u8,
            hash,
            informative: true,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn page(width: u32, height: u32) -> RgbaImage {
        // Coordinate-derived native pixels make a one-row seam error visible;
        // no random seed, platform font or external fixture is involved.
        RgbaImage::from_fn(width, height, |x, y| {
            let mut value = (u64::from(y) + 1).wrapping_mul(0x9e37_79b9);
            value ^= (u64::from(x) + 3).wrapping_mul(0x85eb_ca6b);
            value ^= value >> 16;
            Rgba([
                (value >> 3) as u8,
                (value >> 11) as u8,
                (value >> 19) as u8,
                255,
            ])
        })
    }

    fn frame(page: &RgbaImage, y: u32, height: u32) -> RgbaImage {
        image::imageops::crop_imm(page, 0, y, page.width(), height).to_image()
    }

    fn text_page(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let line = y / 30;
            let glyph_x = x / 8;
            let in_text = x > 25 && x < width - 40 && y % 30 > 5 && y % 30 < 18;
            let value = line.wrapping_mul(7919) ^ glyph_x.wrapping_mul(104729);
            let ink = in_text && x % 8 < 5 && (value >> (y % 7)) & 1 == 1;
            Rgba(if ink {
                [28, 28, 28, 255]
            } else {
                [255, 255, 255, 255]
            })
        })
    }

    fn draw_paragraph_number(image: &mut RgbaImage, paragraph: u32, number: u32) {
        const DIGITS: [[u8; 7]; 10] = [
            [14, 17, 19, 21, 25, 17, 14],
            [4, 12, 4, 4, 4, 4, 14],
            [14, 17, 1, 2, 4, 8, 31],
            [30, 1, 1, 14, 1, 1, 30],
            [2, 6, 10, 18, 31, 2, 2],
            [31, 16, 16, 30, 1, 1, 30],
            [14, 16, 16, 30, 17, 17, 14],
            [31, 1, 2, 4, 8, 8, 8],
            [14, 17, 17, 14, 17, 17, 14],
            [14, 17, 17, 15, 1, 1, 14],
        ];
        for y in 0..14 {
            for x in 0..42 {
                image.put_pixel(12 + x, paragraph * 120 + 4 + y, Rgba([255; 4]));
            }
        }
        for (index, digit) in format!("{number:03}").bytes().enumerate() {
            for y in 0..7 {
                for x in 0..5 {
                    if DIGITS[(digit - b'0') as usize][y as usize] & (1 << (4 - x)) != 0 {
                        for dy in 0..2 {
                            for dx in 0..2 {
                                image.put_pixel(
                                    12 + index as u32 * 14 + x * 2 + dx,
                                    paragraph * 120 + 4 + y * 2 + dy,
                                    Rgba([28, 28, 28, 255]),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    fn numbered_paragraphs(count: u32) -> RgbaImage {
        let mut image = RgbaImage::from_fn(600, count * 120, |x, y| {
            let row = y % 120;
            let bits = (row / 20).wrapping_mul(7919) ^ (x / 8).wrapping_mul(104729);
            let ink = x > 35
                && x < 550
                && row > 20
                && row % 20 < 12
                && x % 8 < 5
                && (bits >> (row % 7)) & 1 == 1;
            Rgba(if ink {
                [28, 28, 28, 255]
            } else {
                [255, 255, 255, 255]
            })
        });
        for paragraph in 0..count {
            draw_paragraph_number(&mut image, paragraph, paragraph);
        }
        image
    }

    #[test]
    fn changed_number_at_the_same_viewport_is_not_unchanged() {
        let original = numbered_paragraphs(5);
        let mut changed = original.clone();
        draw_paragraph_number(&mut changed, 0, 40);
        let mut document = ScrollDocument::new(600, 600).unwrap();
        document.push(original.clone()).unwrap();
        assert_eq!(document.push(changed).unwrap(), ScrollUpdate::Unmatched);
        assert_eq!(document.image().unwrap(), original);
    }

    #[test]
    fn fixed_edges_cannot_hide_changed_numbers_behind_a_short_exact_repeat() {
        let source = numbered_paragraphs(50);
        for start in [13, 53, 71, 89, 107, 119, 133] {
            for next in [2453, 2489, 2573, 2609, 2729] {
                let original = chat_frame(&source, start, 600, 600);
                let mut document = ScrollDocument::new(600, 600).unwrap();
                document.push(original.clone()).unwrap();
                assert_eq!(
                    document.push(chat_frame(&source, next, 600, 600)).unwrap(),
                    ScrollUpdate::Unmatched,
                    "{start} -> {next}"
                );
                assert_eq!(document.image().unwrap(), original);
            }
        }
    }

    #[test]
    fn repeated_rejection_keeps_its_result_but_a_bridge_invalidates_the_cache() {
        let source = page(200, 1600);
        let mut document = ScrollDocument::new(200, 400).unwrap();
        document.push(frame(&source, 0, 400)).unwrap();
        let distant = frame(&source, 800, 400);
        for _ in 0..4 {
            assert_eq!(
                document.push(distant.clone()).unwrap(),
                ScrollUpdate::Unmatched
            );
            assert_eq!(document.dimensions(), (200, 400));
            assert_eq!(document.last_unmatched.as_ref(), Some(&distant));
        }
        assert_eq!(document.frame_count(), 5);
        for y in [200, 400, 600, 800] {
            assert!(
                !matches!(
                    document.push(frame(&source, y, 400)).unwrap(),
                    ScrollUpdate::Unmatched
                ),
                "{y}"
            );
            assert!(document.last_unmatched.is_none());
        }
        assert_eq!(document.image().unwrap(), frame(&source, 0, 1200));
    }

    #[test]
    fn rejected_frame_cache_has_a_separate_native_pixel_budget() {
        let mut document = ScrollDocument::new(2048, 2049).unwrap();
        document.push(RgbaImage::new(2048, 2049)).unwrap();
        assert_eq!(
            document
                .push(RgbaImage::from_pixel(2048, 2049, Rgba([255; 4])))
                .unwrap(),
            ScrollUpdate::Unmatched
        );
        assert!(document.last_unmatched.is_none());
    }

    #[test]
    fn skipped_numbered_paragraphs_cannot_match_older_repeated_body_text() {
        let source = numbered_paragraphs(50);
        for jump in [40 * 120, 40 * 120 + 13, 41 * 120 + 13, 42 * 120 + 61] {
            let original = frame(&source, 0, 600);
            let mut document = ScrollDocument::new(600, 600).unwrap();
            document.push(original.clone()).unwrap();
            assert_eq!(
                document.push(frame(&source, jump, 600)).unwrap(),
                ScrollUpdate::Unmatched,
                "unseen paragraph jump to {jump}"
            );
            assert_eq!(document.image().unwrap(), original);
            assert_eq!(document.viewport(), (0, 600));
        }
    }

    #[test]
    fn continuous_numbered_paragraphs_still_locate_and_extend_in_both_directions() {
        let source = numbered_paragraphs(25);
        let mut document = ScrollDocument::new(600, 600).unwrap();
        document.push(frame(&source, 600, 600)).unwrap();
        let mut trajectory: Vec<_> = (737..2400).step_by(137).collect();
        trajectory.push(2400);
        trajectory.extend((0..2400).step_by(137).rev());
        trajectory.extend([1500, 73, 2000, 0]);
        for y in trajectory {
            let update = document.push(frame(&source, y, 600)).unwrap();
            assert!(
                !matches!(update, ScrollUpdate::Unmatched | ScrollUpdate::LimitReached),
                "continuous/revisited paragraph at {y}: {update:?}"
            );
        }
        assert_eq!(document.image().unwrap(), source);
    }

    #[test]
    fn arbitrary_reverse_trajectory_has_exact_pixels_and_no_duplicates() {
        let source = page(149, 1900);
        let mut document = ScrollDocument::new(149, 400).unwrap();
        let trajectory = [
            700, 901, 1100, 930, 720, 519, 318, 117, 0, 190, 385, 580, 780, 990, 1190, 1390, 1500,
        ];
        for (index, y) in trajectory.into_iter().enumerate() {
            let update = document.push(frame(&source, y, 400)).unwrap();
            assert!(
                matches!(
                    update,
                    ScrollUpdate::Started | ScrollUpdate::Extended { .. } | ScrollUpdate::Located
                ),
                "frame {index} at {y}: {update:?}"
            );
        }
        assert_eq!(document.image().unwrap(), source);
        assert_eq!(document.viewport(), (1500, 400));
        assert_eq!(document.dimensions(), (149, 1900));
        assert_eq!(document.frame_count(), trajectory.len() as u64);
    }

    #[test]
    fn route_order_does_not_change_the_result() {
        let source = page(99, 1000);
        let mut up_first = ScrollDocument::new(99, 300).unwrap();
        let mut down_first = ScrollDocument::new(99, 300).unwrap();
        for y in [350, 175, 0, 180, 360, 540, 700] {
            up_first.push(frame(&source, y, 300)).unwrap();
        }
        for y in [350, 530, 700, 520, 340, 160, 0] {
            down_first.push(frame(&source, y, 300)).unwrap();
        }
        assert_eq!(up_first.image(), down_first.image());
        assert_eq!(up_first.image().unwrap(), source);
    }

    #[test]
    fn lost_overlap_retains_progress_and_relocates_anywhere_already_seen() {
        let source = page(101, 2300);
        let mut document = ScrollDocument::new(101, 320).unwrap();
        document.push(frame(&source, 400, 320)).unwrap();
        document.push(frame(&source, 600, 320)).unwrap();
        document.push(frame(&source, 800, 320)).unwrap();
        let before = document.image();
        let viewport = document.viewport();
        assert_eq!(
            document.push(frame(&source, 1800, 320)).unwrap(),
            ScrollUpdate::Unmatched
        );
        assert_eq!(document.image(), before);
        assert_eq!(document.viewport(), viewport);
        // Recovery does not require returning to the most recent viewport.
        assert_eq!(
            document.push(frame(&source, 450, 320)).unwrap(),
            ScrollUpdate::Located
        );
        assert_eq!(
            document.push(frame(&source, 250, 320)).unwrap(),
            ScrollUpdate::Extended {
                top: 150,
                bottom: 0
            }
        );
        assert_eq!(document.image().unwrap(), frame(&source, 250, 870));
    }

    #[test]
    fn odd_native_pixel_displacements_do_not_round_at_retina_size() {
        let source = page(2560, 1883);
        let mut document = ScrollDocument::new(2560, 1440).unwrap();
        document.push(frame(&source, 202, 1440)).unwrap();
        document.push(frame(&source, 303, 1440)).unwrap();
        document.push(frame(&source, 443, 1440)).unwrap();
        document.push(frame(&source, 342, 1440)).unwrap();
        document.push(frame(&source, 101, 1440)).unwrap();
        document.push(frame(&source, 0, 1440)).unwrap();
        assert_eq!(document.image().unwrap(), source);
    }

    #[test]
    fn duplicates_and_reading_pauses_never_finish_or_extend() {
        let source = page(97, 300);
        let mut document = ScrollDocument::new(97, 300).unwrap();
        assert_eq!(
            document.push(source.clone()).unwrap(),
            ScrollUpdate::Started
        );
        for _ in 0..50 {
            assert_eq!(
                document.push(source.clone()).unwrap(),
                ScrollUpdate::Unchanged
            );
        }
        assert_eq!(document.image().unwrap(), source);
        assert_eq!(document.frame_count(), 51);
    }

    #[test]
    fn empty_and_ambiguous_repeated_content_cannot_invent_motion() {
        let blank = RgbaImage::from_pixel(100, 300, Rgba([255, 255, 255, 255]));
        let mut document = ScrollDocument::new(100, 300).unwrap();
        document.push(blank.clone()).unwrap();
        assert_eq!(document.push(blank).unwrap(), ScrollUpdate::Unchanged);
        assert_eq!(
            document
                .push(RgbaImage::from_pixel(100, 300, Rgba([240, 240, 240, 255])))
                .unwrap(),
            ScrollUpdate::Unmatched
        );

        let tile = page(100, 37);
        let repeated = RgbaImage::from_fn(100, 800, |x, y| *tile.get_pixel(x, y % 37));
        let mut document = ScrollDocument::new(100, 300).unwrap();
        document.push(frame(&repeated, 0, 300)).unwrap();
        let before = document.image();
        assert_eq!(
            document.push(frame(&repeated, 41, 300)).unwrap(),
            ScrollUpdate::Unmatched
        );
        assert_eq!(document.image(), before);
    }

    #[test]
    fn sparse_dynamic_patch_does_not_break_tracking_or_rewrite_old_pixels() {
        let source = page(300, 900);
        let mut document = ScrollDocument::new(300, 400).unwrap();
        document.push(frame(&source, 100, 400)).unwrap();
        let mut incoming = frame(&source, 300, 400);
        // Cursor-sized change lies in overlap, never in the new strip.
        for y in 60..68 {
            for x in 80..88 {
                incoming.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        assert_eq!(
            document.push(incoming).unwrap(),
            ScrollUpdate::Extended {
                top: 0,
                bottom: 200
            }
        );
        assert_eq!(document.image().unwrap(), frame(&source, 100, 600));
    }

    #[test]
    fn significant_changed_content_is_not_committed_as_a_scroll() {
        let source = page(200, 700);
        let mut document = ScrollDocument::new(200, 400).unwrap();
        document.push(frame(&source, 100, 400)).unwrap();
        let mut changed = frame(&source, 200, 400);
        for y in 30..120 {
            for x in 25..175 {
                changed.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let before = document.image();
        assert_eq!(document.push(changed).unwrap(), ScrollUpdate::Unmatched);
        assert_eq!(document.image(), before);
    }

    #[test]
    fn selecting_large_fixed_bars_removes_them_before_extending() {
        let source = page(160, 700);
        let mut first = frame(&source, 100, 400);
        let mut second = frame(&source, 200, 400);
        for y in (0..55).chain(345..400) {
            for x in 0..160 {
                let pixel = Rgba([230, 230, 230, 255]);
                first.put_pixel(x, y, pixel);
                second.put_pixel(x, y, pixel);
            }
        }
        let mut document = ScrollDocument::new(160, 400).unwrap();
        document.push(first.clone()).unwrap();
        assert_eq!(document.push(second).unwrap(), ScrollUpdate::Reframed);
        assert_eq!(document.image().unwrap(), frame(&source, 155, 390));
        assert_eq!(document.viewport(), (100, 290));
        assert_eq!(document.origin(), 55);
    }

    #[test]
    fn thin_fixed_edge_is_removed_without_repeating_it() {
        let source = page(200, 700);
        let header = page(200, 4);
        let mut first = frame(&source, 200, 400);
        let mut second = frame(&source, 100, 400);
        image::imageops::replace(&mut first, &header, 0, 0);
        image::imageops::replace(&mut second, &header, 0, 0);
        let mut document = ScrollDocument::new(200, 400).unwrap();
        document.push(first.clone()).unwrap();
        assert_eq!(document.push(second).unwrap(), ScrollUpdate::Reframed);
        assert_eq!(document.image().unwrap(), frame(&source, 104, 496));
    }

    #[test]
    fn white_text_document_tracks_across_blank_gaps_and_repeated_rule_lines() {
        let source = text_page(600, 2200);
        let mut document = ScrollDocument::new(600, 800).unwrap();
        for y in [600, 801, 1002, 1203, 1400, 1101, 802, 503, 204, 0] {
            let update = document.push(frame(&source, y, 800)).unwrap();
            assert!(!matches!(update, ScrollUpdate::Unmatched), "{y}");
        }
        assert_eq!(document.image().unwrap(), source);
    }

    fn rendered_text() -> RgbaImage {
        image::load_from_memory(include_bytes!("testdata/scroll-text.png"))
            .unwrap()
            .to_rgba8()
    }

    #[test]
    fn native_webkit_large_first_motion_preserves_exact_body_in_both_directions() {
        let first = image::load_from_memory(include_bytes!("testdata/scroll-webkit-7701.png"))
            .unwrap()
            .into_rgba8();
        let second = image::load_from_memory(include_bytes!("testdata/scroll-webkit-8094.png"))
            .unwrap()
            .into_rgba8();
        for (a, b, displacement) in [(&first, &second, 786_i64), (&second, &first, -786)] {
            let mut document = ScrollDocument::new(1800, 1394).unwrap();
            document.push(a.clone()).unwrap();
            let update = document.push(b.clone()).unwrap();
            assert!(!matches!(update, ScrollUpdate::Unmatched), "{displacement}");
            assert_eq!(document.viewport_top, displacement);
            let body = document.body;
            assert!(body.top >= 100 && document.visible.bottom < 1220);
            for (frame, position) in [(a, 0), (b, displacement)] {
                assert_eq!(
                    document
                        .preview_region(
                            0,
                            (position + i64::from(body.top) - document.origin()) as u32,
                            1800,
                            body.bottom - body.top,
                        )
                        .unwrap(),
                    image::imageops::crop_imm(frame, 0, body.top, 1800, body.bottom - body.top,)
                        .to_image()
                );
            }
            assert!(!document.has_unresolved_patches());
            assert!(!matches!(
                document.push(a.clone()).unwrap(),
                ScrollUpdate::Unmatched
            ));
            assert_eq!(document.viewport_top, 0);
        }
    }

    fn chat_frame(source: &RgbaImage, y: u32, width: u32, height: u32) -> RgbaImage {
        chat_frame_scaled(source, y, width, height, 1)
    }

    fn chat_frame_scaled(
        source: &RgbaImage,
        y: u32,
        width: u32,
        height: u32,
        scale: u32,
    ) -> RgbaImage {
        let mut incoming = image::imageops::crop_imm(source, 0, y, width, height).to_image();
        for row in 0..54 * scale {
            for x in 0..width {
                let shade = if row == 40 * scale && x > 32 && x < width - 40 {
                    210
                } else {
                    255
                };
                incoming.put_pixel(x, row, Rgba([shade, shade, shade, 255]));
            }
        }
        // The composer starts 150 pixels above the bottom, beyond the old
        // 96-pixel detector. Its 40-pixel shadow depends on underlying text.
        for row in height - 190 * scale..height {
            for x in 0..width {
                let pixel = incoming.get_pixel_mut(x, row);
                if row < height - 150 * scale {
                    let alpha = (row - (height - 190 * scale)) * 255 / (40 * scale);
                    for channel in &mut pixel.0[..3] {
                        *channel =
                            ((u32::from(*channel) * (255 - alpha) + 255 * alpha) / 255) as u8;
                    }
                } else {
                    let shade = if row == height - 143 * scale && x > 42 && x < width - 42 {
                        220
                    } else {
                        255
                    };
                    *pixel = Rgba([shade, shade, shade, 255]);
                }
            }
        }
        incoming
    }

    fn assert_rendered_body(document: &ScrollDocument, source: &RgbaImage, initial_y: i64) {
        let actual = document.image().unwrap();
        let expected = image::imageops::crop_imm(
            source,
            0,
            (initial_y + document.origin()) as u32,
            actual.width(),
            actual.height(),
        )
        .to_image();
        let fringe = (document.frame_height / 8).clamp(32, 192);
        for row in 0..actual.height() {
            let stride = actual.width() as usize * 4;
            let offset = row as usize * stride;
            if actual.as_raw()[offset..offset + stride]
                == expected.as_raw()[offset..offset + stride]
            {
                continue;
            }
            let absolute = document.top + i64::from(row);
            let strip = document
                .strips
                .iter()
                .find(|strip| absolute >= strip.start && absolute < strip.end())
                .unwrap();
            assert!(
                strip.provisional_edge[(absolute - strip.start) as usize],
                "body mismatch at row {row}, body={:?}",
                document.body
            );
            assert!(
                row < fringe || actual.height() - 1 - row < fringe,
                "unrepaired edge became an interior band at row {row}"
            );
        }
    }

    #[test]
    fn rendered_chat_fixed_composer_and_shadow_follow_both_directions_without_burning_edges() {
        let source = rendered_text();
        for (width, height, scale) in [(920, 700, 1), (620, 1000, 1), (920, 1400, 2)] {
            for reverse in [false, true] {
                let mut document = ScrollDocument::new(width, height).unwrap();
                let start = 1500_i64;
                let mut path = vec![1500, 1680, 1860, 1680, 1500, 1320, 1140, 1320, 1680];
                if reverse {
                    path = path.into_iter().map(|y| 3000 - y).collect();
                }
                for (index, y) in path.into_iter().enumerate() {
                    let result = document
                        .push(chat_frame_scaled(&source, y, width, height, scale))
                        .unwrap();
                    assert!(
                        !matches!(result, ScrollUpdate::Unmatched | ScrollUpdate::LimitReached),
                        "{width}x{height}, reverse={reverse}, frame={index}, y={y}: {result:?}"
                    );
                    if index == 0 {
                        continue;
                    }
                    assert_rendered_body(&document, &source, start);
                    assert!(document.visible.bottom <= height - 150 * scale);
                    assert!(!document.has_unresolved_patches());
                }
            }
        }
    }

    #[test]
    fn a_new_strip_patch_is_repaired_only_after_displaced_clean_observations() {
        let source = rendered_text();
        let mut document = ScrollDocument::new(920, 700).unwrap();
        document.push(frame(&source, 1000, 700)).unwrap();
        let mut dirty = frame(&source, 1180, 700);
        for y in 675..683 {
            for x in 440..448 {
                dirty.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        assert!(matches!(
            document.push(dirty).unwrap(),
            ScrollUpdate::Extended { .. }
        ));
        assert!(!document.has_unresolved_patches());
        let result = document.push(frame(&source, 1200, 700)).unwrap();
        assert!(!matches!(result, ScrollUpdate::Unmatched), "{result:?}");
        assert!(document.has_unresolved_patches());
        // Repeating the same viewport cannot turn a screen-fixed overlay into
        // independent evidence that it belongs to the document.
        document.push(frame(&source, 1200, 700)).unwrap();
        assert!(document.has_unresolved_patches());
        assert_eq!(
            document.push(frame(&source, 1220, 700)).unwrap(),
            ScrollUpdate::Reframed
        );
        assert!(!document.has_unresolved_patches());
        assert_eq!(document.image().unwrap(), frame(&source, 1000, 920));
    }

    #[test]
    fn rendered_chat_blank_margin_reopens_on_small_steps_and_long_revisits() {
        let source = rendered_text();
        let mut document = ScrollDocument::new(920, 700).unwrap();
        // Starts immediately before a 240-pixel blank gap. The first one-pixel
        // moves cannot distinguish that blank margin from the white header.
        let mut path = vec![700, 701, 702, 705, 710, 740, 800, 860, 920];
        path.extend((920..=3000).step_by(90));
        path.extend((0..3001).step_by(90).rev());
        path.extend([0, 90, 180, 90, 0, 1800, 400, 2600, 700]);
        for (index, y) in path.into_iter().enumerate() {
            let update = document.push(chat_frame(&source, y, 920, 700)).unwrap();
            assert!(
                !matches!(update, ScrollUpdate::Unmatched | ScrollUpdate::LimitReached),
                "frame {index} at {y}: {update:?}, body={:?}",
                document.body
            );
            if index != 0 {
                assert_rendered_body(&document, &source, 700);
            }
        }
        assert!(
            document.body.top <= 56 + EDGE_PROOF_MARGIN,
            "blank margin was never restored"
        );
        assert!(document.visible.top <= 56);
        assert!(!document.has_unresolved_patches());
    }

    #[test]
    fn first_motion_proves_the_learned_body_beside_large_blank_gaps() {
        let source = rendered_text();
        for (start, delta) in [
            (422, 180_i64),
            (1384, 180),
            (2235, 180),
            (3197, 180),
            (607, -180),
            (644, -180),
            (2420, -180),
        ] {
            let mut document = ScrollDocument::new(920, 700).unwrap();
            document.push(chat_frame(&source, start, 920, 700)).unwrap();
            assert!(
                !matches!(
                    document
                        .push(chat_frame(
                            &source,
                            (i64::from(start) + delta) as u32,
                            920,
                            700,
                        ))
                        .unwrap(),
                    ScrollUpdate::Unmatched
                ),
                "start={start}, delta={delta}"
            );
            assert_rendered_body(&document, &source, i64::from(start));
        }
    }

    #[test]
    fn faint_gradient_rows_do_not_expand_the_matching_body_on_reverse_and_revisit() {
        let text = rendered_text();
        for (width, height) in [(1180, 1280), (1840, 1400)] {
            let source = RgbaImage::from_fn(width, text.height(), |x, y| {
                if x < text.width() {
                    *text.get_pixel(x, y)
                } else {
                    Rgba([255; 4])
                }
            });
            let mut document = ScrollDocument::new(width, height).unwrap();
            let mut route = vec![1500];
            route.extend((1637..=4000).step_by(137));
            route.extend((0..4001).step_by(137).rev());
            route.extend([0, 1800, 400, 2600, 700, 3000, 0]);
            for (index, y) in route.into_iter().enumerate() {
                let update = document
                    .push(chat_frame_scaled(&source, y, width, height, 2))
                    .unwrap();
                assert!(
                    !matches!(update, ScrollUpdate::Unmatched | ScrollUpdate::LimitReached),
                    "{width}×{height}, frame {index} at {y}: {update:?}"
                );
                if index != 0 {
                    assert_rendered_body(&document, &source, 1500);
                }
            }
            assert!(!document.has_unresolved_patches());
        }
    }

    #[test]
    fn fixed_edge_learning_preserves_every_initial_visible_body_pixel() {
        let source = rendered_text();
        for start in [
            200, 259, 407, 459, 481, 496, 518, 533, 555, 592, 700, 1500, 2000, 3000,
        ] {
            for delta in [-180_i64, 180] {
                let mut document = ScrollDocument::new(920, 700).unwrap();
                document.push(chat_frame(&source, start, 920, 700)).unwrap();
                let update = document
                    .push(chat_frame(
                        &source,
                        (i64::from(start) + delta) as u32,
                        920,
                        700,
                    ))
                    .unwrap();
                assert!(
                    !matches!(update, ScrollUpdate::Unmatched),
                    "start={start}, delta={delta}: {update:?}"
                );
                let output = document.image().unwrap();
                // Compare against the original visible bounds, not against
                // origin after cropping: the latter hid whole missing lines.
                for y in 54..510 {
                    for x in 0..920 {
                        let original = source.get_pixel(x, start + y);
                        if original.0[..3] == [255, 255, 255] {
                            continue;
                        }
                        let destination = i64::from(y) - document.origin();
                        assert!(
                            destination >= 0 && destination < i64::from(output.height()),
                            "discarded initial text at start={start}, delta={delta}, y={y}"
                        );
                        assert_eq!(
                            output.get_pixel(x, destination as u32),
                            original,
                            "changed initial text at start={start}, delta={delta}, y={y}, x={x}"
                        );
                    }
                }
                assert_rendered_body(&document, &source, i64::from(start));
            }
        }
    }

    #[test]
    fn soft_card_edges_refine_to_exact_rows_instead_of_rejecting_nearby_offsets() {
        let source = RgbaImage::from_fn(240, 2000, |x, y| {
            let mut value = 255.0_f64;
            for (left, right, top, bottom, shade) in [
                (10_u32, 155_u32, 600_u32, 1350_u32, 35.0),
                (30, 135, 700, 820, 8.0),
                (30, 135, 910, 1020, 14.0),
                (30, 135, 1100, 1250, 4.0),
            ] {
                if x >= left && x < right && y >= top && y < bottom {
                    let distance = (x - left)
                        .min(right - 1 - x)
                        .min(y - top)
                        .min(bottom - 1 - y);
                    let coverage = (f64::from(distance) / 8.0).min(1.0);
                    value += (shade - value) * coverage;
                }
            }
            Rgba([value as u8, value as u8, value as u8, 255])
        });
        let mut document = ScrollDocument::new(240, 800).unwrap();
        document.push(frame(&source, 500, 800)).unwrap();
        for y in [637, 774, 795] {
            assert!(matches!(
                document.push(frame(&source, y, 800)).unwrap(),
                ScrollUpdate::Extended { .. }
            ));
        }
        assert_eq!(document.image().unwrap(), frame(&source, 500, 1095));
    }

    #[test]
    fn one_pixel_steps_keep_indexing_across_strip_boundaries() {
        let source = page(48, 360);
        let mut document = ScrollDocument::new(48, 96).unwrap();
        document.push(frame(&source, 100, 96)).unwrap();
        for y in 101..=264 {
            assert_eq!(
                document.push(frame(&source, y, 96)).unwrap(),
                ScrollUpdate::Extended { top: 0, bottom: 1 },
                "{y}"
            );
        }
        for y in (0..264).rev() {
            let update = document.push(frame(&source, y, 96)).unwrap();
            assert!(!matches!(update, ScrollUpdate::Unmatched), "{y}");
        }
        assert_eq!(document.image().unwrap(), source);
    }

    #[test]
    #[ignore = "explicit release-mode throughput measurement"]
    fn native_frame_throughput() {
        for (width, height, text) in [
            (1200, 800, false),
            (2560, 1440, false),
            (1200, 800, true),
            (2560, 1440, true),
        ] {
            let source = if text {
                text_page(width, height * 3)
            } else {
                page(width, height * 3)
            };
            let mut document = ScrollDocument::new(width, height).unwrap();
            document.push(frame(&source, height, height)).unwrap();
            let mut times = Vec::new();
            for index in 1..=24_u32 {
                let phase = index % 16;
                let distance = if phase <= 8 { phase } else { 16 - phase };
                let next = frame(&source, height - 404 + distance * 101, height);
                let started = std::time::Instant::now();
                let update = document.push(next).unwrap();
                times.push(started.elapsed().as_secs_f64() * 1000.0);
                assert!(!matches!(update, ScrollUpdate::Unmatched), "{update:?}");
            }
            times.sort_by(f64::total_cmp);
            eprintln!(
                "{width}x{height} text={text}: median={:.2}ms p95={:.2}ms max={:.2}ms",
                times[times.len() / 2],
                times[times.len() * 95 / 100],
                times[times.len() - 1],
            );
        }
    }

    #[test]
    fn dimensions_and_limits_are_checked_before_allocation_or_mutation() {
        assert!(ScrollDocument::new(u32::MAX, u32::MAX).is_err());
        assert!(ScrollDocument::new(MAX_SCROLL_WIDTH + 1, 100).is_err());
        assert!(ScrollDocument::new(8192, 8193).is_err());
        assert!(ScrollDocument::new(8192, 4097).is_err());
        assert!(ScrollDocument::new(8192, 4096).is_ok());
        assert!(ScrollDocument::new(100, MAX_SCROLL_HEIGHT + 1).is_err());
        assert!(ScrollDocument::new(0, 100).is_err());
        let mut document = ScrollDocument::new(32, 100).unwrap();
        let source = page(32, 100);
        document.push(source).unwrap();
        assert!(document.push(page(33, 100)).is_err());
        assert_eq!(document.frame_count(), 1);
        // Exercise the growth guard with real native strips and a narrow image.
        let source = page(32, MAX_SCROLL_HEIGHT + 32);
        let mut document = ScrollDocument::new(32, 512).unwrap();
        for y in (0..=MAX_SCROLL_HEIGHT - 512).step_by(256) {
            let update = document.push(frame(&source, y, 512)).unwrap();
            assert!(!matches!(
                update,
                ScrollUpdate::Unmatched | ScrollUpdate::LimitReached
            ));
        }
        let before = document.dimensions();
        assert_eq!(
            document
                .push(frame(&source, MAX_SCROLL_HEIGHT - 480, 512))
                .unwrap(),
            ScrollUpdate::LimitReached
        );
        assert_eq!(document.dimensions(), before);
    }

    #[test]
    fn viewport_tracks_prepends_and_revisits() {
        let source = page(200, 900);
        let mut document = ScrollDocument::new(200, 400).unwrap();
        assert_eq!(document.image(), None);
        assert_eq!(document.viewport(), (0, 0));
        document.push(frame(&source, 300, 400)).unwrap();
        document.push(frame(&source, 100, 400)).unwrap();
        assert_eq!(document.viewport(), (0, 400));
        document.push(frame(&source, 300, 400)).unwrap();
        assert_eq!(document.viewport(), (200, 400));
    }

    #[test]
    fn native_preview_region_copies_across_prepended_strips_and_clips_bounds() {
        let source = page(200, 900);
        let mut document = ScrollDocument::new(200, 400).unwrap();
        assert_eq!(document.preview_region(0, 0, 100, 100), None);
        for y in [300, 100, 0, 200, 400, 500] {
            document.push(frame(&source, y, 400)).unwrap();
        }
        assert_eq!(
            document.preview_region(17, 55, 127, 723).unwrap(),
            image::imageops::crop_imm(&source, 17, 55, 127, 723).to_image()
        );
        assert_eq!(
            document
                .preview_region(180, 850, u32::MAX, u32::MAX)
                .unwrap(),
            image::imageops::crop_imm(&source, 180, 850, 20, 50).to_image()
        );
        for (x, y, width, height) in [
            (200, 0, 1, 1),
            (0, 900, 1, 1),
            (u32::MAX, 0, 1, 1),
            (0, u32::MAX, 1, 1),
            (0, 0, 0, 100),
            (0, 0, 100, 0),
        ] {
            assert_eq!(document.preview_region(x, y, width, height), None);
        }
        let mut large = ScrollDocument::new(2048, 2049).unwrap();
        large.push(RgbaImage::new(2048, 2049)).unwrap();
        assert!(large.preview_region(0, 0, 2048, 2048).is_some());
        assert!(large.preview_region(0, 0, 2048, 2049).is_none());
    }

    #[test]
    fn revisiting_initial_noisy_position_confirms_a_displaced_clean_repair() {
        // Real anonymous QA text rendered by Windows Notepad at native pixels.
        let source = image::load_from_memory(include_bytes!("testdata/scroll-notepad-dark.png"))
            .unwrap()
            .to_rgba8();
        for stale_rows in [24, 48] {
            let mut document = ScrollDocument::new(754, 525).unwrap();
            // Lock the moving body before a newly exposed top edge briefly
            // retains one or two old text rows during a native repaint.
            for y in [96, 120, 96] {
                document.push(frame(&source, y, 525)).unwrap();
            }
            let mut dirty = frame(&source, 24, 525);
            let stale = image::imageops::crop_imm(&source, 0, 96, 754, stale_rows).to_image();
            image::imageops::replace(&mut dirty, &stale, 0, 0);
            assert!(!matches!(
                document.push(dirty.clone()).unwrap(),
                ScrollUpdate::Unmatched
            ));
            assert!(!matches!(
                document.push(frame(&source, 0, 525)).unwrap(),
                ScrollUpdate::Unmatched
            ));
            assert!(document.has_unresolved_patches());
            let unresolved = document.unresolved.len();
            let before = document.image().unwrap();

            // Repeating one clean viewport is not independent evidence.
            for _ in 0..4 {
                document.push(frame(&source, 0, 525)).unwrap();
                assert_eq!(document.unresolved.len(), unresolved);
                assert!(document.image().unwrap() == before);
            }
            // Nor may returning to the original dirty pixels confirm them and
            // discard the clean observation from the displaced viewport.
            assert!(!matches!(
                document.push(dirty.clone()).unwrap(),
                ScrollUpdate::Unmatched
            ));
            assert_eq!(document.unresolved.len(), unresolved);
            assert!(document.image().unwrap() == before);

            document.push(frame(&source, 0, 525)).unwrap();
            document.push(frame(&source, 24, 525)).unwrap();
            assert!(
                !document.has_unresolved_patches(),
                "stale_rows={stale_rows}"
            );
            assert!(document.image().unwrap() == source);
        }
    }
}
