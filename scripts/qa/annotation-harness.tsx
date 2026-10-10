// Isolated annotation QA: generated source pixels, no native app or user library.
import React, {useCallback, useEffect, useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import AnnotationCanvas, {type AnnotationCanvasHandle} from "../../src/annotation/AnnotationCanvas";
import {DEFAULT_APPEARANCE, nextCalloutNumber, type CalloutMark, type AnnotationMark, type AnnotationDocumentV1, type Tool} from "../../src/annotation/model";
import {Toolbar} from "../../src/windows/OverlayWindow";
import {CalloutControls} from "../../src/annotation/CalloutControls";
import {languages, setLanguage} from "../../src/i18n";
import "../../src/styles/design-system.css";

const source = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="white"/><text x="32" y="48" font-family="sans-serif" font-size="18" fill="#555">Kiri annotation fixture</text></svg>');
const original: AnnotationMark = {kind:"rectangle",id:1,rect:{x:100,y:100,width:140,height:90},color:"cherry",width:4};
const fresh = new URLSearchParams(location.search).has("fresh");
const callouts = new URLSearchParams(location.search).has("callouts");
const language = new URLSearchParams(location.search).get("lang");
if (languages.includes(language as typeof languages[number])) setLanguage(language as typeof languages[number]);
const initialDocument: AnnotationDocumentV1 = {schemaVersion:1,canvas:{width:640,height:360},sourcePixels:{width:640,height:360},marks:fresh||callouts?[]:[original]};

function Harness() {
  const canvas=useRef<AnnotationCanvasHandle>(null);
  const [image,setImage]=useState<HTMLImageElement|null>(null);
  const [tool,setTool]=useState<Tool>(fresh?"rectangle":"select");
  const [marks,setMarks]=useState(initialDocument.marks);
  const [appearance,setAppearance]=useState(DEFAULT_APPEARANCE);
  const [selected,setSelected]=useState<CalloutMark|null>(null);
  const [number,setNumber]=useState(1);
  const [undo,setUndo]=useState(false),[redo,setRedo]=useState(false);
  const [exported,setExported]=useState<string|null>(null);
  const [bounds,setBounds]=useState({x:0,y:0,width:innerWidth-48,height:innerHeight-48});
  useEffect(()=>{const resize=()=>setBounds({x:0,y:0,width:innerWidth-48,height:innerHeight-48});window.addEventListener("resize",resize);return()=>window.removeEventListener("resize",resize);},[]);
  const selection=useCallback((mark:AnnotationMark|null)=>setSelected(mark?.kind==="callout"?mark:null),[]);
  const changed=useCallback((marks:AnnotationMark[])=>{setMarks(marks);setNumber(nextCalloutNumber(marks));},[]);
  useEffect(()=>{const img=new Image();img.onload=()=>setImage(img);img.src=source;return()=>{img.onload=null;};},[]);
  const frame=useCallback((value:HTMLCanvasElement)=>{Object.assign(window,{__qaCanvas:value});},[]);
  const history=useCallback((u:boolean,r:boolean)=>{setUndo(u);setRedo(r);},[]);
  return <div className="library-root kiri-canvas-surface" style={{padding:24,boxSizing:"border-box",height:"100vh"}}>
    <div style={{display:callouts?"none":"flex",gap:8,marginBottom:16}}>
      <button className="kiri-button" onClick={()=>setTool("select")}>Select</button>
      <button className="kiri-button" onClick={()=>setTool("rectangle")}>Rectangle</button>
      <button className="kiri-button" onClick={()=>canvas.current?.undo()}>Undo</button>
      <button className="kiri-button" onClick={()=>canvas.current?.redo()}>Redo</button>
    </div>
    <div style={{position:"relative",width:bounds.width,height:bounds.height}}>
    {callouts&&image&&<img src={source} alt="" aria-hidden="true" style={{position:"absolute",inset:0,width:Math.min(640,bounds.width),height:Math.min(640,bounds.width)*360/640,pointerEvents:"none"}}/>}
    {image&&<AnnotationCanvas ref={canvas} image={image} region={{x:0,y:0,width:640,height:360}}
      viewSize={callouts?{width:Math.min(640,bounds.width),height:Math.min(640,bounds.width)*360/640}:undefined}
      initialDocument={initialDocument} tool={tool} appearance={appearance} calloutNumber={number}
      onSelectionInfo={selection} onHistoryChange={history} onCancel={()=>{}} onFrame={frame} onDocumentChange={changed}/>}
    {callouts&&<Toolbar selection={{x:0,y:0,width:Math.min(640,bounds.width),height:Math.min(640,bounds.width)*360/640}} bounds={bounds}
      tool={tool} setTool={setTool} appearance={appearance} setAppearance={setAppearance} canUndo={undo} canRedo={redo}
      canSetSize={false} sizeControlsOpen={false} onToggleSize={()=>{}} disabled={false}
      onUndo={()=>canvas.current?.undo()} onRedo={()=>canvas.current?.redo()} onQr={()=>{}} onCancel={()=>{}}
      onDone={()=>{void canvas.current?.exportResult().then(result=>{if(result){Object.assign(window,{__qaExport:result.document});setExported(URL.createObjectURL(new Blob([result.png as BlobPart],{type:"image/png"})));}});}}
      showCalloutControls={tool==="callout"||(tool==="select"&&selected!==null)}
      selectedCalloutId={selected?.id}
      calloutControls={<CalloutControls selected={selected} nextNumber={number} appearance={appearance} onNextNumber={setNumber}
        onAppearance={patch=>setAppearance({...appearance,...patch})} onEdit={patch=>canvas.current?.updateSelectedCallout(patch,true)}
        onFinish={()=>canvas.current?.finishAppearanceAdjustment()}/>}/>}
    </div>
    <output id="qa-marks" style={{display:callouts?"none":undefined}}>{JSON.stringify(marks)}</output>
    {exported&&<img id="qa-export" src={exported} width={640} alt="Exported annotation fixture"/>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
