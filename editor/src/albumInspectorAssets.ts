import { getCardCornerRadiusMm, getFlashStyle, processKind, processLayerEnabled, type CardSide, type FlashStyle, type Project, type SideName } from './model';
import { loadImage, makeCanvas, prepareStockOptics, renderArtworkLayers, renderCard, renderEffectMask, renderEffects, renderStockGround } from './render';
import { getStockAppearance, type StockOptics } from './stockOptics';

async function lightingMask(project: Project, face: SideName, scale: number) {
  const side = project[face];
  const active = side.effects.filter(processLayerEnabled);
  const highlights = active.filter(effect => effect.opacity > 0 && ['foil', 'varnish', 'emboss', 'deboss'].includes(processKind(effect)));
  if (!highlights.length) return undefined;
  const mask = makeCanvas(project.widthMm * 10 * scale, project.heightMm * 10 * scale);
  const context = mask.getContext('2d')!;
  for (const effect of highlights) {
    context.globalAlpha = effect.opacity * .8;
    context.drawImage(await renderEffectMask(project, side, effect, scale), 0, 0);
  }
  return mask;
}

export interface InspectorFlash {
  id: string;
  style: FlashStyle;
  mask: HTMLCanvasElement;
  pattern?: HTMLCanvasElement;
  stars?: HTMLCanvasElement;
  angle: number;
  opacity: number;
}

export interface InspectorFace {
  base: HTMLCanvasElement;
  artwork: Awaited<ReturnType<typeof renderArtworkLayers>>;
  surface?: HTMLCanvasElement;
  optics?: StockOptics;
  glare?: HTMLCanvasElement;
  flashes: InspectorFlash[];
}

const patterns = new Map<string, Promise<HTMLCanvasElement>>();

function patternMask(style: string) {
  const cached = patterns.get(style);
  if (cached) return cached;
  const files = style === 'stars' ? ['cosmos-middle-trans.png', 'cosmos-top-trans.png']
    : [style === 'cosmos' ? 'cosmos-bottom.png' : style + '.png'];
  const pending = Promise.all(files.map(file => loadImage('/assets/album/' + file))).then(images => {
    const canvas = makeCanvas(images[0].naturalWidth, images[0].naturalHeight);
    const context = canvas.getContext('2d')!;
    for (const image of images) context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (style !== 'stars') {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        pixels.data[i + 3] *= (pixels.data[i] * .2126 + pixels.data[i + 1] * .7152 + pixels.data[i + 2] * .0722) / 255;
      }
      context.putImageData(pixels, 0, 0);
    }
    return canvas;
  }).catch(error => {
    patterns.delete(style);
    throw error;
  });
  patterns.set(style, pending);
  return pending;
}

function flashMasks(project: Project, side: CardSide, scale: number): Promise<InspectorFlash[]> {
  const regions = new Set(side.regions.map(region => region.id));
  const effects = side.effects.filter(effect => effect.visible && effect.opacity > 0 &&
    processKind(effect) === 'reflection' && effect.maskContent?.length !== 0 && regions.has(effect.regionId));
  return Promise.all(effects.map(async effect => {
    const style = getFlashStyle(project, effect);
    const [mask, pattern, stars] = await Promise.all([
      renderEffectMask(project, side, effect, scale),
      style === 'linear' || style === 'radial' ? undefined : patternMask(style),
      style === 'cosmos' ? patternMask('stars') : undefined,
    ]);
    return { id: effect.id, style, mask, pattern, stars, angle: effect.angle, opacity: effect.opacity };
  }));
}

export async function prepareInspectorFace(project: Project, face: SideName, scale: number, effects = true): Promise<InspectorFace> {
  await document.fonts.ready;
  const side = project[face];
  const hasSurface = effects && side.effects.some(effect => effect.visible && effect.opacity > 0 &&
    ['foil', 'varnish', 'emboss', 'deboss'].includes(processKind(effect)));
  const optics = effects ? await prepareStockOptics(project, side, scale) : undefined;
  const [base, artwork, surface, glare, flashes] = await Promise.all([
    optics ? renderStockGround(project, side, scale) : renderCard(project, face, { scale, effects: false }),
    optics ? renderArtworkLayers(project, side, scale) : [],
    hasSurface ? renderEffects(project, side, scale, 0, false) : undefined,
    effects ? lightingMask(project, face, scale) : undefined,
    effects ? flashMasks(project, side, scale) : [],
  ]);
  return { base, artwork, surface, optics, glare, flashes };
}

const cachedFaces = new WeakMap<CardSide, Map<string, Promise<InspectorFace>>>();

export function loadInspectorFace(project: Project, face: SideName) {
  const faceData = project[face];
  let cache = cachedFaces.get(faceData);
  if (!cache) {
    cache = new Map();
    cachedFaces.set(faceData, cache);
  }
  const { style, match } = getStockAppearance(project, face);
  const key = [project.widthMm, project.heightMm, getCardCornerRadiusMm(project), project.material,
    style, project.previewStyle, match?.method, match?.orientationDeg, match?.transparent].join('/');
  const cached = cache.get(key);
  if (cached) return cached;
  const scale = Math.min(1.5, 1000 / (Math.max(project.widthMm, project.heightMm) * 10));
  const loading = prepareInspectorFace(project, face, scale).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, loading);
  return loading;
}
