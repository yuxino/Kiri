import type {Tool} from "../annotation/model";
import type {IconName} from "./KiriIcons";
import {AnnotationToolbarButton} from "./AnnotationToolbarButton";
import {t} from "../i18n";

export type AnnotationToolbarTool = Tool | "crop";
/** One order, icon, localized name and shortcut for every annotation surface. */
export const ANNOTATION_TOOLS: readonly {
  tool: AnnotationToolbarTool; icon: IconName; title: string; shortcut: string; group: number;
}[] = [
  {tool: "select", icon: "cursorarrow", title: "Select (V)", shortcut: "V", group: 0},
  {tool: "crop", icon: "crop", title: "Crop (C)", shortcut: "C", group: 0},
  {tool: "pen", icon: "pencil.tip", title: "Pen (P)", shortcut: "P", group: 1},
  {tool: "rectangle", icon: "rectangle.dashed", title: "Rectangle (R)", shortcut: "R", group: 1},
  {tool: "line", icon: "line.diagonal", title: "Line (L)", shortcut: "L", group: 1},
  {tool: "arrow", icon: "arrow.up.right", title: "Arrow (A)", shortcut: "A", group: 1},
  {tool: "text", icon: "textformat", title: "Text (T)", shortcut: "T", group: 2},
  {tool: "callout", icon: "number.circle", title: "Numbered callout (N)", shortcut: "N", group: 2},
  {tool: "label", icon: "tag", title: "Label bubble (B)", shortcut: "B", group: 2},
  {tool: "mosaic", icon: "square.grid.3x3.fill", title: "Mosaic (M)", shortcut: "M", group: 3},
  {tool: "watermark", icon: "watermark", title: "Watermark (W)", shortcut: "W", group: 3},
];
export const SCREENSHOT_ANNOTATION_TOOLS = ANNOTATION_TOOLS.filter(item => item.tool !== "crop").map(item => item.tool as Tool);
export const IMAGE_ANNOTATION_TOOLS = ANNOTATION_TOOLS.map(item => item.tool);
export const VIDEO_ANNOTATION_TOOLS: readonly Tool[] = ["select", "pen", "rectangle", "line", "arrow", "text", "mosaic"];
export const LIVE_ANNOTATION_TOOLS = ["select", "pen", "rectangle", "arrow", "text"] as const;

/** Pure render helper keeps layout ownership with each window while sharing controls. */
export function annotationToolGroups<T extends AnnotationToolbarTool>(props: {
  tools: readonly T[]; selected: string | null; disabled?: boolean; onChange(tool: T): void;
}) {
  const visible = ANNOTATION_TOOLS.filter(item => props.tools.includes(item.tool as T));
  return [0, 1, 2, 3].flatMap(group => {
    const entries = visible.filter(item => item.group === group);
    return entries.length ? [<div key={group} className="kiri-annotation-tool-group" role="group" aria-label={t("Annotations")}>
      {entries.map(item => <AnnotationToolbarButton key={item.tool} icon={item.icon} title={t(item.title)}
        shortcut={item.shortcut} active={props.selected === item.tool} disabled={props.disabled}
        onClick={() => props.onChange(item.tool as T)}/>)}
    </div>] : [];
  });
}

export function annotationHistoryButtons(props: {
  disabled?: boolean; canUndo: boolean; canRedo: boolean; onUndo(): void; onRedo(): void;
  hasMarks?: boolean; onClear?(): void; clearShortcut?: string;
}) {
  return <div className="kiri-annotation-tool-group">
    <AnnotationToolbarButton icon="arrow.uturn.backward" title={t("Undo")} shortcut="Mod+Z"
      disabled={props.disabled || !props.canUndo} onClick={props.onUndo}/>
    <AnnotationToolbarButton icon="arrow.uturn.forward" title={t("Redo")} shortcut="Mod+Shift+Z"
      disabled={props.disabled || !props.canRedo} onClick={props.onRedo}/>
    {props.onClear && <AnnotationToolbarButton icon="trash" title={t("Clear Annotations")} shortcut={props.clearShortcut}
      disabled={props.disabled || !props.hasMarks} onClick={props.onClear}/>}
  </div>;
}
