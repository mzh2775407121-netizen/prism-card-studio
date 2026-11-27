import { IMAGE_ADJUSTMENT_KEYS, type ImageAdjustments } from './model';

type SourceImage = HTMLImageElement | ImageBitmap;
type SourceArea = { x: number; y: number; width: number; height: number };
type Sample = {
  canvas: HTMLCanvasElement;
  original: ImageData;
  settings: string;
};

const sourceIds = new WeakMap<SourceImage, number>();
let nextSourceId = 0;
const samples = new Map<string, Sample>();
let cachedPixels = 0;
const maxCachedPixels = 4_000_000;
const maxCachedSamplePixels = 2_000_000;

export function hasImageAdjustments(values?: ImageAdjustments) {
  return values && IMAGE_ADJUSTMENT_KEYS.some(key => Boolean(values[key]));
}

function pixelAdjuster(values: ImageAdjustments) {
  const gain = 2 ** ((values.exposure ?? 0) / 50);
  const contrast = 2 ** ((values.contrast ?? 0) / 100);
  const brightness = (values.brightness ?? 0) * .75;
  const saturation = 1 + (values.saturation ?? 0) / 100;
  const warmth = (values.temperature ?? 0) * .30;
  const tint = (values.tint ?? 0) * .22;
  const highlights = (values.highlights ?? 0) * .55;
  const shadows = (values.shadows ?? 0) * .55;
  const tones = Float32Array.from({ length: 256 }, (_, index) => {
    const normalized = index / 255;
    const linear = (normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4) * gain;
    const exposed = gain === 1 ? index : (linear <= .0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - .055) * 255;
    return Math.max(0, Math.min(255, (exposed - 127.5) * contrast + 127.5 + brightness));
  });

  return (pixels: Uint8ClampedArray) => {
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 0) continue;
      const red = tones[pixels[i]];
      const green = tones[pixels[i + 1]];
      const blue = tones[pixels[i + 2]];
      const luminance = red * .2126 + green * .7152 + blue * .0722;
      const light = luminance / 255;
      const dark = 1 - light;
      const mid = luminance + highlights * light * light + shadows * dark * dark;
      const colorWeight = Math.min(1, luminance / 48);
      pixels[i] = mid + (red - luminance) * saturation + (warmth + tint * .5) * colorWeight;
      pixels[i + 1] = mid + (green - luminance) * saturation - tint * colorWeight;
      pixels[i + 2] = mid + (blue - luminance) * saturation + (tint * .5 - warmth) * colorWeight;
    }
  };
}

function sampleImage(context: CanvasRenderingContext2D, image: SourceImage, area: SourceArea, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const sample = canvas.getContext('2d', { willReadFrequently: true })!;
  sample.imageSmoothingEnabled = context.imageSmoothingEnabled;
  sample.imageSmoothingQuality = context.imageSmoothingQuality;
  sample.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, width, height);
  return sample;
}

// Sample at the painted resolution, with power-of-two buckets to reuse a source while zooming.
// The caller still uses the original source geometry for crop and tile placement.
export function adjustedImageSample(context: CanvasRenderingContext2D, image: SourceImage, area: SourceArea,
  paintedWidth: number, paintedHeight: number, values?: ImageAdjustments): HTMLCanvasElement | undefined {
  if (!values || !hasImageAdjustments(values) || area.width <= 0 || area.height <= 0) return undefined;
  const matrix = context.getTransform();
  const diagonal = Math.hypot(context.canvas.width, context.canvas.height);
  const paintedScale = Math.max(Math.min(diagonal, Math.hypot(matrix.a, matrix.b) * paintedWidth) / area.width,
    Math.min(diagonal, Math.hypot(matrix.c, matrix.d) * paintedHeight) / area.height);
  const scale = Math.min(1, 2 ** Math.ceil(Math.log2(paintedScale)),
    16384 / Math.max(area.width, area.height), Math.sqrt(24_000_000 / (area.width * area.height)));
  const width = Math.max(1, Math.round(area.width * scale));
  const height = Math.max(1, Math.round(area.height * scale));

  if (width * height > maxCachedSamplePixels) {
    const target = sampleImage(context, image, area, width, height);
    const adjust = pixelAdjuster(values);
    const rows = Math.max(1, Math.floor(262144 / width));
    for (let y = 0; y < height; y += rows) {
      const band = target.getImageData(0, y, width, Math.min(rows, height - y));
      adjust(band.data);
      target.putImageData(band, 0, y);
    }
    return target.canvas;
  }

  let sourceId = sourceIds.get(image);
  if (sourceId === undefined) {
    sourceId = nextSourceId++;
    sourceIds.set(image, sourceId);
  }
  const smoothing = context.imageSmoothingEnabled ? context.imageSmoothingQuality : 'off';
  const key = [sourceId, area.x, area.y, area.width, area.height, width, height, smoothing].join(':');
  const settings = IMAGE_ADJUSTMENT_KEYS.map(field => values[field] ?? 0).join(':');
  let sample = samples.get(key);
  if (sample) {
    samples.delete(key);
  } else {
    while (cachedPixels + width * height > maxCachedPixels) {
      const oldest = samples.entries().next().value;
      if (!oldest) break;
      const [oldKey, old] = oldest;
      samples.delete(oldKey);
      cachedPixels -= old.original.width * old.original.height;
    }
    const target = sampleImage(context, image, area, width, height);
    sample = { canvas: target.canvas, original: target.getImageData(0, 0, width, height), settings: '' };
    cachedPixels += width * height;
  }
  if (sample.settings !== settings) {
    const pixels = new ImageData(new Uint8ClampedArray(sample.original.data), width, height);
    pixelAdjuster(values)(pixels.data);
    sample.canvas.getContext('2d')!.putImageData(pixels, 0, 0);
    sample.settings = settings;
  }
  samples.set(key, sample);
  return sample.canvas;
}
