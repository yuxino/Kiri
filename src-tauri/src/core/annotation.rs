//! Versioned, bounded annotation documents shared by capture staging, the
//! editor, and the on-disk sidecar. The Swift-compatible asset index remains
//! deliberately unaware of this format.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

pub const ANNOTATION_SCHEMA_VERSION: u8 = 1;
pub const MAX_ANNOTATION_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_CANVAS_DIMENSION: f64 = 65_536.0;
const MAX_MARKS: usize = 2_048;
const MAX_POINTS_PER_MARK: usize = 100_000;
const MAX_TOTAL_POINTS: usize = 100_000;
const MAX_TOTAL_TEXT_UNITS: usize = 65_536;
pub(super) const MAX_WATERMARK_TEXT_UNITS: usize = 512;
const MAX_WATERMARK_TILES: usize = 4_096;
const MAX_TOTAL_WATERMARK_TILES: usize = 8_192;
const WATERMARK_DENSITY_ERROR: &str = "Watermark is too dense. Increase its size or spacing.";
const MAX_VISUAL_SIZE: f64 = 4_096.0;
const MAX_COORDINATE_MAGNITUDE: f64 = 262_144.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationDocument {
    pub schema_version: u8,
    pub canvas: AnnotationSize,
    pub source_pixels: AnnotationPixelSize,
    pub marks: Vec<AnnotationMark>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnotationSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnotationPixelSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnotationPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnotationRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationColor {
    Violet,
    Cherry,
    Orange,
    Yellow,
    Mint,
    Blue,
    White,
    Black,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextBackground {
    Transparent,
    Dark,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LabelDirection {
    #[default]
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MosaicIntensity {
    Soft,
    Standard,
    Strong,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MosaicStyle {
    Pixel,
    Blur,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MosaicShape {
    Brush,
    Rectangle,
    Ellipse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WatermarkMode {
    Single,
    Tiled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalloutStyle {
    Filled,
    Outline,
}

/// Last-used annotation styling shared by the capture overlay and editor.
/// The active tool is deliberately excluded so every new surface still opens
/// in its predictable selection state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AnnotationAppearance {
    pub color_preset: AnnotationColor,
    pub text_background_style: TextBackground,
    pub label_direction: LabelDirection,
    pub mosaic_intensity: MosaicIntensity,
    pub mosaic_style: MosaicStyle,
    pub mosaic_shape: MosaicShape,
    pub pen_width: u16,
    pub shape_width: u16,
    pub text_font_size: u16,
    pub mosaic_brush_diameter: u16,
    pub callout_size: u16,
    pub callout_style: CalloutStyle,
    pub watermark_color: AnnotationColor,
    pub watermark_font_size: u16,
    pub watermark_opacity: u16,
    pub watermark_rotation: i16,
    pub watermark_mode: WatermarkMode,
    pub watermark_spacing: u16,
}

impl Default for AnnotationAppearance {
    fn default() -> Self {
        Self {
            color_preset: AnnotationColor::Cherry,
            text_background_style: TextBackground::Transparent,
            label_direction: LabelDirection::Left,
            mosaic_intensity: MosaicIntensity::Standard,
            mosaic_style: MosaicStyle::Pixel,
            mosaic_shape: MosaicShape::Brush,
            pen_width: 3,
            shape_width: 3,
            text_font_size: 18,
            mosaic_brush_diameter: 20,
            callout_size: 36,
            callout_style: CalloutStyle::Filled,
            watermark_color: AnnotationColor::Black,
            watermark_font_size: 28,
            watermark_opacity: 20,
            watermark_rotation: -30,
            watermark_mode: WatermarkMode::Tiled,
            watermark_spacing: 80,
        }
    }
}

impl AnnotationAppearance {
    pub fn normalized(mut self) -> Self {
        self.pen_width = self.pen_width.clamp(1, 24);
        self.shape_width = self.shape_width.clamp(1, 16);
        self.text_font_size = self.text_font_size.clamp(12, 64);
        self.mosaic_brush_diameter = self.mosaic_brush_diameter.clamp(12, 120);
        self.callout_size = self.callout_size.clamp(24, 72);
        self.watermark_font_size = self.watermark_font_size.clamp(12, 128);
        self.watermark_opacity = self.watermark_opacity.clamp(0, 100);
        self.watermark_rotation = self.watermark_rotation.clamp(-180, 180);
        self.watermark_spacing = self.watermark_spacing.clamp(16, 512);
        self
    }
}

/// Only changed fields are written so independent windows cannot replace
/// another window's last-used styling with a stale complete snapshot.
#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationAppearancePatch {
    pub color_preset: Option<AnnotationColor>,
    pub text_background_style: Option<TextBackground>,
    pub label_direction: Option<LabelDirection>,
    pub mosaic_intensity: Option<MosaicIntensity>,
    pub mosaic_style: Option<MosaicStyle>,
    pub mosaic_shape: Option<MosaicShape>,
    pub pen_width: Option<u16>,
    pub shape_width: Option<u16>,
    pub text_font_size: Option<u16>,
    pub mosaic_brush_diameter: Option<u16>,
    pub callout_size: Option<u16>,
    pub callout_style: Option<CalloutStyle>,
    pub watermark_color: Option<AnnotationColor>,
    pub watermark_font_size: Option<u16>,
    pub watermark_opacity: Option<u16>,
    pub watermark_rotation: Option<i16>,
    pub watermark_mode: Option<WatermarkMode>,
    pub watermark_spacing: Option<u16>,
}

impl AnnotationAppearancePatch {
    pub fn apply(self, mut saved: AnnotationAppearance) -> AnnotationAppearance {
        if let Some(value) = self.color_preset { saved.color_preset = value; }
        if let Some(value) = self.text_background_style { saved.text_background_style = value; }
        if let Some(value) = self.label_direction { saved.label_direction = value; }
        if let Some(value) = self.mosaic_intensity { saved.mosaic_intensity = value; }
        if let Some(value) = self.mosaic_style { saved.mosaic_style = value; }
        if let Some(value) = self.mosaic_shape { saved.mosaic_shape = value; }
        if let Some(value) = self.pen_width { saved.pen_width = value; }
        if let Some(value) = self.shape_width { saved.shape_width = value; }
        if let Some(value) = self.text_font_size { saved.text_font_size = value; }
        if let Some(value) = self.mosaic_brush_diameter { saved.mosaic_brush_diameter = value; }
        if let Some(value) = self.callout_size { saved.callout_size = value; }
        if let Some(value) = self.callout_style { saved.callout_style = value; }
        if let Some(value) = self.watermark_color { saved.watermark_color = value; }
        if let Some(value) = self.watermark_font_size { saved.watermark_font_size = value; }
        if let Some(value) = self.watermark_opacity { saved.watermark_opacity = value; }
        if let Some(value) = self.watermark_rotation { saved.watermark_rotation = value; }
        if let Some(value) = self.watermark_mode { saved.watermark_mode = value; }
        if let Some(value) = self.watermark_spacing { saved.watermark_spacing = value; }
        saved.normalized()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AnnotationMark {
    Watermark {
        id: f64,
        text: String,
        rect: AnnotationRect,
        color: AnnotationColor,
        font_size: f64,
        opacity: f64,
        rotation: f64,
        mode: WatermarkMode,
        spacing: f64,
    },
    Callout {
        id: f64,
        center: AnnotationPoint,
        number: u16,
        text: String,
        label_rect: AnnotationRect,
        color: AnnotationColor,
        size: f64,
        font_size: f64,
        style: CalloutStyle,
    },
    Pen {
        id: f64,
        points: Vec<AnnotationPoint>,
        color: AnnotationColor,
        width: f64,
    },
    Rectangle {
        id: f64,
        rect: AnnotationRect,
        color: AnnotationColor,
        width: f64,
    },
    Line {
        id: f64,
        start: AnnotationPoint,
        end: AnnotationPoint,
        color: AnnotationColor,
        width: f64,
    },
    Arrow {
        id: f64,
        start: AnnotationPoint,
        end: AnnotationPoint,
        color: AnnotationColor,
        width: f64,
    },
    Text {
        id: f64,
        text: String,
        rect: AnnotationRect,
        color: AnnotationColor,
        background: TextBackground,
        font_size: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label_direction: Option<LabelDirection>,
    },
    Mosaic {
        id: f64,
        points: Vec<AnnotationPoint>,
        brush_diameter: f64,
        intensity: MosaicIntensity,
        style: MosaicStyle,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shape: Option<MosaicShape>,
    },
}

impl AnnotationDocument {
    pub fn from_json(document_json: &str) -> Result<Self, String> {
        if document_json.is_empty() || document_json.len() > MAX_ANNOTATION_DOCUMENT_BYTES {
            return Err("The annotation document is too large.".into());
        }
        let document: Self = serde_json::from_str(document_json)
            .map_err(|_| "The annotation document is invalid.".to_string())?;
        document.validate()?;
        Ok(document)
    }

    pub fn to_json(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)
            .map_err(|_| "The annotation document could not be encoded.".to_string())?;
        if bytes.len() > MAX_ANNOTATION_DOCUMENT_BYTES {
            return Err("The annotation document is too large.".into());
        }
        Ok(bytes)
    }

    pub fn has_marks(&self) -> bool {
        !self.marks.is_empty()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != ANNOTATION_SCHEMA_VERSION {
            return Err("The annotation document version is unsupported.".into());
        }
        validate_dimension(self.canvas.width)?;
        validate_dimension(self.canvas.height)?;
        if self.source_pixels.width == 0
            || self.source_pixels.height == 0
            || f64::from(self.source_pixels.width) > MAX_CANVAS_DIMENSION
            || f64::from(self.source_pixels.height) > MAX_CANVAS_DIMENSION
        {
            return Err("The annotation source dimensions are invalid.".into());
        }
        if self.marks.len() > MAX_MARKS {
            return Err("The annotation document contains too many marks.".into());
        }

        let coordinate_limit = MAX_COORDINATE_MAGNITUDE;
        let mut ids = HashSet::with_capacity(self.marks.len());
        let mut total_points = 0usize;
        let mut total_text_bytes = 0usize;
        let mut total_watermark_tiles = 0usize;
        for mark in &self.marks {
            let (id, points, text_bytes) = match mark {
                AnnotationMark::Watermark {
                    id, text, rect, font_size, opacity, rotation, mode, spacing, ..
                } => {
                    let text_units = text.encode_utf16().take(MAX_WATERMARK_TEXT_UNITS + 1).count();
                    if text_units > MAX_WATERMARK_TEXT_UNITS {
                        return Err("Watermark text must be 512 characters or fewer.".into());
                    }
                    validate_rect(*rect, coordinate_limit, false)?;
                    validate_visual_size(*font_size)?;
                    if !opacity.is_finite() || !(0.0..=1.0).contains(opacity)
                        || !rotation.is_finite() || !(-180.0..=180.0).contains(rotation)
                        || !spacing.is_finite() || !(16.0..=MAX_VISUAL_SIZE).contains(spacing)
                    {
                        return Err("The watermark style is invalid.".into());
                    }
                    let tiles = if *mode == WatermarkMode::Tiled {
                        watermark_tile_count(*rect, *rotation, *spacing, self.canvas)?
                    } else { 1 };
                    total_watermark_tiles = total_watermark_tiles.saturating_add(tiles);
                    if total_watermark_tiles > MAX_TOTAL_WATERMARK_TILES {
                        return Err(WATERMARK_DENSITY_ERROR.into());
                    }
                    (*id, 0, text_units)
                }
                AnnotationMark::Callout { id, center, number, text, label_rect, size, font_size, .. } => {
                    if !(1..=999).contains(number) {
                        return Err("The annotation number is invalid.".into());
                    }
                    validate_point(*center, coordinate_limit)?;
                    validate_rect(*label_rect, coordinate_limit, true)?;
                    validate_visual_size(*size)?;
                    validate_visual_size(*font_size)?;
                    (*id, 0, text.encode_utf16().count())
                }
                AnnotationMark::Pen {
                    id, points, width, ..
                } => {
                    validate_visual_size(*width)?;
                    validate_points(points, 1, coordinate_limit)?;
                    (*id, points.len(), 0)
                }
                AnnotationMark::Rectangle {
                    id, rect, width, ..
                } => {
                    validate_visual_size(*width)?;
                    validate_rect(*rect, coordinate_limit, true)?;
                    (*id, 0, 0)
                }
                AnnotationMark::Line {
                    id,
                    start,
                    end,
                    width,
                    ..
                }
                | AnnotationMark::Arrow {
                    id,
                    start,
                    end,
                    width,
                    ..
                } => {
                    validate_visual_size(*width)?;
                    validate_point(*start, coordinate_limit)?;
                    validate_point(*end, coordinate_limit)?;
                    (*id, 0, 0)
                }
                AnnotationMark::Text {
                    id,
                    text,
                    rect,
                    font_size,
                    ..
                } => {
                    if text.encode_utf16().count() > MAX_TOTAL_TEXT_UNITS {
                        return Err("The annotation text is invalid.".into());
                    }
                    validate_rect(*rect, coordinate_limit, true)?;
                    validate_visual_size(*font_size)?;
                    (*id, 0, text.encode_utf16().count())
                }
                AnnotationMark::Mosaic {
                    id,
                    points,
                    brush_diameter,
                    shape,
                    ..
                } => {
                    validate_visual_size(*brush_diameter)?;
                    validate_points(points, 1, coordinate_limit)?;
                    if matches!(shape, Some(MosaicShape::Rectangle | MosaicShape::Ellipse))
                        && points.len() != 2
                    {
                        return Err("A mosaic shape needs two corners.".into());
                    }
                    (*id, points.len(), 0)
                }
            };

            let normalized_id = if id == 0.0 { 0.0 } else { id };
            if !id.is_finite()
                || !(0.0..=MAX_SAFE_INTEGER).contains(&id)
                || !ids.insert(normalized_id.to_bits())
            {
                return Err("The annotation mark id is invalid.".into());
            }
            total_points = total_points
                .checked_add(points)
                .ok_or_else(|| "The annotation document contains too many points.".to_string())?;
            total_text_bytes = total_text_bytes
                .checked_add(text_bytes)
                .ok_or_else(|| "The annotation document contains too much text.".to_string())?;
            if total_points > MAX_TOTAL_POINTS {
                return Err("The annotation document contains too many points.".into());
            }
            if total_text_bytes > MAX_TOTAL_TEXT_UNITS {
                return Err("The annotation document contains too much text.".into());
            }
        }
        Ok(())
    }

    /// Validates the document against the persisted image that owns it. The
    /// generic schema bounds above are not enough: a well-formed sidecar with
    /// different source dimensions or aspect ratio must be treated as invalid
    /// instead of being paired with the wrong pixels.
    pub fn validate_for_image_pixels(
        &self,
        expected_width: i64,
        expected_height: i64,
    ) -> Result<(), String> {
        self.validate()?;
        if expected_width <= 0
            || expected_height <= 0
            || u32::try_from(expected_width).ok() != Some(self.source_pixels.width)
            || u32::try_from(expected_height).ok() != Some(self.source_pixels.height)
        {
            return Err("The annotation document does not match the edited image.".into());
        }
        let document_ratio = self.canvas.width / self.canvas.height;
        let source_ratio = expected_width as f64 / expected_height as f64;
        if !document_ratio.is_finite()
            || (document_ratio - source_ratio).abs() > source_ratio.abs().max(1.0) * 0.005
        {
            return Err("The annotation canvas does not match the edited image.".into());
        }
        Ok(())
    }
}

/// Fixed document-axis grid, matching watermark-geometry.js. A crop translates
/// only the master rect, so every surviving tile keeps its original phase.
fn watermark_tile_count(
    rect: AnnotationRect,
    rotation: f64,
    spacing: f64,
    canvas: AnnotationSize,
) -> Result<usize, String> {
    let angle = rotation * std::f64::consts::PI / 180.0;
    let cos = angle.cos().abs();
    let sin = angle.sin().abs();
    let width = rect.width * cos + rect.height * sin;
    let height = rect.width * sin + rect.height * cos;
    let center_x = rect.x + rect.width / 2.0;
    let center_y = rect.y + rect.height / 2.0;
    let step_x = width + spacing;
    let step_y = height + spacing;
    // Include boundary-touching tiles conservatively across JS/Rust libm rounding.
    let start_column = ((-width / 2.0 - center_x) / step_x - 1e-9).ceil();
    let end_column = ((canvas.width + width / 2.0 - center_x) / step_x + 1e-9).floor();
    let start_row = ((-height / 2.0 - center_y) / step_y - 1e-9).ceil();
    let end_row = ((canvas.height + height / 2.0 - center_y) / step_y + 1e-9).floor();
    let count = (end_column - start_column + 1.0).max(0.0)
        * (end_row - start_row + 1.0).max(0.0);
    if !count.is_finite() || count > MAX_WATERMARK_TILES as f64 {
        Err(WATERMARK_DENSITY_ERROR.into())
    } else {
        Ok(count as usize)
    }
}

fn validate_dimension(value: f64) -> Result<(), String> {
    if value.is_finite() && value > 0.0 && value <= MAX_CANVAS_DIMENSION {
        Ok(())
    } else {
        Err("The annotation canvas dimensions are invalid.".into())
    }
}

fn validate_visual_size(value: f64) -> Result<(), String> {
    if value.is_finite() && value > 0.0 && value <= MAX_VISUAL_SIZE {
        Ok(())
    } else {
        Err("The annotation mark size is invalid.".into())
    }
}

fn validate_point(point: AnnotationPoint, limit: f64) -> Result<(), String> {
    if point.x.is_finite()
        && point.y.is_finite()
        && point.x.abs() <= limit
        && point.y.abs() <= limit
    {
        Ok(())
    } else {
        Err("The annotation point is invalid.".into())
    }
}

fn validate_points(
    points: &[AnnotationPoint],
    minimum: usize,
    coordinate_limit: f64,
) -> Result<(), String> {
    if points.len() < minimum || points.len() > MAX_POINTS_PER_MARK {
        return Err("The annotation point list is invalid.".into());
    }
    points
        .iter()
        .try_for_each(|point| validate_point(*point, coordinate_limit))
}

fn validate_rect(rect: AnnotationRect, limit: f64, allow_zero_size: bool) -> Result<(), String> {
    if rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.x.abs() <= limit
        && rect.y.abs() <= limit
        && (if allow_zero_size { rect.width >= 0.0 } else { rect.width > 0.0 })
        && (if allow_zero_size { rect.height >= 0.0 } else { rect.height > 0.0 })
        && rect.width <= limit
        && rect.height <= limit
    {
        Ok(())
    } else {
        Err("The annotation rectangle is invalid.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document_json(mark: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"canvas":{{"width":100,"height":80}},"sourcePixels":{{"width":200,"height":160}},"marks":[{mark}]}}"#
        )
    }

    #[test]
    fn parses_every_supported_mark_and_round_trips() {
        let marks = [
            r#"{"kind":"pen","id":1,"points":[{"x":1,"y":2},{"x":3,"y":4}],"color":"violet","width":3}"#,
            r#"{"kind":"rectangle","id":2,"rect":{"x":1,"y":2,"width":30,"height":20},"color":"cherry","width":3}"#,
            r#"{"kind":"line","id":3,"start":{"x":1,"y":2},"end":{"x":3,"y":4},"color":"orange","width":3}"#,
            r#"{"kind":"arrow","id":4,"start":{"x":1,"y":2},"end":{"x":3,"y":4},"color":"yellow","width":3}"#,
            r#"{"kind":"text","id":5,"text":"Kiri","rect":{"x":1,"y":2,"width":30,"height":20},"color":"mint","background":"transparent","fontSize":18}"#,
            r#"{"kind":"mosaic","id":6,"points":[{"x":1,"y":2}],"brushDiameter":20,"intensity":"standard","style":"pixel"}"#,
            r#"{"kind":"callout","id":7,"center":{"x":20,"y":30},"number":1,"text":"説明\nStep one","labelRect":{"x":45,"y":20,"width":40,"height":40},"color":"cherry","size":36,"fontSize":18,"style":"filled"}"#,
            r#"{"kind":"watermark","id":8,"text":"透明 watermark","rect":{"x":20,"y":30,"width":40,"height":20},"color":"black","fontSize":28,"opacity":0.2,"rotation":-30,"mode":"tiled","spacing":80}"#,
        ];
        let json = format!(
            r#"{{"schemaVersion":1,"canvas":{{"width":100,"height":80}},"sourcePixels":{{"width":200,"height":160}},"marks":[{}]}}"#,
            marks.join(",")
        );
        let parsed = AnnotationDocument::from_json(&json).unwrap();
        let encoded = String::from_utf8(parsed.to_json().unwrap()).unwrap();
        assert_eq!(AnnotationDocument::from_json(&encoded).unwrap(), parsed);
    }

    #[test]
    fn rejects_unknown_fields_kinds_enums_and_duplicate_ids() {
        assert!(AnnotationDocument::from_json(&document_json(
            r#"{"kind":"pen","id":1,"points":[{"x":1,"y":2},{"x":3,"y":4}],"color":"violet","width":3,"extra":true}"#
        ))
        .is_err());
        assert!(
            AnnotationDocument::from_json(&document_json(r#"{"kind":"sparkle","id":1}"#)).is_err()
        );
        assert!(AnnotationDocument::from_json(&document_json(
            r#"{"kind":"pen","id":1,"points":[{"x":1,"y":2},{"x":3,"y":4}],"color":"cyan","width":3}"#
        ))
        .is_err());
        let duplicate = document_json(
            r#"{"kind":"line","id":1,"start":{"x":1,"y":2},"end":{"x":3,"y":4},"color":"blue","width":3},{"kind":"arrow","id":1,"start":{"x":1,"y":2},"end":{"x":3,"y":4},"color":"white","width":3}"#,
        );
        assert!(AnnotationDocument::from_json(&duplicate).is_err());
        let signed_zero_duplicate = document_json(
            r#"{"kind":"line","id":0,"start":{"x":1,"y":2},"end":{"x":3,"y":4},"color":"blue","width":3},{"kind":"arrow","id":-0,"start":{"x":1,"y":2},"end":{"x":3,"y":4},"color":"white","width":3}"#,
        );
        assert!(AnnotationDocument::from_json(&signed_zero_duplicate).is_err());
    }

    #[test]
    fn numbered_notes_validate_content_and_old_preferences_keep_defaults() {
        let mark = r#"{"kind":"callout","id":1,"center":{"x":20,"y":30},"number":999,"text":"说明","labelRect":{"x":45,"y":20,"width":40,"height":40},"color":"white","size":36,"fontSize":18,"style":"outline"}"#;
        assert!(AnnotationDocument::from_json(&document_json(mark)).is_ok());
        for invalid in [mark.replace("999", "0"), mark.replace("999", "1000"), mark.replace("999", "1.5"), mark.replace("outline", "unknown")] {
            assert!(AnnotationDocument::from_json(&document_json(&invalid)).is_err());
        }
        let mut oversized = serde_json::from_str::<serde_json::Value>(mark).unwrap();
        oversized["text"] = serde_json::Value::String("x".repeat(MAX_TOTAL_TEXT_UNITS + 1));
        assert!(AnnotationDocument::from_json(&document_json(&oversized.to_string())).is_err());
        let old: AnnotationAppearance = serde_json::from_str(r#"{"textFontSize":24}"#).unwrap();
        assert_eq!(old.callout_style, CalloutStyle::Filled);
        assert_eq!(old.callout_size, 36);
        let patch: AnnotationAppearancePatch = serde_json::from_str(r#"{"calloutSize":999,"calloutStyle":"outline"}"#).unwrap();
        let saved = patch.apply(old);
        assert_eq!(saved.callout_size, 72);
        assert_eq!(saved.callout_style, CalloutStyle::Outline);
        assert_eq!(saved.text_font_size, 24);
    }

    #[test]
    fn label_direction_roundtrips_without_changing_legacy_text_or_preferences() {
        let mark = r#"{"kind":"text","id":1,"text":"Label","rect":{"x":30,"y":30,"width":40,"height":20},"color":"cherry","background":"transparent","fontSize":18,"labelDirection":"right"}"#;
        let document = AnnotationDocument::from_json(&document_json(mark)).unwrap();
        let encoded = String::from_utf8(document.to_json().unwrap()).unwrap();
        assert!(encoded.contains(r#""labelDirection":"right""#));
        assert!(AnnotationDocument::from_json(&document_json(&mark.replace("right", "up"))).is_err());
        let legacy = mark.replace(r#","labelDirection":"right""#, "");
        assert!(AnnotationDocument::from_json(&document_json(&legacy)).is_ok());
        let old: AnnotationAppearance = serde_json::from_str(r#"{"textFontSize":24}"#).unwrap();
        assert_eq!(old.label_direction, LabelDirection::Left);
        let patch: AnnotationAppearancePatch = serde_json::from_str(r#"{"labelDirection":"right"}"#).unwrap();
        assert_eq!(patch.apply(old).label_direction, LabelDirection::Right);
    }

    #[test]
    fn mosaic_shapes_validate_corners_and_keep_legacy_brushes_compatible() {
        for shape in ["rectangle", "ellipse", "brush"] {
            let mark = format!(r#"{{"kind":"mosaic","id":1,"points":[{{"x":10,"y":20}},{{"x":70,"y":50}}],"brushDiameter":20,"intensity":"standard","style":"blur","shape":"{shape}"}}"#);
            let parsed = AnnotationDocument::from_json(&document_json(&mark)).unwrap();
            let encoded = String::from_utf8(parsed.to_json().unwrap()).unwrap();
            assert_eq!(AnnotationDocument::from_json(&encoded).unwrap(), parsed);
        }
        let invalid = r#"{"kind":"mosaic","id":1,"points":[{"x":10,"y":20}],"brushDiameter":20,"intensity":"standard","style":"blur","shape":"ellipse"}"#;
        assert!(AnnotationDocument::from_json(&document_json(invalid)).is_err());
    }

    #[test]
    fn rejects_non_finite_programmatic_geometry_and_oversized_json() {
        let mut document = AnnotationDocument::from_json(&document_json(
            r#"{"kind":"rectangle","id":1,"rect":{"x":1,"y":2,"width":30,"height":20},"color":"black","width":3}"#,
        ))
        .unwrap();
        document.canvas.width = f64::NAN;
        assert!(document.validate().is_err());

        let oversized = " ".repeat(MAX_ANNOTATION_DOCUMENT_BYTES + 1);
        assert!(AnnotationDocument::from_json(&oversized).is_err());
    }

    #[test]
    fn validates_source_dimensions_and_canvas_ratio_against_the_image() {
        let document = AnnotationDocument::from_json(
            r#"{"schemaVersion":1,"canvas":{"width":100,"height":80},"sourcePixels":{"width":200,"height":160},"marks":[]}"#,
        )
        .unwrap();
        document.validate_for_image_pixels(200, 160).unwrap();
        assert!(document.validate_for_image_pixels(201, 160).is_err());

        let mut wrong_ratio = document;
        wrong_ratio.canvas.width = 120.0;
        assert!(wrong_ratio.validate_for_image_pixels(200, 160).is_err());
    }

    #[test]
    fn appearance_patches_merge_against_latest_shared_preferences() {
        let defaults = AnnotationAppearance::default();
        let width: AnnotationAppearancePatch = serde_json::from_str(r#"{"penWidth":24}"#).unwrap();
        let color: AnnotationAppearancePatch = serde_json::from_str(r#"{"colorPreset":"blue"}"#).unwrap();
        let merged = color.apply(width.apply(defaults));
        assert_eq!(merged.pen_width, 24);
        assert_eq!(merged.color_preset, AnnotationColor::Blue);
        assert_eq!(merged.shape_width, defaults.shape_width);
        assert_eq!(AnnotationAppearancePatch { text_font_size: Some(999), ..Default::default() }.apply(merged).text_font_size, 64);
        assert!(serde_json::from_str::<AnnotationAppearancePatch>(r#"{"activeTool":"pen"}"#).is_err());
    }

    #[test]
    fn annotation_appearance_defaults_and_clamps_visual_sizes() {
        let defaults: AnnotationAppearance = serde_json::from_str("{}").unwrap();
        assert_eq!(defaults, AnnotationAppearance::default());
        assert_eq!(defaults.color_preset, AnnotationColor::Cherry);
        let saved: AnnotationAppearance = serde_json::from_str(r#"{"colorPreset":"violet"}"#).unwrap();
        assert_eq!(saved.color_preset, AnnotationColor::Violet);

        let oversized: AnnotationAppearance = serde_json::from_str(
            r#"{
                "colorPreset":"cherry",
                "textBackgroundStyle":"dark",
                "mosaicIntensity":"strong",
                "mosaicStyle":"blur",
                "penWidth":0,
                "shapeWidth":99,
                "textFontSize":2,
                "mosaicBrushDiameter":999
            }"#,
        )
        .unwrap();
        let normalized = oversized.normalized();
        assert_eq!(normalized.color_preset, AnnotationColor::Cherry);
        assert_eq!(normalized.text_background_style, TextBackground::Dark);
        assert_eq!(normalized.mosaic_intensity, MosaicIntensity::Strong);
        assert_eq!(normalized.mosaic_style, MosaicStyle::Blur);
        assert_eq!(normalized.pen_width, 1);
        assert_eq!(normalized.shape_width, 16);
        assert_eq!(normalized.text_font_size, 12);
        assert_eq!(normalized.mosaic_brush_diameter, 120);
        assert!(serde_json::from_str::<AnnotationAppearance>(r#"{"extra":true}"#).is_err());
    }

    #[test]
    fn watermark_preferences_merge_with_legacy_defaults_and_normalize_integer_controls() {
        let legacy: AnnotationAppearance = serde_json::from_str(r#"{"textFontSize":24}"#).unwrap();
        assert_eq!(legacy.watermark_color, AnnotationColor::Black);
        assert_eq!(legacy.watermark_font_size, 28);
        assert_eq!(legacy.watermark_opacity, 20);
        assert_eq!(legacy.watermark_rotation, -30);
        assert_eq!(legacy.watermark_mode, WatermarkMode::Tiled);
        assert_eq!(legacy.watermark_spacing, 80);
        assert_eq!(legacy.mosaic_shape, MosaicShape::Brush);
        let patch: AnnotationAppearancePatch = serde_json::from_str(r#"{"watermarkFontSize":999,"watermarkOpacity":999,"watermarkRotation":-999,"watermarkSpacing":0,"watermarkMode":"single","watermarkColor":"white","mosaicShape":"ellipse"}"#).unwrap();
        let result = patch.apply(legacy);
        assert_eq!(result.watermark_font_size, 128);
        assert_eq!(result.watermark_opacity, 100);
        assert_eq!(result.watermark_rotation, -180);
        assert_eq!(result.watermark_spacing, 16);
        assert_eq!(result.watermark_mode, WatermarkMode::Single);
        assert_eq!(result.watermark_color, AnnotationColor::White);
        assert_eq!(result.mosaic_shape, MosaicShape::Ellipse);
        assert_eq!(result.text_font_size, 24);
        let encoded = serde_json::to_string(&result).unwrap();
        assert_eq!(serde_json::from_str::<AnnotationAppearance>(&encoded).unwrap(), result);
    }

    fn watermark_json() -> serde_json::Value {
        serde_json::json!({"kind":"watermark","id":1,"text":"图片 © Kiri","rect":{"x":20,"y":30,"width":80,"height":35},"color":"black","fontSize":28,"opacity":0.2,"rotation":-30,"mode":"tiled","spacing":80})
    }

    #[test]
    fn watermark_schema_rejects_invalid_fields_geometry_and_unbounded_text() {
        let valid = watermark_json();
        assert!(AnnotationDocument::from_json(&document_json(&valid.to_string())).is_ok());
        for (key, value) in [
            ("opacity", serde_json::json!(-0.1)), ("opacity", serde_json::json!(1.1)),
            ("rotation", serde_json::json!(181)), ("spacing", serde_json::json!(15)),
            ("spacing", serde_json::json!(4097)), ("mode", serde_json::json!("repeat")),
            ("extra", serde_json::json!(true)), ("text", serde_json::json!("😀".repeat(257))),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(AnnotationDocument::from_json(&document_json(&invalid.to_string())).is_err(), "{key}");
        }
        let mut zero = valid;
        zero["rect"]["width"] = serde_json::json!(0);
        assert!(AnnotationDocument::from_json(&document_json(&zero.to_string())).is_err());
    }

    #[test]
    fn watermark_grid_bounds_match_document_density_and_boundary_tiles() {
        let rect = AnnotationRect {x: 0.0, y: 0.0, width: 1.0, height: 1.0};
        assert_eq!(watermark_tile_count(rect, 0.0, 16.0, AnnotationSize {width: 1071.0, height: 1071.0}).unwrap(), 4096);
        assert!(watermark_tile_count(rect, 0.0, 16.0, AnnotationSize {width: 1088.0, height: 1088.0}).is_err());
        let mut mark = watermark_json();
        mark["rect"] = serde_json::json!({"x":0,"y":0,"width":1,"height":1});
        mark["rotation"] = serde_json::json!(0);
        mark["spacing"] = serde_json::json!(16);
        let mut document: AnnotationDocument = serde_json::from_str(&document_json(&mark.to_string())).unwrap();
        document.canvas = AnnotationSize {width: 1024.0, height: 1024.0};
        document.marks.push(document.marks[0].clone());
        if let AnnotationMark::Watermark {id, ..} = &mut document.marks[1] { *id = 2.0; }
        assert!(document.validate().is_ok());
        document.marks.push(document.marks[0].clone());
        if let AnnotationMark::Watermark {id, ..} = &mut document.marks[2] { *id = 3.0; }
        assert_eq!(document.validate().unwrap_err(), WATERMARK_DENSITY_ERROR);
        // Moving the anchor outside the document does not eliminate repeated tiles.
        assert!(watermark_tile_count(AnnotationRect {x:-10013.0,y:-10013.0,..rect}, 0.0, 16.0,
            AnnotationSize {width:1088.0,height:1088.0}).is_err());
    }
}
