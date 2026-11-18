import { getFlashStyle, getStockReflection, processKind, processLayerEnabled, type CardSide, type FlashStyle, type Project, type SideName } from './model';
import { makeCanvas, renderCard, renderEffectMask } from './render';

async function lightingMask(project: Project, face: SideName, scale: number) {
  const mask = makeCanvas(project.widthMm * 10 * scale, project.heightMm * 10 * scale);
  const context = mask.getContext('2d')!;
  const side = project[face];
  const active = side.effects.filter(processLayerEnabled);
  if (getStockReflection(project) !== 'none') {
    context.fillStyle = 'rgba(255,255,255,.27)';
    context.fillRect(0, 0, mask.width, mask.height);
    context.globalCompositeOperation = 'destination-out';
    for (const effect of active.filter(effect => processKind(effect) === 'white')) {
      context.drawImage(await renderEffectMask(project, side, effect, scale), 0, 0);
    }
    context.globalCompositeOperation = 'source-over';
  }
  for (const effect of active) {
    const kind = processKind(effect);
    if (effect.opacity <= 0 || (kind !== 'foil' && kind !== 'varnish' && kind !== 'emboss' && kind !== 'deboss')) continue;
    context.globalAlpha = effect.opacity * .8;
    context.drawImage(await renderEffectMask(project, side, effect, scale), 0, 0);
  }
  return mask;
}

export interface InspectorFlash {
  id: string;
  style: FlashStyle;
  mask: string;
  angle: number;
  opacity: number;
}

export interface InspectorFace { artwork: string; glare: string; flashes: InspectorFlash[] }

function flashMasks(project: Project, side: CardSide, scale: number): Promise<InspectorFlash[]> {
  const regions = new Set(side.regions.map(region => region.id));
  const effects = side.effects.filter(effect => effect.visible && effect.opacity > 0 &&
    processKind(effect) === 'reflection' && effect.maskContent?.length !== 0 && regions.has(effect.regionId));
  return Promise.all(effects.map(async effect => ({
    id: effect.id,
    style: getFlashStyle(project, effect),
    mask: (await renderEffectMask(project, side, effect, scale)).toDataURL('image/png'),
    angle: effect.angle,
    opacity: effect.opacity,
  })));
}

const cachedFaces = new WeakMap<CardSide, Map<string, Promise<InspectorFace>>>();

export function loadInspectorFace(project: Project, face: SideName) {
  const faceData = project[face];
  let cache = cachedFaces.get(faceData);
  if (!cache) {
    cache = new Map();
    cachedFaces.set(faceData, cache);
  }
  const key = [project.widthMm, project.heightMm, project.material, getStockReflection(project), project.previewStyle].join('/');
  const cached = cache.get(key);
  if (cached) return cached;
  const scale = Math.min(1.5, 1320 / (Math.max(project.widthMm, project.heightMm) * 10));
  // The editor and the card inspector use the same layer styles. Motion only changes the light.
  const loading = document.fonts.ready.then(() => Promise.all([
    renderCard(project, face, { scale, localFlash: false }),
    lightingMask(project, face, scale),
    flashMasks(project, faceData, scale),
  ])).then(([artwork, glare, flashes]) => ({
    artwork: artwork.toDataURL('image/png'),
    glare: glare.toDataURL('image/png'),
    flashes,
  })).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, loading);
  return loading;
}
