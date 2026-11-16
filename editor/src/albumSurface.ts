import { loadImage, makeCanvas, renderCard, renderRegionMask } from './render';
import type { Project, SideName } from './model';

export const PREVIEW_STYLES = {
  cosmos: { label: '星空闪', texture: 'cosmos-bottom.png', strength: .76 },
  geometric: { label: '几何镭射', texture: 'geometric.png', strength: .6 },
  glitter: { label: '细闪', texture: 'glitter.png', strength: .7 },
  original: { label: '工艺本色', texture: '', strength: 0 },
} as const;
export type PreviewStyle = keyof typeof PREVIEW_STYLES;
export interface LightPoint { x: number; y: number; strength: number }
export const neutralLight: LightPoint = { x: .43, y: .4, strength: .54 };

const textureCache = new Map<string, Promise<HTMLCanvasElement>>();

function reflectionTexture(file: string) {
  const existing = textureCache.get(file);
  if (existing) return existing;
  const loading = loadImage('/assets/album/' + file).then(image => {
    const texture = makeCanvas(image.width, image.height);
    const context = texture.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, texture.width, texture.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const luminance = Math.max(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) / 255;
      const coverage = Math.max(0, (luminance - .06) / .94);
      pixels.data[i + 3] = Math.round(pixels.data[i + 3] * coverage ** 1.45);
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return texture;
  }).catch(error => { textureCache.delete(file); throw error; });
  textureCache.set(file, loading);
  return loading;
}

async function reflectiveMask(project: Project, face: SideName, scale: number) {
  const width = project.widthMm * 10 * scale;
  const height = project.heightMm * 10 * scale;
  const mask = makeCanvas(width, height);
  const context = mask.getContext('2d')!;
  const side = project[face];
  const effects = side.effects.filter(effect => effect.visible && effect.opacity > 0);
  const regionMasks = new Map<string, Promise<HTMLCanvasElement>>();
  const forRegion = (id: string) => {
    const cached = regionMasks.get(id);
    if (cached) return cached;
    const region = side.regions.find(item => item.id === id);
    if (!region) return undefined;
    const result = renderRegionMask(project, side, region, scale);
    regionMasks.set(id, result);
    return result;
  };
  if (project.material === 'holo' || project.material === 'silver') {
    context.fillStyle = 'rgba(255,255,255,.21)';
    context.fillRect(0, 0, mask.width, mask.height);
    context.globalCompositeOperation = 'destination-out';
    for (const effect of effects.filter(item => item.type === 'white')) {
      const regionMask = await forRegion(effect.regionId);
      if (regionMask) context.drawImage(regionMask, 0, 0);
    }
    context.globalCompositeOperation = 'source-over';
  }
  for (const effect of effects) {
    if (!['holo', 'gold', 'silver', 'gloss', 'emboss', 'grain'].includes(effect.type)) continue;
    const regionMask = await forRegion(effect.regionId);
    if (!regionMask) continue;
    const treatment = effect.type === 'holo' || effect.type === 'silver' ? 1 : .38;
    context.globalAlpha = Math.min(1, effect.opacity * 2.3) * treatment;
    context.drawImage(regionMask, 0, 0);
  }
  return mask;
}

export async function prepareAlbumSurface(project: Project, face: SideName, scale: number, style: PreviewStyle) {
  const preset = PREVIEW_STYLES[style];
  const side = project[face];
  const baseProject = style === 'original' ? project : {
    ...project,
    [face]: { ...side, effects: side.effects.map(effect => effect.type === 'holo' ? { ...effect, opacity: effect.opacity * .35 } : effect) },
  };
  const [base, mask, texture] = await Promise.all([
    renderCard(baseProject, face, { scale, effects: true, material: style === 'original' || !['holo', 'silver'].includes(project.material) }),
    reflectiveMask(project, face, scale),
    preset.texture ? reflectionTexture(preset.texture) : Promise.resolve(null),
  ]);
  const { width, height } = base;
  const scratch = makeCanvas(width, height);
  const shine = scratch.getContext('2d')!;

  return {
    width, height,
    draw(target: HTMLCanvasElement, light: LightPoint = neutralLight) {
      if (target.width !== width) target.width = width;
      if (target.height !== height) target.height = height;
      const context = target.getContext('2d')!;
      context.clearRect(0, 0, width, height);
      context.drawImage(base, 0, 0);
      const px = light.x * width;
      const py = light.y * height;
      const radius = Math.hypot(width, height);
      shine.clearRect(0, 0, width, height);
      if (texture) {
        const ratio = style === 'geometric' ? .56 * width / texture.width : 1.18 * Math.max(width / texture.width, height / texture.height);
        const tileW = texture.width * ratio;
        const tileH = texture.height * ratio;
        const dx = (light.x - .5) * width * .15;
        const dy = (light.y - .5) * height * .11;
        for (let y = dy - tileH; y < height; y += tileH) {
          for (let x = dx - tileW; x < width; x += tileW) shine.drawImage(texture, x, y, tileW, tileH);
        }
        shine.globalCompositeOperation = 'source-in';
        const phase = (light.x * 1.75 + light.y * .7) * 160;
        const spectrum = shine.createLinearGradient(px - radius * .36, py - radius * .25, px + radius * .3, py + radius * .4);
        const colors = [25, 70, 145, 200, 258, 325, 385];
        colors.forEach((hue, i) => spectrum.addColorStop(i / (colors.length - 1), 'hsl(' + ((hue + phase) % 360) + ' 82% 72%)'));
        shine.fillStyle = spectrum;
        shine.fillRect(0, 0, width, height);
        shine.globalCompositeOperation = 'destination-in';
        const falloff = shine.createRadialGradient(px, py, 0, px, py, radius * .72);
        falloff.addColorStop(0, '#fff');
        falloff.addColorStop(.43, 'rgba(255,255,255,.68)');
        falloff.addColorStop(1, 'rgba(255,255,255,.03)');
        shine.fillStyle = falloff;
        shine.fillRect(0, 0, width, height);
        shine.drawImage(mask, 0, 0);
        shine.globalCompositeOperation = 'source-over';
        context.globalCompositeOperation = 'screen';
        context.globalAlpha = preset.strength * light.strength;
        context.drawImage(scratch, 0, 0);
      }
      shine.clearRect(0, 0, width, height);
      const glare = shine.createRadialGradient(px, py, 0, px, py, radius * .55);
      glare.addColorStop(0, 'rgba(249,255,246,.56)');
      glare.addColorStop(.27, 'rgba(226,246,255,.22)');
      glare.addColorStop(1, 'rgba(255,255,255,0)');
      shine.fillStyle = glare;
      shine.fillRect(0, 0, width, height);
      shine.globalCompositeOperation = 'destination-in';
      shine.drawImage(mask, 0, 0);
      shine.globalCompositeOperation = 'source-over';
      context.globalCompositeOperation = 'screen';
      context.globalAlpha = light.strength * .62;
      context.drawImage(scratch, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
    },
  };
}

export async function renderPreviewImage(project: Project, face: SideName, scale: number, style: PreviewStyle) {
  const canvas = makeCanvas(1, 1);
  const surface = await prepareAlbumSurface(project, face, scale, style);
  surface.draw(canvas);
  return canvas;
}
