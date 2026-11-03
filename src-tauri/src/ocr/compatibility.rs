//! A system language is only a hint to try native OCR. Select that result
//! only when the image actually yields text in the hinted, uncovered script.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Script {
    Hangul,
    Cyrillic,
    Arabic,
    Hebrew,
    Devanagari,
    Thai,
}

pub(super) fn system_hint() -> Option<Script> {
    #[cfg(target_os = "macos")]
    let tag = sys_locale::get_locale();
    #[cfg(windows)]
    let tag = windows::Media::Ocr::OcrEngine::TryCreateFromUserProfileLanguages()
        .and_then(|engine| engine.RecognizerLanguage())
        .and_then(|language| language.LanguageTag())
        .ok()
        .map(|tag| tag.to_string());
    // Kiri's existing Linux fallback requests only eng, chi_sim and jpn.
    #[cfg(target_os = "linux")]
    let tag: Option<String> = None;
    tag.as_deref().and_then(Script::from_tag)
}

impl Script {
    fn from_tag(tag: &str) -> Option<Self> {
        let tag = tag.to_ascii_lowercase();
        let mut parts = tag.split(['-', '_']);
        let language = parts.next()?;
        let script =
            parts.find(|part| part.len() == 4 && part.bytes().all(|c| c.is_ascii_alphabetic()));
        match (language, script) {
            (_, Some("hang" | "kore")) | ("ko", None) => Some(Self::Hangul),
            (_, Some("cyrl"))
            | ("ru" | "uk" | "be" | "bg" | "mk" | "sr" | "kk" | "ky" | "mn", None) => {
                Some(Self::Cyrillic)
            }
            (_, Some("arab")) | ("ar" | "fa" | "ur" | "ps", None) => Some(Self::Arabic),
            (_, Some("hebr")) | ("he" | "yi", None) => Some(Self::Hebrew),
            (_, Some("deva")) | ("hi" | "mr" | "ne", None) => Some(Self::Devanagari),
            (_, Some("thai")) | ("th", None) => Some(Self::Thai),
            _ => None,
        }
    }

    fn contains_letter(self, c: char) -> bool {
        c.is_alphabetic()
            && match self {
                Self::Hangul => {
                    matches!(c as u32, 0x1100..=0x11ff | 0x3130..=0x318f | 0xa960..=0xa97f | 0xac00..=0xd7ff)
                }
                Self::Cyrillic => matches!(c as u32, 0x0400..=0x052f | 0xa640..=0xa69f),
                Self::Arabic => {
                    matches!(c as u32, 0x0600..=0x06ff | 0x0750..=0x077f | 0x08a0..=0x08ff | 0xfb50..=0xfdff | 0xfe70..=0xfeff)
                }
                Self::Hebrew => matches!(c as u32, 0x0590..=0x05ff | 0xfb1d..=0xfb4f),
                Self::Devanagari => matches!(c as u32, 0x0900..=0x097f),
                Self::Thai => matches!(c as u32, 0x0e00..=0x0e7f),
            }
    }

    pub(super) fn confirms(self, native: &str, model: &str) -> bool {
        let mut previous = false;
        let has_word = native.chars().any(|c| {
            let letter = self.contains_letter(c);
            let pair = previous && letter;
            previous = letter;
            pair
        });
        // A short fragment from a technical label must not displace a whole
        // page. Compare content characters, ignoring layout and whitespace.
        let length = |s: &str| s.chars().filter(|c| !c.is_whitespace()).count();
        has_word && length(native).saturating_mul(2) >= length(model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_subtags_override_language_defaults() {
        assert_eq!(Script::from_tag("sr-Latn-RS"), None);
        assert_eq!(Script::from_tag("sr_Cyrl_RS"), Some(Script::Cyrillic));
        assert_eq!(Script::from_tag("zh-Hant-TW"), None);
        assert_eq!(Script::from_tag("ja-JP"), None);
        assert_eq!(Script::from_tag("ko-KR"), Some(Script::Hangul));
    }

    #[test]
    fn probes_confirm_real_script_and_reject_unrelated_fragments() {
        for (script, word) in [
            (Script::Hangul, "한국어"),
            (Script::Cyrillic, "Привет"),
            (Script::Arabic, "مرحبا"),
            (Script::Hebrew, "שלום"),
            (Script::Devanagari, "नमस्ते"),
            (Script::Thai, "ภาษา"),
        ] {
            assert!(script.confirms(&format!("API {word} 42"), "API xxxx 42"));
        }
        assert!(!Script::Hangul.confirms("API A한BB", "API ABBB"));
        assert!(!Script::Hangul.confirms("한국", "A much longer recognized paragraph"));
        assert!(!Script::Arabic.confirms("١٢٣٤", "1234"));
    }
}
