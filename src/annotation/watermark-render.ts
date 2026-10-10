import type {WatermarkMark} from "./model";
import {COLOR_HEX} from "./model";
import type {RenderContext} from "./render";
import {layoutTextLines,textLineRuns} from "./text-layout.js";
import {watermarkCenter,watermarkTilePlan} from "./watermark-geometry.js";

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** One transparent mark; the fixed document grid has no view-size or DPR phase. */
export function drawWatermark(mark:WatermarkMark,r:RenderContext,ctx:CanvasRenderingContext2D,editing=false):void {
  if (editing && mark.mode === "single") return;
  const region={x:0,y:0,width:r.regionSize.width,height:r.regionSize.height};
  // Validate the full visible plan before drawing any pixels. Never truncate tiles.
  const plan=mark.mode === "tiled" ? watermarkTilePlan(mark,region) : null;
  const center=watermarkCenter(mark);
  ctx.save();
  try {
    if (r.exporting) ctx.scale(r.scaleX,r.scaleY);
    ctx.beginPath();ctx.rect(0,0,region.width,region.height);ctx.clip();
    ctx.globalAlpha *= mark.opacity;
    ctx.fillStyle=COLOR_HEX[mark.color];
    ctx.font=`600 ${mark.fontSize}px ${FONT_STACK}`;
    ctx.textAlign="left";ctx.textBaseline="top";
    const lines=layoutTextLines(mark.text,mark.rect.width,value=>ctx.measureText(value).width);
    const runs=lines.slice(0,Math.ceil(mark.rect.height/(mark.fontSize*1.25)))
      .map(line=>textLineRuns(line,value=>ctx.measureText(value).width).runs);
    const paint=(x:number,y:number)=>{
      ctx.save();
      try {
        ctx.translate(x,y);ctx.rotate(mark.rotation*Math.PI/180);
        ctx.beginPath();ctx.rect(-mark.rect.width/2,-mark.rect.height/2,mark.rect.width,mark.rect.height);ctx.clip();
        for (const [index,line] of runs.entries()) for (const run of line) {
          ctx.fillText(run.text,-mark.rect.width/2+run.x,-mark.rect.height/2+index*mark.fontSize*1.25);
        }
      } finally { ctx.restore(); }
    };
    if (!plan) paint(center.x,center.y);
    else for(let row=plan.startRow;row<=plan.endRow;row++) {
      for(let column=plan.startColumn;column<=plan.endColumn;column++) {
        if (editing && row === 0 && column === 0) continue;
        paint(plan.center.x+column*plan.stepX,plan.center.y+row*plan.stepY);
      }
    }
  } finally { ctx.restore(); }
}
