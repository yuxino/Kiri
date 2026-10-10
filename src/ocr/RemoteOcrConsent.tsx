import { KiriIcon } from "../components/KiriIcons";
import { useLayoutEffect, useState } from "react";
import { fmt, t } from "../i18n";
import type { PreparedOcrRequestDto } from "../lib/ipc";
import type { Rect } from "../annotation/geom";
import { useDialogFocusTrap } from "../settings/useDialogFocusTrap";
import { ocrProviderLabel } from "./providerLabel";
import { capturePanelLayout } from "../windows/toolbar-layout.js";
import "./remoteOcrConsent.css";

interface RemoteOcrConsentProps {
  prepared: PreparedOcrRequestDto;
  anchor: Rect;
  bounds: Rect;
  modeSelectorBounds?: Rect | null;
  failed: boolean;
  onCancel(): void;
  onUseLocal(): void;
  onSend(): void;
}

export function RemoteOcrConsent({
  prepared,
  anchor,
  bounds,
  modeSelectorBounds,
  failed,
  onCancel,
  onUseLocal,
  onSend,
}: RemoteOcrConsentProps) {
  const dialogRef = useDialogFocusTrap<HTMLElement>();
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const measurePanel = () => {
    const element = dialogRef.current;
    if (!element) return;
    const height = Math.ceil(element.getBoundingClientRect().height +
      Math.max(0, element.scrollHeight - element.clientHeight));
    setMeasuredHeight(current => current === height ? current : height);
  };
  useLayoutEffect(measurePanel);
  useLayoutEffect(() => {
    const element = dialogRef.current;
    if (!element) return;
    const observer = new ResizeObserver(measurePanel);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  const profile = prepared.profile;
  if (!profile) return null;
  const { left, top, width, maxHeight } = capturePanelLayout(
    anchor, bounds, { width: 440, height: measuredHeight }, modeSelectorBounds,
  );

  return (
    <section
      ref={dialogRef}
      className="kiri-hud kiri-remote-consent"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remote-ocr-consent-title"
      onPointerDown={(event) => event.stopPropagation()}
      style={{ left, top, width, maxHeight }}
    >
      <div className="kiri-remote-consent__header">
        <div>
          <span className="kiri-remote-consent__warning">
            {t("Image leaves this device")}
          </span>
          <h2 id="remote-ocr-consent-title">{t("Send image for remote OCR?")}</h2>
        </div>
        <button
          type="button"
          className="kiri-remote-consent__close"
          onClick={onCancel}
          aria-label={t("Cancel")}
          title={t("Cancel")}
        >
          <KiriIcon name="xmark" size={12} />
        </button>
      </div>

      <p className="kiri-remote-consent__summary">
        {t("Only this selected image will be sent after you click Send or Retry.")}
      </p>

      <dl className="kiri-remote-consent__details">
        <div>
          <dt>{t("Profile")}</dt>
          <dd>{profile.name}</dd>
        </div>
        <div>
          <dt>{t("Provider")}</dt>
          <dd>{ocrProviderLabel(profile.provider)}</dd>
        </div>
        <div>
          <dt>{t("Destination")}</dt>
          <dd title={profile.origin}>{profile.origin}</dd>
        </div>
        <div>
          <dt>{t("Model")}</dt>
          <dd>{profile.model}</dd>
        </div>
        <div>
          <dt>{t("Image")}</dt>
          <dd>
            {fmt("%d × %d px", prepared.imageWidth, prepared.imageHeight)} ·{" "}
            {fmt("%d KB", Math.max(1, Math.ceil(prepared.byteLength / 1024)))}
          </dd>
        </div>
      </dl>

      {failed && (
        <div className="kiri-remote-consent__error" role="alert">
          {t("Remote OCR failed. The image was not sent again.")}
        </div>
      )}

      <div className="kiri-remote-consent__hint">
        {t("Press Return to use local OCR for this image only.")}
      </div>

      <div className="kiri-remote-consent__actions">
        <button
          type="button"
          className="kiri-button kiri-button--secondary"
          onClick={onCancel}
        >
          {t("Cancel")}
        </button>
        <div className="kiri-remote-consent__action-spacer" />
        <button
          type="button"
          className="kiri-button kiri-button--primary"
          onClick={onUseLocal}
          autoFocus
        >
          {t("Use Local This Time")}
        </button>
        <button
          type="button"
          className="kiri-button kiri-button--secondary kiri-remote-consent__send"
          onClick={onSend}
        >
          {failed ? t("Retry Remote OCR") : fmt("Send to %@", profile.name)}
        </button>
      </div>
    </section>
  );
}
