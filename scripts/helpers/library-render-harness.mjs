import { readFileSync } from "node:fs";
import ts from "typescript";
import * as qrSelection from "../../src/qr/selection.js";
import * as cardInteraction from "../../src/windows/library-card-interaction.js";
import * as viewerCopyShortcut from "../../src/windows/viewer-copy-shortcut.js";
import * as videoCapabilities from "../../src/windows/video-capabilities.js";

// Exercise the real component handlers without a WebView, native IPC, or a
// user's library. This models hook state/effect cleanup, not DOM or layout.
// Cache compiled source only. Hooks, listeners and mocked IPC stay local to
// each harness, and a fresh test process always reads the current source.
const componentCodeCache = new Map();
let librarySource;
function componentCode(source) {
  if (!componentCodeCache.has(source)) {
    componentCodeCache.set(source, ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2021,
        jsx: ts.JsxEmit.React,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText);
  }
  return componentCodeCache.get(source);
}

let gifModule;
function gifConversion() {
  if (!gifModule) {
    gifModule = { exports: {} };
    new Function("require", "module", "exports", ts.transpileModule(
      readFileSync(new URL("../../src/windows/gif-conversion.ts", import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS } },
    ).outputText)(() => ({ t: (key) => key, fmt: (key, value) => key.replace("%d", value) }), gifModule, gifModule.exports);
  }
  return gifModule.exports;
}

export const testAsset = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "image",
  title: null,
  filename: "test.png",
  pixelWidth: 20,
  pixelHeight: 20,
  createdAt: 0,
  tags: [],
  isFavorite: false,
  gifEligible: false,
  duration: null,
};

export function createLibraryHarness(apiOverrides = {}, componentSource = null, environment = {}) {
  let active;
  const listeners = new Map();
  const events = new Map();
  const sameDeps = (left, right) => left && right && left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const React = {
    lazy: () => () => null,
    forwardRef: (render) => (props) => render(props, props.ref),
    createElement(type, props, ...children) {
      const node = { type, props: { ...props, children } };
      environment.attachRef?.(node);
      return node;
    },
    useState(initial) {
      const owner = active;
      const index = owner.cursor++;
      const hook = owner.hooks[index] ??= {
        value: typeof initial === "function" ? initial() : initial,
      };
      return [hook.value, (next) => {
        if (owner.unmounted) return;
        const value = typeof next === "function" ? next(hook.value) : next;
        if (!Object.is(value, hook.value)) owner.dirty = true;
        hook.value = value;
      }];
    },
    useRef(initial) {
      return React.useState(() => ({ current: initial }))[0];
    },
    useMemo(create, deps) {
      const index = active.cursor++;
      if (!sameDeps(active.hooks[index]?.deps, deps)) {
        active.hooks[index] = { value: create(), deps };
      }
      return active.hooks[index].value;
    },
    useCallback(callback, deps) {
      return React.useMemo(() => callback, deps);
    },
    useEffect(create, deps) {
      const owner = active;
      const index = owner.cursor++;
      if (sameDeps(owner.hooks[index]?.deps, deps)) return;
      owner.effects.push(() => {
        owner.hooks[index]?.cleanup?.();
        owner.hooks[index] = { deps, cleanup: create(), effectCreate: create };
      });
    },
    useLayoutEffect(create, deps) {
      React.useEffect(create, deps);
    },
    useImperativeHandle(ref, create, deps) {
      React.useEffect(() => {
        if (ref) ref.current = create();
        return () => { if (ref) ref.current = null; };
      }, deps);
    },
    useId() {
      return React.useState(() => `test-id-${active.cursor}`)[0];
    },
  };
  const window = {
    location: { search: environment.search ?? "" },
    getSelection: () => null,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatchEvent(event) { listeners.get(event.type)?.forEach((callback) => callback(event)); },
  };
  const subscribe = (name) => (callback) => {
    events.set(name, callback);
    return Promise.resolve(() => events.delete(name));
  };
  const modules = {
    react: React,
    "@tauri-apps/api/webview": {getCurrentWebview:()=>({onDragDropEvent:subscribe("mediaDrop")})},
    "lucide-react": {ImagePlus:"icon", QrCode:"icon", Copy:"icon", ExternalLink:"icon", Star:"icon", X:"icon", Trash2:"icon", ChevronRight:"icon"},
    "./text-history.css": {},
    "../ocr/text-history.css": {},
    "./qr.css": {},
    "./selection.js": qrSelection,
    "../qr/QrResults": { QrFavorites: "qr-favorites" },
    "../ocr/TextHistory": { TextHistory: "text-history", OcrDialog: "ocr-dialog" },
    "react-dom": { createPortal: (child) => child },
    "../lib/ipc": {
      api: {
        qrAction: async () => null,
        getAssetAvailability: async () => ({ status: "ready" }),
        getGifConversionStates: async () => [],
        getLibraryStatus: async () => ({ availability: "ready" }),
        listAssets: async () => [testAsset],
        listPendingRecordings: async () => [],
        getRecordingSaveJobs: async () => [],
        getDockVisibility: async () => ({ supported: true, visible: true }),
        getShortcutStatus: async () => ({ status: "enabled", label: "shortcut" }),
        ...apiOverrides,
      },
      mediaUrl: (id) => `media:${id}`,
      onLibraryChanged: subscribe("libraryChanged"),
      onAssetContentChanged: subscribe("assetContentChanged"),
      onGifConversionState: subscribe("gifConversionState"),
      onRecordingSaveJobs: subscribe("recordingSaveJobs"),
      onNotice: subscribe("notice"),
      onError: subscribe("error"),
    },
    "../i18n": { t: (value) => value, fmt: (value) => value },
    "../../src-tauri/icons/128x128.png": "",
    "../components/KiriIcons": { KiriIcon: "icon" },
    "../lib/kiri-resource-url.js": {
      kiriResourceUrl: (route, [id], { v }) => `${route}:${id}?v=${v}`,
    },
    "./library-card-interaction.js": cardInteraction,
    get "./gif-conversion"() { return gifConversion(); },
    "./viewer-copy-shortcut.js": viewerCopyShortcut,
    "./video-capabilities.js": videoCapabilities,
    ...environment.modules,
  };
  const module = { exports: {} };
  if (componentSource == null) {
    librarySource ??= readFileSync(new URL("../../src/windows/LibraryWindow.tsx", import.meta.url), "utf8") +
      "\nexport { AssetCard, RecordingSaveCard };";
    componentSource = librarySource;
  }
  const globals = environment.globals ?? {};
  new Function("require", "module", "exports", "window", "document", "requestAnimationFrame", "cancelAnimationFrame", "navigator", ...Object.keys(globals), componentCode(componentSource))((name) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, module, module.exports, window, { ...window, body: null, querySelector: () => null, ...environment.document }, () => 1, () => {}, environment.navigator ?? { userAgent: "Macintosh" }, ...Object.values(globals));

  return {
    window,
    emit: (name, payload) => events.get(name)?.(payload),
    mount(name, initialProps) {
      const owner = { hooks: [], cursor: 0, effects: [], dirty: false, unmounted: false };
      let props = initialProps;
      return {
        render(nextProps = props) {
          props = nextProps;
          for (let pass = 0; pass < 30; pass++) {
            active = owner;
            owner.cursor = 0;
            owner.dirty = false;
            const tree = module.exports[name](props);
            const effects = owner.effects.splice(0);
            effects.forEach((effect) => effect());
            if (environment.strictEffects && !owner.replayedEffects) {
              owner.replayedEffects = true;
              owner.hooks.forEach(hook => hook?.effectCreate && hook.cleanup?.());
              owner.hooks.forEach(hook => { if (hook?.effectCreate) hook.cleanup = hook.effectCreate(); });
            }
            if (!owner.dirty) return tree;
          }
          throw new Error("Component did not settle");
        },
        unmount() {
          owner.unmounted = true;
          owner.hooks.forEach((hook) => hook?.cleanup?.());
        },
      };
    },
  };
}

export function nodes(root) {
  if (root == null || typeof root === "boolean") return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (typeof root !== "object") return [root];
  return [root, ...nodes(root.props?.children)];
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

export async function settleRequests() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}
