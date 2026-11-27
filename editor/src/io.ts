import JSZip from 'jszip';
import { get } from 'idb-keyval';
import {
  IMAGE_ADJUSTMENT_KEYS, MAX_LAYOUT_ITEM_OFFSET, PATTERN_TILE_SCALE, PROCESS_LABELS, hydrateProject, isStockReflection, isValidCanvasFacePositions, isValidProjectCover, isValidProjectNote, isValidStockFinish, isValidStockSpec,
  projectCards, serializeProject, type CardNode, type CardSide, type Project, type ProjectCard, type StoredProjectDocument,
} from './model';
import { MAX_LAYER_GROUP_NAME_LENGTH, MAX_LAYER_GROUPS } from './layerGroups';
import { MAX_PATH_POINTS } from './vectorPaths';
import { MAX_GRADIENT_STOPS, MIN_GRADIENT_STOPS, MAX_VISUAL_EFFECTS, MAX_STYLE_PRESETS, MAX_STYLE_PRESET_NAME } from './layerAppearance';
import { DIE_SHAPES, FACE_LABELS, MANUAL_OPERATIONS } from './production';
import { isPrintJobProfile } from './printProfiles';
import { MAX_TEXT_LENGTH, validTextStyles } from './textStyles';
import {
  artworkTextNodes, artworkFontProblem, assetBytes, BUILTIN_ARTWORK_FONTS, importArtworkFont, isArtworkFontReference,
  shareableProjectFont, type ArtworkFontReference,
} from './artworkFonts';

const STORE_KEY = 'prism-projects';
const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 24_000_000;
const FORMAT = 'prism-cardproj';
const ARCHIVE_VERSION = 3;
type ArchiveEntry = { path: string; sha256: string; size: number };
type Manifest = { format: string; version: number; files: ArchiveEntry[] };

export async function listLegacyProjects(): Promise<Project[]> {
  const projects = await get<Project[]>(STORE_KEY);
  return Array.isArray(projects)
    ? projects.filter(project => isObject(project) && typeof project.id === 'string' && typeof project.updatedAt === 'number')
      .sort((a, b) => b.updatedAt - a.updatedAt)
    : [];
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name.replace(/[\\/:*?"<>|]/g, '-');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function imageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  const header = new TextDecoder().decode(bytes.slice(0, 12));
  if (header.startsWith('RIFF') && header.endsWith('WEBP')) return 'image/webp';
  throw new Error('图片格式无法识别，请使用 PNG、JPEG 或 WebP。');
}

// Read dimensions before allocating decoded pixels, including for imported archives.
function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 24 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === 'image/jpeg') {
    let position = 2;
    while (position + 3 < bytes.length) {
      if (bytes[position++] !== 0xff) break;
      while (bytes[position] === 0xff) position++;
      const marker = bytes[position++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (position + 2 > bytes.length) break;
      const length = view.getUint16(position);
      if (length < 2 || position + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { width: view.getUint16(position + 5), height: view.getUint16(position + 3) };
      }
      position += length;
    }
  }
  if (mime === 'image/webp') {
    let position = 12;
    while (position + 8 <= bytes.length) {
      const kind = new TextDecoder().decode(bytes.subarray(position, position + 4));
      const length = view.getUint32(position + 4, true);
      const data = position + 8;
      if (data + length > bytes.length) break;
      if (kind === 'VP8X' && length >= 10) {
        return { width: 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16),
          height: 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16) };
      }
      if (kind === 'VP8 ' && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
        return { width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff };
      }
      if (kind === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
        const size = view.getUint32(data + 1, true);
        return { width: 1 + (size & 0x3fff), height: 1 + ((size >>> 14) & 0x3fff) };
      }
      position = data + length + (length % 2);
    }
  }
  throw new Error('图片尺寸无法读取，文件可能已损坏。');
}

export function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败，请重新选择。'));
    reader.readAsDataURL(blob);
  });
}

async function checkedImage(bytes: Uint8Array): Promise<{ src: string; width: number; height: number }> {
  assert(bytes.byteLength <= MAX_IMAGE_BYTES, '单张图片不能超过 20 MB。');
  const mime = imageMime(bytes);
  const dimensions = imageDimensions(bytes, mime);
  assert(dimensions.width > 0 && dimensions.height > 0 && dimensions.width * dimensions.height <= MAX_IMAGE_PIXELS, '图片不能超过 2400 万像素，请缩小后重新导入。');
  const blob = new Blob([bytes.slice().buffer], { type: mime });
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error('图片无法解码，文件可能已损坏。'); }
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  assert(width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS, '图片不能超过 2400 万像素，请缩小后重新导入。');
  return { src: await dataUrl(blob), width, height };
}

export async function readImage(file: File): Promise<{ src: string; width: number; height: number }> {
  assert(file.size > 0 && file.size <= MAX_IMAGE_BYTES, '请选择一张不超过 20 MB 的 PNG、JPEG 或 WebP 图片。');
  return checkedImage(new Uint8Array(await file.arrayBuffer()));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 300): value is string {
  return typeof value === 'string' && value.length <= max;
}

function number(value: unknown, min = -1_000_000, max = 1_000_000): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function pathCoordinate(value: unknown, min = 0, max = 1) {
  return isObject(value) && number(value.x, min, max) && number(value.y, min, max);
}

function validateNode(node: unknown): asserts node is CardNode {
  assert(isObject(node) && text(node.id) && node.id.length > 0, '图层标识缺失。');
  assert(text(node.name) && ['empty', 'image', 'text', 'rect', 'ellipse', 'polygon', 'line', 'path'].includes(String(node.type)), '图层类型或名称无效。');
  assert(number(node.x) && number(node.y) && number(node.width, 0.001, 100_000) && number(node.height, 0.001, 100_000) && number(node.rotation), '图层位置或尺寸无效。');
  validateLayoutItem(node.layoutItem);
  assert(node.printSafe === undefined || typeof node.printSafe === 'boolean', '正文安全区标记无效。');
  assert((node.flipX === undefined || typeof node.flipX === 'boolean') &&
    (node.flipY === undefined || typeof node.flipY === 'boolean'), '图层翻转状态无效。');
  assert(number(node.opacity, 0, 1) && typeof node.visible === 'boolean' && typeof node.locked === 'boolean' && text(node.fill), '图层外观数据无效。');
  if (node.type === 'image') assert(text(node.src, MAX_IMAGE_BYTES * 1.5) && node.src.length > 0, '图片素材缺失。');
  if (node.type === 'text') assert(text(node.text, MAX_TEXT_LENGTH) && number(node.fontSize, 0.1, 10_000), '文字内容或字号无效。');
  if (node.textStyles !== undefined) {
    assert(node.type === 'text' && text(node.text, MAX_TEXT_LENGTH) && validTextStyles(node.text, node.textStyles), '段内文字样式无效。');
  }
  if (node.verticalAlign !== undefined) assert(node.verticalAlign === 'top' || node.verticalAlign === 'middle' || node.verticalAlign === 'bottom', '文字垂直对齐无效。');
  if (node.lineHeight !== undefined) assert(number(node.lineHeight, .8, 3), '行距数据无效。');
  if (node.letterSpacing !== undefined) assert(number(node.letterSpacing, -100, 100), '字距数据无效。');
  if (node.cornerRadius !== undefined) assert(number(node.cornerRadius, 0, 100_000), '圆角数据无效。');
  if (node.strokeWidth !== undefined) assert(number(node.strokeWidth, 0, 1000), '描边宽度无效。');
  for (const key of ['fillOpacity', 'strokeOpacity']) {
    if (node[key] !== undefined) assert(number(node[key], 0, 1), '填充或描边透明度无效。');
  }
  for (const key of ['fillHidden', 'strokeHidden']) {
    if (node[key] !== undefined) assert(typeof node[key] === 'boolean', '填充或描边状态无效。');
  }
  if (node.fillMode !== undefined) assert(['solid', 'gradient', 'image', 'pattern'].includes(String(node.fillMode)), '填充类型无效。');
  if (node.fillMode === 'gradient') assert(node.gradient !== undefined, '缺少渐变设置。');
  if (node.fillMode === 'pattern') assert(node.imageFill !== undefined, '图案填充素材缺失。');
  if (node.imageFill !== undefined) {
    const fill = node.imageFill;
    assert(isObject(fill) && text(fill.src, MAX_IMAGE_BYTES * 1.5) && fill.src.length > 0, '图片填充素材无效。');
    assert(fill.fit === undefined || fill.fit === 'cover' || fill.fit === 'contain' || fill.fit === 'tile', '图片填充方式无效。');
    if (fill.tileScale !== undefined) assert(number(fill.tileScale, PATTERN_TILE_SCALE.min, PATTERN_TILE_SCALE.max), '图案平铺缩放无效。');
    if (fill.presetId !== undefined) assert(text(fill.presetId, 100) && !!fill.presetId.trim(), '图案预设标识无效。');
    if (fill.crop !== undefined) validateCrop(fill.crop);
    if (fill.adjustments !== undefined) {
      assert(isObject(fill.adjustments) && Object.entries(fill.adjustments).every(([key, value]) =>
        IMAGE_ADJUSTMENT_KEYS.some(field => field === key) && number(value, -100, 100)), '图片颜色调节数据无效。');
    }
  }
  if (node.strokeLineCap !== undefined) assert(['butt', 'round', 'square'].includes(String(node.strokeLineCap)), '描边端点无效。');
  if (node.strokeLineJoin !== undefined) assert(['miter', 'round', 'bevel'].includes(String(node.strokeLineJoin)), '描边连接无效。');
  if (node.strokeMiterLimit !== undefined) assert(number(node.strokeMiterLimit, 1, 1000), '描边斜接限制无效。');
  if (node.strokeAlign !== undefined) assert(['inside', 'center', 'outside'].includes(String(node.strokeAlign)), '描边位置无效。');
  if (node.strokeStyle !== undefined) assert(['solid', 'dashed', 'dotted'].includes(String(node.strokeStyle)), '描边样式无效。');
  for (const field of ['stroke', 'fontFamily', 'fontStyle', 'align', 'blend', 'groupId']) {
    if (node[field] !== undefined) assert(text(node[field]), '图层属性无效。');
  }
  if (node.fontRef !== undefined) assert(node.type === 'text' && isArtworkFontReference(node.fontRef), '文字字体引用无效。');
  if (node.clipRegionId !== undefined) assert(text(node.clipRegionId), '图层蒙版标识无效。');
  if (node.unclassified !== undefined) assert(typeof node.unclassified === 'boolean', '图层分类无效。');
  if (node.maskInk !== undefined) assert(node.maskInk === 'alpha' || node.maskInk === 'dark', '图片蒙版提取方式无效。');
  if (node.polygon !== undefined) {
    assert(Array.isArray(node.polygon) && node.polygon.length >= 6 && node.polygon.length <= 512
      && node.polygon.length % 2 === 0 && node.polygon.every(value => number(value, 0, 1)), '形状路径无效。');
  }
  if (node.type === 'line' || node.type === 'path') {
    const line = node.type === 'line';
    assert(node.pathClosed === undefined || (typeof node.pathClosed === 'boolean' && (!line || !node.pathClosed)), '路径闭合状态无效。');
    assert(node.fillRule === undefined || ['evenodd','nonzero'].includes(String(node.fillRule)), '路径填充规则无效。');
    assert(node.contours === undefined || (!line && node.pathClosed && Array.isArray(node.contours) && node.contours.length <= MAX_PATH_POINTS / 3), '复合路径轮廓无效。');
    const outlines = [node.pathPoints, ...(Array.isArray(node.contours) ? node.contours : [])];
    let pointCount = 0;
    for (const points of outlines) {
      assert(Array.isArray(points) && points.length >= (node.pathClosed ? 3 : 2) &&
        (pointCount += points.length) <= (line ? 2 : MAX_PATH_POINTS) && points.every(point => isObject(point) && pathCoordinate(point) &&
        (point.in === undefined || (!line && pathCoordinate(point.in))) &&
        (point.out === undefined || (!line && pathCoordinate(point.out)))), '线段或钢笔路径的锚点无效。');
    }
  }
  if (node.gradient !== undefined) validateGradient(node.gradient);
  if (node.visualEffects !== undefined) validateVisualEffects(node.visualEffects);
  if (node.crop !== undefined) validateCrop(node.crop);
}

function validateGradient(g: unknown) {
  assert(isObject(g) && number(g.angle) && Array.isArray(g.stops) && g.stops.length >= MIN_GRADIENT_STOPS && g.stops.length <= MAX_GRADIENT_STOPS
    && g.stops.every(stop => Array.isArray(stop) && stop.length === 2 && number(stop[0],0,1)
      && typeof stop[1] === 'string' && CSS.supports('color',stop[1])), '形状渐变无效。');
  if (g.kind !== undefined) assert(g.kind === 'linear' || g.kind === 'radial', '渐变类型无效。');
  if (g.stopIds !== undefined) assert(Array.isArray(g.stopIds) && g.stopIds.length === g.stops.length
    && g.stopIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)
    && new Set(g.stopIds).size === g.stopIds.length, '渐变色标标识无效。');
  if (g.endpoints !== undefined) assert(Array.isArray(g.endpoints) && g.endpoints.length === 2
    && g.endpoints.every(point => Array.isArray(point) && point.length === 2 && point.every(coordinate => number(coordinate, -2, 3))), '渐变端点无效。');
  if (g.radialAxis !== undefined) assert(g.kind === 'radial' && Array.isArray(g.endpoints)
    && Array.isArray(g.radialAxis) && g.radialAxis.length === 2
    && g.radialAxis.every(coordinate => number(coordinate, -5, 5)), '径向渐变副轴无效。');
}

function validateVisualEffects(effects: unknown) {
  assert(Array.isArray(effects) && effects.length <= MAX_VISUAL_EFFECTS, '图层效果数量无效。');
  const ids = new Set();
  for (const effect of effects) {
    assert(isObject(effect) && typeof effect.id === 'string' && effect.id.length > 0 && effect.id.length <= 128 &&
      !ids.has(effect.id) && typeof effect.enabled === 'boolean', '图层效果数据无效。');
    ids.add(effect.id);
    if (effect.kind === 'drop-shadow' || effect.kind === 'inner-shadow') {
      assert(number(effect.x, -500, 500) && number(effect.y, -500, 500) && number(effect.radius, 0, 500) &&
        number(effect.spread, -100, 100) && typeof effect.color === 'string' && CSS.supports('color', effect.color) &&
        number(effect.opacity, 0, 1), '阴影参数无效。');
    } else if (effect.kind === 'gaussian-blur') {
      assert(number(effect.radius, 0, 500), '高斯模糊半径无效。');
    } else {
      assert(effect.kind === 'radial-blur' && Array.isArray(effect.center) && effect.center.length === 2 &&
        effect.center.every(value => number(value,0,1)) && number(effect.strength,0,1), '径向模糊参数无效。');
    }
  }
}

function validateStylePresets(presets: unknown) {
  assert(Array.isArray(presets) && presets.length <= MAX_STYLE_PRESETS, '项目样式预设数量无效。');
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const preset of presets) {
    assert(isObject(preset) && text(preset.id,128) && !!preset.id && !ids.has(preset.id) &&
      text(preset.name,MAX_STYLE_PRESET_NAME) && !!preset.name.trim() && (preset.kind === 'gradient' || preset.kind === 'effects'),
      '项目样式预设无效。');
    const key = preset.kind + '/' + preset.name.trim().toLocaleLowerCase();
    assert(!names.has(key), '项目样式预设名称重复。');
    ids.add(preset.id);
    names.add(key);
    if (preset.kind === 'gradient') validateGradient(preset.gradient);
    else validateVisualEffects(preset.effects);
  }
}

function validateCrop(crop: unknown) {
  assert(isObject(crop) && number(crop.x, 0) && number(crop.y, 0) && number(crop.width, 0.001) && number(crop.height, 0.001), '图片裁切数据无效。');
  if (crop.space !== undefined) assert(crop.space === 'source' && crop.x + crop.width <= 1.00001 && crop.y + crop.height <= 1.00001, '图片裁切超出原图。');
}

function validateLayoutItem(item: unknown) {
  if (item === undefined) return;
  const modeAllowed = (mode: unknown) => mode === undefined || mode === 'fixed' || mode === 'hug' || mode === 'fill';
  assert(isObject(item) && modeAllowed(item.widthMode) && modeAllowed(item.heightMode), '自动布局子项的尺寸模式无效。');
  assert(item.absolute === undefined || item.absolute === true, '自动布局子项的自由定位状态无效。');
  assert((item.minWidth===undefined||number(item.minWidth,1,100_000))&&(item.minHeight===undefined||number(item.minHeight,1,100_000)), '自动布局子项的最小尺寸无效。');
  const offset = item.offset;
  assert(offset === undefined || (isObject(offset) &&
    number(offset.x, -MAX_LAYOUT_ITEM_OFFSET, MAX_LAYOUT_ITEM_OFFSET) &&
    number(offset.y, -MAX_LAYOUT_ITEM_OFFSET, MAX_LAYOUT_ITEM_OFFSET)), '自动布局子项的位置偏移无效。');
}

function validateAutoLayout(layout: unknown) {
  if (layout === undefined) return;
  const frameMode = (mode: unknown) => mode === 'fixed' || mode === 'hug';
  assert(isObject(layout) && number(layout.x) && number(layout.y) && number(layout.width, 0.001, 100_000) &&
    number(layout.height, 0.001, 100_000) && (layout.direction === 'vertical' || layout.direction === 'horizontal') &&
    frameMode(layout.widthMode) && frameMode(layout.heightMode) &&
    (layout.align === 'start' || layout.align === 'center' || layout.align === 'end') &&
    number(layout.gap, 0, 100_000), '自动布局组的尺寸或方向无效。');
  const insets = layout.padding;
  assert(isObject(insets) && ['top', 'right', 'bottom', 'left'].every(edge => number(insets[edge], 0, 100_000)), '自动布局的内边距无效。');
}

function validateLayerGroups(value: unknown, artworkIds: Set<string>, effectIds: Set<string>) {
  assert(Array.isArray(value) && value.length <= MAX_LAYER_GROUPS, '编组数据无效。');
  const parents = new Map<string, string | undefined>();
  for (const group of value) {
    assert(isObject(group) && text(group.id) && group.id.trim() && !parents.has(group.id) &&
      !artworkIds.has(group.id) && !effectIds.has(group.id), '编组标识缺失或重复。');
    assert(text(group.name, MAX_LAYER_GROUP_NAME_LENGTH) && group.name.trim(), '编组名称无效。');
    assert(group.parentId === undefined || (text(group.parentId) && group.parentId.trim()), '上级编组无效。');
    validateLayoutItem(group.layoutItem);
    validateAutoLayout(group.autoLayout);
    parents.set(group.id, group.parentId);
  }
  const checked = new Set<string>();
  for (const groupId of parents.keys()) {
    const chain = new Set<string>();
    for (let id: string | undefined = groupId; id !== undefined && !checked.has(id); id = parents.get(id)) {
      assert(parents.has(id) && !chain.has(id), '上级编组已缺失或编组存在循环引用。');
      chain.add(id);
    }
    for (const id of chain) checked.add(id);
  }
}

function validateSide(value: unknown): asserts value is CardSide {
  assert(isObject(value), '卡片正反面数据不完整。');
  assert(value.canvasLocked === undefined || typeof value.canvasLocked === 'boolean', '卡面锁定状态无效。');
  if (value.stockFinish !== undefined) assert(isValidStockFinish(value.stockFinish), '卡面反光参数无效。');
  if (value.reference !== undefined) {
    const reference = value.reference;
    assert(isObject(reference) && text(reference.name) && text(reference.src, MAX_IMAGE_BYTES * 1.5) && reference.src.length > 0, '参考图数据无效。');
  }
  assert(Array.isArray(value.nodes) && value.nodes.length <= 1000, '图层数据无效或超过 1000 个图层。');
  assert(Array.isArray(value.regions) && value.regions.length <= 1000, '区域数据无效。');
  assert(Array.isArray(value.effects) && value.effects.length <= 1000, '效果数据无效。');
  const ids = new Set<string>();
  for (const node of value.nodes) {
    validateNode(node);
    assert(!ids.has(node.id), '图层标识重复。');
    ids.add(node.id);
  }
  const regionIds = new Set<string>();
  for (const region of value.regions) {
    assert(isObject(region) && text(region.id) && region.id.length > 0 && !regionIds.has(region.id), '区域标识缺失或重复。');
    regionIds.add(region.id);
    assert(text(region.name) && ['full', 'border', 'node', 'paint', 'rect', 'ellipse', 'polygon', 'union'].includes(String(region.kind)), '区域类型无效。');
    assert(['fixed', 'follow'].includes(String(region.binding)) && typeof region.inverted === 'boolean', '区域定位数据无效。');
    if (region.groupMotionCopy !== undefined) assert(region.groupMotionCopy === true, '蒙版组合数据无效。');
    if (region.snapshot !== undefined) validateNode(region.snapshot);
    if (region.bounds !== undefined) {
      const bounds = region.bounds;
      assert(isObject(bounds) && number(bounds.x) && number(bounds.y) && number(bounds.width, 0.001) && number(bounds.height, 0.001) && number(bounds.rotation), '固定区域的尺寸无效。');
    }
    if (region.kind === 'node') {
      const linked = text(region.nodeId) && ids.has(region.nodeId);
      assert(linked || (region.binding === 'fixed' && (region.snapshot !== undefined || region.bounds !== undefined)), '有区域引用的图层已缺失。');
    }
    if (region.kind === 'polygon' || region.points !== undefined) {
      assert(Array.isArray(region.points) && region.points.length >= 6 && region.points.length <= 200_000 && region.points.length % 2 === 0 && region.points.every(point => number(point)), '多边形区域的顶点无效。');
    }
    if (region.kind === 'union') {
      assert(region.operation === undefined || ['union','intersection','subtract'].includes(String(region.operation)), '组合区域运算方式无效。');
      assert(Array.isArray(region.sources) && region.sources.length >= 2 && region.sources.length <= 16 &&
        region.sources.every(id => typeof id === 'string' && id !== region.id), '组合区域的来源无效。');
    }
    assert(Array.isArray(region.strokes) && region.strokes.length <= 10_000, '蒙版编辑数据无效。');
    for (const stroke of region.strokes) {
      assert(isObject(stroke) && typeof stroke.erase === 'boolean', '蒙版编辑参数无效。');
      if (stroke.kind === 'selection') {
        const points = stroke.pathPoints;
        assert(Array.isArray(points) && points.length >= 3 && points.length <= MAX_PATH_POINTS &&
          points.every(point => isObject(point) && pathCoordinate(point, -1_000_000, 1_000_000) &&
            (point.in === undefined || pathCoordinate(point.in, -1_000_000, 1_000_000)) &&
            (point.out === undefined || pathCoordinate(point.out, -1_000_000, 1_000_000))), '蒙版选区路径无效。');
      } else {
        assert(stroke.kind === undefined && Array.isArray(stroke.points) && stroke.points.length <= 200_000 && stroke.points.length % 2 === 0, '画笔路径无效。');
        assert(stroke.points.every(point => number(point)) && number(stroke.size, 0.1, 2000), '画笔参数无效。');
      }
    }
  }
  const byId = new Map(value.regions.map(region => [region.id, region]));
  const depths = new Map<string, number>();
  function sourceDepth(id: string, ancestors: Set<string>): number {
    assert(ancestors.size < 16 && !ancestors.has(id), '组合区域嵌套过深或包含循环。');
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const region = byId.get(id);
    assert(region, '组合区域的来源已缺失。');
    if (region.kind !== 'union') return 0;
    const next = new Set(ancestors).add(id);
    const depth = 1 + Math.max(...(region.sources as string[]).map(source => sourceDepth(source, next)));
    assert(depth < 16, '组合区域嵌套过深。');
    depths.set(id, depth);
    return depth;
  }
  for (const region of value.regions) if (region.kind === 'union') sourceDepth(region.id, new Set());
  for (const node of value.nodes) {
    if (node.clipRegionId !== undefined) assert(regionIds.has(node.clipRegionId), '彩稿图层的蒙版缺失。');
  }
  const effectIds = new Set<string>();
  for (const effect of value.effects) {
    assert(isObject(effect) && text(effect.id) && effect.id.length > 0 && !effectIds.has(effect.id), '效果标识缺失或重复。');
    effectIds.add(effect.id);
    assert(text(effect.name) && ['holo', 'gold', 'silver', 'gloss', 'emboss', 'grain', 'white'].includes(String(effect.type)), '效果类型无效。');
    assert(text(effect.regionId) && regionIds.has(effect.regionId), '效果引用的作用区域已缺失。');
    if (effect.process !== undefined) assert(Object.hasOwn(PROCESS_LABELS, String(effect.process)), '工艺类型无效。');
    if (effect.productionEnabled !== undefined) assert(typeof effect.productionEnabled === 'boolean', '工艺输出状态无效。');
    if (effect.pattern !== undefined) assert(['linear','radial','grain'].includes(String(effect.pattern)), '闪光纹样无效。');
    if (effect.flashStyle !== undefined) assert(['cosmos','geometric','glitter','linear','radial'].includes(String(effect.flashStyle)), '局部闪光样式无效。');
    if (effect.groupId !== undefined) assert(text(effect.groupId) && effect.groupId.trim(), '工艺图层编组标识无效。');
    if (effect.maskContent !== undefined) {
      assert(Array.isArray(effect.maskContent) && effect.maskContent.length <= 1000, '工艺蒙版内容无效。');
      const maskIds = new Set();
      for (const item of effect.maskContent) {
        validateNode(item);
        assert(!maskIds.has(item.id), '工艺蒙版内容标识重复。');
        if (item.clipRegionId !== undefined) assert(regionIds.has(item.clipRegionId), '工艺蒙版内容引用的裁切区域已缺失。');
        maskIds.add(item.id);
      }
    }
    assert(number(effect.opacity, 0, 1) && number(effect.angle) && typeof effect.visible === 'boolean', '效果参数无效。');
  }
  if (value.groups !== undefined) validateLayerGroups(value.groups, ids, effectIds);
}

export function validateCardDesign(value: unknown) {
  assert(isObject(value), '卡牌数据无效。');
  const validOwnedOrigin=(origin:unknown)=>isObject(origin)&&text(origin.assetId,128)&&!!origin.assetId&&
    number(origin.version,1,2**31-1)&&Number.isInteger(origin.version)&&text(origin.authorId,128)&&!!origin.authorId&&
    (origin.author===undefined||text(origin.author,128));
  if(value.assetOrigin!==undefined)assert(validOwnedOrigin(value.assetOrigin),'资产作者或版本无效。');
  if(value.assetFaceOrigins!==undefined)assert(isObject(value.assetFaceOrigins)&&
    Object.entries(value.assetFaceOrigins).every(([side,origin])=>['front','back'].includes(side)&&(origin===undefined||validOwnedOrigin(origin))), '卡面资产来源无效。');
  assert(number(value.widthMm, 10, 500) && number(value.heightMm, 10, 500) && number(value.bleedMm, 0, 20), '卡片尺寸应在 10–500 mm 之间，出血在 0–20 mm 之间。');
  if (value.cornerRadiusMm !== undefined) assert(number(value.cornerRadiusMm, 0, Math.min(value.widthMm, value.heightMm) / 2), '卡片圆角半径超出范围。');
  if (value.singleSided !== undefined) assert(typeof value.singleSided === 'boolean', '卡牌面数无效。');
  if (value.looseFace !== undefined) assert(value.looseFace === 'back' && value.singleSided === true, '独立卡面的方向无效。');
  assert(text(value.material), '卡牌材质无效。');
  if (value.previewStyle !== undefined) assert(['cosmos', 'geometric', 'glitter', 'original'].includes(String(value.previewStyle)), '预览样式无效。');
  if (value.stockReflection !== undefined) assert(isStockReflection(value.stockReflection), '底材反光类型无效。');
  if (value.stockSpec !== undefined) assert(isValidStockSpec(value.stockSpec), '卡基规格无效。');
  if (value.production !== undefined) {
    const plan = value.production;
    assert(isObject(plan) && Object.hasOwn(DIE_SHAPES, String(plan.dieShape)) && Array.isArray(plan.steps) && plan.steps.length <= 250, '工艺单格式无效。');
    if (plan.splitOrder !== undefined) {
      const split = plan.splitOrder;
      assert(isObject(split) && text(split.pair, 100) && Array.isArray(split.ids) && split.ids.length <= 250 &&
        split.ids.every(id => text(id, 330)) && isObject(split.crossDependencies) && Object.keys(split.crossDependencies).length <= 250 &&
        Object.entries(split.crossDependencies).every(([id, required]) => text(id, 330) && text(required, 330)), '拆分工序的记录无效。');
    }
    if (plan.printProfile !== undefined) assert(isPrintJobProfile(plan.printProfile), '印厂配置无效。');
    for (const [key, limit] of [['printer', 120], ['stockCode', 120], ['note', 1200]] as const) {
      assert(plan[key] === undefined || text(plan[key], limit), '工艺单说明无效。');
    }
    const ids = new Set<string>();
    for (const row of plan.steps) {
      assert(isObject(row) && text(row.id, 330) && !!row.id && !ids.has(row.id) &&
        (['artwork', 'layer', 'die'].includes(String(row.kind)) || Object.hasOwn(MANUAL_OPERATIONS, String(row.kind))) &&
        Object.hasOwn(FACE_LABELS, String(row.face)) && text(row.name, 300) &&
        (row.layerId === undefined || text(row.layerId)) &&
        (row.materialCode === undefined || text(row.materialCode, 120)) &&
        (row.requiresStepId === undefined || text(row.requiresStepId, 330)) &&
        (row.method === undefined || text(row.method, 120)) && (row.note === undefined || text(row.note, 600)), '工序内容无效。');
      ids.add(row.id);
    }
  }
  validateSide(value.front);
  validateSide(value.back);
}

function validateProject(value: unknown, archiveVersion: number): asserts value is Project | StoredProjectDocument {
  assert(isObject(value) && text(value.id) && value.id.length > 0 && text(value.name, 500), '项目名称或标识无效。');
  assert(isValidProjectNote(value.note), '项目备注无效。');
  if (value.stylePresets !== undefined) validateStylePresets(value.stylePresets);
  assert(number(value.version, 1) && Number.isInteger(value.version), '项目版本号无效。');
  assert(number(value.updatedAt, 0, Number.MAX_SAFE_INTEGER), '项目保存时间无效。');
  if (archiveVersion === 1) {
    assert(value.cards === undefined && value.additionalCards === undefined && value.canvasFacePositions === undefined, '项目包版本与卡牌数据不符。');
    validateCardDesign(value);
    assert(isValidProjectCover(value.projectCover, projectCards(value as unknown as Project)), '项目封面对应的卡面无效。');
    return;
  }
  assert(Array.isArray(value.cards) && value.cards.length > 0, '项目缺少卡牌。');
  const ids = new Set<string>();
  for (const card of value.cards) {
    assert(isObject(card) && text(card.id, 302) && !!card.id.trim() && !ids.has(card.id) &&
      text(card.name, 500) && !!card.name.trim(), '卡牌名称或标识无效。');
    ids.add(card.id);
    validateCardDesign(card);
  }
  assert(isValidCanvasFacePositions(value.canvasFacePositions, value.cards as ProjectCard[]), '卡面画布坐标无效。');
  assert(isValidProjectCover(value.projectCover, value.cards as ProjectCard[]), '项目封面对应的卡面无效。');
}

function imageNodes(cards: ProjectCard[]): { src?: string }[] {
  const assets = cards.flatMap(card => [card.front, card.back]).flatMap(side => {
    const nodes = [...side.nodes, ...side.effects.flatMap(effect => effect.maskContent ?? []),
      ...side.regions.flatMap(region => region.snapshot ? [region.snapshot] : [])];
    return [...nodes.flatMap(node => [
      ...(node.type === 'image' ? [node] : []),
      ...(node.imageFill ? [node.imageFill] : []),
    ]), ...(side.reference ? [side.reference] : [])];
  });
  return [...new Set(assets)];
}

function projectFontReferences(cards: ProjectCard[]): ArtworkFontReference[] {
  return cards.flatMap(card => [card.front, card.back]).flatMap(artworkTextNodes)
    .flatMap(node => node.fontRef ? [node.fontRef] : []);
}

export async function localSource(src: string): Promise<Uint8Array> {
  if (!src.startsWith('data:image/')) {
    const url = new URL(src, location.href);
    assert(url.origin === location.origin && (url.protocol === 'blob:' || url.pathname.startsWith('/assets/')), '项目包含外部图片，请先下载并导入图片。');
  }
  const response = await fetch(src, { redirect: 'error' });
  assert(response.ok, '读取项目素材失败，请确认原始图片仍可访问。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  await checkedImage(bytes);
  return bytes;
}

export async function buildProjectArchive(project: Project): Promise<Blob> {
  const snapshot = structuredClone(serializeProject(project));
  validateProject(snapshot, ARCHIVE_VERSION);
  const zip = new JSZip();
  const entries: ArchiveEntry[] = [];
  const sources = new Map<string, string>();
  let totalSize = 0;
  async function add(path: string, bytes: Uint8Array): Promise<void> {
    totalSize += bytes.byteLength;
    assert(totalSize <= MAX_PROJECT_BYTES, '项目包超过 100 MB，请移除部分图片再导出。');
    zip.file(path, bytes);
    entries.push({ path, sha256: await sha256(bytes), size: bytes.byteLength });
  }
  for (const node of imageNodes(snapshot.cards)) {
    if (!node.src) continue;
    const original = node.src;
    let path = sources.get(original);
    if (!path) {
      const bytes = await localSource(original);
      const extension = imageMime(bytes).split('/')[1];
      path = `assets/${await sha256(bytes)}.${extension}`;
      if (!entries.some(entry => entry.path === path)) await add(path, bytes);
      sources.set(original, path);
    }
    node.src = path;
  }

  const encoder = new TextEncoder();
  await add('document.json', encoder.encode(JSON.stringify(snapshot)));
  await add('schema.json', encoder.encode(JSON.stringify({ format: FORMAT, version: ARCHIVE_VERSION, coordinateUnits: '0.1mm' })));
  const builtinFiles = new Set<string>([
    BUILTIN_ARTWORK_FONTS['work-sans'].file, BUILTIN_ARTWORK_FONTS['work-sans'].license,
  ]);
  const packaged = new Set<string>();
  for (const ref of projectFontReferences(snapshot.cards)) {
    if (ref.kind === 'builtin') {
      const { file, license } = BUILTIN_ARTWORK_FONTS[ref.id];
      builtinFiles.add(file);
      builtinFiles.add(license);
    } else if (ref.kind === 'imported' && ref.share && !packaged.has(ref.id)) {
      const asset = await shareableProjectFont(ref);
      if (asset) {
        await add(`fonts/${ref.id}.${asset.format}`, new Uint8Array(asset.bytes));
        packaged.add(ref.id);
      }
    }
  }
  for (const file of builtinFiles) {
    await add('fonts/' + file.split('/').at(-1)!, new Uint8Array(await assetBytes(file)));
  }
  zip.file('manifest.json', JSON.stringify({ format: FORMAT, version: ARCHIVE_VERSION, files: entries }, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } });
}

export async function exportProject(project: Project): Promise<void> {
  downloadBlob(await buildProjectArchive(project), `${project.name}.cardproj`);
}

export async function inspectProjectArchive(file: File) {
  assert(file.size > 0 && file.size <= MAX_PROJECT_BYTES, '项目包必须小于 100 MB。');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(file, { checkCRC32: false }); }
  catch { throw new Error('项目包无法打开，请选择完整的 .cardproj 文件。'); }
  const files = Object.values(zip.files).filter(entry => !entry.dir);
  assert(files.length <= 2200, '项目包中的文件过多。');
  let estimatedSize = 0;
  for (const entry of files) {
    const originalName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName || entry.name;
    assert(originalName === entry.name && !entry.name.startsWith('/') && !entry.name.includes('\\') && !entry.name.split('/').some(part => part === '..' || part === '.' || part === ''), '项目包包含无效文件路径。');
    assert(['document.json', 'schema.json', 'manifest.json'].includes(entry.name) || /^(assets|fonts)\/[a-zA-Z0-9_.-]+$/.test(entry.name), '项目包包含无法识别的文件。');
    const metadata = entry as typeof entry & { _data?: { uncompressedSize?: number } };
    estimatedSize += metadata._data?.uncompressedSize || 0;
  }
  assert(estimatedSize <= MAX_PROJECT_BYTES, '解压后的项目超过 100 MB。');
  const schemaFile = zip.file('schema.json');
  const manifestFile = zip.file('manifest.json');
  const documentFile = zip.file('document.json');
  assert(schemaFile && manifestFile && documentFile, '项目包缺少文档、版本说明或校验清单。');
  let schema: unknown;
  let manifest: Manifest;
  try {
    schema = JSON.parse(await schemaFile.async('string'));
    manifest = JSON.parse(await manifestFile.async('string')) as Manifest;
  } catch { throw new Error('项目包说明文件损坏。'); }
  assert(isObject(schema) && schema.format === FORMAT && (schema.version === 1 || schema.version === 2 || schema.version === ARCHIVE_VERSION)
    && schema.coordinateUnits === '0.1mm', '项目包版本暂不支持，请使用版本 1 至 3 的 .cardproj 文件。');
  assert(isObject(manifest) && manifest.format === FORMAT && manifest.version === schema.version && Array.isArray(manifest.files), '项目包校验清单无效。');
  assert(manifest.files.length === files.length - 1 && manifest.files.length <= 2199, '项目包校验清单的文件数量不符。');
  const checked = new Map<string, Uint8Array>();
  let actualSize = 0;
  for (const entry of manifest.files) {
    assert(isObject(entry) && text(entry.path) && text(entry.sha256) && /^[0-9a-f]{64}$/.test(entry.sha256) && number(entry.size, 0, MAX_PROJECT_BYTES) && Number.isInteger(entry.size), '项目包校验信息无效。');
    assert(!checked.has(entry.path) && entry.path !== 'manifest.json', '校验清单包含重复文件。');
    const stored = zip.file(entry.path);
    assert(stored, `项目包缺少文件 ${entry.path}。`);
    const bytes = await stored.async('uint8array');
    actualSize += bytes.byteLength;
    assert(actualSize <= MAX_PROJECT_BYTES && bytes.byteLength === entry.size && await sha256(bytes) === entry.sha256, `文件 ${entry.path} 校验失败，项目包可能已损坏。`);
    checked.set(entry.path, bytes);
  }
  assert(files.length === checked.size + 1 && checked.has('document.json') && checked.has('schema.json'), '项目包包含未校验的文件。');
  let project: unknown;
  try { project = JSON.parse(new TextDecoder().decode(checked.get('document.json'))); }
  catch { throw new Error('项目文档损坏。'); }
  validateProject(project, schema.version);
  const cards = 'cards' in project ? project.cards : projectCards(project);
  const embedded = new Map<string, string>();
  for (const node of imageNodes(cards)) {
    const path = node.src || '';
    assert(/^assets\/[a-zA-Z0-9_.-]+$/.test(path) && checked.has(path), '项目图片缺失或引用了包外文件。');
    let src = embedded.get(path);
    if (!src) {
      src = (await checkedImage(checked.get(path)!)).src;
      embedded.set(path, src);
    }
    node.src = src;
  }

  const fonts = new Map<string, () => Promise<unknown>>();
  for (const ref of projectFontReferences(cards)) {
    if (ref.kind !== 'imported' || !ref.share || fonts.has(ref.id)) continue;
    const bytes = checked.get(`fonts/${ref.id}.ttf`) ?? checked.get(`fonts/${ref.id}.otf`);
    if (bytes) fonts.set(ref.id, () => importArtworkFont(new Blob([new Uint8Array(bytes)]), ref));
  }
  const document = hydrateProject(project);
  return {
    project: document,
    installFonts: async () => { for (const install of fonts.values()) await install(); },
    fontIssues: async () => {
      const nodes = cards.flatMap(card => [card.front,card.back]).flatMap(artworkTextNodes);
      const problems = await Promise.all(nodes.filter(node => node.fontRef &&
        !(node.fontRef.kind === 'imported' && fonts.has(node.fontRef.id))).map(node => artworkFontProblem(node)));
      return [...new Set(problems.filter((value): value is string => Boolean(value)))];
    },
  };
}

export async function importProject(file: File): Promise<Project> {
  const archive = await inspectProjectArchive(file);
  await archive.installFonts();
  return archive.project;
}
