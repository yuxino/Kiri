import React from "react";
import {COLOR_HEX, COLOR_LABELS, COLOR_PRESETS, type AppearanceSettings, type CalloutMark} from "./model";
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
      <textarea rows={2} maxLength={1000} value={selected?.text ?? ""} disabled={!selected}
        aria-label={t("Description (optional)")} placeholder={t(selected ? "Add a description…" : "Place a number to add a description")}
        onChange={event => onEdit({text: event.target.value})} onBlur={onFinish}
        onKeyDown={event => {event.stopPropagation(); if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.currentTarget.blur();
        }}}/>
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
