import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

type CardPress = {
  source: HTMLElement;
  ids: string[];
  pointerId: number;
  x: number;
  y: number;
  dragging: boolean;
};

function tagAtPointer(event: PointerEvent<HTMLDivElement>) {
  const chip = document.elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLButtonElement>("button[data-library-tag]");
  return chip && !chip.disabled && event.currentTarget.contains(chip)
    ? chip.dataset.libraryTag ?? null : null;
}

export function useLibraryTagDrag(
  enabled: boolean,
  getIds: (sourceId: string) => string[],
  onDrop: (ids: string[], tag: string) => void,
) {
  const press = useRef<CardPress | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [targetTag, setTargetTag] = useState<string | null>(null);

  const cancel = useCallback(() => {
    const current = press.current;
    press.current = null;
    if (!current?.dragging) return;
    if (current.source.hasPointerCapture(current.pointerId)) {
      current.source.releasePointerCapture(current.pointerId);
    }
    setDragging(false);
    setTargetTag(null);
  }, []);

  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !press.current) return;
      if (press.current.dragging) {
        event.preventDefault();
        event.stopPropagation();
      }
      cancel();
    };
    window.addEventListener("keydown", onEscape, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("blur", cancel);
    };
  }, [cancel]);

  return {
    targetTag,
    cancel,
    rootProps: {
      "data-tag-dragging": dragging || undefined,
      onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
        if (!event.isPrimary || event.button !== 0) return;
        cancel();
        suppressClick.current = false;
        if (!enabled || event.pointerType === "touch") return;
        const target = event.target as Element;
        if (target.closest("button,input,textarea,select,a,[contenteditable],[draggable='true']")) return;
        const source = target.closest<HTMLElement>("[data-card]");
        const id = source?.dataset.card;
        if (!source || !id) return;
        const ids = getIds(id);
        if (ids.length === 0) return;
        press.current = { source, ids, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const current = press.current;
        if (!current || event.pointerId !== current.pointerId) return;
        if (!enabled || !current.source.isConnected || !(event.buttons & 1)) {
          cancel();
          return;
        }
        if (!current.dragging) {
          if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
          current.source.setPointerCapture(current.pointerId);
          current.dragging = true;
          suppressClick.current = true;
          setDragging(true);
        }
        setTargetTag(tagAtPointer(event));
      },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        const current = press.current;
        if (!current || event.pointerId !== current.pointerId) return;
        const tag = enabled && current.dragging ? tagAtPointer(event) : null;
        cancel();
        if (tag) onDrop(current.ids, tag);
      },
      onPointerCancel(event: PointerEvent<HTMLDivElement>) {
        if (press.current?.pointerId === event.pointerId) cancel();
      },
      onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
        if (press.current?.pointerId === event.pointerId && press.current.source === event.target) cancel();
      },
      onDragStart: cancel,
      onClickCapture(event: MouseEvent<HTMLDivElement>) {
        if (!suppressClick.current || event.detail === 0) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
