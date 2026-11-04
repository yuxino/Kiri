import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../lib/ipc";
import { t } from "../i18n";
import { KiriIcon } from "../components/KiriIcons";
import { isTextComposition } from "../annotation/text-composition.js";

/** Shared, query-scoped selection for the text and QR record lists. */
export function useRecordSelection({ query, ids, loading, disabled = false, onDeleted }: {
  query: string; ids: string[]; loading: boolean; disabled?: boolean; onDeleted(ids: string[]): void;
}) {
  const [state, setState] = useState<{ query: string; active: boolean; ids: Set<string> }>({ query, active: false, ids: new Set() });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(false);
  const [done, setDone] = useState(false);
  const active = state.query === query && state.active;
  const selected = active ? ids.filter(id => state.ids.has(id)) : [];
  const locked = busy || disabled || loading;
  const idsKey = JSON.stringify(ids);
  useEffect(() => {
    setState(previous => previous.query !== query
      ? { query, active: false, ids: new Set() }
      : { ...previous, ids: new Set([...previous.ids].filter(id => ids.includes(id))) });
  }, [query, idsKey]);
  useEffect(() => { setError(false); setDone(false); }, [query]);
  const cancel = () => {
    if (busyRef.current || disabled) return;
    setState({ query, active: false, ids: new Set() }); setError(false);
  };
  const toggle = (id: string) => {
    if (locked || busyRef.current || !active || !ids.includes(id)) return;
    setError(false);
    setState(previous => {
      const next = new Set(previous.ids);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { query, active: true, ids: next };
    });
  };
  const selectAll = () => {
    if (locked || busyRef.current) return;
    setError(false); setState({ query, active: true, ids: new Set(ids) });
  };
  const remove = async () => {
    if (locked || busyRef.current || !selected.length) return;
    busyRef.current = true; setBusy(true); setError(false); setDone(false);
    try {
      await api.batchMoveToTrash(selected);
      onDeleted(selected);
      setState({ query, active: false, ids: new Set() }); setDone(true);
    } catch { setError(true); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement> | globalThis.KeyboardEvent) => {
    if (!active || isTextComposition(event)) return;
    const target = event.target as HTMLElement;
    if (target?.closest?.("input:not([type=checkbox]), textarea, [contenteditable=true]")) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); event.stopPropagation(); selectAll();
    }
  };
  // WebKit mouse/AX activation need not focus the clicked button. Keep batch
  // shortcuts available when focus remains on the document outside this section.
  useEffect(() => {
    if (!active) return;
    const keydown = (event: globalThis.KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [active, onKeyDown]);
  const allSelected = ids.length > 0 && selected.length === ids.length;
  const controls = <div className="record-selection__controls" data-selecting={active || undefined} aria-busy={busy}>
    {active && <>
      <span role="status" className="record-selection__count">{t("Selected {n}").replace("{n}", String(selected.length))}</span>
      <button type="button" className="kiri-button kiri-button--ghost" disabled={locked || !ids.length}
        onClick={() => {
          if (!locked && !busyRef.current && allSelected) { setState({ query, active: true, ids: new Set() }); setError(false); }
          else selectAll();
        }}>{t(allSelected ? "Deselect All" : "Select All")}</button>
      <button type="button" className="kiri-button kiri-button--destructive" disabled={locked || !selected.length} onClick={() => void remove()}>
        <KiriIcon name="trash" size={14} />{t("Move to Trash ({n})").replace("{n}", String(selected.length))}
      </button>
    </>}
    {done && <span role="status">{t("Moved to Trash")}</span>}
    <button type="button" className="kiri-button kiri-button--ghost" aria-pressed={active}
      disabled={busy || disabled || (!active && (loading || !ids.length))}
      onClick={() => {
        if (active) cancel();
        else if (!locked && !busyRef.current) { setState({ query, active: true, ids: new Set() }); setDone(false); }
      }}>{t(active ? "Cancel" : "Select records")}</button>
    {error && <p role="alert" className="text-history__error">{t("Couldn't move these records to Trash. Try again.")}</p>}
  </div>;
  const checkbox = (id: string) => <input type="checkbox" checked={selected.includes(id)} disabled={locked}
    aria-label={t("Select record")} onChange={() => toggle(id)} />;
  return { active, busy, locked, controls, checkbox, onKeyDown };
}
