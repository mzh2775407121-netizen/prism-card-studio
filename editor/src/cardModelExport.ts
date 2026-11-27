import { getCardCornerRadiusMm, getStockFinish, processKind, processLayerEnabled, type Project, type SideName } from './model';
import { renderFlatCardTexture } from './stillExport';
import { encodeDigitalImage } from './digitalImage';
import { isTransparentStock, stockPreset } from './stockMaterials';
import { stockFinishVisible } from './stockOptics';
import { supportsMaterialModel, type ModelShading } from './modelMaterialSupport';

const MODEL_THICKNESS_MM = .32;
const METRES_PER_MM = .001;
const EXPORT_TEXTURE_EDGE = 4096;
const PREVIEW_TEXTURE_EDGE = 2048;
const FACE_WORK_BYTES = 320 * 1024 * 1024;
const CORNER_ERROR_M = .002 * METRES_PER_MM;
const align4 = (value: number) => Math.ceil(value / 4) * 4;
type Point = { x: number; y: number };
type Vec3 = [number, number, number];
type ModelOptions = {
  preview?: boolean;
  shading?: ModelShading;
  resampling: 'high' | 'medium';
  signal?: AbortSignal;
};

function roundedOutline(halfWidth: number, halfHeight: number, radius: number) {
  const corners = [
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
  ];
  if (radius < 1e-7) return corners;
  const maxStepAngle = 4 * Math.asin(Math.sqrt(Math.min(1, CORNER_ERROR_M / (2 * radius))));
  const steps = Math.max(8, Math.ceil(Math.PI / 2 / maxStepAngle));
  const outline: Point[] = [];
  corners.forEach((corner, index) => {
    const centerX = corner.x - Math.sign(corner.x) * radius;
    const centerY = corner.y - Math.sign(corner.y) * radius;
    for (let step = 0; step <= steps; step++) {
      const angle = (index + step / steps) * Math.PI / 2;
      const point = { x: Math.fround(centerX + radius * Math.cos(angle)), y: Math.fround(centerY + radius * Math.sin(angle)) };
      const previous = outline.at(-1);
      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 1e-9) {
        outline.push(point);
      }
    }
  });
  const first = outline[0];
  const last = outline.at(-1)!;
  if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9) outline.pop();
  return outline;
}

function textureScale(project: Project, side: SideName, maxEdge: number) {
  const card = project[side];
  const reflective = stockFinishVisible(getStockFinish(project, side));
  const kinds = card.effects.filter(processLayerEnabled).map(processKind);
  const flashMasks = kinds.filter(kind => kind === 'reflection').length;
  const whiteMasks = kinds.filter(kind => kind === 'white').length;
  const finish = kinds.some(kind => kind === 'foil' || kind === 'varnish' || kind === 'emboss' || kind === 'deboss');
  const clipMasks = new Set<string>();
  let blendPasses = 0;
  let previousBlend: string | undefined;
  for (const node of card.nodes) {
    if (!node.visible || node.opacity <= 0 || node.type === 'empty') continue;
    if (node.clipRegionId) clipMasks.add(node.clipRegionId);
    const blend = node.blend || 'source-over';
    if (blend !== 'source-over' || blend !== previousBlend) blendPasses++;
    previousBlend = blend;
  }
  // Account for full-face RGBA canvases retained by the still renderer.
  let buffers = 4 + clipMasks.size + (clipMasks.size > 0 ? 1 : 0) + flashMasks;
  if (reflective || flashMasks > 0) buffers += 2;
  if (reflective) buffers += blendPasses + 1;
  if (finish) buffers += 4;
  if (reflective || isTransparentStock(project.material)) buffers += whiteMasks;

  const longest = Math.max(project.widthMm, project.heightMm);
  const widthRatio = project.widthMm / longest;
  const heightRatio = project.heightMm / longest;
  const budgetEdge = Math.sqrt(FACE_WORK_BYTES / (4 * buffers * widthRatio * heightRatio));
  const edge = Math.max(1, Math.floor(Math.min(maxEdge, budgetEdge)));
  return edge / (longest * 10);
}

async function renderTexture(project: Project, side: SideName, options: ModelOptions) {
  options.signal?.throwIfAborted();
  const scale = textureScale(project, side, options.preview ? PREVIEW_TEXTURE_EDGE : EXPORT_TEXTURE_EDGE);
  const canvas = await renderFlatCardTexture(project, side, scale, options.resampling);
  try {
    options.signal?.throwIfAborted();
    const dpi = Math.max(1, Math.round(canvas.height * 25.4 / project.heightMm));
    const png = await encodeDigitalImage(canvas, 'png', dpi, { failureMessage: '无法生成 3D 模型贴图' });
    options.signal?.throwIfAborted();
    return png;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function buildCardModel(project: Project, options: ModelOptions): Promise<Blob> {
  options.signal?.throwIfAborted();
  if (options.shading === 'pbr') {
    if (!supportsMaterialModel(project)) throw new Error('当前卡牌的基材和工艺仅支持保色模型');
    const { buildMaterialModelTrial } = await import('./materialModelTrial');
    const maxEdge = options.preview ? 1536 : 3072;
    const scale = Math.min(textureScale(project, 'front', maxEdge),
      project.singleSided ? Infinity : textureScale(project, 'back', maxEdge));
    const edge = Math.max(1, Math.round(scale * 10 * Math.max(project.widthMm, project.heightMm)));
    return buildMaterialModelTrial(project, edge, options.signal, options.resampling);
  }
  const front = await renderTexture(project, 'front', options);
  const back = project.singleSided ? undefined : await renderTexture(project, 'back', options);
  options.signal?.throwIfAborted();
  return packCardModel(project, { color: front }, back ? { color: back } : undefined, 'unlit');
}

export type ModelFaceTextures = { color: Blob; metallicRoughness?: Blob };

export function packCardModel(project: Project, front: ModelFaceTextures, back: ModelFaceTextures | undefined,
  shading: ModelShading): Blob {
  const stock = stockPreset(project.material);
  const configuredThickness = project.stockSpec?.thicknessMm;
  const presetThickness = stock?.defaults.thicknessMm;
  const thicknessMm = configuredThickness ?? presetThickness ?? MODEL_THICKNESS_MM;
  const thicknessSource = configuredThickness !== undefined ? 'configured' : presetThickness !== undefined ? 'preset' : 'reference';
  const cornerRadiusMm = getCardCornerRadiusMm(project);
  const halfWidth = Math.fround(project.widthMm * METRES_PER_MM / 2);
  const halfHeight = Math.fround(project.heightMm * METRES_PER_MM / 2);
  const halfThickness = thicknessMm * METRES_PER_MM / 2;
  const radius = Math.min(halfWidth, halfHeight, cornerRadiusMm * METRES_PER_MM);
  const outline = roundedOutline(halfWidth, halfHeight, radius);

  const parts: BlobPart[] = [];
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = [];
  const accessors: { bufferView: number; componentType: number; count: number; type: string; min?: Vec3; max?: Vec3 }[] = [];
  const primitives: { attributes: Record<string, number>; indices: number; material: number }[] = [];
  let byteLength = 0;

  function addBufferView(data: ArrayBuffer | Blob, target?: number) {
    const length = data instanceof Blob ? data.size : data.byteLength;
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: length, target });
    parts.push(data);
    const padding = align4(length) - length;
    if (padding) parts.push(new ArrayBuffer(padding));
    byteLength += length + padding;
    return index;
  }

  function addPrimitive(positions: number[], normals: number[], indices: number[], material: number, uv?: number[]) {
    const points = Float32Array.from(positions);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < points.length; index += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], points[index + axis]);
        max[axis] = Math.max(max[axis], points[index + axis]);
      }
    }
    const positionAccessor = accessors.length;
    accessors.push(
      { bufferView: addBufferView(points.buffer, 34962), componentType: 5126, count: points.length / 3, type: 'VEC3', min, max },
      { bufferView: addBufferView(Float32Array.from(normals).buffer, 34962), componentType: 5126, count: points.length / 3, type: 'VEC3' },
    );
    const attributes: Record<string, number> = { POSITION: positionAccessor, NORMAL: positionAccessor + 1 };
    if (uv) {
      attributes.TEXCOORD_0 = accessors.length;
      accessors.push({ bufferView: addBufferView(Float32Array.from(uv).buffer, 34962), componentType: 5126, count: uv.length / 2, type: 'VEC2' });
    }
    const indexAccessor = accessors.length;
    accessors.push({ bufferView: addBufferView(Uint16Array.from(indices).buffer, 34963), componentType: 5123, count: indices.length, type: 'SCALAR' });
    primitives.push({ attributes, indices: indexAccessor, material });
  }

  function addFace(isBack: boolean) {
    const z = isBack ? -halfThickness : halfThickness;
    const vertices = [{ x: 0, y: 0 }, ...outline];
    const indices: number[] = [];
    outline.forEach((_, index) => {
      const current = index + 1;
      const next = (index + 1) % outline.length + 1;
      indices.push(...(isBack ? [0, next, current] : [0, current, next]));
    });
    // The back reads left to right when the card is rotated around its vertical axis.
    const uv = !isBack || back ? vertices.flatMap(({ x, y }) => [
      .5 + (isBack ? -x : x) / (2 * halfWidth), .5 - y / (2 * halfHeight),
    ]) : undefined;
    addPrimitive(vertices.flatMap(({ x, y }) => [x, y, z]),
      vertices.flatMap(() => [0, 0, isBack ? -1 : 1]), indices, isBack ? 1 : 0, uv);
  }

  addFace(false);
  addFace(true);

  const edge: number[] = [];
  const edgeNormals: number[] = [];
  const edgeIndices: number[] = [];
  outline.forEach((point, index) => {
    const next = outline[(index + 1) % outline.length];
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    const length = Math.hypot(dx, dy);
    for (const { x, y } of [point, next]) {
      edge.push(x, y, halfThickness, x, y, -halfThickness);
      edgeNormals.push(dy / length, -dx / length, 0, dy / length, -dx / length, 0);
    }
    const offset = index * 4;
    edgeIndices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
  });
  addPrimitive(edge, edgeNormals, edgeIndices, 2);

  const images: { bufferView: number; mimeType: string }[] = [];
  function addImage(data: Blob) {
    return images.push({ bufferView: addBufferView(data), mimeType: 'image/png' }) - 1;
  }
  const frontImage = addImage(front.color);
  const backImage = back && addImage(back.color);
  const frontPbr = front.metallicRoughness && addImage(front.metallicRoughness);
  const backPbr = back?.metallicRoughness && addImage(back.metallicRoughness);
  const stockColor = stock?.color ?? '#f6f3eb';
  const stockFactor = [1, 3, 5].map(offset => {
    const srgb = Number.parseInt(stockColor.slice(offset, offset + 2), 16) / 255;
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
  });
  const transparent = shading === 'pbr' && isTransparentStock(project.material);
  const cardMaterial = (name: string, texture?: number, pbr?: number) => ({
    name,
    pbrMetallicRoughness: {
      ...(texture === undefined ? { baseColorFactor: [...stockFactor, transparent ? .06 : 1] } : { baseColorTexture: { index: texture } }),
      ...(pbr === undefined ? {} : { metallicRoughnessTexture: { index: pbr } }),
      metallicFactor: pbr === undefined ? 0 : 1,
      roughnessFactor: shading === 'unlit' || pbr !== undefined ? 1 : transparent ? .48 : .8,
    },
    ...(shading === 'unlit' ? { extensions: { KHR_materials_unlit: {} } } : {}),
    ...(transparent ? { alphaMode: 'BLEND', doubleSided: true } : {}),
  });
  const document = {
    asset: { version: '2.0', generator: 'Prism', extras: {
      thicknessMm,
      thicknessSource,
      dimensionsMm: { width: project.widthMm, height: project.heightMm, thickness: thicknessMm, cornerRadius: cornerRadiusMm },
    } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: project.name || '卡牌', mesh: 0 }],
    meshes: [{ primitives }],
    ...(shading === 'unlit' ? { extensionsUsed: ['KHR_materials_unlit'], extensionsRequired: ['KHR_materials_unlit'] } : {}),
    materials: [cardMaterial('正面', frontImage, frontPbr), cardMaterial('背面', backImage, backPbr), cardMaterial('卡边')],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    textures: images.map((_, source) => ({ sampler: 0, source })),
    images,
    buffers: [{ byteLength }],
    bufferViews,
    accessors,
  };
  const json = new TextEncoder().encode(JSON.stringify(document));
  const paddedJson = new Uint8Array(align4(json.length)).fill(0x20);
  paddedJson.set(json);
  const header = new DataView(new ArrayBuffer(20));
  header.setUint32(0, 0x46546c67, true); // glTF
  header.setUint32(4, 2, true);
  header.setUint32(8, 28 + paddedJson.length + byteLength, true);
  header.setUint32(12, paddedJson.length, true);
  header.setUint32(16, 0x4e4f534a, true); // JSON
  const binary = new DataView(new ArrayBuffer(8));
  binary.setUint32(0, byteLength, true);
  binary.setUint32(4, 0x004e4942, true); // BIN
  return new Blob([header.buffer, paddedJson, binary.buffer, ...parts], { type: 'model/gltf-binary' });
}
