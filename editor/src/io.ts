import JSZip from 'jszip';
import { get } from 'idb-keyval';
import type { CardNode, CardSide, Project } from './model';

const STORE_KEY = 'prism-projects';
const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 24_000_000;
const FORMAT = 'prism-cardproj';
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

function imageMime(bytes: Uint8Array): string {
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

function dataUrl(blob: Blob): Promise<string> {
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

function validateNode(node: unknown): asserts node is CardNode {
  assert(isObject(node) && text(node.id) && node.id.length > 0, '图层标识缺失。');
  assert(text(node.name) && ['image', 'text', 'rect', 'ellipse', 'polygon'].includes(String(node.type)), '图层类型或名称无效。');
  assert(number(node.x) && number(node.y) && number(node.width, 0.001, 100_000) && number(node.height, 0.001, 100_000) && number(node.rotation), '图层位置或尺寸无效。');
  assert(number(node.opacity, 0, 1) && typeof node.visible === 'boolean' && typeof node.locked === 'boolean' && text(node.fill), '图层外观数据无效。');
  if (node.type === 'image') assert(text(node.src, MAX_IMAGE_BYTES * 1.5) && node.src.length > 0, '图片素材缺失。');
  if (node.type === 'text') assert(text(node.text, 50_000) && number(node.fontSize, 0.1, 10_000), '文字内容或字号无效。');
  if (node.lineHeight !== undefined) assert(number(node.lineHeight, .8, 3), '行距数据无效。');
  if (node.letterSpacing !== undefined) assert(number(node.letterSpacing, -100, 100), '字距数据无效。');
  if (node.cornerRadius !== undefined) assert(number(node.cornerRadius, 0, 100_000), '圆角数据无效。');
  if (node.strokeWidth !== undefined) assert(number(node.strokeWidth, 0, 1000), '描边宽度无效。');
  for (const field of ['stroke', 'fontFamily', 'fontStyle', 'align', 'blend', 'groupId']) {
    if (node[field] !== undefined) assert(text(node[field]), '图层属性无效。');
  }
  if (node.clipRegionId !== undefined) assert(text(node.clipRegionId), '图层蒙版标识无效。');
  if (node.maskInk !== undefined) assert(node.maskInk === 'alpha' || node.maskInk === 'dark', '图片蒙版提取方式无效。');
  if (node.polygon !== undefined) {
    assert(Array.isArray(node.polygon) && node.polygon.length >= 6 && node.polygon.length <= 512
      && node.polygon.length % 2 === 0 && node.polygon.every(value => number(value, 0, 1)), '形状路径无效。');
  }
  if (node.gradient !== undefined) {
    const g = node.gradient;
    assert(isObject(g) && number(g.angle) && Array.isArray(g.stops) && g.stops.length >= 2 && g.stops.length <= 12
      && g.stops.every(stop => Array.isArray(stop) && stop.length === 2 && number(stop[0],0,1)
        && typeof stop[1] === 'string' && CSS.supports('color',stop[1])), '形状渐变无效。');
  }
  if (node.crop !== undefined) {
    const crop = node.crop;
    assert(isObject(crop) && number(crop.x, 0) && number(crop.y, 0) && number(crop.width, 0.001) && number(crop.height, 0.001), '图片裁切数据无效。');
    if (crop.space !== undefined) assert(crop.space === 'source' && crop.x + crop.width <= 1.00001 && crop.y + crop.height <= 1.00001, '图片裁切超出原图。');
  }
}

function validateSide(value: unknown): asserts value is CardSide {
  assert(isObject(value), '卡片正反面数据不完整。');
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
      assert(Array.isArray(region.sources) && region.sources.length >= 2 && region.sources.length <= 16 &&
        region.sources.every(id => typeof id === 'string' && id !== region.id), '组合区域的来源无效。');
    }
    assert(Array.isArray(region.strokes) && region.strokes.length <= 10_000, '画笔数据无效。');
    for (const stroke of region.strokes) {
      assert(isObject(stroke) && Array.isArray(stroke.points) && stroke.points.length <= 200_000 && stroke.points.length % 2 === 0, '画笔路径无效。');
      assert(stroke.points.every(point => number(point)) && number(stroke.size, 0.1, 2000) && typeof stroke.erase === 'boolean', '画笔参数无效。');
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
    if (effect.process !== undefined) assert(['reflection','white','foil','varnish'].includes(String(effect.process)), '工艺类型无效。');
    if (effect.pattern !== undefined) assert(['linear','radial','grain'].includes(String(effect.pattern)), '闪光纹样无效。');
    if (effect.flashStyle !== undefined) assert(['cosmos','geometric','glitter','linear','radial'].includes(String(effect.flashStyle)), '局部闪光样式无效。');
    if (effect.maskContent !== undefined) {
      assert(Array.isArray(effect.maskContent) && effect.maskContent.length <= 1000, '工艺蒙版内容无效。');
      const maskIds = new Set();
      for (const item of effect.maskContent) {
        validateNode(item);
        assert(!maskIds.has(item.id) && !item.clipRegionId, '工艺蒙版内容标识重复或引用了其他蒙版。');
        maskIds.add(item.id);
      }
    }
    assert(number(effect.opacity, 0, 1) && number(effect.angle) && typeof effect.visible === 'boolean', '效果参数无效。');
  }
}

function validateProject(value: unknown): asserts value is Project {
  assert(isObject(value) && text(value.id) && value.id.length > 0 && text(value.name, 500), '项目名称或标识无效。');
  assert(number(value.version, 1) && Number.isInteger(value.version), '项目版本号无效。');
  assert(number(value.widthMm, 10, 500) && number(value.heightMm, 10, 500) && number(value.bleedMm, 0, 20), '卡片尺寸应在 10–500 mm 之间，出血在 0–20 mm 之间。');
  if (value.cornerRadiusMm !== undefined) assert(number(value.cornerRadiusMm, 0, Math.min(value.widthMm, value.heightMm) / 2), '卡片圆角半径超出范围。');
  assert(text(value.material) && number(value.updatedAt, 0, Number.MAX_SAFE_INTEGER), '项目材质或保存时间无效。');
  if (value.previewStyle !== undefined) assert(['cosmos', 'geometric', 'glitter', 'original'].includes(String(value.previewStyle)), '预览样式无效。');
  if (value.stockReflection !== undefined) assert(['none','mirror','rainbow','radial'].includes(String(value.stockReflection)), '底材反光类型无效。');
  validateSide(value.front);
  validateSide(value.back);
}

function imageNodes(project: Project): { src?: string }[] {
  return [...new Set([project.front, project.back].flatMap(side => [
    ...side.nodes.filter(node => node.type === 'image'),
    ...side.effects.flatMap(effect => (effect.maskContent || []).filter(node => node.type === 'image')),
    ...side.regions.flatMap(region => region.snapshot?.type === 'image' ? [region.snapshot] : []),
    ...(side.reference ? [side.reference] : []),
  ]))];
}

async function localSource(src: string): Promise<Uint8Array> {
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

export async function exportProject(project: Project): Promise<void> {
  validateProject(project);
  const snapshot = structuredClone(project);
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
  for (const node of imageNodes(snapshot)) {
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
  await add('schema.json', encoder.encode(JSON.stringify({ format: FORMAT, version: 1, coordinateUnits: '0.1mm' })));
  const fontResponse = await fetch('/assets/work-sans-variable.woff2');
  assert(fontResponse.ok, '项目字体读取失败，请重试。');
  await add('fonts/work-sans-variable.woff2', new Uint8Array(await fontResponse.arrayBuffer()));
  const licenseResponse = await fetch('/assets/WorkSans-OFL.txt');
  assert(licenseResponse.ok, '字体授权文件读取失败，请重试。');
  await add('fonts/WorkSans-OFL.txt', new Uint8Array(await licenseResponse.arrayBuffer()));
  zip.file('manifest.json', JSON.stringify({ format: FORMAT, version: 1, files: entries }, null, 2));
  downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } }), `${snapshot.name}.cardproj`);
}

export async function importProject(file: File): Promise<Project> {
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
  assert(isObject(schema) && schema.format === FORMAT && schema.version === 1 && schema.coordinateUnits === '0.1mm', '项目包版本暂不支持，请使用版本 1 的 .cardproj 文件。');
  assert(isObject(manifest) && manifest.format === FORMAT && manifest.version === 1 && Array.isArray(manifest.files), '项目包校验清单无效。');
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
  validateProject(project);
  const embedded = new Map<string, string>();
  for (const node of imageNodes(project)) {
    const path = node.src || '';
    assert(/^assets\/[a-zA-Z0-9_.-]+$/.test(path) && checked.has(path), '项目图片缺失或引用了包外文件。');
    let src = embedded.get(path);
    if (!src) {
      src = (await checkedImage(checked.get(path)!)).src;
      embedded.set(path, src);
    }
    node.src = src;
  }

  return project;
}
