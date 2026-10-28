// Isolated real-component renderer QA. This entry is never loaded by Kiri.
// It models three separate WebViews, not native capture or exclusion behavior.
import React from "react";
import {createRoot} from "react-dom/client";
import {mockIPC, mockWindows} from "@tauri-apps/api/mocks";
import {emit} from "@tauri-apps/api/event";
import {ControlPanelWindow} from "../../src/windows/ControlPanelWindow";
import {RecordingAnnotationWindow} from "../../src/windows/RecordingAnnotationWindow";
import {DEFAULT_APPEARANCE} from "../../src/annotation/model";
import {setLanguage, isLanguage} from "../../src/i18n";
import type {RecordingAnnotationsState} from "../../src/lib/ipc";
import "../../src/styles/design-system.css";

const params = new URLSearchParams(location.search);
const role = params.get("role");
const language = params.get("lang") ?? "en";
if (isLanguage(language)) setLanguage(language);
const width = Number(params.get("width")) || 900;
const height = Number(params.get("height")) || 500;

if (!role) {
  document.getElementById("root")!.remove();
  const frames: Record<string, HTMLIFrameElement> = {};
  let state: RecordingAnnotationsState = {sessionId:"qa-recording", supported:true, available:true,
    ready:false, tool:"desktop", canUndo:false, canRedo:false, hasMarks:false, marks:[], revision:0,error:null};
  const ready = new Set<string>();
  let appearance = {...DEFAULT_APPEARANCE};
  let paused = false;
  const errors: string[] = [];
  const actions: {caller:string;command:string;payload:unknown}[] = [];
  const broadcast = (event: string, payload: unknown) => {
    for (const frame of Object.values(frames)) (frame.contentWindow as any)?.__qaEmit?.(event, payload);
  };
  const publish = () => {
    frames.input.style.pointerEvents = state.tool === "desktop" ? "none" : "auto";
    frames.input.style.visibility = state.tool === "desktop" ? "hidden" : "visible";
    broadcast("recording-annotations-state", state);
  };
  const recording = () => ({isRecording:!paused,isPaused:paused,isStarting:false,
    isTransitioning:false,isFinalizing:false,elapsed:17,elapsedLabel:"00:17"});
  const invoke = (caller:string,command:string,p:any) => {
    actions.push({caller,command,payload:p});
    if(actions.length>100) actions.shift();
    switch(command) {
      case "get_recording_annotations": return structuredClone(state);
      case "recording_annotations_ready":
        ready.add(caller); state={...state,ready:ready.has("input") && ready.has("ink")}; publish(); return;
      case "set_recording_annotation_tool":
        state={...state,tool:p.tool}; publish();
        if (p.tool !== "desktop") frames.input.contentWindow?.focus();
        return structuredClone(state);
      case "update_recording_annotations":
        if (p.revision > state.revision) {state={...state,...p};publish();} return;
      case "recording_annotation_action":
        broadcast("recording-annotation-action", {sessionId:state.sessionId,action:p.action}); return;
      case "update_recording_annotation_appearance":
        broadcast("recording-annotation-appearance",p);return;
      case "plugin:event|emit_to": broadcast(p.event,p.payload);return;
      case "get_annotation_appearance": return appearance;
      case "set_annotation_appearance":
        appearance={...appearance,...p.appearance}; broadcast("annotation-appearance-changed",appearance); return appearance;
      case "get_recording_state": return recording();
      case "get_shortcut_settings": return [];
      case "position_recording_controls":
        frames.panel.style.width=`${p.width}px`;frames.panel.style.height=`${p.height}px`;
        return {maxWidth:Math.min(Number(params.get("panelWidth")) || 640, innerWidth-48)};
      case "pause_recording": paused=true;broadcast("recording-state",recording());return;
      case "resume_recording": paused=false;broadcast("recording-state",recording());return;
      case "stop_recording": state={...state,tool:"desktop"}; publish();return;
      case "log_frontend_error": errors.push(p.message);return;
      default:
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|outer_position") return {x:24,y:height+112};
        if (command.startsWith("plugin:window|")) return;
        errors.push(`Unsupported QA command ${command}`);
    }
  };
  Object.assign(window,{__qa:{invoke,errors,actions,get state(){return state;},get appearance(){return appearance;}}});
  document.body.style.cssText="margin:0;background:#eee;color:#171717;font:15px system-ui;overflow:auto";
  const title=document.createElement("div");
  title.style.cssText="margin:20px 24px 16px";
  title.textContent="Kiri · Live recording annotation test — generated content";
  const stage=document.createElement("div");
  stage.id="qa-stage";
  stage.style.cssText=`position:relative;margin:0 24px;width:${width}px;height:${height}px;background:#fff;overflow:hidden`;
  stage.innerHTML='<div style="padding:36px"><h1 style="margin:0 0 18px;font-size:30px">Explain a workflow</h1><p style="max-width:600px;line-height:1.8">Draw an arrow, highlight a step, and add a note while the recording continues. Return to the desktop to keep working.</p><button id="source-action" style="margin-top:28px;padding:12px 18px">Original application button</button><p id="source-result"></p></div>';
  stage.querySelector("button")!.addEventListener("click",()=>{stage.querySelector("#source-result")!.textContent="Desktop interaction received";});
  document.body.append(title,stage);
  for (const name of ["ink","input","panel"]) {
    const frame=document.createElement("iframe"); frames[name]=frame;frame.id=`qa-${name}`;
    frame.src=`?role=${name}&session=qa-recording&width=${width}&height=${height}&lang=${language}`;
    frame.title=`${name} WebView`;
    frame.style.cssText=name==="panel"
      ?`display:block;position:relative;margin:16px 24px;border:0;width:640px;height:240px`
      :`position:absolute;inset:0;border:0;width:${width}px;height:${height}px;${name==="ink"?"pointer-events:none":"visibility:hidden;pointer-events:none"}`;
    (name==="panel"?document.body:stage).append(frame);
  }
} else {
  mockWindows(role==="panel"?"control-panel":`recording-annotation-${role}`);
  Object.assign(window,{__qaEmit:(event:string,payload:unknown)=>emit(event,payload)});
  mockIPC((command,payload)=>{
    try {return (parent as any).__qa.invoke(role,command,payload);}
    catch(error){(parent as any).__qa.errors.push(String(error));throw error;}
  },{shouldMockEvents:true});
  // The official Tauri event mock supports emit/listen but not emitTo.
  const internals=(window as any).__TAURI_INTERNALS__;
  const invokeMock=internals.invoke;
  internals.invoke=(command:string,payload:unknown,options:unknown)=>command==="plugin:event|emit_to"
    ? (parent as any).__qa.invoke(role,command,payload):invokeMock(command,payload,options);
  window.addEventListener("error",event=>(parent as any).__qa.errors.push(event.message));
  window.addEventListener("unhandledrejection",event=>(parent as any).__qa.errors.push(String(event.reason)));
  createRoot(document.getElementById("root")!).render(<React.StrictMode>
    {role==="panel"?<ControlPanelWindow/>:<RecordingAnnotationWindow ink={role==="ink"}/>}
  </React.StrictMode>);
}
