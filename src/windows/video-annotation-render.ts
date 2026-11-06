import type {AnnotationMark} from "../annotation/model";
import {MOSAIC_VIEW_BLOCK_SIZE} from "../annotation/model";
import {clipToMosaicStroke, drawMark, mosaicBlurRadius, type RenderContext} from "../annotation/render";

type Size = {width: number; height: number};
export type TimedVideoAnnotation = {start: number; end: number; mark: AnnotationMark;layer?:number};
export type RasterizedVideoAnnotation = {start:number;end:number;x:number;y:number;width:number;height:number;kind:"overlay"|"pixelate"|"blur";imageBase64:string;amount:number;layer?:number};

function context(ctx:CanvasRenderingContext2D, source:CanvasImageSource, size:Size):RenderContext {
  return {ctx,sourceImage:source,sourceWidth:size.width,sourceHeight:size.height,sourceOffset:{x:0,y:0},regionSize:{x:0,y:0,...size},scaleX:1,scaleY:1,viewScaleX:1,viewScaleY:1,exporting:true};
}

/** A mosaic samples everything below its track, including lower annotations. */
export function paintVideoAnnotation(ctx:CanvasRenderingContext2D, mark:AnnotationMark, sourceSize:Size, scratch:HTMLCanvasElement) {
  if(mark.kind==="mosaic"){
    if(scratch.width!==sourceSize.width)scratch.width=sourceSize.width;
    if(scratch.height!==sourceSize.height)scratch.height=sourceSize.height;
    scratch.getContext("2d")?.drawImage(ctx.canvas,0,0,sourceSize.width,sourceSize.height);
  }
  const render = context(ctx,scratch,sourceSize);
  ctx.save(); drawMark(mark,render,ctx); ctx.restore();
}

/** Rasterize ink once; mosaic PNGs contain coverage only, never frozen video pixels. */
export function rasterizeVideoAnnotations(tracks:TimedVideoAnnotation[], sourceSize:Size):RasterizedVideoAnnotation[] {
  if(tracks.length===0)return [];
  const {width,height}=sourceSize;
  if (!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0) throw new Error("Invalid annotation canvas size");
  const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  if(!ctx) throw new Error("Annotation canvas unavailable");
  const result:RasterizedVideoAnnotation[]=[];
  let decodedBytes=0,encodedBytes=0;
  for(const {start,end,mark,layer} of tracks) {
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start) throw new Error("Invalid annotation time range");
    ctx.clearRect(0,0,width,height);
    let kind:RasterizedVideoAnnotation["kind"]="overlay",amount=0;
    if(mark.kind==="mosaic") {
      if(mark.points.length===0) continue;
      clipToMosaicStroke(ctx,mark.points,mark.brushDiameter,mark.shape);
      ctx.fillStyle="#fff";ctx.fillRect(0,0,width,height);ctx.restore();
      kind=mark.style==="blur"?"blur":"pixelate";
      amount=(mark.style==="blur"?mosaicBlurRadius(mark.brushDiameter,mark.intensity,{x:1,y:1,stroke:1}):MOSAIC_VIEW_BLOCK_SIZE[mark.intensity])/width;
    } else {
      ctx.save();drawMark(mark,context(ctx,canvas,sourceSize),ctx);ctx.restore();
    }
    const pixels=ctx.getImageData(0,0,width,height).data;
    let left=width,top=height,right=-1,bottom=-1;
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) if(pixels[(y*width+x)*4+3]>0) {left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
    if(right<left||bottom<top) continue;
    const crop=document.createElement("canvas");
    const cropWidth=right-left+1,cropHeight=bottom-top+1;
    const ratio=Math.min(1,4096/Math.max(cropWidth,cropHeight));
    crop.width=Math.max(1,Math.round(cropWidth*ratio));crop.height=Math.max(1,Math.round(cropHeight*ratio));
    decodedBytes+=crop.width*crop.height*4;
    if(decodedBytes>128*1024*1024) throw new Error("Annotation images exceed export memory limit");
    const cropped=crop.getContext("2d");if(!cropped) throw new Error("Annotation canvas unavailable");
    cropped.drawImage(canvas,left,top,cropWidth,cropHeight,0,0,crop.width,crop.height);
    const imageBase64=crop.toDataURL("image/png").split(",")[1];encodedBytes+=imageBase64.length;
    if(encodedBytes>64*1024*1024) throw new Error("Annotation images exceed export size limit");
    result.push({start,end,x:left/width,y:top/height,width:cropWidth/width,height:cropHeight/height,kind,amount,imageBase64,layer});
  }
  return result;
}
