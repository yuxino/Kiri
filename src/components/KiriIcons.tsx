// KiriIcons — icon set backed by lucide-react. The IconName union keeps the
// SF-Symbol-style names used across the app (data-driven toolbars, menus);
// each maps to a crisp, consistent Lucide glyph.

import React from "react";
import {
  ArrowUpRight,
  Eye,
  Camera,
  Check,
  CircleCheck,
  CircleDot,
  CirclePause,
  CirclePlay,
  Crop,
  Copy,
  Film,
  Folder,
  Grid3x3,
  Image,
  Moon,
  MoreHorizontal,
  MousePointer2,
  Pause,
  Pen,
  Pin,
  PinOff,
  Play,
  PlaySquare,
  Redo2,
  ScanText,
  QrCode,
  Search,
  Slash,
  SlidersHorizontal,
  Square,
  SquareDashed,
  Star,
  Tag,
  TextCursorInput,
  TriangleAlert,
  Trash2,
  Type,
  Undo2,
  Video,
  X,
} from "lucide-react";

export type IconName =
  | "cursorarrow" // Select (V)
  | "crop" // Crop (C)
  | "pencil.tip" // Pen (P)
  | "rectangle.dashed" // Rectangle (R)
  | "line.diagonal" // Line (L)
  | "arrow.up.right" // Arrow (A)
  | "textformat" // Text (T)
  | "number.circle"
  | "square.grid.3x3.fill" // Mosaic (M)
  | "arrow.uturn.backward" // Undo
  | "arrow.uturn.forward" // Redo
  | "checkmark" // Done
  | "checkmark.circle.fill" // notice: copied/saved
  | "exclamationmark.triangle" // notice: capture error
  | "exclamationmark.triangle.fill" // notice: operation error
  | "record.circle.fill" // notice: recording started
  | "video.fill" // notice: recording saved
  | "trash.slash" // notice: trash emptied
  | "pause.circle.fill" // notice: recording paused
  | "play.circle.fill" // notice: recording resumed
  | "ellipsis.circle" // More
  | "xmark" // Cancel
  | "camera.viewfinder" // Screenshot mode
  | "record.circle" // Record mode
  | "text.viewfinder" // OCR mode
  | "qrcode"
  | "pin"
  | "pin.slash"
  | "square.dashed" // text background: transparent
  | "moon.fill" // text background: dark
  | "character.textbox" // text context icon
  | "play.fill" // resume recording
  | "pause.fill" // pause recording
  | "stop.fill" // stop recording
  | "slider.horizontal.3" // Settings / adjustments
  | "trash" // Clear annotations
  | "trash.fill" // library: move to trash
  | "doc.on.doc" // library: copy
  | "sparkles.rectangle.stack" // library: convert to GIF
  | "star" // library: favorite
  | "star.fill" // library: favorite (filled)
  | "magnifyingglass" // library: search
  | "folder" // show in finder
  | "photo.on.rectangle" // open in library
  | "play.rectangle" // open video
  | "tag" // library: tag
  | "eye"; // library: view

const ICONS: Record<IconName, React.ComponentType<Record<string, unknown>>> = {
  cursorarrow: MousePointer2,
  crop: Crop,
  "pencil.tip": Pen,
  "rectangle.dashed": SquareDashed,
  "line.diagonal": Slash,
  "arrow.up.right": ArrowUpRight,
  textformat: Type,
  "number.circle": CircleDot,
  "square.grid.3x3.fill": Grid3x3,
  "arrow.uturn.backward": Undo2,
  "arrow.uturn.forward": Redo2,
  checkmark: Check,
  "checkmark.circle.fill": CircleCheck,
  "exclamationmark.triangle": TriangleAlert,
  "exclamationmark.triangle.fill": TriangleAlert,
  "record.circle.fill": CircleDot,
  "video.fill": Film,
  "trash.slash": Trash2,
  "pause.circle.fill": CirclePause,
  "play.circle.fill": CirclePlay,
  "ellipsis.circle": MoreHorizontal,
  xmark: X,
  "camera.viewfinder": Camera,
  "record.circle": Video,
  "text.viewfinder": ScanText,
  "qrcode": QrCode,
  pin: Pin,
  "pin.slash": PinOff,
  "square.dashed": SquareDashed,
  "moon.fill": Moon,
  "character.textbox": TextCursorInput,
  "play.fill": Play,
  "pause.fill": Pause,
  "stop.fill": Square,
  "slider.horizontal.3": SlidersHorizontal,
  trash: Trash2,
  "trash.fill": Trash2,
  "doc.on.doc": Copy,
  "sparkles.rectangle.stack": Film,
  star: Star,
  "star.fill": Star,
  magnifyingglass: Search,
  folder: Folder,
  "photo.on.rectangle": Image,
  "play.rectangle": PlaySquare,
  tag: Tag,
  eye: Eye,
};

export function KiriIcon(props: {
  name: IconName;
  size?: number;
  style?: React.CSSProperties;
}) {
  const { name, size = 16, style } = props;
  if (name === "number.circle") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style} aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <path d="M10 9l2-1v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
  // Notice symbols arrive from Rust at runtime. An unknown symbol must not
  // crash the entire feedback window while it is reporting an error.
  const Glyph = ICONS[name] ?? TriangleAlert;
  return (
    <Glyph
      size={size}
      strokeWidth={2}
      fill={name === "star.fill" ? "currentColor" : "none"}
      style={style}
      aria-hidden="true"
    />
  );
}
