import {useEffect, useLayoutEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {KiriIcon} from "../components/KiriIcons";
import {t} from "../i18n";
import type {Tool} from "./model";
import "./callout-controls.css";

/** Text and numbered notes share one slot, keeping both capture toolbars compact. */
export function TextToolPicker({tool, onSelect}: {tool: Tool | "crop"; onSelect(tool: "text" | "callout"): void}) {
  const [choice, setChoice] = useState<"text" | "callout">(tool === "callout" ? "callout" : "text");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({left: 0, top: 0});
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const active = tool === "text" || tool === "callout";
  useEffect(() => {if (active) setChoice(tool as "text" | "callout");}, [tool, active]);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 124;
    setPosition({left: Math.max(8, Math.min(window.innerWidth - 204, rect.left)),
      top: rect.bottom + height + 8 < window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - height - 8)});
    menu.current?.querySelector<HTMLButtonElement>("[aria-checked=true]")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", close);
    return () => {window.removeEventListener("pointerdown", dismiss); window.removeEventListener("resize", close);};
  }, [open]);
  return <div className="kiri-text-tool">
    <button type="button" className="kiri-text-tool-main" aria-pressed={active}
      title={t(choice === "text" ? "Text (T)" : "Numbered callout (N)")}
      aria-label={t(choice === "text" ? "Text (T)" : "Numbered callout (N)")}
      onClick={() => onSelect(choice)}><KiriIcon name={choice === "text" ? "textformat" : "number.circle"} size={16}/></button>
    <button ref={anchor} type="button" className="kiri-text-tool-toggle" aria-label={t("Text tools")}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
    </button>
    {open && createPortal(<div ref={menu} role="menu" className="kiri-text-tool-menu kiri-dark" style={position}
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape") {event.preventDefault(); setOpen(false); anchor.current?.focus();}
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        }
      }}>
      {(["text", "callout"] as const).map(value => <button key={value} type="button" className="kiri-text-tool-option" role="menuitemradio"
        aria-checked={choice === value} onClick={() => {setChoice(value); setOpen(false); onSelect(value); anchor.current?.focus();}}>
        <KiriIcon name={value === "text" ? "textformat" : "number.circle"}/>
        <span>{t(value === "text" ? "Text" : "Numbered callout")}</span><kbd>{value === "text" ? "T" : "N"}</kbd>
      </button>)}
    </div>, document.body)}
  </div>;
}
