import {useEffect, useRef, useState} from "react";
import {Mouse} from "lucide-react";
import {KiriIcon, type IconName} from "../components/KiriIcons";
import {toolbarShortcut} from "../components/AnnotationToolbarButton";
import {COLOR_HEX, COLOR_LABELS, COLOR_PRESETS, type AnnotationMark} from "../annotation/model";
import {selectedAnnotationAppearance} from "../annotation/AnnotationStyleControls";
import {useAnnotationAppearance} from "../annotation/useAnnotationAppearance";
import {api, onRecordingAnnotationSelection, type RecordingAnnotationAction, type RecordingAnnotationsState,
  type RecordingAnnotationTool, type RecordingAnnotationAppearance} from "../lib/ipc";
import {t} from "../i18n";
import "./recording-annotations.css";

const tools: {tool: RecordingAnnotationTool; icon: IconName; label: string; key: string}[] = [
  {tool: "select", icon: "cursorarrow", label: "Select", key: "V"},
  {tool: "pen", icon: "pencil.tip", label: "Pen", key: "P"},
  {tool: "arrow", icon: "arrow.up.right", label: "Arrow", key: "A"},
  {tool: "rectangle", icon: "rectangle.dashed", label: "Rectangle", key: "R"},
  {tool: "text", icon: "textformat", label: "Text", key: "T"},
];

export function RecordingAnnotationControls({sessionId, state, disabled}: {
  sessionId: string; state: RecordingAnnotationsState; disabled: boolean;
}) {
  const [appearance, setAppearance] = useAnnotationAppearance();
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<AnnotationMark | null>(null);
  const operations = useRef(Promise.resolve<unknown>(undefined));
  const adjusting = useRef(false);
  const enqueue = (action: () => Promise<unknown>) => {
    const next = operations.current.then(action);
    operations.current = next.catch(() => {});
    return next;
  };
  useEffect(() => {
    let disposed = false;
    const subscription = onRecordingAnnotationSelection(event => {
      if (!disposed && event.sessionId === sessionId) setSelected(event.mark);
    });
    return () => {disposed = true; void subscription.then(stop => stop()).catch(() => {});
      if (adjusting.current) void enqueue(() => api.updateRecordingAnnotationAppearance(sessionId, {}, false, true)).catch(() => {});};
  }, [sessionId]);
  useEffect(() => {if (state.tool === "desktop") setSelected(null);}, [state.tool]);
  const run = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true); setFailed(false);
    try {await enqueue(action);} catch {setFailed(true);} finally {setPending(false);}
  };
  const choose = (tool: RecordingAnnotationTool) => void run(() => api.setRecordingAnnotationTool(sessionId, tool));
  const act = (action: RecordingAnnotationAction) => void run(() => api.recordingAnnotationAction(sessionId, action));
  const unavailable = disabled || !state.ready || pending;
  const editingTool = selected?.kind ?? state.tool;
  const values = selectedAnnotationAppearance(appearance, selected);
  const sizeKey = editingTool === "text" ? "textFontSize" : editingTool === "pen" ? "penWidth" : "shapeWidth";
  const sizeLabel = t(editingTool === "text" ? "Font" : editingTool === "pen" ? "Brush" : "Line");
  const changeAppearance = (patch: RecordingAnnotationAppearance, transient = false) => {
    setAppearance({...appearance, ...patch}); adjusting.current ||= transient;
    void enqueue(() => api.updateRecordingAnnotationAppearance(sessionId, patch, transient))
      .then(() => setFailed(false)).catch(() => setFailed(true));
  };
  const finishAppearance = () => {
    if (!adjusting.current) return;
    adjusting.current = false;
    void enqueue(() => api.updateRecordingAnnotationAppearance(sessionId, {}, false, true))
      .catch(() => setFailed(true));
  };
  const clearKey = toolbarShortcut("Mod+Shift+Backspace");
  return <div className="kiri-record-annotation-tools" aria-label={t("Annotations")}>
    <div className="kiri-record-annotation-row" role="group" aria-label={t("Annotations")}>
      <button type="button" className="kiri-record-control-button" title={`${t("Operate Desktop")} · Esc`}
        aria-label={t("Operate Desktop")} aria-pressed={state.tool === "desktop"} disabled={unavailable}
        onClick={() => choose("desktop")}><Mouse size={17}/></button>
      {tools.map(item => <button type="button" className="kiri-record-control-button" key={item.tool}
        aria-label={t(item.label)} title={`${t(item.label)} · ${item.key}`} aria-pressed={state.tool === item.tool}
        disabled={unavailable} onClick={() => choose(item.tool)}><KiriIcon name={item.icon} size={17}/></button>)}
      <span className="kiri-record-controls__divider" aria-hidden="true"/>
      <button type="button" className="kiri-record-control-button" title={t("Undo")} aria-label={t("Undo")}
        disabled={unavailable || !state.canUndo} onClick={() => act("undo")}><KiriIcon name="arrow.uturn.backward" size={17}/></button>
      <button type="button" className="kiri-record-control-button" title={t("Redo")} aria-label={t("Redo")}
        disabled={unavailable || !state.canRedo} onClick={() => act("redo")}><KiriIcon name="arrow.uturn.forward" size={17}/></button>
      <button type="button" className="kiri-record-control-button" title={`${t("Clear Annotations")} · ${clearKey.label}`}
        aria-label={t("Clear Annotations")} disabled={unavailable || !state.hasMarks} onClick={() => act("clear")}>
        <KiriIcon name="trash" size={16}/></button>
    </div>
    <div className="kiri-record-annotation-row" role="group" aria-label={t("Tool options")}>
      <div className="kiri-record-annotation-row" role="group" aria-label={t("Color")}>
        {COLOR_PRESETS.map(color => <button type="button" key={color} className="kiri-record-annotation-swatch"
          title={t(COLOR_LABELS[color])} aria-label={t(COLOR_LABELS[color])} aria-pressed={values.colorPreset === color}
          disabled={unavailable} style={{background: COLOR_HEX[color]}}
          onClick={() => changeAppearance({colorPreset: color})}/>)}
      </div>
      <label className="kiri-record-annotation-size"><span>{sizeLabel}</span>
        <input type="range" aria-label={sizeLabel} min={editingTool === "text" ? 12 : 1}
          max={editingTool === "text" ? 64 : editingTool === "pen" ? 24 : 16} value={values[sizeKey]}
          disabled={unavailable} onChange={event => changeAppearance({[sizeKey]: Number(event.target.value)}, true)}
          onPointerUp={finishAppearance} onPointerCancel={finishAppearance} onKeyUp={finishAppearance} onBlur={finishAppearance}/>
        <output>{values[sizeKey]}</output>
      </label>
    </div>
    {failed && <p className="kiri-record-annotation-notice" role="alert">{t("Could not update recording annotations. Try again.")}</p>}
  </div>;
}
