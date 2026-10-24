import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { mediaUrl, onAssetContentChanged, onPinOnTop } from "../lib/ipc";
import { t } from "../i18n";
import { KiriIcon } from "../components/KiriIcons";
import { isTextComposition } from "../annotation/text-composition.js";
import { isImageViewportScrollbar, useImageViewport } from "./useImageViewport";
import "./pin-window.css";

type ResizeGesture = {
  pointerId: number;
  x: number;
  y: number;
  base: { width: number; height: number; scale: number } | null;
  pending: { x: number; y: number } | null;
  applying: boolean;
  cancelled: boolean;
};

type MoveGesture = {
  pointerId: number;
  x: number;
  y: number;
  base: { x: number; y: number; scale: number } | null;
  pending: { x: number; y: number } | null;
  applying: boolean;
  cancelled: boolean;
};

async function applyMove(gesture: MoveGesture) {
  if (!gesture.base || gesture.applying || gesture.cancelled) return;
  gesture.applying = true;
  try {
    while (gesture.pending && !gesture.cancelled) {
      const point = gesture.pending;
      gesture.pending = null;
      const { x, y, scale } = gesture.base;
      await getCurrentWindow().setPosition(new PhysicalPosition(
        Math.round(x + (point.x - gesture.x) * scale),
        Math.round(y + (point.y - gesture.y) * scale),
      ));
    }
  } catch { gesture.pending = null; }
  finally { gesture.applying = false; }
}

async function applyResize(gesture: ResizeGesture) {
  if (!gesture.base || gesture.applying || gesture.cancelled) return;
  gesture.applying = true;
  try {
    while (gesture.pending && !gesture.cancelled) {
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
  const [imageSize, setImageSize] = useState<{w: number; h: number} | null>(null);
  const [loadedRevision, setLoadedRevision] = useState<string | null>(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const imageRevision = useRef(0);
  const imageIdentity = useRef(id);
  imageIdentity.current = id;
  const rootRef = useRef<HTMLDivElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const viewButtonRef = useRef<HTMLButtonElement>(null);
  const menuOpen = useRef(false);
  const initialMenuItem = useRef<number | null>(null);
  const resizeGesture = useRef<ResizeGesture | null>(null);
  const latestResize = useRef<ResizeGesture | null>(null);
  const moveGesture = useRef<MoveGesture | null>(null);
  const latestMove = useRef<MoveGesture | null>(null);
  const imageReady = !!imageSize && !imageFailed && loadedRevision === `${id}:${revision}`;
  const viewport = useImageViewport(imageSize, id, !imageReady, {
    padding: 0, allowUpscale: true, alignLongImagesToTop: true, fitWidthWhenOverflowing: true,
    isInteracting: () => !!moveGesture.current || !!resizeGesture.current,
  });
  const closeViewMenu = useCallback((restoreFocus = false) => {
    menuOpen.current = false;
    setViewMenuOpen(false);
    if (restoreFocus) viewButtonRef.current?.focus();
  }, []);
  const openViewMenu = (index: number | null = null) => {
    if (!imageReady) return;
    initialMenuItem.current = index;
    menuOpen.current = true;
    setViewMenuOpen(true);
  };
  useLayoutEffect(() => {
    if (!viewMenuOpen) return;
    const items = Array.from(viewMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
    const selected = items.findIndex(item => item.getAttribute("aria-checked") === "true");
    items[initialMenuItem.current ?? Math.max(0, selected)]?.focus();
  }, [viewMenuOpen]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (menuOpen.current && target && !viewMenuRef.current?.contains(target) && !viewButtonRef.current?.contains(target)) closeViewMenu();
    };
    const blur = () => {
      closeViewMenu();
      if (latestMove.current) { latestMove.current.cancelled = true; latestMove.current.pending = null; }
      if (latestResize.current) { latestResize.current.cancelled = true; latestResize.current.pending = null; }
      moveGesture.current = null;
      resizeGesture.current = null;
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", blur); };
  }, [closeViewMenu]);
  useEffect(() => () => {
    if (latestMove.current) latestMove.current.cancelled = true;
    if (latestResize.current) latestResize.current.cancelled = true;
  }, []);
  useEffect(() => {
    const subscription = onAssetContentChanged((assetId) => {
      if (assetId === id) {
        // Invalidate old load/error callbacks before React paints the new URL.
        imageRevision.current += 1;
        setImageFailed(false);
        setRevision(imageRevision.current);
        closeViewMenu();
      }
    });
    return () => { void subscription.then((dispose) => dispose()).catch(() => {}); };
  }, [id, closeViewMenu]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextComposition(event)) return;
      const closeShortcut = event.key === "Escape" || ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w");
      if (event.repeat) { if (closeShortcut) event.preventDefault(); return; }
      if (event.key === "Escape" && menuOpen.current) {
        event.preventDefault(); closeViewMenu(true); return;
      }
      if (closeShortcut) {
        event.preventDefault(); void getCurrentWindow().close();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [closeViewMenu]);
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
  const menuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isTextComposition(event) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) closeViewMenu(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault(); event.stopPropagation();
      const controls = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("button:not([role=menuitemradio]):not(:disabled)") ?? [])
        .filter(button => button.getClientRects().length > 0);
      const index = controls.indexOf(viewButtonRef.current!);
      closeViewMenu();
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = Array.from(viewMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
    const index = items.findIndex(item => item === event.target || item.contains(event.target as Node));
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  const autoReadingWidth = imageSize && (imageSize.h > imageSize.w * 2 || imageSize.h * viewport.size.width / imageSize.w > viewport.size.height + 1);
  const selectedView = viewport.mode === "manual" ? (Math.abs(viewport.layout.zoom - 1) < .001 ? "actual" : null)
    : viewport.mode === "auto" ? (autoReadingWidth ? "width" : "fit") : viewport.mode;
  const zoomLabel = imageReady ? `${Math.round(viewport.layout.zoom * 1000) / 10}%` : "—";
  return <div ref={rootRef} className="pin-window" aria-label={t("Screenshot Reference")} data-view-menu-open={viewMenuOpen || undefined}
    onContextMenu={event => event.preventDefault()}>
    <div className="pin-window__actions" onPointerDown={event => event.stopPropagation()}>
      <button className="kiri-pin-action" type="button" disabled={busy}
        title={t(onTop ? "Unpin" : "Pin on Top")} aria-label={t(onTop ? "Unpin" : "Pin on Top")}
        onClick={() => void toggleTop()}><KiriIcon name={onTop ? "pin.slash" : "pin"} size={15} /></button>
      <button className="kiri-pin-action" type="button" title={t("Close")} aria-label={t("Close")}
        onClick={() => void getCurrentWindow().close()}><KiriIcon name="xmark" size={15} /></button>
    </div>
    {error && <p className="pin-window__error" role="alert">{t("Could not change window pinning on this desktop.")}</p>}
    <main className="pin-window__image" onPointerDown={event => {
      if (event.defaultPrevented || event.button !== 0 || event.pointerType === "touch" || viewport.space || viewport.panning
        || isImageViewportScrollbar(event, viewport.containerRef.current)) return;
      closeViewMenu();
      if (!/Macintosh|Mac OS X|Windows/i.test(navigator.userAgent)) {
        void getCurrentWindow().startDragging().catch(() => {});
        return;
      }
      // Native dragging reaches AppKit/Win32 asynchronously and a short gesture
      // may already have ended. Capture screen coordinates and retain pointerup
      // while the native origin loads. Linux keeps compositor-managed dragging.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      if (latestMove.current) latestMove.current.cancelled = true;
      const gesture: MoveGesture = { pointerId: event.pointerId, x: event.screenX, y: event.screenY,
        base: null, pending: null, applying: false, cancelled: false };
      moveGesture.current = latestMove.current = gesture;
      const nativeWindow = getCurrentWindow();
      void Promise.all([nativeWindow.outerPosition(), nativeWindow.scaleFactor()]).then(([position, scale]) => {
        gesture.base = { x: position.x, y: position.y, scale };
        void applyMove(gesture);
      }).catch(() => { gesture.pending = null; });
    }} onPointerMove={event => {
      const gesture = moveGesture.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.pending = { x: event.screenX, y: event.screenY };
      void applyMove(gesture);
    }} onPointerUp={event => {
      const gesture = moveGesture.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.pending = { x: event.screenX, y: event.screenY };
      moveGesture.current = null;
      void applyMove(gesture);
    }} onPointerCancel={() => {
      if (moveGesture.current) {
        moveGesture.current.cancelled = true;
        moveGesture.current.pending = null;
      }
      moveGesture.current = null;
    }} onLostPointerCapture={event => {
      const gesture = moveGesture.current;
      if (gesture?.pointerId === event.pointerId) {
        gesture.cancelled = true; gesture.pending = null; moveGesture.current = null;
      }
    }}>
      <div ref={viewport.containerRef} className="pin-window__viewport" {...viewport.handlers}
        data-pan-ready={viewport.space || undefined} data-panning={viewport.panning || undefined} aria-busy={!imageReady && !imageFailed}>
        {imageFailed ? <p role="alert">{t("Can't read this file")}</p> : <div className="pin-window__surface"
          style={{width: viewport.layout.surfaceWidth, height: viewport.layout.surfaceHeight}}>
          <img key={`${id}:${revision}`} src={`${mediaUrl(id)}?v=${revision}`} alt={t("Pinned screenshot")} draggable={false}
            style={{left: viewport.layout.x, top: viewport.layout.y, width: viewport.layout.width, height: viewport.layout.height, visibility: imageReady ? "visible" : "hidden"}}
            onLoad={event => {
              if (imageIdentity.current !== id || imageRevision.current !== revision) return;
              const {naturalWidth: w, naturalHeight: h} = event.currentTarget;
              if (!(w > 0 && h > 0)) { setImageFailed(true); return; }
              setImageSize(previous => previous?.w === w && previous.h === h ? previous : {w, h});
              setLoadedRevision(`${id}:${revision}`);
            }} onError={() => { if (imageIdentity.current === id && imageRevision.current === revision) setImageFailed(true); }} />
        </div>}
      </div>
    </main>
    <div className="pin-window__viewbar" role="group" aria-label={t("Zoom level")} onPointerDown={event => event.stopPropagation()}>
      <button className="kiri-pin-action pin-window__zoom-step" type="button" aria-label={t("Zoom out")} title={t("Zoom out")}
        disabled={!imageReady} onClick={() => viewport.zoomBy(.8)}><Minus size={15} /></button>
      <button ref={viewButtonRef} className="kiri-pin-action pin-window__zoom-value" type="button" aria-label={`${t("Zoom level")}: ${zoomLabel}`}
        title={t("Drag to move the window. Scroll to view. Pinch or hold Ctrl/Command and scroll to zoom. Hold Space and drag to pan.")}
        aria-haspopup="menu" aria-expanded={viewMenuOpen} disabled={!imageReady}
        onClick={() => menuOpen.current ? closeViewMenu() : openViewMenu()}
        onKeyDown={event => {
          if (isTextComposition(event) || event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); event.stopPropagation(); openViewMenu(event.key === "ArrowUp" ? 2 : 0);
          }
        }}>{zoomLabel}</button>
      <button className="kiri-pin-action pin-window__zoom-step" type="button" aria-label={t("Zoom in")} title={t("Zoom in")}
        disabled={!imageReady} onClick={() => viewport.zoomBy(1.25)}><Plus size={15} /></button>
    </div>
    {viewMenuOpen && <div ref={viewMenuRef} className="pin-window__menu" role="menu" aria-label={t("View")} onKeyDown={menuKeyDown}
      onPointerDown={event => event.stopPropagation()}>
      {([{key: "width", label: t("Fit width")}, {key: "fit", label: t("Fit image")}, {key: "actual", label: t("Actual size")}] as const).map(choice =>
        <button className="kiri-pin-view-choice" type="button" key={choice.key} role="menuitemradio" tabIndex={-1} aria-checked={selectedView === choice.key} disabled={!imageReady}
          onClick={() => { viewport.changeView(choice.key === "actual" ? "manual" : choice.key, choice.key === "actual" ? 1 : undefined); closeViewMenu(true); }}>
          <span>{choice.label}</span><span aria-hidden="true">{selectedView === choice.key ? "✓" : ""}</span>
        </button>)}
    </div>}
    <div className="pin-window__resize" aria-hidden="true" onPointerDown={event => {
        event.stopPropagation();
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        if (latestResize.current) { latestResize.current.cancelled = true; latestResize.current.pending = null; }
        const gesture: ResizeGesture = { pointerId: event.pointerId, x: event.screenX, y: event.screenY,
          base: null, pending: null, applying: false, cancelled: false };
        resizeGesture.current = latestResize.current = gesture;
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
      }} onPointerCancel={() => {
        if (resizeGesture.current) { resizeGesture.current.cancelled = true; resizeGesture.current.pending = null; }
        resizeGesture.current = null;
      }} onLostPointerCapture={event => {
        const gesture = resizeGesture.current;
        if (gesture?.pointerId === event.pointerId) {
          gesture.cancelled = true; gesture.pending = null; resizeGesture.current = null;
        }
      }} />
  </div>;
}
