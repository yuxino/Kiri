/** Runs the real renderer against either browser Canvas or a native Canvas adapter. */
export function mosaicPixelCases(createCanvas, renderAll) {
  const width = 96, height = 64;
  const source = createCanvas(width, height);
  const sourceContext = source.getContext("2d");
  const image = sourceContext.createImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    image.data.set([(x * 7 + y * 13) % 256, (x * 17 + y * 3) % 256, (x % 3) * 100, 255], i);
  }
  sourceContext.putImageData(image, 0, 0);
  function frame(marks, options = {}, scaleX = 1, scaleY = scaleX, exporting = true) {
    const fullSource = createCanvas(width * scaleX, height * scaleY);
    fullSource.getContext("2d").drawImage(source, 0, 0, fullSource.width, fullSource.height);
    const output = createCanvas(width * scaleX, height * scaleY);
    const ctx = output.getContext("2d");
    if (!exporting) ctx.scale(scaleX, scaleY);
    renderAll({ctx, sourceImage: fullSource, sourceWidth: fullSource.width, sourceHeight: fullSource.height,
      sourceOffset: {x: 0, y: 0}, regionSize: {x: 0, y: 0, width, height},
      scaleX, scaleY, viewScaleX: 1, viewScaleY: 1, exporting}, marks, options);
    return ctx.getImageData(0, 0, output.width, output.height).data;
  }
  const brush = {kind: "mosaic", id: 1, points: [{x: 25, y: 32}, {x: 45, y: 32}],
    brushDiameter: 20, intensity: "standard", style: "pixel", shape: "brush"};
  const before = frame([brush]);
  const grown = frame([{...brush, points: [...brush.points, {x: 74, y: 32}]}]);
  let changedCoveredPixels = 0;
  for (let y = 26; y < 38; y++) for (let x = 25; x < 44; x++) {
    const i = (y * width + x) * 4;
    if (before.slice(i, i + 4).some((value, channel) => value !== grown[i + channel])) changedCoveredPixels++;
  }
  const strong = {...brush, points: [{x: 12, y: 12}, {x: 84, y: 52}], shape: "rectangle", intensity: "strong"};
  const weak = {...strong, id: 2, points: [{x: 24, y: 20}, {x: 70, y: 44}], intensity: "soft"};
  const protectedFrame = frame([strong]);
  const overpainted = frame([strong, weak]);
  const draftOverpainted = frame([strong], {draft: weak});
  let weakenedPixels = 0, weakenedDraftPixels = 0;
  for (let y = 21; y < 43; y++) for (let x = 25; x < 69; x++) {
    const i = (y * width + x) * 4;
    if (protectedFrame.slice(i, i + 4).some((value, channel) => value !== overpainted[i + channel])) weakenedPixels++;
    if (protectedFrame.slice(i, i + 4).some((value, channel) => value !== draftOverpainted[i + channel])) weakenedDraftPixels++;
  }
  const differingChannels = (a, b) => a.reduce((count, value, index) => count + (value !== b[index] ? 1 : 0), 0);
  const blur = {...strong, style: "blur", brushDiameter: 36};
  const weakBlur = {...weak, style: "blur", brushDiameter: 12};
  const protectedBlur = frame([blur]), overpaintedBlur = frame([blur, weakBlur]);
  let weakenedBlurPixels = 0;
  for (let y = 21; y < 43; y++) for (let x = 25; x < 69; x++) {
    const i = (y * width + x) * 4;
    if (protectedBlur.slice(i, i + 4).some((value, channel) => value !== overpaintedBlur[i + channel])) weakenedBlurPixels++;
  }
  const mixedStyleOrderDiff = differingChannels(frame([strong, blur]), frame([blur, strong]));
  const exported = frame([strong], {}, 2, 1, true), preview = frame([strong], {}, 2, 1, false);
  let previewExportDiff = 0;
  for (let y = 14; y < 50; y++) for (let x = 28; x < 164; x++) {
    const i = (y * width * 2 + x) * 4;
    for (let channel = 0; channel < 4; channel++) if (exported[i + channel] !== preview[i + channel]) previewExportDiff++;
  }
  const edge = {...strong, points: [{x: 85, y: 50}, {x: width, y: height}]};
  const edgeFrame = frame([edge]);
  const edgeAlpha = edgeFrame[(width * height - 1) * 4 + 3];
  const regionWidth = 61, regionHeight = 43, offset = {x: 11, y: 7};
  const croppedSource = createCanvas(regionWidth, regionHeight);
  croppedSource.getContext("2d").drawImage(source, offset.x, offset.y, regionWidth, regionHeight,
    0, 0, regionWidth, regionHeight);
  function regionFrame(image, sourceOffset, style = "pixel") {
    const output = createCanvas(regionWidth, regionHeight), ctx = output.getContext("2d");
    renderAll({ctx, sourceImage: image, sourceWidth: image.width, sourceHeight: image.height,
      sourceOffset, regionSize: {x: 0, y: 0, width: regionWidth, height: regionHeight},
      scaleX: 1, scaleY: 1, viewScaleX: 1, viewScaleY: 1, exporting: true},
    [{...strong, style, brushDiameter: 36, points: [{x: 0, y: 0}, {x: regionWidth, y: regionHeight}]}]);
    return ctx.getImageData(0, 0, regionWidth, regionHeight).data;
  }
  const sourceReopenDiff = differingChannels(regionFrame(source, offset), regionFrame(croppedSource, {x: 0, y: 0}));
  const blurSourceReopenDiff = differingChannels(regionFrame(source, offset, "blur"), regionFrame(croppedSource, {x: 0, y: 0}, "blur"));
  return {changedCoveredPixels, weakenedPixels, weakenedDraftPixels, weakenedBlurPixels,
    mixedStyleOrderDiff, previewExportDiff, edgeAlpha, sourceReopenDiff, blurSourceReopenDiff};
}
