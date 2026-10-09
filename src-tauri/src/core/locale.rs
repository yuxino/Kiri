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
            if parts.contains(&"hant") {
                return "zh-Hant";
            }
            if parts.contains(&"hans") {
                return "zh-Hans";
            }
            if parts
                .iter()
                .skip(1)
                .any(|part| matches!(*part, "tw" | "hk" | "mo"))
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
/// Native dialogs use the same saved choice as the renderer, with OS fallback.
pub fn preferred_language(saved: &str, system_locale: &str) -> &'static str {
    LANGUAGES
        .iter()
        .copied()
        .find(|language| *language == saved)
        .unwrap_or_else(|| language_for_locale(system_locale))
}

pub fn png_filter_label(language: &str) -> &'static str {
    match language {
        "zh-Hans" => "PNG 图片",
        "zh-Hant" => "PNG 圖片",
        "ja" => "PNG 画像",
        "de" => "PNG-Bild",
        "ko" => "PNG 이미지",
        "fr" => "Image PNG",
        _ => "PNG image",
    }
}

/// Keep the small native Portal labels here rather than embedding full UI
/// dictionaries just to read three strings. The frontend parity test checks
/// these labels against the complete application dictionaries.
pub fn shortcut_descriptions(language: &str) -> [&'static str; 3] {
    match language {
        "zh-Hans" => ["截图 / 录屏", "暂停/继续录制", "停止录制"],
        "zh-Hant" => ["截圖 / 錄影", "暫停/繼續錄製", "停止錄製"],
        "ja" => ["キャプチャ", "録画を一時停止／再開", "録画を停止"],
        "de" => [
            "Aufnehmen",
            "Aufnahme pausieren/fortsetzen",
            "Aufnahme beenden",
        ],
        "ko" => ["캡처", "녹화 일시 정지/재개", "녹화 중지"],
        "fr" => [
            "Capturer",
            "Suspendre/Reprendre l’enregistrement",
            "Arrêter l’enregistrement",
        ],
        _ => ["Capture", "Pause/Resume Recording", "Stop Recording"],
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_labels_respect_saved_choices_and_system_fallback() {
        for language in super::LANGUAGES {
            assert_eq!(super::preferred_language(language, "en-US"), language);
            assert!(!super::png_filter_label(language).is_empty());
            assert!(super::shortcut_descriptions(language)
                .iter()
                .all(|label| !label.is_empty()));
        }
        assert_eq!(super::preferred_language("", "zh-TW"), "zh-Hant");
        assert_eq!(super::preferred_language("invalid", "fr-CA"), "fr");
        assert_eq!(super::png_filter_label("de"), "PNG-Bild");
        assert_eq!(super::png_filter_label("ko"), "PNG 이미지");
        assert_eq!(
            super::shortcut_descriptions("fr"),
            [
                "Capturer",
                "Suspendre/Reprendre l’enregistrement",
                "Arrêter l’enregistrement"
            ]
        );
    }

    #[test]
    fn resolves_system_and_saved_languages() {
        for (input, expected) in [
            ("zh_TW", "zh-Hant"),
            ("zh-Hant-HK", "zh-Hant"),
            ("zh-Hans-TW", "zh-Hans"),
            ("zh-Hans-HK", "zh-Hans"),
            ("zh-Hant-CN", "zh-Hant"),
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
