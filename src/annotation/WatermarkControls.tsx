import {t} from "../i18n";
import type {AppearanceSettings} from "./model";
import {AnnotationColors, AnnotationNumberControl} from "./AnnotationControlFields";

/** Content is edited in the canvas; these fields adjust appearance. */
export function WatermarkControls(props: {
  appearance: AppearanceSettings; onChange(patch: Partial<AppearanceSettings>, transient?: boolean): void;
  onFinish(): void;
}) {
  const a = props.appearance;
  return <>
    <AnnotationNumberControl label={t("Font")} value={a.watermarkFontSize} min={12} max={128}
      onChange={(watermarkFontSize, transient) => props.onChange({watermarkFontSize}, transient)} onFinish={props.onFinish}/>
    <AnnotationNumberControl label={t("Opacity")} value={a.watermarkOpacity} min={0} max={100} unit="%"
      onChange={(watermarkOpacity, transient) => props.onChange({watermarkOpacity}, transient)} onFinish={props.onFinish}/>
    <AnnotationNumberControl label={t("Rotation")} value={a.watermarkRotation} min={-180} max={180} unit="°"
      onChange={(watermarkRotation, transient) => props.onChange({watermarkRotation}, transient)} onFinish={props.onFinish}/>
    <AnnotationNumberControl label={t("Spacing")} value={a.watermarkSpacing} min={16} max={512}
      onChange={(watermarkSpacing, transient) => props.onChange({watermarkSpacing}, transient)} onFinish={props.onFinish}/>
    <AnnotationColors value={a.watermarkColor} onChange={watermarkColor => props.onChange({watermarkColor})}/>
  </>;
}
