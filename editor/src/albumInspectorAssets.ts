import { getStockReflection, processKind, processLayerEnabled, type CardSide, type Project, type SideName } from './model';
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
    if (processKind(effect) === 'white' || !effect.opacity) continue;
    context.globalAlpha = effect.opacity * .8;
    context.drawImage(await renderEffectMask(project, side, effect, scale), 0, 0);
  }
  return mask;
}

export interface InspectorFace { artwork: string; glare: string }

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
  const loading = Promise.all([
    renderCard(project, face, { scale }),
    lightingMask(project, face, scale),
  ]).then(([artwork, glare]) => ({
    artwork: artwork.toDataURL('image/png'),
    glare: glare.toDataURL('image/png'),
  })).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, loading);
  return loading;
}
