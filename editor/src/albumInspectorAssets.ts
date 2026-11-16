import { makeCanvas, renderCard, renderRegionMask } from './render';
import type { PreviewStyle } from './albumSurface';
import type { CardSide, Project, SideName } from './model';

export const inspectorRarity: Record<PreviewStyle, string> = {
  cosmos: 'rare holo cosmos',
  geometric: 'rare secret',
  glitter: 'rare rainbow alt',
  original: 'process',
};

async function createMask(project: Project, face: SideName, scale: number, kind: 'foil' | 'glare') {
  const mask = makeCanvas(project.widthMm * 10 * scale, project.heightMm * 10 * scale);
  const context = mask.getContext('2d')!;
  const side = project[face];
  const active = side.effects.filter(effect => effect.visible && effect.opacity > 0);
  const regions = new Map<string, HTMLCanvasElement>();
  for (const effect of active) {
    if (regions.has(effect.regionId)) continue;
    const region = side.regions.find(item => item.id === effect.regionId);
    if (region) regions.set(region.id, await renderRegionMask(project, side, region, scale));
  }
  if (project.material === 'holo' || project.material === 'silver') {
    context.fillStyle = kind === 'foil' ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.33)';
    context.fillRect(0, 0, mask.width, mask.height);
    context.globalCompositeOperation = 'destination-out';
    for (const effect of active) {
      const region = regions.get(effect.regionId);
      if (effect.type === 'white' && region) context.drawImage(region, 0, 0);
    }
    context.globalCompositeOperation = 'source-over';
  }
  for (const effect of active) {
    const region = regions.get(effect.regionId);
    if (!region || effect.type === 'white') continue;
    const isFoil = ['holo', 'gold', 'silver', 'grain'].includes(effect.type);
    if (!isFoil && kind === 'foil') continue;
    context.globalAlpha = effect.opacity ** (effect.type === 'holo' ? .25 : .75);
    context.drawImage(region, 0, 0);
  }
  return mask;
}

export interface InspectorFace {
  artwork: string;
  mask: string;
  glare: string;
}

const cachedFaces = new WeakMap<CardSide, Map<string, Promise<InspectorFace>>>();

export function loadInspectorFace(project: Project, face: SideName, style: PreviewStyle) {
  const faceData = project[face];
  let cache = cachedFaces.get(faceData);
  if (!cache) {
    cache = new Map();
    cachedFaces.set(faceData, cache);
  }
  const key = [project.widthMm, project.heightMm, project.material, style === 'original'].join('/');
  const cached = cache.get(key);
  if (cached) return cached;
  const scale = Math.min(1.5, 1320 / (Math.max(project.widthMm, project.heightMm) * 10));
  // Keep the metal and relief details underneath the moving foil and glare.
  const artworkProject = style === 'original' ? project : {
    ...project,
    [face]: {
      ...faceData,
      effects: faceData.effects.filter(effect => ['gold', 'silver', 'emboss'].includes(effect.type))
        .map(effect => ({ ...effect, opacity: effect.opacity * .74 })),
    },
  };
  const loading = Promise.all([
    renderCard(artworkProject, face, { scale, effects: true, material: style === 'original' || !['holo', 'silver'].includes(project.material) }),
    createMask(project, face, scale, 'foil'),
    createMask(project, face, scale, 'glare'),
  ]).then(([artwork, mask, glare]) => ({
    artwork: artwork.toDataURL('image/png'),
    mask: mask.toDataURL('image/png'),
    glare: glare.toDataURL('image/png'),
  })).catch(error => {
    cache?.delete(key);
    throw error;
  });
  cache.set(key, loading);
  return loading;
}
