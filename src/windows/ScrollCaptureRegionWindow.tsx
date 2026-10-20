import { useEffect, useState } from "react";
import { t } from "../i18n";
import "./scroll-capture-region.css";

type Selection = { x: number; y: number; width: number; height: number };
const readViewport = () => ({
  width: window.innerWidth, height: window.innerHeight,
  scale: Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
});

// The native window is nonactivating and ignores pointer input. Every painted
// rectangle stays outside the captured pixels, including on X11 without native
// capture exclusion. The transparent hole contains no element or border.
export function ScrollCaptureRegionWindow(selection: Selection) {
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const resize = () => setViewport(readViewport());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  if (![selection.x, selection.y, selection.width, selection.height, viewport.width, viewport.height].every(Number.isFinite) ||
      selection.width <= 0 || selection.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  // Round away from the hole so fractional CSS coordinates never dim a
  // captured device pixel. Any rounding gap remains outside the selection.
  const left = Math.max(0, Math.floor(selection.x * viewport.scale) / viewport.scale);
  const top = Math.max(0, Math.floor(selection.y * viewport.scale) / viewport.scale);
  const right = Math.min(viewport.width, Math.ceil((selection.x + selection.width) * viewport.scale) / viewport.scale);
  const bottom = Math.min(viewport.height, Math.ceil((selection.y + selection.height) * viewport.scale) / viewport.scale);
  if (right <= left || bottom <= top) return null;
  const width = right - left, height = bottom - top;
  const masks = [
    { left: 0, top: 0, width: viewport.width, height: top },
    { left: 0, top, width: left, height },
    { left: right, top, width: viewport.width - right, height },
    { left: 0, top: bottom, width: viewport.width, height: viewport.height - bottom },
  ];
  const borders = [
    { left: left - 1, top: top - 1, width: width + 2, height: 1 },
    { left: left - 1, top, width: 1, height },
    { left: right, top, width: 1, height },
    { left: left - 1, top: bottom, width: width + 2, height: 1 },
  ];
  const hintTop = top >= 36 ? top - 36 : viewport.height - bottom >= 36 ? bottom + 8 : null;
  const hintWidth = Math.min(320, Math.max(0, viewport.width - 16));
  const hintLeft = Math.max(8, Math.min(viewport.width - 8 - hintWidth, (left + right - hintWidth) / 2));
  return <div className="kiri-dark kiri-scroll-region" aria-hidden="true">
    {masks.map((style, index) => style.width > 0 && style.height > 0 &&
      <div key={`mask-${index}`} className="kiri-scroll-region__mask" style={style} />)}
    {borders.map((style, index) =>
      <div key={`border-${index}`} className="kiri-scroll-region__border" style={style} />)}
    {hintTop !== null && hintWidth > 0 && <div className="kiri-scroll-region__hint-slot"
      style={{ left: hintLeft, top: hintTop, width: hintWidth, height: 28 }}>
      <span className="kiri-scroll-region__hint">{t("Scroll up or down")}</span>
    </div>}
  </div>;
}
