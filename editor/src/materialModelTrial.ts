import { packCardModel, type ModelFaceTextures } from './cardModelExport';
import { processKind, processLayerEnabled, type Project, type SideName } from './model';
import { renderCard, renderEffectMask } from './render';
import { isTransparentStock, stockPreset } from './stockMaterials';

function surface(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d')!;
}

function asPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成试验贴图')), 'image/png'));
}

async function physicalFace(project: Project, face: SideName, scale: number, signal?: AbortSignal, resampling: ImageSmoothingQuality = 'high'): Promise<ModelFaceTextures> {
  const side = project[face];
  const clear = isTransparentStock(project.material);
  const artwork = await renderCard(project, face, { scale, effects: false, transparentGround: true, resampling });
  const color = surface(artwork.width, artwork.height);
  const stock = stockPreset(project.material);
  color.fillStyle = stock?.color ?? '#f6f3eb';
  color.globalAlpha = clear ? .04 : 1;
  color.fillRect(0, 0, artwork.width, artwork.height);
  color.globalAlpha = 1;
  const scratch = surface(artwork.width, artwork.height);
  const roughness = surface(artwork.width, artwork.height);
  roughness.fillStyle = clear ? 'rgb(255 122 0)' : 'rgb(255 205 0)';
  roughness.fillRect(0, 0, artwork.width, artwork.height);
  const effects = side.effects.filter(processLayerEnabled);
  let hasFoil = false;

  // The same white plate backs the ink only where its mask has coverage.
  for (const effect of effects.filter(e => processKind(e) === 'white')) {
    signal?.throwIfAborted();
    const mask = await renderEffectMask(project, side, effect, scale, false, resampling);
    scratch.clearRect(0, 0, artwork.width, artwork.height);
    scratch.drawImage(mask, 0, 0);
    scratch.globalCompositeOperation = 'source-in';
    scratch.fillStyle = '#fff';
    scratch.fillRect(0, 0, artwork.width, artwork.height);
    scratch.globalCompositeOperation = 'source-over';
    color.drawImage(scratch.canvas, 0, 0);
  }
  // Ink density, PET transmission and surface roughness are sample values.
  color.globalAlpha = clear ? .68 : 1;
  color.drawImage(artwork, 0, 0);
  color.globalAlpha = 1;
  for (const effect of effects.filter(e => processKind(e) === 'foil')) {
    hasFoil = true;
    signal?.throwIfAborted();
    const mask = await renderEffectMask(project, side, effect, scale, false, resampling);
    scratch.clearRect(0, 0, artwork.width, artwork.height);
    scratch.drawImage(mask, 0, 0);
    scratch.globalCompositeOperation = 'source-in';
    scratch.fillStyle = effect.type === 'silver' ? '#e1e3e6' : '#ecd080';
    scratch.fillRect(0, 0, artwork.width, artwork.height);
    color.drawImage(scratch.canvas, 0, 0);
    // glTF reads roughness from G and metalness from B in linear data.
    scratch.fillStyle = 'rgb(255 55 245)';
    scratch.fillRect(0, 0, artwork.width, artwork.height);
    roughness.drawImage(scratch.canvas, 0, 0);
    scratch.globalCompositeOperation = 'source-over';
  }
  try {
    return { color: await asPng(color.canvas), metallicRoughness: hasFoil ? await asPng(roughness.canvas) : undefined };
  } finally {
    for (const canvas of [artwork, color.canvas, scratch.canvas, roughness.canvas]) canvas.width = canvas.height = 1;
  }
}

/** Separate trial for PET / white underprint and paper / local foil. The default export stays unlit. */
export async function buildMaterialModelTrial(project: Project, longestEdge = 1536, signal?: AbortSignal,
  resampling: ImageSmoothingQuality = 'high'): Promise<Blob> {
  signal?.throwIfAborted();
  if (!Number.isFinite(longestEdge) || longestEdge < 1 || longestEdge > 4096) throw new Error('试验贴图长边须在 1 到 4096 px 之间');
  const scale = longestEdge / (Math.max(project.widthMm, project.heightMm) * 10);
  const front = await physicalFace(project, 'front', scale, signal, resampling);
  signal?.throwIfAborted();
  const back = project.singleSided ? undefined : await physicalFace(project, 'back', scale, signal, resampling);
  signal?.throwIfAborted();
  return packCardModel(project, front, back, 'pbr');
}
