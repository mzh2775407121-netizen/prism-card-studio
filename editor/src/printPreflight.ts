import JSZip from 'jszip';
import { effectInProduction, getStockReflection, plateFor, type CardNode, type CardSide, type Effect, type Project, type Region, type SideName } from './model';
import { activeImageFill } from './layerAppearance';
import { isOutsidePrintSafeArea } from './PrintGuides';
import { imageCrop, loadImage, makeCanvas, renderCard, renderEffectMask } from './render';
import { DIE_SHAPES, FACE_LABELS, PLATE_LABELS, productionSteps } from './production';
import { PRINT_SAFE_MARGIN_MM, printSpotNames, projectPrintProfile, validSpotName, type PrintJobProfile, type TechnicalPrintProfile } from './printProfiles';
import { effectiveStockSpec, needsStockFinishMatch, stockDelivery, stockPreset, STOCK_CORES, STOCK_FINISH_METHODS } from './stockMaterials';

export type PreflightTarget = { side: SideName; nodeId?: string; effectId?: string; material?: boolean };
export type PreflightIssue = { target: PreflightTarget; text: string; blocking: boolean };

function effectivePpi(node: CardNode, image: HTMLImageElement) {
  const fill = activeImageFill(node);
  if (fill?.fit === 'contain') return 254 / Math.min(node.width / image.naturalWidth, node.height / image.naturalHeight);
  const crop = imageCrop(image, { ...node, crop: fill?.crop });
  return Math.min(crop.width / node.width, crop.height / node.height) * 254;
}

const availableFonts = new Set<string>();
function fontAvailable(context: CanvasRenderingContext2D, families: string) {
  const normalized = families.split(',').map(value => value.trim().replace(/^['"]|['"]$/g, ''));
  if (normalized.some(value => /^(?:sans-serif|serif|monospace|system-ui|cursive|fantasy)$/i.test(value))) return true;
  if (availableFonts.has(families)) return true;
  const probe = 'MW@~%āЬfij23409';
  const result = normalized.some(font => ['serif', 'monospace'].some(fallback => {
    context.font = `48px ${fallback}`;
    const baseline = context.measureText(probe).width;
    context.font = `48px ${JSON.stringify(font)}, ${fallback}`;
    return Math.abs(context.measureText(probe).width - baseline) > .01;
  }));
  if (result) availableFonts.add(families);
  return result;
}

function linkedMaskNode(face: CardSide, region: Region) {
  return region.binding === 'fixed' && region.snapshot ? region.snapshot : face.nodes.find(node => node.id === region.nodeId);
}

function hasBrushMask(face: CardSide, region: Region | undefined, visited = new Set<string>()): boolean {
  if (!region || visited.has(region.id)) return false;
  visited.add(region.id);
  if (region.kind === 'paint' || region.strokes.length) return true;
  const ids = [...region.sources ?? [], linkedMaskNode(face, region)?.clipRegionId];
  return ids.some(id => id && hasBrushMask(face, face.regions.find(item => item.id === id), visited));
}

type MaskPixels = { effect: Effect; width: number; height: number; scale: number; left: number; top: number; right: number; bottom: number; pixels: Uint8Array };
async function analyzeMask(project: Project, face: CardSide, effect: Effect): Promise<MaskPixels> {
  const span = Math.max(project.widthMm, project.heightMm) + 2 * project.bleedMm;
  const scale = Math.min(1.2, 900 / (span * 10));
  const canvas = await renderEffectMask(project, face, effect, scale, true);
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 1;
  const pixels = new Uint8Array(width * height);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (data[index * 4 + 3] < 128) continue;
      pixels[index] = 1;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return { effect, width, height, scale, left, top, right, bottom, pixels };
}

async function hasPrintMaskCoverage(project: Project, face: CardSide, effect: Effect, dpi: number) {
  const canvas = await renderEffectMask(project, face, effect, dpi / 254, true);
  const { width, height } = canvas;
  const context = canvas.getContext('2d')!;
  try {
    for (let y = 0; y < height; y += 64) {
      const { data } = context.getImageData(0, y, width, Math.min(64, height - y));
      for (let index = 3; index < data.length; index += 4) if (data[index] > 127) return true;
    }
    return false;
  } finally {
    canvas.width = canvas.height = 1;
  }
}

function inkDistance(masks: MaskPixels[], within: number) {
  const { width, height } = masks[0];
  const distance = new Float32Array(width * height).fill(Infinity);
  for (const { pixels } of masks) {
    for (let index = 0; index < pixels.length; index++) {
      if (pixels[index]) distance[index] = 0;
    }
  }
  if (!within) return distance;
  const diagonal = Math.SQRT2;
  // 8-neighbour distance bounds same-resolution Euclidean separation
  // conservatively. Use it for confident conflicts, not false-precision claims.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x > 0) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
      if (y > 0) {
        distance[i] = Math.min(distance[i], distance[i - width] + 1);
        if (x > 0) distance[i] = Math.min(distance[i], distance[i - width - 1] + diagonal);
        if (x < width - 1) distance[i] = Math.min(distance[i], distance[i - width + 1] + diagonal);
      }
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y < height - 1) {
        distance[i] = Math.min(distance[i], distance[i + width] + 1);
        if (x > 0) distance[i] = Math.min(distance[i], distance[i + width - 1] + diagonal);
        if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + width + 1] + diagonal);
      }
    }
  }
  return distance;
}

function requestedDimensions(project: Project, dpi: number) {
  const scale = dpi / 25.4;
  return [project.widthMm, project.heightMm].map(side => Math.round((side + 2 * project.bleedMm) * scale)) as [number, number];
}

function scopedIssues(project: Project, sides: SideName[], dpi: number, profile: PrintJobProfile, technical: TechnicalPrintProfile) {
  const target = { side: sides[0] ?? 'front', material: true } as const;
  const issues: PreflightIssue[] = [];
  const block = (text: string) => issues.push({ target, text, blocking: true });
  if (![project.production?.printer, project.production?.stockCode, profile.product, profile.version, profile.reference]
    .every(value => value?.trim())) block('请填写印厂、产品、材料料号、厂规版本和依据。');
  if (Math.abs(project.widthMm - profile.widthMm) > .005 || Math.abs(project.heightMm - profile.heightMm) > .005) {
    block(`成品尺寸须符合厂规 ${profile.widthMm} × ${profile.heightMm} mm。`);
  }
  if (Math.abs(project.bleedMm - profile.bleedMm) > .005) block(`出血须符合厂规 ${profile.bleedMm} mm。`);
  if (profile.safeMm * 2 >= Math.min(project.widthMm, project.heightMm)) block('厂规安全区内缩超过卡面可用范围。');
  if (profile.dpi !== dpi) block(`所选厂规要求 ${profile.dpi} PPI。`);
  if ((profile.faces === 'both' && (!sides.includes('front') || !sides.includes('back'))) ||
      (profile.faces === 'front' && (sides.length !== 1 || sides[0] !== 'front'))) {
    block(profile.faces === 'both' ? '所选厂规要求交付正反两面。' : '所选厂规要求仅交付正面。');
  }
  if (profile.colorRequirement === 'icc') block(profile.iccName.trim()
    ? `当前导出无法生成印厂所需的 ${profile.iccName.trim()} 输出条件。可改用技术打样包供确认。`
    : '请填写厂规要求的 ICC 或输出条件。');
  if (profile.route === 'specialty') {
    if (profile.requireVectorPlates) block('所选厂规要求矢量工艺版。当前独立工艺 PDF 由栅格蒙版生成，可另用技术打样包沟通。');
    if (Object.values(profile.spotNames).some(value => value?.trim() && !validSpotName(value))) {
      block('专色名仅支持 1–64 位英文字母、数字、下划线、连字符或英文句点。');
    }
    const names = Object.values(printSpotNames(project, technical));
    if (new Set(names).size !== names.length || names.includes('CutContour')) block('专色名称不能与其它通道或刀线重名。');
  }
  return issues;
}

async function bleedCoverage(project: Project, side: SideName) {
  const scale = Math.min(.6, 640 / (Math.max(project.widthMm, project.heightMm) * 10));
  const artwork = await renderCard(project, side, { scale, bleed: true, transparentGround: true, effects: false, material: false });
  const { width, height } = artwork;
  const inset = Math.max(1, Math.round(project.bleedMm * 10 * scale));
  const data = artwork.getContext('2d')!.getImageData(0, 0, width, height).data;
  artwork.width = artwork.height = 1;
  const directions = ['上', '右', '下', '左'];
  const gaps: string[] = [];
  for (const [index, direction] of directions.entries()) {
    const horizontal = index % 2 === 0;
    // Sample one pixel inside the edge to allow the preview canvas to round up.
    const position = index === 0 || index === 3 ? 1 : (horizontal ? height : width) - 2;
    const start = Math.min(inset, Math.floor((horizontal ? width : height) / 3));
    const end = (horizontal ? width : height) - start;
    let openings = 0;
    for (let i = start; i < end; i++) {
      const x = horizontal ? i : position, y = horizontal ? position : i;
      if (data[(y * width + x) * 4 + 3] < 245) openings++;
    }
    if (openings > Math.max(1, (end - start) * .01)) gaps.push(direction);
  }
  return gaps;
}

export async function printPreflight(project: Project, sides: SideName[], technical: TechnicalPrintProfile,
  dpi: number, signal?: AbortSignal, applyFactory = true): Promise<PreflightIssue[]> {
  const profile = applyFactory ? projectPrintProfile(project) : undefined;
  const issues: PreflightIssue[] = profile ? scopedIssues(project, sides, dpi, profile, technical) : [];
  if (!sides.length || (project.singleSided && sides.includes('back'))) {
    issues.push({ target: { side: 'front', material: true }, text: '请选择当前工程可交稿的卡面。', blocking: true });
    return issues;
  }
  const target: PreflightTarget = { side: sides[0], material: true };
  const [width, height] = requestedDimensions(project, dpi);
  if (profile?.route !== 'raster' && (project.widthMm < 20 || project.widthMm > 300 || project.heightMm < 20 || project.heightMm > 300)) {
    issues.push({ target, text: '技术分版的成品宽高必须在 20–300 mm 之间。', blocking: true });
  }
  if (width * height > 24_000_000 || Math.max(width, height) > 16_384) {
    issues.push({ target, text: '含出血输出超过 2400 万像素或单边 16384 像素，请调整输出尺寸。', blocking: true });
    return issues;
  }
  const safeMm = profile?.safeMm ?? PRINT_SAFE_MARGIN_MM;
  const minPpi = profile?.minImagePpi || 300;
  await document.fonts.ready;
  signal?.throwIfAborted();
  const context = makeCanvas(1, 1).getContext('2d')!;
  for (const side of sides) {
    signal?.throwIfAborted();
    const face = project[side];
    const label = FACE_LABELS[side];
    const effects = face.effects.filter(effectInProduction);
    if (needsStockFinishMatch(project, side)) {
      issues.push({ target: { side, material: true }, blocking: Boolean(profile),
        text: `${label}底材反光待印厂确认，请匹配用料及加工方式。` });
      const related = new Set(effects.flatMap(effect => {
        const channel = plateFor(effect);
        return channel === 'white' || channel === 'primer' || channel === 'foil' || channel === 'clear' ? [PLATE_LABELS[channel]] : [];
      }));
      if (related.size) issues.push({ target: { side, material: true }, blocking: false,
        text: `请按${label}的新底材与反光用料复核${[...related].join('、')}工艺版。` });
    }
    const add = (text: string, blocking = false, nodeId?: string, effectId?: string) =>
      issues.push({ text, blocking, target: { side, nodeId, effectId } });
    const nodes = face.nodes.filter(node => node.visible && node.opacity > 0 && node.type !== 'empty');
    if (!nodes.length) add(`${label}没有可见彩稿，将导出空白彩稿`);
    const imageProbes = await Promise.allSettled([...new Set(nodes.flatMap(node => {
      const source = activeImageFill(node)?.src;
      return source ? [source] : [];
    }))].map(async source => [source, await loadImage(source)] as const));
    signal?.throwIfAborted();
    const loadedImages = new Map(imageProbes.flatMap(probe => probe.status === 'fulfilled' ? [probe.value] : []));
    for (const node of nodes) {
      const name = `${label}「${node.name || '未命名图层'}」`;
      const fill = activeImageFill(node);
      if (node.type === 'image' && (node.fillMode ?? 'image') === 'image' && !fill && !node.fillHidden) {
        add(name + '缺少图片', true, node.id);
      } else if (fill) {
        const image = loadedImages.get(fill.src);
        if (image) {
          const ppi = Math.floor(effectivePpi(node, image) + .05);
          if (ppi < minPpi) add(`${name}裁切后有效分辨率 ${ppi} PPI，低于 ${minPpi} PPI`, !!profile?.minImagePpi, node.id);
        } else {
          add(name + '图片无法读取，请重新上传', true, node.id);
        }
      }
      if (node.type === 'text') {
        if (node.text?.trim() && isOutsidePrintSafeArea(node, project, safeMm)) {
          add(`${name}超出正文安全区（内缩 ${safeMm} mm）`, false, node.id);
        }
        if (node.text?.trim() && node.fontFamily && !fontAvailable(context, node.fontFamily)) {
          add(name + '所选字体未加载，当前使用回退字体', false, node.id);
        }
      }
      if (node.clipRegionId && !face.regions.some(region => region.id === node.clipRegionId)) {
        add(name + '的裁切蒙版找不到', true, node.id);
      }
    }
    signal?.throwIfAborted();
    if (profile?.route !== 'raster' && effects.filter(plateFor).length > 64) {
      add(label + '超过 64 个独立工艺层，请调整本次印刷范围', true);
    }
    const masks: MaskPixels[] = [];
    for (const effect of effects) {
      const name = `${label}「${effect.name || '未命名工艺层'}」`;
      const channel = plateFor(effect);
      const region = face.regions.find(item => item.id === effect.regionId);
      if (!region || region.kind === 'node' && !region.bounds && !linkedMaskNode(face, region)) {
        add(name + '缺少作用区域或关联图层', true, undefined, effect.id);
        continue;
      }
      if (effect.maskContent?.length === 0) {
        add(name + '的蒙版没有内容', !!channel, undefined, effect.id);
        continue;
      }
      if (!channel) continue;
      if (!effect.name.trim()) add(label + '有工艺层缺少名称', true, undefined, effect.id);
      if (profile?.route === 'raster') {
        add(name + '需要独立工艺版，请改用技术打样或取消纳入印刷输出', true, undefined, effect.id);
        continue;
      }
      if (technical === 'alternate' && channel === 'foil' && hasBrushMask(face, region)) {
        add(name + '含笔刷区域。技术配置 B 的箔版要求几何轮廓', true, undefined, effect.id);
      }
      if (getStockReflection(project, side) === 'none' && channel === 'white') {
        add(name + '使用白墨，请与印厂确认覆盖率及附着条件', false, undefined, effect.id);
      }
      try {
        const mask = await analyzeMask(project, face, effect);
        signal?.throwIfAborted();
        if (mask.right < 0) {
          const hasCoverage = await hasPrintMaskCoverage(project, face, effect, dpi);
          signal?.throwIfAborted();
          if (!hasCoverage) add(name + '在含出血范围内没有有效覆盖，请检查轮廓、图片和作用区域', true, undefined, effect.id);
          continue;
        }
        if (profile?.route === 'specialty') {
          const pixelsPerMm = mask.scale * 10;
          const shortSideMm = (Math.min(mask.right - mask.left, mask.bottom - mask.top) + 2) / pixelsPerMm;
          if (profile.minPlateWidthMm > shortSideMm) {
            add(`${name}整层短边低于厂规线宽 ${profile.minPlateWidthMm} mm`, true, undefined, effect.id);
          } else if (profile.minPlateWidthMm > 0) {
            add(`${name}包含小于 ${profile.minPlateWidthMm} mm 的局部细节时需人工核对`, false, undefined, effect.id);
          }
          const margin = Math.min(mask.left, mask.top, mask.width - 1 - mask.right, mask.height - 1 - mask.bottom) -
            project.bleedMm * pixelsPerMm;
          if (profile.plateTrimMarginMm > 0 && profile.plateTrimMarginMm > (margin + 1) / pixelsPerMm) {
            add(`${name}距离裁切边不足 ${profile.plateTrimMarginMm} mm`, true, undefined, effect.id);
          }
          if ((!profile.foilWhiteOverlap || profile.whiteFoilGapMm > 0) && (channel === 'white' || channel === 'foil')) masks.push(mask);
        }
      } catch (error) {
        signal?.throwIfAborted();
        add(name + '的蒙版无法渲染，请检查关联素材', true, undefined, effect.id);
      }
    }
    if (profile?.route === 'specialty' && masks.length > 1) {
      const whites = masks.filter(mask => plateFor(mask.effect) === 'white');
      const foils = masks.filter(mask => plateFor(mask.effect) === 'foil');
      if (whites.length && foils.length) {
        const gap = Math.max(0, profile.whiteFoilGapMm * whites[0].scale * 10 - 1);
        const distance = inkDistance(whites, gap);
        for (const foil of foils) {
          const overlap = !profile.foilWhiteOverlap && foil.pixels.some((ink, index) => ink > 0 && distance[index] === 0);
          if (overlap) add(`${label}「${foil.effect.name}」与白墨区重叠`, true, undefined, foil.effect.id);
          else if (profile.whiteFoilGapMm > 0 && foil.pixels.some((ink, index) => ink > 0 && distance[index] <= gap)) {
            add(`${label}「${foil.effect.name}」距白墨区不足 ${profile.whiteFoilGapMm} mm`, true, undefined, foil.effect.id);
          }
        }
      }
    }
    if (profile?.requireBleedArtwork && project.bleedMm > 0) {
      try {
        const gaps = await bleedCoverage(project, side);
        signal?.throwIfAborted();
        if (gaps.length) add(`${label}${gaps.join('、')}边图文未覆盖出血，请延伸背景`, true);
      } catch (error) {
        signal?.throwIfAborted();
        add(label + '无法检查出血，请检查图文素材', true);
      }
    }
  }
  const steps = productionSteps(project, project.production, sides);
  const positions = new Map(steps.map((step, index) => [step.id, index]));
  steps.forEach((step, index) => {
    if (!step.requiresStepId) return;
    const required = positions.get(step.requiresStepId);
    if (required !== undefined && required < index) return;
    const prior = steps.find(candidate => candidate.id === step.requiresStepId);
    issues.push({
      text: prior ? `「${step.name}」须排在「${prior.name}」之后` : `「${step.name}」的前置工序不在当前交稿范围`,
      blocking: true, target: { side: step.face === 'both' ? sides[0] ?? 'front' : step.face, effectId: step.layerId, material: !step.layerId },
    });
  });
  return issues;
}

export function orientPrintCanvas(canvas: HTMLCanvasElement, side: SideName, profile?: PrintJobProfile) {
  if (side !== 'back' || !profile || profile.backOrientation === 'normal') return canvas;
  const output = makeCanvas(canvas.width, canvas.height);
  const context = output.getContext('2d')!;
  if (profile.backOrientation === 'rotate180') context.setTransform(-1, 0, 0, -1, canvas.width, canvas.height);
  else context.setTransform(-1, 0, 0, 1, canvas.width, 0);
  context.drawImage(canvas, 0, 0);
  return output;
}

function pngDensity(bytes: Uint8Array, dpi: number) {
  // Browser canvases encode nominal density as 96 PPI. Write the requested
  // density into pHYs and replace any prior pHYs without touching image data.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = new Uint8Array(21);
  const data = new DataView(chunk.buffer);
  data.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4);
  data.setUint32(8, Math.round(dpi / .0254));
  data.setUint32(12, Math.round(dpi / .0254));
  chunk[16] = 1;
  let crc = -1;
  for (const value of chunk.subarray(4, 17)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  data.setUint32(17, (crc ^ -1) >>> 0);
  const parts = [bytes.slice(0, 8)];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset) + 12;
    const type = view.getUint32(offset + 4);
    if (size > bytes.length - offset) throw new Error('PNG 文件结构无效');
    if (type !== 0x70485973) parts.push(bytes.slice(offset, offset + size));
    if (type === 0x49484452) parts.push(chunk);
    offset += size;
  }
  return new Blob(parts, { type: 'image/png' });
}

function jpegDensity(bytes: Uint8Array, dpi: number) {
  const jfif = new Uint8Array([255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
  if (bytes[2] === 255 && bytes[3] === 224 && bytes[6] === 74 && bytes[7] === 70 && bytes[8] === 73 && bytes[9] === 70) {
    return new Blob([bytes.slice(0, 2), jfif, bytes.slice(4 + (bytes[4] << 8) + bytes[5])], { type: 'image/jpeg' });
  }
  return new Blob([bytes.slice(0, 2), jfif, bytes.slice(2)], { type: 'image/jpeg' });
}

async function rasterFile(canvas: HTMLCanvasElement, profile: PrintJobProfile) {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    data => data ? resolve(data) : reject(new Error('无法生成交稿图片，请降低分辨率后重试')),
    `image/${profile.rasterFormat}`, .98));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return profile.rasterFormat === 'jpeg' ? jpegDensity(bytes, profile.dpi) : pngDensity(bytes, profile.dpi);
}

export async function exportFactoryRaster(project: Project, sides: SideName[], signal?: AbortSignal,
  preflight?: PreflightIssue[], includeGrain = false) {
  const production = project.production;
  const profile = production?.printProfile;
  if (!production || profile?.route !== 'raster') throw new Error('请选择普通彩印的图片交稿方式');
  const issues = preflight ?? await printPreflight(project, sides, 'standard', profile.dpi, signal);
  if (issues.some(issue => issue.blocking)) throw new Error('请先处理印前检查的阻塞问题');
  const selected = (['front', 'back'] as const).filter(side => sides.includes(side));
  const faceFinishes = stockDelivery(project, selected);
  if (faceFinishes.some(finish => finish.status === 'pending')) throw new Error('请先确认各交稿卡面的底材反光');
  const zip = new JSZip();
  const files: Array<{ path: string; role: 'artwork' | 'report' | 'instructions'; side?: SideName; bytes: number; sha256: string }> = [];
  const addFile = async (path: string, bytes: ArrayBuffer, role: typeof files[number]['role'], side?: SideName) => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    files.push({ path, role, side, bytes: bytes.byteLength, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') });
    zip.file(path, bytes);
  };
  for (const side of selected) {
    signal?.throwIfAborted();
    const digitalEffects = project[side].effects.filter(effect => !plateFor(effect) && effectInProduction(effect))
      .map(effect => ({ ...effect, visible: true }));
    const artwork = includeGrain ? { ...project, [side]: { ...project[side], effects: digitalEffects } } : project;
    const rendered = await renderCard(artwork, side, { scale: profile.dpi / 254, bleed: true, effects: includeGrain, material: false });
    const canvas = orientPrintCanvas(rendered, side, profile);
    const data = await rasterFile(canvas, profile);
    const path = `${side}.${profile.rasterFormat === 'jpeg' ? 'jpg' : 'png'}`;
    await addFile(path, await data.arrayBuffer(), 'artwork', side);
    if (canvas !== rendered) canvas.width = canvas.height = 1;
    rendered.width = rendered.height = 1;
  }
  const createdAt = new Date().toISOString();
  const stockSpec = effectiveStockSpec(project);
  const projectInfo = {
    id: project.id, cardId: project.cardId ?? project.id + '_1', name: project.name, version: project.version,
    widthMm: project.widthMm, heightMm: project.heightMm, bleedMm: project.bleedMm,
    material: stockPreset(project.material)?.name ?? project.material, stockSpec, faceFinishes,
  };
  const report = {
    schemaVersion: 1,
    project: projectInfo,
    printer: production.printer, stockCode: production.stockCode, profile, createdAt,
    scope: 'RGB template upload', productionApproved: false, colorSpace: 'sRGB', sides: selected,
    flashTreatment: includeGrain ? 'artwork' : 'preview',
    trim: DIE_SHAPES[production.dieShape], pixels: requestedDimensions(project, profile.dpi),
    preflight: issues, files: [...files],
  };
  const { grammageGsm, thicknessMm, core } = stockSpec ?? {};
  const stockDetails = [
    projectInfo.material,
    grammageGsm !== undefined && `${grammageGsm} g/m²`,
    thicknessMm !== undefined && `${thicknessMm} mm`,
    core && STOCK_CORES[core],
  ].filter(Boolean);
  const instructions = [
    `${project.name} · ${selected.map(side => FACE_LABELS[side]).join('、')}`,
    `卡牌标识 ${projectInfo.cardId} · 源版本 ${project.version}`,
    `${production.printer} · ${profile.product} · 厂规 ${profile.version}`,
    `料号 ${production.stockCode} · ${profile.widthMm} × ${profile.heightMm} mm · 出血 ${profile.bleedMm} mm · ${profile.dpi} PPI`,
    `卡基 ${stockDetails.join(' · ')}`,
    ...faceFinishes.map(finish => [
      `${FACE_LABELS[finish.side]}底材反光 ${finish.label}`,
      finish.materialCode && `反光料号 ${finish.materialCode}`,
      finish.patternCode && `纹样号 ${finish.patternCode}`,
      finish.orientationDeg !== undefined && `纹向 ${finish.orientationDeg}°`,
      finish.method && STOCK_FINISH_METHODS[finish.method],
      finish.transparent !== undefined && (finish.transparent ? '反光材料透光' : '反光材料不透光'),
    ].filter(Boolean).join(' · ')),
    `厂规依据 ${profile.reference}`, '', '提交以下图片，其余文件供核对。', ...files.map(file => file.path),
  ].join('\n');
  const encode = new TextEncoder();
  await addFile('交稿说明.txt', encode.encode(instructions).buffer, 'instructions');
  await addFile('production-order.json', encode.encode(JSON.stringify({
    schemaVersion: 1, project: projectInfo, printer: production.printer,
    stockCode: production.stockCode, factoryProfile: profile, productionApproved: false,
    artwork: report.files,
  }, null, 2)).buffer, 'instructions');
  await addFile('preflight-report.json', encode.encode(JSON.stringify(report, null, 2)).buffer, 'report');
  zip.file('manifest.json', JSON.stringify({ projectId: project.id, cardId: projectInfo.cardId, version: project.version, createdAt, files }, null, 2));
  signal?.throwIfAborted();
  return zip.generateAsync({ type: 'blob' });
}
