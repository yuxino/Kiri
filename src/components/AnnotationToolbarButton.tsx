import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { KiriIcon, type IconName } from "./KiriIcons";
import "./annotation-toolbar.css";

export function toolbarShortcut(shortcut: string, mac = /Mac|iPhone|iPad/.test(navigator.platform)) {
  const parts = shortcut.split("+");
  const displayParts = mac && parts.includes("Shift")
    ? ["Shift", ...parts.filter(part => part !== "Shift")] : parts;
  return {
    label: displayParts.map(part => part === "Mod" ? (mac ? "⌘" : "Ctrl")
      : part === "Shift" ? (mac ? "⇧" : "Shift")
      : part === "Escape" ? "Esc" : part === "Enter" && mac ? "Return" : part).join(mac ? "" : "+"),
    aria: parts.map(part => part === "Mod" ? (mac ? "Meta" : "Control") : part).join("+"),
  };
}

type Props = {
  icon: IconName;
  title: string;
  shortcut?: string;
  active?: boolean;
  expanded?: boolean;
  primary?: boolean;
  disabled?: boolean;
  onClick(): void;
};

/** Tool letters stay visible; action chords belong with the full tooltip. */
export function AnnotationToolbarButton(props: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const tooltipId = useId();
  const key = props.shortcut ? toolbarShortcut(props.shortcut) : null;
  const visibleKey = key && (props.primary || /^[A-Z]$/.test(key.label))
    ? props.primary && props.shortcut === "Enter" ? "↵" : key.label : null;
  const tooltipTitle = key && !props.title.includes(key.label) ? `${props.title} · ${key.label}` : props.title;
  const showTooltip = hovered || focused;
  return <>
    <button ref={button} type="button" className="kiri-toolbar-button kiri-annotation-toolbar-button"
      data-active={props.active || undefined}
      data-primary={props.primary || undefined}
      data-key={!!visibleKey || undefined}
      aria-label={props.title} aria-pressed={props.active} aria-expanded={props.expanded}
      aria-keyshortcuts={key?.aria} aria-describedby={showTooltip ? tooltipId : undefined}
      disabled={props.disabled}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onKeyDown={event => {
        // Focused actions own activation; do not also confirm the whole capture.
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }} onClick={props.onClick}>
      <span className="kiri-annotation-toolbar-glyph"><KiriIcon name={props.icon} size={18}/></span>
      {visibleKey && <kbd className="kiri-annotation-toolbar-key" aria-hidden="true">{visibleKey}</kbd>}
    </button>
    {showTooltip && <ToolbarTooltip id={tooltipId} anchor={button.current} title={tooltipTitle}/>}
  </>;
}

function ToolbarTooltip(props: {id: string; anchor: HTMLButtonElement | null; title: string}) {
  const tooltip = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({left: 8, top: 8});
  useLayoutEffect(() => {
    const anchor = props.anchor, tip = tooltip.current;
    if (!anchor || !tip) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = tip.offsetWidth, height = tip.offsetHeight;
      setPosition({
        left: Math.max(8, Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect.top >= height + 16 ? rect.top - height - 8 : rect.bottom + 8,
          window.innerHeight - height - 8)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [props.anchor, props.title]);
  return createPortal(<div ref={tooltip} id={props.id} role="tooltip"
    className="kiri-annotation-toolbar-tooltip" style={position}>{props.title}</div>, document.body);
}
