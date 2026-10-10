import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createLibraryHarness, nodes, settleRequests, deferred, testAsset } from "./helpers/library-render-harness.mjs";
import { capturePanelLayout, captureToolbarPosition } from "../src/windows/toolbar-layout.js";
import { initialQrSelection, qrCodeCenter, qrContentType, qrLooksLikeLink } from "../src/qr/selection.js";

const source = 'import React from "react";\n' + readFileSync(new URL("../src/qr/QrResults.tsx", import.meta.url), "utf8");
const code = (index, text = "https://example.org/kiri-safe") => ({ index, text, url: text.startsWith("https:") ? text : null, host: "example.org", suspicious: false, corners: [[.1,.1],[.4,.1],[.4,.4],[.1,.4]] });
const scan = codes => ({ requestId: "test-request", width: 1000, height: 500, imageUrl: "data:image/png;base64,test", codes });
const has = (tree, text) => nodes(tree).includes(text);
const button = (tree, text) => nodes(tree).find(n => n?.type === "button" && has(n, text));

test("library QR entry opens the original image editor instead of a second image dialog", async () => {
  const calls = [];
  const harness = createLibraryHarness({ openEditor: async (...args) => calls.push(args) });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  nodes(library.render()).find(node => node?.type?.name === "AssetCard").props.onMenu(10, 10);
  const card = nodes(library.render()).find(node => node?.type?.name === "AssetCard");
  const recognize = nodes(card.props.menu).find(node => node?.props?.label === "Recognize QR Codes");
  assert.ok(recognize);
  recognize.props.onClick(); await settleRequests();
  assert.deepEqual(calls, [[testAsset.id, true]]);
  assert.equal(nodes(library.render()).some(node => node?.type === "qr-dialog"), false);
  library.unmount();
});

test("editor QR IPC preserves source revision and exposes the editor request event", async () => {
  const invokes = [], listens = [];
  const ipc = ts.transpileModule(readFileSync(new URL("../src/lib/ipc.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ipc)(name => {
    if (name === "@tauri-apps/api/core") return { invoke: async (...args) => invokes.push(args) };
    if (name === "@tauri-apps/api/event") return { listen: async (...args) => listens.push(args) };
    if (name === "./kiri-resource-url.js") return { kiriResourceUrl() {} };
    throw new Error(`Unexpected IPC import: ${name}`);
  }, module, module.exports);
  await module.exports.api.openEditor(testAsset.id, true);
  await module.exports.api.scanQr("request", null, testAsset.id, "a".repeat(64));
  await module.exports.api.takeEditorQrRequest();
  const handler = () => {};
  await module.exports.onEditorRecognizeQr(handler);
  assert.deepEqual(invokes, [
    ["open_editor", { id: testAsset.id, recognizeQr: true }],
    ["scan_qr", { requestId: "request", selection: null, assetId: testAsset.id, expectedRevisionSha256: "a".repeat(64) }],
    ["take_editor_qr_request"],
  ]);
  assert.deepEqual(listens, [["editor-recognize-qr", handler]]);
});

test("screenshot toolbar recognition is explicit and does not complete the capture", () => {
  const overlay = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");
  const toolbar = overlay.slice(overlay.indexOf("const TOOLS:"));
  const harness = createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
    import {t} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
    const captureToolbarPosition=${captureToolbarPosition.toString()}, capturePanelLayout=${capturePanelLayout.toString()}; ${toolbar}`);
  let scans = 0, captures = 0;
  const component = harness.mount("Toolbar", { selection:{x:100,y:100,width:140,height:160},bounds:{x:0,y:0,width:1000,height:700},
    tool:"select",appearance:{},canUndo:false,canRedo:false,canSetSize:false,disabled:false,
    onQr:()=>scans++,onDone:()=>captures++ });
  const target = nodes(component.render()).find(n => n?.props?.title === "Recognize QR Codes");
  assert.ok(target);
  assert.equal(scans, 0);
  target.props.onClick();
  assert.equal(scans, 1);
  assert.equal(captures, 0);
  component.unmount();
});

test("region selection and initial mode choice do not trigger QR recognition", () => {
  const overlay = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");
  const selection = overlay.slice(overlay.indexOf("function afterSelection"), overlay.indexOf("// --- render ---"));
  assert.doesNotMatch(selection, /runQr/);
  assert.doesNotMatch(overlay, /switchMode\("qr"\)/);
  assert.match(overlay, /phaseRef\.current === "qr-result"\) \{ closeQr\(\); return; \}/);
});

test("single, multiple and empty scans await explicit selection", () => {
  assert.equal(initialQrSelection([code(0)]), null);
  assert.equal(initialQrSelection([code(0), code(1)]), null);
  assert.equal(initialQrSelection([]), null);
  assert.deepEqual(qrCodeCenter(code(0).corners), [.25, .25]);
});

test("single-code center button saves the chosen code without opening or copying", async () => {
  const calls = [];
  const harness = createLibraryHarness({ qrAction: (...args) => calls.push(args) }, source);
  const component = harness.mount("QrResults", { scan: scan([code(0)]) });
  let tree = component.render();
  assert.equal(nodes(tree).find(n => n?.props?.code), undefined);
  assert.equal(nodes(tree).some(n => n?.type === "polygon"), false);
  const marker = nodes(tree).find(n => n?.props?.className === "kiri-qr-marker");
  assert.equal(marker.type, "button");
  assert.deepEqual(marker.props.style, { left: "25%", top: "25%" });
  assert.equal(marker.props["aria-pressed"], false);
  marker.props.onClick();
  tree = component.render();
  assert.equal(nodes(tree).find(n => n?.props?.code).props.code.index, 0);
  assert.equal(nodes(tree).find(n => n?.props?.className === "kiri-qr-marker").props["aria-pressed"], true);
  await settleRequests();
  assert.deepEqual(calls.map(args => args[2]), ["favorite"]);
  component.unmount();
});

test("perspective markers use the diagonal intersection rather than corner average", () => {
  const center = qrCodeCenter([[0, 0], [1, 0], [.6, 1], [.4, 1]]);
  assert.ok(Math.abs(center[0] - .5) < 1e-9);
  assert.ok(Math.abs(center[1] - 5 / 6) < 1e-9);
  assert.deepEqual(qrCodeCenter([[.2, .3], [.2, .3], [.2, .3], [.2, .3]]), [.2, .3]);
});

test("duplicate payloads retain positions and save only after explicit selection", async () => {
  const calls = [];
  const harness = createLibraryHarness({ qrAction: (...args) => { calls.push(args); } }, source);
  const component = harness.mount("QrResults", { scan: scan([code(0), {...code(1), corners:[[.6,.6],[.9,.6],[.9,.9],[.6,.9]]}]) });
  let tree = component.render();
  assert.ok(has(tree, "Choose a QR code in the image"));
  const targets = nodes(tree).filter(n => n?.type === "button" && n.props.className === "kiri-qr-marker");
  assert.equal(targets.length, 2);
  targets[1].props.onClick();
  tree = component.render();
  assert.equal(nodes(tree).find(n => n?.props?.code)?.props.code.index, 1);
  await settleRequests();
  assert.deepEqual(calls.map(args => args[2]), ["favorite"]);
  component.unmount();
});

test("opening invokes the default-browser action once without another confirmation", async () => {
  const calls = [];
  const harness = createLibraryHarness({}, source);
  const component = harness.mount("QrDetails", { code: code(0), action: async a => calls.push(a) });
  const tree = component.render();
  assert.deepEqual(calls, []);
  button(tree, "Open Link").props.onClick();
  await settleRequests();
  assert.deepEqual(calls, ["open"]);
  assert.equal(nodes(component.render()).filter(n => n?.type === "button" && has(n, "Open Link")).length, 1);
  assert.equal(has(component.render(), "Only open links you trust."), false);
  component.unmount();
});

test("result opening closes only after success and failures leave the result available", async () => {
  const pending = deferred(), calls = [], closed = [];
  const harness = createLibraryHarness({qrAction:async (...args)=>{calls.push(args);return pending.promise;}},source);
  const component = harness.mount("QrResults", {scan:scan([code(0)]),onOpened:()=>closed.push(true)});
  nodes(component.render()).find(n=>n?.props?.className==="kiri-qr-marker").props.onClick();
  const action = nodes(component.render()).find(n=>n?.props?.code).props.action;
  const opening = action("open");
  assert.deepEqual(closed, []);
  pending.resolve(null); await opening;
  assert.deepEqual(closed, [true]);
  assert.deepEqual(calls.map(args=>args[2]), ["favorite", "open"]);
  component.unmount();
  const failing = createLibraryHarness({qrAction:async()=>{throw "Could not open this link.";}},source);
  const failed = failing.mount("QrResults", {scan:scan([code(0)]),onOpened:()=>closed.push(false)});
  nodes(failed.render()).find(n=>n?.props?.className==="kiri-qr-marker").props.onClick();
  await assert.rejects(nodes(failed.render()).find(n=>n?.props?.code).props.action("open"));
  assert.deepEqual(closed, [true]);
  assert.equal(nodes(failed.render()).find(n=>n?.props?.code).props.code.index, 0);
  failed.unmount();
});

test("rapid repeated clicks invoke only one open while its request is pending", async () => {
  const pending = deferred(), calls = [];
  const harness = createLibraryHarness({}, source);
  const component = harness.mount("QrDetails", {code:code(0), action:a=>{calls.push(a);return pending.promise;}});
  const target = button(component.render(), "Open Link");
  target.props.onClick(); target.props.onClick();
  assert.deepEqual(calls, ["open"]);
  pending.resolve(null); await settleRequests();
  component.unmount();
});

test("an opening response from a closed result cannot dismiss a newer dialog", async () => {
  const pending=deferred(),closed=[];
  const harness=createLibraryHarness({qrAction:()=>pending.promise},source);
  const component=harness.mount("QrResults",{scan:scan([code(0)]),onOpened:()=>closed.push(true)});
  nodes(component.render()).find(n=>n?.props?.className==="kiri-qr-marker").props.onClick();
  const opening=nodes(component.render()).find(n=>n?.props?.code).props.action("open");
  component.unmount();pending.resolve(null);await opening;
  assert.deepEqual(closed,[]);
});

test("link, plain text and standard WeChat payloads get distinct simple labels", () => {
  assert.equal(qrContentType(code(0)), "Link");
  assert.equal(qrContentType({...code(0,"Kiri QR 测试"),host:null}), "Text");
  for (const host of ["weixin.qq.com", "login.weixin.qq.com", "mp.weixin.qq.com"]) {
    assert.equal(qrContentType({...code(0),host}), "WeChat");
  }
  for (const text of ["weixin://wxpay/bizpayurl?pr=public", "wxp://public-fixture"]) {
    const value={...code(0,text),host:null};
    assert.equal(qrContentType(value), "WeChat");
    const component=createLibraryHarness({},source).mount("QrDetails",{code:value,action:async()=>{}});
    assert.equal(button(component.render(),"Open Link"),undefined);
    component.unmount();
  }
  assert.equal(qrContentType({...code(0),host:"weixin.qq.com.example.org"}), "Link");
});

test("plain colon content stays copyable without link warnings in results and favorites", async () => {
  for (const text of ["兔子二维码 https://tuzim.net", "Note: https://example.org", "Time: 12:30"]) {
    assert.equal(qrLooksLikeLink(text), false);
    // Even an older DTO with the former colon flag should render as text.
    const value = {...code(0, text), host:null, url:null, suspicious:true};
    const detail = createLibraryHarness({}, source).mount("QrDetails", {code:value, action:async()=>{}});
    assert.equal(button(detail.render(), "Open Link"), undefined);
    assert.ok(button(detail.render(), "Copy Text"));
    assert.equal(has(detail.render(), "Review this content carefully. This link may be unsafe."), false);
    assert.equal(has(detail.render(), "Only explicit HTTP or HTTPS links without credentials can be opened."), false);
    detail.unmount();
    const favorite = createLibraryHarness({listQrFavorites:async()=>[{...testAsset, qrText:text}]}, source).mount("QrFavorites");
    favorite.render(); await new Promise(resolve=>setTimeout(resolve,5)); await settleRequests();
    const saved = nodes(favorite.render()).find(node=>node?.props?.code).props.code;
    assert.equal(saved.suspicious, false);
    assert.equal(saved.url, null);
    favorite.unmount();
  }
});

test("explicit unsupported links retain warnings while WeChat schemes and RTL use their own content treatment", () => {
  for (const text of ["https://user:password@example.org", "https://", "javascript:alert(1)", "file:///tmp/test", "ftp://example.org"]) {
    assert.equal(qrLooksLikeLink(text), true);
    const detail = createLibraryHarness({}, source).mount("QrDetails", {code:{...code(0,text),host:null,url:null,suspicious:true},action:async()=>{}});
    assert.equal(button(detail.render(),"Open Link"),undefined);
    assert.ok(has(detail.render(),"Only explicit HTTP or HTTPS links without credentials can be opened."));
    detail.unmount();
  }
  for (const text of ["weixin://wxpay/bizpayurl?pr=public", "wxp://public-fixture"]) {
    const detail = createLibraryHarness({}, source).mount("QrDetails", {code:{...code(0,text),host:null,url:null,suspicious:true},action:async()=>{}});
    assert.ok(has(detail.render(),"WeChat"));
    assert.equal(nodes(detail.render()).some(node=>node?.props?.className==="qr-warning"),false);
    detail.unmount();
  }
  const detail = createLibraryHarness({}, source).mount("QrDetails", {code:{...code(0,"text\u202ereordered"),host:null,url:null,suspicious:true},action:async()=>{}});
  assert.ok(has(detail.render(),"Review this content carefully."));
  assert.equal(has(detail.render(),"Only explicit HTTP or HTTPS links without credentials can be opened."),false);
  detail.unmount();
});

test("saving a repeated payload retains its favorite state when selecting another copy", async () => {
  const calls = [];
  const harness = createLibraryHarness({ qrAction: async (...args) => { calls.push(args); } }, source);
  const component = harness.mount("QrResults", { scan: scan([code(0), code(1)]) });
  nodes(component.render()).filter(n => n?.type === "button" && n.props.className === "kiri-qr-marker")[0].props.onClick();
  await settleRequests();
  nodes(component.render()).filter(n => n?.type === "button" && n.props.className === "kiri-qr-marker")[1].props.onClick();
  const detail = nodes(component.render()).find(n => n?.props?.code);
  assert.equal(detail.props.code.index, 1);
  assert.equal(detail.props.saved, true);
  await detail.props.action("unfavorite");
  assert.equal(nodes(component.render()).find(n => n?.props?.code).props.saved, false);
  assert.deepEqual(calls.map(c => c[2]), ["favorite", "unfavorite"]);
  component.unmount();
});

test("opening waits for every chosen code to finish saving and locks further selection", async () => {
  const first=deferred(),second=deferred(),calls=[];
  const harness=createLibraryHarness({qrAction:async(_id,index,action)=>{
    calls.push([index,action]);
    if(action==="favorite")return index===0?first.promise:second.promise;
    return null;
  }},source);
  const component=harness.mount("QrResults",{scan:scan([code(0),code(1,"Kiri QR test")])});
  const markers=()=>nodes(component.render()).filter(n=>n?.props?.className==="kiri-qr-marker");
  markers()[0].props.onClick();markers()[1].props.onClick();markers()[0].props.onClick();
  const opening=nodes(component.render()).find(n=>n?.props?.code).props.action("open");
  await settleRequests();
  assert.deepEqual(calls,[[0,"favorite"],[1,"favorite"]]);
  assert.ok(markers().every(n=>n.props.disabled));
  first.resolve(null);await settleRequests();
  assert.deepEqual(calls,[[0,"favorite"],[1,"favorite"]]);
  second.resolve(null);await opening;
  assert.deepEqual(calls,[[0,"favorite"],[1,"favorite"],[0,"open"]]);
  component.unmount();
});

test("failed automatic saving leaves content readable and manual saving can retry", async () => {
  let attempts=0;
  const harness=createLibraryHarness({qrAction:async()=>{if(++attempts===1)throw "Could not save this QR code.";return null;}},source);
  const component=harness.mount("QrResults",{scan:scan([code(0)])});
  nodes(component.render()).find(n=>n?.props?.className==="kiri-qr-marker").props.onClick();
  await settleRequests();
  let detail=nodes(component.render()).find(n=>n?.props?.code);
  assert.equal(detail.props.autoSaveError,"Could not save this QR code.");
  assert.equal(detail.props.autoSaving,false);
  assert.equal(detail.props.saved,false);
  await detail.props.action("favorite");
  detail=nodes(component.render()).find(n=>n?.props?.code);
  assert.equal(detail.props.autoSaveError,null);
  assert.equal(detail.props.saved,true);
  component.unmount();
});

test("damaged and unsafe codes cannot open; content can be copied and saved explicitly", async () => {
  const harness = createLibraryHarness({}, source);
  const broken = harness.mount("QrDetails", { code: {...code(0), text:null, url:null}, action: async()=>{throw Error("unexpected");} });
  const tree = broken.render();
  assert.ok(has(tree, "This QR code could not be decoded. Try a clearer image."));
  assert.equal(nodes(tree).filter(n => n?.type === "button").length, 0);
  broken.unmount();
  const calls=[];
  const unsafe = harness.mount("QrDetails", { code: {...code(0,"javascript:alert(1)"), suspicious:true}, action:async a=>calls.push(a) });
  assert.equal(button(unsafe.render(), "Open Link"), undefined);
  button(unsafe.render(), "Copy Text").props.onClick(); await settleRequests();
  button(unsafe.render(), "Save QR Code").props.onClick(); await settleRequests();
  button(unsafe.render(), "Remove Favorite").props.onClick(); await settleRequests();
  assert.deepEqual(calls, ["copy", "favorite", "unfavorite"]);
  unsafe.unmount();
});

test("empty result explains retry and performs no action", () => {
  const harness = createLibraryHarness({}, source);
  const component = harness.mount("QrResults", {scan:scan([])});
  assert.ok(has(component.render(), "No QR codes found. Try a clearer image or a larger selection."));
  component.unmount();
});

test("favorite search rejects a late previous response", async () => {
  const first=deferred(), second=deferred();
  const harness=createLibraryHarness({listQrFavorites:q=>q?second.promise:first.promise},source);
  const component=harness.mount("QrFavorites");
  component.render(); await new Promise(resolve=>setTimeout(resolve,5));
  nodes(component.render()).find(n=>n?.type==="input").props.onChange({target:{value:"new"}});
  component.render(); await new Promise(resolve=>setTimeout(resolve,170));
  second.resolve([{...testAsset,id:"new",qrText:"Newest QR content"}]);await settleRequests();
  assert.ok(has(component.render(),"Newest QR content"));
  first.resolve([{...testAsset,id:"old",qrText:"Old QR content"}]);await settleRequests();
  assert.ok(has(component.render(),"Newest QR content"));assert.equal(has(component.render(),"Old QR content"),false);
  component.unmount();
});
