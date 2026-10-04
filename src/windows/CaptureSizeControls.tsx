import { useState } from "react";
import type { Rect } from "../annotation/geom";
import { t } from "../i18n";
import { capturePixelSize, captureSizePositions } from "./capture-size.js";
import "./capture-size.css";

export function CaptureSizeControls(props: {
  rect: Rect;
  bounds: Rect;
  scale: number;
  interactive: boolean;
  onChange(axis: "width" | "height", pixels: number): void;
}) {
  const pixels = capturePixelSize(props.rect, props.scale);
  const sizes = {
    width: { width: Math.max(48, String(pixels.width).length * 8 + 20), height: 24 },
    height: { width: Math.max(48, String(pixels.height).length * 8 + 20), height: 24 },
  };
  const positions = captureSizePositions(props.rect, props.bounds, sizes);
  return <>{(["width", "height"] as const).map(axis => <DimensionField
    key={axis} axis={axis} value={pixels[axis]} interactive={props.interactive}
    style={{ ...positions[axis], width: sizes[axis].width }}
    onChange={value => props.onChange(axis, value)}
  />)}</>;
}

function DimensionField(props: {
  axis: "width" | "height";
  value: number;
  interactive: boolean;
  style: React.CSSProperties;
  onChange(value: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const label = t(props.axis === "width" ? "Width (px)" : "Height (px)");
  const commit = (input: HTMLInputElement) => {
    const text = input.value.trim();
    if (/^\d+$/.test(text)) props.onChange(Number(text));
    setDraft(null);
  };
  return <label className="kiri-capture-dimension" style={props.style}
    data-axis={props.axis}
    data-interactive={props.interactive || undefined}
    onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()}
    onContextMenu={event => event.stopPropagation()}
  >
    <input className="kiri-capture-dimension-input" aria-label={label} title={label}
      type="text" inputMode="numeric" pattern="[0-9]*" spellCheck={false}
      value={draft ?? String(props.value)} readOnly={!props.interactive}
      tabIndex={props.interactive ? 0 : -1}
      onFocus={event => { setDraft(String(props.value)); event.currentTarget.select(); }}
      onChange={event => setDraft(event.target.value)}
      onBlur={event => commit(event.currentTarget)}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget);
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          // Blur must see the original value, not the discarded draft.
          event.currentTarget.value = String(props.value);
          setDraft(null);
          event.currentTarget.blur();
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const current = Number(event.currentTarget.value);
          const step = (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
          const next = Math.max(1, (Number.isSafeInteger(current) ? current : props.value) + step);
          props.onChange(next);
          setDraft(null);
        }
      }}
    />
  </label>;
}
