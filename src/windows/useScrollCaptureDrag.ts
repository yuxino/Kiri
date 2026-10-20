import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../lib/ipc";

type Point = { x: number; y: number };
type Gesture = {
  pointerId: number;
  target: HTMLElement;
  start: Point;
  base: (Point & { scale: number }) | null;
  pending: Point | null;
  moved: boolean;
  applying: boolean;
  ended: boolean;
  cancelled: boolean;
};
type Pointer = ReactPointerEvent<HTMLElement>;
type DragController = {
  begin(event: Pointer): void;
  move(event: Pointer): void;
  end(event: Pointer, cancelled: boolean): void;
};

export function useScrollCaptureDrag(sessionId: string) {
  const [dragging, setDragging] = useState(false);
  const controller = useRef<DragController | null>(null);
  const operations = useRef(Promise.resolve());

  useEffect(() => {
    if (!sessionId) return;
    const nativeWindow = getCurrentWindow();
    let disposed = false;
    let gesture: Gesture | null = null;
    let committedPosition: Point | null = null;
    let positionEpoch = 0;
    setDragging(false);

    function enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const result = operations.current.then(operation);
      operations.current = result.then(() => {}, () => {});
      return result;
    }
    function release(move: Gesture) {
      try {
        if (move.target.hasPointerCapture(move.pointerId)) move.target.releasePointerCapture(move.pointerId);
      } catch { /* The target may already have been removed. */ }
    }
    function cancelGesture() {
      const move = gesture;
      if (!move) return;
      move.cancelled = move.ended = true;
      move.pending = null;
      gesture = null;
      release(move);
      if (!disposed) setDragging(false);
    }
    async function applyMove(move: Gesture) {
      if (move.applying || !move.base || move.cancelled || disposed) return;
      move.applying = true;
      try {
        while (move.pending && gesture === move && !move.cancelled && !disposed) {
          const point = move.pending;
          move.pending = null;
          const { x, y, scale } = move.base;
          await enqueue(async () => {
            if (disposed || move.cancelled || gesture !== move) return;
            const epoch = positionEpoch;
            const accepted = await api.moveScrollCapturePanel(sessionId,
              Math.round(x + (point.x - move.start.x) * scale),
              Math.round(y + (point.y - move.start.y) * scale));
            // Native placement is asynchronous. Even a cancelled/superseded
            // gesture can already have submitted a move; its accepted clamped
            // point is the next gesture's origin while OS position reads lag.
            if (!disposed && epoch === positionEpoch) committedPosition = accepted;
          });
        }
      } catch {
        if (gesture === move) cancelGesture();
      } finally {
        move.applying = false;
        if (move.ended && gesture === move) gesture = null;
      }
    }
    function updatePoint(move: Gesture, event: Pointer) {
      const point = { x: event.screenX, y: event.screenY };
      if (!move.moved && Math.hypot(point.x - move.start.x, point.y - move.start.y) < 3) return;
      move.moved = true;
      move.pending = point;
    }

    controller.current = {
      begin(event) {
        if (event.button !== 0 || event.isPrimary === false || (event.target as HTMLElement).closest("button")) return;
        cancelGesture();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; }
        event.preventDefault();
        const move: Gesture = {
          pointerId: event.pointerId, target: event.currentTarget,
          start: { x: event.screenX, y: event.screenY }, base: null, pending: null,
          moved: false, applying: false, ended: false, cancelled: false,
        };
        gesture = move;
        setDragging(true);
        // Read the origin after earlier writes settle. Retain a short gesture's
        // pointerup while these native reads are still pending.
        void enqueue(async () => {
          if (disposed || move.cancelled || gesture !== move) return null;
          const [position, scale] = await Promise.all([
            committedPosition ?? nativeWindow.outerPosition(), nativeWindow.scaleFactor(),
          ]);
          if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid window scale");
          return { x: position.x, y: position.y, scale };
        }).then(base => {
          if (!base || disposed || move.cancelled || gesture !== move) return;
          move.base = base;
          void applyMove(move);
        }).catch(() => { if (gesture === move) cancelGesture(); });
      },
      move(event) {
        const move = gesture;
        if (!move || move.ended || move.pointerId !== event.pointerId) return;
        updatePoint(move, event);
        void applyMove(move);
      },
      end(event, cancelled) {
        const move = gesture;
        if (!move || move.ended || move.pointerId !== event.pointerId) return;
        if (cancelled) { cancelGesture(); return; }
        updatePoint(move, event);
        move.ended = true;
        setDragging(false);
        // Normal pointerup releases capture too; its later lostcapture event
        // must not discard the final point waiting on native reads or writes.
        release(move);
        if (move.pending || move.applying) void applyMove(move);
        else gesture = null;
      },
    };
    const unlistenScale = nativeWindow.onScaleChanged(() => {
      if (disposed) return;
      positionEpoch++;
      committedPosition = null;
      cancelGesture();
    });
    return () => {
      disposed = true;
      cancelGesture();
      controller.current = null;
      void unlistenScale.then(stop => stop()).catch(() => {});
    };
  }, [sessionId]);

  return {
    "data-dragging": dragging || undefined,
    onPointerDown: (event: Pointer) => controller.current?.begin(event),
    onPointerMove: (event: Pointer) => controller.current?.move(event),
    onPointerUp: (event: Pointer) => controller.current?.end(event, false),
    onPointerCancel: (event: Pointer) => controller.current?.end(event, true),
    onLostPointerCapture: (event: Pointer) => controller.current?.end(event, true),
  };
}
