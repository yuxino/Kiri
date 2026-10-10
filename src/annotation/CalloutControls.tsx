import React, {useCallback, useRef} from "react";
import {COLOR_HEX, COLOR_LABELS, COLOR_PRESETS, type AppearanceSettings, type CalloutMark} from "./model";
import {isTextComposition, setTextComposition} from "./text-composition.js";
import {t} from "../i18n";
import "./callout-controls.css";

interface Props {
  selected: CalloutMark | null;
  nextNumber: number;
  appearance: AppearanceSettings;
  onNextNumber(value: number): void;
  onAppearance(patch: Partial<AppearanceSettings>): void;
  onEdit(patch: Partial<Omit<CalloutMark, "kind" | "id">>): void;
  onFinish(): void;
}

function CalloutDescription({text, disabled, onChange, onFinish}: {
  text: string;
  disabled: boolean;
  onChange(text: string): void;
  onFinish(): void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const initialText = useRef(text);
  const attachTextarea = useCallback((element: HTMLTextAreaElement | null) => {
    // Match TextEditor: the native editor owns the live value, caret, IME and
    // undo stack. Canvas selection echoes must never write old text back.
    if (element && element !== ref.current) element.value = initialText.current;
    if (!element && ref.current) setTextComposition(ref.current, false);
    ref.current = element;
  }, []);
  return <textarea ref={attachTextarea} rows={2} maxLength={1000} disabled={disabled}
    aria-label={t("Description (optional)")} placeholder={t(disabled ? "Place a number to add a description" : "Add a description…")}
    onChange={event => onChange(event.currentTarget.value)}
    onCompositionStart={event => setTextComposition(event.currentTarget, true)}
    onCompositionEnd={event => setTextComposition(event.currentTarget, false)}
    onBlur={event => {setTextComposition(event.currentTarget, false); onFinish();}}
    onKeyDown={event => {
      event.stopPropagation();
      if (isTextComposition(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.currentTarget.blur();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        // Match the normal text editor, including WebKitGTK's native history.
        if (event.currentTarget.ownerDocument.execCommand(event.shiftKey ? "redo" : "undo")) event.preventDefault();
      }
    }}/>;
}

export function CalloutControls({selected, nextNumber, appearance, onNextNumber, onAppearance, onEdit, onFinish}: Props) {
  const size = selected?.size ?? appearance.calloutSize;
  const fontSize = selected?.fontSize ?? appearance.textFontSize;
  const style = selected?.style ?? appearance.calloutStyle;
  const color = selected?.color ?? appearance.colorPreset;
  const slider = (label: string, value: number, min: number, max: number, change: (value: number) => void) =>
    <label className="kiri-callout-slider"><span>{t(label)}</span>
      <input type="range" className="kiri-range" aria-label={t(label)} min={min} max={max} value={value}
        onChange={event => change(Number(event.target.value))} onPointerUp={onFinish} onKeyUp={onFinish} onBlur={onFinish}
        onKeyDown={event => {if (event.key !== "Escape") event.stopPropagation();}}/>
      <output>{Math.round(value)}</output>
    </label>;
  return <div className="kiri-callout-controls kiri-hud" onPointerDown={event => event.stopPropagation()}>
    <div className="kiri-callout-row">
      <label className="kiri-callout-number"><span>{t(selected ? "Number" : "Next number")}</span>
        <input type="number" min={1} max={999} value={selected?.number ?? nextNumber} aria-label={t(selected ? "Number" : "Next number")}
          onChange={event => {const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 999) {
            if (selected) onEdit({number: value}); else onNextNumber(value);
          }}} onBlur={onFinish} onKeyDown={event => event.stopPropagation()}/>
      </label>
      <div className="kiri-callout-styles" role="group" aria-label={t("Number style")}>
        {(["filled", "outline"] as const).map(value => <button type="button" className="kiri-callout-style-button" key={value} aria-pressed={style === value}
          onClick={() => {onAppearance({calloutStyle: value}); if (selected) onEdit({style: value}); onFinish();}}>
          <span className={`kiri-callout-style-preview kiri-callout-style-preview--${value}`}>1</span>
          {t(value === "filled" ? "Filled" : "Outline")}
        </button>)}
      </div>
    </div>
    <label className="kiri-callout-description"><span>{t("Description (optional)")}</span>
      {/* Canvas Undo/Redo and revision loads clear selection. The changed key
          initializes a new native editor when this or another mark is picked. */}
      <CalloutDescription key={selected?.id ?? "empty"} text={selected?.text ?? ""} disabled={!selected}
        onChange={text => onEdit({text})} onFinish={onFinish}/>
    </label>
    <div className="kiri-callout-row">
      {slider("Number size", size, 24, 72, value => {onAppearance({calloutSize: value}); if (selected) onEdit({size: value});})}
      {slider("Font", fontSize, 12, 64, value => {onAppearance({textFontSize: value}); if (selected) onEdit({fontSize: value});})}
    </div>
    <div className="kiri-callout-colors" role="group" aria-label={t("Color")}>
      {COLOR_PRESETS.map(preset => <button type="button" className="kiri-callout-swatch" key={preset} title={t(COLOR_LABELS[preset])}
        aria-label={t(COLOR_LABELS[preset])} aria-pressed={color === preset} style={{"--swatch": COLOR_HEX[preset]} as React.CSSProperties}
        onClick={() => {onAppearance({colorPreset: preset}); if (selected) onEdit({color: preset}); onFinish();}}/>) }
      <span>{t("Drag the dots to move the number or description")}</span>
    </div>
  </div>;
}
