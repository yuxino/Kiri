import {useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import AnnotationCanvas, {type AnnotationCanvasHandle} from "../annotation/AnnotationCanvas";
import {type AnnotationMark, type Tool} from "../annotation/model";
import {drawMark, type RenderContext} from "../annotation/render";
import {isTextComposition} from "../annotation/text-composition.js";
import {useAnnotationAppearance} from "../annotation/useAnnotationAppearance";
import {api, onRecordingAnnotationAction, onRecordingAnnotationAppearance, onRecordingAnnotationFlush,
  onRecordingAnnotationPresent, emitRecordingAnnotationSelection,
  type RecordingAnnotationAction, type RecordingAnnotationsState} from "../lib/ipc";
import {t} from "../i18n";
import {useRecordingAnnotations} from "./useRecordingAnnotations";
import {RecordingAnnotationPublisher, recordingInkMarks, type RecordingInkFrame} from "./recording-annotation-publisher.js";
import "./recording-annotations.css";

function regionSize() {
  const params = new URLSearchParams(window.location.search);
  const dimension = (key: string, fallback: number) => {
    const value = Number(params.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {width: dimension("width", window.innerWidth), height: dimension("height", window.innerHeight)};
}

export function RecordingAnnotationWindow({ink = false}: {ink?: boolean}) {
  const sessionId = new URLSearchParams(window.location.search).get("session") ?? "";
  const {state, failed} = useRecordingAnnotations(sessionId);
  const [size] = useState(regionSize);
  return ink ? <RecordingInk sessionId={sessionId} state={state} size={size}/> :
    state ? <RecordingInput sessionId={sessionId} state={state} size={size}/> :
      failed ? <p className="kiri-record-annotation-error" role="alert">{t("Could not update recording annotations. Try again.")}</p> : null;
}

function RecordingInk({sessionId, state, size}: {sessionId: string; state: RecordingAnnotationsState | null; size: {width: number; height: number}}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawnRevision = useRef<number | null>(null);
  const [presentation, setPresentation] = useState<{requestId: string; revision: number} | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    let disposed = false;
    const subscription = onRecordingAnnotationPresent(event => {
      if (!disposed && event.sessionId === sessionId) setPresentation(event);
    });
    void subscription.then(() => {if (!disposed) setSubscribed(true);}).catch(() => {});
    return () => {disposed = true; void subscription.then(stop => stop()).catch(() => {});};
  }, [sessionId]);
  useLayoutEffect(() => {
    drawnRevision.current = null;
    const element = canvas.current;
    if (!element || !state) return;
    const scale = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.round(size.width * scale), height = Math.round(size.height * scale);
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    const context: RenderContext = {ctx, sourceImage: element, sourceWidth: width, sourceHeight: height,
      sourceOffset: {x: 0, y: 0}, regionSize: {x: 0, y: 0, ...size}, scaleX: 1, scaleY: 1,
      viewScaleX: 1, viewScaleY: 1, exporting: true};
    for (const mark of recordingInkMarks(state.marks, null)) {
      ctx.save(); drawMark(mark, context, ctx); ctx.restore();
    }
    drawnRevision.current = state.revision;
  }, [state, size]);
  useEffect(() => {
    if (!state || !subscribed) return;
    void api.recordingAnnotationsReady(sessionId).catch(() => {});
  }, [sessionId, Boolean(state), subscribed]);
  useEffect(() => {
    if (!presentation || !state || drawnRevision.current === null
      || drawnRevision.current < presentation.revision) return;
    let cancelled = false;
    // The layout effect has drawn the target revision. Wait across a browser
    // paint before acknowledging it to the native recording stop barrier.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (!cancelled) void api.recordingAnnotationsPresented(sessionId, presentation.requestId,
          state.revision).catch(() => {});
      });
    });
    return () => {cancelled = true; cancelAnimationFrame(first); cancelAnimationFrame(second);};
  }, [sessionId, state, presentation]);
  return <canvas ref={canvas} className="kiri-record-annotation-ink" aria-hidden="true" style={size}/>;
}

function RecordingInput({sessionId, state, size}: {sessionId: string; state: RecordingAnnotationsState; size: {width: number; height: number}}) {
  const canvas = useRef<AnnotationCanvasHandle>(null);
  const [initial] = useState(() => ({schemaVersion: 1 as const, canvas: size,
    sourcePixels: {width: Math.round(size.width), height: Math.round(size.height)}, marks: state.marks}));
  const [appearance, setAppearance, appearanceReady] = useAnnotationAppearance();
  const appearanceRef = useRef(appearance); appearanceRef.current = appearance;
  const setAppearanceRef = useRef(setAppearance); setAppearanceRef.current = setAppearance;
  const [failed, setFailed] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const flushingRef = useRef(false);
  const interactionLock = useRef({locked: false});
  const publisher = useRef<RecordingAnnotationPublisher | null>(null);
  const latest = useRef<RecordingInkFrame>({marks: initial.marks, canUndo: false, canRedo: false, hasMarks: initial.marks.length > 0});
  const lastTool = useRef<Tool>("pen");
  if (state.tool !== "desktop") lastTool.current = state.tool;
  const active = state.tool !== "desktop";
  const stateRef = useRef(state); stateRef.current = state;
  const perform = useCallback((action: RecordingAnnotationAction) => {
    if (flushingRef.current) return;
    if (action === "clear") canvas.current?.clearAnnotations();
    else if (action === "editText") canvas.current?.editSelectedText();
    else if (action === "delete") canvas.current?.deleteSelection();
    else {
      if (canvas.current?.cancelInteraction()) return;
      action === "undo" ? canvas.current?.undo() : canvas.current?.redo();
    }
  }, []);
  useEffect(() => {
    if (!appearanceReady) return;
    let disposed = false;
    const next = new RecordingAnnotationPublisher((revision, value) => api.updateRecordingAnnotations(
      sessionId, revision, value.marks, value.canUndo, value.canRedo, value.hasMarks), setFailed);
    next.revision = stateRef.current.revision;
    publisher.current = next;
    const actions = onRecordingAnnotationAction(event => {
      if (!disposed && event.sessionId === sessionId) perform(event.action);
    });
    const styling = onRecordingAnnotationAppearance(event => {
      if (disposed || flushingRef.current || event.sessionId !== sessionId) return;
      if (Object.keys(event.patch).length) {
        setAppearanceRef.current({...appearanceRef.current, ...event.patch});
        canvas.current?.updateSelectionAppearance(event.patch, event.transient);
      }
      if (event.finish) canvas.current?.finishAppearanceAdjustment();
    });
    const flushSubscription = onRecordingAnnotationFlush(event => {
      if (disposed || event.sessionId !== sessionId || flushingRef.current) return;
      flushingRef.current = true;
      canvas.current?.commitTextEditing();
      canvas.current?.finishAppearanceAdjustment();
      interactionLock.current.locked = true;
      setFlushing(true);
      void (async () => {
        try {
          // React commits text/history before AnnotationCanvas publishes its
          // next rendered frame. A hidden desktop-mode canvas stays mounted.
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          if (disposed) return;
          next.push(latest.current);
          const revision = await next.drain();
          if (!disposed) await api.recordingAnnotationsFlushed(sessionId, event.requestId, revision);
        } catch {
          if (!disposed) {
            setFailed(true);
            await api.recordingAnnotationsFlushed(sessionId, event.requestId, null).catch(() => {});
          }
        }
      })();
    });
    const subscription = Promise.all([actions, styling, flushSubscription]);
    void subscription.then(async () => {
      if (disposed) return;
      await api.recordingAnnotationsReady(sessionId);
      if (!disposed && stateRef.current.available) next.push(latest.current);
    }).catch(() => {if (!disposed) setFailed(true);});
    return () => {disposed = true; next.dispose(); publisher.current = null;
      for (const subscription of [actions, styling, flushSubscription]) void subscription.then(stop => stop()).catch(() => {});};
  }, [sessionId, perform, appearanceReady]);
  useEffect(() => {
    if (state.available) publisher.current?.push(latest.current);
  }, [state.available]);
  const history = useCallback((canUndo: boolean, canRedo: boolean, hasMarks: boolean) => {
    latest.current = {...latest.current, canUndo, canRedo, hasMarks};
    if (stateRef.current.available) publisher.current?.push(latest.current);
  }, []);
  const liveMarks = useCallback((marks: AnnotationMark[], draft: AnnotationMark | null) => {
    const ink = recordingInkMarks(marks, draft);
    latest.current = {...latest.current, marks: ink, hasMarks: ink.length > 0};
    if (stateRef.current.available) publisher.current?.push(latest.current);
  }, []);
  const selection = useCallback((mark: AnnotationMark | null, editing: boolean) => {
    void emitRecordingAnnotationSelection(sessionId, stateRef.current.tool === "desktop" ? null : mark, editing)
      .catch(() => setFailed(true));
  }, [sessionId]);
  const desktop = useCallback(() => {
    if (!canvas.current?.commitTextEditing()) return;
    canvas.current?.cancelInteraction();
    canvas.current?.clearSelection();
    void api.setRecordingAnnotationTool(sessionId, "desktop").catch(() => setFailed(true));
  }, [sessionId]);
  const previousActive = useRef(active);
  useEffect(() => {
    if (!active && previousActive.current) {
      if (canvas.current?.commitTextEditing()) {
        canvas.current?.cancelInteraction(); canvas.current?.clearSelection();
      }
      void emitRecordingAnnotationSelection(sessionId, null, false).catch(() => {});
    }
    previousActive.current = active;
  }, [active, sessionId]);
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (flushingRef.current) return;
      if (event.defaultPrevented || event.repeat || isTextComposition(event)) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input,textarea,select,[contenteditable],[role=menu],[role=listbox]")) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.shiftKey && event.key === "Backspace") {event.preventDefault(); perform("clear"); return;}
      if (mod && event.key.toLowerCase() === "z") {event.preventDefault(); perform(event.shiftKey ? "redo" : "undo"); return;}
      if (mod || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (!canvas.current?.cancelInteraction()) desktop();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {event.preventDefault(); canvas.current?.deleteSelection(); return;}
      const tools: Record<string, "select" | "pen" | "arrow" | "rectangle" | "text"> = {v: "select", p: "pen", a: "arrow", r: "rectangle", t: "text"};
      const tool = tools[event.key.toLowerCase()];
      if (tool) {event.preventDefault(); void api.setRecordingAnnotationTool(sessionId, tool).catch(() => setFailed(true));}
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, desktop, perform, sessionId]);
  return <div className="kiri-record-annotation-input" data-active={active || undefined} style={size}>
    <AnnotationCanvas ref={canvas} image={null} transparent undoableClear region={{x: 0, y: 0, ...size}}
      initialDocument={initial} tool={lastTool.current} appearance={appearance} onLiveMarks={liveMarks}
      interactionDisabled={flushing} interactionLock={interactionLock.current} preserveDraftWhenDisabled
      onSelectionInfo={selection} onHistoryChange={history} onCancel={desktop} onError={() => setFailed(true)}/>
    {failed && <div className="kiri-record-annotation-error" role="alert">
      <span>{t("Could not update recording annotations. Try again.")}</span>
      <button type="button" className="kiri-record-annotation-error-action" onClick={() => publisher.current?.push(latest.current)}>{t("Retry")}</button>
      <button type="button" className="kiri-record-annotation-error-action" onClick={() => perform("clear")}>{t("Clear Annotations")}</button>
      <button type="button" className="kiri-record-annotation-error-action" onClick={desktop}>{t("Operate Desktop")}</button>
    </div>}
  </div>;
}
