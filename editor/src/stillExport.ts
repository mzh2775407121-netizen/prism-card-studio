import { prepareInspectorFace, type InspectorFace, type InspectorFlash } from './albumInspectorAssets';
import { getCardCornerRadiusMm, type Project, type SideName } from './model';
import { makeCanvas, rasterContext } from './render';
import { paintStockOptics, REST_STOCK_LIGHT, stockBlendMode, type StockLight } from './stockOptics';

export const INSPECTOR_BACKGROUND = '#e9e9e9';
export const INSPECTOR_PERSPECTIVE = 1400;
export type InspectorLight = StockLight;
export type StillView = {
  side: SideName;
  light: InspectorLight;
  yaw: number;
  pitch: number;
  perspective: number;
  background: string;
};
export type StillExportOptions = {
  width: number;
  height: number;
  view?: StillView;
  background?: string;
  effects?: boolean;
  resampling?: 'high' | 'medium';
};
type Context = CanvasRenderingContext2D;
type ColorStop = [number, string];
type Point = { x: number; y: number };

function ramp(gradient: CanvasGradient, stops: ColorStop[]) {
  stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
  return gradient;
}

function directional(ctx: Context, angle: number, sweep: number, before: number, after: number, stops: ColorStop[]) {
  const { width, height } = ctx.canvas;
  const radians = angle * Math.PI / 180;
  const x = Math.sin(radians), y = -Math.cos(radians);
  const length = Math.abs(x) * width + Math.abs(y) * height;
  const start = (sweep + before - 50) / 100 * length;
  const end = (sweep + after - 50) / 100 * length;
  ctx.fillStyle = ramp(ctx.createLinearGradient(width / 2 + x * start, height / 2 + y * start,
    width / 2 + x * end, height / 2 + y * end), stops);
  ctx.fillRect(0, 0, width, height);
}

function spot(ctx: Context, light: InspectorLight, rx: number, ry: number, stops: ColorStop[]) {
  const { width, height } = ctx.canvas;
  const x = width * light.x / 100, y = height * light.y / 100;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(width * rx, height * ry);
  ctx.fillStyle = ramp(ctx.createRadialGradient(0, 0, 0, 0, 0, 1), stops);
  ctx.fillRect(-x / (width * rx), -y / (height * ry), 1 / rx, 1 / ry);
  ctx.restore();
}

function maskedBy(ctx: Context, mask: HTMLCanvasElement, tile?: number, offset?: Point) {
  const { width, height } = ctx.canvas;
  ctx.globalCompositeOperation = 'destination-in';
  if (!tile) ctx.drawImage(mask, 0, 0, width, height);
  else {
    const scale = tile * width / mask.width;
    const pattern = ctx.createPattern(mask, 'repeat')!;
    pattern.setTransform(new DOMMatrix().translate(offset?.x ?? (width - mask.width * scale) / 2,
      offset?.y ?? (height - mask.height * scale) / 2).scale(scale));
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.globalCompositeOperation = 'source-over';
}

function paintFlash(layer: Context, plane: Context, finish: InspectorFlash, light: InspectorLight) {
  const { width, height } = layer.canvas;
  const sweep = light.x * .72 + light.y * .28;
  const tilt = (light.x - 50) * .58 + (light.y - 50) * .31;
  const angle = finish.angle + 65 + tilt * .42;
  const renderSpectrum = (ctx: Context) => directional(ctx, angle, sweep, -36, 36, [
    [0, '#8a76e35c'], [.292, '#47ccdc95'], [.444, '#b0f5ff'], [.555, '#fffae0'], [.75, '#f1a1d9ad'], [1, '#8a77e15c'],
  ]);
  const overlay = (paint: (ctx: Context) => void, mask?: HTMLCanvasElement, tile?: number, offset?: Point) => {
    plane.clearRect(0, 0, width, height);
    paint(plane);
    if (mask) maskedBy(plane, mask, tile, offset);
    layer.drawImage(plane.canvas, 0, 0);
  };
  layer.clearRect(0, 0, width, height);
  if (finish.style === 'cosmos') {
    spot(layer, light, .57, .48, [[0, '#b7a7e830'], [.94, '#b7a7e800']]);
    overlay(renderSpectrum, finish.pattern);
    overlay(ctx => {
      directional(ctx, angle + 110, 100 - sweep, -40, 40, [
        [0, '#9c71db22'], [.275, '#64d9dc73'], [.54, '#f7b4d3b3'], [1, '#606fbb25'],
      ]);
      spot(ctx, light, .55, .48, [[.02, '#fffde8'], [.22, '#b8f0ffdb'], [.51, '#bd93f773'], [.99, '#bd93f700']]);
    }, finish.stars);
  } else if (finish.style === 'geometric') {
    renderSpectrum(layer);
    spot(layer, light, .48, .47, [[0, '#fffdf3f5'], [.2, '#baf7eedb'], [.77, '#baf7ee00']]);
    if (finish.pattern) maskedBy(layer, finish.pattern, .43);
  } else if (finish.style === 'glitter') {
    overlay(renderSpectrum, finish.pattern, .36);
    overlay(ctx => spot(ctx, light, .67, .57, [[.01, '#fffdea'], [.29, '#effeffed'], [.65, '#e6c4fc75'], [1, '#e6c4fc00']]),
      finish.pattern, .29, { x: (3 + (light.x / 100 - .5) * 2) * width / 500, y: (-5 + (light.y / 100 - .5) * 2) * width / 500 });
  } else if (finish.style === 'linear') {
    renderSpectrum(layer);
    overlay(ctx => {
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate((finish.angle + 65) * Math.PI / 180);
      const range = Math.hypot(width, height);
      const step = Math.max(3, width * .03);
      ctx.fillStyle = '#e3feff50';
      for (let row = -range; row < range; row += step) ctx.fillRect(-range, row, range * 2, step * .12);
      ctx.restore();
      ctx.globalCompositeOperation = 'destination-in';
      spot(ctx, light, .91, .78, [[.03, '#000'], [.46, '#000b'], [.79, '#0004'], [1, '#0001']]);
      ctx.globalCompositeOperation = 'source-over';
    });
    directional(layer, angle, sweep, -15, 12, [[0, '#fffaea00'], [.555, '#fffaeaed'], [1, '#fffffe00']]);
  } else {
    const rays = layer.createConicGradient((finish.angle + tilt * 1.3 - 90) * Math.PI / 180, width * .83, height * .46);
    const colors: ColorStop[] = [[0, '#8d87d65d'], [6, '#4eb4da26'], [9, '#8ae4ed9c'], [12, '#fff7c8'], [15, '#cda2f96e'], [22.5, '#8d87d65d']];
    for (let ray = 0; ray < 16; ray++) {
      ramp(rays, colors.map(([degree, color]) => [(ray * 22.5 + degree) / 360, color]));
    }
    layer.fillStyle = rays;
    layer.fillRect(0, 0, width, height);
    layer.globalCompositeOperation = 'destination-in';
    spot(layer, light, .91, .78, [[.03, '#000'], [.46, '#000b'], [.79, '#0004'], [1, '#0001']]);
    layer.globalCompositeOperation = 'source-over';
    spot(layer, light, .56, .52, [[0, '#fff5c7b0'], [.37, '#c6b4ff3b'], [.91, '#c6b4ff00']]);
  }
  maskedBy(layer, finish.mask);
}

const workLayers = new WeakMap<HTMLCanvasElement, { finish: Context; plane: Context }>();

export function paintInspectorFace(target: HTMLCanvasElement, face: InspectorFace, light: InspectorLight,
  resampling?: ImageSmoothingQuality) {
  const { width, height } = face.base;
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
    workLayers.delete(target);
  }
  const context = rasterContext(target, resampling);
  context.clearRect(0, 0, width, height);
  context.drawImage(face.base, 0, 0);
  if (!face.optics && !face.flashes.length && (!face.glare || !light.opacity)) {
    if (face.surface) context.drawImage(face.surface, 0, 0);
    return;
  }
  let work = workLayers.get(target);
  if (!work) {
    work = { finish: rasterContext(makeCanvas(width, height), resampling), plane: rasterContext(makeCanvas(width, height), resampling) };
    workLayers.set(target, work);
  }
  if (face.optics) {
    paintStockOptics(work.plane, face.optics, light);
    context.globalAlpha = face.optics.finish.opacity;
    context.globalCompositeOperation = stockBlendMode(face.optics.finish);
    context.drawImage(work.plane.canvas, 0, 0);
    context.globalAlpha = 1;
    for (const { canvas, blend } of face.artwork) {
      context.globalCompositeOperation = blend;
      context.drawImage(canvas, 0, 0);
    }
    context.globalCompositeOperation = 'source-over';
  }
  if (face.surface) context.drawImage(face.surface, 0, 0);
  for (const effect of face.flashes) {
    paintFlash(work.finish, work.plane, effect, light);
    context.globalAlpha = effect.opacity * (.66 + .34 * light.opacity);
    context.drawImage(work.finish.canvas, 0, 0);
  }
  if (face.glare && light.opacity > 0) {
    const layer = work.plane;
    layer.clearRect(0, 0, width, height);
    const radius = Math.hypot(width * Math.max(light.x, 100 - light.x) / 100,
      height * Math.max(light.y, 100 - light.y) / 100);
    spot(layer, light, radius / width, radius / height, [[.1, '#fffc'], [.2, '#ffffffa6'], [.9, '#0008']]);
    maskedBy(layer, face.glare);
    context.globalAlpha = light.opacity * .52;
    context.globalCompositeOperation = 'overlay';
    context.drawImage(layer.canvas, 0, 0);
  }
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
}

function drawPerspective(context: Context, source: HTMLCanvasElement, view?: StillView) {
  const width = source.width, height = source.height;
  const { width: outputWidth, height: outputHeight } = context.canvas;
  if (!view || Math.abs(view.yaw) + Math.abs(view.pitch) < .01) {
    context.drawImage(source, (outputWidth - width) / 2, (outputHeight - height) / 2);
    return;
  }
  const yaw = view.yaw * Math.PI / 180, pitch = view.pitch * Math.PI / 180;
  const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw);
  const sinPitch = Math.sin(pitch), cosPitch = Math.cos(pitch);
  const distance = Math.max(1, view.perspective) * height;
  const project = (x: number, y: number): Point => {
    const u = x - width / 2, v = y - height / 2;
    const z = -sinYaw * u + cosYaw * sinPitch * v;
    const scale = distance / (distance - z);
    return { x: (u * cosYaw + v * sinPitch * sinYaw) * scale, y: v * cosPitch * scale };
  };
  const corners = [project(0, 0), project(width, 0), project(width, height), project(0, height)];
  const left = Math.min(...corners.map(p => p.x)), right = Math.max(...corners.map(p => p.x));
  const top = Math.min(...corners.map(p => p.y)), bottom = Math.max(...corners.map(p => p.y));
  const fit = Math.min(1, outputWidth / (right - left), outputHeight / (bottom - top));
  const offsetX = (outputWidth - (left + right) * fit) / 2;
  const offsetY = (outputHeight - (top + bottom) * fit) / 2;
  const vertex = (x: number, y: number): Point => {
    const p = project(x, y);
    return { x: p.x * fit + offsetX, y: p.y * fit + offsetY };
  };
  const mesh = 16;
  const dx = width / mesh, dy = height / mesh;
  const points = Array.from({ length: mesh + 1 }, (_, row) =>
    Array.from({ length: mesh + 1 }, (_, col) => vertex(col * dx, row * dy)));
  const triangle = (a: Point, b: Point, c: Point, originX: number, originY: number, reverse = false) => {
    const sign = reverse ? -1 : 1;
    const m11 = (b.x - a.x) / dx * sign, m12 = (b.y - a.y) / dx * sign;
    const m21 = (c.x - a.x) / dy * sign, m22 = (c.y - a.y) / dy * sign;
    context.save();
    context.beginPath();
    // A subpixel overlap closes internal anti-aliased mesh seams.
    const center = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    for (const [i, p] of [a, b, c].entries()) {
      const expand = .7 / Math.max(1, Math.hypot(p.x - center.x, p.y - center.y));
      const x = p.x + (p.x - center.x) * expand, y = p.y + (p.y - center.y) * expand;
      if (!i) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.closePath();
    context.clip();
    context.setTransform(m11, m12, m21, m22, a.x - m11 * originX - m21 * originY, a.y - m12 * originX - m22 * originY);
    context.drawImage(source, 0, 0);
    context.restore();
  };
  for (let row = 0; row < mesh; row++) for (let col = 0; col < mesh; col++) {
    const a = points[row][col], b = points[row][col + 1], c = points[row + 1][col], d = points[row + 1][col + 1];
    triangle(a, b, c, col * dx, row * dy);
    triangle(d, c, b, (col + 1) * dx, (row + 1) * dy, true);
  }
}

async function renderCardSurface(project: Project, side: SideName, scale: number, light: InspectorLight,
  effects: boolean, resampling?: ImageSmoothingQuality) {
  const face = await prepareInspectorFace(project, side, scale, effects, resampling);
  const surface = makeCanvas(face.base.width, face.base.height);
  paintInspectorFace(surface, face, light, resampling);
  workLayers.delete(surface);
  return surface;
}

export async function renderFlatCardTexture(project: Project, side: SideName, scale: number, resampling?: ImageSmoothingQuality) {
  const surface = await renderCardSurface(project, side, scale, REST_STOCK_LIGHT, true, resampling);
  const context = surface.getContext('2d')!;
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, surface.width, surface.height);
  context.globalCompositeOperation = 'source-over';
  return surface;
}

export async function renderStill(project: Project, side: SideName,
  { width, height, view, background, effects = true, resampling }: StillExportOptions) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 8192 || height > 8192 || width * height > 32_000_000) {
    throw new Error('图片尺寸超出导出范围，请降低像素尺寸。');
  }
  const captured = view?.side === side ? view : undefined;
  const scale = Math.min(width / (project.widthMm * 10), height / (project.heightMm * 10));
  const source = await renderCardSurface(project, side, scale, captured?.light ?? REST_STOCK_LIGHT, effects, resampling);
  const sourceContext = source.getContext('2d')!;
  sourceContext.globalCompositeOperation = 'destination-in';
  sourceContext.beginPath();
  const radius = getCardCornerRadiusMm(project) * 10 * scale;
  sourceContext.roundRect(0, 0, source.width, source.height, radius);
  sourceContext.fill();
  const output = makeCanvas(width, height);
  const context = rasterContext(output, resampling);
  const ground = background ?? captured?.background ?? '#ffffff';
  if (ground !== 'transparent') {
    context.fillStyle = ground;
    context.fillRect(0, 0, width, height);
  }
  drawPerspective(context, source, captured);
  return output;
}
