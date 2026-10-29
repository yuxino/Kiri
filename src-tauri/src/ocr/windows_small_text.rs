//! Bounded recovery for empty Windows OCR results on narrow text crops.

use anyhow::Result;
use image::{imageops, RgbaImage};

const SMALL_EDGE: u32 = 128;
const PADDING: u32 = 16;

pub(super) fn recognize(
    image: &RgbaImage,
    max_dimension: u32,
    mut recognize_image: impl FnMut(&RgbaImage) -> Result<String>,
) -> Result<String> {
    let text = recognize_image(image)?;
    if !text.trim().is_empty() {
        return Ok(text);
    }
    let Some(recovery) = recovery_image(image, max_dimension) else {
        return Ok(text);
    };
    recognize_image(&recovery)
}

fn recovery_image(image: &RgbaImage, max_dimension: u32) -> Option<RgbaImage> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 || width.min(height) > SMALL_EDGE {
        return None;
    }
    // Keep an integer enlargement, preserving aspect ratio and reserving space
    // for padding inside the native engine's actual dimension limit. With one
    // edge <= 128 and scale <= 3 this also bounds the retry's pixel allocation.
    let available = max_dimension.checked_sub(2 * PADDING)?;
    let scale = (available / width.max(height)).min(3);
    if scale < 2 {
        return None;
    }
    let enlarged = imageops::resize(
        image,
        width * scale,
        height * scale,
        imageops::FilterType::Lanczos3,
    );
    // Match the most common corner color so dark crops keep a dark margin.
    let corners = [
        *image.get_pixel(0, 0),
        *image.get_pixel(width - 1, 0),
        *image.get_pixel(0, height - 1),
        *image.get_pixel(width - 1, height - 1),
    ];
    let background = corners.iter().max_by_key(|color| {
        corners
            .iter()
            .filter(|candidate| *candidate == *color)
            .count()
    })?;
    let mut padded = RgbaImage::from_pixel(
        enlarged.width() + 2 * PADDING,
        enlarged.height() + 2 * PADDING,
        *background,
    );
    imageops::replace(
        &mut padded,
        &enlarged,
        i64::from(PADDING),
        i64::from(PADDING),
    );
    Some(padded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn narrow_crop() -> RgbaImage {
        let mut image = RgbaImage::from_pixel(295, 35, Rgba([255; 4]));
        for y in 10..24 {
            for x in 5..290 {
                image.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        image
    }

    #[test]
    fn preserves_nonempty_first_result_without_another_call() {
        let image = narrow_crop();
        let mut calls = 0;
        let text = recognize(&image, 2600, |pixels| {
            calls += 1;
            assert_eq!(pixels, &image);
            Ok("  Original text\n".into())
        })
        .unwrap();
        assert_eq!(text, "  Original text\n");
        assert_eq!(calls, 1);
    }

    #[test]
    fn empty_narrow_crop_uses_one_enlarged_padded_attempt_and_preserves_source() {
        let image = narrow_crop();
        let original = image.clone();
        let mut sizes = Vec::new();
        let text = recognize(&image, 2600, |pixels| {
            sizes.push(pixels.dimensions());
            Ok(if sizes.len() == 1 {
                " \n"
            } else {
                "Recovered text"
            }
            .into())
        })
        .unwrap();
        assert_eq!(sizes, [(295, 35), (917, 137)]);
        assert_eq!(text, "Recovered text");
        assert_eq!(image, original);
    }

    #[test]
    fn blank_crop_remains_successful_empty_with_at_most_two_calls() {
        let image = RgbaImage::from_pixel(295, 35, Rgba([255; 4]));
        let mut calls = 0;
        let text = recognize(&image, 2600, |pixels| {
            calls += 1;
            assert!(pixels.pixels().all(|pixel| *pixel == Rgba([255; 4])));
            Ok(String::new())
        })
        .unwrap();
        assert_eq!(text, "");
        assert_eq!(calls, 2);
    }

    #[test]
    fn full_size_and_limit_constrained_crops_do_not_retry() {
        for (width, height, limit) in [(640, 480, 2600), (1300, 35, 2600), (295, 35, 32)] {
            let image = RgbaImage::new(width, height);
            let mut calls = 0;
            assert_eq!(
                recognize(&image, limit, |_| {
                    calls += 1;
                    Ok(String::new())
                })
                .unwrap(),
                ""
            );
            assert_eq!(calls, 1);
        }
        assert!(recovery_image(&RgbaImage::new(0, 35), 2600).is_none());
    }

    #[test]
    fn recovery_fits_native_limit_and_preserves_dark_border_and_orientation() {
        for (width, height, expected) in [(1000, 35, (2032, 102)), (35, 1000, (102, 2032))] {
            let background = Rgba([16, 18, 20, 255]);
            let mut image = RgbaImage::from_pixel(width, height, background);
            image.put_pixel(width / 2, height / 2, Rgba([255; 4]));
            let recovered = recovery_image(&image, 2600).unwrap();
            assert_eq!(recovered.dimensions(), expected);
            assert_eq!(*recovered.get_pixel(0, 0), background);
            assert!(recovered.width() <= 2600 && recovered.height() <= 2600);
        }
    }

    #[test]
    fn native_errors_remain_errors() {
        let mut calls = 0;
        assert!(recognize(&narrow_crop(), 2600, |_| {
            calls += 1;
            anyhow::bail!("native failure")
        })
        .is_err());
        assert_eq!(calls, 1);
        let mut calls = 0;
        assert!(recognize(&narrow_crop(), 2600, |_| {
            calls += 1;
            if calls == 1 {
                Ok(String::new())
            } else {
                anyhow::bail!("recovery failure")
            }
        })
        .is_err());
        assert_eq!(calls, 2);
    }
}
