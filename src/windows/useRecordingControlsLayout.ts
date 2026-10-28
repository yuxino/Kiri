import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { api } from "../lib/ipc";
import { onLanguageChange } from "../i18n";

type Point = { x: number; y: number };
type MoveGesture = {
  pointerId: number;
  start: Point;
  base: (Point & { scale: number }) | null;
  pending: Point | null;
  applying: boolean;
  ended: boolean;
  cancelled: boolean;
};

type DragController = {
  begin(event: ReactPointerEvent<HTMLDivElement>): void;
  move(event: ReactPointerEvent<HTMLDivElement>): void;
  end(event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void;
};

// Layout and drag writes share one queue. A slow resize can never overtake a
// user's drag, and the final native placement clamps the bar to its display.
export function useRecordingControlsLayout(sessionId: string) {
  const surface = useRef<HTMLDivElement>(null);
  const controller = useRef<DragController | null>(null);

  useEffect(() => {
    const element = surface.current;
    if (!element || !sessionId) return;
    const nativeWindow = getCurrentWindow();
    let disposed = false;
    let manuallyPlaced = false;
    let gesture: MoveGesture | null = null;
    let operations = Promise.resolve();
    let layoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceLayout = false;
    let appliedSize = "";
    let maxWidth: number | undefined;

    function measure() {
      // Measure each presentation against the monitor's stable available width,
      // never against our own resized viewport. A locale/font/scale change can
      // therefore restore the full label rather than locking in compact mode.
      element!.style.removeProperty("--kiri-record-controls-max-width");
      for (const mode of ["compact", "narrow", "minimal"]) {
        element!.removeAttribute(`data-${mode}`);
      }
      if (maxWidth !== undefined) {
        for (const mode of ["compact", "narrow", "minimal"]) {
          if (element!.getBoundingClientRect().width <= maxWidth) break;
          element!.setAttribute(`data-${mode}`, "");
        }
        element!.style.setProperty("--kiri-record-controls-max-width", `${maxWidth}px`);
      }
      const bounds = element!.getBoundingClientRect();
      return { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) };
    }

    function enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const result = operations.then(operation);
      operations = result.then(() => {}, () => {});
      return result;
    }

    function requestLayout(force = false) {
      if (disposed) return;
      forceLayout ||= force;
      clearTimeout(layoutTimer);
      layoutTimer = setTimeout(() => {
        layoutTimer = undefined;
        if (disposed || gesture) return;
        void enqueue(async () => {
          if (disposed || gesture) return;
          const { width, height } = measure();
          if (width <= 0 || height <= 0) return;
          const contentScale = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
            ? window.devicePixelRatio : 1;
          const size = `${width}x${height}@${contentScale}`;
          if (!forceLayout && appliedSize === size) return;
          forceLayout = false;
          const available = await api.positionRecordingControls({
            sessionId, width, height, contentScale, preservePosition: manuallyPlaced,
          });
          if (disposed) return;
          appliedSize = size;
          if (Number.isFinite(available.maxWidth) && available.maxWidth > 0 && maxWidth !== available.maxWidth) {
            maxWidth = available.maxWidth;
            measure();
            requestLayout();
          }
          // Avoid revealing a clipped label between the first native clamp and
          // applying its available-width constraint to the actual controls.
          element!.setAttribute("data-layout-ready", "");
        }).catch(() => {});
      }, 24);
    }

    function finishMove(move: MoveGesture) {
      if (gesture !== move || !move.ended || move.applying) return;
      gesture = null;
      requestLayout(true);
    }

    async function applyMove(move: MoveGesture) {
      if (move.applying || !move.base) return;
      move.applying = true;
      try {
        while (move.pending && !move.cancelled && !disposed) {
          const point = move.pending;
          move.pending = null;
          const { x, y, scale } = move.base;
          await enqueue(async () => {
            if (disposed || move.cancelled) return;
            await nativeWindow.setPosition(new PhysicalPosition(
              Math.round(x + (point.x - move.start.x) * scale),
              Math.round(y + (point.y - move.start.y) * scale),
            ));
          });
        }
      } catch {
        move.pending = null;
      } finally {
        move.applying = false;
        finishMove(move);
      }
    }

    controller.current = {
      begin(event) {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button,input,select,textarea,[role=slider]")) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        if (gesture) gesture.cancelled = true;
        const move: MoveGesture = {
          pointerId: event.pointerId, start: { x: event.screenX, y: event.screenY },
          base: null, pending: null, applying: false, ended: false, cancelled: false,
        };
        gesture = move;
        // AppKit native dragging depends on NSApp.currentEvent, which may no
        // longer be mouse-down after WebView IPC. Captured screen coordinates
        // avoid that race and retain serialized physical-pixel placement.
        void enqueue(() => Promise.all([
          nativeWindow.outerPosition(), nativeWindow.scaleFactor(),
        ])).then(([position, scale]) => {
          if (disposed || move.cancelled) return;
          move.base = { x: position.x, y: position.y, scale };
          void applyMove(move);
        }).catch(() => {
          move.ended = true;
          move.pending = null;
          finishMove(move);
        });
      },
      move(event) {
        const move = gesture;
        if (!move || move.ended || move.pointerId !== event.pointerId) return;
        const point = { x: event.screenX, y: event.screenY };
        if (Math.hypot(point.x - move.start.x, point.y - move.start.y) < 3 && !move.pending) return;
        manuallyPlaced = true;
        move.pending = point;
        void applyMove(move);
      },
      end(event, cancelled) {
        const move = gesture;
        if (!move || move.ended || move.pointerId !== event.pointerId) return;
        move.ended = true;
        move.cancelled = cancelled;
        if (cancelled) move.pending = null;
        else if (manuallyPlaced) move.pending = { x: event.screenX, y: event.screenY };
        if (move.base) void applyMove(move);
        else if (cancelled) finishMove(move);
      },
    };

    // A hidden compact label does not resize its parent when translated.
    // Re-measure on language changes so shorter labels can expand again.
    const unlistenLanguage = onLanguageChange(() => requestLayout(true));
    const observer = new ResizeObserver(() => requestLayout());
    observer.observe(element);
    const unlistenScale = nativeWindow.onScaleChanged(() => {
      // The drag's original pixel scale is no longer valid on a new display.
      // Settle its last native write before measuring and clamping again.
      if (gesture) {
        const move = gesture;
        move.cancelled = move.ended = true;
        move.pending = null;
        finishMove(move);
      }
      requestLayout(true);
    });
    const onResize = () => requestLayout();
    window.addEventListener("resize", onResize);
    void document.fonts.ready.then(() => requestLayout());
    requestLayout();
    return () => {
      disposed = true;
      if (gesture) gesture.cancelled = true;
      controller.current = null;
      clearTimeout(layoutTimer);
      observer.disconnect();
      unlistenLanguage();
      window.removeEventListener("resize", onResize);
      void unlistenScale.then(stop => stop()).catch(() => {});
    };
  }, [sessionId]);

  return {
    surface,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => controller.current?.begin(event),
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => controller.current?.move(event),
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => controller.current?.end(event, false),
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => controller.current?.end(event, true),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => controller.current?.end(event, true),
  };
}
