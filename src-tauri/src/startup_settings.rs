//! Explicit, OS-owned login startup. Merely launching Kiri never registers it.
use tauri::WebviewWindow;

const LOAD_ERROR: &str = "Couldn't load startup settings.";
const CHANGE_ERROR: &str = "Couldn't change startup settings.";
const OPEN_ERROR: &str = "Couldn't open system startup settings.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSettingsDto {
    pub supported: bool,
    pub enabled: bool,
    pub requires_approval: bool,
}

impl StartupSettingsDto {
    fn supported(enabled: bool, requires_approval: bool) -> Self {
        Self {
            supported: true,
            enabled,
            requires_approval,
        }
    }

    #[cfg(any(target_os = "macos", not(any(windows, target_os = "linux"))))]
    fn unavailable() -> Self {
        Self {
            supported: false,
            enabled: false,
            requires_approval: false,
        }
    }
}

fn library_owner(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "library" {
        return Err("Startup settings are only available in Settings.".into());
    }
    Ok(())
}

fn report<T>(result: Result<T, String>, message: &str) -> Result<T, String> {
    result.map_err(|error| {
        log::warn!("[startup] {message} {error}");
        message.to_string()
    })
}

#[tauri::command]
pub fn get_startup_settings(window: WebviewWindow) -> Result<StartupSettingsDto, String> {
    library_owner(&window)?;
    report(native::get(), LOAD_ERROR)
}

#[tauri::command]
pub fn set_startup_enabled(
    window: WebviewWindow,
    enabled: bool,
) -> Result<StartupSettingsDto, String> {
    library_owner(&window)?;
    report(native::set(enabled), CHANGE_ERROR)
}

#[tauri::command]
pub fn open_system_startup_settings(window: WebviewWindow) -> Result<(), String> {
    library_owner(&window)?;
    report(native::open_settings(), OPEN_ERROR)
}

pub fn has_autostart_arg(args: &[String]) -> bool {
    args.iter()
        .skip(1)
        .any(|argument| argument == "--autostart")
}

/// Call during setup, while macOS is still handling its launch AppleEvent.
/// Subsequent single-instance requests must use `has_autostart_arg` instead.
pub fn is_autostart_launch(args: &[String]) -> bool {
    if has_autostart_arg(args) {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        native::is_login_launch()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::StartupSettingsDto;
    extern "C" {
        fn kiri_startup_status() -> i32;
        fn kiri_startup_set_enabled(enabled: bool) -> i32;
        fn kiri_startup_open_settings() -> bool;
        fn kiri_startup_is_login_launch() -> bool;
    }

    fn status(value: i32) -> Result<StartupSettingsDto, String> {
        match value {
            -1 => Ok(StartupSettingsDto::unavailable()),
            0 => Ok(StartupSettingsDto::supported(false, false)),
            1 => Ok(StartupSettingsDto::supported(true, false)),
            2 => Ok(StartupSettingsDto::supported(false, true)),
            other => Err(format!("ServiceManagement returned status {other}")),
        }
    }

    pub fn get() -> Result<StartupSettingsDto, String> {
        status(unsafe { kiri_startup_status() })
    }

    pub fn set(enabled: bool) -> Result<StartupSettingsDto, String> {
        status(unsafe { kiri_startup_set_enabled(enabled) })
    }

    pub fn open_settings() -> Result<(), String> {
        if unsafe { kiri_startup_open_settings() } {
            Ok(())
        } else {
            Err("This process is not an installed Kiri app bundle".into())
        }
    }

    pub fn is_login_launch() -> bool {
        unsafe { kiri_startup_is_login_launch() }
    }
}

#[cfg(any(windows, test))]
fn windows_approval_required(value: Option<&[u8]>) -> Result<bool, String> {
    let Some(bytes) = value else {
        return Ok(false);
    };
    if bytes.len() != 12 {
        return Err("Invalid StartupApproved value length".into());
    }
    let state = u32::from_le_bytes(bytes[..4].try_into().unwrap());
    // StartupApproved is shell-owned. Unknown states must not be reported on.
    match state {
        0 | 2 | 6 => Ok(false),
        3 | 7 => Ok(true),
        _ => Err(format!("Unknown StartupApproved state {state}")),
    }
}

#[cfg(windows)]
mod native {
    use super::{windows_approval_required, StartupSettingsDto};
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w, PCWSTR};
    use windows::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegDeleteKeyValueW, RegGetValueW, RegSetValueExW, HKEY,
            HKEY_CURRENT_USER, KEY_SET_VALUE, REG_BINARY, REG_OPTION_NON_VOLATILE, REG_SZ,
            REG_VALUE_TYPE, RRF_RT_ANY,
        },
    };

    const RUN: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    const APPROVED: PCWSTR =
        w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run");
    const VALUE: PCWSTR = w!("io.yuxino.kiri");

    fn read(subkey: PCWSTR, expected: REG_VALUE_TYPE) -> Result<Option<Vec<u8>>, String> {
        let mut kind = REG_VALUE_TYPE::default();
        let mut size = 0;
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey,
                VALUE,
                RRF_RT_ANY,
                Some(&mut kind),
                None,
                Some(&mut size),
            )
        };
        if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND {
            return Ok(None);
        }
        if result != ERROR_SUCCESS {
            return Err(format!(
                "Could not inspect startup registry value: {result:?}"
            ));
        }
        if kind != expected || size > 65536 {
            return Err("Invalid startup registry value".into());
        }
        let mut bytes = vec![0u8; size as usize];
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey,
                VALUE,
                RRF_RT_ANY,
                Some(&mut kind),
                Some(bytes.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if result != ERROR_SUCCESS || kind != expected {
            return Err(format!("Could not read startup registry value: {result:?}"));
        }
        bytes.truncate(size as usize);
        Ok(Some(bytes))
    }

    fn command() -> Result<Vec<u16>, String> {
        let path = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command: Vec<u16> = vec![b'"' as u16];
        command.extend(path.as_os_str().encode_wide());
        command.extend("\" --autostart".encode_utf16());
        // Run values have a documented 260-character command-line limit.
        if command.len() > 260 {
            return Err("The startup executable path is too long".into());
        }
        command.push(0);
        Ok(command)
    }

    pub fn get() -> Result<StartupSettingsDto, String> {
        let Some(bytes) = read(RUN, REG_SZ)? else {
            return Ok(StartupSettingsDto::supported(false, false));
        };
        if bytes.len() % 2 != 0 {
            return Err("Invalid startup registry command".into());
        }
        let registered = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let matches = registered == command()?;
        let approval = read(APPROVED, REG_BINARY)?;
        let requires_approval = matches && windows_approval_required(approval.as_deref())?;
        Ok(StartupSettingsDto::supported(
            matches && !requires_approval,
            requires_approval,
        ))
    }

    pub fn set(enabled: bool) -> Result<StartupSettingsDto, String> {
        if enabled {
            // Never write StartupApproved: OS/user denial must remain in force.
            let command = command()?;
            let bytes = command
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>();
            let mut key = HKEY::default();
            let result = unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    RUN,
                    None,
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_SET_VALUE,
                    None,
                    &mut key,
                    None,
                )
            };
            if result != ERROR_SUCCESS {
                return Err(format!("Could not open startup registry key: {result:?}"));
            }
            let result = unsafe { RegSetValueExW(key, VALUE, None, REG_SZ, Some(&bytes)) };
            unsafe {
                let _ = RegCloseKey(key);
            }
            if result != ERROR_SUCCESS {
                return Err(format!("Could not save startup registry value: {result:?}"));
            }
        } else {
            let result = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN, VALUE) };
            if result != ERROR_SUCCESS
                && result != ERROR_FILE_NOT_FOUND
                && result != ERROR_PATH_NOT_FOUND
            {
                return Err(format!(
                    "Could not remove startup registry value: {result:?}"
                ));
            }
        }
        get()
    }

    pub fn open_settings() -> Result<(), String> {
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:startupapps")
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[cfg(any(target_os = "linux", all(test, unix)))]
mod linux_entry {
    use super::StartupSettingsDto;
    use std::{
        io::Write,
        path::{Path, PathBuf},
    };

    const FILE_NAME: &str = "io.yuxino.kiri.desktop";
    const OWNER: &str = "X-Kiri-Autostart";
    const MAX_ENTRY_SIZE: u64 = 65536;

    fn entry_path(config: &Path) -> PathBuf {
        config.join("autostart").join(FILE_NAME)
    }

    // Desktop Exec escaping has two layers: the string value, then the quoted
    // executable argument. Percent signs must be doubled to avoid field codes.
    fn exec_value(executable: &Path) -> Result<String, String> {
        let value = executable
            .to_str()
            .ok_or("The startup path is not valid UTF-8")?;
        if !executable.is_absolute() || value.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
            return Err("Invalid startup executable path".into());
        }
        let mut quoted = String::from("\"");
        for ch in value.chars() {
            match ch {
                '\\' => quoted.push_str("\\\\\\\\"),
                '"' => quoted.push_str("\\\\\""),
                '$' | '`' => {
                    quoted.push_str("\\\\");
                    quoted.push(ch);
                }
                '%' => quoted.push_str("%%"),
                _ => quoted.push(ch),
            }
        }
        quoted.push_str("\" --autostart");
        Ok(quoted)
    }

    fn render(executable: &Path, enabled: bool) -> Result<String, String> {
        Ok(format!("[Desktop Entry]\nType=Application\nName=Kiri\nExec={}\nTerminal=false\nHidden={}\n{OWNER}=true\n", exec_value(executable)?, !enabled))
    }

    fn read(config: &Path) -> Result<Option<String>, String> {
        let path = entry_path(config);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.is_file() || metadata.len() > MAX_ENTRY_SIZE {
            return Err("The startup entry is not a regular, bounded file".into());
        }
        std::fs::read_to_string(path)
            .map(Some)
            .map_err(|error| error.to_string())
    }

    fn values(text: &str) -> Result<std::collections::HashMap<&str, &str>, String> {
        let mut in_entry = false;
        let mut values = std::collections::HashMap::new();
        for line in text.lines().map(str::trim) {
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if line.starts_with('[') {
                in_entry = line == "[Desktop Entry]";
                continue;
            }
            if !in_entry {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                return Err("Invalid startup desktop entry".into());
            };
            if values.insert(key.trim(), value.trim()).is_some() {
                return Err("Duplicate startup desktop entry key".into());
            }
        }
        if values.get(OWNER) != Some(&"true") {
            return Err("The startup entry is not managed by Kiri".into());
        }
        Ok(values)
    }

    pub fn get(
        config: &Path,
        executable: &Path,
        desktops: &str,
    ) -> Result<StartupSettingsDto, String> {
        let Some(text) = read(config)? else {
            return Ok(StartupSettingsDto::supported(false, false));
        };
        let values = values(&text)?;
        let allowed = |list: &&str| {
            list.split(';')
                .any(|item| !item.is_empty() && desktops.split(':').any(|desktop| desktop == item))
        };
        let enabled = values.get("Type") == Some(&"Application")
            && values
                .get("Exec")
                .is_some_and(|value| *value == exec_value(executable).unwrap_or_default())
            && values.get("Hidden") != Some(&"true")
            && values.get("X-GNOME-Autostart-enabled") != Some(&"false")
            && values.get("OnlyShowIn").is_none_or(allowed)
            && values.get("NotShowIn").is_none_or(|list| !allowed(list));
        Ok(StartupSettingsDto::supported(enabled, false))
    }

    pub fn set(
        config: &Path,
        executable: &Path,
        enabled: bool,
        desktops: &str,
    ) -> Result<StartupSettingsDto, String> {
        let previous = read(config)?;
        if let Some(text) = &previous {
            values(text)?;
        }
        if !enabled && previous.is_none() {
            return get(config, executable, desktops);
        }
        let path = entry_path(config);
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        file.write_all(render(executable, enabled)?.as_bytes())
            .map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        file.persist(path).map_err(|error| error.to_string())?;
        get(config, executable, desktops)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn querying_and_disabling_an_absent_entry_do_not_create_files() {
            let dir = tempfile::tempdir().unwrap();
            let exe = Path::new("/opt/Kiri App/kiri");
            assert!(!get(dir.path(), exe, "GNOME").unwrap().enabled);
            assert!(!set(dir.path(), exe, false, "GNOME").unwrap().enabled);
            assert!(!entry_path(dir.path()).exists());
        }

        #[test]
        fn explicit_toggle_round_trips_and_preserves_external_entries() {
            let dir = tempfile::tempdir().unwrap();
            let exe = Path::new("/opt/Kiri App/kiri");
            assert!(set(dir.path(), exe, true, "GNOME").unwrap().enabled);
            assert!(!set(dir.path(), exe, false, "GNOME").unwrap().enabled);
            assert!(std::fs::read_to_string(entry_path(dir.path()))
                .unwrap()
                .contains("Hidden=true"));
            assert!(set(dir.path(), exe, true, "GNOME").unwrap().enabled);
            std::fs::write(entry_path(dir.path()), "[Desktop Entry]\nName=User entry\n").unwrap();
            assert!(set(dir.path(), exe, true, "GNOME").is_err());
            assert!(std::fs::read_to_string(entry_path(dir.path()))
                .unwrap()
                .contains("User entry"));
        }

        #[test]
        fn external_desktop_disables_are_read_without_rewriting() {
            let dir = tempfile::tempdir().unwrap();
            let exe = Path::new("/usr/bin/kiri");
            set(dir.path(), exe, true, "GNOME").unwrap();
            let path = entry_path(dir.path());
            for suffix in [
                "Hidden=true\n",
                "X-GNOME-Autostart-enabled=false\n",
                "OnlyShowIn=KDE;\n",
                "NotShowIn=GNOME;\n",
            ] {
                let mut text = render(exe, true).unwrap().replace("Hidden=false\n", "");
                text.push_str(suffix);
                std::fs::write(&path, &text).unwrap();
                assert!(
                    !get(dir.path(), exe, "ubuntu:GNOME").unwrap().enabled,
                    "{suffix}"
                );
                assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
            }
        }

        #[test]
        fn quoting_protects_exec_field_codes_and_reserved_characters() {
            assert_eq!(
                exec_value(Path::new("/opt/Kiri App/100%/kiri")).unwrap(),
                "\"/opt/Kiri App/100%%/kiri\" --autostart"
            );
            assert_eq!(
                exec_value(Path::new("/opt/a\\b\"$`/kiri")).unwrap(),
                "\"/opt/a\\\\\\\\b\\\\\"\\\\$\\\\`/kiri\" --autostart"
            );
            for invalid in [
                "relative/kiri",
                "/opt/line\nbreak/kiri",
                "/opt/line\rbreak/kiri",
            ] {
                assert!(exec_value(Path::new(invalid)).is_err());
            }
        }

        #[test]
        fn an_old_executable_path_is_not_claimed_as_enabled_for_a_moved_copy() {
            let dir = tempfile::tempdir().unwrap();
            set(dir.path(), Path::new("/opt/old/kiri"), true, "GNOME").unwrap();
            assert!(
                !get(dir.path(), Path::new("/opt/new/kiri"), "GNOME")
                    .unwrap()
                    .enabled
            );
        }

        #[cfg(unix)]
        #[test]
        fn refuses_a_symlink_instead_of_replacing_user_managed_content() {
            let dir = tempfile::tempdir().unwrap();
            let target = dir.path().join("external.desktop");
            std::fs::write(&target, "keep").unwrap();
            std::fs::create_dir_all(dir.path().join("autostart")).unwrap();
            std::os::unix::fs::symlink(&target, entry_path(dir.path())).unwrap();
            assert!(set(dir.path(), Path::new("/usr/bin/kiri"), true, "GNOME").is_err());
            assert_eq!(std::fs::read_to_string(target).unwrap(), "keep");
        }
    }
}

#[cfg(target_os = "linux")]
mod native {
    use super::{linux_entry, StartupSettingsDto};

    fn environment() -> Result<(std::path::PathBuf, std::path::PathBuf, String), String> {
        let config = dirs::config_dir().ok_or("The configuration directory is unavailable")?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let desktops = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
        Ok((config, executable, desktops))
    }
    pub fn get() -> Result<StartupSettingsDto, String> {
        let (config, executable, desktops) = environment()?;
        linux_entry::get(&config, &executable, &desktops)
    }
    pub fn set(enabled: bool) -> Result<StartupSettingsDto, String> {
        let (config, executable, desktops) = environment()?;
        linux_entry::set(&config, &executable, enabled, &desktops)
    }
    pub fn open_settings() -> Result<(), String> {
        std::process::Command::new("gnome-session-properties")
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod native {
    use super::StartupSettingsDto;
    pub fn get() -> Result<StartupSettingsDto, String> {
        Ok(StartupSettingsDto::unavailable())
    }
    pub fn set(_enabled: bool) -> Result<StartupSettingsDto, String> {
        Err("Unsupported startup platform".into())
    }
    pub fn open_settings() -> Result<(), String> {
        Err("Unsupported startup platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn autostart_requires_an_exact_option_after_the_program_name() {
        for args in [
            vec!["kiri"],
            vec!["--autostart"],
            vec!["kiri", "--autostart=false"],
            vec!["kiri", "prefix--autostart"],
        ] {
            assert!(!has_autostart_arg(
                &args.into_iter().map(str::to_string).collect::<Vec<_>>()
            ));
        }
        assert!(has_autostart_arg(&["kiri".into(), "--autostart".into()]));
    }
    #[test]
    fn shell_disabled_startup_is_distinct_from_a_missing_approval_record() {
        assert!(!windows_approval_required(None).unwrap());
        for state in [0u32, 2, 6] {
            let mut bytes = [0u8; 12];
            bytes[..4].copy_from_slice(&state.to_le_bytes());
            assert!(!windows_approval_required(Some(&bytes)).unwrap());
        }
        for state in [3u32, 7] {
            let mut bytes = [0u8; 12];
            bytes[..4].copy_from_slice(&state.to_le_bytes());
            assert!(windows_approval_required(Some(&bytes)).unwrap());
        }
        assert!(windows_approval_required(Some(&[2])).is_err());
        assert!(windows_approval_required(Some(&[255; 12])).is_err());
    }
}
