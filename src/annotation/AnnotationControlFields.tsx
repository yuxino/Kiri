import {useEffect, useRef, useState} from "react";
import {t} from "../i18n";
import {COLOR_HEX, COLOR_LABELS, COLOR_PRESETS, type ColorPreset} from "./model";

/** A drag (or a number edit) previews live and commits one history entry. */
export function AnnotationNumberControl(props: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange(value: number, transient: boolean): void; onFinish(): void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  const editing = useRef(false);
  const dragging = useRef(false);
  const step = props.step ?? 1;
  const min = Math.min(props.min, props.value), max = Math.max(props.max, props.value);
  useEffect(() => { if (!editing.current) setDraft(String(Math.round(props.value * 100) / 100)); }, [props.value]);
  function finish() {
    editing.current = false; dragging.current = false;
    setDraft(String(Math.round(props.value * 100) / 100));
    props.onFinish();
  }
  function point(event: React.PointerEvent<HTMLInputElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - 6) / Math.max(1, rect.width - 12)));
    props.onChange(Math.max(min, Math.min(max, min + Math.round(fraction * (max - min) / step) * step)), true);
  }
  return <label className="kiri-annotation-number">
    <span>{props.label}</span>
    <input type="range" className="kiri-range" aria-label={props.label} min={min} max={max} step={step} value={props.value}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId); point(event);
      }}
      onPointerMove={event => { if (dragging.current) point(event); }}
      onChange={event => props.onChange(Number(event.target.value), true)}
      onKeyDown={event => event.stopPropagation()}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { if (dragging.current) finish(); }}
      onKeyUp={props.onFinish} onBlur={props.onFinish}/>
    <input type="number" className="kiri-annotation-number-value" aria-label={props.label} min={min} max={max} step={step} value={draft}
      onFocus={() => { editing.current = true; }}
      onChange={event => {
        const text = event.target.value; setDraft(text);
        if (text.trim() === "") return;
        const value = Number(text);
        if (Number.isFinite(value) && value >= min && value <= max) props.onChange(value, true);
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); }
      }} onBlur={finish}/>
    {props.unit && <span className="kiri-annotation-unit">{props.unit}</span>}
  </label>;
}

export function AnnotationChoices<T extends string>(props: {
  label: string; value: T; options: {value: T; label: string; title?: string}[]; onChange(value: T): void;
}) {
  return <div className="kiri-annotation-choice" role="group" aria-label={props.label}>
    <span className="kiri-annotation-choice-label">{props.label}</span>
    <div className="kiri-toolbar-segments">
      {props.options.map(option => <button type="button" key={option.value} className="kiri-toolbar-segment"
        title={option.title ?? option.label} aria-pressed={props.value === option.value} data-active={props.value === option.value || undefined}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
        onClick={() => props.onChange(option.value)}>{option.label}</button>)}
    </div>
  </div>;
}

export function AnnotationColors(props: {value: ColorPreset; onChange(value: ColorPreset): void}) {
  return <div className="kiri-annotation-colors" role="group" aria-label={t("Color")}>
    {COLOR_PRESETS.map(color => <button type="button" key={color} className="kiri-annotation-swatch"
      title={t(COLOR_LABELS[color])} aria-label={t(COLOR_LABELS[color])} aria-pressed={props.value === color}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
      onClick={() => props.onChange(color)} style={{"--swatch": COLOR_HEX[color]} as React.CSSProperties}/>)}
  </div>;
}
