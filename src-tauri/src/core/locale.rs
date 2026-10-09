//! Shared persisted language codes and OS locale normalization.
pub const LANGUAGES: [&str; 7] = ["en", "zh-Hans", "zh-Hant", "ja", "de", "ko", "fr"];
pub fn is_language(value: &str) -> bool {
    LANGUAGES.contains(&value)
}
pub fn language_for_locale(value: &str) -> &'static str {
    let value = value.to_lowercase().replace('_', "-");
    let parts: Vec<_> = value.split('-').collect();
    match parts[0] {
        "zh" => {
            if parts
                .iter()
                .skip(1)
                .any(|part| matches!(*part, "hant" | "tw" | "hk" | "mo"))
            {
                "zh-Hant"
            } else {
                "zh-Hans"
            }
        }
        "ja" => "ja",
        "de" => "de",
        "ko" => "ko",
        "fr" => "fr",
        _ => "en",
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn resolves_system_and_saved_languages() {
        for (input, expected) in [
            ("zh_TW", "zh-Hant"),
            ("zh-Hant-HK", "zh-Hant"),
            ("zh-CN", "zh-Hans"),
            ("zh", "zh-Hans"),
            ("de-AT", "de"),
            ("ko_KR", "ko"),
            ("fr-CA", "fr"),
            ("ja-JP", "ja"),
            ("es", "en"),
        ] {
            assert_eq!(super::language_for_locale(input), expected);
        }
        assert!(super::LANGUAGES.iter().all(|lang| super::is_language(lang)));
        assert!(!super::is_language("de-DE"));
    }
}
