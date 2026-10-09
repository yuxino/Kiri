import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles/design-system.css";
import { getLanguage, isLanguage, onLanguageChange, setLanguage } from "./i18n";
import { initializeLanguage } from "./i18n/language-sync";
import { configureVideoPlaybackOrigin } from "./lib/kiri-resource-url.js";

const OverlayWindow = React.lazy(() =>
  import("./windows/OverlayWindow").then((module) => ({ default: module.OverlayWindow })),
);
const LibraryWindow = React.lazy(() =>
  import("./windows/LibraryWindow").then((module) => ({ default: module.LibraryWindow })),
);
const CountdownWindow = React.lazy(() =>
  import("./windows/CountdownWindow").then((module) => ({ default: module.CountdownWindow })),
);
const ControlPanelWindow = React.lazy(() =>
  import("./windows/ControlPanelWindow").then((module) => ({
    default: module.ControlPanelWindow,
  })),
);
const RippleWindow = React.lazy(() =>
  import("./windows/RippleWindow").then((module) => ({ default: module.RippleWindow })),
);
const EditorWindow = React.lazy(() =>
  import("./windows/EditorWindow").then((module) => ({ default: module.EditorWindow })),
);
const ViewerWindow = React.lazy(() =>
  import("./windows/ViewerWindow").then((module) => ({ default: module.ViewerWindow })),
);
const PinWindow = React.lazy(() =>
  import("./windows/PinWindow").then((module) => ({ default: module.PinWindow })),
);
const ToastWindow = React.lazy(() =>
  import("./windows/ToastWindow").then((module) => ({ default: module.ToastWindow })),
);
const ConfirmWindow = React.lazy(() =>
  import("./windows/ConfirmWindow").then((module) => ({ default: module.ConfirmWindow })),
);

// Resolve the UI language at startup: a manually chosen language persisted
// by the backend (language.json in the app config dir) wins; otherwise fall
// back to the real system locale via get_locale (the WebView's
// navigator.language is fixed to en in Tauri, so it cannot be trusted).
// The choice is shared across all windows and survives relaunches.
void initializeLanguage({
  subscribe: async (change) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<string>("language-changed", ({ payload }) => change(payload));
  },
  getSaved: () => invoke<string>("get_language"),
  getLocale: () => invoke<string>("get_locale"),
  accept: (language) => {
    if (!isLanguage(language)) return false;
    setLanguage(language);
    return true;
  },
});

// Forward renderer failures to the bounded Rust error log. Production windows
// must not mutate their title or inject a debug overlay.
function installErrorReporting() {
  const report = (message: string) => {
    void invoke("log_frontend_error", { message: message.slice(0, 2000) }).catch(() => {});
  };
  window.addEventListener("error", (event) => {
    report(`window.onerror: ${event.message}\n${event.filename ?? ""}:${event.lineno ?? 0}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
    report(`unhandledrejection: ${message}`);
  });
}
installErrorReporting();

function resolveWindow(): { kind: string; params: URLSearchParams } {
  const params = new URLSearchParams(window.location.search);
  return { kind: params.get("window") ?? "library", params };
}

function App() {
  const { kind, params } = resolveWindow();
  // Re-render when the UI language resolves/changes (system locale arrives
  // asynchronously from the backend).
  React.useSyncExternalStore(onLanguageChange, getLanguage);
  switch (kind) {
    case "overlay":
      return <OverlayWindow />;
    case "countdown":
      return <CountdownWindow />;
    case "control-panel":
      return <ControlPanelWindow />;
    case "ripple":
      return <RippleWindow />;
    case "editor":
      return <EditorWindow id={params.get("id") ?? ""} />;
    case "viewer":
      return <ViewerWindow id={params.get("id") ?? ""} />;
    case "pin":
      return <PinWindow id={params.get("id") ?? ""} />;
    case "toast":
      return (
        <ToastWindow
          title={params.get("title") ?? undefined}
          symbol={params.get("symbol") ?? undefined}
        />
      );
    case "confirm":
      return (
        <ConfirmWindow
          kind={params.get("kind") ?? ""}
          title={params.get("title") ?? ""}
          message={params.get("message") ?? ""}
          confirmLabel={params.get("confirmLabel") ?? ""}
          ids={params.get("ids")?.split(",").filter(Boolean)}
          localize={params.get("localize") === "1"}
        />
      );
    default:
      return <LibraryWindow />;
  }
}

function render() {
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense fallback={null}>
      <App />
    </React.Suspense>
  </React.StrictMode>,
);
}

const { kind } = resolveWindow();
if (kind === "library" || kind === "viewer" || kind === "toast") {
  // Only Linux returns an HTTP capability. Resolve it before any video mounts
  // so WebKitGTK never attempts to decode an unsupported custom URI first.
  void invoke<string | null>("get_media_playback_origin")
    .then(configureVideoPlaybackOrigin)
    .catch(() => {})
    .finally(render);
} else {
  render();
}
