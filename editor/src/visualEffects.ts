import type { CardNode, VisualEffect } from './model';
import { hasStroke } from './layerAppearance';

type Insets = { left: number; right: number; top: number; bottom: number };
interface EffectSurface { canvas: HTMLCanvasElement; x: number; y: number; width: number; height: number }

const RADIAL_TRAVEL = .38;
const MAX_SURFACE_PIXELS = 6_000_000;
const MAX_CACHE_PIXELS = 10_000_000;
const MAX_SURFACE_SIDE = 4096;

export function visualEffectIsActive(effect: VisualEffect) {
  if (!effect.enabled) return false;
  if (effect.kind === 'radial-blur') return effect.strength > 0;
  if (effect.kind === 'gaussian-blur') return effect.radius > 0;
  return effect.opacity > 0;
}

export function visualEffectPadding(node: CardNode): Insets {
  let left = 0, right = 0, top = 0, bottom = 0;
  for (const effect of node.visualEffects ?? []) {
    if (!visualEffectIsActive(effect)) continue;
    if (effect.kind === 'drop-shadow') {
      const softness = Math.max(0, effect.radius * 3 + effect.spread);
      const x = node.flipX ? -effect.x : effect.x;
      const y = node.flipY ? -effect.y : effect.y;
      left += Math.max(0, softness - x);
      right += Math.max(0, softness + x);
      top += Math.max(0, softness - y);
      bottom += Math.max(0, softness + y);
    } else if (effect.kind === 'gaussian-blur') {
      const softness = effect.radius * 3;
      left += softness; right += softness; top += softness; bottom += softness;
    } else if (effect.kind === 'radial-blur') {
      const factor = effect.strength * RADIAL_TRAVEL;
      const x = node.width * (node.flipX ? 1 - effect.center[0] : effect.center[0]);
      const y = node.height * (node.flipY ? 1 - effect.center[1] : effect.center[1]);
      left += (x + left) * factor;
      right += (node.width - x + right) * factor;
      top += (y + top) * factor;
      bottom += (node.height - y + bottom) * factor;
    }
  }
  return { left, right, top, bottom };
}

export function visualEffectsActive(node: CardNode) {
  return node.visualEffects?.some(visualEffectIsActive) ?? false;
}

function newSurface(width: number, height: number, resampling?: ImageSmoothingQuality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  if (resampling) context.imageSmoothingQuality = resampling;
  return context;
}

function like(source: HTMLCanvasElement) {
  return newSurface(source.width, source.height, source.getContext('2d')!.imageSmoothingQuality);
}

function gaussian(source: HTMLCanvasElement, radius: number) {
  if (radius < .04) return source;
  const target = like(source);
  if (typeof target.filter === 'string') {
    target.filter = `blur(${radius}px)`;
    target.drawImage(source, 0, 0);
    return target.canvas;
  }
  // Canvas implementations without filter use the same separable kernel via weighted draws.
  const weights = [0.003, 0.022, 0.097, 0.233, 0.29, 0.233, 0.097, 0.022, 0.003];
  for (const horizontal of [true, false]) {
    const output = horizontal ? target : like(source);
    output.globalCompositeOperation = 'lighter';
    weights.forEach((weight, index) => {
      output.globalAlpha = weight;
      const delta = (index - 4) * radius * .75;
      output.drawImage(source, horizontal ? delta : 0, horizontal ? 0 : delta);
    });
    source = output.canvas;
  }
  return source;
}

function morphology(source: HTMLCanvasElement, spread: number) {
  const radius = Math.abs(Math.round(spread));
  if (!radius) return source;
  const expand = spread > 0;
  const target = like(source);
  const { width, height } = source;
  const data = source.getContext('2d')!.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  const filtered = new Uint8Array(alpha.length);
  for (let index = 0; index < alpha.length; index++) alpha[index] = data[index * 4 + 3];
  for (const horizontal of [true, false]) {
    const length = horizontal ? width : height;
    const stride = horizontal ? 1 : width;
    const segments = horizontal ? height : width;
    const queue = new Int32Array(length + radius * 2);
    const input = horizontal ? alpha : filtered;
    const output = horizontal ? filtered : alpha;
    for (let segment = 0; segment < segments; segment++) {
      let first = 0, last = 0;
      const base = segment * (horizontal ? width : 1);
      const sample = (position: number) => position < 0 || position >= length ? 0 : input[base + position * stride];
      for (let index = -radius; index < length + radius; index++) {
        if (first < last && queue[first] < index - 2 * radius) first++;
        const value = sample(index);
        while (first < last && (expand ? value >= sample(queue[last - 1]) : value <= sample(queue[last - 1]))) last--;
        queue[last++] = index;
        if (index >= radius) output[base + (index - radius) * stride] = sample(queue[first]);
      }
    }
  }
  const image = target.createImageData(width, height);
  for (let index = 0; index < alpha.length; index++) image.data[index * 4 + 3] = alpha[index];
  target.putImageData(image, 0, 0);
  return target.canvas;
}

function shadow(source: HTMLCanvasElement, radius: number, spread: number, x: number, y: number, color: string, opacity: number, inside: boolean) {
  const shape = morphology(source, inside ? -spread : spread);
  const matte = like(source);
  if (inside) {
    matte.fillRect(0, 0, source.width, source.height);
    matte.globalCompositeOperation = 'destination-out';
  }
  matte.drawImage(shape, x, y);
  const shaded = like(source);
  shaded.drawImage(gaussian(matte.canvas, radius), 0, 0);
  shaded.globalCompositeOperation = 'source-in';
  shaded.fillStyle = color;
  shaded.globalAlpha = opacity;
  shaded.fillRect(0, 0, source.width, source.height);
  const output = like(source);
  if (inside) {
    output.drawImage(source, 0, 0);
    output.globalCompositeOperation = 'source-atop';
    output.drawImage(shaded.canvas, 0, 0);
  } else {
    output.drawImage(shaded.canvas, 0, 0);
    output.drawImage(source, 0, 0);
  }
  return output.canvas;
}

function radial(source: HTMLCanvasElement, x: number, y: number, strength: number) {
  const output = like(source);
  const samples = 12;
  output.globalCompositeOperation = 'lighter';
  output.globalAlpha = 1 / samples;
  for (let index = 0; index < samples; index++) {
    const part = index * strength * RADIAL_TRAVEL / (samples - 1);
    output.drawImage(source, -x * part, -y * part, source.width * (1 + part), source.height * (1 + part));
  }
  return output.canvas;
}

interface CacheEntry {
  node: CardNode;
  image?: HTMLImageElement | ImageBitmap;
  resolution: number;
  resampling?: ImageSmoothingQuality;
  surface: EffectSurface;
}
const canvasCache = new Map<string, CacheEntry>();

function remember(entry: CacheEntry) {
  canvasCache.set(entry.node.id, entry);
  let pixels = 0;
  for (const [id, { surface: { canvas } }] of Array.from(canvasCache).reverse()) {
    pixels += canvas.width * canvas.height;
    if (pixels > MAX_CACHE_PIXELS || canvasCache.size > 32) canvasCache.delete(id);
  }
}

export function createVisualEffectSurface(node: CardNode, matrix: DOMMatrix, image: CacheEntry['image'],
  paint: (context: CanvasRenderingContext2D) => void, clip?: HTMLCanvasElement,
  resampling?: ImageSmoothingQuality): EffectSurface {
  const resolution = Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d), .1);
  const reusable = !clip && node.type !== 'text';
  const cached = reusable ? canvasCache.get(node.id) : undefined;
  if (cached && cached.node === node && cached.image === image && cached.resolution === resolution &&
      cached.resampling === resampling) return cached.surface;

  const expansion = visualEffectPadding(node);
  const stroke = hasStroke(node) ? node.strokeWidth ?? 0 : 0;
  const padding = stroke * 2 + 3;
  // Inner-shadow input needs a transparent margin beyond even the softest inset.
  let innerPadX = 0, innerPadY = 0;
  for (const effect of node.visualEffects ?? []) {
    if (effect.kind !== 'inner-shadow' || !visualEffectIsActive(effect)) continue;
    const softness = effect.radius * 3 + Math.abs(effect.spread);
    innerPadX = Math.max(innerPadX, softness + Math.abs(effect.x));
    innerPadY = Math.max(innerPadY, softness + Math.abs(effect.y));
  }
  const left = expansion.left + padding + innerPadX, top = expansion.top + padding + innerPadY;
  const width = node.width + left + expansion.right + padding + innerPadX;
  const height = node.height + top + expansion.bottom + padding + innerPadY;
  const scale = Math.min(resolution, Math.sqrt(MAX_SURFACE_PIXELS / (width * height)), MAX_SURFACE_SIDE / Math.max(width, height));
  const output = newSurface(Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale)), resampling);
  output.setTransform(scale, 0, 0, scale, left * scale, top * scale);
  paint(output);
  if (clip) {
    const inverse = matrix.inverse();
    output.save();
    output.globalCompositeOperation = 'destination-in';
    output.transform(inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f);
    output.drawImage(clip, 0, 0);
    output.restore();
  }
  let canvas = output.canvas;
  for (const effect of node.visualEffects ?? []) {
    if (!visualEffectIsActive(effect)) continue;
    if (effect.kind === 'gaussian-blur') canvas = gaussian(canvas, effect.radius * scale);
    else if (effect.kind === 'radial-blur') {
      const x = node.width * (node.flipX ? 1 - effect.center[0] : effect.center[0]);
      const y = node.height * (node.flipY ? 1 - effect.center[1] : effect.center[1]);
      canvas = radial(canvas, (x + left) * scale, (y + top) * scale, effect.strength);
    } else canvas = shadow(canvas, effect.radius * scale, effect.spread * scale,
      effect.x * (node.flipX ? -scale : scale), effect.y * (node.flipY ? -scale : scale),
      effect.color, effect.opacity, effect.kind === 'inner-shadow');
  }
  const surface = { canvas, x: -left, y: -top, width: canvas.width / scale, height: canvas.height / scale };
  if (reusable) remember({ node, image, resolution, resampling, surface });
  return surface;
}
