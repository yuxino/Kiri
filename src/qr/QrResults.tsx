import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { QrCode, Copy, ExternalLink, Star, X, Trash2, ChevronRight } from "lucide-react";
import { api, mediaUrl, onLibraryChanged, type AssetDto, type QrCodeDto, type QrScanDto } from "../lib/ipc";
import { t, fmt } from "../i18n";
import type { Rect } from "../annotation/geom";
import { initialQrSelection, qrCodeCenter, qrContentType, qrLooksLikeLink } from "./selection.js";
import "../ocr/text-history.css";
import "./qr.css";

export function QrDetails({ code, action, saved = false, removable = false, autoSaving = false, autoSaveError = null, preview, meta }: {
  code: QrCodeDto; action(action: string): Promise<unknown>; saved?: boolean; removable?: boolean; autoSaving?: boolean; autoSaveError?: string | null; preview?: ReactNode; meta?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const [favorite, setFavorite] = useState(saved);
  const contentType = qrContentType(code);
  const linkWarning = code.suspicious && contentType !== "WeChat" && (!!code.url || qrLooksLikeLink(code.text ?? ""));
  const directionWarning = code.text?.includes("\u202e") === true;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setFavorite(saved); }, [saved]);
  const run = async (name: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setMessage("");
    try {
      await action(name);
      if (!mounted.current) return;
      if (name === "favorite") setFavorite(true);
      if (name === "unfavorite" || name === "remove") setFavorite(false);
      setMessage(t(name === "copy" || name === "copyImage" ? "Copied to Clipboard" : name === "favorite" ? "Saved to QR Favorites" : name === "remove" || name === "unfavorite" ? "Moved to Trash" : "Link opened"));
    } catch (error) {
      if (mounted.current) setMessage(t(typeof error === "string" ? error : "Could not complete this QR action."));
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const controls = code.text ? (
    <div className="qr-actions">
      {code.url && <button type="button" className="kiri-button kiri-button--primary" disabled={busy} onClick={() => void run("open")}><ExternalLink size={14}/>{t("Open Link")}</button>}
      <button type="button" className={`kiri-button ${code.url ? "kiri-button--secondary" : "kiri-button--primary"}`} disabled={busy} onClick={() => void run("copy")}><Copy size={14}/>{t("Copy Text")}</button>
      {!removable && <button type="button" className="kiri-button kiri-button--secondary" disabled={busy || autoSaving} onClick={() => void run(favorite ? "unfavorite" : "favorite")}><Star size={14} fill={favorite ? "currentColor" : "none"}/>{t(autoSaving ? "Saving…" : favorite ? "Remove Favorite" : "Save QR Code")}</button>}
      {removable && <>
        <button type="button" className="kiri-button kiri-button--secondary" disabled={busy} onClick={() => void run("copyImage")}><QrCode size={14}/>{t("Copy QR Image")}</button>
        <button type="button" className="kiri-button kiri-button--secondary" disabled={busy} onClick={() => void run("remove")}><Trash2 size={14}/>{t("Remove Favorite")}</button>
      </>}
    </div>
  ) : null;
  return <section className={`qr-details${removable ? " qr-details--saved" : ""}`} aria-label={t("QR Content")}>
    <header className="qr-details__header">
      <div className="text-history__record-heading">
        <span className="text-reader__caption qr-content-type">{t(code.text ? contentType : "QR Content")}</span>
        {meta}
      </div>
      {removable && controls}
    </header>
    <div className="qr-details__body">
      {preview}
      <div className="qr-details__content">
        <div className="qr-content" tabIndex={0}>{code.text ?? t("This QR code could not be decoded. Try a clearer image.")}</div>
        {code.text && <>
          {code.host && <p className="qr-host">{t("Destination")}: <bdi>{code.host}</bdi></p>}
          {(linkWarning || directionWarning) && <p className="qr-warning" role="note">{t(linkWarning ? "Review this content carefully. This link may be unsafe." : "Review this content carefully.")}</p>}
          {!code.url && linkWarning && <p className="qr-warning">{t("Only explicit HTTP or HTTPS links without credentials can be opened.")}</p>}
          {!removable && controls}
        </>}
      </div>
    </div>
    {autoSaveError && <p className="qr-feedback" role="status">{t(autoSaveError)}</p>}
    {message && <p className="qr-feedback" role="status">{message}</p>}
  </section>;
}

export function QrResults({ scan, onOpened, sourceRect, viewport, onClose }: {
  scan: QrScanDto;
  onOpened?(): void;
  sourceRect?: Rect;
  viewport?: Rect;
  onClose?(): void;
}) {
  const [selected, setSelected] = useState<number | null>(() => initialQrSelection(scan.codes));
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [autoSaving, setAutoSaving] = useState<Set<string>>(() => new Set());
  const [saveErrors, setSaveErrors] = useState<Map<string, string>>(() => new Map());
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const autoAttempts = useRef(new Set<string>());
  const pendingAutoSave = useRef(new Map<string, Promise<unknown>>());
  const mounted = useRef(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(240);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const code = scan.codes.find(code => code.index === selected);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => setPanelHeight(panel.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    panel.focus({ preventScroll: true });
    return () => observer.disconnect();
  }, [selected, sourceRect?.width, viewport?.width, viewport?.height]);
  const onMarkerSelect = (index: number) => {
    if (openingRef.current) return;
    setSelected(index);
    const target = scan.codes.find(code => code.index === index);
    if (!target?.text || autoAttempts.current.has(target.text)) return;
    const text = target.text;
    autoAttempts.current.add(text);
    setAutoSaving(previous => new Set(previous).add(text));
    const pending = Promise.resolve().then(() => api.qrAction(scan.requestId, index, "favorite"))
      .then(result => {
        if (mounted.current) setFavorites(previous => new Set(previous).add(text));
        return result;
      })
      .catch(error => {
        if (mounted.current) setSaveErrors(previous => new Map(previous).set(text, typeof error === "string" ? error : "Could not save this QR code."));
        throw error;
      })
      .finally(() => {
        pendingAutoSave.current.delete(text);
        if (mounted.current) setAutoSaving(previous => {
          const next = new Set(previous); next.delete(text); return next;
        });
      });
    pendingAutoSave.current.set(text, pending);
    // A failed automatic save stays visible and can be retried with Save QR Code.
    void pending.catch(() => {});
  };
  const targets = <div className="qr-targets" role="group" aria-label={t("Choose a QR code in the image")}>
        {scan.codes.map(code => {
          const center = qrCodeCenter(code.corners);
          return <button type="button" key={code.index} className="kiri-qr-marker" disabled={opening} style={{ left: `${center[0] * 100}%`, top: `${center[1] * 100}%` }} aria-pressed={selected === code.index} aria-label={fmt("QR code %d", code.index + 1)} onClick={() => onMarkerSelect(code.index)}>
            <ChevronRight size={18} strokeWidth={2.5} aria-hidden="true"/>
          </button>;
        })}
      </div>;
  const details = code ? <QrDetails key={code.index} code={code} saved={!!code.text && favorites.has(code.text)} autoSaving={!!code.text && autoSaving.has(code.text)} autoSaveError={code.text ? saveErrors.get(code.text) ?? null : null} action={async action => {
      const isOpen = action === "open";
      if (isOpen) {
        if (openingRef.current) return;
        openingRef.current = true; setOpening(true);
      }
      try {
        if (isOpen) {
          // Preserve every code already selected before opening tears down the scan.
          await Promise.allSettled([...pendingAutoSave.current.values()]);
        } else if (code.text && (action === "favorite" || action === "unfavorite")) {
          await pendingAutoSave.current.get(code.text)?.catch(() => {});
        }
        if (!mounted.current) return;
        const result = await api.qrAction(scan.requestId, code.index, action);
        if (isOpen && mounted.current) onOpened?.();
        if (mounted.current && code.text && (action === "favorite" || action === "unfavorite")) setFavorites(previous => {
          const next = new Set(previous);
          if (action === "favorite") next.add(code.text!); else next.delete(code.text!);
          return next;
        });
        if (mounted.current && code.text && action === "favorite") setSaveErrors(previous => {
          const next = new Map(previous); next.delete(code.text!); return next;
        });
        return result;
      } finally {
        if (isOpen) {
          openingRef.current = false;
          if (mounted.current) setOpening(false);
        }
      }
    }}/> : null;
  if (sourceRect && viewport) {
    const center = code ? qrCodeCenter(code.corners) : [0, 0];
    const anchor = { x: sourceRect.x + center[0] * sourceRect.width, y: sourceRect.y + center[1] * sourceRect.height };
    const margin = 12;
    const width = Math.min(340, Math.max(0, viewport.width - margin * 2));
    const minLeft = viewport.x + margin;
    const maxLeft = Math.max(minLeft, viewport.x + viewport.width - width - margin);
    const preferredLeft = anchor.x + 26 + width <= viewport.x + viewport.width - margin ? anchor.x + 26 : anchor.x - width - 26;
    const left = Math.min(maxLeft, Math.max(minLeft, preferredLeft));
    const minTop = viewport.y + margin;
    const top = Math.min(Math.max(minTop, viewport.y + viewport.height - panelHeight - margin), Math.max(minTop, anchor.y - 26));
    return <div className="qr-results-inline">
      <div className="qr-inline-source" style={{ left: sourceRect.x, top: sourceRect.y, width: sourceRect.width, height: sourceRect.height }}>{targets}</div>
      {code && <div ref={panelRef} className="qr-inline-panel" role="dialog" aria-label={t("QR Content")} tabIndex={-1} style={{ left, top, width, maxHeight: Math.max(0, viewport.height - margin * 2) }}>
        {onClose && <button type="button" className="kiri-icon-button qr-inline-close" aria-label={t("Close")} onClick={onClose}><X size={16}/></button>}
        {details}
      </div>}
    </div>;
  }
  return <div className="qr-results">
    <div className="qr-image-scroll"><div className="qr-image-stage">
      <img src={scan.imageUrl} alt={t("QR Source Image")} draggable={false}/>
      {targets}
    </div></div>
    {details ??
      <div className="qr-prompt" role="status"><QrCode size={28}/><p>{t(scan.codes.length ? "Choose a QR code in the image" : "No QR codes found. Try a clearer image or a larger selection.")}</p></div>}
  </div>;
}

export function QrFavorites() {
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<{ query: string; records: AssetDto[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [failedQuery, setFailedQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => { const subscription = onLibraryChanged(() => setRevision(n => n + 1)); return () => { void subscription.then(stop => stop()).catch(() => {}); }; }, []);
  useEffect(() => {
    let current = true; setFailedQuery(null); setLoading(true);
    const timer = setTimeout(() => { void api.listQrFavorites(query).then(items => {
      if (!current) return;
      setSnapshot({ query, records: items }); setSelected(id => items.some(a => a.id === id) ? id : items[0]?.id ?? null); setLoading(false);
    }, () => { if (current) { setFailedQuery(query); setLoading(false); setSnapshot(null); } }); }, query ? 150 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [query, revision]);
  // A new search cannot inherit another query's selectable records or actions.
  // Refreshes for the same query retain their last acknowledged snapshot.
  const records = snapshot?.query === query ? snapshot.records : [];
  const error = failedQuery === query;
  const loadingResults = loading || snapshot?.query !== query;
  const asset = records.find(a => a.id === selected);
  return <div className="text-history">
    <aside className="text-history__sidebar"><label className="text-history__search"><QrCode size={15}/><input type="search" aria-label={t("Search QR Favorites")} placeholder={t("Search QR Favorites")} value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="text-history__list">{records.map(asset => <button type="button" className="ocr-history__item" aria-current={asset.id === selected || undefined} key={asset.id} onClick={() => setSelected(asset.id)}><span className="text-history__excerpt">{asset.qrText}</span><time>{new Date(asset.createdAt).toLocaleString()}</time></button>)}</div>
    </aside>
    <main className="text-history__detail">{asset ? <QrDetails key={asset.id} code={favoriteCode(asset.qrText ?? "")} saved removable
      meta={<time>{new Date(asset.createdAt).toLocaleString()}</time>}
      preview={<img className="qr-favorite-image" src={mediaUrl(asset.id)} alt={t("QR Source Image")} />}
      action={action => api.qrFavoriteAction(asset.id, action)} /> : <div className="text-history__empty" role={error ? "alert" : "status"}><QrCode size={28}/><p>{t(error ? "Could not load QR Favorites." : loadingResults ? "Loading…" : query ? "No QR favorites match this search." : "Save a QR code to find and reuse it here.")}</p></div>}</main>
  </div>;
}

function favoriteCode(text: string): QrCodeDto {
  // The backend repeats URL validation before every explicit open action.
  let url: URL | null = null;
  try { if (/^https?:\/\//i.test(text) && !/[\s\\\u0000-\u001f\u007f\u202e]/.test(text)) { const parsed = new URL(text); if (!parsed.username && !parsed.password) url = parsed; } } catch { /* Plain content. */ }
  return { index: 0, corners: [], text, url: url?.href ?? null, host: url?.hostname ?? null, suspicious: text.includes("\u202e") || (url ? /xn--|localhost|^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) : qrLooksLikeLink(text)) };
}
