import { useEffect, useRef, useState } from "react";
import { KiriIcon } from "../components/KiriIcons";
import { api } from "../lib/ipc";
import { t } from "../i18n";
import { ocrProviderLabel } from "../ocr/providerLabel";
import type {
  OcrEngineRef,
  OcrProviderProfileDto,
  OcrProviderSettingsDto,
} from "../lib/ipc";

export function ScreenshotOcrSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api.getScreenshotOcrEnabled().then(value => {
      if (current) setEnabled(value);
    }, () => {
      if (current) setError("Couldn't load screenshot text indexing.");
    });
    return () => { current = false; };
  }, [loadAttempt]);

  const change = async () => {
    if (enabled === null || changing.current) return;
    changing.current = true;
    setBusy(true);
    setError(null);
    try {
      setEnabled(await api.setScreenshotOcrEnabled(!enabled));
    } catch {
      setError("Couldn't change screenshot text indexing.");
    } finally {
      changing.current = false;
      setBusy(false);
    }
  };

  return <div className="kiri-settings-card kiri-screenshot-ocr-row" aria-busy={busy || (enabled === null && !error)}>
    <div className="kiri-screenshot-ocr-copy">
      <strong>{t("Search text in new screenshots")}</strong>
      <span id="screenshot-ocr-description">{t("Kiri uses on-device OCR for screenshots saved after you turn this on.")}</span>
      {error && <span className="kiri-storage-error" role="alert">{t(error)}</span>}
    </div>
    {enabled === null && error ? (
      <button type="button" className="kiri-button kiri-button--secondary"
        onClick={() => { setError(null); setLoadAttempt(value => value + 1); }}>{t("Retry")}</button>
    ) : (
      <button type="button" className="kiri-settings-switch" role="switch"
        aria-label={t("Search text in new screenshots")} aria-describedby="screenshot-ocr-description"
        aria-checked={enabled ?? false} disabled={enabled === null || busy} onClick={() => void change()}>
        <span aria-hidden="true" />
      </button>
    )}
  </div>;
}

interface OcrSettingsSectionProps {
  settings: OcrProviderSettingsDto;
  busy: boolean;
  onActivate(engine: OcrEngineRef): void;
  onAdd(): void;
  onEdit(profile: OcrProviderProfileDto): void;
  onDelete(profile: OcrProviderProfileDto): void;
}

function displayOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

export function OcrSettingsSection({
  settings,
  busy,
  onActivate,
  onAdd,
  onEdit,
  onDelete,
}: OcrSettingsSectionProps) {
  const localActive = settings.activeEngine.kind === "local";

  return (
    <section className="kiri-settings-section" aria-labelledby="ocr-settings-title">
      <div className="kiri-settings-section__heading">
        <div>
          <h2 id="ocr-settings-title">{t("Text Recognition")}</h2>
        </div>
        <button
          type="button"
          className="kiri-button kiri-button--secondary kiri-settings-add-button"
          onClick={onAdd}
          disabled={busy}
        >
          <span aria-hidden="true">＋</span>
          {t("Add Remote Profile")}
        </button>
      </div>

      {settings.warning && (
        <div className="kiri-settings-alert" role="status">
          {t(settings.warning)}
        </div>
      )}

      <div className="kiri-settings-card ocr-engine-list" role="group" aria-label={t("Active OCR engine")}>
        <div className="ocr-engine-row" data-active={localActive || undefined}>
          <button
            type="button"
            className="ocr-engine-choice"
            aria-pressed={localActive}
            onClick={() => { if (!localActive) onActivate({ kind: "local" }); }}
            disabled={busy}
          >
            <span className="ocr-engine-radio" aria-hidden="true" />
            <span className="ocr-engine-copy">
              <span className="ocr-engine-title-row">
                <strong>{t("Local OCR")}</strong>
                <span className="kiri-settings-badge kiri-settings-badge--local">
                  {t("On device")}
                </span>
              </span>
              <span>{t("Recognizes text on this device, even offline.")}</span>
            </span>
          </button>
        </div>

        {settings.profiles.map((profile) => {
          const active =
            settings.activeEngine.kind === "profile" &&
            settings.activeEngine.profileId === profile.id;
          return (
            <div className="ocr-engine-row" data-active={active || undefined} key={profile.id}>
              <button
                type="button"
                className="ocr-engine-choice"
                aria-pressed={active}
                onClick={() => { if (!active) onActivate({ kind: "profile", profileId: profile.id }); }}
                disabled={busy || !profile.hasApiKey}
                title={
                  profile.hasApiKey
                    ? t("Use this profile")
                    : t("Add an API key before selecting this profile")
                }
              >
                <span className="ocr-engine-radio" aria-hidden="true" />
                <span className="ocr-engine-copy">
                  <span className="ocr-engine-title-row">
                    <strong>{profile.name}</strong>
                    <span className="kiri-settings-badge">
                      {ocrProviderLabel(profile.provider)}
                    </span>
                  </span>
                  <span className="ocr-engine-metadata">
                    <span title={profile.baseUrl}>{displayOrigin(profile.baseUrl)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{profile.model}</span>
                  </span>
                  <span
                    className={
                      profile.hasApiKey
                        ? "ocr-engine-key-state ocr-engine-key-state--saved"
                        : "ocr-engine-key-state ocr-engine-key-state--missing"
                    }
                  >
                    {profile.hasApiKey ? (
                      <KiriIcon name="checkmark.circle.fill" size={12} />
                    ) : null}
                    {profile.hasApiKey ? t("API key saved") : t("API key required")}
                  </span>
                </span>
              </button>
              <div className="ocr-engine-actions">
                <button
                  type="button"
                  className="kiri-icon-button"
                  onClick={() => onEdit(profile)}
                  disabled={busy}
                  title={t("Edit Profile")}
                  aria-label={t("Edit Profile")}
                >
                  <KiriIcon name="pencil.tip" size={13} />
                </button>
                <button
                  type="button"
                  className="kiri-icon-button ocr-engine-delete"
                  onClick={() => onDelete(profile)}
                  disabled={busy}
                  title={t("Delete Profile")}
                  aria-label={t("Delete Profile")}
                >
                  <KiriIcon name="trash" size={13} />
                </button>
              </div>
            </div>
          );
        })}

      </div>

      <p className="ocr-privacy-note">
        {t("Remote OCR asks before sending each image.")}
      </p>
    </section>
  );
}
