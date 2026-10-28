// EditorWindow — annotation editor for saved captures
// Screenshot tools share one document; viewing zoom never changes saved pixels.

import { OcrDialog } from "../ocr/TextHistory";
import { QrOverlay } from "../qr/QrOverlay";
import type { AssetDto, QrScanDto } from "../lib/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isEditorRevisionMismatch, onEditorRecognizeQr } from "../lib/ipc";
import { t } from "../i18n";
import { isTextComposition } from "../annotation/text-composition.js";
import type { Rect } from "../annotation/geom";
import {
  type AnnotationDocumentV1,
  type AnnotationMark,
  type Tool,
} from "../annotation/model";
import { useAnnotationAppearance } from "../annotation/useAnnotationAppearance";
import {AnnotationStyleControls} from "../annotation/AnnotationStyleControls";
import {nextCalloutNumber} from "../annotation/model";
import AnnotationCanvas, { type AnnotationCanvasHandle } from "../annotation/AnnotationCanvas";
import { CropOverlay } from "../annotation/CropOverlay";
import {
  fullCropRect,
  isFullCrop,
} from "../annotation/crop.js";
import { resolveInitialEditorDocument } from "../annotation/editor-document.js";
import { AnnotationInteractionLock } from "../annotation/interaction-lock.js";
import { parseAnnotationDocument } from "../annotation/project.js";
import { KiriIcon } from "../components/KiriIcons";
import { AnnotationToolbarButton } from "../components/AnnotationToolbarButton";
import {annotationToolGroups, annotationHistoryButtons, IMAGE_ANNOTATION_TOOLS} from "../components/AnnotationTools";
import { kiriResourceUrl } from "../lib/kiri-resource-url.js";
import { hasPendingImageTextChange, hasUnsavedImageChanges, type ImageEditSnapshot, type ImageTextDraft } from "../annotation/image-edit-state.js";
import { ImageCloseGuard, type ImageCloseGuardHandle } from "./ImageCloseGuard";
import { useImageViewport } from "./useImageViewport";
import { Minus, Plus, CircleHelp } from "lucide-react";
import "./editor-view.css";

type EditorTool = Tool | "crop";

export function EditorWindow(props: { id: string }) {
  const [readOnly, setReadOnly] = useState(() => new URLSearchParams(window.location.search).get("readonly") === "1");
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const [document, setDocument] = useState<AnnotationDocumentV1 | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [tool, setTool] = useState<EditorTool>("select");
  const [selectedMark, setSelectedMark] = useState<AnnotationMark | null>(null);
  const [calloutNumber, setCalloutNumber] = useState(1);
  const onAnnotationSelection = useCallback((mark: AnnotationMark | null) => setSelectedMark(mark), []);
  const [cropSelection, setCropSelection] = useState<Rect | null>(null);
  const [cropUndo, setCropUndo] = useState<Rect[]>([]);
  const [cropRedo, setCropRedo] = useState<Rect[]>([]);
  const [appearance, setAppearance] = useAnnotationAppearance();
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [hasMarks, setHasMarks] = useState(false);
  const [ocrAsset, setOcrAsset] = useState<AssetDto | null>(null);
  const [qrActive, setQrActive] = useState(false);
  const [qrScan, setQrScan] = useState<QrScanDto | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [currentMarks, setCurrentMarks] = useState<AnnotationMark[]>([]);
  useEffect(() => setCalloutNumber(nextCalloutNumber(currentMarks)), [currentMarks]);
  const [textDraft, setTextDraft] = useState<ImageTextDraft | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ImageEditSnapshot>({ marks: [], crop: null });
  const closeGuardRef = useRef<ImageCloseGuardHandle>(null);
  const canvasRef = useRef<AnnotationCanvasHandle>(null);

  const revisionRef = useRef<string | null>(null);
  const qrRequestRef = useRef<string | null>(null);
  const requestedQrRef = useRef(new URLSearchParams(window.location.search).get("qr") === "1");
  const completionLock = useMemo(() => new AnnotationInteractionLock(), []);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const canvasLock = useMemo(() => ({
    get locked() { return readOnlyRef.current || completionLock.locked || qrRequestRef.current !== null; },
  }), [completionLock]);
  const closeQr = useCallback(() => {
    const requestId = qrRequestRef.current;
    qrRequestRef.current = null;
    setQrActive(false);
    setQrScan(null);
    setQrError(null);
    if (requestId) void api.cancelQr(requestId).catch(() => {});
  }, []);
  const runQr = useCallback(() => {
    const revision = revisionRef.current;
    if (!imageSize || !revision || ocrAsset || completionLock.locked || qrRequestRef.current) return;
    const requestId = crypto.randomUUID();
    qrRequestRef.current = requestId;
    setActionError(null);
    setQrActive(true);
    setQrScan(null);
    setQrError(null);
    void api.scanQr(requestId, null, props.id, revision).then(scan => {
      if (qrRequestRef.current !== requestId) return;
      // The arrows describe this displayed source, never a changed asset or
      // annotation document's logical coordinates (which can differ at 2x).
      if (scan.width !== imageSize.w || scan.height !== imageSize.h) {
        setQrError("The screenshot changed. Close and reopen the editor.");
        void api.cancelQr(requestId).catch(() => {});
        return;
      }
      setQrScan(scan);
    }).catch(error => {
      if (qrRequestRef.current !== requestId) return;
      setQrError(isEditorRevisionMismatch(error)
        ? "The screenshot changed. Close and reopen the editor."
        : "QR recognition failed.");
    });
  }, [completionLock, imageSize, ocrAsset, props.id]);
  const runQrRef = useRef(runQr);
  runQrRef.current = runQr;
  const onTextDraftChange = useCallback((mark: AnnotationMark | null, previousId: number | null, editing: boolean) => {
    setTextDraft({ mark, previousId, editing });
  }, []);
  const effectiveCrop = document && cropSelection && !isFullCrop(document, cropSelection) ? cropSelection : null;
  // Typing and selection updates do not change the committed document. Avoid
  // serializing every saved brush point again for each inline text keystroke.
  const documentDirty = useMemo(
    () => hasUnsavedImageChanges(savedSnapshot, currentMarks, effectiveCrop, null),
    [savedSnapshot, currentMarks, effectiveCrop],
  );
  const dirty = documentDirty || hasPendingImageTextChange(currentMarks, textDraft);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const consumePending = async () => {
      if (disposed) return;
      try {
        const requested = await api.takeEditorQrRequest();
        if (disposed || !requested) return;
        requestedQrRef.current = true;
        runQrRef.current();
        if (qrRequestRef.current) requestedQrRef.current = false;
      } catch { /* The toolbar remains available if a window event fails. */ }
    };
    void onEditorRecognizeQr(() => { void consumePending(); }).then(stop => {
      if (disposed) stop();
      else {
        unlisten = stop;
        // The backend queues an existing editor's request until this listener
        // is ready, including a request emitted while the WebView was loading.
        void consumePending();
      }
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
      // StrictMode replays this cleanup before the first image finishes loading.
      // Preserve an unconsumed query/event intent for the next setup.
      closeQr();
    };
  }, [closeQr, props.id]);

  useEffect(() => {
    if (!imageSize || !requestedQrRef.current) return;
    runQr();
    if (qrRequestRef.current) requestedQrRef.current = false;
  }, [completing, imageSize, runQr]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let objectUrl: string | null = null;
    let pendingImage: HTMLImageElement | null = null;

    setImage(null);
    setImageSize(null);
    setDocument(null);
    setHasMarks(false);
    setCurrentMarks([]);
    setTextDraft(null);
    setSavedSnapshot({ marks: [], crop: null });
    setCropSelection(null);
    setCropUndo([]);
    setCropRedo([]);
    revisionRef.current = null;
    setActionError(null);

    async function loadImage(url: string): Promise<HTMLImageElement> {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("asset unavailable");
      const blob = await response.blob();
      if (disposed) throw new Error("editor disposed");
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      pendingImage = img;
      img.src = objectUrl;
      await img.decode();
      return img;
    }

    void (async () => {
      let initialDocument: AnnotationDocumentV1 | null = null;
      let revisionSha256: string;
      try {
        const snapshot = await api.getAssetAnnotationProject(props.id);
        if (!disposed) setReadOnly(snapshot.readOnly === true);
        revisionSha256 = snapshot.revisionSha256;
        if (snapshot.state === "valid") {
          if (!snapshot.documentJson) throw new Error("valid project has no document");
          initialDocument = parseAnnotationDocument(JSON.parse(snapshot.documentJson));
        } else if (snapshot.state === "invalid" && !disposed) {
          setActionError("Editable data couldn't be loaded. The current image is still available.");
        }
        if (disposed) return;
      } catch {
        if (!disposed) setActionError("The screenshot changed. Close and reopen the editor.");
        return;
      }

      let img: HTMLImageElement;
      try {
        img = await loadImage(
          kiriResourceUrl("annotation-source", [props.id], {
            revision: revisionSha256,
          }),
        );
        if (
          initialDocument &&
          (img.naturalWidth !== initialDocument.sourcePixels.width ||
            img.naturalHeight !== initialDocument.sourcePixels.height)
        ) {
          throw new Error("annotation source dimensions changed");
        }
      } catch {
        if (!disposed) setActionError("The screenshot changed. Close and reopen the editor.");
        return;
      }
      if (disposed) return;
      const nextDocument = resolveInitialEditorDocument(initialDocument, {
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
      setImage(img);
      setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
      setDocument(nextDocument);
      setCurrentMarks(nextDocument.marks);
      setSavedSnapshot({ marks: nextDocument.marks, crop: null });
      setHasMarks(nextDocument.marks.length > 0);
      revisionRef.current = revisionSha256;
    })();

    return () => {
      disposed = true;
      controller.abort();
      if (pendingImage) pendingImage.onload = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.id]);

  const viewport = useImageViewport(imageSize, props.id, completing || !!ocrAsset);
  const {containerRef, viewSize, size: containerSize} = viewport;
  const hasToolOptions = !readOnly && tool !== "crop" && (tool !== "select" || selectedMark !== null);
  useEffect(() => { setOptionsOpen(true); }, [tool, selectedMark?.id]);

  const documentRegion = useMemo<Rect>(() => {
    const canvas = document?.canvas ?? { width: 1, height: 1 };
    return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  }, [document]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (isTextComposition(e)) return;
      if (e.target instanceof Element && e.target.closest("input,textarea,select,[contenteditable]")) return;
      if (qrRequestRef.current) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeQr();
        }
        // QR controls and selected text retain their normal keyboard behavior.
        // Editor save, undo, crop and annotation shortcuts stay paused.
        return;
      }
      if (completionLock.locked) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (readOnlyRef.current) {
        if (e.key === "Escape") void closeWindow();
        return;
      }
      if (e.key === "Escape") {
        if (tool === "crop") {
          cancelCrop();
          return;
        }
        void closeWindow();
        return;
      }
      if (e.key === "Enter" && !e.isComposing) {
        // Focused controls own Enter (notably export and crop cancellation).
        // Saving here before their native click could persist unintended edits.
        if (e.target instanceof Element && e.target.closest("button,input,select,textarea,[contenteditable]")) return;
        void complete("save");
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (tool === "crop") {
          if (e.shiftKey) redoCrop();
          else undoCrop();
        } else if (e.shiftKey) canvasRef.current?.redo();
        else canvasRef.current?.undo();
        return;
      }
      if (!mod && !e.altKey && (e.key === "Delete" || e.key === "Backspace")) {
        if (tool !== "crop") {
          e.preventDefault();
          canvasRef.current?.deleteSelection();
        }
        return;
      }
      if (!mod && !e.altKey) {
        const keyMap: Record<string, EditorTool> = {
          v: "select",
          c: "crop",
          p: "pen",
          r: "rectangle",
          l: "line",
          a: "arrow",
          t: "text",
          b: "label",
          n: "callout",
          m: "mosaic",
          w: "watermark",
        };
        const next = keyMap[e.key.toLowerCase()];
        if (next) selectTool(next);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeQr, completionLock, cropRedo, cropSelection, cropUndo, document, tool]);

  function selectTool(next: EditorTool) {
    setOptionsOpen(true);
    if (readOnlyRef.current || qrRequestRef.current) return;
    canvasRef.current?.finishAppearanceAdjustment();
    if (next === "watermark") {
      setTool(next);
      canvasRef.current?.editWatermark();
      return;
    }
    canvasRef.current?.commitTextEditing();
    if (next !== "select") canvasRef.current?.clearSelection();
    setTool(next);
    if (next === "crop" && document) {
      setCropSelection((current) => current ?? fullCropRect(document));
    }
  }

  function cancelCrop() {
    setCropSelection(null);
    setCropUndo([]);
    setCropRedo([]);
    if (tool === "crop") setTool("select");
  }

  function commitCrop(previous: Rect, next: Rect) {
    if (sameRect(previous, next)) return;
    setCropUndo((history) => [...history.slice(-99), previous]);
    setCropRedo([]);
  }

  function undoCrop() {
    if (!cropSelection || cropUndo.length === 0) return;
    const previous = cropUndo[cropUndo.length - 1];
    setCropUndo(cropUndo.slice(0, -1));
    setCropRedo([...cropRedo.slice(-99), cropSelection]);
    setCropSelection(previous);
  }

  function redoCrop() {
    if (!cropSelection || cropRedo.length === 0) return;
    const next = cropRedo[cropRedo.length - 1];
    setCropRedo(cropRedo.slice(0, -1));
    setCropUndo([...cropUndo.slice(-99), cropSelection]);
    setCropSelection(next);
  }

  async function closeWindow() {
    if (qrRequestRef.current) { closeQr(); return; }
    await closeGuardRef.current?.requestClose();
  }

  async function complete(action: "save" | "saveAs") {
    if (readOnlyRef.current || qrRequestRef.current) return;
    if (!completionLock.acquire()) return;
    setCompleting(true);
    const failureMessage = "Couldn't save the edited image. Try again.";
    try {
      setActionError(null);
      const revisionSha256 = revisionRef.current;
      if (!revisionSha256) {
        setActionError("The screenshot changed. Close and reopen the editor.");
        return;
      }
      const result = await canvasRef.current?.exportResult(cropSelection ?? undefined);
      if (!result) {
        setActionError(failureMessage);
        return;
      }
      const saveToken = action === "saveAs"
        ? await api.saveFileDialog(`kiri-${props.id}.png`)
        : null;
      // Cancelling Save As must be a true no-op: do not replace the library
      // asset when the system file picker returns no one-time authorization.
      if (action === "saveAs" && saveToken === null) return;
      const update = await api.updateAsset(props.id, result.png, result.document, {
        action,
        cropPixels: result.cropPixels,
        saveToken,
        revisionSha256,
      });
      revisionRef.current = update.revisionSha256;
      if (!update.actionSucceeded) {
        setActionError(failureMessage);
        return;
      }
      // Save As exports a copy without updating the editable library asset.
      // Only Save advances the library baseline; exported edits remain dirty.
      if (action === "save") {
        setSavedSnapshot({ marks: result.document.marks, crop: effectiveCrop });
        await closeGuardRef.current?.closeSaved();
      }
    } catch (error) {
      if (isEditorRevisionMismatch(error)) {
        revisionRef.current = null;
        setActionError("The screenshot changed. Close and reopen the editor.");
      } else {
        setActionError(failureMessage);
      }
    } finally {
      completionLock.release();
      setCompleting(false);
    }
  }

  return (
    <div
      className="kiri-dark"
      aria-busy={completing}
      data-interaction-disabled={completing || undefined}
      inert={completing}
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#080808", position: "relative" }}
    >
      <div className="kiri-image-editor-toolbar" style={{opacity: completing ? 0.62 : 1}}>
        {!readOnly && <div className="kiri-image-editor-tools" inert={qrActive}>
          {annotationToolGroups({tools: IMAGE_ANNOTATION_TOOLS, selected: tool, onChange: selectTool})}
          {annotationHistoryButtons({canUndo: tool === "crop" ? cropUndo.length > 0 : canUndo,
            canRedo: tool === "crop" ? cropRedo.length > 0 : canRedo,
            onUndo: () => tool === "crop" ? undoCrop() : canvasRef.current?.undo(),
            onRedo: () => tool === "crop" ? redoCrop() : canvasRef.current?.redo(),
            hasMarks: tool !== "crop" && hasMarks, onClear: () => canvasRef.current?.clearAnnotations()})}
        </div>}
        <div className="kiri-image-editor-actions">
          {!readOnly && cropSelection && <button type="button" className="kiri-image-editor-view-button" disabled={qrActive || completing}
            onKeyDown={event => {if (event.key === "Enter" || event.key === " ") event.stopPropagation();}}
            onClick={cancelCrop}>{t("Cancel crop")}</button>}
          {!readOnly && <EditorToolButton icon="slider.horizontal.3" title={t("Tool options")} expanded={optionsOpen}
            active={hasToolOptions && optionsOpen} disabled={!hasToolOptions || qrActive} onClick={() => setOptionsOpen(open => !open)}/>}

          <EditorToolButton icon="qrcode" title={t("Recognize QR Codes")} active={qrActive} disabled={!image || completing || !!ocrAsset}
            onClick={() => qrRequestRef.current ? closeQr() : runQr()}/>
          {!readOnly && <EditorToolButton icon="text.viewfinder" title={t("Recognize Saved Image Locally")} disabled={!image || completing || qrActive}
            onClick={() => { void api.getAsset(props.id).then(setOcrAsset).catch(() => setActionError(t("Can't read this file."))); }}/>}
          {!readOnly && <EditorToolButton icon="doc.on.doc" title={t("Save As…")} disabled={qrActive} onClick={() => void complete("saveAs")}/>}
          <EditorToolButton icon="xmark" title={t(readOnly ? "Close" : "Cancel (Esc)")} shortcut="Escape" onClick={() => qrRequestRef.current ? closeQr() : closeWindow()}/>
          {!readOnly && <EditorToolButton icon="checkmark" title={t("Save")} shortcut="Enter" primary disabled={qrActive}
            onClick={() => void complete("save")}/>}
        </div>
      </div>


      {ocrAsset && <OcrDialog asset={ocrAsset} onClose={() => setOcrAsset(null)} />}

      {actionError && (
        <div
          role="alert"
          style={{
            position: "absolute",
            top: 66,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            maxWidth: "min(420px, calc(100% - 24px))",
            minHeight: 30,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 7px 5px 11px",
            boxSizing: "border-box",
            border: "1px solid var(--kiri-surface-border)",
            borderRadius: 10,
            background: "var(--kiri-elevated)",
            color: "var(--kiri-coral)",
            font: "500 11.5px/16px var(--kiri-font-ui)",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t(actionError)}
          </span>
          <button
            type="button"
            className="kiri-icon-button kiri-inline-dismiss"
            aria-label={t("Close")}
            title={t("Close")}
            onClick={() => setActionError(null)}
            style={{
              width: 20,
              height: 20,
              flexBasis: 20,
            }}
          >
            <KiriIcon name="xmark" size={9} />
          </button>
        </div>
      )}

      <div className="kiri-image-editor-stage">
        <div ref={containerRef} className="kiri-image-editor-viewport" aria-label={t("Image")}
          data-pan-ready={viewport.space || undefined} data-panning={viewport.panning || undefined} {...viewport.handlers}>
        <div className="kiri-image-editor-surface" style={{width: viewport.layout.surfaceWidth, height: viewport.layout.surfaceHeight}}>
        {imageSize && document && (
          <div className="kiri-image-editor-picture" style={{left: viewport.layout.x, top: viewport.layout.y, width: viewSize.width, height: viewSize.height,
            backgroundImage: qrActive && image ? `url("${image.src}")` : undefined}}>
            {/* Keep the canvas and native text editor mounted: QR reads the
                same clean source, then restores all unsaved edits on exit. */}
            <div style={{ visibility: qrActive ? "hidden" : undefined }}>
            <AnnotationCanvas
              ref={canvasRef}
              image={image}
              region={documentRegion}
              viewSize={viewSize}
              visibleViewport={viewport.visibleViewport}
              initialDocument={document}
              interactionDisabled={readOnly || completing || tool === "crop" || qrActive}
              interactionLock={canvasLock}
              tool={tool === "crop" ? "select" : tool}
              appearance={appearance}
              mosaicShape={appearance.mosaicShape}
              onError={setActionError}
              calloutNumber={calloutNumber}
              onSelectionInfo={onAnnotationSelection}
              onHistoryChange={(u, r, populated) => {
                setCanUndo(u);
                setCanRedo(r);
                setHasMarks(populated);
              }}
              onCancel={closeWindow}
              onDocumentChange={setCurrentMarks}
              onTextDraftChange={onTextDraftChange}
            />
            {cropSelection && (
              <CropOverlay
                document={document}
                viewSize={viewSize}
                selection={cropSelection}
                active={tool === "crop" && !completing && !qrActive}
                onChange={setCropSelection}
                onCommit={commitCrop}
              />
            )}
            </div>
          </div>
        )}
        </div>
        </div>
      {hasToolOptions && optionsOpen && !qrActive && <div className="kiri-image-editor-properties" inert={qrActive}>
        <AnnotationStyleControls tool={tool} selected={selectedMark} appearance={appearance} disabled={qrActive}
            panelChrome={<button type="button" className="kiri-capture-options-hide" aria-label={t("Hide tool options")}
              title={t("Hide tool options")} onKeyDown={event => event.stopPropagation()} onClick={() => setOptionsOpen(false)}><KiriIcon name="xmark" size={12}/></button>}
            nextNumber={calloutNumber} onNextNumber={setCalloutNumber}
            onCalloutEdit={(patch, transient) => canvasRef.current?.updateSelectedCallout(patch, transient)}
            onChange={(patch, transient) => {setActionError(null); setAppearance({...appearance, ...patch}); canvasRef.current?.updateSelectionAppearance(patch, transient);}}
            onFinish={() => canvasRef.current?.finishAppearanceAdjustment()}
            onDelete={() => canvasRef.current?.deleteSelection()}
            onEditText={() => canvasRef.current?.editSelectedText()} onEditWatermark={() => canvasRef.current?.editWatermark()}/>
      </div>}
        {qrActive && <QrOverlay scan={qrScan} failed={!!qrError} error={qrError}
          sourceRect={{ x: viewport.layout.x - viewport.scroll.x,
            y: viewport.layout.y - viewport.scroll.y, ...viewSize }}
          selection={documentRegion} bounds={{ x: 0, y: 0, ...containerSize }} scale={1}
          onRetry={() => { closeQr(); runQr(); }} onClose={closeQr} onOpened={closeQr} />}
      </div>
      <div className="kiri-image-editor-viewbar" role="group" aria-label={t("Zoom")}>
        <button type="button" className="kiri-image-editor-view-button" aria-label={t("Zoom out")} title={t("Zoom out")} disabled={!image} onClick={() => viewport.zoomBy(0.8)}><Minus size={14}/></button>
        <span className="kiri-image-editor-zoom-value" aria-live="off">{Math.round(viewport.layout.zoom * 1000) / 10}%</span>
        <button type="button" className="kiri-image-editor-view-button" aria-label={t("Zoom in")} title={t("Zoom in")} disabled={!image} onClick={() => viewport.zoomBy(1.25)}><Plus size={14}/></button>
        <span className="kiri-image-editor-view-divider"/>
        <button type="button" className="kiri-image-editor-view-button" aria-pressed={viewport.mode === "width"} disabled={!image} onClick={() => viewport.changeView("width")}>{t("Fit width")}</button>
        <button type="button" className="kiri-image-editor-view-button" aria-pressed={viewport.mode === "fit"} disabled={!image} onClick={() => viewport.changeView("fit")}>{t("Fit image")}</button>
        <button type="button" className="kiri-image-editor-view-button" aria-pressed={Math.abs(viewport.layout.zoom - 1) < 0.001} disabled={!image} onClick={() => viewport.changeView("manual", 1)}>{t("Actual size")}</button>
        <button type="button" className="kiri-image-editor-view-button" aria-label={t("Scroll to view. Pinch or hold Ctrl/Command and scroll to zoom. Hold Space and drag to pan.")}
          title={t("Scroll to view. Pinch or hold Ctrl/Command and scroll to zoom. Hold Space and drag to pan.")}><CircleHelp size={14}/></button>
      </div>
      <ImageCloseGuard ref={closeGuardRef} dirty={!readOnly && dirty} busy={completing} lock={completionLock}
        error={actionError} onSave={() => { closeQr(); return complete("save"); }} />
    </div>
  );
}

function sameRect(left: Rect, right: Rect): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

const EditorToolButton = AnnotationToolbarButton;
