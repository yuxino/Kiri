import {t} from "../i18n";
import {COLOR_HEX, COLOR_LABELS, COLOR_PRESETS, type AnnotationMark, type AppearanceSettings} from "./model";

export type LabelMark = Extract<AnnotationMark, {kind:"text"}>;

export function LabelControls({selected, appearance, onChange, onFinish}: {
  selected:LabelMark|null; appearance:AppearanceSettings;
  onChange(patch:Partial<AppearanceSettings>, transient?:boolean):void; onFinish():void;
}) {
  const size = selected?.fontSize ?? appearance.textFontSize;
  const direction = selected?.labelDirection ?? appearance.labelDirection;
  const color = selected?.color ?? appearance.colorPreset;
  return <div className="kiri-label-controls kiri-hud">
    <div className="kiri-label-control-row">
      <div className="kiri-label-directions" role="group" aria-label={t("Label direction")}>
        {(["left","right"] as const).map(value => <button key={value} type="button" className="kiri-label-direction"
          aria-pressed={direction===value} title={t(value==="left"?"Point label left":"Point label right")}
          aria-label={t(value==="left"?"Point label left":"Point label right")}
          onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")event.stopPropagation();}}
          onClick={()=>onChange({labelDirection:value})}>
          <svg width="36" height="18" viewBox="0 0 36 18" aria-hidden="true" style={{transform:value==="right"?"scaleX(-1)":undefined}}>
            <circle cx="4" cy="9" r="2" fill="currentColor"/>
            <path d="M14 3h15a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3l-3-3 3-3a3 3 0 0 1 3-3Z" fill="none" stroke="currentColor" strokeWidth="1.4"/>
          </svg>
        </button>)}
      </div>
      <label className="kiri-label-size"><span>{t("Font")}</span>
        <input type="range" className="kiri-range" min="12" max="64" value={size}
          aria-label={t("Font")} onChange={event=>onChange({textFontSize:Number(event.target.value)},true)}
          onPointerUp={onFinish} onPointerCancel={onFinish} onKeyUp={onFinish} onBlur={onFinish}/>
        <output>{Math.round(size)}</output>
      </label>
    </div>
    <div className="kiri-label-colors">
      {COLOR_PRESETS.map(value=><button key={value} type="button" className="kiri-label-swatch"
        title={t(COLOR_LABELS[value])} aria-label={t(COLOR_LABELS[value])} aria-pressed={color===value}
        onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")event.stopPropagation();}}
        onClick={()=>onChange({colorPreset:value})} style={{background:COLOR_HEX[value]}}/>)}
      <span>{t("Click the dot to switch sides.")}</span>
    </div>
  </div>;
}
