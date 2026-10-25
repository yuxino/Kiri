// An isolated frontend harness. It never invokes native Kiri commands.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QrFavorites } from "../../src/qr/QrResults";
import { QrOverlay } from "../../src/qr/QrOverlay";
import { setLanguage } from "../../src/i18n";
import "../../src/styles/design-system.css";

const params = new URLSearchParams(location.search);
setLanguage(params.get("language") === "en" ? "en" : "zh-Hans");
const scenario = params.get("scenario") ?? "multi";
const base = "/src-tauri/tests/fixtures/qr/";
const metaName = scenario === "single" ? "url" : scenario === "favorites" ? "multi"
  : scenario === "contrast" && params.get("before") === "1" ? "contrast-before" : scenario;
const meta = await fetch(base + metaName + ".json").then(r => r.json());
if (params.get("long") === "1") {
  const text = "https://example.org/kiri-safe?data=" + "kiri-".repeat(1600);
  meta.codes = [{...meta.codes[0], text, url:text, host:"example.org", suspicious:false}];
}
const image = base + (scenario === "single" ? "url" : scenario) + ".png";
function InlineHarness() {
  const [open, setOpen] = useState(true);
  const width = params.get("edge") === "1" ? 280 : Math.min(960, innerWidth - 120);
  const scale = meta.width / width;
  const height = meta.height / scale;
  const selection = {x:params.get("edge") === "1" ? innerWidth-width-4 : 60, y:params.get("edge") === "1" ? innerHeight-height-4 : 116, width, height};
  return <>
    <img src={image} alt="Public original fixture" style={{position:"absolute",left:selection.x,top:selection.y,width,height}}/>
    {open ? <QrOverlay scan={{...meta,requestId:"fixture-request",imageUrl:image}} failed={false} selection={selection} bounds={{x:0,y:0,width:innerWidth,height:innerHeight}} scale={scale} onClose={()=>setOpen(false)} onOpened={()=>setOpen(false)}/> : <p role="status">Mock capture canceled</p>}
  </>;
}
createRoot(document.getElementById("root")!).render(<div className="library-root kiri-canvas-surface" style={{height:"100vh",boxSizing:"border-box",padding:28,flexDirection:"column"}}>
  <header className="text-dialog__header"><div><h2>{scenario === "favorites" ? "二维码收藏" : "二维码"}</h2><p>隔离前端测试 · 公开生成的测试图片 · 模拟 IPC</p></div><a href="?scenario=favorites">查看收藏测试</a></header>
  {scenario === "favorites" ? <div style={{height:"calc(100vh - 112px)",display:"flex"}}><QrFavorites/></div> : <InlineHarness/>}
  <output id="qa-actions" style={{display:"block",marginTop:20,fontSize:12}}/>
</div>);
