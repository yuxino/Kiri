// Isolated real-component layout check. No native commands or user assets.
import React from "react";
import { version } from "../../package.json";
import { createRoot } from "react-dom/client";
import { ToastWindow } from "../../src/windows/ToastWindow";
import { PinWindow } from "../../src/windows/PinWindow";
import { LibraryWindow } from "../../src/windows/LibraryWindow";
import type { AssetTagEdit } from "../../src/lib/ipc";
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
const tagCount = Number(params.get("tagCount") ?? 0);
const fixtureTags = Array.from({ length: tagCount }, (_, index) =>
  index === 0 ? "01 · VeryLongCaptureCategoryForTestingEinAusführlicherNameБезПробелов" : `Tag ${index + 1}`);
const tagFixture = params.has("tags");
let resolveLateUpdate: (() => void) | undefined;
const lateUpdate = params.has("lateUpdate") ? new Promise<void>(resolve => { resolveLateUpdate = resolve; }) : null;
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
  ...(workspace ? {kind:"image",title:["Capture toolbar", "Keyboard shortcuts", "Local workflow", "Window selection"][index % 4],tags:params.has("tagCount") ? fixtureTags.filter((_, tagIndex) => tagIndex % 8 === index) : tagFixture ? [["Project", "Keep"], ["Keep"], [], ["Other"]][index % 4] : ["Kiri"],pixelWidth:1440,pixelHeight:900} : {}),
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
  __qaTagFailure: params.has("tagFailure"),
  __qaResolveUpdate: () => resolveLateUpdate?.(),
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
        case "get_startup_settings": return {supported:true,enabled:false,requiresApproval:false};
        case "platform_capabilities": return {manualUpdates:false,videoEditing:true};
        case "plugin:app|version": return version;
        case "plugin:window|is_visible": return true;
        case "plugin:updater|check":
          actions.push("check-update");
          if (params.has("updateFailure")) throw new Error("Controlled offline update check");
          if (lateUpdate) await lateUpdate;
          return params.has("update") ? {rid:7,currentVersion:version,version:params.get("updateVersion") ?? "9.9.9",body:params.get("updateNotes") ?? "Public update fixture — no package is downloaded.",rawJson:{}} : null;
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
        case "save_ocr_provider_profile":
          actions.push(command);
          return new Promise((_resolve, reject) => Object.assign(window, {
            __qaRejectOcrSave: () => reject(new Error("Controlled OCR profile save failure")),
          }));
        case "get_gif_conversion_states": return [];
        case "cancel_gif_conversion": actions.push(command); return true;
        case "get_recording_save_jobs": return [...savingJobs];
        case "list_assets": {
          const query = String(args.query ?? "").toLowerCase();
          return structuredClone(assets.filter((asset: any) =>
            !workspace || [asset.title, ...asset.tags].some(text => text.toLowerCase().includes(query))));
        }
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
        case "batch_move_to_trash": {
          actions.push(`${command}:${JSON.stringify(args.ids)}`);
          if (params.has("batchFailure")) throw new Error("Controlled batch failure");
          const ids = args.ids as string[];
          for (const records of [textRecords, qrRecords]) {
            for (let index = records.length - 1; index >= 0; index--) {
              if (ids.includes(records[index].id)) records.splice(index, 1);
            }
          }
          emit("library-changed", null);
          return null;
        }
        case "empty_trash":
          actions.push(command);
          if (params.has("trashFailure")) throw new Error("Controlled trash deletion failure");
          if (params.has("trashPending")) await new Promise<void>(resolve => Object.assign(window, { __qaResolveTrash: resolve }));
          assets.splice(0);
          emit("library-changed", null);
          return null;
        case "get_asset_availability": return { status: "ready" };
        case "open_library": actions.push(command); return null;
        case "plugin:window|set_size": case "plugin:window|set_ignore_cursor_events": return null;
        case "copy_support_info":
          actions.push(command);
          if (params.has("copyFailure")) throw new Error("Test clipboard unavailable");
          return null;
        case "copy_asset": case "open_editor": case "open_viewer": actions.push(command); return null;
        case "edit_asset_tag": {
          actions.push(command);
          if ((window as unknown as {__qaTagFailure: boolean}).__qaTagFailure) throw new Error("Controlled tag save failure");
          const asset = assets.find((item: any) => item.id === args.id) as {tags: string[]} | undefined;
          if (!asset) throw new Error("Unknown fixture asset");
          const edit = args.edit as AssetTagEdit;
          const key = (tag: string) => tag.replace(/[A-Z]/g, char => char.toLowerCase());
          if (edit.kind === "rename") {
            if (!asset.tags.includes(edit.from)) throw "This tag has changed.";
            if (asset.tags.some(tag => tag !== edit.from && key(tag) === key(edit.to))) throw "This tag already exists.";
            asset.tags = asset.tags.map(tag => tag === edit.from ? edit.to : tag);
          } else if (edit.kind === "remove") {
            asset.tags = asset.tags.filter(tag => tag !== edit.tag);
          } else if (!asset.tags.some(tag => key(tag) === key(edit.tag))) {
            asset.tags = [...asset.tags, edit.tag];
          }
          emit("library-changed", null);
          return [...asset.tags];
        }
        case "edit_asset_tags": {
          actions.push(`${command}:${JSON.stringify(args)}`);
          if ((window as unknown as {__qaTagFailure: boolean}).__qaTagFailure) throw new Error("Controlled tag save failure");
          const key = (tag: string) => tag.trim().replace(/[A-Z]/g, letter => letter.toLowerCase());
          const tag = String(args.tag).trim();
          const hasTag = (tags: string[]) => tags.some(existing => key(existing) === key(tag));
          const selected = assets.filter((asset: any) => (args.ids as string[]).includes(asset.id)) as {id: string; tags: string[]}[];
          if (args.action === "addExisting" && !assets.some((asset: any) => hasTag(asset.tags))) {
            throw "This tag no longer exists.";
          }
          for (const asset of selected) {
            if (args.action === "remove") asset.tags = asset.tags.filter(existing => key(existing) !== key(tag));
            else if (!hasTag(asset.tags)) asset.tags = [...asset.tags, tag];
          }
          emit("library-changed", null);
          return selected.map(({id, tags}) => ({id, tags}));
        }
        case "export_selected_assets": {
          actions.push(`${command}:${JSON.stringify(args.ids)}`);
          return { exported: (args.ids as string[]).length, failed: [] };
        }
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
setLanguage((["en", "zh-Hans", "zh-Hant", "ja", "de", "ko", "fr", "ru"].includes(language) ? language : "en") as KiriLanguage);
createRoot(document.getElementById("root")!).render(params.has("toast") ? <ToastWindow /> : params.has("pin") ? <PinWindow id="pin-fixture" /> : <LibraryWindow />);
