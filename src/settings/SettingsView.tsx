import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ChoiceSelect } from "../components/ChoiceSelect";
import { stateDetails, type AppUpdater } from "./useAppUpdater";
import { KiriIcon } from "../components/KiriIcons";
import { fmt, getLanguage, languageNames, languages, onLanguageChange, setLanguage, t, type KiriLanguage } from "../i18n";
import {
  api,
  onLibraryChanged,
  type LibraryStatusDto,
  type OcrEngineRef,
  type OcrProviderProfileDto,
  type OcrProviderSettingsDto,
  type SaveOcrProviderProfileRequest,
} from "../lib/ipc";
import { OcrProfileDialog } from "./OcrProfileDialog";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { DockVisibilityRow } from "./DockVisibilityRow";
import { StartupSettingsRow } from "./StartupSettingsRow";
import { SupportLinks } from "./SupportLinks";
import { ReleaseNotes } from "./ReleaseNotes";
import { OcrSettingsSection } from "./OcrSettingsSection";
import { useDialogFocusTrap } from "./useDialogFocusTrap";
import "./settings.css";

export function SettingsView({ updater }: { updater: AppUpdater }) {
  const tabs = [
    { id: "general", label: "General" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "ocr", label: "Text Recognition" },
    { id: "about", label: "About" },
  ] as const;
  type SettingsTab = typeof tabs[number]["id"];
  const [activeTab, setActiveTab] = useState<SettingsTab>(updater.hasUpdate ? "about" : "general");
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const openedWithUpdate = useRef(updater.hasUpdate);
  useEffect(() => {
    if (!openedWithUpdate.current) return;
    const heading = document.getElementById("about-settings-title");
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  }, []);
  const [settings, setSettings] = useState<OcrProviderSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState<OcrProviderProfileDto | null | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<OcrProviderProfileDto | null>(null);
  const ocrLoadRequested = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setSettings(await api.getOcrProviderSettings());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Reading OCR profiles consults system credential storage. Other settings
    // pages do not need those secrets or the accompanying native work.
    if (activeTab !== "ocr" || ocrLoadRequested.current) return;
    ocrLoadRequested.current = true;
    void load();
  }, [activeTab, load]);

  const activate = async (engine: OcrEngineRef) => {
    if (busy) return;
    setBusy(true);
    setOperationError(null);
    try {
      setSettings(await api.setActiveOcrEngine(engine));
    } catch {
      setOperationError("Couldn't change the OCR engine.");
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async (request: SaveOcrProviderProfileRequest) => {
    if (busy) return;
    setBusy(true);
    setOperationError(null);
    try {
      setSettings(await api.saveOcrProviderProfile(request));
      setEditingProfile(undefined);
    } catch {
      setOperationError("Couldn't save the OCR profile.");
    } finally {
      setBusy(false);
    }
  };

  const deleteProfile = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setOperationError(null);
    try {
      setSettings(
        await api.deleteOcrProviderProfile(deleteTarget.id, deleteTarget.revision),
      );
      setDeleteTarget(null);
    } catch {
      setOperationError("Couldn't delete the OCR profile.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="kiri-settings" aria-label={t("Settings")}>
      <div className="kiri-settings__content">
        <nav className="kiri-settings-tabs" role="tablist" aria-label={t("Settings")}>
          {tabs.map((tab, index) => (
            <button className="kiri-settings-tab" key={tab.id} ref={(button) => { tabButtons.current[index] = button; }}
              type="button" role="tab" id={`settings-tab-${tab.id}`}
              aria-controls={`settings-panel-${tab.id}`} aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => {
                const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
                if (next === null) return;
                event.preventDefault();
                setActiveTab(tabs[next].id);
                tabButtons.current[next]?.focus();
              }}>
              {t(tab.label)}
              {tab.id === "about" && updater.hasUpdate && <span className="kiri-settings-tab-dot" aria-label={t("Update available")} />}
            </button>
          ))}
        </nav>
        <div className="kiri-settings-panel" role="tabpanel" id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`} tabIndex={0}>
        {activeTab === "general" && <GeneralSettingsSection />}
        {activeTab === "shortcuts" && <ShortcutsSettings />}
        {activeTab === "ocr" && <>
        {operationError && (
          <div className="kiri-settings-alert kiri-settings-alert--error" role="alert">
            {t(operationError)}
          </div>
        )}

        {loading ? (
          <div className="kiri-settings-card kiri-settings-loading" role="status">
            <span className="kiri-settings-spinner" aria-hidden="true" />
            {t("Loading OCR settings…")}
          </div>
        ) : loadError || !settings ? (
          <div className="kiri-settings-card kiri-settings-empty-state" role="alert">
            <KiriIcon name="text.viewfinder" size={24} />
            <strong>{t("Couldn't load OCR settings")}</strong>
            <span>{t("Local OCR remains available while you try again.")}</span>
            <button
              type="button"
              className="kiri-button kiri-button--secondary"
              onClick={() => void load()}
            >
              {t("Retry")}
            </button>
          </div>
        ) : (
          <OcrSettingsSection
            settings={settings}
            busy={busy}
            onActivate={(engine) => void activate(engine)}
            onAdd={() => {
              setOperationError(null);
              setEditingProfile(null);
            }}
            onEdit={(profile) => {
              setOperationError(null);
              setEditingProfile(profile);
            }}
            onDelete={(profile) => {
              setOperationError(null);
              setDeleteTarget(profile);
            }}
          />
        )}

        </>}
        {activeTab === "about" && <AboutSettingsSection updater={updater} />}
        </div>
      </div>

      {editingProfile !== undefined && (
        <OcrProfileDialog
          profile={editingProfile}
          busy={busy}
          error={operationError ? t(operationError) : null}
          onCancel={() => {
            if (!busy) {
              setEditingProfile(undefined);
              setOperationError(null);
            }
          }}
          onSave={(request) => void saveProfile(request)}
        />
      )}

      {deleteTarget && (
        <DeleteProfileDialog
          profile={deleteTarget}
          active={
            settings?.activeEngine.kind === "profile" &&
            settings.activeEngine.profileId === deleteTarget.id
          }
          busy={busy}
          error={operationError ? t(operationError) : null}
          onCancel={() => {
            if (!busy) {
              setDeleteTarget(null);
              setOperationError(null);
            }
          }}
          onDelete={() => void deleteProfile()}
        />
      )}
    </main>
  );
}

function AboutSettingsSection({ updater }: { updater: AppUpdater }) {
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const copying = useRef(false);
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const copyInfo = async () => {
    if (copying.current) return;
    copying.current = true;
    setCopyState("copying");
    try { await api.copySupportInfo(); setCopyState("copied"); }
    catch { setCopyState("error"); }
    finally { copying.current = false; }
  };
  const { currentVersion, isWindows, isPortable, manualUpdates, updateState,
    checkForUpdates, downloadUpdate, installUpdate, restartUpdatedApp, openRecoveryPage } = updater;
  let status = t(manualUpdates ? "Linux updates are installed manually from a downloaded package." : isPortable
    ? "Portable version: download the latest ZIP from Releases to update."
    : "Opening Kiri checks for updates.");
  if (updateState.kind === "checking") {
    status = t("Checking…");
  } else if (updateState.kind === "upToDate") {
    status = fmt("Kiri %@ is up to date.", `v${currentVersion}`);
  } else if (updateState.kind === "available") {
    status = fmt("Kiri %@ is available.", `v${updateState.version}`);
  } else if (updateState.kind === "downloading") {
    const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    status = updateState.total
      ? fmt("Downloading… %@", `${Math.min(100, Math.round((updateState.downloaded / updateState.total) * 100))}% · ${size(Math.min(updateState.downloaded, updateState.total))} / ${size(updateState.total)}`)
      : fmt("Downloading… %@", size(updateState.downloaded));
  } else if (updateState.kind === "verifying") {
    status = t("Verifying update signature…");
  } else if (updateState.kind === "downloaded") {
    status = t("Download and signature verification complete. Ready to install.");
  } else if (updateState.kind === "installing") {
    status = t(
      updateState.isWindows
        ? "Kiri will close briefly and reopen after the update."
        : "Installing the signed update…",
    );
  } else if (updateState.kind === "readyToRestart") {
    status = t("Update installed. Restart Kiri when you're ready.");
  } else if (updateState.kind === "relaunching") {
    status = t("Restarting Kiri…");
  } else if (updateState.kind === "error") {
    const errors: Record<string, string> = {
      check: "Couldn't check for updates. Try again.",
      download: "Couldn't download the update. Try again.",
      install: "Couldn't install the update. Try again.",
      relaunch: "Couldn't restart Kiri. Try again.",
      open: "Couldn't open the update page. Try again.",
    };
    status = t(errors[updateState.action]);
  }

  const details = stateDetails(updateState);
  const busy = ["checking", "downloading", "verifying", "installing", "relaunching"].includes(updateState.kind);

  const runPrimaryAction = () => {
    if (isPortable || manualUpdates) return void openRecoveryPage();
    if (isPortable === null) return;
    if (busy) return;
    if (updateState.kind === "available") return void downloadUpdate();
    if (updateState.kind === "downloaded") return void installUpdate();
    if (updateState.kind === "readyToRestart") return void restartUpdatedApp();
    if (updateState.kind === "error") {
      if (updateState.action === "download") return void downloadUpdate();
      if (updateState.action === "install") return void installUpdate();
      if (updateState.action === "relaunch") return void restartUpdatedApp();
      if (updateState.action === "open") return void openRecoveryPage();
    }
    return void checkForUpdates();
  };

  const buttonLabel = (isPortable || manualUpdates) ? t("Open Releases Page") : updateState.kind === "checking"
    ? t("Checking…")
    : updateState.kind === "downloading" || updateState.kind === "verifying"
      ? t(updateState.kind === "verifying" ? "Verifying update signature…" : "Downloading…")
      : updateState.kind === "downloaded"
        ? t(isWindows ? "Install and Restart" : "Install Update")
        : updateState.kind === "installing"
          ? t("Installing…")
          : updateState.kind === "readyToRestart" || updateState.kind === "relaunching"
            ? t(updateState.kind === "relaunching" ? "Restarting…" : "Restart and Finish Update")
            : updateState.kind === "available"
              ? t("Download Update")
              : updateState.kind === "error"
                ? t("Retry")
                : t("Check for Updates");

  return (
    <section className="kiri-settings-section kiri-settings-section--about" aria-labelledby="about-settings-title">
      <div className="kiri-settings-section__heading">
        <div>
          <h2 id="about-settings-title" tabIndex={-1}>{t(updater.hasUpdate ? "Update available" : "About")}</h2>
        </div>
      </div>
      <div className="kiri-settings-card kiri-version-row">
        <div className="kiri-update-summary">
          <div className="kiri-update-copy">
            <div className="kiri-version-title">
              <strong>Kiri</strong>
              <span className="kiri-version-number">
                {details ? <>
                  <span aria-label={fmt("Version %@", currentVersion ? `v${currentVersion}` : "—")}>{currentVersion ? `v${currentVersion}` : "—"}</span>
                  <span className="kiri-version-arrow" aria-hidden="true">→</span>
                  <span className="kiri-version-target" aria-label={`${t("Update available")}: v${details.version}`}>v{details.version}</span>
                </> : fmt("Version %@", currentVersion ? `v${currentVersion}` : "—")}
              </span>
            </div>
            <span
              id="kiri-update-status"
              className="kiri-update-status"
              role={updateState.kind === "error" ? "alert" : "status"}
              aria-live={updateState.kind === "error" ? "assertive" : "polite"}
            >
              {updateState.kind === "error"
                ? <KiriIcon name="exclamationmark.triangle" size={14} />
                : ["downloaded", "readyToRestart", "upToDate"].includes(updateState.kind)
                  ? <KiriIcon name="checkmark.circle.fill" size={14} />
                  : busy && <span className="kiri-settings-spinner" aria-hidden="true" />}
              <span>{status}</span>
            </span>
            {updateState.kind === "downloading" && (
              <progress
                className="kiri-update-progress"
                max={updateState.total}
                value={updateState.total ? Math.min(updateState.downloaded, updateState.total) : undefined}
                aria-label={t("Update download progress")}
              />
            )}
          </div>
          <div className="kiri-update-actions" role="group" aria-label={t("About")}>
            <button
              type="button"
              className={updater.hasUpdate
                ? "kiri-button kiri-button--primary kiri-update-button"
                : "kiri-button kiri-button--secondary kiri-update-button"}
              disabled={busy || isPortable === null}
              aria-describedby="kiri-update-status"
              onClick={runPrimaryAction}
            >
              {buttonLabel}
            </button>
          </div>
        </div>
        {details?.notes && <ReleaseNotes notes={details.notes} />}
      </div>
      <div className="kiri-support-actions" role="group" aria-label={t("About")}>
        <button type="button" className="kiri-button kiri-button--secondary"
          disabled={copyState === "copying"} aria-label={t("Copy Info")}
          onClick={() => void copyInfo()}>
          <KiriIcon name={copyState === "copied" ? "checkmark" : "doc.on.doc"} size={15} />
          <span aria-live="polite">{t(copyState === "copied" ? "Copied" : "Copy Info")}</span>
        </button>
        {copyState === "error" && <span className="kiri-support-copy-status" role="alert">{t("Couldn't copy info. Try again.")}</span>}
        <SupportLinks isWindows={isWindows} />
        {updateState.kind === "error" && (
          <button
            type="button"
            className="kiri-button kiri-button--ghost"
            onClick={() => void openRecoveryPage()}
          >
            {t("Open Releases Page")}
          </button>
        )}
      </div>
    </section>
  );
}

function GeneralSettingsSection() {
  const language = useSyncExternalStore(onLanguageChange, getLanguage);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [languageError, setLanguageError] = useState(false);
  const [libraryStatus, setLibraryStatus] = useState<LibraryStatusDto | null>(null);
  const [libraryLoadError, setLibraryLoadError] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryOperationError, setLibraryOperationError] = useState<string | null>(null);
  const libraryStatusGeneration = useRef(0);

  const loadLibraryStatus = useCallback(async (clearOperationErrorOnSuccess = false) => {
    const generation = ++libraryStatusGeneration.current;
    try {
      const status = await api.getLibraryStatus();
      if (generation !== libraryStatusGeneration.current) return;
      setLibraryStatus(status);
      setLibraryLoadError(false);
      if (clearOperationErrorOnSuccess) setLibraryOperationError(null);
    } catch {
      if (generation !== libraryStatusGeneration.current) return;
      setLibraryLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadLibraryStatus();
    const subscription = onLibraryChanged(() => {
      void loadLibraryStatus();
    });
    return () => {
      void subscription.then((dispose) => dispose()).catch(() => {});
    };
  }, [loadLibraryStatus]);

  const switchTo = async (next: KiriLanguage) => {
    if (languageBusy) return;
    setLanguageBusy(true);
    setLanguageError(false);
    try {
      await api.setLanguage(next);
      setLanguage(next);
    } catch {
      setLanguageError(true);
    } finally {
      setLanguageBusy(false);
    }
  };

  const runLibraryAction = async (
    action: () => Promise<unknown>,
    errorMessage: "Couldn't open folder" | "Couldn't update location",
  ) => {
    if (libraryBusy) return;
    setLibraryBusy(true);
    setLibraryOperationError(null);
    try {
      await action();
      await loadLibraryStatus(true);
    } catch {
      setLibraryOperationError(errorMessage);
      await loadLibraryStatus();
    } finally {
      setLibraryBusy(false);
    }
  };

  const statusLabel = libraryLoadError
    ? t("Unavailable")
    : libraryStatus?.availability === "migrating"
      ? t("Moving…")
      : libraryStatus?.availability === "unavailable"
        ? t("Unavailable")
        : null;
  const locationLabel = libraryStatus
    ? libraryStatus.isDefault
      ? t("Default")
      : libraryStatus.locationLabel
    : libraryLoadError
      ? t("Couldn't load location")
      : "—";

  return (
    <section className="kiri-settings-section kiri-settings-section--general" aria-labelledby="general-settings-title">
      <div className="kiri-settings-section__heading">
        <div>
          <h2 id="general-settings-title">{t("General")}</h2>
        </div>
      </div>
      <div className="kiri-settings-group">
      <div className="kiri-settings-card kiri-language-row">
        <div>
          <strong>{t("Language")}</strong>
          <span>{t("Changes apply to every Kiri window.")}</span>
          {languageError && <span role="alert">{t("Could not save the language preference.")}</span>}
        </div>
        <ChoiceSelect
          className="kiri-language-select"
          menuClassName="kiri-language-menu"
          menuMinWidth={220}
          label={t("Language")}
          value={language}
          disabled={languageBusy}
          onChange={(next) => { if (next !== language) void switchTo(next); }}
          options={languages.map((item) => ({ value: item, label: languageNames[item] }))}
        />
      </div>
      <DockVisibilityRow />
      <StartupSettingsRow />
      <div className="kiri-settings-card kiri-storage-row">
        <div className="kiri-storage-copy">
          <div className="kiri-storage-title">
            <strong>{t("Library Location")}</strong>
            {statusLabel && <span className="kiri-settings-badge">{statusLabel}</span>}
          </div>
          <span title={locationLabel}>{locationLabel}</span>
          {libraryOperationError && (
            <span className="kiri-storage-error" role="alert">
              {t(libraryOperationError)}
            </span>
          )}
        </div>
        <div className="kiri-storage-actions">
          {libraryLoadError ? (
            <button
              type="button"
              className="kiri-button kiri-button--secondary"
              disabled={libraryBusy}
              onClick={() => {
                setLibraryOperationError(null);
                void loadLibraryStatus(true);
              }}
            >
              {t("Retry")}
            </button>
          ) : libraryStatus?.availability === "ready" ? (
            <>
              <button
                type="button"
                className="kiri-button kiri-button--secondary"
                disabled={libraryBusy}
                onClick={() =>
                  void runLibraryAction(api.revealLibrary, "Couldn't open folder")
                }
              >
                {t("Open Folder")}
              </button>
              <button
                type="button"
                className="kiri-button kiri-button--secondary"
                disabled={libraryBusy}
                onClick={() =>
                  void runLibraryAction(api.chooseLibraryLocation, "Couldn't update location")
                }
              >
                {t("Change…")}
              </button>
              {!libraryStatus.isDefault && (
                <button
                  type="button"
                  className="kiri-button kiri-button--secondary"
                  disabled={libraryBusy}
                  onClick={() =>
                    void runLibraryAction(api.restoreDefaultLibrary, "Couldn't update location")
                  }
                >
                  {t("Restore Default")}
                </button>
              )}
            </>
          ) : libraryStatus?.availability === "unavailable" ? (
            <>
              <button
                type="button"
                className="kiri-button kiri-button--secondary"
                disabled={libraryBusy}
                onClick={() =>
                  void runLibraryAction(api.retryLibrary, "Couldn't update location")
                }
              >
                {t("Retry")}
              </button>
              <button
                type="button"
                className="kiri-button kiri-button--secondary"
                disabled={libraryBusy}
                onClick={() =>
                  void runLibraryAction(api.locateLibrary, "Couldn't update location")
                }
              >
                {t("Locate…")}
              </button>
            </>
          ) : null}
        </div>
      </div>
      </div>
    </section>
  );
}

function DeleteProfileDialog({
  profile,
  active,
  busy,
  error,
  onCancel,
  onDelete,
}: {
  profile: OcrProviderProfileDto;
  active: boolean;
  busy: boolean;
  error: string | null;
  onCancel(): void;
  onDelete(): void;
}) {
  const titleId = useId();
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter" || event.key === "Return") {
        // Destructive actions are intentionally never bound to Return.
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onCancel]);

  return (
    <div className="kiri-settings-dialog-backdrop">
      <div
        ref={dialogRef}
        className="kiri-settings-dialog kiri-settings-dialog--compact"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId}>{t("Delete OCR Profile?")}</h2>
        <p>{fmt("The profile “%@” and its saved API key will be removed.", profile.name)}</p>
        {active && <p>{t("Kiri will switch back to Local OCR after deletion.")}</p>}
        {error && (
          <div className="kiri-settings-form-error" role="alert">
            {error}
          </div>
        )}
        <div className="kiri-settings-dialog__actions">
          <button
            type="button"
            className="kiri-button kiri-button--secondary"
            onClick={onCancel}
            disabled={busy}
            autoFocus
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="kiri-button kiri-button--destructive kiri-button--destructive-fill"
            onClick={onDelete}
            disabled={busy}
          >
            {busy ? t("Deleting…") : t("Delete Profile")}
          </button>
        </div>
      </div>
    </div>
  );
}
