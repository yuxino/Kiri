import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";

/** The native dialog top layer belongs to this WebView, never the desktop. */
export function EmptyTrashDialog({ onConfirm, onClose }: {
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const confirm = async () => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await onConfirm();
      onClose();
    } catch {
      setFailed(true);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="kiri-confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="empty-trash-title"
      aria-describedby="empty-trash-description"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!operation.current) onClose();
      }}
      onKeyDown={(event) => {
        // Main-window shortcuts must not move focus or change selection here.
        event.stopPropagation();
        if (event.key === "Enter" || event.key === "Return") event.preventDefault();
      }}
    >
      <h2 id="empty-trash-title">{t("Empty Trash?")}</h2>
      <p id="empty-trash-description">
        {t("All captures in Trash will be permanently deleted. This cannot be undone.")}
      </p>
      {failed && <p className="kiri-confirm-dialog__error" role="alert">
        {t("Couldn't complete this action")}
      </p>}
      <div className="kiri-confirm-dialog__actions">
        <button type="button" className="kiri-button kiri-button--secondary"
          autoFocus disabled={busy} onClick={() => { if (!operation.current) onClose(); }}>
          {t("Cancel")}
        </button>
        <button type="button" className="kiri-button kiri-button--destructive kiri-button--destructive-fill"
          disabled={busy} onClick={() => void confirm()}>
          {t(busy ? "Deleting…" : "Empty Trash")}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
