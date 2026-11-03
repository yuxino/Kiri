import { useLayoutEffect, useRef, useState } from "react";
import { KiriIcon } from "../components/KiriIcons";
import { t } from "../i18n";
import type { Rect } from "../annotation/geom";
import { capturePanelLayout } from "../windows/toolbar-layout.js";
import "./ocr-result-panel.css";

export function OcrResultPanel({ text, saved, error, anchor, bounds, modeSelectorBounds, onCopy, onClose, onReselect }: {
  text: string;
  saved: boolean;
  error: string | null;
  anchor: Rect;
  bounds: Rect;
  modeSelectorBounds?: Rect | null;
  onCopy(): Promise<void>;
  onClose(): void;
  onReselect(): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const copying = useRef(false);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "failed">("idle");
  const [height, setHeight] = useState(0);
  const hasText = !error && Boolean(text.trim());
  const title = error ? "Text Recognition Failed" : hasText ? "Recognized Text" : "No Text Found";
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const measure = () => {
      // Measure the natural content even when placement has to cap the panel.
      const next = Math.ceil(node.getBoundingClientRect().height + Math.max(0, node.scrollHeight - node.clientHeight));
      setHeight(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, [hasText, copyState, saved, text]);

  const copy = async () => {
    if (copying.current || !hasText) return;
    copying.current = true;
    setCopyState("copying");
    try {
      await onCopy(); // The native command dismisses the overlay on success.
    } catch {
      setCopyState("failed");
      copying.current = false;
    }
  };
  const { left, top, width, maxHeight } = capturePanelLayout(anchor, bounds, { width: 384, height }, modeSelectorBounds);
  return <section ref={panel} className="kiri-hud ocr-result" aria-labelledby="ocr-result-title"
    onPointerDown={event => event.stopPropagation()} style={{ left, top, width, maxHeight }}>
    <header className="ocr-result__header">
      <h2 id="ocr-result-title"><KiriIcon name="text.viewfinder" size={16} />{t(title)}</h2>
      <button type="button" className="kiri-icon-button kiri-icon-button--hud" aria-label={t("Close")} title={t("Close")} onClick={onClose}><KiriIcon name="xmark" size={13} /></button>
    </header>
    {hasText && <div className="ocr-result__body" role="region" aria-label={t("Recognized Text")} tabIndex={0}>{text}</div>}
    {error && error !== title && <p className="ocr-result__message" role="alert">{t(error)}</p>}
    {hasText && saved && <p className="ocr-result__saved" role="status">{t("Saved to Text History")}</p>}
    {hasText && !saved && <p className="ocr-result__message" role="status">{t("History wasn't saved. Copy the text before closing.")}</p>}
    {copyState === "failed" && <p className="ocr-result__message" role="alert">{t("Couldn't copy text.")}</p>}
    <footer className="ocr-result__footer">
      <button type="button" className={hasText ? "kiri-button kiri-button--secondary ocr-result__reselect" : "kiri-primary-button"} onClick={onReselect}><KiriIcon name="crop" size={14} />{t("Select Another Region")}</button>
      {hasText && <button type="button" className="kiri-primary-button" disabled={copyState === "copying"} onClick={() => void copy()}><KiriIcon name="doc.on.doc" size={14} />{t("Copy Text")}</button>}
    </footer>
  </section>;
}
