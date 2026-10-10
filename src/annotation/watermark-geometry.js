// Pure document-space geometry shared by selection, crop and rasterization.
export const MAX_WATERMARK_TILES = 4096;
export const MAX_TOTAL_WATERMARK_TILES = 8192;
export const MAX_WATERMARK_TEXT_UNITS = 512;
const DENSITY_ERROR = "Watermark is too dense. Increase its size or spacing.";

export function watermarkCenter(mark) {
  return {x: mark.rect.x + mark.rect.width / 2, y: mark.rect.y + mark.rect.height / 2};
}

export function watermarkCorners(mark) {
  const center = watermarkCenter(mark);
  const angle = mark.rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy]) => {
    const x = sx * mark.rect.width / 2, y = sy * mark.rect.height / 2;
    return {x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos};
  });
}

/** The outline and hit target describe the master text, never the whole tiling. */
export function watermarkBounds(mark) {
  const center = watermarkCenter(mark), angle = mark.rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
  const width = mark.rect.width * cos + mark.rect.height * sin;
  const height = mark.rect.width * sin + mark.rect.height * cos;
  return {x:center.x-width/2,y:center.y-height/2,width,height};
}

export function watermarkContainsPoint(mark, point, paddingX = 0, paddingY = 0) {
  const center = watermarkCenter(mark), angle = -mark.rotation * Math.PI / 180;
  const dx = point.x - center.x, dy = point.y - center.y;
  const x = dx * Math.cos(angle) - dy * Math.sin(angle);
  const y = dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(x) <= mark.rect.width / 2 + paddingX &&
    Math.abs(y) <= mark.rect.height / 2 + paddingY;
}

/** Separating-axis intersection avoids dropping partially rotated text on crop. */
export function watermarkIntersectsRect(mark, rect) {
  const corners = watermarkCorners(mark);
  const target = [{x:rect.x,y:rect.y},{x:rect.x+rect.width,y:rect.y},
    {x:rect.x+rect.width,y:rect.y+rect.height},{x:rect.x,y:rect.y+rect.height}];
  const angle = mark.rotation * Math.PI / 180;
  for (const axis of [{x:1,y:0},{x:0,y:1},
    {x:Math.cos(angle),y:Math.sin(angle)},{x:-Math.sin(angle),y:Math.cos(angle)}]) {
    const first = corners.map(p => p.x * axis.x + p.y * axis.y);
    const second = target.map(p => p.x * axis.x + p.y * axis.y);
    if (Math.max(...first) < Math.min(...second) || Math.max(...second) < Math.min(...first)) return false;
  }
  return true;
}

/** Fixed document grid: cropping translates the anchor, never resets its phase. */
export function watermarkTilePlan(mark, region) {
  const bounds = watermarkBounds(mark), center = watermarkCenter(mark);
  const stepX = bounds.width + mark.spacing, stepY = bounds.height + mark.spacing;
  if (![center.x,center.y,stepX,stepY,region.x,region.y,region.width,region.height].every(Number.isFinite)
    || stepX <= 0 || stepY <= 0 || region.width <= 0 || region.height <= 0) {
    throw new RangeError("Invalid watermark geometry.");
  }
  // Include boundary-touching tiles conservatively across JS/Rust libm rounding.
  const startColumn = Math.ceil((region.x - bounds.width / 2 - center.x) / stepX - 1e-9);
  const endColumn = Math.floor((region.x + region.width + bounds.width / 2 - center.x) / stepX + 1e-9);
  const startRow = Math.ceil((region.y - bounds.height / 2 - center.y) / stepY - 1e-9);
  const endRow = Math.floor((region.y + region.height + bounds.height / 2 - center.y) / stepY + 1e-9);
  const count = Math.max(0,endColumn-startColumn+1) * Math.max(0,endRow-startRow+1);
  if (!Number.isSafeInteger(count) || count > MAX_WATERMARK_TILES) {
    throw new RangeError(DENSITY_ERROR);
  }
  return {center,stepX,stepY,startColumn,endColumn,startRow,endRow,count};
}

/** Drafts may have temporary IDs; this checks density without copying or parsing them. */
export function validateWatermarkDensity(marks, region) {
  let total = 0;
  for (const mark of marks) {
    if (mark.kind !== "watermark") continue;
    if (mark.text.length > MAX_WATERMARK_TEXT_UNITS) {
      throw new RangeError("Watermark text must be 512 characters or fewer.");
    }
    total += mark.mode === "tiled" ? watermarkTilePlan(mark,region).count : 1;
    if (total > MAX_TOTAL_WATERMARK_TILES) {
      throw new RangeError(DENSITY_ERROR);
    }
  }
  return total;
}
