import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { KiriIcon } from "../components/KiriIcons";
import { api } from "../lib/ipc";
import { t } from "../i18n";

type Folder = Parameters<typeof api.openSupportFolder>[0];

export function SupportLinks({ isWindows }: { isWindows: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const running = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const project = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const folders: { value: Folder; label: string }[] = [
    { value: "settings", label: "Settings Folder" },
    { value: "logs", label: "Logs Folder" },
    ...(isWindows ? [
      { value: "errors" as const, label: "Error Logs Folder" },
      { value: "temporary" as const, label: "Temporary Folder" },
    ] : []),
  ];
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(240, window.innerWidth - 16);
      const height = Math.min(folders.length * 40 + 14, window.innerHeight - 16);
      const below = rect.bottom + 6;
      const above = rect.top - height - 6;
      const top = below + height <= window.innerHeight - 8 ? below
        : above >= 8 ? above : Math.max(8, window.innerHeight - height - 8);
      setPosition({ position: "fixed", width, maxHeight: height,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top });
    };
    place();
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, isWindows]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);

  const run = async (folder?: Folder) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null); close(Boolean(folder));
    try { if (folder) await api.openSupportFolder(folder); else await api.openProjectPage(); }
    catch { setError(folder ? "Couldn't open folder" : "Couldn't open the project page."); }
    finally { running.current = false; setBusy(false); }
  };

  return <>
    <button ref={trigger} type="button" className="kiri-button kiri-button--secondary" disabled={busy}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
      }}>
      <KiriIcon name="folder" size={15} />{t("Open Folder")}<ChevronDown size={14} />
    </button>
    <button ref={project} type="button" className="kiri-button kiri-button--secondary" disabled={busy} onClick={() => void run()}>
      GitHub<KiriIcon name="arrow.up.right" size={15} />
    </button>
    {error && <span className="kiri-support-copy-status" role="alert">{t(error)}</span>}
    {open && createPortal(<div ref={menu} id={id} className="kiri-support-menu" role="menu" aria-label={t("Open Folder")}
      style={position} onKeyDown={event => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault(); event.stopPropagation(); close();
          (event.key === "Tab" && !event.shiftKey ? project : trigger).current?.focus();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {folders.map(folder => <button type="button" role="menuitem" key={folder.value}
        className="kiri-button kiri-button--ghost" onClick={() => void run(folder.value)}>{t(folder.label)}</button>)}
    </div>, document.body)}
  </>;
}
