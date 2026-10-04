// Isolated controls/layout QA, without native capture or a user's library.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CaptureSizeControls } from "../../src/windows/CaptureSizeControls";
import { resizeCapturePixels } from "../../src/windows/capture-size.js";
import { SelectionHandles, Toolbar, RecordOptionsPanel } from "../../src/windows/OverlayWindow";
import { DEFAULT_APPEARANCE } from "../../src/annotation/model";
import { DEFAULT_RECORDING_OPTIONS } from "../../src/lib/ipc";
import { KiriIcon } from "../../src/components/KiriIcons";
import { t } from "../../src/i18n";
import "../../src/styles/design-system.css";

function Harness() {
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
  useEffect(() => {
    const resize = () => setViewport({ width: innerWidth, height: innerHeight });
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  const [rect, setRect] = useState({ x: 240, y: 170, width: 540, height: 340 });
  const bounds = { x: 0, y: 0, ...viewport };
  const [scale, setScale] = useState(2);
  const [mode, setMode] = useState("screenshot");
  const [sizeOpen, setSizeOpen] = useState(false);
  const [tool, setTool] = useState("select");
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);
  const [options, setOptions] = useState(DEFAULT_RECORDING_OPTIONS);
  return <main className="kiri-dark" style={{ width: "100vw", height: "100vh", background: "#d7d7d4" }}>
    <nav className="kiri-hud kiri-mode-select">
      {(["screenshot", "record"] as const).map(value => <button key={value} className="kiri-mode-btn" data-active={mode === value || undefined} onClick={() => { setMode(value); setSizeOpen(false); }}>
        <KiriIcon name={value === "screenshot" ? "camera.viewfinder" : "record.circle"} size={15} />
        {t(value === "screenshot" ? "Screenshot" : "Record")}
      </button>)}
    </nav>
    <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height, border: "1.5px solid #111", outline: "2px solid #fff", boxSizing: "border-box", background: "#f7f7f5" }}>
    </div>
    <SelectionHandles rect={rect}/>
    {sizeOpen && (mode === "record" || tool === "select") && <CaptureSizeControls rect={rect} bounds={bounds} scale={scale} interactive={true}
      onChange={(axis, pixels) => setRect(current => resizeCapturePixels(current, bounds, scale, axis, pixels))} />}
    {mode === "screenshot" ? <Toolbar selection={rect} bounds={bounds} tool={tool as any}
      setTool={setTool} appearance={appearance} setAppearance={setAppearance}
      canUndo={false} canRedo={false} canSetSize={tool === "select"} disabled={false}
      sizeControlsOpen={sizeOpen} onToggleSize={() => setSizeOpen(open => !open)}
      onUndo={() => {}} onRedo={() => {}} onDone={() => {}} onQr={() => {}} onCancel={() => {}} />
      : <RecordOptionsPanel anchor={rect} bounds={bounds} options={options} onChange={setOptions}
        micSupported={false} systemAudioSupported={false} clickHighlightsSupported={false}
        trayRecordingControls={false} sizeControlsOpen={sizeOpen}
        onToggleSize={() => setSizeOpen(open => !open)} onStart={() => {}} onCancel={() => {}} />}
    <nav style={{ display: "flex", alignItems: "center", gap: 16, position: "absolute", bottom: 20, left: 24, fontSize: 11, color: "#777" }}>
      <span>Isolated UI preview</span>
      <button onClick={() => setScale(scale === 2 ? 1.25 : 2)}>{scale}×</button>
      <button onClick={() => setRect({ x: bounds.width - 90, y: bounds.height - 90, width: 80, height: 80 })}>Bottom right</button>
      <button onClick={() => setRect({ x: bounds.width - 3, y: bounds.height - 3, width: 3, height: 3 })}>Tiny</button>
      <button onClick={() => setRect(bounds)}>Full display</button>
    </nav>
    <output id="qa-rect" hidden>{JSON.stringify(rect)}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
