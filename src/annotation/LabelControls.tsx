import {t} from "../i18n";
import {COLOR_HEX, COLOR_LABELS, COLOR_PRESETS, type AnnotationMark, type AppearanceSettings} from "./model";

export type LabelMark = Extract<AnnotationMark, {kind:"text"}>;

export function LabelControls({selected, appearance, onChange, onFinish}: {
  selected:LabelMark|null; appearance:AppearanceSettings;
  onChange(patch:Partial<AppearanceSettings>, transient?:boolean):void; onFinish():void;
}) {
  const size = selected?.fontSize ?? appearance.textFontSize;
  const color = selected?.color ?? appearance.colorPreset;
  return <div className="kiri-label-controls kiri-hud">
    <label className="kiri-label-size"><span>{t("Font")}</span>
      <input type="range" className="kiri-range" min="12" max="64" value={size}
        aria-label={t("Font")} onChange={event=>onChange({textFontSize:Number(event.target.value)},true)}
        onPointerUp={onFinish} onPointerCancel={onFinish} onKeyUp={onFinish} onBlur={onFinish}/>
      <output>{Math.round(size)}</output>
    </label>
    <div className="kiri-label-colors" role="group" aria-label={t("Color")}>
      {COLOR_PRESETS.map(value=><button key={value} type="button" className="kiri-label-swatch"
        title={t(COLOR_LABELS[value])} aria-label={t(COLOR_LABELS[value])} aria-pressed={color===value}
        onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")event.stopPropagation();}}
        onClick={()=>onChange({colorPreset:value})} style={{background:COLOR_HEX[value]}}/>)}
    </div>
  </div>;
}
