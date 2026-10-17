import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, ScrollText, X } from "lucide-react";
import { api, type ScrollCaptureStatus } from "../lib/ipc";
import { t } from "../i18n";
import { isTextComposition } from "../annotation/text-composition.js";
import "./scroll-capture.css";

const STATUS_MESSAGES = new Set([
  "Scroll down slowly to extend the screenshot.",
  "Scroll back slightly to reconnect the screenshot.",
  "The screenshot reached its size limit.",
  "Screen capture stopped. Save the captured portion or cancel.",
  "Could not save the screenshot. Try again.",
]);

function statusLabel(status: ScrollCaptureStatus | null): string {
  if (status?.message && STATUS_MESSAGES.has(status.message)) return status.message;
  switch (status?.phase) {
    case "capturing": return "Scroll down slowly to extend the screenshot.";
    case "needsOverlap": return "Scroll back slightly to reconnect the screenshot.";
    case "finishing": return "Checking the final frame…";
    case "saving": return "Saving screenshot…";
    case "failed": return "Scrolling capture paused. You can save the captured portion.";
    default: return "Preparing scrolling capture…";
  }
}

export function ScrollCaptureWindow() {
  const sessionId = new URLSearchParams(window.location.search).get("sessionId") ?? "";
  const [status, setStatus] = useState<ScrollCaptureStatus | null>(null);
  const statusRef = useRef<ScrollCaptureStatus | null>(null);
  const [action, setAction] = useState<"finish" | "cancel" | null>(null);
  const actionRef = useRef<"finish" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [confirmPartial, setConfirmPartial] = useState(false);
  const confirmPartialRef = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const followsPreview = useRef(true);

  const followPreview = () => {
    const element = previewRef.current;
    if (element && followsPreview.current) element.scrollTop = element.scrollHeight;
  };
  useLayoutEffect(followPreview, [status?.revision]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReadFailed(false);
    const poll = async () => {
      if (disposed) return;
      if (actionRef.current) {
        timer = setTimeout(() => void poll(), 250);
        return;
      }
      const requestGeneration = generation.current;
      try {
        const next = await api.scrollCaptureStatus(sessionId);
        if (disposed) return;
        if (next.sessionId !== sessionId) throw new Error("Scrolling capture session changed.");
        // A pending read must never overwrite the result of Finish or Cancel.
        if (requestGeneration === generation.current && !actionRef.current) {
          statusRef.current = next;
          setStatus(next);
          if (next.phase === "capturing" ||
              (next.phase === "failed" && next.message === "Could not save the screenshot. Try again.")) {
            confirmPartialRef.current = false;
            setConfirmPartial(false);
          }
          if (next.phase === "failed" && next.message === "Could not save the screenshot. Try again.") {
            // The status now carries the correct save remedy; an earlier
            // generic Finish error must not tell the user to scroll again.
            setError(null);
          }
        }
      } catch {
        if (disposed) return;
        if (requestGeneration === generation.current && !actionRef.current) {
          setReadFailed(true);
          return;
        }
      }
      // Schedule after the response, keeping at most one IPC read in flight.
      if (!disposed) timer = setTimeout(() => void poll(), 250);
    };
    void poll();
    return () => {
      disposed = true;
      mounted.current = false;
      generation.current += 1;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [retry, sessionId]);

  const runAction = useCallback(async (kind: "finish" | "cancel", allowPartial = false) => {
    if (actionRef.current) return;
    const current = statusRef.current;
    if (kind === "finish") {
      if (!current || current.frames < 1 || current.phase === "starting" ||
          current.phase === "finishing" || current.phase === "saving") return;
      if (!allowPartial && (current.phase === "needsOverlap" ||
          (current.phase === "failed" && current.message !== "Could not save the screenshot. Try again."))) {
        confirmPartialRef.current = true;
        setConfirmPartial(true);
        return;
      }
    }
    actionRef.current = kind;
    generation.current += 1;
    setAction(kind);
    setError(null);
    try {
      if (kind === "cancel") await api.cancelScrollCapture(sessionId);
      else await api.finishScrollCapture(sessionId, allowPartial);
      // Close only after the command responds, avoiding a blocked WebView2 IPC.
      await getCurrentWindow().close();
    } catch {
      if (!mounted.current) return;
      setError(kind === "cancel"
        ? "Could not cancel scrolling capture. Try again."
        : statusRef.current?.message === "Could not save the screenshot. Try again."
          ? "Could not save the screenshot. Try again."
          : "Could not finish scrolling capture. Adjust the scroll position and try again.");
      actionRef.current = null;
      setAction(null);
    }
  }, [sessionId]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (isTextComposition(event) || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        void runAction("cancel");
      } else if (event.key === "Enter" && !confirmPartialRef.current) {
        // Focused controls retain native activation (including Cancel).
        if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
        event.preventDefault();
        void runAction("finish");
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [runAction]);

  const busy = action !== null || status?.phase === "finishing" || status?.phase === "saving";
  const canFinish = !!status && status.frames > 0 && status.phase !== "starting" && !busy;
  const preview = status?.preview?.startsWith("data:image/png;base64,") ? status.preview : null;

  return (
    <main className="kiri-scroll-capture kiri-dark" aria-label={t("Scrolling Screenshot")} aria-busy={busy}>
      <header className="kiri-scroll-capture__header">
        <ScrollText size={17} aria-hidden="true" />
        <h1>{t("Scrolling Screenshot")}</h1>
        <span className="kiri-scroll-capture__live" aria-hidden="true" />
      </header>
      <p className="kiri-scroll-capture__status" role="status" aria-live="polite">
        {t(action === "finish" ? "Saving screenshot…" : statusLabel(status))}
      </p>
      <div className="kiri-scroll-capture__preview" aria-label={t("Captured portion")} ref={previewRef}
        onScroll={() => {
          const element = previewRef.current;
          if (element) followsPreview.current = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
        }}>
        {preview ? <img src={preview} alt={t("Captured portion")} draggable={false} onLoad={followPreview} /> :
          <span className="kiri-scroll-capture__placeholder">{t("Waiting for the first frame…")}</span>}
      </div>
      <p className="kiri-scroll-capture__dimensions" aria-label={t("Image dimensions")}>
        {status && status.width > 0 ? `${status.width.toLocaleString()} × ${status.height.toLocaleString()} px` : "—"}
      </p>
      {readFailed && <div className="kiri-scroll-capture__error" role="alert">
        <p>{t("Could not update the preview.")}</p>
        <button type="button" className="kiri-scroll-capture__button" onClick={() => setRetry(value => value + 1)} disabled={busy}>{t("Retry")}</button>
      </div>}
      {error && <p className="kiri-scroll-capture__error" role="alert">{t(error)}</p>}
      {confirmPartial ? <div className="kiri-scroll-capture__partial" role="alert">
        <p>{t("The last section could not be joined. Save only the captured portion?")}</p>
        <button type="button" className="kiri-scroll-capture__button" disabled={busy} onClick={() => {
          confirmPartialRef.current = false;
          setConfirmPartial(false);
        }}>{t("Continue adjusting")}</button>
        <button type="button" className="kiri-scroll-capture__button kiri-scroll-capture__primary" disabled={!canFinish}
          onClick={() => void runAction("finish", true)}>{t("Save captured portion")}</button>
      </div> : null}
      <footer className="kiri-scroll-capture__actions">
        <button type="button" className="kiri-scroll-capture__button" disabled={busy} onClick={() => void runAction("cancel")}
          title={t("Cancel capture · Esc")} aria-keyshortcuts="Escape">
          <X size={15} aria-hidden="true" />{t("Cancel")}
        </button>
        <button type="button" className="kiri-scroll-capture__button kiri-scroll-capture__primary" disabled={!canFinish || confirmPartial}
          onClick={() => void runAction("finish")} aria-keyshortcuts="Enter">
          <Check size={15} aria-hidden="true" />{t("Done")}
        </button>
      </footer>
      <p className="kiri-scroll-capture__hint">{t("Done copies and saves. Esc cancels.")}<br />
        {t("Enter finishes when this panel has focus.")}</p>
    </main>
  );
}
