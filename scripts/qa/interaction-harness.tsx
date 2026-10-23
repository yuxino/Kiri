// Isolated real-component QA. Generated media, no devices or user library.
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {mockIPC, mockWindows} from "@tauri-apps/api/mocks";
import {VideoTrimPlayer} from "../../src/windows/VideoTrimPlayer";
import RecordingMicrophoneSelect from "../../src/windows/RecordingMicrophoneSelect";
import {DEFAULT_APPEARANCE} from "../../src/annotation/model";
import {DEFAULT_RECORDING_OPTIONS} from "../../src/lib/ipc";
import {isLanguage, setLanguage} from "../../src/i18n";
import "../../src/styles/design-system.css";

const params = new URLSearchParams(location.search);
const language = params.get("lang") || "en";
if (isLanguage(language)) setLanguage(language);
const qa = {calls: [] as string[], devices: [{id: "qa-usb", name: "USB QA Microphone"}], failDevices: false, plays: 0};
Object.assign(window, {__interactionQa: qa});
mockWindows("viewer-qa");
mockIPC((command, payload) => {
  qa.calls.push(command);
  switch (command) {
    case "list_microphone_devices":
      if (qa.failDevices) throw new Error("Controlled enumeration failure");
      return qa.devices;
    case "get_annotation_appearance": return DEFAULT_APPEARANCE;
    case "set_annotation_appearance": return (payload as {appearance: unknown}).appearance;
    case "load_video_project": return {state: "missing", revision: "qa-0", project: null};
    case "save_video_project": return {state: "valid", revision: "qa-1", project: (payload as {project: unknown}).project};
    case "plugin:window|is_maximized": return true;
    case "plugin:window|is_fullscreen": return false;
    default:
      if (command.startsWith("plugin:event|") || command.startsWith("plugin:window|")) return;
      throw new Error(`Unexpected isolated QA command: ${command}`);
  }
}, {shouldMockEvents: true});

function MicrophoneFixture() {
  const [options, setOptions] = useState({...DEFAULT_RECORDING_OPTIONS, capturesMicrophone: true, microphoneDeviceId: "qa-usb"});
  return <main style={{padding: 32}}>
    <h1>Microphone selection · generated devices</h1>
    <div style={{display: "flex", gap: 12, alignItems: "center"}}>
      <button type="button">Before selector</button>
      <RecordingMicrophoneSelect options={options} disabled={false} onChange={next => setOptions({...next, microphoneDeviceId: next.microphoneDeviceId ?? ""})}/>
      <button type="button">After selector</button>
    </div>
    <output aria-label="Saved device">{options.microphoneDeviceId || "default"}</output>
  </main>;
}

async function generatedVideo() {
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  const context = canvas.getContext("2d")!;
  const stream = canvas.captureStream(10);
  const recorder = new MediaRecorder(stream, {mimeType: "video/webm"});
  const chunks: Blob[] = [];
  const complete = new Promise<Blob>(resolve => {
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.onstop = () => resolve(new Blob(chunks, {type: "video/webm"}));
  });
  recorder.start();
  for (let frame = 0; frame < 12; frame++) {
    context.fillStyle = "#f4f4f4"; context.fillRect(0, 0, 640, 360);
    context.fillStyle = "#222"; context.font = "24px sans-serif";
    context.fillText("Kiri · generated silent QA video", 40, 100);
    context.fillRect(40 + frame * 30, 180, 30, 30);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  recorder.stop();
  const blob = await complete; stream.getTracks().forEach(track => track.stop());
  return URL.createObjectURL(blob);
}

if (params.has("microphone")) createRoot(document.getElementById("root")!).render(<MicrophoneFixture/>);
else {
  const src = await generatedVideo();
  // Record whether a focused control accidentally starts preview playback.
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { qa.plays++; return play.call(this); };
  createRoot(document.getElementById("root")!).render(<VideoTrimPlayer id="qa" src={src} editable
    capabilities={{videoEditing: true, videoSpeedEditing: true, videoEffectsEditing: true, videoAnnotationsEditing: true, videoExportPresets: true}}
    onClosePreparationChange={() => {}} onClose={() => qa.calls.push("close")} onError={() => qa.calls.push("media-error")}/>);
}
