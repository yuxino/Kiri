import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { api } from "../lib/ipc";

const UPDATE_CHECK_CACHE_MS = 6 * 60 * 60 * 1000;
const UPDATE_FAILURE_RETRY_MS = 5 * 60 * 1000;

type UpdateDetails = {
  version: string;
  notes: string | null;
};

type UpdateAction = "check" | "download" | "install" | "relaunch" | "open";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | ({ kind: "available" } & UpdateDetails)
  | ({ kind: "downloading"; downloaded: number; total?: number } & UpdateDetails)
  | ({ kind: "verifying" } & UpdateDetails)
  | ({ kind: "downloaded" } & UpdateDetails)
  | ({ kind: "installing"; isWindows: boolean } & UpdateDetails)
  | ({ kind: "readyToRestart" } & UpdateDetails)
  | ({ kind: "relaunching" } & UpdateDetails)
  | ({ kind: "error"; action: UpdateAction; details?: UpdateDetails });

function updateDetails(update: Update): UpdateDetails {
  return {
    version: update.version,
    notes: update.body?.trim() || null,
  };
}

export function useAppUpdater() {
  const [currentVersion, setCurrentVersion] = useState("");
  const isWindows = /Windows/i.test(navigator.userAgent);
  const [isPortable, setIsPortable] = useState<boolean | null>(isWindows ? null : false);
  const [manualUpdates, setManualUpdates] = useState(/Linux/i.test(navigator.userAgent));
  const [platformResolved, setPlatformResolved] = useState(false);
  const lastAutoCheck = useRef<number | null>(null);
  const autoRetryAfter = useRef(UPDATE_CHECK_CACHE_MS);
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  const updateRef = useRef<Update | null>(null);
  const operationRef = useRef(false);
  const mountedRef = useRef(true);

  const finishOperation = () => {
    operationRef.current = false;
    if (!mountedRef.current) {
      const update = updateRef.current;
      updateRef.current = null;
      if (update) void update.close().catch(() => {});
    }
  };

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    void api.platformCapabilities().then(caps => {
      if (active && typeof caps.manualUpdates === "boolean") {
        setManualUpdates(caps.manualUpdates);
        setPlatformResolved(true);
      }
    }).catch(() => {});
    void getVersion()
      .then((version) => {
        if (active) setCurrentVersion(version);
      })
      .catch(() => {});
    if (isWindows) {
      void api.isPortableBuild()
        .then((portable) => { if (active) setIsPortable(portable); })
        .catch(() => { if (active) setIsPortable(true); });
    }
    return () => {
      active = false;
      mountedRef.current = false;
      if (!operationRef.current) {
        const update = updateRef.current;
        updateRef.current = null;
        if (update) void update.close().catch(() => {});
      }
    };
  }, []);

  const checkForUpdates = async (automatic = false) => {
    if (isPortable !== false || manualUpdates) return;
    if (operationRef.current || !mountedRef.current) return;
    const cached = lastAutoCheck.current !== null &&
      Date.now() - lastAutoCheck.current < autoRetryAfter.current;
    if (automatic && (updateRef.current || cached)) return;
    lastAutoCheck.current = Date.now();
    autoRetryAfter.current = UPDATE_CHECK_CACHE_MS;
    operationRef.current = true;
    setUpdateState({ kind: "checking" });
    try {
      const previous = updateRef.current;
      updateRef.current = null;
      if (previous) await previous.close();

      const update = await check({ timeout: 15_000 });
      if (!update) {
        setUpdateState({ kind: "upToDate" });
        return;
      }
      updateRef.current = update;
      setCurrentVersion(update.currentVersion);
      setUpdateState({ kind: "available", ...updateDetails(update) });
    } catch {
      autoRetryAfter.current = UPDATE_FAILURE_RETRY_MS;
      setUpdateState(automatic ? { kind: "idle" } : { kind: "error", action: "check" });
    } finally {
      finishOperation();
    }
  };

  const downloadUpdate = async () => {
    if (operationRef.current) return;
    const update = updateRef.current;
    if (!update) {
      setUpdateState({ kind: "error", action: "check" });
      return;
    }
    operationRef.current = true;
    const details = updateDetails(update);
    let downloaded = 0;
    let total: number | undefined;
    setUpdateState({ kind: "downloading", downloaded, ...details });
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          downloaded = 0;
          total = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
        } else if (event.event === "Finished") {
          setUpdateState({ kind: "verifying", ...details });
          return;
        }
        setUpdateState({ kind: "downloading", downloaded, total, ...details });
      }, { timeout: 120_000 });
      setUpdateState({ kind: "downloaded", ...details });
    } catch {
      setUpdateState({ kind: "error", action: "download", details });
    } finally {
      finishOperation();
    }
  };

  const installUpdate = async () => {
    if (isPortable !== false) return;
    if (operationRef.current) return;
    const update = updateRef.current;
    if (!update) {
      setUpdateState({ kind: "error", action: "check" });
      return;
    }
    operationRef.current = true;
    const details = updateDetails(update);
    setUpdateState({ kind: "installing", isWindows, ...details });
    try {
      await update.install({ restartAfterInstall: true });
      if (!isWindows) setUpdateState({ kind: "readyToRestart", ...details });
    } catch {
      setUpdateState({ kind: "error", action: "install", details });
    } finally {
      finishOperation();
    }
  };

  const restartUpdatedApp = async () => {
    if (operationRef.current) return;
    const details = stateDetails(updateState);
    if (!details) return;
    operationRef.current = true;
    setUpdateState({ kind: "relaunching", ...details });
    try {
      await relaunch();
    } catch {
      setUpdateState({ kind: "error", action: "relaunch", details });
    } finally {
      finishOperation();
    }
  };

  const openRecoveryPage = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    const details = stateDetails(updateState);
    try {
      await api.openReleasePage();
    } catch {
      setUpdateState({ kind: "error", action: "open", details: details ?? undefined });
    } finally {
      finishOperation();
    }
  };

  const checkRef = useRef(checkForUpdates);
  checkRef.current = checkForUpdates;
  useEffect(() => {
    if (!platformResolved || manualUpdates || isPortable !== false) return;
    let active = true;
    let stop: (() => void) | undefined;
    const nativeWindow = getCurrentWindow();
    const checkVisiblePanel = async () => {
      try {
        if (active && await nativeWindow.isVisible() && active) await checkRef.current(true);
      } catch { /* Visibility failures must not trigger a network request. */ }
    };
    void nativeWindow.onFocusChanged(event => {
      if (event.payload) void checkVisiblePanel();
    }).then(unlisten => { if (active) stop = unlisten; else unlisten(); }).catch(() => {});
    void checkVisiblePanel();
    return () => { active = false; stop?.(); };
  }, [platformResolved, manualUpdates, isPortable]);

  return { currentVersion, isWindows, isPortable, manualUpdates, updateState,
    hasUpdate: stateDetails(updateState) !== null,
    checkForUpdates, downloadUpdate, installUpdate, restartUpdatedApp, openRecoveryPage };
}

export function stateDetails(state: UpdateState): UpdateDetails | null {
  switch (state.kind) {
    case "available":
    case "downloading":
    case "verifying":
    case "downloaded":
    case "installing":
    case "readyToRestart":
    case "relaunching":
      return { version: state.version, notes: state.notes };
    case "error":
      return state.details ?? null;
    default:
      return null;
  }
}


export type AppUpdater = ReturnType<typeof useAppUpdater>;
