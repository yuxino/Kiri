//! Explicit, local support information. Never include paths, identities or captures.

pub struct DisplayInfo {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

pub fn report(version: &str, language: &str, displays: Option<&[DisplayInfo]>) -> String {
    let mut text = format!(
        "Kiri: {}\nOS: {}\nArchitecture: {}\nBuild: {}\nPackage: {}\nLanguage: {}\n",
        line(version),
        line(&os_version()),
        std::env::consts::ARCH,
        if cfg!(debug_assertions) {
            "development"
        } else {
            "release"
        },
        package_kind(),
        line(language),
    );
    #[cfg(target_os = "linux")]
    text.push_str(if crate::platform::linux::is_wayland_session() {
        "Session: Wayland\n"
    } else {
        "Session: X11\n"
    });
    match displays {
        Some(displays) => {
            text.push_str(&format!("Displays: {}\n", displays.len()));
            for (index, display) in displays.iter().enumerate() {
                let scale = if display.scale.is_finite() && display.scale > 0.0 {
                    format!("{:.0}%", display.scale * 100.0)
                } else {
                    "unknown".into()
                };
                text.push_str(&format!(
                    "  {}: {} × {} px, scale {}\n",
                    index + 1,
                    display.width,
                    display.height,
                    scale
                ));
            }
        }
        None => text.push_str("Displays: unavailable\n"),
    }
    text
}

fn line(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(256)
        .collect()
}

fn package_kind() -> &'static str {
    #[cfg(windows)]
    {
        if crate::updates::is_portable_build() {
            "Windows portable"
        } else {
            "Windows app"
        }
    }
    #[cfg(target_os = "macos")]
    {
        "macOS app"
    }
    #[cfg(target_os = "linux")]
    {
        "Linux app"
    }
}

#[cfg(target_os = "macos")]
fn os_version() -> String {
    let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
    format!(
        "macOS {}.{}.{}",
        version.majorVersion, version.minorVersion, version.patchVersion
    )
}

#[cfg(windows)]
fn os_version() -> String {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // RtlGetVersion reports the real build rather than the compatibility-manifest version.
    if unsafe { RtlGetVersion(&mut version) }.is_ok() {
        format!(
            "Windows {}.{}.{}",
            version.dwMajorVersion, version.dwMinorVersion, version.dwBuildNumber
        )
    } else {
        "Windows (version unavailable)".into()
    }
}

#[cfg(target_os = "linux")]
fn os_version() -> String {
    std::fs::read_to_string("/etc/os-release")
        .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
        .ok()
        .and_then(|release| linux_release_name(&release))
        .unwrap_or_else(|| "Linux (version unavailable)".into())
}

#[cfg(any(target_os = "linux", test))]
fn linux_release_name(release: &str) -> Option<String> {
    release.lines().find_map(|entry| {
        let (key, value) = entry.split_once('=')?;
        if key != "PRETTY_NAME" {
            return None;
        }
        let value = line(value.trim().trim_matches(['\"', '\'']));
        (!value.is_empty()).then_some(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_contains_only_support_fields_and_handles_unavailable_displays() {
        let text = report("1.2.3", "zh-Hans", None);
        assert!(text.contains("Kiri: 1.2.3\n"));
        assert!(text.contains("Language: zh-Hans\n"));
        assert!(text.ends_with("Displays: unavailable\n"));
        assert!(!text.contains("/Users/"));
        assert!(!text.contains("APPDATA"));
    }

    #[test]
    fn report_preserves_mixed_display_scales_without_names_or_locations() {
        let text = report(
            "1.2.3",
            "en",
            Some(&[
                DisplayInfo {
                    width: 1920,
                    height: 1080,
                    scale: 1.0,
                },
                DisplayInfo {
                    width: 3840,
                    height: 2160,
                    scale: 1.5,
                },
                DisplayInfo {
                    width: 100,
                    height: 80,
                    scale: f64::NAN,
                },
            ]),
        );
        assert!(text.contains("2: 3840 × 2160 px, scale 150%"));
        assert!(text.contains("3: 100 × 80 px, scale unknown"));
        assert!(!text.contains("NaN"));
    }

    #[test]
    fn system_metadata_cannot_inject_extra_report_lines() {
        assert_eq!(line("en\nPath: secret\t"), "enPath: secret");
        assert_eq!(line(&"x".repeat(300)).len(), 256);
        assert_eq!(
            linux_release_name("NAME=Ubuntu\nPRETTY_NAME=\"Ubuntu 24.04.3 LTS\"\nHOME=/private"),
            Some("Ubuntu 24.04.3 LTS".into())
        );
        assert_eq!(linux_release_name("NAME=Ubuntu\nPRETTY_NAME=\"\""), None);
    }
}
