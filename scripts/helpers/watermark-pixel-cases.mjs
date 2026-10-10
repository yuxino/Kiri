/** Shared real-Canvas assertions. The caller supplies Canvas and document APIs. */
export function watermarkPixelCases(createCanvas, renderAll, cropAnnotationDocument) {
  const watermark = {kind:"watermark",id:80,text:"Kiri © 中文",rect:{x:80,y:60,width:150,height:40},
    color:"black",fontSize:28,opacity:.2,rotation:0,mode:"single",spacing:80};
  function render(marks, width=640, height=360, background=null) {
    const source=createCanvas(width,height),canvas=createCanvas(width,height);
    const sourceContext=source.getContext("2d"),ctx=canvas.getContext("2d");
    if(!sourceContext||!ctx)throw new Error("Watermark pixel test requires a real Canvas 2D context.");
    if(background){sourceContext.fillStyle=background;sourceContext.fillRect(0,0,width,height);}
    renderAll({ctx,sourceImage:source,sourceWidth:width,sourceHeight:height,
      sourceOffset:{x:0,y:0},regionSize:{x:0,y:0,width,height},scaleX:1,scaleY:1,
      viewScaleX:1,viewScaleY:1,exporting:true},marks);
    return canvas;
  }
  const lower=render([watermark]).getContext("2d").getImageData(0,0,640,360).data;
  const higher=render([{...watermark,opacity:1}]).getContext("2d").getImageData(0,0,640,360).data;
  let visibleTextPixels=0,opacityViolations=0;
  for(let index=3;index<lower.length;index+=4){
    if(higher[index]>0){
      visibleTextPixels++;
      if(Math.abs(lower[index]-Math.round(higher[index]*watermark.opacity))>1)opacityViolations++;
    }else if(lower[index]!==0)opacityViolations++;
  }
  // Reverse mark order deliberately: the white object is later in persisted data.
  const layer=render([{...watermark,opacity:1},{kind:"rectangle",id:81,
    rect:{...watermark.rect},color:"white",width:35}],640,360,"#fff")
    .getContext("2d").getImageData(0,0,640,360).data;
  const layerReference=render([{...watermark,opacity:1}],640,360,"#fff")
    .getContext("2d").getImageData(0,0,640,360).data;
  let lastLayerDarkPixels=0,lastLayerChangedPixels=0;
  for(let index=0;index<layer.length;index+=4){
    if(layer[index]<50&&layer[index+1]<50&&layer[index+2]<50&&layer[index+3]>0)lastLayerDarkPixels++;
    if([0,1,2,3].some(channel=>layer[index+channel]!==layerReference[index+channel]))lastLayerChangedPixels++;
  }
  const tiled={...watermark,rect:{x:80,y:60,width:150,height:35},mode:"tiled",rotation:-30};
  const full=render([tiled]);
  const crop={x:260,y:170,width:250,height:150};
  const edited=cropAnnotationDocument({schemaVersion:1,canvas:{width:640,height:360},
    sourcePixels:{width:1280,height:720},marks:[tiled]},crop).document;
  const cropped=render(edited.marks,250,150);
  const expected=full.getContext("2d").getImageData(crop.x,crop.y,250,150).data;
  const actual=cropped.getContext("2d").getImageData(0,0,250,150).data;
  let cropPhaseChangedPixels=0,cropComparedPixels=0;
  // Only edge clipping may alter antialiasing. Every interior glyph keeps phase.
  for(let y=2;y<148;y++)for(let x=2;x<248;x++){
    const index=(y*250+x)*4;cropComparedPixels++;
    if([0,1,2,3].some(channel=>actual[index+channel]!==expected[index+channel]))cropPhaseChangedPixels++;
  }
  const checks={
    transparentBackground:lower[3]===0&&higher[3]===0,
    textHasVisiblePixels:visibleTextPixels>100,
    opacityRespected:opacityViolations===0,
    watermarkDrawnLast:lastLayerDarkPixels>100&&lastLayerChangedPixels===0,
    cropPhasePreserved:cropPhaseChangedPixels===0,
  };
  return {
    success:Object.values(checks).every(Boolean),checks,
    transparentCornerAlpha:{low:lower[3],high:higher[3]},visibleTextPixels,opacityViolations,
    lastLayerDarkPixels,lastLayerChangedPixels,cropPhaseChangedPixels,cropComparedPixels,
  };
}
