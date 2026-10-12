// Isolated real-component layout check. No native commands or user assets.
import React from "react";
import { createRoot } from "react-dom/client";
import { LibraryWindow } from "../../src/windows/LibraryWindow";
import { setLanguage, type KiriLanguage } from "../../src/i18n";
import "../../src/styles/design-system.css";

const actions: string[] = [];
const callbacks = new Map<number, (event: unknown) => void>();
const eventHandlers = new Map<string, number>();
let nextCallback = 0;
const params = new URLSearchParams(location.search);
const savingJobs = params.has("saving") ? [
  { id: "saving-video", kind: "video", createdAt: new Date().toISOString(), duration: 125, pixelWidth: 1920, pixelHeight: 1080 },
  { id: "saving-gif", kind: "gif", createdAt: new Date().toISOString(), duration: 8, pixelWidth: 720, pixelHeight: 405 },
] : [];
const workspace = params.has("workspace");
const examples = [
  { kind: "image", fileSize: 12500, title: "Screenshot with a long title for layout checking" },
  { kind: "video", fileSize: 1500000000, title: "Recording" },
  { kind: "gif", fileSize: 2340000, title: "GIF" },
  { kind: "image", fileSize: null, title: "Missing file size" },
];
const assets: unknown[] = workspace || params.has("sizes") || params.has("scroll") ? Array.from({length:params.has("scroll")?60:workspace?8:examples.length},(_,index) => ({
  id: `size-${index}`, createdAt: Date.now(), filename: `fixture-${index}.png`,
  ocrText: null, ocrOriginalText: null, qrText: null, tags: [],
  pixelWidth: 3840, pixelHeight: 2160, duration: null, sourceApplication: null,
  trashedAt: null, gifEligible: false, ...examples[index % examples.length],
  isFavorite: index % 3 === 0,
  ...(workspace ? {kind:"image",title:["Capture toolbar", "Keyboard shortcuts", "Local workflow", "Window selection"][index % 4],tags:["Kiri"],pixelWidth:1440,pixelHeight:900} : {}),
})) : [];
const recordBase = { kind:"image", filename:"fixture.png", pixelWidth:640, pixelHeight:360, duration:null, sourceApplication:null, isFavorite:false, trashedAt:null, gifEligible:false, tags:[], fileSize:12000, ocrOriginalText:null };
const textRecords: {id:string;createdAt:number;ocrText:string;ocrOriginalText:string|null;[key:string]:unknown}[] = workspace ? [
  { ...recordBase, id:"text-1", createdAt:Date.parse("2026-10-12T09:30:00Z"), ocrText:"Kiri\nCapture, annotate, and keep everything local.\n\nSelect a window or drag a region. Add notes, copy the image, or pin it on your screen.\n\nScreenshot · Recording · Text recognition", qrText:null },
  { ...recordBase, id:"text-2", createdAt:Date.parse("2026-10-11T09:30:00Z"), ocrText:"Keyboard shortcuts\nShift + Command + A: Capture\nReturn: Confirm\nEscape: Cancel", qrText:null },
  { ...recordBase, id:"text-3", createdAt:Date.parse("2026-10-10T09:30:00Z"), ocrText:"截图与录屏保存在本机。\n文字可编辑、复制，随时回来查看。", qrText:null },
] : [];
const qrRecords = workspace ? [
  { ...recordBase, id:"qr-1", createdAt:Date.parse("2026-10-12T09:30:00Z"), ocrText:null, qrText:"https://example.com/" },
  { ...recordBase, id:"qr-2", createdAt:Date.parse("2026-10-11T09:30:00Z"), ocrText:null, qrText:"A plain text QR example" },
] : [];
const svgPreview = (id:string) => {
  const index = Number(id.split("-").pop()) || 0;
  const titles = ["Capture toolbar", "Keyboard shortcuts", "Local workflow", "Window selection"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#fff"/><rect width="640" height="38" fill="#eee"/><circle cx="20" cy="19" r="5" fill="#aaa"/><circle cx="38" cy="19" r="5" fill="#bbb"/><circle cx="56" cy="19" r="5" fill="#ccc"/><text x="40" y="99" font-family="sans-serif" font-size="28" fill="#111">${titles[index % 4]}</text><text x="40" y="130" font-family="sans-serif" font-size="14" fill="#777">Kiri · Public layout fixture</text><rect x="40" y="166" width="560" height="130" rx="6" fill="#f4f4f2"/><rect x="62" y="190" width="290" height="10" fill="#ccc"/><rect x="62" y="215" width="450" height="8" fill="#ddd"/><rect x="62" y="239" width="390" height="8" fill="#ddd"/></svg>`;
  // Keep resource cache queries outside the SVG payload in this isolated fixture.
  return `data:image/svg+xml,${encodeURIComponent(svg)}#fixture`;
};
const emit = (event: string, payload: unknown) => {
  const id = eventHandlers.get(event);
  if (id != null) callbacks.get(id)?.({ event, id, payload });
};
Object.assign(window, {
  __qaActions: actions,
  __qaGifState: (job: unknown) => emit("gif-conversion-state", job),
  __qaCompleteSave: () => {
    const job = savingJobs.shift();
    if (!job) return;
    assets.push({ id: job.id, kind: job.kind, createdAt: Date.now(),
      filename: "qa.mp4", title: "Public QA recording", ocrText: null,
      ocrOriginalText: null, qrText: null, tags: [], pixelWidth: job.pixelWidth,
      pixelHeight: job.pixelHeight, duration: job.duration, sourceApplication: null,
      isFavorite: false, trashedAt: null, gifEligible: false });
    emit("recording-save-jobs", [...savingJobs]);
    emit("library-changed", null);
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "library" }, currentWebview: { label: "library" } },
    transformCallback: (callback: (event: unknown) => void) => {
      const id = ++nextCallback; callbacks.set(id, callback); return id;
    },
    unregisterCallback: (id: number) => { callbacks.delete(id); },
    convertFileSrc: (path:string) => workspace && !path.includes("qr-") ? svgPreview(path.split("/").pop() ?? "") : "/src-tauri/tests/fixtures/qr/url.png",
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "plugin:event|listen") {
        eventHandlers.set(args.event as string, args.handler as number); return args.handler;
      }
      if (command.startsWith("plugin:event|")) return 1;
      switch (command) {
        case "get_library_status": return { availability: "ready", isDefault: true, locationLabel: "Test Library" };
        case "get_shortcut_status": return { status: "enabled", label: "⇧⌘A" };
        case "get_dock_visibility": return {supported:true,visible:true};
        case "platform_capabilities": return {manualUpdates:false,videoEditing:true};
        case "plugin:app|version": return "1.6.17";
        case "plugin:window|is_visible": return true;
        case "plugin:updater|check":
          actions.push("check-update");
          if (params.has("updateFailure")) throw new Error("Controlled offline update check");
          return params.has("update") ? {rid:7,currentVersion:"1.6.17",version:"9.9.9",body:"Public update fixture — no package is downloaded.",rawJson:{}} : null;
        case "plugin:resources|close": return null;
        case "set_capture_shortcut_editing": return null;
        case "set_capture_shortcut": return {status:"enabled",label:"⇧⌘A"};
        case "set_language":
          actions.push(`set-language:${args.language}`);
          if (params.has("languageFailure")) throw new Error("Controlled language save failure");
          return null;
        case "set_dock_visibility": return null;
        case "get_ocr_provider_settings":
          if(params.has("settingsFailure")) throw new Error("Controlled OCR settings load failure");
          return {schemaVersion:1,activeEngine:{kind:"local"},profiles:params.has("profiles") ? [{id:"public-ocr",revision:1,name:"PublicLayoutProfileWithALongNameForWrappingChecks",provider:"customOpenAi",protocol:"openAiChat",baseUrl:"https://example.org/v1",model:"public-model",hasApiKey:false}] : [],warning:null};
        case "get_gif_conversion_states": return [];
        case "cancel_gif_conversion": actions.push(command); return true;
        case "get_recording_save_jobs": return [...savingJobs];
        case "list_assets": return [...assets].filter((asset:any) => !workspace || asset.title.toLowerCase().includes(String(args.query ?? "").toLowerCase()));
        case "list_ocr_records": return textRecords.filter(asset => asset.ocrText.toLowerCase().includes(String(args.query ?? "").toLowerCase()));
        case "list_qr_favorites": return qrRecords.filter(asset => asset.qrText.toLowerCase().includes(String(args.query ?? "").toLowerCase()));
        case "copy_history_text": case "qr_favorite_action": case "reveal_library": actions.push(command); return null;
        case "update_ocr_history_text": {
          const asset = textRecords.find(asset => asset.id === args.id)!;
          const original = asset.ocrOriginalText ?? asset.ocrText;
          asset.ocrOriginalText = args.replacement == null ? null : original;
          asset.ocrText = String(args.replacement ?? original);
          return {...asset};
        }
        case "get_asset_availability": return { status: "ready" };
        case "copy_asset": actions.push(command); return null;
        case "list_pending_recordings": case "list_text_history": return [];
        case "import_media": actions.push(command); return { ids: [], failed: 0 };
        case "paste_clipboard_image":
          actions.push(command);
          if(params.has("failure")) throw new Error("Test clipboard failure");
          return { id: "fixture" };
        default: throw new Error(`Unexpected harness command: ${command}`);
      }
    },
  },
});
const language = params.get("language") ?? "en";
setLanguage((["en", "zh-Hans", "zh-Hant", "ja", "de", "ko", "fr"].includes(language) ? language : "en") as KiriLanguage);
createRoot(document.getElementById("root")!).render(<LibraryWindow />);
