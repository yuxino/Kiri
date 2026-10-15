//! Conservative, pixel-preserving vertical screenshot stitching.
//!
//! A frame is committed only when textured row signatures propose a unique
//! integer position and the original pixels verify that position. Rejected
//! frames never move the anchor, so scrolling back into known content recovers
//! without adding the same rows twice. Stored strips are never resampled.

use std::collections::HashMap;
use std::fmt;

use image::RgbaImage;

pub const MAX_SCROLL_DIMENSION: u32 = 8192;
pub const MAX_SCROLL_PIXELS: u64 = 32 * 1024 * 1024;
const SIGNATURE_SAMPLES: usize = 32;
const MAX_SIGNATURE_OCCURRENCES: usize = 32;
const MAX_CANDIDATES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StitchLimits {
    pub max_width: u32,
    pub max_height: u32,
    pub max_pixels: u64,
}

impl Default for StitchLimits {
    fn default() -> Self {
        Self {
            max_width: MAX_SCROLL_DIMENSION,
            max_height: MAX_SCROLL_DIMENSION,
            max_pixels: MAX_SCROLL_PIXELS,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StitchUpdate {
    Started,
    Appended { rows: u32 },
    Repositioned,
    Unchanged,
    NeedsOverlap,
    LimitReached,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StitchError {
    InvalidDimensions,
    FrameDimensionsChanged,
    InvalidBuffer,
}

impl fmt::Display for StitchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidDimensions => "The scrolling capture dimensions exceed the image limits",
            Self::FrameDimensionsChanged => "The scrolling capture frame dimensions changed",
            Self::InvalidBuffer => "The scrolling capture frame buffer is invalid",
        })
    }
}

impl std::error::Error for StitchError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Signature {
    Samples([u8; SIGNATURE_SAMPLES]),
    Sparse(u64),
}

impl Signature {
    fn coarse(self) -> Self {
        // Candidate generation tolerates small native antialiasing changes;
        // full RGB/block verification below still decides whether to commit.
        match self {
            Self::Samples(samples) => Self::Samples(samples.map(|value| value >> 3)),
            Self::Sparse(_) => self,
        }
    }

    fn informative(self) -> bool {
        match self {
            Self::Samples(samples) => {
                let minimum = samples.iter().copied().min().unwrap_or(0);
                let maximum = samples.iter().copied().max().unwrap_or(0);
                maximum.saturating_sub(minimum) >= 3
            }
            Self::Sparse(_) => true,
        }
    }
}

struct Strip {
    top: u32,
    image: RgbaImage,
}

#[derive(Default)]
struct Votes {
    count: u32,
    first_row: u32,
    last_row: u32,
}

pub struct ScrollStitcher {
    width: u32,
    frame_height: u32,
    height: u32,
    limits: StitchLimits,
    strips: Vec<Strip>,
    signatures: Vec<Signature>,
    current_origin: u32,
    frame_count: u32,
}

impl ScrollStitcher {
    pub fn new(width: u32, height: u32) -> Result<Self, StitchError> {
        Self::with_limits(width, height, StitchLimits::default())
    }

    /// Smaller limits are useful for callers with a stricter memory budget.
    /// The global image bounds cannot be widened by this configuration.
    pub fn with_limits(
        width: u32,
        height: u32,
        mut limits: StitchLimits,
    ) -> Result<Self, StitchError> {
        limits.max_width = limits.max_width.min(MAX_SCROLL_DIMENSION);
        limits.max_height = limits.max_height.min(MAX_SCROLL_DIMENSION);
        limits.max_pixels = limits.max_pixels.min(MAX_SCROLL_PIXELS);
        if width == 0
            || height == 0
            || width > limits.max_width
            || height > limits.max_height
            || u64::from(width) * u64::from(height) > limits.max_pixels
        {
            return Err(StitchError::InvalidDimensions);
        }
        Ok(Self {
            width,
            frame_height: height,
            height: 0,
            limits,
            strips: Vec::new(),
            signatures: Vec::new(),
            current_origin: 0,
            frame_count: 0,
        })
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Number of frames that contributed new pixels, including the baseline.
    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Convert a padded native BGRA/BGRX desktop frame without changing its exact
    /// dimensions. Desktop frames are already composited: X11's unused X byte
    /// may be zero, so it must never become transparency in the saved screenshot.
    pub fn push_bgra(
        &mut self,
        bytes: &[u8],
        stride: usize,
    ) -> Result<StitchUpdate, StitchError> {
        let row_bytes = self.width as usize * 4;
        let required = stride
            .checked_mul(self.frame_height.saturating_sub(1) as usize)
            .and_then(|value| value.checked_add(row_bytes))
            .ok_or(StitchError::InvalidBuffer)?;
        if stride < row_bytes || bytes.len() < required {
            return Err(StitchError::InvalidBuffer);
        }
        let mut image = RgbaImage::new(self.width, self.frame_height);
        for (y, target) in image.as_mut().chunks_exact_mut(row_bytes).enumerate() {
            let source = &bytes[y * stride..y * stride + row_bytes];
            for (source, target) in source.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
                target.copy_from_slice(&[source[2], source[1], source[0], 255]);
            }
        }
        self.push(image)
    }

    pub fn push(&mut self, frame: RgbaImage) -> Result<StitchUpdate, StitchError> {
        if frame.dimensions() != (self.width, self.frame_height) {
            return Err(StitchError::FrameDimensionsChanged);
        }
        let signatures = row_signatures(&frame);
        if self.height == 0 {
            self.height = self.frame_height;
            self.signatures = signatures;
            self.strips.push(Strip {
                top: 0,
                image: frame,
            });
            self.frame_count = 1;
            return Ok(StitchUpdate::Started);
        }

        // Identical/repeated frames can safely remain unchanged, even when the
        // page's repeated content makes its physical scroll position unknowable.
        if self.current_origin + self.frame_height <= self.height
            && (0..self.frame_height).all(|y| {
                let row_bytes = self.width as usize * 4;
                let first = y as usize * row_bytes;
                self.row(self.current_origin + y)
                    == &frame.as_raw()[first..first + row_bytes]
            })
        {
            return Ok(StitchUpdate::Unchanged);
        }

        let minimum_overlap = (self.frame_height / 8).max(16).min(self.frame_height);
        let mut index: HashMap<Signature, Vec<u32>> = HashMap::new();
        for (y, signature) in self.signatures.iter().copied().enumerate() {
            if !signature.informative() {
                continue;
            }
            let positions = index.entry(signature.coarse()).or_default();
            // Keep one extra occurrence so repetitive signatures are explicitly
            // discarded rather than arbitrarily choosing their first matches.
            if positions.len() <= MAX_SIGNATURE_OCCURRENCES {
                positions.push(y as u32);
            }
        }
        let mut candidates: HashMap<u32, Votes> = HashMap::new();
        let sample_step = (self.frame_height / 512).max(1) as usize;
        for new_y in (0..self.frame_height).step_by(sample_step) {
            let Some(positions) = index.get(&signatures[new_y as usize].coarse()) else {
                continue;
            };
            if positions.len() > MAX_SIGNATURE_OCCURRENCES {
                continue;
            }
            for old_y in positions {
                let Some(origin) = old_y.checked_sub(new_y) else {
                    continue;
                };
                if origin > self.height.saturating_sub(minimum_overlap) {
                    continue;
                }
                let votes = candidates.entry(origin).or_insert(Votes {
                    count: 0,
                    first_row: new_y,
                    last_row: new_y,
                });
                votes.count += 1;
                votes.last_row = new_y;
            }
        }
        let minimum_votes = (minimum_overlap / (sample_step as u32 * 8)).max(3);
        let mut candidates: Vec<_> = candidates
            .into_iter()
            .filter(|(_, votes)| {
                votes.count >= minimum_votes
                    && votes.last_row.saturating_sub(votes.first_row) >= minimum_overlap / 3
            })
            .collect();
        candidates.sort_unstable_by(|a, b| b.1.count.cmp(&a.1.count).then(a.0.cmp(&b.0)));
        if candidates.len() > MAX_CANDIDATES {
            // Never declare a position unique after inspecting only the first
            // few candidates. Highly repetitive content exceeds the bounded
            // verification budget and needs a more distinctive overlap.
            return Ok(StitchUpdate::NeedsOverlap);
        }

        let mut matched = None;
        for (origin, _) in candidates {
            if self.verify(&frame, origin) {
                if matched.is_some() {
                    // Multiple physically plausible seams must not be resolved
                    // by speed estimates or a preference for the shortest move.
                    return Ok(StitchUpdate::NeedsOverlap);
                }
                matched = Some(origin);
            }
        }
        let Some(origin) = matched else {
            return Ok(StitchUpdate::NeedsOverlap);
        };
        let new_height = origin + self.frame_height;
        if new_height <= self.height {
            self.current_origin = origin;
            return Ok(StitchUpdate::Repositioned);
        }
        if new_height > self.limits.max_height
            || u64::from(self.width) * u64::from(new_height) > self.limits.max_pixels
        {
            // Preserve the complete last accepted result. Never partially append
            // a frame and silently present a truncated output as successful.
            return Ok(StitchUpdate::LimitReached);
        }
        let first_new_row = self.height - origin;
        let rows = self.frame_height - first_new_row;
        let strip = image::imageops::crop_imm(&frame, 0, first_new_row, self.width, rows).to_image();
        self.signatures
            .extend_from_slice(&signatures[first_new_row as usize..]);
        self.strips.push(Strip {
            top: self.height,
            image: strip,
        });
        self.height = new_height;
        self.current_origin = origin;
        self.frame_count += 1;
        Ok(StitchUpdate::Appended { rows })
    }

    /// Assemble once at completion; incremental capture stores only new strips.
    pub fn image(&self) -> Option<RgbaImage> {
        if self.height == 0 {
            return None;
        }
        let mut output = RgbaImage::new(self.width, self.height);
        let row_bytes = self.width as usize * 4;
        for strip in &self.strips {
            let first = strip.top as usize * row_bytes;
            output.as_mut()[first..first + strip.image.as_raw().len()]
                .copy_from_slice(strip.image.as_raw());
        }
        Some(output)
    }

    /// A bounded thumbnail sampled directly from the committed strips. This
    /// never allocates a second full-size long image during live capture.
    pub fn preview(&self, max_width: u32, max_height: u32) -> Option<RgbaImage> {
        if self.height == 0 || max_width == 0 || max_height == 0 {
            return None;
        }
        let scale = (f64::from(max_width) / f64::from(self.width))
            .min(f64::from(max_height) / f64::from(self.height))
            .min(1.0);
        let width = (f64::from(self.width) * scale).floor().max(1.0) as u32;
        let height = (f64::from(self.height) * scale).floor().max(1.0) as u32;
        let mut output = RgbaImage::new(width, height);
        for y in 0..height {
            let source_y = u64::from(y) * u64::from(self.height) / u64::from(height);
            let row = self.row(source_y as u32);
            for x in 0..width {
                let source_x = u64::from(x) * u64::from(self.width) / u64::from(width);
                let start = source_x as usize * 4;
                output.put_pixel(x, y, image::Rgba(row[start..start + 4].try_into().unwrap()));
            }
        }
        Some(output)
    }

    fn row(&self, y: u32) -> &[u8] {
        let strip_index = self.strips.partition_point(|strip| strip.top <= y) - 1;
        let strip = &self.strips[strip_index];
        let row_bytes = self.width as usize * 4;
        let first = (y - strip.top) as usize * row_bytes;
        &strip.image.as_raw()[first..first + row_bytes]
    }

    fn verify(&self, frame: &RgbaImage, origin: u32) -> bool {
        let overlap = self.frame_height.min(self.height - origin);
        let pixels = u64::from(self.width) * u64::from(overlap);
        let mut blocks = [(0u64, 0u64); 16];
        let mut difference = 0u64;
        let row_bytes = self.width as usize * 4;
        for y in 0..overlap {
            let old = self.row(origin + y);
            let first = y as usize * row_bytes;
            let new = &frame.as_raw()[first..first + row_bytes];
            let block_y = (y as usize * 4 / overlap as usize).min(3);
            for x in 0..self.width as usize {
                let pixel = x * 4;
                let mut delta = 0u64;
                for channel in 0..3 {
                    let value = old[pixel + channel].abs_diff(new[pixel + channel]);
                    // Allow small native rendering differences, but never
                    // average a changed word or identifier into a large area
                    // of matching content. Even a tiny high-contrast change
                    // can distinguish two otherwise identical list entries.
                    if value > 10 {
                        return false;
                    }
                    delta += u64::from(value);
                }
                let block_x = (x * 4 / self.width as usize).min(3);
                let block = &mut blocks[block_y * 4 + block_x];
                block.0 += 1;
                block.1 += delta;
                difference += delta;
            }
            // A candidate that already exceeds the *whole overlap's* budget
            // cannot recover on later rows. This is especially valuable on text
            // pages whose repeated line shapes propose several wrong offsets.
            if difference * 2 > pixels * 3 * 5 {
                return false;
            }
        }
        // Global consistency plus local blocks prevent a static sidebar, header,
        // or a small matching patch from determining the page's displacement.
        difference * 2 <= pixels * 3 * 5
            && blocks.iter().all(|(count, delta)| *delta <= count * 3 * 6)
    }
}

fn row_signatures(frame: &RgbaImage) -> Vec<Signature> {
    (0..frame.height())
        .map(|y| {
            let mut samples = [0; SIGNATURE_SAMPLES];
            for (sample, target) in samples.iter_mut().enumerate() {
                let x = ((sample as u64 * 2 + 1) * u64::from(frame.width())
                    / (SIGNATURE_SAMPLES as u64 * 2)) as u32;
                let pixel = frame.get_pixel(x.min(frame.width() - 1), y);
                let luminance = (u16::from(pixel[0]) * 77
                    + u16::from(pixel[1]) * 150
                    + u16::from(pixel[2]) * 29)
                    >> 8;
                *target = (luminance >> 2) as u8;
            }
            let sampled = Signature::Samples(samples);
            if sampled.informative() {
                return sampled;
            }
            // A narrow label or aligned monospace glyphs can fall entirely
            // between the sample columns. Look at the complete row only when
            // those columns appear blank, retaining its horizontal structure.
            // This only proposes positions: collisions or quantization never
            // bypass the original-pixel verification above.
            let mut minimum = u8::MAX;
            let mut maximum = u8::MIN;
            let mut fingerprint = 0xcbf29ce484222325u64;
            let row_bytes = frame.width() as usize * 4;
            let first = y as usize * row_bytes;
            for pixel in frame.as_raw()[first..first + row_bytes].chunks_exact(4) {
                let luminance = ((u16::from(pixel[0]) * 77
                    + u16::from(pixel[1]) * 150
                    + u16::from(pixel[2]) * 29)
                    >> 8) as u8;
                minimum = minimum.min(luminance);
                maximum = maximum.max(luminance);
                fingerprint ^= u64::from(luminance >> 5);
                fingerprint = fingerprint.wrapping_mul(0x100000001b3);
            }
            if maximum.saturating_sub(minimum) >= 12 {
                Signature::Sparse(fingerprint)
            } else {
                sampled
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{imageops::crop_imm, Rgba};

    fn document(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let seed = x.wrapping_mul(0x45d9f3b) ^ y.wrapping_mul(0x119de1f3);
            let value = seed.wrapping_mul(seed ^ 0x9e3779b9);
            Rgba([
                (value >> 24) as u8,
                (value >> 16) as u8,
                (value >> 8) as u8,
                255,
            ])
        })
    }

    fn viewport(document: &RgbaImage, y: u32, height: u32) -> RgbaImage {
        crop_imm(document, 0, y, document.width(), height).to_image()
    }

    fn sparse_numbered_document(height: u32) -> RgbaImage {
        const DIGITS: [[u8; 7]; 10] = [
            [14, 17, 19, 21, 25, 17, 14], [4, 12, 4, 4, 4, 4, 14],
            [14, 17, 1, 2, 4, 8, 31], [30, 1, 1, 14, 1, 1, 30],
            [2, 6, 10, 18, 31, 2, 2], [31, 16, 16, 30, 1, 1, 30],
            [14, 16, 16, 30, 17, 17, 14], [31, 1, 2, 4, 8, 8, 8],
            [14, 17, 17, 14, 17, 17, 14], [14, 17, 17, 15, 1, 1, 14],
        ];
        RgbaImage::from_fn(2048, height, |x, y| {
            // Three actual 5x7 digits at 2x scale, wholly between the sampling
            // columns at x=32 and x=96. The surrounding selection is whitespace.
            let ink = if (40..76).contains(&x) && (4..18).contains(&(y % 24)) {
                let column = (x - 40) / 2;
                let row = (y % 24 - 4) / 2;
                let number = y / 24;
                let digit = match column / 6 {
                    0 => number / 100 % 10,
                    1 => number / 10 % 10,
                    _ => number % 10,
                };
                column % 6 < 5
                    && DIGITS[digit as usize][row as usize] & (1 << (4 - column % 6)) != 0
            } else {
                false
            };
            if ink { Rgba([40, 40, 40, 255]) } else { Rgba([250, 250, 250, 255]) }
        })
    }

    #[test]
    fn sparse_text_between_sampling_columns_still_stitches_exactly() {
        let source = sparse_numbered_document(960);
        let mut stitcher = ScrollStitcher::new(2048, 240).unwrap();
        stitcher.push(viewport(&source, 0, 240)).unwrap();
        for position in (48..=720).step_by(48) {
            assert_eq!(stitcher.push(viewport(&source, position, 240)).unwrap(), StitchUpdate::Appended { rows: 48 });
        }
        assert_eq!(stitcher.image().unwrap(), source);
    }

    #[test]
    fn sparse_text_signature_preserves_small_native_pixel_variation() {
        let source = sparse_numbered_document(480);
        let mut stitcher = ScrollStitcher::new(2048, 240).unwrap();
        stitcher.push(viewport(&source, 0, 240)).unwrap();
        let mut frame = viewport(&source, 48, 240);
        for pixel in frame.pixels_mut() {
            for channel in 0..3 { pixel[channel] = pixel[channel].saturating_add(1); }
        }
        assert_eq!(stitcher.push(frame.clone()).unwrap(), StitchUpdate::Appended { rows: 48 });
        let output = stitcher.image().unwrap();
        assert_eq!(viewport(&output, 0, 240), viewport(&source, 0, 240));
        assert_eq!(viewport(&output, 240, 48), viewport(&frame, 192, 48));
    }

    #[test]
    fn sparse_text_recovers_after_motion_blur_and_a_jump_without_overlap() {
        let source = sparse_numbered_document(960);
        let mut stitcher = ScrollStitcher::new(2048, 240).unwrap();
        let baseline = viewport(&source, 0, 240);
        stitcher.push(baseline.clone()).unwrap();
        let blurred = RgbaImage::from_fn(2048, 240, |x, y| {
            let first = source.get_pixel(x, y + 48);
            let next = source.get_pixel(x, y + 49);
            Rgba(std::array::from_fn(|channel| {
                ((u16::from(first[channel]) + u16::from(next[channel])) / 2) as u8
            }))
        });
        assert_eq!(stitcher.push(blurred).unwrap(), StitchUpdate::NeedsOverlap);
        assert_eq!(stitcher.image().unwrap(), baseline);
        assert_eq!(stitcher.push(viewport(&source, 48, 240)).unwrap(), StitchUpdate::Appended { rows: 48 });
        assert_eq!(stitcher.push(viewport(&source, 720, 240)).unwrap(), StitchUpdate::NeedsOverlap);
        assert_eq!(stitcher.dimensions(), (2048, 288));
        assert_eq!(stitcher.push(viewport(&source, 0, 240)).unwrap(), StitchUpdate::Repositioned);
        assert_eq!(stitcher.push(viewport(&source, 96, 240)).unwrap(), StitchUpdate::Appended { rows: 48 });
        assert_eq!(stitcher.image().unwrap(), viewport(&source, 0, 336));
    }

    #[test]
    fn identical_repetition_never_invents_a_scroll_distance() {
        let pattern = document(95, 20);
        let frame = RgbaImage::from_fn(95, 160, |x, y| *pattern.get_pixel(x, y % 20));
        let mut stitcher = ScrollStitcher::new(95, 160).unwrap();
        stitcher.push(frame.clone()).unwrap();
        for _ in 0..5 {
            assert_eq!(stitcher.push(frame.clone()).unwrap(), StitchUpdate::Unchanged);
        }
        // A new tail follows indistinguishable repeated content. Several seam
        // positions are possible, so the new pixels cannot safely be appended.
        let tail = RgbaImage::from_fn(95, 160, |x, y| {
            if y < 120 { *frame.get_pixel(x, y) } else { Rgba([255, 255, 255, 255]) }
        });
        assert_eq!(stitcher.push(tail).unwrap(), StitchUpdate::NeedsOverlap);
        assert_eq!(stitcher.image().unwrap(), frame);
        assert_eq!(stitcher.frame_count(), 1);
    }

    #[test]
    fn full_height_limit_preserves_exact_pixels_and_allows_reverse_recovery() {
        let source = document(83, MAX_SCROLL_DIMENSION + 1);
        let mut stitcher = ScrollStitcher::new(83, 257).unwrap();
        for position in (0..=7800).step_by(200) {
            stitcher.push(viewport(&source, position, 257)).unwrap();
        }
        assert_eq!(stitcher.push(viewport(&source, 7935, 257)).unwrap(), StitchUpdate::Appended { rows: 135 });
        assert_eq!(stitcher.push(viewport(&source, 7936, 257)).unwrap(), StitchUpdate::LimitReached);
        assert_eq!(stitcher.push(viewport(&source, 7735, 257)).unwrap(), StitchUpdate::Repositioned);
        assert_eq!(stitcher.push(viewport(&source, 7935, 257)).unwrap(), StitchUpdate::Repositioned);
        assert_eq!(stitcher.push(viewport(&source, 7936, 257)).unwrap(), StitchUpdate::LimitReached);
        assert_eq!(stitcher.image().unwrap(), viewport(&source, 0, MAX_SCROLL_DIMENSION));
    }

    #[test]
    fn odd_dimensions_and_mixed_scroll_steps_preserve_every_pixel() {
        let source = document(83, 901);
        let mut stitcher = ScrollStitcher::new(83, 157).unwrap();
        assert_eq!(stitcher.image(), None);
        assert_eq!(stitcher.push(viewport(&source, 0, 157)).unwrap(), StitchUpdate::Started);
        let mut previous = 0;
        for position in [1, 3, 27, 99, 160, 280, 281, 402, 520, 640, 744] {
            assert_eq!(
                stitcher.push(viewport(&source, position, 157)).unwrap(),
                StitchUpdate::Appended { rows: position - previous }
            );
            previous = position;
        }
        assert_eq!(stitcher.dimensions(), (83, 901));
        assert_eq!(stitcher.image().unwrap(), source);
        assert_eq!(stitcher.frame_count(), 12);
    }

    #[test]
    fn reverse_scroll_repositions_then_only_appends_new_content() {
        let source = document(97, 600);
        let mut stitcher = ScrollStitcher::new(97, 160).unwrap();
        stitcher.push(viewport(&source, 0, 160)).unwrap();
        for position in [90, 180, 270] {
            assert!(matches!(stitcher.push(viewport(&source, position, 160)).unwrap(), StitchUpdate::Appended { .. }));
        }
        for position in [160, 30, 100, 270] {
            assert_eq!(stitcher.push(viewport(&source, position, 160)).unwrap(), StitchUpdate::Repositioned);
        }
        assert_eq!(stitcher.push(viewport(&source, 300, 160)).unwrap(), StitchUpdate::Appended { rows: 30 });
        assert_eq!(stitcher.image().unwrap(), viewport(&source, 0, 460));
    }

    #[test]
    fn missing_overlap_keeps_anchor_and_can_recover() {
        let source = document(101, 700);
        let mut stitcher = ScrollStitcher::new(101, 160).unwrap();
        stitcher.push(viewport(&source, 0, 160)).unwrap();
        assert_eq!(stitcher.push(viewport(&source, 350, 160)).unwrap(), StitchUpdate::NeedsOverlap);
        assert_eq!(stitcher.dimensions(), (101, 160));
        assert_eq!(stitcher.push(viewport(&source, 90, 160)).unwrap(), StitchUpdate::Appended { rows: 90 });
        assert_eq!(stitcher.image().unwrap(), viewport(&source, 0, 250));
    }

    #[test]
    fn duplicate_and_blank_frames_never_grow_the_image() {
        let frame = RgbaImage::from_pixel(91, 129, Rgba([255, 255, 255, 255]));
        let mut stitcher = ScrollStitcher::new(91, 129).unwrap();
        assert_eq!(stitcher.push(frame.clone()).unwrap(), StitchUpdate::Started);
        assert_eq!(stitcher.push(frame.clone()).unwrap(), StitchUpdate::Unchanged);
        let other = RgbaImage::from_pixel(91, 129, Rgba([128, 128, 128, 255]));
        assert_eq!(stitcher.push(other).unwrap(), StitchUpdate::NeedsOverlap);
        assert_eq!(stitcher.image().unwrap(), frame);
    }

    #[test]
    fn ambiguous_repeated_rows_are_rejected() {
        let pattern = document(95, 20);
        let mut source = RgbaImage::from_fn(95, 400, |x, y| *pattern.get_pixel(x, y % 20));
        // A distinctive first row prevents the new viewport being mistaken for
        // the unchanged frame; the remaining repeated rows admit many offsets.
        for x in 0..95 {
            source.put_pixel(x, 0, Rgba([255, 255, 255, 255]));
        }
        let mut stitcher = ScrollStitcher::new(95, 160).unwrap();
        stitcher.push(viewport(&source, 0, 160)).unwrap();
        assert_eq!(stitcher.push(viewport(&source, 40, 160)).unwrap(), StitchUpdate::NeedsOverlap);
        assert_eq!(stitcher.dimensions(), (95, 160));
    }

    #[test]
    fn horizontal_motion_and_fixed_header_fail_verification() {
        let source = document(99, 400);
        let original = viewport(&source, 0, 160);
        let mut stitcher = ScrollStitcher::new(99, 160).unwrap();
        stitcher.push(original.clone()).unwrap();
        let shifted = RgbaImage::from_fn(99, 160, |x, y| *source.get_pixel((x + 1) % 99, y + 50));
        assert_eq!(stitcher.push(shifted).unwrap(), StitchUpdate::NeedsOverlap);
        let mut header = viewport(&source, 50, 160);
        for y in 0..20 {
            for x in 0..99 {
                header.put_pixel(x, y, *original.get_pixel(x, y));
            }
        }
        assert_eq!(stitcher.push(header).unwrap(), StitchUpdate::NeedsOverlap);
    }

    #[test]
    fn height_and_area_limits_preserve_the_last_complete_image() {
        let source = document(83, 500);
        for limits in [
            StitchLimits { max_width: 83, max_height: 250, max_pixels: 83 * 500 },
            StitchLimits { max_width: 83, max_height: 500, max_pixels: 83 * 250 },
        ] {
            let mut stitcher = ScrollStitcher::with_limits(83, 157, limits).unwrap();
            stitcher.push(viewport(&source, 0, 157)).unwrap();
            assert_eq!(stitcher.push(viewport(&source, 90, 157)).unwrap(), StitchUpdate::Appended { rows: 90 });
            assert_eq!(stitcher.push(viewport(&source, 100, 157)).unwrap(), StitchUpdate::LimitReached);
            assert_eq!(stitcher.image().unwrap(), viewport(&source, 0, 247));
        }
    }

    #[test]
    fn preview_is_bounded_and_uses_the_committed_output() {
        let source = document(83, 400);
        let mut stitcher = ScrollStitcher::new(83, 157).unwrap();
        stitcher.push(viewport(&source, 0, 157)).unwrap();
        stitcher.push(viewport(&source, 90, 157)).unwrap();
        assert_eq!(stitcher.preview(83, 247).unwrap(), stitcher.image().unwrap());
        let preview = stitcher.preview(30, 70).unwrap();
        assert!(preview.width() <= 30 && preview.height() <= 70);
        assert_eq!(preview.get_pixel(0, 0), source.get_pixel(0, 0));
        assert_eq!(stitcher.preview(0, 70), None);
    }

    #[test]
    fn bgra_stride_is_respected_without_even_dimension_rounding() {
        let source = document(43, 67);
        let stride = 43 * 4 + 13;
        let mut bytes = vec![0u8; stride * 67];
        for y in 0..67usize {
            for x in 0..43usize {
                let pixel = source.get_pixel(x as u32, y as u32);
                let start = y * stride + x * 4;
                bytes[start..start + 4].copy_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
            }
        }
        let mut stitcher = ScrollStitcher::new(43, 67).unwrap();
        assert_eq!(stitcher.push_bgra(&bytes, stride).unwrap(), StitchUpdate::Started);
        assert_eq!(stitcher.image().unwrap(), source);
        assert_eq!(stitcher.push_bgra(&bytes[..10], stride), Err(StitchError::InvalidBuffer));
        assert_eq!(stitcher.push_bgra(&bytes, 1), Err(StitchError::InvalidBuffer));
    }

    #[test]
    fn native_bgrx_is_opaque_while_rgba_input_preserves_alpha() {
        let source = RgbaImage::from_pixel(43, 67, Rgba([19, 73, 151, 0]));
        let native_bytes: Vec<_> = source
            .pixels()
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], 0])
            .collect();
        let mut native = ScrollStitcher::new(43, 67).unwrap();
        native.push_bgra(&native_bytes, 43 * 4).unwrap();
        assert!(native.image().unwrap().pixels().all(|pixel| *pixel == Rgba([19, 73, 151, 255])));
        assert!(native.preview(20, 30).unwrap().pixels().all(|pixel| pixel[3] == 255));
        let mut rgba = ScrollStitcher::new(43, 67).unwrap();
        rgba.push(source.clone()).unwrap();
        assert_eq!(rgba.image().unwrap(), source);
    }

    #[test]
    fn sparse_text_on_repeated_white_background_preserves_every_row() {
        let source = RgbaImage::from_fn(760, 2016, |x, y| {
            let line = y / 24;
            let column = x / 9;
            let glyph = (line + 1).wrapping_mul(column + 11).wrapping_mul(0x45d9f3b);
            let ink = (8..19).contains(&(y % 24))
                && (36..700).contains(&x)
                && x % 9 < 6
                && (glyph.rotate_left(y % 24) >> (x % 9)) & 1 != 0;
            if ink { Rgba([40, 40, 40, 255]) } else { Rgba([250, 250, 250, 255]) }
        });
        let mut stitcher = ScrollStitcher::new(760, 480).unwrap();
        stitcher.push(viewport(&source, 0, 480)).unwrap();
        for position in (96..=1536).step_by(96) {
            assert_eq!(stitcher.push(viewport(&source, position, 480)).unwrap(), StitchUpdate::Appended { rows: 96 });
        }
        assert_eq!(stitcher.image().unwrap(), source);
    }

    #[test]
    fn tiny_native_pixel_variation_still_finds_the_integer_translation() {
        let source = document(139, 400);
        let mut stitcher = ScrollStitcher::new(139, 160).unwrap();
        stitcher.push(viewport(&source, 0, 160)).unwrap();
        let mut frame = viewport(&source, 80, 160);
        for pixel in frame.pixels_mut() {
            for channel in 0..3 { pixel[channel] = pixel[channel].saturating_add(1); }
        }
        assert_eq!(stitcher.push(frame.clone()).unwrap(), StitchUpdate::Appended { rows: 80 });
        let output = stitcher.image().unwrap();
        assert_eq!(viewport(&output, 0, 160), viewport(&source, 0, 160));
        assert_eq!(viewport(&output, 160, 80), viewport(&frame, 80, 80));
    }

    #[test]
    fn repeated_cards_with_small_changed_labels_reject_skips_and_recover() {
        let pattern = RgbaImage::from_fn(760, 240, |x, y| {
            let line = y / 24;
            let column = x / 9;
            let glyph = (line + 1).wrapping_mul(column + 11).wrapping_mul(0x45d9f3b);
            let ink = (8..19).contains(&(y % 24))
                && (36..700).contains(&x)
                && x % 9 < 6
                && (glyph.rotate_left(y % 24) >> (x % 9)) & 1 != 0;
            if ink { Rgba([40, 40, 40, 255]) } else { Rgba([250, 250, 250, 255]) }
        });
        let source = RgbaImage::from_fn(760, 720, |x, y| {
            // A small, high-contrast label distinguishes otherwise repeated
            // cards. Its 48 pixels must not disappear into an area-wide budget.
            if (8..14).contains(&x) && (70..78).contains(&(y % 240)) {
                if y / 240 == 0 { Rgba([40, 40, 40, 255]) } else { Rgba([220, 220, 220, 255]) }
            } else {
                *pattern.get_pixel(x, y % 240)
            }
        });
        let mut stitcher = ScrollStitcher::new(760, 240).unwrap();
        let baseline = viewport(&source, 0, 240);
        stitcher.push(baseline.clone()).unwrap();

        // The real jump is greater than one viewport, but the repeated body
        // proposes a false 48-row advance. Never commit that guessed position.
        assert_eq!(stitcher.push(viewport(&source, 288, 240)).unwrap(), StitchUpdate::NeedsOverlap);
        assert_eq!(stitcher.image().unwrap(), baseline);
        assert_eq!(stitcher.frame_count(), 1);

        // Returning to known content can then continue with no missing rows.
        for position in [48, 96, 144, 192, 240] {
            assert_eq!(stitcher.push(viewport(&source, position, 240)).unwrap(), StitchUpdate::Appended { rows: 48 });
        }
        assert_eq!(stitcher.image().unwrap(), viewport(&source, 0, 480));
    }

    #[test]
    fn long_preview_keeps_its_width_and_samples_every_committed_strip() {
        let source = document(496, 2400);
        let mut stitcher = ScrollStitcher::new(496, 600).unwrap();
        for position in [0, 450, 900, 1350, 1800] {
            stitcher.push(viewport(&source, position, 600)).unwrap();
        }
        let preview = stitcher.preview(248, MAX_SCROLL_DIMENSION).unwrap();
        assert_eq!(preview.dimensions(), (248, 1200));
        assert_eq!(preview.as_raw().len(), 248 * 1200 * 4);
        for (x, y, pixel) in preview.enumerate_pixels() {
            assert_eq!(pixel, source.get_pixel(x * 2, y * 2));
        }

        // Full-height results stay within the thumbnail budget, including its
        // maximum area; narrower results are never upscaled to fill the width.
        for width in [73, 248] {
            let source = document(width, MAX_SCROLL_DIMENSION);
            let mut stitcher = ScrollStitcher::new(width, MAX_SCROLL_DIMENSION).unwrap();
            stitcher.push(source.clone()).unwrap();
            let preview = stitcher.preview(248, MAX_SCROLL_DIMENSION).unwrap();
            assert_eq!(preview, source);
            assert!(preview.as_raw().len() <= 248 * MAX_SCROLL_DIMENSION as usize * 4);
        }
    }

    #[test]
    fn reject_changed_foreground_hidden_by_large_white_background() {
        let ink = document(80, 800);
        let source = RgbaImage::from_fn(760, 800, |x, y| {
            if x < 80 { *ink.get_pixel(x, y) } else { Rgba([255, 255, 255, 255]) }
        });
        let mut stitcher = ScrollStitcher::new(760, 480).unwrap();
        stitcher.push(viewport(&source, 0, 480)).unwrap();
        let mut changed = viewport(&source, 96, 480);
        // Less than one percent of the whole image changes, but this is a
        // substantial part of its foreground. White space must not hide it.
        for y in 0..480 {
            for x in [752, 754, 756, 758] {
                changed.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        assert_eq!(stitcher.push(changed).unwrap(), StitchUpdate::NeedsOverlap);
        assert_eq!(stitcher.image().unwrap(), viewport(&source, 0, 480));
    }

    #[test]
    fn invalid_geometry_is_rejected_before_allocation_or_mutation() {
        assert!(matches!(ScrollStitcher::new(0, 1), Err(StitchError::InvalidDimensions)));
        assert!(matches!(ScrollStitcher::new(8193, 1), Err(StitchError::InvalidDimensions)));
        assert!(matches!(ScrollStitcher::new(8192, 8192), Err(StitchError::InvalidDimensions)));
        let mut stitcher = ScrollStitcher::new(43, 67).unwrap();
        assert_eq!(stitcher.push(document(42, 67)), Err(StitchError::FrameDimensionsChanged));
        assert_eq!(stitcher.dimensions(), (43, 0));
    }
}
