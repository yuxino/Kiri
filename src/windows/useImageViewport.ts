import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { imageViewport, imageZoomAnchor, scrollToImageAnchor, visibleImageViewport, type ImageViewMode } from "../annotation/image-viewport.js";
import { isTextComposition } from "../annotation/text-composition.js";

const editable = (target: EventTarget | null) => target instanceof Element && !!target.closest("input,textarea,select,[contenteditable]");

export function useImageViewport(image: {w: number; h: number} | null, identity: string, disabled: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({width: 800, height: 560});
  const [scroll, setScroll] = useState({x: 0, y: 0});
  const [view, setView] = useState<{mode: ImageViewMode; zoom: number}>({mode: "auto", zoom: 1});
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const gesture = useRef(false);
  const pan = useRef<{id: number; x: number; y: number; left: number; top: number} | null>(null);
  const pending = useRef<{source: {x: number; y: number}; point: {x: number; y: number}} | null>(null);
  const layout = useMemo(() => imageViewport({width: image?.w ?? 1, height: image?.h ?? 1}, size, view.mode, view.zoom, dpr), [image, size, view, dpr]);
  const latest = useRef({layout, size, disabled, dpr});
  latest.current = {layout, size, disabled, dpr};
  const readScroll = useCallback(() => {
    const element = containerRef.current;
    if (element) setScroll(previous => previous.x === element.scrollLeft && previous.y === element.scrollTop ? previous : {x: element.scrollLeft, y: element.scrollTop});
  }, []);
  const preserveAnchor = useCallback((point?: {x: number; y: number}) => {
    const element = containerRef.current;
    if (!element) return;
    const current = latest.current;
    const anchor = point ?? {x: current.size.width / 2, y: current.size.height / 2};
    pending.current = {source: imageZoomAnchor(current.layout, {x: element.scrollLeft, y: element.scrollTop}, anchor), point: anchor};
  }, []);
  const changeView = useCallback((mode: ImageViewMode, zoom?: number, point?: {x: number; y: number}) => {
    if (latest.current.disabled || gesture.current) return;
    preserveAnchor(point);
    setView({mode, zoom: Math.max(Math.min(0.005, latest.current.layout.zoom), Math.min(Math.max(8, latest.current.layout.zoom), zoom ?? latest.current.layout.zoom))});
  }, [preserveAnchor]);
  const zoomBy = useCallback((factor: number, point?: {x: number; y: number}) => changeView("manual", latest.current.layout.zoom * factor, point), [changeView]);
  useLayoutEffect(() => {
    setView({mode: "auto", zoom: 1});
    pending.current = null;
    if (containerRef.current) { containerRef.current.scrollLeft = 0; containerRef.current.scrollTop = 0; }
    setScroll({x: 0, y: 0});
  }, [identity, image?.w, image?.h]);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const publish = () => {
      const next = {width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight)};
      const nextDpr = window.devicePixelRatio || 1;
      if (next.width !== latest.current.size.width || next.height !== latest.current.size.height || nextDpr !== latest.current.dpr) {
        preserveAnchor();
        if (pending.current) pending.current.point = {x: next.width / 2, y: next.height / 2};
        setSize(next);
      }
      setDpr(nextDpr);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    window.addEventListener("resize", publish);
    return () => { observer.disconnect(); window.removeEventListener("resize", publish); };
  }, [preserveAnchor]);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    if (pending.current) {
      const next = scrollToImageAnchor(layout, size, pending.current.source, pending.current.point);
      element.scrollLeft = next.x; element.scrollTop = next.y;
      pending.current = null;
    }
    readScroll();
  }, [layout, size, readScroll]);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (gesture.current || latest.current.disabled) { event.preventDefault(); return; }
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? latest.current.size.height : 1);
      zoomBy(Math.exp(-Math.max(-120, Math.min(120, delta)) * 0.008), {x: event.clientX - rect.left, y: event.clientY - rect.top});
    };
    let pinchStart = 1;
    const pinch = (event: Event) => {
      event.preventDefault();
      const gestureEvent = event as Event & {scale: number; clientX: number; clientY: number};
      if (event.type === "gesturestart") pinchStart = latest.current.layout.zoom;
      const rect = element.getBoundingClientRect();
      changeView("manual", pinchStart * gestureEvent.scale, {x: gestureEvent.clientX - rect.left, y: gestureEvent.clientY - rect.top});
    };
    element.addEventListener("wheel", wheel, {passive: false});
    element.addEventListener("gesturestart", pinch, {passive: false});
    element.addEventListener("gesturechange", pinch, {passive: false});
    return () => { element.removeEventListener("wheel", wheel); element.removeEventListener("gesturestart", pinch); element.removeEventListener("gesturechange", pinch); };
  }, [zoomBy, changeView]);
  useEffect(() => {
    const reset = () => { gesture.current = false; pan.current = null; setPanning(false); setSpace(false); };
    const finish = () => { gesture.current = false; pan.current = null; setPanning(false); };
    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextComposition(event) || editable(event.target) || latest.current.disabled) return;
      if (event.code === "Space" && !(event.target instanceof Element && event.target.closest("button"))) {
        event.preventDefault(); setSpace(true); return;
      }
      if (!event.metaKey && !event.ctrlKey) return;
      if (["+", "="].includes(event.key)) { event.preventDefault(); zoomBy(1.25); }
      else if (event.key === "-") { event.preventDefault(); zoomBy(0.8); }
      else if (event.key === "0") { event.preventDefault(); changeView("fit"); }
      else if (event.key === "1") { event.preventDefault(); changeView("manual", 1); }
    };
    const up = (event: KeyboardEvent) => { if (event.code === "Space") setSpace(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up, true);
    window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish); window.addEventListener("blur", reset);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); window.removeEventListener("blur", reset); };
  }, [changeView, zoomBy]);
  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (editable(event.target)) {
      // A callout text frame can promote its pointer into a canvas drag.
      // Preserve its geometry while text selection/IME still owns the input.
      if (event.button === 0) gesture.current = true;
      return;
    }
    if (event.button === 1 || (space && event.button === 0)) {
      event.preventDefault(); event.stopPropagation();
      pan.current = {id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop};
      event.currentTarget.setPointerCapture(event.pointerId); setPanning(true);
    } else if (event.button === 0) gesture.current = true;
  };
  const onPointerMoveCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pan.current;
    if (!start || start.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
    event.currentTarget.scrollTop = start.top + start.y - event.clientY;
    readScroll();
  };
  const finishPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pan.current?.id === event.pointerId) { event.preventDefault(); event.stopPropagation(); }
    pan.current = null; gesture.current = false; setPanning(false);
  };
  return {containerRef, size, layout, scroll, viewSize: {width: layout.width, height: layout.height},
    visibleViewport: visibleImageViewport(layout, size, scroll), mode: view.mode, changeView, zoomBy,
    handlers: {onScroll: readScroll, onPointerDownCapture, onPointerMoveCapture, onPointerUpCapture: finishPan,
      onPointerCancelCapture: finishPan, onLostPointerCapture: finishPan}, panning, space};
}
