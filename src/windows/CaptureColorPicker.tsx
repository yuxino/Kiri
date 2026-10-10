import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { Point, Rect } from "../annotation/geom";
import { t } from "../i18n";
import { canCopyCaptureOnKeyDown } from "./viewer-copy-shortcut.js";
import { captureColorHex, captureColorPixel, captureColorPosition } from "./capture-color.js";
import "./capture-color.css";

const PREVIEW_PIXELS = 15;
const CENTER_PIXEL = Math.floor(PREVIEW_PIXELS / 2);
const PANEL_SIZE = { width: 184, height: 276 };

type ColorSample = { point: Point; pixel: Point; hex: string; preview: ImageData };
type CopyFeedback = { hex: string; failed: boolean };

/** Samples a tiny sRGB patch; never duplicates the full display in a canvas. */
export function useCaptureColorPicker(
  enabled: boolean,
  imageRef: RefObject<HTMLImageElement | null>,
  bounds: Rect,
  copyColor: (hex: string) => Promise<void>,
) {
  const [sample, setSample] = useState<ColorSample | null>(null);
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null);
  const sampleRef = useRef<ColorSample | null>(null);
  const pendingPoint = useRef<Point | null>(null);
  const frame = useRef<number | null>(null);
  const sampler = useRef<CanvasRenderingContext2D | null>(null);
  const copying = useRef(false);
  const active = useRef(true);
  const current = useRef({ enabled, bounds });
  current.current = { enabled, bounds };

  const clear = useCallback(() => {
    pendingPoint.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    sampleRef.current = null;
    setSample(null);
    setFeedback(null);
  }, []);

  const samplePoint = useCallback(() => {
    frame.current = null;
    const point = pendingPoint.current;
    pendingPoint.current = null;
    const image = imageRef.current;
    if (!current.current.enabled || !point || !image?.complete || !image.naturalWidth) return;
    const pixel = captureColorPixel(point, current.current.bounds, { width: image.naturalWidth, height: image.naturalHeight });
    if (!pixel) { clear(); return; }
    if (!sampler.current) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = PREVIEW_PIXELS;
      sampler.current = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    }
    const ctx = sampler.current;
    if (!ctx) return;
    try {
      ctx.clearRect(0, 0, PREVIEW_PIXELS, PREVIEW_PIXELS);
      ctx.drawImage(image, pixel.x - CENTER_PIXEL, pixel.y - CENTER_PIXEL, PREVIEW_PIXELS, PREVIEW_PIXELS,
        0, 0, PREVIEW_PIXELS, PREVIEW_PIXELS);
      const preview = ctx.getImageData(0, 0, PREVIEW_PIXELS, PREVIEW_PIXELS);
      const offset = (CENTER_PIXEL * PREVIEW_PIXELS + CENTER_PIXEL) * 4;
      const next = { point, pixel, hex: captureColorHex(preview.data.subarray(offset, offset + 4)), preview };
      sampleRef.current = next;
      setSample(next);
    } catch { clear(); }
  }, [clear, imageRef]);

  useEffect(() => { if (!enabled) clear(); }, [enabled, clear]);
  useEffect(() => {
    active.current = true;
    window.addEventListener("blur", clear);
    return () => {
      active.current = false;
      window.removeEventListener("blur", clear);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      sampler.current = null;
    };
  }, [clear]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    // Capture phase also observes controls that stop propagation. Only bare
    // frozen-screen hover may supply a color; gestures and controls clear it.
    if (!current.current.enabled || event.buttons !== 0 || event.target !== event.currentTarget) {
      clear();
      return;
    }
    pendingPoint.current = { x: event.clientX, y: event.clientY };
    if (frame.current === null) frame.current = requestAnimationFrame(samplePoint);
  }, [clear, samplePoint]);

  const onCopyKeyDown = useCallback((event: KeyboardEvent) => {
    if (!current.current.enabled || !canCopyCaptureOnKeyDown(event, {
      canCopy: () => !!sampleRef.current || !!pendingPoint.current,
      hasTextSelection: () => !!window.getSelection()?.toString(),
    })) return false;
    // A key can arrive before the next animation frame after a pointer move.
    if (pendingPoint.current) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      samplePoint();
    }
    const picked = sampleRef.current;
    if (!picked) return false;
    event.preventDefault();
    if (event.repeat || copying.current) return true;
    copying.current = true;
    void copyColor(picked.hex).then(() => {
      if (active.current && sampleRef.current) setFeedback({ hex: picked.hex, failed: false });
    }).catch(() => {
      if (active.current && sampleRef.current) setFeedback({ hex: picked.hex, failed: true });
    }).finally(() => { copying.current = false; });
    return true;
  }, [copyColor, samplePoint]);

  return { sample: enabled ? sample : null, feedback, clear, onPointerMove, onCopyKeyDown };
}

export function CaptureColorPicker(props: { sample: ColorSample; feedback: CopyFeedback | null; bounds: Rect }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    canvasRef.current?.getContext("2d")?.putImageData(props.sample.preview, 0, 0);
  }, [props.sample]);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const feedback = props.feedback?.hex === props.sample.hex ? props.feedback : null;
  const hint = feedback
    ? t(feedback.failed ? "Could not copy color" : "Color copied")
    : t(isMac ? "⌘C to copy color" : "Ctrl+C to copy color");
  return <div className="kiri-color-picker" style={captureColorPosition(props.sample.point, props.bounds, PANEL_SIZE)}>
    <div className="kiri-color-picker-preview" aria-hidden="true">
      <canvas ref={canvasRef} width={PREVIEW_PIXELS} height={PREVIEW_PIXELS} />
      <div className="kiri-color-picker-crosshair" />
      <div className="kiri-color-picker-pixel" />
    </div>
    <div className="kiri-color-picker-values">
      <div><span>{t("Coordinates")}</span><output>{props.sample.pixel.x}, {props.sample.pixel.y}</output></div>
      <div><span>{t("Color value")}</span><output><i style={{ backgroundColor: props.sample.hex }} />{props.sample.hex}</output></div>
      <p role="status" data-failed={feedback?.failed || undefined}>{hint}</p>
    </div>
  </div>;
}
