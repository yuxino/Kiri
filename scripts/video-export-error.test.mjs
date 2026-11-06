import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";
import {createVideoPlayerHarness} from "./helpers/video-player-harness.mjs";
import {createLibraryHarness,deferred,nodes,settleRequests} from "./helpers/library-render-harness.mjs";

function loadModule(path, modules={}, document={}) {
  const source=readFileSync(new URL(path,import.meta.url),"utf8");
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText;
  const module={exports:{}};
  new Function("require","module","exports","document",code)(name=>modules[name]??{},module,module.exports,document);
  return module.exports;
}
const errors=loadModule("../src/windows/video-export-error.ts");
const {parseVideoExportFailure,videoExportFailureMessage,videoExportFailureCode}=errors;
const capabilities=Object.fromEntries(["videoEditing","videoSpeedEditing","videoEffectsEditing","videoAnnotationsEditing","videoExportPresets"].map(key=>[key,true]));

test("native export failures preserve only known stages and safe diagnostic codes",()=>{
  for(const stage of ["request","source","snapshot","render","save","worker"]){
    for(const code of ["io_not_found","io_storage_full","hresult_80070005","transcode_00000002","native","unknown"]){
      assert.deepEqual(parseVideoExportFailure(`VIDEO_EXPORT_FAILED:${stage}:${code}`),{stage,code});
    }
  }
  const privateReason="C:\\Users\\Private Person\\capture.mp4: decoder failed";
  for(const reason of [privateReason,new Error(privateReason),{stage:"save",code:privateReason},
    `VIDEO_EXPORT_FAILED:render:${privateReason}`,"VIDEO_EXPORT_FAILED:render:io_private_file",
    "VIDEO_EXPORT_FAILED:open:native","VIDEO_EXPORT_FAILED:render:hresult_1234","VIDEO_EXPORT_FAILED:render:transcode_0000000z",
    "VIDEO_EXPORT_FAILED:save:io_not_found\nprivate",null]){
    const failure=parseVideoExportFailure(reason);
    assert.deepEqual(failure,{stage:"unknown",code:"unknown"});
    assert.equal(videoExportFailureCode(failure),"unknown/unknown");
  }
});

function player(t,options={}){
  const exports=[],opened=[],cancelled=[];
  let progress,stops=0;
  const component=createVideoPlayerHarness(capabilities,{
    api:{
      exportVideoCopy:async(...args)=>{exports.push(args);return options.export?.(...args)??"saved-copy";},
      openAsset:async id=>{opened.push(id);return options.open?.(id);},
      cancelVideoExport:async id=>{cancelled.push(id);return options.cancel?.(id)??true;},
    },
    modules:{
      "@tauri-apps/api/window":{getCurrentWindow:()=>({isMaximized:async()=>true,listen:async(_event,callback)=>{
        if(options.listenError)throw options.listenError;
        progress=callback;return()=>{stops++;};
      }})},
      "./video-annotation-render":{rasterizeVideoAnnotations:options.rasterize??(()=>[])},
      "./video-stickers":{rasterizeVideoStickers:()=>[]},
    },
  });
  component.openEditor();
  const panel=()=>nodes(component.render()).find(node=>node?.type==="export-panel");
  t.after(()=>component.unmount());
  return {...component,exports,opened,cancelled,panel,get stops(){return stops;},
    async settle(){await settleRequests();await new Promise(resolve=>setTimeout(resolve,0));await settleRequests();component.render();},
    progress(phase,value=.25){progress({payload:{requestId:exports[0][5],phase,progress:value}});component.render();},
  };
}

for(const stage of ["request","source","snapshot","render","save","worker"]){
  test(`real video editor retains its edit and permits retry after ${stage} failure`,async t=>{
    let fail=true;
    const f=player(t,{export:()=>{if(fail)throw `VIDEO_EXPORT_FAILED:${stage}:io_permission_denied`;return"saved-copy";}});
    const before=f.projectOptions().getProject();
    f.panel().props.onSave();await f.settle();
    assert.deepEqual(f.panel().props.error,{stage,code:"io_permission_denied"});
    assert.equal(f.panel().props.busy,false);
    assert.equal(f.panel().props.valid,true);
    assert.equal(f.panel().props.saved,false);
    assert.deepEqual(f.projectOptions().getProject(),before);
    fail=false;f.panel().props.onSave();await f.settle();
    assert.equal(f.exports.length,2);
    assert.equal(f.panel().props.error,null);
    assert.equal(f.panel().props.saved,true);
    assert.equal(f.stops,2);
  });
}

test("progress listener failure prevents starting export and has its own safe error",async t=>{
  const f=player(t,{listenError:new Error("private listener detail")});
  f.panel().props.onSave();await f.settle();
  assert.equal(f.exports.length,0);
  assert.deepEqual(f.panel().props.error,{stage:"progress",code:"unavailable"});
  assert.equal(f.panel().props.busy,false);
  assert.equal(f.panel().props.valid,true);
});

test("annotation rasterization failure cleans up progress and never invokes native export",async t=>{
  const f=player(t,{rasterize:()=>{throw new Error("private canvas detail");}});
  f.panel().props.onSave();await f.settle();
  assert.equal(f.exports.length,0);
  assert.equal(f.stops,1);
  assert.deepEqual(f.panel().props.error,{stage:"annotations",code:"unavailable"});
  assert.equal(f.panel().props.busy,false);
});

test("unknown backend text is discarded while cancellation keeps its separate state",async t=>{
  let reason="C:\\Users\\Private Person\\capture.mp4";
  const f=player(t,{export:()=>{throw reason;}});
  f.panel().props.onSave();await f.settle();
  assert.deepEqual(f.panel().props.error,{stage:"unknown",code:"unknown"});
  reason="VIDEO_EXPORT_CANCELLED";f.panel().props.onSave();await f.settle();
  assert.equal(f.panel().props.error,null);
  assert.equal(f.panel().props.cancelled,true);
});

test("opening a saved copy can fail and retry without claiming export failed or exporting twice",async t=>{
  let fail=true;
  const f=player(t,{open:()=>{if(fail)throw new Error("private output path");}});
  f.panel().props.onSave();await f.settle();
  assert.equal(f.panel().props.saved,true);
  f.panel().props.onOpen();await f.settle();
  assert.equal(f.panel().props.saved,true);
  assert.deepEqual(f.panel().props.error,{stage:"open",code:"unavailable"});
  fail=false;f.panel().props.onOpen();await f.settle();
  assert.equal(f.panel().props.error,null);
  assert.equal(f.panel().props.saved,true);
  assert.deepEqual(f.opened,["saved-copy","saved-copy"]);
  assert.equal(f.exports.length,1);
});

test("an unaccepted cancellation stays retryable until genuine saving progress arrives",async t=>{
  const pending=deferred();let attempts=0;
  const f=player(t,{export:()=>pending.promise,cancel:()=>++attempts>1});
  f.panel().props.onSave();await f.settle();
  f.panel().props.onCancel();await f.settle();
  assert.equal(f.panel().props.progress.phase,"preparing");
  assert.equal(f.panel().props.cancelling,false);
  assert.equal(f.panel().props.cancelFailed,true);
  f.progress("rendering");
  f.panel().props.onCancel();await f.settle();
  assert.equal(f.panel().props.cancelling,true);
  assert.equal(f.panel().props.cancelFailed,false);
  assert.deepEqual(f.cancelled,[f.exports[0][5],f.exports[0][5]]);
  pending.reject("VIDEO_EXPORT_CANCELLED");await f.settle();
  assert.equal(f.panel().props.cancelled,true);
  assert.equal(f.panel().props.error,null);
});

test("genuine saving progress prevents another cancellation request",async t=>{
  const pending=deferred();
  const f=player(t,{export:()=>pending.promise});
  f.panel().props.onSave();await f.settle();f.progress("saving",null);
  f.panel().props.onCancel();await f.settle();
  assert.deepEqual(f.cancelled,[]);
  pending.resolve("saved-copy");await f.settle();
  assert.equal(f.panel().props.saved,true);
});

test("unannotated exports require no annotation canvas, while real annotations still validate it",()=>{
  const annotations=loadModule("../src/windows/video-annotation-render.ts",{},
    {createElement(){throw new Error("canvas unavailable");}});
  assert.deepEqual(annotations.rasterizeVideoAnnotations([],{width:7680,height:4320}),[]);
  assert.throws(()=>annotations.rasterizeVideoAnnotations([{start:0,end:1}],{width:1920,height:1080}),/canvas unavailable/);
  const stickers=loadModule("../src/windows/video-stickers.ts",{},
    {createElement(){throw new Error("canvas unavailable");}});
  assert.deepEqual(stickers.rasterizeVideoStickers([]),[]);
});

test("real export panel shows stage guidance and safe code in all seven languages",()=>{
  const source='import React from "react";\n'+readFileSync(new URL("../src/windows/VideoExportPanel.tsx",import.meta.url),"utf8");
  const failures=[... ["request","source","snapshot","render","save","worker"].map(stage=>({stage,code:"io_permission_denied"})),
    {stage:"progress",code:"unavailable"},{stage:"annotations",code:"unavailable"},{stage:"open",code:"unavailable"},{stage:"unknown",code:"unknown"}];
  for(const language of ["en","zh-Hans","zh-Hant","ja","de","ko","fr"]){
    const dictionary=JSON.parse(readFileSync(new URL(`../src/i18n/${language}.json`,import.meta.url),"utf8"));
    for(const failure of failures){
      const message=videoExportFailureMessage(failure);
      assert.ok(dictionary[message],`${language}: ${message}`);
      const h=createLibraryHarness({},source,{modules:{
        "./VideoExportSettings":{VideoExportSettings:"settings"},"./video-export-error":errors,
        "../i18n":{t:key=>dictionary[key]??key,fmt:(key,value)=>(dictionary[key]??key).replace("%@",value)},
      }});
      const c=h.mount("VideoExportPanel",{preset:"original",supportsPresets:true,sourceSize:{width:1920,height:1080},duration:10,valid:true,busy:false,error:failure,saved:failure.stage==="open",progress:null,cancelling:false,cancelled:false,cancelFailed:false});
      const closed=c.render();nodes(closed).find(node=>node?.type==="button").props.onClick();
      const tree=c.render();
      const status=nodes(tree).find(node=>node?.props?.className==="kiri-video-export-status");
      assert.equal(status.props.role,"alert");
      assert.ok(nodes(status).includes(dictionary[message]));
      assert.ok(nodes(tree).includes(dictionary["Error code: %@"].replace("%@",videoExportFailureCode(failure))));
      c.unmount();
    }
  }
});
