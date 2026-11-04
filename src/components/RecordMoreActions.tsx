import { useEffect, useRef, type ReactNode } from "react";
import { KiriIcon } from "./KiriIcons";
import { t } from "../i18n";

/** Low-frequency record actions share one keyboard-accessible overflow menu. */
export function RecordMoreActions({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !menu.current?.open) return;
      event.preventDefault(); event.stopPropagation(); menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    };
    const blur = () => { if (menu.current) menu.current.open = false; };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => { if (disabled && menu.current) menu.current.open = false; }, [disabled]);
  return <details className="record-more" ref={menu} onKeyDown={event => {
    if (event.key === "Escape" && menu.current?.open) {
      event.preventDefault(); event.stopPropagation(); menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    }
  }}>
    <summary className="kiri-icon-button" aria-label={t("More Actions")} title={t("More Actions")}
      aria-disabled={disabled} onClick={event => { if (disabled) event.preventDefault(); }}>
      <KiriIcon name="ellipsis.circle" size={16} />
    </summary>
    <div className="record-more__menu" onClick={event => {
      if ((event.target as HTMLElement).closest("button") && menu.current) menu.current.open = false;
    }}>{children}</div>
  </details>;
}
