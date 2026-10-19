// Real settings, dictionaries and CSS; only Tauri and the surrounding window
// shell are isolated. This entry never reaches the production import graph.
import React from "react";
import {createRoot} from "react-dom/client";
import {mockIPC, mockWindows} from "@tauri-apps/api/mocks";
import {emit} from "@tauri-apps/api/event";
import {SettingsView} from "../../src/settings/SettingsView";
import type {AppUpdater} from "../../src/settings/useAppUpdater";
import type {ShortcutAction, ShortcutSettingDto} from "../../src/lib/ipc";
import {isLanguage, setLanguage, t} from "../../src/i18n";
import brandIcon from "../../src-tauri/icons/128x128.png";
import "../../src/styles/design-system.css";

const params = new URLSearchParams(location.search);
const platform = params.get("platform") || "macos";
const mac = platform === "macos", wayland = platform === "wayland";
const language = params.get("lang") || "en";
if (isLanguage(language)) setLanguage(language);
const zoom = Number(params.get("zoom")) || 1;
document.body.style.zoom = String(zoom);
// WebKit resolves vh through CSS zoom while Chromium does not. Explicit
// logical pixels keep the isolated window height consistent in either engine.
document.getElementById("root")!.style.height = `${innerHeight / zoom}px`;
const actions: ShortcutAction[] = ["capture", "record", "ocr", "library", "recordingPauseResume", "recordingStop"];
const keys = ["A", "R", "O", "L", "P", "S"];
let settings: ShortcutSettingDto[] = actions.map((action, index) => {
  const scope = index < 4 ? "global" : "recording";
  const defaultLabel = mac ? `⇧${index ? "⌥" : ""}⌘${keys[index]}` : `Shift+Ctrl+${index ? "Alt+" : ""}${keys[index]}`;
  return {action, scope, label: wayland ? null : defaultLabel, defaultLabel,
    status: wayland ? "systemManaged" : scope === "recording" ? "inactive" : "enabled", isDefault: true};
});
const snapshot = () => settings.map(setting => ({...setting}));
const label = (shortcut: string) => {
  const modifiers = [["Shift", "⇧", "Shift"], ["Control", "⌃", "Ctrl"], ["Alt", "⌥", "Alt"], ["Super", "⌘", "Win"]];
  const parts = shortcut.split("+");
  // Match shortcut_settings.rs::key_label. These are native key names rather
  // than localized prose; long names are essential clipping test fixtures.
  const keyNames: Record<string, string> = {
    Backquote: "`", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Comma: ",", Equal: "=", Minus: "-",
    Period: ".", Quote: "'", Semicolon: ";", Slash: "/", Escape: "Esc", CapsLock: "Caps Lock", PageDown: "Page Down",
    PageUp: "Page Up", PrintScreen: "Print Screen", ScrollLock: "Scroll Lock", NumLock: "Num Lock",
    ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", NumpadAdd: "Num +", NumpadDecimal: "Num .",
    NumpadDivide: "Num /", NumpadEnter: "Num Enter", NumpadEqual: "Num =", NumpadMultiply: "Num *", NumpadSubtract: "Num -",
    AudioVolumeDown: "Volume Down", AudioVolumeUp: "Volume Up", AudioVolumeMute: "Mute", MediaPlay: "Media Play",
    MediaPause: "Media Pause", MediaPlayPause: "Play/Pause", MediaStop: "Media Stop", MediaTrackNext: "Next Track",
    MediaTrackPrevious: "Previous Track",
    ...(mac ? {Backspace: "⌫", Delete: "⌦", Enter: "↩", Tab: "⇥"} : {}),
  };
  const code = parts.at(-1)!;
  const key = keyNames[code] ?? code.replace(/^(Key|Digit)/, "").replace(/^Numpad/, "Num ");
  return [...modifiers.filter(([name]) => parts.includes(name)).map(tokens => tokens[mac ? 1 : 2]),
    key].join(mac ? "" : "+");
};
const qa = {
  editing: false,
  failNext: "",
  calls: [] as Array<{command: string; payload: unknown}>,
  snapshot,
  async status(action: ShortcutAction, status: ShortcutSettingDto["status"]) {
    settings = settings.map(setting => setting.action === action ? {...setting, status} : setting);
    await emit("shortcut-settings-changed", snapshot());
  },
};
Object.assign(window, {__shortcutSettingsQa: qa});
mockWindows("main");
mockIPC((command, payload) => {
  const data = payload as {action?: ShortcutAction; shortcut?: string | null; editing?: boolean};
  if (["set_action_shortcut", "reset_action_shortcut", "retry_action_shortcut"].includes(command)) {
    qa.calls.push({command, payload});
    if (qa.failNext) {const failure = qa.failNext; qa.failNext = ""; throw failure;}
    settings = settings.map(setting => {
      if (setting.action !== data.action) return setting;
      const nextLabel = command === "reset_action_shortcut" ? setting.defaultLabel
        : command === "retry_action_shortcut" ? setting.label : data.shortcut ? label(data.shortcut) : null;
      return {...setting, label: nextLabel, isDefault: nextLabel === setting.defaultLabel,
        status: nextLabel === null ? "disabled" : setting.scope === "recording" ? "inactive" : "enabled"};
    });
    return snapshot();
  }
  switch (command) {
    case "get_shortcut_settings": return snapshot();
    case "set_capture_shortcut_editing": qa.editing = !!data.editing; return;
    case "get_ocr_provider_settings": return {schemaVersion: 1, activeEngine: {kind: "local"}, profiles: []};
    case "get_dock_visibility": return {supported: mac, visible: true};
    case "get_library_status": return {availability: "ready", isDefault: true, locationLabel: "QA library"};
    case "get_portal_shortcuts": case "update_portal_shortcuts": return {status: "unavailable", revision: 1, bindings: [], canConfigure: false};
    default:
      if (command.startsWith("plugin:event|") || command.startsWith("plugin:window|")) return;
      throw new Error(`Unexpected isolated settings command: ${command}`);
  }
}, {shouldMockEvents: true});
const noop = async () => {};
const updater: AppUpdater = {currentVersion: "1.0.0", isWindows: platform === "windows", isPortable: false,
  manualUpdates: platform === "linux" || wayland, updateState: {kind: "idle"}, hasUpdate: false,
  checkForUpdates: noop, downloadUpdate: noop, installUpdate: noop, restartUpdatedApp: noop, openRecoveryPage: noop};

createRoot(document.getElementById("root")!).render(
  <div className="library-root kiri-canvas-surface">
    <aside className="library-sidebar" aria-hidden="true">
      <div className="library-sidebar__brand"><img src={brandIcon} alt=""/><strong>kiri</strong></div>
      <span>{t("Settings")}</span>
    </aside>
    <div className="library-workspace">
      <header className="library-control-panel library-control-panel--settings">
        <div className="library-control-panel__primary"><div className="library-control-panel__titles">
          <h1 className="library-control-panel__title">{t("Settings")}</h1>
        </div></div>
      </header>
      <SettingsView updater={updater}/>
    </div>
  </div>,
);
