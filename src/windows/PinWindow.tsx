import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { mediaUrl, onAssetContentChanged, onPinOnTop } from "../lib/ipc";
import { t } from "../i18n";
import { KiriIcon } from "../components/KiriIcons";
import "./pin-window.css";

type ResizeGesture = {
  pointerId: number;
  x: number;
  y: number;
  base: { width: number; height: number; scale: number } | null;
  pending: { x: number; y: number } | null;
  applying: boolean;
};

async function applyResize(gesture: ResizeGesture) {
  if (!gesture.base || gesture.applying) return;
  gesture.applying = true;
  try {
    while (gesture.pending) {
      const point = gesture.pending;
      gesture.pending = null;
      const { width, height, scale } = gesture.base;
      const dx = (point.x - gesture.x) * scale / width;
      const dy = (point.y - gesture.y) * scale / height;
      const minimum = Math.min(1, Math.max(80 * scale / width, 60 * scale / height));
      const ratio = Math.max(minimum, 1 + (Math.abs(dx) > Math.abs(dy) ? dx : dy));
      await getCurrentWindow().setSize(new PhysicalSize(Math.round(width * ratio), Math.round(height * ratio)));
    }
  } catch { gesture.pending = null; }
  finally { gesture.applying = false; }
}

export function PinWindow({ id }: { id: string }) {
  const [onTop, setOnTop] = useState(true);
  const [busy, setBusy] = useState(false);
  const topState = useRef({onTop: true, generation: 0, busy: false});
  const [error, setError] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const resizeGesture = useRef<ResizeGesture | null>(null);
  useEffect(() => {
    const subscription = onAssetContentChanged((assetId) => {
      if (assetId === id) { setImageFailed(false); setRevision((value) => value + 1); }
    });
    return () => { void subscription.then((dispose) => dispose()).catch(() => {}); };
  }, [id]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w")) {
        event.preventDefault(); void getCurrentWindow().close();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Every new pin is created with always_on_top(true). The native getter can
    // briefly report false while the window manager is applying that request.
    // Track successful Kiri pin actions instead of freezing that startup snapshot.
    void onPinOnTop(() => {
      if (disposed) return;
      topState.current.generation += 1;
      topState.current.onTop = true;
      setOnTop(true);
      setError(false);
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const toggleTop = async () => {
    const state = topState.current;
    if (state.busy) return;
    state.busy = true;
    const generation = state.generation;
    const next = !state.onTop;
    setBusy(true); setError(false);
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
      // A library repin received while this request was pending is newer.
      if (state.generation === generation) {
        state.onTop = next;
        setOnTop(next);
      }
    }
    catch { if (state.generation === generation) setError(true); }
    finally { state.busy = false; setBusy(false); }
  };
  return <div className="pin-window" aria-label={t("Screenshot Reference")}>
    <div className="pin-window__actions" onPointerDown={event => event.stopPropagation()}>
      <button className="kiri-pin-action" type="button" disabled={busy}
        title={t(onTop ? "Unpin" : "Pin on Top")} aria-label={t(onTop ? "Unpin" : "Pin on Top")}
        onClick={() => void toggleTop()}><KiriIcon name={onTop ? "pin.slash" : "pin"} size={15} /></button>
      <button className="kiri-pin-action" type="button" title={t("Close")} aria-label={t("Close")}
        onClick={() => void getCurrentWindow().close()}><KiriIcon name="xmark" size={15} /></button>
    </div>
    {error && <p className="pin-window__error" role="alert">{t("Could not change window pinning on this desktop.")}</p>}
    <main className="pin-window__image" onPointerDown={event => {
      if (event.button === 0) void getCurrentWindow().startDragging().catch(() => {});
    }}>
      {imageFailed ? <p role="alert">{t("Can't read this file")}</p> :
        <img key={revision} src={`${mediaUrl(id)}?v=${revision}`} alt={t("Pinned screenshot")} draggable={false} onError={() => setImageFailed(true)} />}
    </main>
    <div className="pin-window__resize" aria-hidden="true" onPointerDown={event => {
        event.stopPropagation();
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const gesture: ResizeGesture = { pointerId: event.pointerId, x: event.screenX, y: event.screenY,
          base: null, pending: null, applying: false };
        resizeGesture.current = gesture;
        const window = getCurrentWindow();
        void Promise.all([window.innerSize(), window.scaleFactor()]).then(([size, scale]) => {
          gesture.base = { width: size.width, height: size.height, scale };
          void applyResize(gesture);
        }).catch(() => { gesture.pending = null; });
      }} onPointerMove={event => {
        const gesture = resizeGesture.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gesture.pending = { x: event.screenX, y: event.screenY };
        void applyResize(gesture);
      }} onPointerUp={event => {
        const gesture = resizeGesture.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gesture.pending = { x: event.screenX, y: event.screenY };
        resizeGesture.current = null;
        void applyResize(gesture);
      }} onPointerCancel={() => { resizeGesture.current = null; }} />
  </div>;
}
