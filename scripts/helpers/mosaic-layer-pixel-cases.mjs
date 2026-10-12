/** Pixel references use a separately flattened lower layer, not renderer ordering. */
export function mosaicLayerPixelCases(createCanvas, renderAll) {
  const width = 128, height = 96;
  const base = createCanvas(width, height);
  const background = base.getContext("2d");
  background.fillStyle = "#fff"; background.fillRect(0, 0, width, height);
  const text = {kind: "text", id: 1, text: "PRIVATE", rect: {x: 22, y: 30, width: 88, height: 24},
    color: "black", fontSize: 18, background: "transparent"};
  const callout = {kind: "callout", id: 2, center: {x: 30, y: 40}, size: 24, number: 1, style: "outline",
    text: "PRIVATE", labelRect: {x: 50, y: 26, width: 70, height: 30}, color: "cherry", fontSize: 14};
  const rectangle = {kind: "rectangle", id: 3, rect: {x: 20, y: 28, width: 80, height: 36}, color: "black", width: 4};
  const line = {kind: "line", id: 4, start: {x: 20, y: 35}, end: {x: 100, y: 55}, color: "cherry", width: 5};
  const arrow = {...line, kind: "arrow", id: 5};
  const pen = {kind: "pen", id: 6, points: [{x: 20, y: 40}, {x: 55, y: 30}, {x: 100, y: 55}], color: "black", width: 5};
  const label = {...text, id: 7, labelDirection: "left", color: "cherry"};
  const watermark = {kind: "watermark", id: 11, text: "PRIVATE", rect: {...text.rect},
    color: "black", fontSize: 18, opacity: 1, rotation: 0, mode: "single", spacing: 80};
  const mosaic = {kind: "mosaic", id: 8, points: [{x: 10, y: 10}, {x: 124, y: 86}],
    brushDiameter: 70, intensity: "strong", style: "pixel", shape: "rectangle"};
  const pixels = canvas => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  const compare = (a, b) => {
    const expected = pixels(b);
    return pixels(a).reduce((count, value, index) => count + (value !== expected[index] ? 1 : 0), 0);
  };
  function frame(marks, options = {}, sx = 1, sy = sx, exporting = true, source = null) {
    if (!source) {
      source = createCanvas(width * sx, height * sy);
      source.getContext("2d").drawImage(base, 0, 0, source.width, source.height);
    }
    const out = createCanvas(width * sx, height * sy), ctx = out.getContext("2d");
    if (!exporting) ctx.scale(sx, sy);
    renderAll({ctx, sourceImage: source, sourceWidth: source.width, sourceHeight: source.height,
      sourceOffset: {x: 0, y: 0}, regionSize: {x: 0, y: 0, width, height}, scaleX: sx, scaleY: sy,
      viewScaleX: 1, viewScaleY: 1, exporting}, marks, options);
    return out;
  }
  let cases = 0, referenceDiff = 0, previewDiff = 0, draftDiff = 0, laterInkMissingPixels = 0, unchangedRedactions = 0;
  for (const style of ["pixel", "blur"]) for (const shape of ["brush", "rectangle", "ellipse"])
    for (const [sx, sy] of [[1, 1], [2, 2], [2, 1]]) for (const mark of [text, callout, rectangle, line, arrow, pen, label, watermark]) {
      const mask = {...mosaic, style, shape, points: shape === "brush" ? [{x: 20, y: 40}, {x: 112, y: 48}] : mosaic.points};
      const lower = frame([mark], {}, sx, sy);
      const expected = frame([mask], {}, sx, sy, true, lower);
      const actual = frame([mark, mask], {}, sx, sy);
      referenceDiff += compare(actual, expected);
      previewDiff += compare(frame([mark, mask], {}, sx, sy, false), actual);
      draftDiff += compare(frame([mark], {draft: mask}, sx, sy), actual);
      const empty = createCanvas(width * sx, height * sy);
      const ink = pixels(frame([mark], {}, sx, sy, true, empty));
      const after = pixels(frame([mask, mark], {}, sx, sy));
      // Fully covered ink must remain above the mosaic. Edge antialiasing can
      // differ when Canvas copies an intermediate surface (not lost layers).
      for (let i = 0; i < ink.length; i += 4) if (ink[i + 3] === 255) {
        if ([0, 1, 2, 3].some(channel => Math.abs(ink[i + channel] - after[i + channel]) > 1)) laterInkMissingPixels++;
      }
      if (compare(actual, lower) === 0) unchangedRedactions++;
      cases++;
    }
  // A mark between two runs must be sampled by the later run. Undo removes
  // only that later run, and replaying the saved mark array restores its pixels.
  const first = {...mosaic, id: 9, intensity: "soft"};
  const second = {...mosaic, id: 10, points: [{x: 15, y: 15}, {x: 110, y: 80}]};
  const lower = frame([text, first, callout]);
  const expected = frame([second], {}, 1, 1, true, lower);
  const interleavedDiff = compare(frame([text, first, callout, second]), expected);
  const saved = JSON.parse(JSON.stringify([text, first, callout, second]));
  const reopenedDiff = compare(frame(saved), expected);
  return {cases, referenceDiff, previewDiff, draftDiff, laterInkMissingPixels, unchangedRedactions, interleavedDiff, reopenedDiff};
}
