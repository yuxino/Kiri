import {t} from "../i18n";
import type {AppearanceSettings} from "./model";
import {AnnotationChoices, AnnotationNumberControl} from "./AnnotationControlFields";

export function MosaicControls(props: {
  appearance: AppearanceSettings; onChange(patch: Partial<AppearanceSettings>, transient?: boolean): void; onFinish(): void;
}) {
  const a = props.appearance;
  return <>
    <AnnotationChoices label={t("Shape")} value={a.mosaicShape} onChange={mosaicShape => props.onChange({mosaicShape})} options={[
      {value: "brush", label: t("Freehand")}, {value: "rectangle", label: t("Rectangle")}, {value: "ellipse", label: t("Ellipse")},
    ]}/>
    <AnnotationChoices label={t("Style")} value={a.mosaicStyle} onChange={mosaicStyle => props.onChange({mosaicStyle})} options={[
      {value: "pixel", label: t("Pixel"), title: t("Pixel mosaic")}, {value: "blur", label: t("Blur"), title: t("Gaussian blur")},
    ]}/>
    <AnnotationChoices label={t("Intensity")} value={a.mosaicIntensity} onChange={mosaicIntensity => props.onChange({mosaicIntensity})} options={[
      {value: "soft", label: t("Soft")}, {value: "standard", label: t("Standard")}, {value: "strong", label: t("Strong")},
    ]}/>
    {(a.mosaicShape === "brush" || a.mosaicStyle === "blur") && <AnnotationNumberControl
      label={t(a.mosaicShape === "brush" ? "Brush" : "Effect size")} value={a.mosaicBrushDiameter} min={12} max={120}
      onChange={(mosaicBrushDiameter, transient) => props.onChange({mosaicBrushDiameter}, transient)} onFinish={props.onFinish}/>}
  </>;
}
