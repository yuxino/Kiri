// QA entry point only: the real overlay with isolated Tauri IPC and generated
// pixels. Never imported by the app, never touches the clipboard or library.
import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { OverlayWindow } from "../../src/windows/OverlayWindow";
import { DEFAULT_APPEARANCE } from "../../src/annotation/model";
import { DEFAULT_RECORDING_OPTIONS } from "../../src/lib/ipc";
import { languages, setLanguage, type KiriLanguage } from "../../src/i18n";
import "../../src/styles/design-system.css";

const params = new URLSearchParams(location.search);
params.set("captureToken", "0123456789abcdef0123456789abcdef");
history.replaceState(null, "", `?${params}`);
const lang = params.get("lang") as KiriLanguage;
if (languages.includes(lang)) setLanguage(lang);
const scale = Number(params.get("scale")) || 2;
const width = innerWidth, height = innerHeight;
const source = document.createElement("canvas");
source.width = Math.round(width * scale); source.height = Math.round(height * scale);
const ctx = source.getContext("2d")!;
for (const [x, y, color] of [[0, 0, "#000302"], [1, 0, "#FA80FF"], [0, 1, "#FFFFFF"], [1, 1, "#2567AB"]] as const) {
  ctx.fillStyle = color;
  ctx.fillRect(x * source.width / 2, y * source.height / 2, source.width / 2, source.height / 2);
}
ctx.fillStyle = "#102030"; ctx.fillRect(200, 200, 1, 1);
const png = await new Promise<Blob>(resolve => source.toBlob(blob => resolve(blob!)));
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => String(input).startsWith("kiri:")
  ? Promise.resolve(new Response(png)) : realFetch(input, init);

const actions: { command: string; hex?: string }[] = [];
Object.assign(window, { __colorQa: { actions, pixelWidth: source.width, pixelHeight: source.height } });
mockWindows("overlay");
mockConvertFileSrc("macos");
mockIPC((command, payload) => {
  switch (command) {
    case "start_capture": return { displayWidth: width, displayHeight: height, scale,
      pixelWidth: source.width, pixelHeight: source.height, sourceApplication: "Color QA",
      windowRects: [{ x: 40, y: 150, width: Math.min(500, width - 80), height: Math.min(320, height - 180) }] };
    case "get_recording_options": return DEFAULT_RECORDING_OPTIONS;
    case "mic_supported": return true;
    case "platform_capabilities": return { recording: true, localOcr: true, microphone: true, systemAudio: true };
    case "get_annotation_appearance": return DEFAULT_APPEARANCE;
    case "set_annotation_appearance": return { ...DEFAULT_APPEARANCE, ...((payload as { appearance: object }).appearance) };
    case "copy_capture_color": {
      const hex = (payload as { hex: string }).hex;
      actions.push({ command, hex });
      if (params.has("failCopy")) throw new Error("Isolated clipboard failure");
      return;
    }
    case "prepare_capture_annotation": return "qa-token";
    case "confirm_capture": case "cancel_capture": case "start_recording_flow":
      actions.push({ command }); return;
    case "log_frontend_error": console.error(payload); return;
    default: throw new Error(`Unsupported QA command: ${command}`);
  }
}, { shouldMockEvents: true });
createRoot(document.getElementById("root")!).render(<OverlayWindow />);
