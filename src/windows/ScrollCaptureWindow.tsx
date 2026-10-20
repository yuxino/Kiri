import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ScrollCaptureStatusDto } from "../lib/ipc";
import { t } from "../i18n";
import { KiriIcon } from "../components/KiriIcons";
import { isTextComposition } from "../annotation/text-composition.js";
import { useScrollCaptureDrag } from "./useScrollCaptureDrag";
import "./scroll-capture.css";

const STATUS_INTERVAL_MS = 180;
type DetailPreview = NonNullable<ScrollCaptureStatusDto["detailPreview"]>;
type PreviewBuffer = {
  detail: DetailPreview;
  token: number;
  phase: "loading" | "decoding" | "ready" | "failed";
};
type PreviewPresentation = {
  sessionId: string;
  slots: [PreviewBuffer | null, PreviewBuffer | null];
  active: 0 | 1 | null;
};

function samePreview(left: DetailPreview | undefined, right: DetailPreview): boolean {
  return !!left && left.image === right.image && left.top === right.top && left.left === right.left &&
    left.width === right.width && left.height === right.height && left.displayScale === right.displayScale;
}

function phaseMessage(phase: ScrollCaptureStatusDto["phase"] | undefined): string {
  switch (phase) {
    case "capturing": return "Scroll up or down";
    case "reconnecting": return "Return to captured content to continue.";
    case "finishing": return "Finishing capture…";
    case "saving": return "Saving…";
    case "failed": return "Could not finish scrolling capture. Try again.";
    case "limit": return "Capture limit reached.";
    default: return "Preparing scrolling capture…";
  }
}

function actionError(error: unknown, fallback: string): string {
  const message = String(error);
  for (const known of [
    "Return to captured content to continue.",
    "Could not save scrolling capture. Try again.",
    "Capture limit reached.",
    "Stop scrolling briefly, then choose Done.",
    "No scrolling content has been captured yet.",
  ]) if (message.includes(known)) return known;
  return fallback;
}

export function ScrollCaptureWindow({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  const drag = useScrollCaptureDrag(sessionId);
  const [status, setStatus] = useState<ScrollCaptureStatusDto | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"finish" | "cancel" | null>(null);
  const [previewFollowRevision, refreshPreview] = useState(0);
  const actionRef = useRef<"finish" | "cancel" | null>(null);
  const actionGeneration = useRef(0);
  const settled = useRef(false);
  const stopPolling = useRef<() => void>(() => {});
  const recoveryError = useRef<object | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const mounted = useRef(false);
  const preview = useRef<HTMLDivElement>(null);
  const inspectingPreview = useRef(false);
  const [presentation, setPresentation] = useState<PreviewPresentation>(() => ({
    sessionId, slots: [null, null], active: null,
  }));
  const presentationRef = useRef(presentation);
  const previewToken = useRef(0);
  const previousPreview = useRef<{ detail: DetailPreview; scale: number } | null>(null);
  const sourceFollow = useRef<{ top: number; direction: number } | null>(null);
  const commitPresentation = useCallback((next: PreviewPresentation) => {
    presentationRef.current = next;
    setPresentation(next);
  }, []);
  const detail = presentation.sessionId === sessionId && presentation.active !== null
    ? presentation.slots[presentation.active]?.detail : null;
  const displayScale = detail && detail.displayScale > 0 ? detail.displayScale : 1;
  const sourceViewportTop = (status?.contentOrigin ?? 0) + (status?.viewportTop ?? 0);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    stopPolling.current = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const poll = async () => {
      if (disposed || settled.current) return;
      const recoveryAtRequest = recoveryError.current;
      try {
        const next = await api.scrollCaptureStatus(sessionId);
        if (disposed || settled.current || next.sessionId !== sessionId) return;
        if (recoveryAtRequest && recoveryError.current === recoveryAtRequest && next.phase === "capturing") {
          recoveryError.current = null;
          setError(null);
        }
        failures = 0;
        setPollFailed(false);
        // Keep an encoded image and its coordinates together while a newer
        // accepted source position is still waiting for its PNG.
        setStatus(previous => ({
          ...next, detailPreview: next.detailPreview ?? previous?.detailPreview ?? null,
        }));
      } catch {
        if (disposed || settled.current) return;
        failures++;
        if (failures >= 3) setPollFailed(true);
      } finally {
        // A slow capture or image encode never creates overlapping requests.
        if (!disposed && !settled.current) timer = setTimeout(() => void poll(), STATUS_INTERVAL_MS);
      }
    };
    if (sessionId) void poll();
    else setPollFailed(true);
    return () => {
      disposed = true;
      mounted.current = false;
      stopPolling.current();
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    if (presentationRef.current.sessionId === sessionId) return;
    commitPresentation({ sessionId, slots: [null, null], active: null });
    previousPreview.current = null;
    sourceFollow.current = null;
    inspectingPreview.current = false;
  }, [sessionId, commitPresentation]);

  useLayoutEffect(() => {
    const incoming = status?.sessionId === sessionId ? status.detailPreview : null;
    if (compact || !incoming || incoming.width <= 0 || incoming.height <= 0) return;
    // Record source motion even while a PNG is pending or the user is looking
    // at an older frame. Neither clock may consume a later frame's direction.
    const follow = sourceFollow.current;
    if (!follow) sourceFollow.current = { top: sourceViewportTop, direction: 0 };
    else if (follow.top !== sourceViewportTop) {
      sourceFollow.current = { top: sourceViewportTop, direction: Math.sign(sourceViewportTop - follow.top) };
    }
    const current = presentationRef.current;
    const front = current.active === null ? null : current.slots[current.active];
    const back = current.active === 0 ? 1 : 0;
    const pending = current.slots[back];
    if (samePreview(front?.detail, incoming)) {
      // A rapid reversal can return to the displayed image before the next
      // image decodes. Invalidate that obsolete decode without touching front.
      if (pending) {
        const slots: PreviewPresentation["slots"] = [...current.slots];
        slots[back] = null;
        commitPresentation({ ...current, slots });
      }
      return;
    }
    if (samePreview(pending?.detail, incoming)) {
      if (pending?.phase === "ready" && (!inspectingPreview.current || current.active === null)) {
        commitPresentation({ ...current, active: back });
      }
      return;
    }
    const slots: PreviewPresentation["slots"] = [...current.slots];
    slots[back] = { detail: incoming, token: ++previewToken.current, phase: "loading" };
    commitPresentation({ ...current, slots });
  }, [status?.detailPreview, sourceViewportTop, sessionId, compact, previewFollowRevision, commitPresentation]);

  const loadPreview = async (slot: 0 | 1, token: number, element: HTMLImageElement) => {
    const current = presentationRef.current;
    const buffer = current.slots[slot];
    if (!mounted.current || current.sessionId !== sessionId || buffer?.token !== token || buffer.phase !== "loading") return;
    const slots: PreviewPresentation["slots"] = [...current.slots];
    slots[slot] = { ...buffer, phase: "decoding" };
    commitPresentation({ ...current, slots });
    let ready = false;
    try {
      if (typeof element.decode === "function") await element.decode();
      ready = element.complete && element.naturalWidth > 0 && element.getAttribute("src") === buffer.detail.image;
    } catch { /* The old decoded frame remains visible on load/decode failure. */ }
    const latest = presentationRef.current;
    if (!mounted.current || latest.sessionId !== sessionId || latest.slots[slot]?.token !== token ||
      latest.slots[slot]?.phase !== "decoding") return;
    const next: PreviewPresentation["slots"] = [...latest.slots];
    next[slot] = { ...buffer, phase: ready ? "ready" : "failed" };
    commitPresentation({ ...latest, slots: next,
      active: ready && (!inspectingPreview.current || latest.active === null) ? slot : latest.active });
  };

  const failPreview = (slot: 0 | 1, token: number) => {
    const current = presentationRef.current;
    const buffer = current.slots[slot];
    if (!mounted.current || current.sessionId !== sessionId || buffer?.token !== token) return;
    const slots: PreviewPresentation["slots"] = [...current.slots];
    slots[slot] = { ...buffer, phase: "failed" };
    commitPresentation({ ...current, slots });
  };

  useLayoutEffect(() => {
    const element = preview.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => refreshPreview(value => value + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact]);

  useLayoutEffect(() => {
    const element = preview.current;
    if (!element || !detail || detail.width <= 0 || detail.height <= 0) return;
    const scale = Math.min(element.clientWidth / detail.width, 1 / displayScale);
    if (scale <= 0) return;
    const previous = previousPreview.current;
    const maxTop = Math.max(0, detail.height * scale - element.clientHeight);
    if (previous && (previous.detail.top !== detail.top || previous.scale !== scale)) {
      element.scrollTop = Math.max(0, Math.min(maxTop,
        element.scrollTop * scale / previous.scale + (previous.detail.top - detail.top) * scale));
    }
    element.scrollLeft = 0;
    previousPreview.current = { detail, scale };
    if (inspectingPreview.current) return;
    const direction = sourceFollow.current?.direction ?? 0;
    const viewportBottom = sourceViewportTop + (status?.viewportHeight ?? 0);
    // Do not move the old pixels toward an image that is still loading. When
    // only status has arrived, follow within the available crop, but hold its
    // position if the newly reached edge is outside it.
    if (status?.detailPreview && !samePreview(detail, status.detailPreview)) return;
    if (previous?.detail === detail &&
      ((direction > 0 && viewportBottom > detail.top + detail.height) ||
       (direction < 0 && sourceViewportTop < detail.top))) return;
    const top = Math.max(0, sourceViewportTop - detail.top) * scale;
    const bottom = Math.min(detail.height, viewportBottom - detail.top) * scale;
    if (bottom > top) {
      const target = direction > 0 ? bottom - element.clientHeight : direction < 0 ? top :
        (top + bottom - element.clientHeight) / 2;
      element.scrollTop = Math.max(0, Math.min(maxTop, target));
    }
  }, [detail, displayScale, sourceViewportTop, status?.viewportHeight, status?.detailPreview, compact, previewFollowRevision]);

  const inspectPreview = () => { inspectingPreview.current = true; };
  const resumePreview = () => {
    inspectingPreview.current = false;
    refreshPreview(value => value + 1);
  };

  const finish = useCallback(async (allowPartial = false) => {
    if (actionRef.current || settled.current || !sessionId) return;
    const generation = ++actionGeneration.current;
    actionRef.current = "finish";
    recoveryError.current = null;
    setAction("finish");
    setError(null);
    try {
      await api.finishScrollCapture(sessionId, allowPartial);
      // Keep the successful operation locked until the native panel closes.
      // Polls and repeated clicks must not target a session being torn down.
      settled.current = true;
      stopPolling.current();
      actionRef.current = "finish";
      if (mounted.current) setAction("finish");
    } catch (failure) {
      if (!mounted.current || settled.current || generation !== actionGeneration.current) return;
      const message = actionError(failure, "Could not finish scrolling capture. Try again.");
      recoveryError.current = message === "Return to captured content to continue." ? {} : null;
      setError(message);
      actionRef.current = null;
      setAction(null);
    }
  }, [sessionId]);

  const cancel = useCallback(async () => {
    if (settled.current || actionRef.current === "cancel" || statusRef.current?.phase === "saving" || !sessionId) return;
    // Finishing may still be waiting for a settled final frame. Cancellation
    // owns a new generation so its older finish rejection cannot overwrite it.
    const generation = ++actionGeneration.current;
    actionRef.current = "cancel";
    recoveryError.current = null;
    setAction("cancel");
    setError(null);
    try {
      await api.cancelScrollCapture(sessionId);
      settled.current = true;
      stopPolling.current();
    } catch {
      if (!mounted.current || settled.current || generation !== actionGeneration.current) return;
      setError("Could not cancel scrolling capture. Try again.");
      actionRef.current = null;
      setAction(null);
    }
  }, [sessionId]);

  const busy = action !== null || status?.phase === "finishing" || status?.phase === "saving";
  const canCancel = !settled.current && action !== "cancel" && status?.phase !== "saving";
  const partial = !!status?.canSavePartial &&
    (status.phase === "reconnecting" || status.phase === "failed" || status.phase === "limit");
  const canFinish = !busy && !!status && status.width > 0 && status.height > 0 &&
    (status.phase === "capturing" || status.phase === "limit" || status.phase === "failed" || partial);
  const message = error ?? (pollFailed ? "Could not update scrolling capture. Try again." :
    status?.message || phaseMessage(status?.phase));

  return (
    <section className={`kiri-dark kiri-scroll-capture${compact ? " kiri-scroll-capture--compact" : ""}`}
      aria-label={t("Scrolling Screenshot")}
      onKeyDown={event => {
        if (isTextComposition(event.nativeEvent) || event.repeat) return;
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          if (canCancel) void cancel();
        }
        // Only an explicit action inside this panel owns Return. The source
        // application's keyboard and scrolling remain entirely native.
      }}>
      {!compact && <header className="kiri-scroll-capture__header" {...drag}>
        <KiriIcon name="arrows.up.down" size={15} />
        <span>{t("Scrolling Screenshot")}</span>
        {status && status.width > 0 && <output className="kiri-scroll-capture__dimensions"
          aria-label={t("Captured image size")}>{status.width} × {status.height}</output>}
      </header>}
      {!compact && <div ref={preview} className="kiri-scroll-capture__preview"
        aria-label={t("Captured area preview")} tabIndex={0}
        onPointerEnter={inspectPreview}
        onWheel={inspectPreview}
        onPointerDown={inspectPreview}
        onPointerLeave={resumePreview}
        onBlur={resumePreview}
        onKeyDown={event => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
            inspectPreview();
          }
        }}>
        <div className="kiri-scroll-capture__image" data-empty={!detail || undefined} style={detail ? {
              maxWidth: detail.width / displayScale, aspectRatio: `${detail.width} / ${detail.height}`,
            } : undefined}>
          {([0, 1] as const).map(slot => {
            const buffer = presentation.sessionId === sessionId ? presentation.slots[slot] : null;
            const visible = !!detail && presentation.active === slot;
            return <img key={slot} src={buffer?.detail.image} decoding="async"
              data-preview-slot={slot} data-visible={visible || undefined} aria-hidden={!visible}
              onLoad={event => { if (buffer) void loadPreview(slot, buffer.token, event.currentTarget); }}
              onError={() => { if (buffer) failPreview(slot, buffer.token); }}
              alt={visible ? t("Captured area preview") : ""} draggable={false} />;
          })}
        </div>
        {!detail && <div className="kiri-scroll-capture__placeholder">
            <KiriIcon name="arrows.up.down" size={22} />
            <span>{t("Preparing preview…")}</span>
          </div>}
      </div>}
      <div className="kiri-scroll-capture__status" role="status" aria-live="polite"
        {...(compact ? drag : {})}
        data-error={!!error || pollFailed || status?.phase === "failed" || undefined}
        title={t(message)}>{t(message)}</div>
      <footer className="kiri-scroll-capture__actions">
        <button type="button" className="kiri-scroll-capture__cancel"
          disabled={!canCancel} onClick={() => void cancel()}
          aria-label={t("Cancel")} title={t("Cancel (Esc)")}>
          <KiriIcon name="xmark" size={15} />
          <span>{t("Cancel")}</span>
        </button>
        <button type="button" className="kiri-primary-button kiri-scroll-capture__done"
          disabled={!canFinish} onClick={() => void finish(partial)}
          title={partial ? t("Only the connected captured area will be saved.") : t("Done — Copy to clipboard")}>
          <KiriIcon name="checkmark" size={15} />
          <span>{busy ? t(action === "cancel" ? "Cancelling…" : "Saving…") :
            t(partial ? "Save captured area" : "Done")}</span>
        </button>
      </footer>
    </section>
  );
}
