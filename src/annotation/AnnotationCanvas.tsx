// AnnotationCanvas — interactive canvas port of AnnotationCanvasView.swift.
// The parent owns tool/appearance; this component owns history, selection,
// drafts, inline text editing, and export.

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Point, Rect } from "./geom";
import { handleTextEditorKey, setTextComposition } from "./text-composition.js";
import type { ColorPreset } from "./model";
import { clampPoint, hitTestHandle } from "./geom";
import {
  AnnotationHistory,
  COLOR_HEX,
  applyAnnotationAppearance,
  annotationTextForCommit,
  changeMosaicShape,
  calloutHandleAt,
  dragAnnotationHandle,
  markIndexAt,
  selectionBounds,
  labelGeometry,
  translateMark,
  type AnnotationMark,
  type CalloutMark,
  type AnnotationDocumentV1,
  type AppearanceSettings,
  type TextBackgroundStyle,
  type LabelDirection,
  type Tool,
  type MosaicShape,
} from "./model";
import { renderAll, textFont, type RenderContext } from "./render";
import {
  annotationSourceCrop,
  documentUnitsPerViewPixel,
  parseAnnotationDocument,
  viewPointToDocument,
} from "./project.js";
import { fitTextEditorFrame, layoutTextLines, textEditorInsets, TEXT_TAB_SIZE } from "./text-layout.js";
import { cropAnnotationDocument, isFullCrop, type CropPixels } from "./crop.js";
import { t } from "../i18n";

export interface AnnotationCanvasHandle {
  undo(): void;
  redo(): void;
  clearAnnotations(): void;
  deleteSelection(): void;
  commitTextEditing(): void;
  cancelTextEditing(): boolean;
  editSelectedText(): void;
  clearSelection(): void;
  cancelInteraction(): boolean;
  updateSelectionAppearance(patch: Partial<AppearanceSettings>, transient?: boolean): void;
  finishAppearanceAdjustment(): void;
  setMosaicShape(shape: MosaicShape): void;
  updateSelectedCallout(patch: Partial<Omit<CalloutMark, "kind" | "id">>, transient?: boolean): void;
  exportResult(cropSelection?: Rect): Promise<AnnotationExportResult | null>;
  /**
   * Live text font-size adjustment (spec §6.6): begin records the selected
   * text mark, set applies a preview (no history), end commits one history
   * entry. The slider value itself lives in the parent's AppearanceSettings.
   */
  beginTextFontSizeAdjustment(): void;
  setTextFontSizeLive(value: number): void;
  endTextFontSizeAdjustment(): void;
}

export interface AnnotationExportResult {
  png: Uint8Array;
  document: AnnotationDocumentV1;
  cropPixels: CropPixels | null;
}

interface Props {
  /** Full-resolution source image element. */
  image: HTMLImageElement | null;
  /** Region of the source in display-local points (top-left). */
  region: Rect;
  /**
   * Size of the coordinate space `region` lives in (the display in points).
   * Required when `region` is a sub-rect of the image (capture overlay);
   * omitted for the editor where region covers the whole image.
   */
  displaySize?: { width: number; height: number };
  /** Persisted baseline. It is loaded once, without creating undo history. */
  initialDocument?: AnnotationDocumentV1;
  /** Video editors can reload an externally owned history without remounting. */
  documentRevision?: number;
  selectedMarkId?: number | null;
  onSelectionChange?(markId: number | null): void;
  onSelectionInfo?(mark: AnnotationMark | null, editing: boolean): void;
  /** A recoverable text snapshot without committing history or interrupting IME. */
  onTextDraftChange?(mark: AnnotationMark | null, previousId: number | null, editing: boolean): void;
  onMarkCreated?(): void;
  mosaicShape?: MosaicShape;
  textEscapeCancelsEdit?: boolean;
  /** Video's toolbar commits explicitly; selecting a text track must not close its editor. */
  commitTextOnToolChange?: boolean;
  onDocumentChange?(marks: AnnotationMark[]): void;
  /** Let a video compositor present live drafts through the same effects as export. */
  onFrame?(canvas: HTMLCanvasElement): void;
  /** Video draws marks in its own layer stack; this canvas keeps hit targets and handles. */
  onLiveMarks?(marks: AnnotationMark[], draft: AnnotationMark | null, editingId: number | null): void;
  onUndo?(): void;
  onRedo?(): void;
  /** CSS viewport size; document coordinates remain fixed to canvas/region. */
  viewSize?: { width: number; height: number };
  /** Prevents edits while an immutable export snapshot is being committed. */
  interactionDisabled?: boolean;
  /** Synchronous companion to interactionDisabled for the pre-render event gap. */
  interactionLock?: { readonly locked: boolean };
  tool: Tool;
  appearance: AppearanceSettings;
  calloutNumber?: number;
  onHistoryChange(canUndo: boolean, canRedo: boolean, hasMarks: boolean): void;
  onCancel(): void;
  /**
   * Called after a text annotation is committed via Return (spec §6.6:
   * "Return commits the text and completes the capture"). The parent
   * overlay finishes the screenshot; the editor leaves this unset.
   */
  onFinishAfterTextCommit?(): void;
  /** Capture-only: Select tool double-clicks on unmarked canvas confirm the image. */
  onFinishOnBlankDoubleClick?(): void;
}

interface EditingState {
  id: number;
  index: number | null;
  text: string;
  rect: Rect;
  maxWidth: number;
  uiScale: number;
  color: ColorPreset;
  background: TextBackgroundStyle;
  fontSize: number;
  labelDirection?: LabelDirection;
}

type Interaction =
  | { kind: "none" }
  | { kind: "draw"; tool: Tool; start: Point; points: Point[] }
  | { kind: "move"; index: number; original: AnnotationMark; start: Point }
  | { kind: "resize"; index: number; original: AnnotationMark; handle: string; start: Point }
  | { kind: "endpoint"; index: number; original: AnnotationMark; isStart: boolean; start: Point };

const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, Props>(
  function AnnotationCanvas(
    {
      image,
      region,
      displaySize,
      initialDocument,
      documentRevision,
      selectedMarkId,
      onSelectionChange,
      onSelectionInfo,
      onTextDraftChange,
      onMarkCreated,
      mosaicShape = "brush",
      textEscapeCancelsEdit = true,
      commitTextOnToolChange = true,
      onDocumentChange,
      onFrame,
      onLiveMarks,
      onUndo,
      onRedo,
      viewSize,
      interactionDisabled = false,
      interactionLock,
      tool,
      appearance,
      calloutNumber = 1,
      onHistoryChange,
      onCancel,
      onFinishAfterTextCommit,
      onFinishOnBlankDoubleClick,
    },
    ref,
  ) {
    const initialProjectRef = useRef<AnnotationDocumentV1 | null | undefined>(undefined);
    if (initialProjectRef.current === undefined) {
      initialProjectRef.current = initialDocument
        ? parseAnnotationDocument(initialDocument)
        : null;
    }
    const initialProject = initialProjectRef.current;
    const historyRef = useRef<AnnotationHistory | null>(null);
    if (historyRef.current === null) {
      historyRef.current = new AnnotationHistory(initialProject?.marks ?? []);
    }
    const history = historyRef.current;
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [marks, setMarks] = useState<AnnotationMark[]>(() =>
      history.elements.slice(),
    );
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
    const selectionChangeRef = useRef(onSelectionChange);
    selectionChangeRef.current = onSelectionChange;
    // Publish only user selection changes. External revision reloads use the
    // raw state setter, so their temporary reset cannot clear the parent track.
    const selectMark = useCallback((index: number | null) => {
      selectedIndexRef.current = index;
      setSelectedIndex(index);
      selectionChangeRef.current?.(index === null ? null : history.elements[index]?.id ?? null);
    }, [history]);
    const [draft, setDraft] = useState<AnnotationMark | null>(null);
    const [brushCursor, setBrushCursor] = useState<Point | null>(null);
    const [selectCursor, setSelectCursor] = useState<string>("default");
    const [editing, setEditing] = useState<EditingState | null>(null);
    const interactionRef = useRef<Interaction>({ kind: "none" });
    const gestureRectRef = useRef<{left: number; top: number; width: number; height: number} | null>(null);
    const canvasClickRef = useRef({ start: { x: 0, y: 0 }, moved: false, wasEditing: false });
    const blankDoubleClickRef = useRef(false);
    const appearanceRef = useRef(appearance);
    appearanceRef.current = appearance;
    const toolRef = useRef(tool);
    toolRef.current = tool;
    const calloutNumberRef = useRef(calloutNumber);
    calloutNumberRef.current = calloutNumber;
    const mosaicShapeRef=useRef(mosaicShape);mosaicShapeRef.current=mosaicShape;
    const markCreatedRef=useRef(onMarkCreated);markCreatedRef.current=onMarkCreated;
    const interactionDisabledRef = useRef(interactionDisabled);
    interactionDisabledRef.current = interactionDisabled;
    const interactionLockRef = useRef(interactionLock);
    interactionLockRef.current = interactionLock;
    const interactionsDisabled = useCallback(
      () => interactionDisabledRef.current || interactionLockRef.current?.locked === true,
      [],
    );
    const imageRef = useRef<HTMLImageElement | null>(null);
    imageRef.current = image;
    const editingRef = useRef<EditingState | null>(null);
    const brushCursorRef = useRef<Point | null>(null);
    useEffect(() => {
      brushCursorRef.current = brushCursor;
    }, [brushCursor]);

    useEffect(() => {
      if (!interactionDisabled) return;
      interactionRef.current = { kind: "none" };
      setDraft(null);
      setBrushCursor(null);
      setSelectCursor("default");
    }, [interactionDisabled]);

    // Canvas drawImage can crop directly from the decoded HTMLImageElement.
    // Keeping a second full-resolution source canvas would duplicate the
    // image's RGBA surface for the whole annotation session.
    const getSourceImage = useCallback((): HTMLImageElement | null => {
      const img = imageRef.current;
      if (!img || !img.complete || img.naturalWidth === 0) return null;
      return img;
    }, []);

    const documentSize = initialProject?.canvas ?? {
      width: region.width,
      height: region.height,
    };
    const view = useMemo(
      () => viewSize ?? { width: region.width, height: region.height },
      [region.height, region.width, viewSize],
    );
    const hitTestScale = useMemo(
      () => documentUnitsPerViewPixel(view, documentSize),
      [documentSize.height, documentSize.width, view.height, view.width],
    );
    const viewScaleX = 1 / hitTestScale.x;
    const viewScaleY = 1 / hitTestScale.y;

    const publishHistory = useCallback(() => {
      onHistoryChange(
        history.canUndo,
        history.canRedo,
        history.elements.length > 0 || editingRef.current !== null,
      );
    }, [history, onHistoryChange]);

    const documentChangeRef = useRef(onDocumentChange);
    documentChangeRef.current = onDocumentChange;
    const loadedRevisionRef = useRef(documentRevision);
    useEffect(() => {
      if (loadedRevisionRef.current === documentRevision) return;
      loadedRevisionRef.current = documentRevision;
      const document = initialDocument ? parseAnnotationDocument(initialDocument) : null;
      history.load(document?.marks ?? []);
      interactionRef.current = {kind: "none"};
      editingRef.current = null;
      setEditing(null); setDraft(null); setSelectedIndex(null);
      setMarks(history.elements.slice());
      publishHistory();
    }, [documentRevision, initialDocument, history, publishHistory]);
    useEffect(() => {
      if (selectedMarkId === undefined) return;
      const index = history.elements.findIndex(mark => mark.id === selectedMarkId);
      setSelectedIndex(index < 0 ? null : index);
    }, [selectedMarkId, documentRevision, history]);

    const syncMarks = useCallback(() => {
      setMarks(history.elements.slice());
      documentChangeRef.current?.(history.elements.slice());
      publishHistory();
    }, [history, publishHistory]);

    useEffect(()=>{
      const selected=selectedIndex===null?null:marks[selectedIndex]??null;
      const mark:AnnotationMark|null=editing?{kind:"text",id:editing.index===null?-1:marks[editing.index]?.id??-1,
        text:editing.text,rect:editing.rect,color:editing.color,background:editing.background,fontSize:editing.fontSize,
        ...(editing.labelDirection?{labelDirection:editing.labelDirection}:{})}:selected;
      onSelectionInfo?.(mark,!!editing);
    },[marks,selectedIndex,editing,onSelectionInfo]);

    useEffect(()=>{
      const text=editing?annotationTextForCommit(editing.text):null;
      const insets=textEditorInsets(editing?.uiScale);
      const mark:AnnotationMark|null=editing&&text!==null?{kind:"text",id:editing.id,text,
        rect:{x:editing.rect.x+insets.x,y:editing.rect.y+insets.y,
          width:Math.max(1,editing.rect.width-2*insets.x),height:Math.max(1,editing.rect.height-2*insets.y)},
        color:editing.color,background:editing.background,fontSize:editing.fontSize,
        ...(editing.labelDirection?{labelDirection:editing.labelDirection}:{})}:null;
      onTextDraftChange?.(mark,editing?.index!=null?marks[editing.index]?.id??null:null,!!editing);
    },[editing,marks,onTextDraftChange]);

    const appendMark=useCallback((mark:AnnotationMark)=>{
      history.append(mark);syncMarks();selectMark(history.elements.length-1);markCreatedRef.current?.();
    },[history,syncMarks,selectMark]);

    useEffect(() => {
      publishHistory();
    }, [publishHistory]);

    const updateEditingText = useCallback((text: string) => {
      const current = editingRef.current;
      if (!current) return;
      const next = { ...current, text };
      editingRef.current = next;
      setEditing(next);
    }, []);

    const updateEditingRect = useCallback((rect: Rect) => {
      const current = editingRef.current;
      if (
        !current ||
        (current.rect.x === rect.x &&
          current.rect.y === rect.y &&
          current.rect.width === rect.width &&
          current.rect.height === rect.height)
      ) {
        return;
      }
      const next = { ...current, rect };
      editingRef.current = next;
      setEditing(next);
    }, []);

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const sourceImage = getSourceImage();
      if (!sourceImage) return;
      ctx.setTransform(
        devicePixelRatio * viewScaleX,
        0,
        0,
        devicePixelRatio * viewScaleY,
        0,
        0,
      );
      const context: RenderContext = {
        ctx,
        sourceImage,
        sourceWidth: sourceImage.naturalWidth,
        sourceHeight: sourceImage.naturalHeight,
        sourceOffset: { x: region.x, y: region.y },
        regionSize: { x: 0, y: 0, width: documentSize.width, height: documentSize.height },
        scaleX: sourceImage.naturalWidth / (displaySize?.width ?? documentSize.width),
        scaleY: sourceImage.naturalHeight / (displaySize?.height ?? documentSize.height),
        viewScaleX,
        viewScaleY,
        exporting: false,
      };
      // Moving/resizing an existing mark replaces it in place for this frame.
      // Preserve stacking and move the handles too, without touching history.
      const replacementIndex = draft ? marks.findIndex(mark => mark.id === draft.id) : -1;
      const previewMarks = replacementIndex < 0 ? marks : marks.map((mark, index) =>
        index === replacementIndex ? draft! : mark);
      const drawingDraft = replacementIndex < 0 ? draft : null;
      renderAll(context, previewMarks, {
        draft: drawingDraft,
        brushCursor,
        brushDiameter: appearanceRef.current.mosaicBrushDiameter,
        selectedIndex: editing ? null : selectedIndex,
        editingIndex: editing ? editing.index : null,
        chromeOnly: !!onLiveMarks,
      });
      onLiveMarks?.(previewMarks, drawingDraft, editing?.index != null ? marks[editing.index]?.id ?? null : null);
      onFrame?.(canvas);
    }, [
      marks,
      draft,
      brushCursor,
      selectedIndex,
      editing,
      region.x,
      region.y,
      documentSize.width,
      documentSize.height,
      view.width,
      view.height,
      viewScaleX,
      viewScaleY,
      displaySize,
      getSourceImage,
      onFrame,
      onLiveMarks,
    ]);

    useEffect(() => {
      redraw();
    }, [redraw, image]);

    const toPoint = useCallback((e: React.PointerEvent | MouseEvent): Point => {
      const canvas = canvasRef.current!;
      // Selecting a callout can open its inspector and resize the editor stage
      // before pointerup. Keep this gesture in the coordinate space it began in.
      const rect = interactionRef.current.kind !== "none" && gestureRectRef.current
        ? gestureRectRef.current : canvas.getBoundingClientRect();
      return viewPointToDocument(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        { width: rect.width, height: rect.height },
        documentSize,
      );
    }, [documentSize.height, documentSize.width]);

    const commitText = useCallback(() => {
      const current = editingRef.current;
      if (!current) return;
      editingRef.current = null;
      setEditing(null);
      // Keep Clear enabled while an inline edit exists, then publish its
      // removal even when a new empty text box produces no history entry.
      publishHistory();
      const text = annotationTextForCommit(current.text);
      const frame = current.rect;
      const insets = textEditorInsets(current.uiScale);
      const textRect: Rect = {
        x: frame.x + insets.x,
        y: frame.y + insets.y,
        width: Math.max(1, frame.width - 2*insets.x),
        height: Math.max(1, frame.height - 2*insets.y),
      };
      if (text === null) {
        if (current.index !== null) {
          history.remove(current.index);
          selectMark(null);
          syncMarks();
        }
        return;
      }
      const previous =
        current.index !== null ? history.elements[current.index] : null;
      const newMark: AnnotationMark = {
        // Reuse the previous id so an unchanged edit compares equal and
        // does not create a no-op history entry (spec §6.6).
        id: previous && previous.kind === "text" ? previous.id : current.id,
        kind: "text",
        text,
        rect: textRect,
        color: current.color,
        background: current.background,
        fontSize: current.fontSize,
        ...(current.labelDirection?{labelDirection:current.labelDirection}:{}),
      };
      if (current.index !== null) {
        const unchanged =
          previous && previous.kind === "text"
            ? previous.text === newMark.text &&
              previous.rect.x === newMark.rect.x &&
              previous.rect.y === newMark.rect.y &&
              previous.rect.width === newMark.rect.width &&
              previous.rect.height === newMark.rect.height &&
              previous.color === newMark.color &&
              previous.background === newMark.background &&
              previous.fontSize === newMark.fontSize && previous.labelDirection === newMark.labelDirection
            : false;
        if (!unchanged) {
          history.replace(current.index, newMark);
          syncMarks();
        }
        selectMark(current.index);
      } else {
        appendMark(newMark);
      }
      // Spec §6.6: commit (unchanged edits do not write history). The
      // Return key additionally finishes the capture — handled in the
      // TextEditor's Enter branch so other commit triggers (tool switch,
      // undo, export) do not complete the capture.
    }, [history, publishHistory, syncMarks, appendMark, selectMark]);

    const editText=useCallback((index:number)=>{
      const mark=history.elements[index];if(!mark||mark.kind!=="text")return;
      const uiScale=hitTestScale.radial;
      const insets=textEditorInsets(uiScale);
      const width=Math.max(1,Math.min(mark.rect.width+2*insets.x,documentSize.width));
      const height=Math.max(1,Math.min(mark.rect.height+2*insets.y,documentSize.height));
      const next:EditingState={id:mark.id,index,text:mark.text,uiScale,rect:{x:Math.min(Math.max(0,mark.rect.x-insets.x),Math.max(0,documentSize.width-width)),
        y:Math.min(Math.max(0,mark.rect.y-insets.y),Math.max(0,documentSize.height-height)),width,height},
        maxWidth:Math.max(width,documentSize.width-Math.max(0,mark.rect.x-insets.x)),color:mark.color,background:mark.background,fontSize:mark.fontSize,labelDirection:mark.labelDirection};
      editingRef.current=next;setEditing(next);selectMark(index);publishHistory();
    },[history,documentSize.width,documentSize.height,selectMark,publishHistory,hitTestScale.radial]);

    const fitLabelRef = useRef<(mark:AnnotationMark)=>AnnotationMark>(mark=>mark);
    const styleAdjustment=useRef<{index:number;original:AnnotationMark}|null>(null);
    const fitCallout = useCallback((mark: CalloutMark): CalloutMark => {
      const context = canvasRef.current?.getContext("2d");
      const size = Math.min(mark.size, documentSize.width, documentSize.height);
      const center = {x: Math.max(size / 2, Math.min(documentSize.width - size / 2, mark.center.x)),
        y: Math.max(size / 2, Math.min(documentSize.height - size / 2, mark.center.y))};
      if (!mark.text.trim() || !context) return {...mark, size, center};
      let fontSize = mark.fontSize;
      let width = 1, height = 1;
      for (let attempt = 0; attempt < 32; attempt++) {
        context.font = textFont(fontSize);
        const pad = Math.max(4, fontSize * .5);
        const longest = Math.max(...mark.text.split("\n").map(line => context.measureText(line).width));
        width = Math.min(documentSize.width, Math.max(Math.min(72, documentSize.width), Math.min(280, longest + pad * 2)));
        const lines = layoutTextLines(mark.text, Math.max(1, width - pad * 2), value => context.measureText(value).width);
        height = lines.length * fontSize * 1.25 + pad * 2;
        if (height <= documentSize.height || fontSize <= .1) break;
        fontSize *= .8;
      }
      height = Math.min(height, documentSize.height);
      return {...mark, size, center, fontSize, labelRect: {
        x: Math.max(0, Math.min(documentSize.width - width, mark.labelRect.x)),
        y: Math.max(0, Math.min(documentSize.height - height, mark.labelRect.y)), width, height}};
    }, [documentSize.width, documentSize.height]);
    const createCallout = useCallback((start: Point, end: Point, id: number): CalloutMark => {
      const ap = appearanceRef.current;
      const size = Math.min(ap.calloutSize, documentSize.width, documentSize.height);
      const dragged = Math.hypot(end.x - start.x, end.y - start.y) >= 12 * hitTestScale.radial;
      const width = Math.min(160, documentSize.width), height = Math.min(ap.textFontSize * 2.25, documentSize.height);
      const right = dragged ? end.x >= start.x : start.x + size + 24 + width <= documentSize.width;
      const anchor = dragged ? end : {x: start.x + (right ? 1 : -1) * (size / 2 + 24), y: start.y};
      return fitCallout({kind: "callout", id, number: calloutNumberRef.current, text: "", center: start,
        labelRect: {x: Math.max(0, Math.min(documentSize.width - width, right ? anchor.x : anchor.x - width)),
          y: Math.max(0, Math.min(documentSize.height - height, anchor.y - height / 2)), width, height},
        color: ap.colorPreset, size, fontSize: ap.textFontSize, style: ap.calloutStyle});
    }, [documentSize.width, documentSize.height, hitTestScale.radial, fitCallout]);
    const finishAppearanceAdjustment=useCallback(()=>{
      const adjustment=styleAdjustment.current;styleAdjustment.current=null;if(!adjustment)return;
      if(JSON.stringify(history.elements[adjustment.index])!==JSON.stringify(adjustment.original)){
        history.commitOverwrite(adjustment.index,adjustment.original);syncMarks();
      }
    },[history,syncMarks]);
    const updateSelectionAppearance=useCallback((patch:Partial<AppearanceSettings>,transient=false)=>{
      if(interactionsDisabled())return;
      const editing=editingRef.current;
      if(editing){
        const next={...editing,color:patch.colorPreset??editing.color,background:patch.textBackgroundStyle??editing.background,fontSize:patch.textFontSize??editing.fontSize,
          ...(editing.labelDirection?{labelDirection:patch.labelDirection??editing.labelDirection}: {})};
        editingRef.current=next;setEditing(next);return;
      }
      const index=selectedIndexRef.current;if(index===null)return;
      const mark=history.elements[index];if(!mark)return;
      styleAdjustment.current??={index,original:mark};
      const updated=applyAnnotationAppearance(mark,patch);
      const next=updated.kind === "callout" ? fitCallout(updated) : updated.kind === "text" && updated.labelDirection ? fitLabelRef.current(updated) : updated;
      const elements=history.elements.slice();elements[index]=next;history.overwrite(elements);setMarks(elements);
      if(!transient)finishAppearanceAdjustment();
    },[history,interactionsDisabled,finishAppearanceAdjustment,fitCallout]);

    const updateSelectedCallout = useCallback((patch: Partial<Omit<CalloutMark, "kind" | "id">>, transient = false) => {
      if (interactionsDisabled()) return;
      const index = selectedIndexRef.current;
      const mark = index === null ? null : history.elements[index];
      if (index === null || !mark || mark.kind !== "callout") return;
      styleAdjustment.current ??= {index, original: mark};
      const next = fitCallout({...mark, ...patch});
      const elements = history.elements.slice(); elements[index] = next;
      history.overwrite(elements); setMarks(elements);
      documentChangeRef.current?.(elements);
      if (!transient) finishAppearanceAdjustment();
    }, [history, interactionsDisabled, fitCallout, finishAppearanceAdjustment]);

    const toggleLabel = useCallback((id: number) => {
      if (interactionsDisabled() || interactionRef.current.kind !== "none") return;
      blankDoubleClickRef.current = false;
      const current = editingRef.current;
      if (current?.id === id && current.labelDirection) {
        const next: EditingState = {...current, labelDirection:current.labelDirection === "left" ? "right" : "left"};
        editingRef.current = next; setEditing(next); return;
      }
      commitText(); finishAppearanceAdjustment();
      const index = history.elements.findIndex(mark => mark.id === id);
      const mark = history.elements[index];
      if (!mark || mark.kind !== "text" || !mark.labelDirection) return;
      history.replace(index, {...mark, labelDirection:mark.labelDirection === "left" ? "right" : "left"});
      selectMark(index); syncMarks();
    }, [history, interactionsDisabled, commitText, finishAppearanceAdjustment, selectMark, syncMarks]);

    const cancelInteraction=useCallback(()=>{
      if(editingRef.current){editingRef.current=null;setEditing(null);publishHistory();return true;}
      if(interactionRef.current.kind!=="none"){
        interactionRef.current={kind:"none"};setDraft(null);setSelectCursor("default");return true;
      }
      return false;
    },[publishHistory]);

    // Switching tools while a text edit is open should commit it (the text
    // becomes a mark and the editor closes), matching the canvas click
    // behavior. Without this the textarea stays up after choosing another
    // tool.
    const prevTool = useRef(tool);
    useEffect(() => {
      if (commitTextOnToolChange && prevTool.current !== tool && editingRef.current) {
        commitText();
      }
      prevTool.current = tool;
    }, [tool, commitText, commitTextOnToolChange]);

    const onPointerDown = useCallback(
      (e: React.PointerEvent) => {
        if (interactionsDisabled()) return;
        if(e.button!==0)return;
        canvasClickRef.current = {
          start: { x: e.clientX, y: e.clientY }, moved: false, wasEditing: editingRef.current !== null,
        };
        finishAppearanceAdjustment();
        const canvas = canvasRef.current!;
        gestureRectRef.current = canvas.getBoundingClientRect();
        canvas.setPointerCapture(e.pointerId);
        const p = clampPoint(toPoint(e), {
          x: 0,
          y: 0,
          width: documentSize.width,
          height: documentSize.height,
        });
        const t = toolRef.current;
        const ap = appearanceRef.current;

        if (editingRef.current) {
          commitText();
        }

        if (t === "text" || t === "label") {
          const hit=markIndexAt(history.elements,p,hitTestScale);
          if(hit!==null&&history.elements[hit].kind==="text"){editText(hit);return;}
          const width = Math.max(1, Math.min(180*hitTestScale.radial, documentSize.width));
          const height = Math.max(1, Math.min(34*hitTestScale.radial, documentSize.height));
          const frame: Rect = {
            x: Math.min(Math.max(0, p.x), Math.max(0, documentSize.width - width)),
            y: Math.min(Math.max(0, p.y), Math.max(0, documentSize.height - height)),
            width,
            height,
          };
          const nextEditing: EditingState = {
            id: Date.now() + Math.random(),
            // The Text tool always creates a new mark. Existing text is edited
            // only through the Select tool's double-click path below; carrying
            // a stale selection index here would replace the selected mark.
            index: null,
            uiScale:hitTestScale.radial,
            text: "",
            rect: frame,
            maxWidth: Math.max(width,documentSize.width-frame.x),
            color: ap.colorPreset,
            background: ap.textBackgroundStyle,
            fontSize: t === "label" ? Math.min(ap.textFontSize, documentSize.width / 8, documentSize.height / 3) : ap.textFontSize,
            ...(t === "label" ? {labelDirection: ap.labelDirection} : {}),
          };
          editingRef.current = nextEditing;
          setEditing(nextEditing);
          selectMark(null);
          publishHistory();
          return;
        }

        const current = history.elements;
        const selectedLine = selectedIndex === null ? null : current[selectedIndex];
        const editingSelectedLine =
          (t === "line" || t === "arrow") &&
          selectedLine?.kind === t &&
          (Math.hypot(p.x - selectedLine.start.x, p.y - selectedLine.start.y) <= 10 * hitTestScale.radial ||
            Math.hypot(p.x - selectedLine.end.x, p.y - selectedLine.end.y) <= 10 * hitTestScale.radial ||
            markIndexAt(current, p, hitTestScale) === selectedIndex);
        const calloutHit = t === "callout" ? markIndexAt(current, p, hitTestScale) : null;
        const editingCallout = (calloutHit !== null && current[calloutHit].kind === "callout") ||
          (t === "callout" && selectedLine?.kind === "callout" && calloutHandleAt(selectedLine, p, 9 * hitTestScale.radial) !== null);
        if (t === "select" || editingSelectedLine || editingCallout) {
          let handleInteraction: string | null = null;
          const selectedMark = selectedIndex === null ? null : current[selectedIndex];
          if (selectedMark?.kind === "callout") {
            handleInteraction = calloutHandleAt(selectedMark, p, 9 * hitTestScale.radial);
          } else if (selectedIndex !== null && current[selectedIndex] && !["line","arrow"].includes(current[selectedIndex].kind)) {
            handleInteraction = hitTestHandle(
              p,
              selectionBounds(current[selectedIndex]),
              9 * hitTestScale.radial,
            );
          } else if (selectedIndex !== null) {
            const mark = current[selectedIndex];
            if (mark && (mark.kind === "line" || mark.kind === "arrow")) {
              if (
                Math.hypot(p.x - mark.start.x, p.y - mark.start.y) <=
                10 * hitTestScale.radial
              ) {
                handleInteraction = "start";
              } else if (
                Math.hypot(p.x - mark.end.x, p.y - mark.end.y) <=
                10 * hitTestScale.radial
              ) {
                handleInteraction = "end";
              }
            }
          }
          const index = handleInteraction
            ? selectedIndex
            : markIndexAt(current, p, hitTestScale);
          if (index === null || index === undefined) {
            selectMark(null);
            interactionRef.current = { kind: "none" };
            redraw();
            return;
          }
          const mark = current[index];
          if (mark.kind === "text" && e.detail >= 2) {editText(index);return;}
          selectMark(index);
          if (handleInteraction === "start" || handleInteraction === "end") {
            interactionRef.current = {
              kind: "endpoint",
              index,
              original: mark,
              isStart: handleInteraction === "start",
              start: p,
            };
          } else if (handleInteraction) {
            interactionRef.current = { kind: "resize", index, original: mark, handle: handleInteraction, start: p };
          } else {
            interactionRef.current = { kind: "move", index, original: mark, start: p };
            // Spec §6.3: closedHand while dragging.
            setSelectCursor("grabbing");
          }
          redraw();
          return;
        }

        const points = [p];
        interactionRef.current = { kind: "draw", tool: t, start: p, points };
        if (t === "callout") {
          setDraft(createCallout(p, p, -1));
        } else if (t === "pen") {
          setDraft({ kind: "pen", id: -1, points, color: ap.colorPreset, width: ap.penWidth });
        } else if (t === "mosaic") {
          setDraft({
            kind: "mosaic",
            id: -1,
            points:mosaicShapeRef.current==="brush"?points:[p,p],
            shape:mosaicShapeRef.current,
            brushDiameter: ap.mosaicBrushDiameter,
            intensity: ap.mosaicIntensity,
            style: ap.mosaicStyle,
          });
        } else if (t === "rectangle") {
          setDraft({
            kind: "rectangle",
            id: -1,
            rect: { x: p.x, y: p.y, width: 0, height: 0 },
            color: ap.colorPreset,
            width: ap.shapeWidth,
          });
        } else {
          setDraft({ kind: t==="arrow"?"arrow":"line", id: -1, start: p, end: p, color: ap.colorPreset, width: ap.shapeWidth });
        }
      },
      [
        toPoint,
        documentSize.height,
        documentSize.width,
        selectedIndex,
        redraw,
        commitText,
        history,
        hitTestScale,
        publishHistory,editText,finishAppearanceAdjustment,createCallout,
      ],
    );

    // Native font metrics can change wrapping after even a uniform scale.
    // Use the same layout as rendering for preview, hit bounds and persistence.
    const fitTextBounds = useCallback((mark: AnnotationMark, handle?: string,
      original: AnnotationMark = mark): AnnotationMark => {
      if (mark.kind !== "text") return mark;
      if (mark.labelDirection) {
        const context = canvasRef.current?.getContext("2d");
        if (!context) return mark;
        context.save();
        let fontSize = mark.fontSize, width = mark.rect.width, height = mark.rect.height;
        for (let attempt = 0; attempt < 32; attempt++) {
          const horizontal = fontSize * 1.99;
          width = Math.max(.1, Math.min(width, documentSize.width - horizontal * 2));
          context.font = textFont(fontSize);
          height = Math.max(.1, Math.ceil(layoutTextLines(mark.text, width, text => context.measureText(text).width).length * fontSize * 1.25));
          if (height + fontSize * .8 <= documentSize.height && horizontal * 2 + width <= documentSize.width) break;
          fontSize *= .8; width *= .8;
        }
        context.restore();
        const xMargin = fontSize * 1.99, yMargin = fontSize * .4;
        return {...mark, fontSize, rect:{x:Math.max(xMargin, Math.min(mark.rect.x, documentSize.width - xMargin - width)),
          y:Math.max(yMargin, Math.min(mark.rect.y, documentSize.height - yMargin - height)), width, height}};
      }
      const context = canvasRef.current?.getContext("2d");
      if (!context) return mark;
      const measureHeight = (width: number, fontSize: number) => {
        context.font = textFont(fontSize);
        const lines = layoutTextLines(mark.text, width, text => context.measureText(text).width);
        return Math.max(1, Math.ceil(lines.length * fontSize * 1.25));
      };
      context.save();
      let {width} = mark.rect;
      let {fontSize} = mark;
      let height = measureHeight(width, fontSize);
      if (!handle) {
        context.restore();
        return {...mark, rect: {...mark.rect, height}};
      }
      const left = handle.includes("Left") || handle === "left";
      const right = handle.includes("Right") || handle === "right";
      const top = handle.startsWith("top");
      const bottom = handle.startsWith("bottom");
      const anchorX = left ? mark.rect.x + width : right ? mark.rect.x : mark.rect.x + width / 2;
      const anchorY = top ? mark.rect.y + mark.rect.height : bottom ? mark.rect.y : mark.rect.y + mark.rect.height / 2;
      const room = Math.max(0, top ? anchorY : bottom ? documentSize.height - anchorY :
        2 * Math.min(anchorY, documentSize.height - anchorY));
      if (room < 1) { context.restore(); return original; }
      // A wrap threshold can add lines even when width/font scale together.
      // Reduce the proposed scale against measured height, preserving its fixed
      // edge/center. Never accept a frame that extends beyond that anchored room.
      for (let attempt = 0; height > room && attempt < 12; attempt++) {
        const factor = Math.min(.99, room / height);
        width *= factor;
        fontSize *= factor;
        height = measureHeight(width, fontSize);
      }
      context.restore();
      if (height > room) return original;
      return {...mark, fontSize, rect: {
        x: left ? anchorX - width : right ? anchorX : anchorX - width / 2,
        y: top ? anchorY - height : bottom ? anchorY : anchorY - height / 2,
        width, height,
      }};
    }, [documentSize.height, documentSize.width]);

    fitLabelRef.current = fitTextBounds;

    const onPointerMove = useCallback(
      (e: React.PointerEvent) => {
        if (Math.hypot(e.clientX - canvasClickRef.current.start.x,
          e.clientY - canvasClickRef.current.start.y) >= 3) canvasClickRef.current.moved = true;
        if (interactionsDisabled()) return;
        const p = clampPoint(toPoint(e), {
          x: 0,
          y: 0,
          width: documentSize.width,
          height: documentSize.height,
        });
        const interaction = interactionRef.current;
        if (interaction.kind === "none") {
          if (toolRef.current === "mosaic" && mosaicShapeRef.current==="brush") setBrushCursor(p);
          else if (brushCursorRef.current) setBrushCursor(null);
          if (toolRef.current === "select" || toolRef.current === "line" || toolRef.current === "arrow") {
            // Spec §6.7: handle → crosshair, over a mark → open hand,
            // otherwise arrow.
            const current = history.elements;
            const selected = selectedIndexRef.current;
            let cursor = "default";
            const selectedMark = selected === null ? null : current[selected];
            const activeLine = selectedMark &&
              (selectedMark.kind === "line" || selectedMark.kind === "arrow") &&
              (toolRef.current === "select" || toolRef.current === selectedMark.kind);
            if (activeLine &&
              (Math.hypot(p.x - selectedMark.start.x, p.y - selectedMark.start.y) <= 10 * hitTestScale.radial ||
                Math.hypot(p.x - selectedMark.end.x, p.y - selectedMark.end.y) <= 10 * hitTestScale.radial)) {
              cursor = "crosshair";
            }
            if (toolRef.current === "select" && selectedMark?.kind === "callout") {
              if (calloutHandleAt(selectedMark, p, 9 * hitTestScale.radial)) cursor = "crosshair";
            } else if (toolRef.current === "select" && selected !== null && current[selected] && !["line","arrow"].includes(current[selected].kind)) {
              if (
                hitTestHandle(
                  p,
                  selectionBounds(current[selected]),
                  9 * hitTestScale.radial,
                )
              ) {
                cursor = "crosshair";
              }
            }
            if (
              cursor === "default" &&
              (toolRef.current === "select" || activeLine) &&
              (toolRef.current === "select"
                ? markIndexAt(current, p, hitTestScale) !== null
                : markIndexAt(current, p, hitTestScale) === selected)
            ) {
              cursor = "grab";
            }
            setSelectCursor(cursor);
          }
          return;
        }
        if (interaction.kind === "draw") {
          const t = interaction.tool;
          // Spec §7.4: the brush cursor tracks the drag point while drawing.
          if (t === "mosaic" && mosaicShapeRef.current==="brush") setBrushCursor(p);
          if (t === "callout") {
            setDraft(createCallout(interaction.start, p, -1));
          } else if (t === "pen" || t === "mosaic") {
            const points = interaction.points;
            const last = points[points.length - 1];
            if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.5) points.push(p);
            if (t === "pen") {
              setDraft({
                kind: "pen",
                id: -1,
                points: [...points],
                color: appearanceRef.current.colorPreset,
                width: appearanceRef.current.penWidth,
              });
            } else {
              setDraft({
                kind: "mosaic",
                id: -1,
                points: mosaicShapeRef.current==="brush"?[...points]:[interaction.start,p],
                shape:mosaicShapeRef.current,
                brushDiameter: appearanceRef.current.mosaicBrushDiameter,
                intensity: appearanceRef.current.mosaicIntensity,
                style: appearanceRef.current.mosaicStyle,
              });
            }
          } else {
            const start = interaction.start;
            if (t === "rectangle") {
              setDraft({
                kind: "rectangle",
                id: -1,
                rect: {
                  x: Math.min(start.x, p.x),
                  y: Math.min(start.y, p.y),
                  width: Math.abs(p.x - start.x),
                  height: Math.abs(p.y - start.y),
                },
                color: appearanceRef.current.colorPreset,
                width: appearanceRef.current.shapeWidth,
              });
            } else {
              setDraft({
                kind: t==="arrow"?"arrow":"line",
                id: -1,
                start,
                end: p,
                color: appearanceRef.current.colorPreset,
                width: appearanceRef.current.shapeWidth,
              });
            }
          }
          return;
        }
        if (interaction.kind === "move") {
          const by = { x: p.x - interaction.start.x, y: p.y - interaction.start.y };
          setDraft(
            translateMark(interaction.original, by, {
              x: 0,
              y: 0,
              width: documentSize.width,
              height: documentSize.height,
            }),
          );
          return;
        }
        if (interaction.kind === "resize") {
          const resized = dragAnnotationHandle(interaction.original, interaction.handle,
            {x: p.x - interaction.start.x, y: p.y - interaction.start.y},
            {x: 0, y: 0, width: documentSize.width, height: documentSize.height});
          setDraft(resized === interaction.original ? resized :
            fitTextBounds(resized, interaction.handle, interaction.original));
          return;
        }
        if (interaction.kind === "endpoint") {
          setDraft(dragAnnotationHandle(interaction.original, interaction.isStart ? "start" : "end",
            { x: p.x-interaction.start.x, y: p.y-interaction.start.y }, {x:0,y:0,width:documentSize.width,height:documentSize.height}));
        }
      },
      [toPoint, documentSize.height, documentSize.width, history, hitTestScale, fitTextBounds, createCallout],
    );

    const onPointerUp = useCallback(
      (e: React.PointerEvent) => {
        if (interactionsDisabled()) return;
        const p = clampPoint(toPoint(e), {
          x: 0,
          y: 0,
          width: documentSize.width,
          height: documentSize.height,
        });
        const interaction = interactionRef.current;
        interactionRef.current = { kind: "none" };
        if (interaction.kind === "move") setSelectCursor("default");

        if (interaction.kind === "draw") {
          const t = interaction.tool;
          const ap = appearanceRef.current;
          if (t === "callout") {
            appendMark(createCallout(interaction.start, p, Date.now() + Math.random()));
          } else if (t === "pen") {
            const points = interaction.points;
            const last = points[points.length - 1];
            if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.5) points.push(p);
            if (points.length > 0) {
              appendMark({
                kind: "pen",
                id: Date.now() + Math.random(),
                points: [...points],
                color: ap.colorPreset,
                width: ap.penWidth,
              });
            }
          } else if (t === "mosaic") {
            const points = interaction.points;
            const last = points[points.length - 1];
            if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.5) points.push(p);
            if(mosaicShapeRef.current!=="brush"&&(Math.abs(p.x-interaction.start.x)<1||Math.abs(p.y-interaction.start.y)<1)){setDraft(null);return;}
            appendMark({
              kind: "mosaic",
              id: Date.now() + Math.random(),
              points: mosaicShapeRef.current==="brush"?[...points]:[interaction.start,p],
              shape:mosaicShapeRef.current,
              brushDiameter: ap.mosaicBrushDiameter,
              intensity: ap.mosaicIntensity,
              style: ap.mosaicStyle,
            });
          } else if (t === "rectangle") {
            const start = interaction.start;
            if(Math.abs(p.x-start.x)<1||Math.abs(p.y-start.y)<1){setDraft(null);return;}
            appendMark({
              kind: "rectangle",
              id: Date.now() + Math.random(),
              rect: {
                x: Math.min(start.x, p.x),
                y: Math.min(start.y, p.y),
                width: Math.abs(p.x - start.x),
                height: Math.abs(p.y - start.y),
              },
              color: ap.colorPreset,
              width: ap.shapeWidth,
            });
          } else {
            const start = interaction.start;
            if (Math.hypot(p.x - start.x, p.y - start.y) >= 3) {
              appendMark({
                kind: t === "arrow" ? "arrow" : "line",
                id: Date.now() + Math.random(),
                start,
                end: p,
                color: ap.colorPreset,
                width: ap.shapeWidth,
              });
            }
          }
          setDraft(null);
          return;
        }

        if (
          interaction.kind === "move" ||
          interaction.kind === "resize" ||
          interaction.kind === "endpoint"
        ) {
          const bounds={x:0,y:0,width:documentSize.width,height:documentSize.height};
          let preview=interaction.kind==="move"?translateMark(interaction.original,{x:p.x-interaction.start.x,y:p.y-interaction.start.y},bounds):
            dragAnnotationHandle(interaction.original,interaction.kind==="resize"?interaction.handle:interaction.isStart?"start":"end",
              {x:p.x-interaction.start.x,y:p.y-interaction.start.y},bounds);
          if (interaction.kind === "resize" && preview !== interaction.original) {
            preview = fitTextBounds(preview, interaction.handle, interaction.original);
          }
          // Spec §6.3: only commit a drag when it actually changed the
          // mark (≥1pt of movement) — a click without movement must not
          // write a no-op history entry.
          const changed =
            Math.hypot(p.x - interaction.start.x, p.y - interaction.start.y) >= 1 &&
            preview !== null && JSON.stringify(preview) !== JSON.stringify(interaction.original);
          if (preview && changed) {
            history.replace(interaction.index, preview);
            syncMarks();
          }
          setDraft(null);
        }
        redraw();
      },
      [
        toPoint,
        documentSize.height,
        documentSize.width,
        redraw,
        syncMarks,
        history,appendMark,fitTextBounds,createCallout,
      ],
    );

    // Keyboard shortcuts (overlay-level keys are handled by the parent).
    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        const canvasWindow = window as unknown as { __kiriOverlay?: boolean };
        if (!canvasWindow.__kiriOverlay) return;
        if (interactionsDisabled()) return;
        if (editingRef.current) return;
        if (e.key === "Delete" || e.key === "Backspace") {
          if (toolRef.current === "select" && selectedIndexRef.current !== null) {
            history.remove(selectedIndexRef.current);
            selectMark(null);
            syncMarks();
          }
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [history, interactionsDisabled, syncMarks]);

    const selectedIndexRef = useRef<number | null>(null);
    useEffect(() => {
      selectedIndexRef.current = selectedIndex;
    }, [selectedIndex]);

    const undoRef = useRef<() => void>(() => {});
    const redoRef = useRef<() => void>(() => {});
    const deleteRef = useRef<() => void>(() => {});
    undoRef.current = () => {
      if (interactionsDisabled()) return;
      commitText();
      finishAppearanceAdjustment();
      if (onUndo) { onUndo(); return; }
      history.undo();
      selectMark(null);
      syncMarks();
    };
    redoRef.current = () => {
      if (interactionsDisabled()) return;
      commitText();
      finishAppearanceAdjustment();
      if (onRedo) { onRedo(); return; }
      history.redo();
      selectMark(null);
      syncMarks();
    };
    deleteRef.current = () => {
      if (interactionsDisabled()) return;
      if (selectedIndexRef.current === null) return;
      finishAppearanceAdjustment();
      history.remove(selectedIndexRef.current);
      selectMark(null);
      syncMarks();
    };

    // Live text font-size adjustment (spec §6.6): begin records the selected
    // text mark; set applies a preview without touching history; end commits
    // a single replace entry if the size actually changed.
    const fontAdjustRef = useRef<{
      index: number;
      original: Extract<AnnotationMark, { kind: "text" }>;
    } | null>(null);
    const beginFontAdjustRef = useRef<() => void>(() => {});
    const setFontLiveRef = useRef<(value: number) => void>(() => {});
    const endFontAdjustRef = useRef<() => void>(() => {});
    beginFontAdjustRef.current = () => {
      if (interactionsDisabled()) return;
      if (fontAdjustRef.current) return;
      commitText();
      const index = selectedIndexRef.current;
      const mark = index !== null ? history.elements[index] : undefined;
      if (index !== null && mark && mark.kind === "text") {
        fontAdjustRef.current = { index, original: mark };
      } else {
        fontAdjustRef.current = null;
      }
    };
    setFontLiveRef.current = (value: number) => {
      if (interactionsDisabled()) return;
      // Range inputs also change through keyboard and accessibility actions.
      if (!fontAdjustRef.current) beginFontAdjustRef.current();
      const adjust = fontAdjustRef.current;
      if (!adjust) return;
      const mark = history.elements[adjust.index];
      if (!mark || mark.kind !== "text") return;
      const updated = fitTextBounds(applyAnnotationAppearance(adjust.original, { textFontSize: value }));
      // Preview: swap the element without recording history.
      const before = history.elements.slice();
      before[adjust.index] = updated;
      history.overwrite(before);
      // Keep live slider frames local; external history gets one final commit.
      setMarks(history.elements.slice());
      publishHistory();
    };
    const finishFontAdjustment = useCallback(() => {
      const adjust = fontAdjustRef.current;
      fontAdjustRef.current = null;
      if (!adjust) return;
      const mark = history.elements[adjust.index];
      if (mark && mark.kind === "text" &&
          JSON.stringify(mark) !== JSON.stringify(adjust.original)) {
        history.commitOverwrite(adjust.index, adjust.original);
        syncMarks();
      }
    }, [history, syncMarks]);
    endFontAdjustRef.current = () => {
      if (interactionsDisabled()) return;
      finishFontAdjustment();
    };

    const exportResult = useCallback(async (cropSelection?: Rect): Promise<AnnotationExportResult | null> => {
      const img = imageRef.current;
      if (!img) return null;
      if (!img.complete) {
        try {
          await img.decode();
        } catch {
          return null;
        }
      }
      const sourceImage = getSourceImage();
      if (!sourceImage) return null;

      // This is intentionally synchronous: the PNG and sidecar below must be
      // derived from the exact same committed text/mark snapshot.
      finishFontAdjustment();
      finishAppearanceAdjustment();
      commitText();
      const scaleX =
        sourceImage.naturalWidth / (displaySize?.width ?? documentSize.width);
      const scaleY =
        sourceImage.naturalHeight / (displaySize?.height ?? documentSize.height);
      const derivedSourcePixels = {
        width: Math.max(1, Math.round(documentSize.width * scaleX)),
        height: Math.max(1, Math.round(documentSize.height * scaleY)),
      };
      if (
        initialProject &&
        (initialProject.sourcePixels.width !== derivedSourcePixels.width ||
          initialProject.sourcePixels.height !== derivedSourcePixels.height)
      ) {
        return null;
      }

      let project: AnnotationDocumentV1;
      try {
        project = parseAnnotationDocument({
          schemaVersion: 1,
          canvas: documentSize,
          sourcePixels: initialProject?.sourcePixels ?? derivedSourcePixels,
          marks: history.elements,
        });
      } catch {
        return null;
      }
      let sourceCrop: Rect;
      try {
        sourceCrop = annotationSourceCrop(
          { width: sourceImage.naturalWidth, height: sourceImage.naturalHeight },
          displaySize ?? documentSize,
          region,
          project.sourcePixels,
        );
      } catch {
        return null;
      }
      const exportScaleX = project.sourcePixels.width / documentSize.width;
      const exportScaleY = project.sourcePixels.height / documentSize.height;

      let cropPixels: CropPixels | null = null;
      let exportSource: CanvasImageSource = sourceImage;
      let croppedSource: HTMLCanvasElement | null = null;
      if (cropSelection && !isFullCrop(project, cropSelection)) {
        const cropped = cropAnnotationDocument(project, cropSelection);
        cropPixels = cropped.cropPixels;
        project = cropped.document;
        // Re-render from exactly the clean source that Rust will persist.
        // Mosaic sampling at the cropped edge must match a later reopen.
        croppedSource = document.createElement("canvas");
        croppedSource.width = cropPixels.width;
        croppedSource.height = cropPixels.height;
        const sourceContext = croppedSource.getContext("2d");
        if (!sourceContext) return null;
        sourceContext.drawImage(sourceImage, sourceCrop.x+cropPixels.x, sourceCrop.y+cropPixels.y,
          cropPixels.width, cropPixels.height, 0, 0, cropPixels.width, cropPixels.height);
        exportSource = croppedSource;
      }

      const out = document.createElement("canvas");
      out.width = project.sourcePixels.width;
      out.height = project.sourcePixels.height;
      const ctx = out.getContext("2d");
      if (!ctx) {
        out.width = 0;
        out.height = 0;
        return null;
      }
      const context: RenderContext = {
        ctx,
        sourceImage: exportSource,
        sourceWidth: croppedSource?.width ?? sourceImage.naturalWidth,
        sourceHeight: croppedSource?.height ?? sourceImage.naturalHeight,
        sourceOffset: croppedSource ? { x: 0, y: 0 } : {
          x: sourceCrop.x / exportScaleX,
          y: sourceCrop.y / exportScaleY,
        },
        regionSize: { x: 0, y: 0, ...project.canvas },
        scaleX: exportScaleX,
        scaleY: exportScaleY,
        viewScaleX: 1,
        viewScaleY: 1,
        exporting: true,
      };
      renderAll(context, project.marks, {});
      if (croppedSource) { croppedSource.width = 0; croppedSource.height = 0; }
      const blob = await new Promise<Blob | null>((resolve) =>
        out.toBlob(resolve, "image/png"),
      );
      if (!blob) {
        out.width = 0;
        out.height = 0;
        return null;
      }
      const png = new Uint8Array(await blob.arrayBuffer());
      // Release the large export backing store immediately instead of
      // waiting for a later garbage-collection cycle.
      out.width = 0;
      out.height = 0;
      return { png, document: project, cropPixels };
    }, [
      commitText,
      displaySize,
      documentSize.height,
      documentSize.width,
      getSourceImage,
      history,
      initialProject,
      finishFontAdjustment,
      finishAppearanceAdjustment,
      region.x,
      region.y,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        undo: () => undoRef.current(),
        redo: () => redoRef.current(),
        clearAnnotations: () => {
          if (interactionsDisabled()) return;
          if (history.elements.length === 0 && !editingRef.current) return;
          // Spec §10.1: clear also discards an in-flight text edit.
          editingRef.current = null;
          setEditing(null);
          history.clear();
          selectMark(null);
          syncMarks();
        },
        deleteSelection: () => deleteRef.current(),
        commitTextEditing: () => {
          if (!interactionsDisabled()) commitText();
        },
        cancelTextEditing: () => {
          if (interactionsDisabled() || !editingRef.current) return false;
          return cancelInteraction();
        },
        editSelectedText:()=>{if(!interactionsDisabled()&&selectedIndexRef.current!==null)editText(selectedIndexRef.current);},
        clearSelection:()=>{if(!interactionsDisabled()){finishAppearanceAdjustment();selectMark(null);}},
        cancelInteraction,
        updateSelectionAppearance,
        updateSelectedCallout,
        finishAppearanceAdjustment,
        setMosaicShape:(shape)=>{
          if(interactionsDisabled())return;finishAppearanceAdjustment();
          const index=selectedIndexRef.current;if(index===null)return;
          const mark=history.elements[index];if(!mark||mark.kind!=="mosaic")return;
          const next=changeMosaicShape(mark,shape);if(next!==mark){history.replace(index,next);syncMarks();}
        },
        exportResult: (cropSelection) => exportResult(cropSelection),
        beginTextFontSizeAdjustment: () => beginFontAdjustRef.current(),
        setTextFontSizeLive: (value: number) => setFontLiveRef.current(value),
        endTextFontSizeAdjustment: () => endFontAdjustRef.current(),
      }),
      [commitText, exportResult, history, interactionsDisabled, syncMarks,editText,selectMark,cancelInteraction,updateSelectionAppearance,updateSelectedCallout,finishAppearanceAdjustment],
    );

    const dotMarks = draft && marks.some(mark => mark.id === draft.id)
      ? marks.map(mark => mark.id === draft.id ? draft : mark) : marks;
    return (
      <div
        className="annotation-canvas-root"
        aria-busy={interactionDisabled}
        data-interaction-disabled={interactionDisabled || undefined}
        style={{
          position: "relative",
          width: view.width,
          height: view.height,
          pointerEvents: interactionDisabled ? "none" : "auto",
        }}
      >
        <canvas
          ref={canvasRef}
          width={Math.round(view.width * devicePixelRatio)}
          height={Math.round(view.height * devicePixelRatio)}
          style={{
            display: "block",
            width: view.width,
            height: view.height,
            // Spec §6.7: mosaic uses a crosshair, select tracks hover
            // (arrow/hand/crosshair), all other tools use the arrow.
            cursor:
              interactionDisabled
                ? "progress"
                : tool === "mosaic"
                ? "crosshair"
                : tool === "select"
                  ? selectCursor
                  : "default",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onClick={(event) => {
            const point = toPoint(event.nativeEvent);
            const selected = selectedIndexRef.current === null ? null : history.elements[selectedIndexRef.current];
            const eligible = !interactionsDisabled() && toolRef.current === "select" &&
              !editingRef.current && !canvasClickRef.current.wasEditing && !canvasClickRef.current.moved &&
              markIndexAt(history.elements, point, hitTestScale) === null &&
              !(selected && hitTestHandle(point, selectionBounds(selected), 10 * hitTestScale.radial));
            blankDoubleClickRef.current = event.detail === 1
              ? eligible : blankDoubleClickRef.current && eligible;
          }}
          onDoubleClick={(event) => {
            if (interactionsDisabled() || toolRef.current !== "select" || editingRef.current) return;
            const index = markIndexAt(history.elements, toPoint(event.nativeEvent), hitTestScale);
            if (index !== null && history.elements[index].kind === "text") {
              editText(index);
            } else if (index === null && blankDoubleClickRef.current) {
              onFinishOnBlankDoubleClick?.();
            }
          }}
          onPointerCancel={()=>{interactionRef.current={kind:"none"};setDraft(null);setSelectCursor("default");}}
          onPointerLeave={()=>setBrushCursor(null)}
        />
        {dotMarks.map((mark, index) => {
          if (mark.kind !== "text" || !mark.labelDirection || editing?.id === mark.id) return null;
          const {dot, radius} = labelGeometry(mark.rect, mark.fontSize, mark.labelDirection);
          if (markIndexAt(dotMarks.slice(index + 1), dot, hitTestScale) !== null) return null;
          return <LabelDot key={mark.id} x={dot.x * viewScaleX} y={dot.y * viewScaleY}
            radius={radius * Math.min(viewScaleX, viewScaleY)} color={COLOR_HEX[mark.color]}
            direction={mark.labelDirection} disabled={interactionDisabled}
            onToggle={() => toggleLabel(mark.id)}/>;
        })}
        {editing && (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: documentSize.width,
              height: documentSize.height,
              transformOrigin: "top left",
              transform: `scale(${view.width / documentSize.width}, ${view.height / documentSize.height})`,
              pointerEvents: "none",
            }}
          >
            <TextEditor
              key={editing.id}
              editing={editing}
              bounds={documentSize}
              disabled={interactionDisabled}
              onToggleDirection={() => toggleLabel(editing.id)}
              onTextChange={updateEditingText}
              onRectChange={updateEditingRect}
              onCommit={commitText}
              onFinish={onFinishAfterTextCommit}
              onUndo={() => undoRef.current()}
              onRedo={() => redoRef.current()}
              onCancel={textEscapeCancelsEdit?()=>{cancelInteraction();}:onCancel}
              nativeUndo={textEscapeCancelsEdit}
            />
          </div>
        )}
      </div>
    );
  },
);

function TextEditor(props: {
  editing: EditingState;
  bounds: { width: number; height: number };
  disabled: boolean;
  onToggleDirection(): void;
  onTextChange(text: string): void;
  onRectChange(rect: Rect): void;
  onCommit(): void;
  onFinish?(): void;
  onUndo(): void;
  onRedo(): void;
  onCancel(): void;
  nativeUndo?: boolean;
}) {
  const {
    editing,
    bounds,
    disabled,
    onTextChange,
    onToggleDirection,
    onRectChange,
    onCommit,
    onFinish,
    onUndo,
    onRedo,
    onCancel,
    nativeUndo,
  } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  const initialText = useRef(editing.text);
  const attachTextarea = useCallback((element: HTMLTextAreaElement | null) => {
    ref.current = element;
    // Let the native editor own the live value/undo stack. A controlled React
    // textarea also rewrites defaultValue (light-DOM children) on each input;
    // WebKit treats those script mutations as non-user edits. Initialize once
    // per annotation, then observe input without writing it back into the DOM.
    if (element) element.value = initialText.current;
  }, []);
  const hintId = useId();
  const hintHeight = 32 * editing.uiScale;
  const hintTop = editing.rect.y + editing.rect.height + 4 * editing.uiScale;

  // Spec §6.6 resizeTextEditor: min 120×34, grows with text/font, clamped
  // to the right/bottom edges of the region.
  useEffect(() => {
    // Creation happens on pointerdown. Focus after its native mouse default
    // action, which otherwise returns WebKit focus to the underlying canvas.
    const frame = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const font = textFont(editing.fontSize);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = font;
    const text = editing.text || t("Type something…");
    // Width follows the longest line (measureText on the whole string with
    // newlines yields a wrong width).
    const insets = textEditorInsets(editing.uiScale);
    const marginX = editing.labelDirection ? Math.max(0, editing.fontSize * 1.99 - insets.x) : 0;
    const marginY = editing.labelDirection ? Math.max(0, editing.fontSize * .4 - insets.y) : 0;
    const frame = fitTextEditorFrame({
        text,
        fontSize: editing.fontSize,
        x: editing.rect.x - marginX,
        y: editing.rect.y - marginY,
        maxWidth: Math.min(editing.maxWidth, bounds.width - 2 * marginX),
        uiScale: editing.uiScale,
        boundsWidth: bounds.width - 2 * marginX,
        boundsHeight: bounds.height - 2 * marginY,
        measureText: (value) => ctx.measureText(value).width,
      });
    onRectChange({...frame, x:frame.x+marginX, y:frame.y+marginY});
  }, [
    editing.labelDirection,
    bounds.height,
    bounds.width,
    editing.fontSize,
    editing.maxWidth,
    editing.rect.x,
    editing.rect.y,
    editing.text,
    onRectChange,
  ]);

  const insets = textEditorInsets(editing.uiScale);
  const label = editing.labelDirection ? labelGeometry({x:editing.rect.x+insets.x, y:editing.rect.y+insets.y,
    width:Math.max(1,editing.rect.width-insets.x*2),height:Math.max(1,editing.rect.height-insets.y*2)}, editing.fontSize, editing.labelDirection) : null;
  const edge = label ? editing.labelDirection === "left" ? label.body.x : label.body.x+label.body.width : 0;
  const sign = editing.labelDirection === "left" ? -1 : 1;
  return (
    <>
    {label && <>
      <svg aria-hidden="true" width={bounds.width} height={bounds.height} style={{position:"absolute",inset:0,pointerEvents:"none"}}>
        <rect {...label.body} rx={editing.fontSize*.45} fill="#303136"/>
        <path d={`M${edge-sign} ${label.dot.y-label.tail} L${edge+sign*label.tail} ${label.dot.y} L${edge-sign} ${label.dot.y+label.tail} Z`} fill="#303136"/>
      </svg>
      <LabelDot x={label.dot.x} y={label.dot.y} radius={label.radius} color={COLOR_HEX[editing.color]}
        direction={editing.labelDirection!} disabled={disabled} onToggle={onToggleDirection}/>
    </>}
    <textarea
      ref={attachTextarea}
      className={label ? "kiri-label-text-editor" : undefined}
      aria-label={t("Text content")}
      aria-describedby={hintId}
      disabled={disabled}
      placeholder={t("Type something…")}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      onCompositionStart={(e) => setTextComposition(e.currentTarget, true)}
      onCompositionEnd={(e) => setTextComposition(e.currentTarget, false)}
      onBlur={(e) => setTextComposition(e.currentTarget, false)}
      onChange={(e) => onTextChange(e.target.value)}
      onKeyDown={(e) => {
        handleTextEditorKey(e, { cancel: onCancel, commit: onCommit,
          undo: onUndo, redo: onRedo, finish: onFinish,
          nativeHistory: (command) => e.currentTarget.ownerDocument.execCommand(command),
        }, nativeUndo);
      }}
      style={{
        position: "absolute",
        left: editing.rect.x,
        top: editing.rect.y,
        width: editing.rect.width,
        height: editing.rect.height,
        boxSizing: "border-box",
        padding: `${5*editing.uiScale}px ${8*editing.uiScale}px`,
        font: textFont(editing.fontSize),
        color: label ? "#fafafa" : COLOR_HEX[editing.color],
        background: label ? "transparent" : editing.background === "dark" ? "rgba(0,0,0,0.72)" : "transparent",
        border: `${editing.uiScale}px solid ${label ? "#ffffff55" : COLOR_HEX[editing.color]+"cc"}`,
        borderRadius: 7,
        resize: "none",
        overflow: "hidden",
        whiteSpace: "pre-wrap",
        tabSize: TEXT_TAB_SIZE,
        wordBreak: "break-word",
        lineHeight: 1.25,
        pointerEvents: "auto",
      }}
    />
    <div id={hintId} style={{
      position: "absolute",
      left: Math.min(editing.rect.x, Math.max(0, bounds.width - 280 * editing.uiScale)),
      top: hintTop + hintHeight <= bounds.height ? hintTop : Math.max(0, editing.rect.y - hintHeight - 4 * editing.uiScale),
      maxWidth: Math.min(280 * editing.uiScale, bounds.width),
      boxSizing: "border-box",
      padding: `${3 * editing.uiScale}px ${6 * editing.uiScale}px`,
      borderRadius: 5 * editing.uiScale,
      background: "rgba(0,0,0,.8)",
      color: "#eee",
      font: `${10 * editing.uiScale}px/${13 * editing.uiScale}px var(--kiri-font-ui)`,
      pointerEvents: "none",
    }}>{t("Shift + Enter: new line · Enter: done · Esc: cancel edit")}</div>
    </>
  );
}

export default AnnotationCanvas;


function LabelDot({x, y, radius, color, direction, disabled, onToggle}: {
  x:number; y:number; radius:number; color:string; direction:LabelDirection; disabled:boolean; onToggle():void;
}) {
  const size = Math.max(radius * 2 + 10, 22);
  const title = t(direction === "left" ? "Point label right" : "Point label left");
  return <button type="button" className="kiri-label-dot" title={title} aria-label={title} disabled={disabled}
    onPointerDown={event => {event.stopPropagation(); event.preventDefault();}}
    onClick={event => {event.stopPropagation(); onToggle();}}
    onDoubleClick={event => {event.stopPropagation(); event.preventDefault();}}
    onKeyDown={event => {if(event.key==="Enter"||event.key===" ")event.stopPropagation();}}
    onKeyUp={event => {if(event.key==="Enter"||event.key===" ")event.stopPropagation();}}
    style={{position:"absolute",left:x-size/2,top:y-size/2,width:size,height:size,pointerEvents:"auto"}}>
    <span style={{width:radius*2,height:radius*2,background:color}}/>
  </button>;
}
