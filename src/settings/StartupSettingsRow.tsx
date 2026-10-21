import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, type StartupSettingsDto } from "../lib/ipc";
import { t } from "../i18n";

export function StartupSettingsRow() {
  const descriptionId = useId();
  const [status, setStatus] = useState<StartupSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const changing = useRef(false);

  const load = useCallback(async () => {
    if (changing.current) return;
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.getStartupSettings();
      if (mounted.current && request === generation.current) setStatus(next);
    } catch {
      if (mounted.current && request === generation.current) setError("Couldn't load startup settings.");
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const change = async () => {
    if (!status?.supported || loading || changing.current) return;
    changing.current = true;
    ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.setStartupEnabled(!(status.enabled || status.requiresApproval));
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError("Couldn't change startup settings.");
    } finally {
      changing.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const openSystemSettings = async () => {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setError(null);
    let opened = false;
    try {
      await api.openSystemStartupSettings();
      opened = true;
    } catch {
      if (mounted.current) setError("Couldn't open system startup settings.");
    } finally {
      changing.current = false;
      if (mounted.current) { setBusy(false); if (opened) void load(); }
    }
  };

  return (
    <div className="kiri-settings-card kiri-dock-row" aria-busy={loading || busy}>
      <div className="kiri-dock-copy">
        <strong>{t("Start at login")}</strong>
        <span id={descriptionId}>{t(status?.supported === false
          ? "Startup is unavailable for this installation."
          : status?.requiresApproval
            ? "Not active. Allow Kiri in your system's startup settings."
            : "Start in the background without opening the library.")}</span>
        {error && <span className="kiri-storage-error" role="alert">{t(error)}</span>}
      </div>
      <div className="kiri-storage-actions">
        {error && !status ? (
          <button type="button" className="kiri-button kiri-button--secondary" disabled={loading || busy} onClick={() => void load()}>{t("Retry")}</button>
        ) : <>
          {status?.requiresApproval && (
            <button type="button" className="kiri-button kiri-button--secondary" disabled={loading || busy} onClick={() => void openSystemSettings()}>{t("Open System Settings")}</button>
          )}
          <button type="button" role="switch" className="kiri-settings-switch"
            aria-label={t("Start at login")} aria-describedby={descriptionId}
            aria-checked={!!status && (status.enabled || status.requiresApproval)}
            disabled={loading || busy || !status?.supported} onClick={() => void change()}>
            <span aria-hidden="true" />
          </button>
        </>}
      </div>
    </div>
  );
}
