import {useEffect, useRef, useState} from "react";
import {AnnotationToolbarButton} from "../components/AnnotationToolbarButton";
import {annotationToolGroups, annotationHistoryButtons, LIVE_ANNOTATION_TOOLS} from "../components/AnnotationTools";
import type {AnnotationMark, AppearanceSettings} from "../annotation/model";
import {AnnotationStyleControls} from "../annotation/AnnotationStyleControls";
import {useAnnotationAppearance} from "../annotation/useAnnotationAppearance";
import {api, onRecordingAnnotationSelection, type RecordingAnnotationAction, type RecordingAnnotationsState,
  type RecordingAnnotationTool} from "../lib/ipc";
import {t} from "../i18n";
import "./recording-annotations.css";

const noop = () => {};

export function RecordingAnnotationControls({sessionId, state, disabled}: {
  sessionId: string; state: RecordingAnnotationsState; disabled: boolean;
}) {
  const [appearance, setAppearance] = useAnnotationAppearance();
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<AnnotationMark | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(true);
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
  const changeAppearance = (patch: Partial<AppearanceSettings>, transient = false) => {
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
  return <div className="kiri-record-annotation-tools kiri-dark" aria-label={t("Annotations")}>
    <div className="kiri-record-annotation-row" role="group" aria-label={t("Annotations")}>
      <div className="kiri-annotation-tool-group">
        <AnnotationToolbarButton icon="mouse" title={t("Operate Desktop")} shortcut="Escape"
          active={state.tool === "desktop"} disabled={unavailable} onClick={() => choose("desktop")}/>
      </div>
      {annotationToolGroups({tools: LIVE_ANNOTATION_TOOLS, selected: state.tool, disabled: unavailable, onChange: tool => choose(tool)})}
      {annotationHistoryButtons({canUndo: state.canUndo, canRedo: state.canRedo, hasMarks: state.hasMarks, disabled: unavailable,
        onUndo: () => act("undo"), onRedo: () => act("redo"), onClear: () => act("clear"), clearShortcut: "Mod+Shift+Backspace"})}
      <div className="kiri-annotation-tool-group">
        <AnnotationToolbarButton icon="slider.horizontal.3" title={t("Tool options")} expanded={optionsOpen}
          active={optionsOpen} disabled={unavailable} onClick={() => setOptionsOpen(open => !open)}/>
      </div>
    </div>
    {optionsOpen && <AnnotationStyleControls tool={state.tool === "desktop" ? "select" : state.tool}
      selected={selected} appearance={appearance} disabled={unavailable} nextNumber={1} onNextNumber={noop} onCalloutEdit={noop}
      onChange={changeAppearance} onFinish={finishAppearance} onEditText={() => act("editText")}
      onEditWatermark={noop} onDelete={() => act("delete")}/>}
    {failed && <p className="kiri-record-annotation-notice" role="alert">{t("Could not update recording annotations. Try again.")}</p>}
  </div>;
}
