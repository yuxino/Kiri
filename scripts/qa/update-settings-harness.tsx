// Isolated UI review: real settings, styles and translations, with no updater,
// clipboard, filesystem or user-library side effects. Not a production entry.
import {useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import {mockIPC, mockWindows} from "@tauri-apps/api/mocks";
import {SettingsView} from "../../src/settings/SettingsView";
import {stateDetails, type AppUpdater} from "../../src/settings/useAppUpdater";
import {isLanguage, setLanguage, t} from "../../src/i18n";
import brandIcon from "../../src-tauri/icons/128x128.png";
import "../../src/styles/design-system.css";

const params = new URLSearchParams(location.search);
const platform = params.get("platform") || "macos";
const isWindows = platform === "windows" || platform === "portable";
const language = params.get("lang") || "zh-Hans";
if (isLanguage(language)) setLanguage(language);
const english = [
  "Improve scrolling-capture startup compatibility on Windows.",
  "Restore focus to the original app after canceling or completing a capture.",
  "Keep long pinned screenshots readable, with zoom and scrolling controls.",
];
const chinese = [
  "改善 Windows 上滚动截图的启动兼容性。",
  "取消或完成截图后，恢复原应用的焦点。",
  "优化长截图置顶显示，支持缩放和滚动查看。",
];
const longNotes = params.get("notes") === "long";
const list = (items: string[]) => (longNotes ? [...items, ...items, ...items, ...items] : items)
  .map(item => `- ${item}`).join("\n");
const notes = params.get("notes") === "empty" ? null
  : params.get("notes") === "code" ? `## English\n\nUse the signed \`Kiri.dmg\` package.\n\n\`\`\`text\nSHA256: ${"0123456789abcdef".repeat(12)}\n\`\`\`\n\n## 中文\n\n使用已签名的 \`Kiri.dmg\` 安装包。\n\n\`\`\`text\nSHA256: ${"0123456789abcdef".repeat(12)}\n\`\`\``
  : `## English\n\n${list(english)}\n\n### Installation\n\nDownload and install are separate actions. Restart Kiri when ready.\n\n## 中文\n\n${list(chinese)}\n\n### 安装说明\n\n下载、安装与重启均由你手动确认。`;

type UpdateState = AppUpdater["updateState"];
const makeState = (kind: string): UpdateState => {
  const details = {version: "1.6.30", notes};
  switch (kind) {
    case "idle": case "checking": case "upToDate": return {kind};
    case "available": case "verifying": case "downloaded":
    case "readyToRestart": case "relaunching": return {kind, ...details};
    case "downloading": return {kind, ...details, downloaded: 37 * 1024 ** 2, total: 62 * 1024 ** 2};
    case "unknownDownload": return {kind: "downloading", ...details, downloaded: 37 * 1024 ** 2};
    case "installing": return {kind, ...details, isWindows};
    case "error": return {kind, action: "install", details};
    default: throw new Error(`Unknown update QA state: ${kind}`);
  }
};
const qa = {
  calls: [] as Array<{command: string; payload?: unknown}>,
  setState: (_kind: string) => {},
  setLanguage: (next: string) => {if (isLanguage(next)) setLanguage(next);},
};
Object.assign(window, {__updateSettingsQa: qa});
mockWindows("main");
mockIPC((command, payload) => {
  switch (command) {
    case "get_ocr_provider_settings": return {schemaVersion: 1, activeEngine: {kind: "local"}, profiles: []};
    case "get_dock_visibility": return {supported: platform === "macos", visible: true};
    case "get_startup_settings": return {supported: true, enabled: false};
    case "get_library_status": return {availability: "ready", isDefault: true, locationLabel: "QA library"};
    case "copy_support_info": case "open_support_folder": case "open_project_page":
      qa.calls.push({command, payload}); return;
    default:
      if (command.startsWith("plugin:event|") || command.startsWith("plugin:window|")) return;
      throw new Error(`Unexpected isolated update-settings command: ${command}`);
  }
}, {shouldMockEvents: true});

function UpdateSettingsHarness() {
  const [updateState, setUpdateState] = useState(() => makeState(params.get("state") || "downloaded"));
  const [, renderLanguage] = useState(0);
  qa.setState = kind => setUpdateState(makeState(kind));
  qa.setLanguage = next => {
    if (!isLanguage(next)) throw new Error(`Unknown QA language: ${next}`);
    setLanguage(next); renderLanguage(value => value + 1);
  };
  useEffect(() => {
    // Idle/manual routes start on General in the real app. Review About here.
    document.getElementById("settings-tab-about")?.click();
  }, []);
  const action = async (command: string, next?: string) => {
    qa.calls.push({command});
    if (next) setUpdateState(makeState(next));
  };
  const updater: AppUpdater = {
    currentVersion: "1.6.29", isWindows, isPortable: platform === "portable",
    manualUpdates: platform === "linux", updateState, hasUpdate: stateDetails(updateState) !== null,
    checkForUpdates: async () => action("checkForUpdates", "upToDate"),
    downloadUpdate: async () => action("downloadUpdate", "downloading"),
    installUpdate: async () => action("installUpdate", isWindows ? "installing" : "readyToRestart"),
    restartUpdatedApp: async () => action("restartUpdatedApp", "relaunching"),
    openRecoveryPage: async () => action("openRecoveryPage"),
  };
  return <div className="library-root kiri-canvas-surface">
    <aside className="library-sidebar" aria-hidden="true">
      <div className="library-sidebar__brand"><img src={brandIcon} alt=""/><strong>kiri</strong></div>
      <span style={{marginTop: "auto", padding: "10px"}}>{t("Settings")}</span>
    </aside>
    <div className="library-workspace">
      <header className="library-control-panel library-control-panel--settings">
        <div className="library-control-panel__primary"><div className="library-control-panel__titles">
          <h1 className="library-control-panel__title">{t("Settings")}</h1>
        </div></div>
      </header>
      <SettingsView updater={updater}/>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<UpdateSettingsHarness/>);
