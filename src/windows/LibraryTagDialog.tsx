import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import type { AssetTagAction } from "../lib/ipc";
import { useDialogFocusTrap } from "../settings/useDialogFocusTrap";

export function LibraryTagDialog({ count, canEdit, existingTags, removableTags, currentTag, onEdit, onClose }: {
  count: number;
  canEdit: boolean;
  existingTags: string[];
  removableTags: string[];
  currentTag: string | null;
  onEdit(tag: string, action: AssetTagAction): Promise<void>;
  onClose(): void;
}) {
  const dialogRef = useDialogFocusTrap<HTMLDialogElement>();
  const nameRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLSelectElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failedAction, setFailedAction] = useState<AssetTagAction | null>(null);
  const [draft, setDraft] = useState("");
  const [removeTag, setRemoveTag] = useState(() => {
    if (currentTag && removableTags.includes(currentTag)) return currentTag;
    return removableTags.length === 1 ? removableTags[0] : "";
  });
  const canRemove = removableTags.includes(removeTag);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [dialogRef]);

  useLayoutEffect(() => {
    if (busy) dialogRef.current?.focus();
    else if (failedAction === "remove") removeRef.current?.focus();
    else if (failedAction) nameRef.current?.focus();
  }, [busy, dialogRef, failedAction]);

  const save = async (tag: string, action: AssetTagAction) => {
    if (pending.current || !tag || !canEdit) return;
    pending.current = true;
    setBusy(true);
    setFailedAction(null);
    try {
      await onEdit(tag, action);
      onClose();
    } catch {
      setFailedAction(action);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return createPortal(
    <dialog ref={dialogRef} className="kiri-confirm-dialog library-tag-dialog" tabIndex={-1}
      aria-labelledby="library-tag-dialog-title" aria-describedby="library-tag-dialog-count"
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending.current) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") event.stopPropagation();
      }}>
      <h2 id="library-tag-dialog-title">{t("Manage Tags")}</h2>
      <p id="library-tag-dialog-count">{t("Selected {n}").replace("{n}", String(count))}</p>
      <div className="library-tag-dialog__field">
        <label htmlFor="library-tag-dialog-name">{t("Tag name")}</label>
        <div>
          <input ref={nameRef} autoFocus id="library-tag-dialog-name" list="library-tag-dialog-options"
            value={draft} disabled={busy || !canEdit} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.repeat || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              void save(draft.trim(), "add");
            }} />
          <datalist id="library-tag-dialog-options">
            {existingTags.map((tag) => <option key={tag} value={tag} />)}
          </datalist>
          <button type="button" className="kiri-button kiri-button--secondary"
            disabled={busy || !canEdit || !draft.trim()} onClick={() => void save(draft.trim(), "add")}>
            {t("Add")}
          </button>
        </div>
      </div>
      {removableTags.length > 0 && <div className="library-tag-dialog__field">
        <label htmlFor="library-tag-dialog-remove">{t("Remove tag")}</label>
        <div>
          <select ref={removeRef} id="library-tag-dialog-remove" value={canRemove ? removeTag : ""}
            disabled={busy || !canEdit} onChange={(event) => setRemoveTag(event.target.value)}>
            <option value="" disabled>{t("Select a tag")}</option>
            {removableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
          <button type="button" className="kiri-button kiri-button--secondary"
            disabled={busy || !canEdit || !canRemove} onClick={() => void save(removeTag, "remove")}>
            {t("Remove")}
          </button>
        </div>
      </div>}
      {(!canEdit || failedAction) && <p className="kiri-confirm-dialog__error" role="alert">
        {t(canEdit ? "Couldn't complete this action" : "The selection changed. Select the captures again.")}
      </p>}
      <div className="kiri-confirm-dialog__actions">
        <button type="button" className="kiri-button kiri-button--secondary" disabled={busy} onClick={onClose}>
          {t("Cancel")}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
