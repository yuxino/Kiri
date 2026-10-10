import {t} from "../i18n";
import type {AnnotationMark, AppearanceSettings, CalloutMark, Tool} from "./model";
import {AnnotationChoices, AnnotationColors, AnnotationNumberControl} from "./AnnotationControlFields";
import {MosaicControls} from "./MosaicControls";
import {WatermarkControls} from "./WatermarkControls";
import "./annotation-controls.css";

export function selectedAnnotationAppearance(appearance: AppearanceSettings, selected: AnnotationMark | null): AppearanceSettings {
  if (!selected) return appearance;
  if (selected.kind === "watermark") return {...appearance, watermarkColor: selected.color, watermarkFontSize: selected.fontSize,
    watermarkOpacity: Math.round(selected.opacity * 100), watermarkRotation: selected.rotation, watermarkMode: selected.mode, watermarkSpacing: selected.spacing};
  if (selected.kind === "mosaic") return {...appearance, mosaicShape: selected.shape ?? "brush", mosaicBrushDiameter: selected.brushDiameter,
    mosaicIntensity: selected.intensity, mosaicStyle: selected.style};
  if (selected.kind === "callout") return {...appearance, colorPreset: selected.color, calloutSize: selected.size,
    calloutStyle: selected.style, textFontSize: selected.fontSize};
  if (selected.kind === "text") return {...appearance, colorPreset: selected.color, textFontSize: selected.fontSize,
    textBackgroundStyle: selected.background, labelDirection: selected.labelDirection ?? appearance.labelDirection};
  return {...appearance, colorPreset: selected.color, ...(selected.kind === "pen" ? {penWidth: selected.width} : {shapeWidth: selected.width})};
}

export function AnnotationStyleControls(props: {
  tool: Tool; selected: AnnotationMark | null; appearance: AppearanceSettings; editing?: boolean; disabled?: boolean;
  nextNumber: number; onNextNumber(value: number): void; onCalloutEdit(patch: Partial<CalloutMark>, transient: boolean): void;
  onChange(patch: Partial<AppearanceSettings>, transient?: boolean): void; onFinish(): void; onEditText(): void; onEditWatermark(): void;
}) {
  const a = selectedAnnotationAppearance(props.appearance, props.selected);
  const kind = props.selected?.kind === "text" && props.selected.labelDirection ? "label" : props.selected?.kind ?? props.tool;
  const label = t(kind === "watermark" ? "Watermark" : kind === "callout" ? "Numbered callout" : kind === "label" ? "Label bubble" :
    kind === "mosaic" ? "Mosaic" : kind === "pen" ? "Pen" : kind === "rectangle" ? "Rectangle" : kind === "arrow" ? "Arrow" : kind === "line" ? "Line" : kind === "text" ? "Text" : "Select");
  const selectedCallout = props.selected?.kind === "callout" ? props.selected : null;
  return <fieldset disabled={props.disabled} className="kiri-annotation-controls" aria-label={t("Tool options")} data-tool={kind}>
    <div className="kiri-annotation-controls-heading"><strong>{label}</strong>{props.selected && <span>{t("Selected object")}</span>}</div>
    <div className="kiri-annotation-control-fields">
      {kind === "select" ? <span className="kiri-annotation-hint">{t("Click an object to edit it. Drag its handles to resize.")}</span> :
        kind === "watermark" ? <WatermarkControls appearance={a} onChange={props.onChange} onFinish={props.onFinish} onEdit={props.onEditWatermark}/> :
        kind === "mosaic" ? <MosaicControls appearance={a} onChange={props.onChange} onFinish={props.onFinish}/> : <>
          {(kind === "text" || kind === "label" || kind === "callout") && props.selected && <button type="button" className="kiri-annotation-action"
            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }} onClick={props.onEditText}>{t("Edit text")}</button>}
          {kind === "callout" && <>
            <label className="kiri-annotation-number kiri-annotation-callout-number"><span>{t("Number")}</span>
              <input type="number" aria-label={t("Number")} className="kiri-annotation-number-value" min={1} max={999} value={selectedCallout?.number ?? props.nextNumber}
                onKeyDown={event => event.stopPropagation()} onChange={event => {
                  const value = Number(event.target.value); if (!Number.isInteger(value) || value < 1 || value > 999) return;
                  selectedCallout ? props.onCalloutEdit({number: value}, true) : props.onNextNumber(value);
                }} onBlur={props.onFinish}/>
            </label>
            <AnnotationChoices label={t("Style")} value={a.calloutStyle} onChange={calloutStyle => props.onChange({calloutStyle})} options={[
              {value: "filled", label: t("Filled")}, {value: "outline", label: t("Outline")},
            ]}/>
            <AnnotationNumberControl label={t("Number size")} value={a.calloutSize} min={24} max={72}
              onChange={(calloutSize, transient) => props.onChange({calloutSize}, transient)} onFinish={props.onFinish}/>
          </>}
          {(kind === "text" || kind === "label" || kind === "callout") ? <AnnotationNumberControl label={t("Font")} value={a.textFontSize} min={12} max={64}
            onChange={(textFontSize, transient) => props.onChange({textFontSize}, transient)} onFinish={props.onFinish}/> :
            <AnnotationNumberControl label={t(kind === "pen" ? "Brush" : "Line")} value={kind === "pen" ? a.penWidth : a.shapeWidth} min={1} max={kind === "pen" ? 24 : 16}
              onChange={(value, transient) => props.onChange(kind === "pen" ? {penWidth: value} : {shapeWidth: value}, transient)} onFinish={props.onFinish}/>}
          {kind === "text" && <AnnotationChoices label={t("Text background")} value={a.textBackgroundStyle} onChange={textBackgroundStyle => props.onChange({textBackgroundStyle})} options={[
            {value: "transparent", label: t("Transparent")}, {value: "dark", label: t("Dark")},
          ]}/>}
          <AnnotationColors value={a.colorPreset} onChange={colorPreset => props.onChange({colorPreset})}/>
        </>}
    </div>
    {kind === "mosaic" && <p className="kiri-annotation-hint">{t("Brush over private details, or drag a rectangle or ellipse.")}</p>}
    {(kind === "text" || kind === "label" || kind === "callout") && <p className="kiri-annotation-hint">{t("Drag to move or resize. Double-click to edit the text.")}</p>}
  </fieldset>;
}
