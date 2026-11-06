import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, mediaUrl, onLibraryChanged, type AssetDto, type OcrRecognitionDto } from "../lib/ipc";
import { KiriIcon } from "../components/KiriIcons";
import { t } from "../i18n";
import { isTextComposition, setTextComposition } from "../annotation/text-composition.js";
import { useRecordSelection } from "../components/useRecordSelection";
import { RecordMoreActions } from "../components/RecordMoreActions";
import "./text-history.css";

export function TextReader({ text, imageId, saved = true, editor, heading, actions, actionsDisabled = false }: {
  text: string; imageId?: string; saved?: boolean; editor?: ReactNode; heading?: ReactNode; actions?: ReactNode; actionsDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const copyGeneration = useRef(0);
  useEffect(() => {
    setCopied(false); setCopyError(false); setImageFailed(false);
    copyGeneration.current += 1;
    return () => { copyGeneration.current += 1; };
  }, [text, imageId]);
  const copy = async () => {
    if (actionsDisabled) return;
    const generation = ++copyGeneration.current;
    setCopyError(false);
    try {
      await api.copyHistoryText(text);
      if (generation === copyGeneration.current) setCopied(true);
    } catch {
      if (generation === copyGeneration.current) setCopyError(true);
    }
  };
  return <div className="text-reader">
    <div className="record-detail-header">
      {heading ?? <span className="text-reader__caption">{t("Recognized Text")}</span>}
      <div className="record-actions">
        {!editor && text.trim() && <button type="button" className="kiri-button kiri-button--secondary" disabled={actionsDisabled} onClick={() => void copy()}>
          <KiriIcon name={copied ? "checkmark" : "doc.on.doc"} size={14} />
          {t(copied ? "Text Copied" : "Copy Text")}
        </button>}
        {actions}
      </div>
    </div>
    {copyError && <p className="text-history__error" role="alert">{t("Couldn't copy text.")}</p>}
    {!saved && text.trim() && <p className="text-history__error" role="status">{t("History wasn't saved. Copy the text before closing.")}</p>}
    {editor ?? <div className="text-reader__body" tabIndex={0} role="region" aria-label={t("Recognized Text")}>
      {text.trim() ? text : t("No Text Found")}
    </div>}
    {imageId && <details className="text-reader__source" key={imageId}>
      <summary><KiriIcon name="photo.on.rectangle" size={14} />{t("View Source Image")}</summary>
      {imageFailed ? <p role="status">{t("Can't read this file")}</p> :
        <a href="#" onClick={(event) => { event.preventDefault(); void api.openAsset(imageId).catch(() => setImageFailed(true)); }} aria-label={t("Open Source Image")}>
          <img src={mediaUrl(imageId)} alt={t("OCR Source Image")} loading="lazy" onError={() => setImageFailed(true)} />
        </a>}
    </details>}
  </div>;
}

export function OcrDialog({ asset, onClose }: { asset: AssetDto; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<OcrRecognitionDto | null>(asset.ocrText != null
    ? { text: asset.ocrText, saved: true, asset } : null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A single promise survives React's effect replay. Closing never starts a retry.
  const request = useRef<Promise<OcrRecognitionDto> | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (asset.ocrText != null) setResult({ text: asset.ocrText, saved: true, asset });
  }, [asset]);
  useEffect(() => {
    if (asset.ocrText != null) return;
    let current = true;
    setError(null);
    request.current ??= api.recognizeAssetLocal(asset.id);
    void request.current.then((value) => { if (current) setResult(value); }, (reason: unknown) => {
      if (current) setError(typeof reason === "string" ? reason : "Local OCR failed.");
    });
    return () => { current = false; };
  }, [asset.id, asset.ocrText, attempt]);
  const hasText = Boolean(result?.text.trim());
  const heading = <div className="text-dialog__title">
    <h2 id="text-dialog-title">{t(hasText ? "Recognized Text" : "Local OCR")}</h2>
    {hasText && result?.saved && <p>{t("Saved to Text History")}</p>}
  </div>;
  const closeButton = <button type="button" className="kiri-icon-button" aria-label={t("Close")} onClick={onClose}><KiriIcon name="xmark" size={16} /></button>;
  return <dialog ref={dialog} className="text-dialog" onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onKeyDown={(event) => event.stopPropagation()} aria-labelledby="text-dialog-title">
    {result ? <TextReader text={result.text} saved={result.saved} imageId={result.asset?.id ?? asset.id} heading={heading} actions={closeButton} /> : <>
      <header className="text-dialog__header">{heading}{closeButton}</header>
      <div className="text-history__empty" role={error ? "alert" : "status"}>
        <KiriIcon name="text.viewfinder" size={28} />
        <p>{t(error ?? "Recognizing Text…")}</p>
        {!error && <small>{t("You can close this window. Successful results are saved to Text History.")}</small>}
        {error && <button type="button" className="kiri-button kiri-button--secondary" onClick={() => { request.current = null; setAttempt((value) => value + 1); }}>{t("Retry")}</button>}
      </div>
    </>}
  </dialog>;
}

export function TextHistory({ onNavigationLockChange }: { onNavigationLockChange?(locked: boolean): void } = {}) {
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<AssetDto[]>([]);
  const [recordsQuery, setRecordsQuery] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [mutationError, setMutationError] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBase, setEditBase] = useState<{ id: string; text: string; asset: AssetDto } | null>(null);
  const editingRef = useRef(false);
  const savingRef = useRef(false);
  // Publish changes synchronously: a second click can reach the main sidebar
  // before React renders disabled navigation. Keep failed drafts mounted.
  const updateNavigationLock = () => onNavigationLockChange?.(editingRef.current || savingRef.current);
  useEffect(() => () => onNavigationLockChange?.(false), [onNavigationLockChange]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState(false);
  const [revision, setRevision] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const visibleRecords = recordsQuery === query ? records : [];
  const batch = useRecordSelection({ query, ids: visibleRecords.map(record => record.id), loading: loading || recordsQuery !== query,
    disabled: editing || saving || deleting, onDeleted: ids => {
      setRecords(current => current.filter(record => !ids.includes(record.id)));
      setRevision(value => value + 1);
    } });
  useEffect(() => {
    const subscription = onLibraryChanged(() => setRevision((value) => value + 1));
    return () => { void subscription.then((dispose) => dispose()).catch(() => {}); };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true); setLoadError(false);
    const timer = setTimeout(() => {
      void api.listOcrRecords(query).then((items) => {
        if (!current) return;
        setRecords(items); setRecordsQuery(query);
        setSelectedId((id) => editingRef.current ? id : items.some((item) => item.id === id) ? id : items[0]?.id ?? null);
        setLoading(false);
      }, () => { if (current) { setLoadError(true); setLoading(false); setRecords([]); } });
    }, query ? 150 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [query, revision]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!isTextComposition(event) && !editingRef.current && !savingRef.current &&
          (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); search.current?.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  // Keep the edited record visible even if an earlier search or a library
  // refresh no longer returns it. Its original text remains the save revision.
  const selected = editing && editBase ? editBase.asset : records.find((item) => item.id === selectedId);
  useEffect(() => {
    if (!editing) setSelectedId(id => records.some(item => item.id === id) ? id : records[0]?.id ?? null);
  }, [editing, records]);
  useEffect(() => { setEditError(false); }, [selectedId]);
  const finishEditing = () => {
    editingRef.current = false;
    setEditing(false); setEditBase(null);
    updateNavigationLock();
  };
  const saveCorrection = async (replacement: string | null) => {
    if (!selected || savingRef.current || !selected.ocrText || batch.active) return;
    // A live library refresh must not silently rebase an in-progress draft over
    // another window's correction. Keep the text the user began editing.
    if (replacement !== null && editBase?.id !== selected.id) return;
    const expectedText = replacement === null ? selected.ocrText : editBase!.text;
    savingRef.current = true;
    updateNavigationLock();
    setSaving(true); setEditError(false);
    try {
      const updated = await api.updateOcrHistoryText(selected.id, expectedText, replacement);
      setRecords((current) => current.map((item) => item.id === updated.id ? updated : item));
      finishEditing();
    } catch { setEditError(true); }
    finally { savingRef.current = false; setSaving(false); updateNavigationLock(); }
  };
  const remove = async () => {
    if (!selected || deleting || batch.active) return;
    setDeleting(true); setMutationError(false);
    try { await api.moveToTrash(selected.id); setRevision((value) => value + 1); }
    catch { setMutationError(true); }
    finally { setDeleting(false); }
  };
  return <section className="text-history" aria-label={t("Text History")} onKeyDown={batch.onKeyDown}>
    <div className="record-workspace-toolbar">
      <label className="text-history__search"><KiriIcon name="magnifyingglass" size={15} />
        <input ref={search} type="search" value={query} disabled={editing || saving || batch.busy}
          onChange={(event) => { if (!editingRef.current && !savingRef.current && !batch.busy) setQuery(event.target.value); }}
          placeholder={t("Search recognized text")} aria-label={t("Search recognized text")} />
      </label>
      {batch.controls}
    </div>
    <aside className="text-history__sidebar">
      <div className="text-history__list" aria-label={t("Text History")} aria-busy={loading}>
        {visibleRecords.map((record) => batch.active ? <label key={record.id} className="ocr-history__item record-selection__item">
          {batch.checkbox(record.id)}<span className="record-selection__text"><span className="text-history__excerpt">{record.ocrText}</span>
          <time>{new Date(record.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></span>
        </label> : <button type="button" key={record.id} className="ocr-history__item"
          aria-current={selectedId === record.id ? "true" : undefined} disabled={editing || saving}
          onClick={() => { if (editingRef.current || savingRef.current) return; setSelectedId(record.id); setMutationError(false); }}>
          <span className="text-history__excerpt">{record.ocrText}</span>
          <time dateTime={new Date(record.createdAt).toISOString()}>{new Date(record.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
        </button>)}
      </div>
    </aside>
    <main className="text-history__detail">
      {loadError && !editing ? <div className="text-history__empty" role="alert"><p>{t("Couldn't load Text History.")}</p><button type="button" className="kiri-button kiri-button--secondary" onClick={() => setRevision((v) => v + 1)}>{t("Retry")}</button></div> :
        selected ? <>
          {loadError && <p role="alert" className="text-history__error">{t("Couldn't load Text History.")}</p>}
          {mutationError && <p role="alert" className="text-history__error">{t("Couldn't move this text to Trash.")}</p>}
          {editError && <p role="alert" className="text-history__error">{t("Couldn't save the text. Reload Text History and try again.")}</p>}
          <TextReader actionsDisabled={batch.active} key={selected.id} text={selected.ocrText ?? ""} imageId={selected.id}
            heading={<div className="text-history__record-heading">
              <time title={new Date(selected.createdAt).toLocaleString()}>{new Date(selected.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
            </div>}
            actions={editing ? <>
                <button type="button" className="kiri-button kiri-button--secondary" disabled={saving} onClick={() => { if (savingRef.current) return; finishEditing(); setEditError(false); }}><KiriIcon name="xmark" size={14} />{t("Cancel")}</button>
                <button type="button" className="kiri-button kiri-button--primary" disabled={saving || !draft.trim()} onClick={() => void saveCorrection(draft)}><KiriIcon name="checkmark" size={14} />{t("Save")}</button>
              </> : <>
                <button type="button" className="kiri-button kiri-button--ghost" disabled={saving || deleting || batch.active} onClick={() => { if (savingRef.current || batch.active) return; editingRef.current = true; updateNavigationLock(); setDraft(selected.ocrText ?? ""); setEditBase({ id: selected.id, text: selected.ocrText ?? "", asset: selected }); setEditing(true); setEditError(false); }}><KiriIcon name="pencil.tip" size={14} />{t("Edit Text")}</button>
                <RecordMoreActions disabled={saving || deleting || batch.active}>
                {selected.ocrOriginalText != null && <button type="button" className="kiri-button kiri-button--secondary" disabled={saving || deleting || batch.active} onClick={() => void saveCorrection(null)}><KiriIcon name="arrow.uturn.backward" size={14} />{t("Restore Original Text")}</button>}
                <button type="button" className="kiri-button kiri-button--destructive" disabled={deleting || loading || saving || batch.active} onClick={() => void remove()}><KiriIcon name="trash" size={14} />{t("Move to Trash")}</button>
                </RecordMoreActions>
              </>}
            editor={editing ? <textarea autoFocus className="text-reader__editor" value={draft} disabled={saving}
              onChange={(event) => { if (!savingRef.current) setDraft(event.target.value); }}
              onCompositionStart={event => setTextComposition(event.currentTarget, true)}
              onCompositionEnd={event => setTextComposition(event.currentTarget, false)}
              onBlur={event => setTextComposition(event.currentTarget, false)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || isTextComposition(event)) return;
                event.preventDefault(); event.stopPropagation();
                if (!savingRef.current) { finishEditing(); setEditError(false); }
              }}
              aria-label={t("Edit recognized text")} maxLength={1024 * 1024} /> : undefined} />
        </> : <div className="text-history__empty" role="status"><KiriIcon name="text.viewfinder" size={32} />
          <h2>{t(loading ? "Loading…" : query ? "No matching text" : "Your text, ready to revisit")}</h2>
          {!loading && <p>{t(query ? "Try another word or clear the search." : "Recognize text from your screen or a saved screenshot. It will appear here.")}</p>}
        </div>}
    </main>
  </section>;
}
