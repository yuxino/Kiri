import { readFileSync } from "node:fs";
import ts from "typescript";
import { createLibraryHarness, nodes } from "./library-render-harness.mjs";
import * as capabilities from "../../src/windows/video-capabilities.js";
import * as trim from "../../src/windows/video-trim.js";
import * as projectSave from "../../src/windows/video-project-save.js";
import * as shortcuts from "../../src/windows/video-project-shortcuts.js";
import * as composition from "../../src/annotation/text-composition.js";

async function pureModule(name) {
  const source = readFileSync(new URL(`../../src/windows/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}
const effects = await pureModule("video-effects");
const layers = await pureModule("video-layers");
const project = await pureModule("video-project");
const source = 'import React from "react";\n' + readFileSync(new URL("../../src/windows/VideoTrimPlayer.tsx", import.meta.url), "utf8");

/** Render real editor handlers while replacing only native/DOM/media boundaries. */
export function createVideoPlayerHarness(caps, configuration = {}) {
  let options;
  const player = { duration: 10, currentTime: 0, videoWidth: 1920, videoHeight: 1080, readyState: 1,
    pause() {}, addEventListener() {}, removeEventListener() {} };
  const harness = createLibraryHarness(configuration.api ?? {}, source, {
    attachRef(node) { if (node.type === "video") node.props.ref.current = player; },
    modules: {
      "@tauri-apps/api/window": { getCurrentWindow: () => ({ isMaximized: async () => true }) },
      "lucide-react": {},
      "./video-trim.js": trim,
      "./video-capabilities.js": capabilities,
      "./useVideoThumbnails": { useVideoThumbnails: () => ({ frames: [], failed: false }) },
      "./VideoEffects": { VideoEffectsControls: "effects-controls", VideoEffectsOverlay: "effects-overlay" },
      "./video-effects": effects,
      "./video-effect-render": {},
      "./video-layers": layers,
      "./video-trim.css": {},
      "./VideoOutputEffectTracks": { VideoOutputEffectTracks: "effect-tracks" },
      "../components/ChoiceSelect": { ChoiceSelect: "choice-select" },
      "./VideoPlaybackControls": { VideoPlaybackControls: "playback-controls" },
      "../lib/kiri-resource-url.js": { videoResourceCrossOrigin: () => undefined },
      "./VideoTimeInput": { VideoTimeInput: "time-input" },
      "./VideoExportPanel": { VideoExportPanel: "export-panel" },
      "./VideoVisibleTime": { VideoVisibleTime: "visible-time" },
      "./useVideoProject": { useVideoProject: value => {
        options = value;
        return { ready: true, state: { status: "idle", error: null }, schedule() {}, flush: async () => true, retry() {} };
      } },
      "./video-project-save.js": projectSave,
      "./video-project": project,
      "./video-project-shortcuts.js": shortcuts,
      "./VideoProjectStatus.css": {},
      "./video-stickers": {},
      "../annotation/model": {},
      "../annotation/text-composition.js": composition,
      "../annotation/geom": {},
      "./VideoAnnotationsEditor": { VideoAnnotationsEditor: "annotations-editor" },
      "./video-annotation-render": {},
      ...configuration.modules,
    },
  });
  const component = harness.mount("VideoTrimPlayer", { id: "video", src: "media:video", editable: caps.videoEditing, capabilities: caps, onClosePreparationChange: configuration.onClosePreparationChange ?? (() => {}), onClose() {}, onError() {} });
  const initial = component.render();
  nodes(initial).find(node => node?.type === "video").props.onLoadedMetadata({ currentTarget: player });
  component.render();
  return {
    ...component,
    window: harness.window,
    projectOptions: () => options,
    openEditor() {
      const button = nodes(component.render()).find(node => node?.type === "button" && nodes(node).includes("Trim & Export"));
      button.props.onClick();
      return component.render();
    },
  };
}
