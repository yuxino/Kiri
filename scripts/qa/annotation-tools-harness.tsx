// Isolated QA entry: actual product windows with generated pixels and mocked
// Tauri IPC. Never imported by the app or connected to a user's library.
import React from "react";
import {createRoot} from "react-dom/client";
import {mockIPC, mockWindows, mockConvertFileSrc} from "@tauri-apps/api/mocks";
import {EditorWindow} from "../../src/windows/EditorWindow";
import {OverlayWindow} from "../../src/windows/OverlayWindow";
import {DEFAULT_APPEARANCE, type AnnotationDocumentV1} from "../../src/annotation/model";
import {DEFAULT_RECORDING_OPTIONS} from "../../src/lib/ipc";
import {languages, setLanguage, type KiriLanguage} from "../../src/i18n";
import {renderAll} from "../../src/annotation/render";
import {mosaicPixelCases} from "../helpers/mosaic-pixel-cases.mjs";
import {watermarkPixelCases} from "../helpers/watermark-pixel-cases.mjs";
import {cropAnnotationDocument} from "../../src/annotation/crop.js";
import "../../src/styles/design-system.css";

const params = new URLSearchParams(location.search);
params.set("captureToken", "0123456789abcdef0123456789abcdef");
history.replaceState(null, "", `?${params}`);
const language = params.get("lang") as KiriLanguage;
if (languages.includes(language)) setLanguage(language);
const overlay = params.get("window") === "overlay";
const scale = overlay ? Number(params.get("scale")) || 2 : 1;
const width = overlay ? innerWidth : 960, height = overlay ? innerHeight : 600;
const source = document.createElement("canvas");
source.width = Math.round(width * scale); source.height = Math.round(height * scale);
const ctx = source.getContext("2d")!;
ctx.scale(scale, scale);
for (let y = 0; y < height; y += 20) for (let x = 0; x < width; x += 20) {
  ctx.fillStyle = `rgb(${(x * 7 + y * 13) % 190 + 40},${(x * 17 + y * 3) % 190 + 40},${(x / 20 % 3) * 70 + 60})`;
  ctx.fillRect(x, y, 20, 20);
}
ctx.fillStyle = "#fff"; ctx.fillRect(24, 24, width - 48, 82);
ctx.fillStyle = "#141414"; ctx.font = "22px sans-serif";
ctx.fillText("Kiri annotation QA — generated test image", 40, 62);
ctx.font = "16px sans-serif"; ctx.fillText("Direct text · mosaic · editable watermarks", 40, 88);
const png = await new Promise<Blob>(resolve => source.toBlob(blob => resolve(blob!)));
let stored: AnnotationDocumentV1 = {
  schemaVersion: 1, canvas: {width, height}, sourcePixels: {width: source.width, height: source.height}, marks: [],
};
if (params.has("seed")) stored.marks = [
  {kind: "rectangle", id: 1, rect: {x: 120, y: 180, width: 150, height: 100}, color: "white", width: 4},
  {kind: "text", id: 2, rect: {x: 300, y: 180, width: 180, height: 42}, text: "Editable text", color: "white", fontSize: 24, background: "transparent"},
  {kind: "mosaic", id: 3, points: [{x: 550, y: 180}, {x: 750, y: 280}], brushDiameter: 24, intensity: "strong", style: "pixel", shape: "rectangle"},
];
if (params.has("watermark")) stored.marks.push({kind: "watermark", id: 4,
  text: "Kiri QA", rect: {x: params.has("outside") ? -180 : 320, y: params.has("outside") ? -120 : 300, width: 140, height: 42},
  fontSize: 28, color: "black", opacity: .2, rotation: -30, spacing: 80, mode: "tiled"});
let appearance = {...DEFAULT_APPEARANCE};
const actions: {command: string; payload?: unknown}[] = [];
const createCanvas = (w: number, h: number) => {
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h; return canvas;
};
const qa = {actions, source, get document() {return stored;}, exports: [] as Uint8Array[],
  mosaicPixels: () => mosaicPixelCases(createCanvas, renderAll),
  watermarkPixels: () => watermarkPixelCases(createCanvas, renderAll, cropAnnotationDocument),
};
Object.assign(window, {__annotationToolsQa: qa});
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => String(input).startsWith("kiri:")
  ? Promise.resolve(new Response(png)) : realFetch(input, init);
mockWindows(overlay ? "overlay" : "editor");
mockConvertFileSrc("macos");
mockIPC((command, payload) => {
  switch (command) {
    case "start_capture": return {displayWidth: width, displayHeight: height, scale,
      pixelWidth: source.width, pixelHeight: source.height, sourceApplication: "Annotation QA",
      windowRects: [{x: 40, y: 150, width: Math.min(600, width - 80), height: Math.min(360, height - 180)}]};
    case "get_asset_annotation_project": return {state: "valid", documentJson: JSON.stringify(stored), revisionSha256: "a".repeat(64), readOnly: false};
    case "get_annotation_appearance": return appearance;
    case "set_annotation_appearance": appearance = {...appearance, ...(payload as {appearance: object}).appearance}; return appearance;
    case "get_recording_options": return DEFAULT_RECORDING_OPTIONS;
    case "mic_supported": return true;
    case "platform_capabilities": return {recording: true, localOcr: true, microphone: true, systemAudio: true};
    case "take_editor_qr_request": return false;
    case "save_file_dialog": actions.push({command, payload}); return "qa-save-token";
    case "prepare_capture_annotation": case "prepare_asset_annotation": {
      const request = payload as {documentJson: string};
      actions.push({command, payload}); stored = JSON.parse(request.documentJson); return "qa-annotation-token";
    }
    case "update_asset": case "confirm_capture":
      qa.exports.push(new Uint8Array(payload as ArrayBuffer)); actions.push({command});
      return {revisionSha256: "b".repeat(64), actionSucceeded: true};
    case "cancel_capture": case "start_recording_flow": actions.push({command, payload}); return;
    case "log_frontend_error": actions.push({command, payload}); console.error(payload); return;
    default:
      if (command.startsWith("plugin:event|") || command.startsWith("plugin:window|")) return;
      throw new Error(`Unsupported isolated QA command: ${command}`);
  }
}, {shouldMockEvents: true});
createRoot(document.getElementById("root")!).render(overlay ? <OverlayWindow/> : <EditorWindow id="annotation-tools-qa"/>);
