import { useEffect, useSyncExternalStore } from 'react';
import { createStore, entries, get, set } from 'idb-keyval';
import { processKind, processLayerEnabled, projectCards, type CardNode, type CardSide, type Project, type SideName } from './model';
import { MAX_FONT_BYTES, readOpenType, type OpenTypeInfo } from './fontOpenType';
import { textWithoutInlineSymbols, type InlineTextStyle } from './textStyles';

export type ArtworkFontReference =
  | { kind: 'builtin'; id: BuiltinFontId; weight: number }
  | { kind: 'device'; family: string; style: string; postScriptName: string }
  | { kind: 'imported'; id: string; family: string; style: string; postScriptName: string; share?: boolean };

export type DeviceFontReference = Extract<ArtworkFontReference, { kind: 'device' }>;
export type ImportedFontReference = Extract<ArtworkFontReference, { kind: 'imported' }>;
type FontRef = ArtworkFontReference;
type DeviceFont = Pick<DeviceFontReference, 'family' | 'style'> & { postscriptName: string; fullName: string; blob: () => Promise<Blob> };
type FontFile = Pick<OpenTypeInfo, 'family' | 'style' | 'postScriptName' | 'format' | 'weight' | 'shareable'> &
  { id: string; blob: Blob };

const FONT_WEIGHTS: Record<number, string> = {
  100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black',
};

// Noto source and licensing: github.com/google/fonts/tree/main/ofl/{notosanssc,notoserifsc}
// The WOFF2 files carry unmodified glyphs and variable weights. Matching OFL texts ship beside them.
export const BUILTIN_ARTWORK_FONTS = {
  'noto-sans-sc': { family: '思源黑体', language: '中文与拉丁 · 无衬线', file: 'fonts/noto-sans-sc.woff2',
    license: 'fonts/NotoSansSC-OFL.txt', minWeight: 100 },
  'noto-serif-sc': { family: '思源宋体', language: '中文与拉丁 · 衬线', file: 'fonts/noto-serif-sc.woff2',
    license: 'fonts/NotoSerifSC-OFL.txt', minWeight: 200 },
  'work-sans': { family: 'Work Sans', language: '拉丁 · 无衬线', file: 'work-sans-variable.woff2',
    license: 'WorkSans-OFL.txt', minWeight: 100 },
} as const;
type BuiltinFontId = keyof typeof BUILTIN_ARTWORK_FONTS;

const store = createStore('prism-fonts', 'files');
const assets = new Map<string, Promise<ArrayBuffer>>();
const glyphRanges = new Map<string, Promise<number[]>>();
const devices = new Map<string, DeviceFont>();
const deviceRefs = new Map<string, DeviceFontReference>();
const imports = new Map<string, FontFile>();
const listeners = new Set<() => void>();
let revision = 0;
let catalogPending: Promise<void> | undefined;
let listeningToPermission = false;
let devicePermissionRevision = 0;

function publish() {
  revision++;
  for (const notify of listeners) notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFontRevision() {
  return useSyncExternalStore(subscribe, () => revision);
}

export function artworkFontRevision() {
  return revision;
}

export function fontReferenceName(ref: FontRef) {
  return ref.kind === 'builtin' ? BUILTIN_ARTWORK_FONTS[ref.id].family : ref.family;
}

export function fontReferenceWeight(ref: FontRef) {
  return ref.kind === 'builtin' ? FONT_WEIGHTS[ref.weight] ?? String(ref.weight) : ref.style;
}

export function fontWeightOptions(id: BuiltinFontId) {
  return Object.entries(FONT_WEIGHTS).flatMap(([weight, label]) =>
    Number(weight) < BUILTIN_ARTWORK_FONTS[id].minWeight ? [] : [{ value: weight, label }]);
}

export function fontFamilyKey(ref: FontRef) {
  return ref.kind === 'builtin' ? ref.id : `${ref.kind}:${ref.family}`;
}

export function fontRefKey(ref: FontRef) {
  if (ref.kind === 'builtin') return `builtin:${ref.id}`;
  return ref.kind === 'device' ? `device:${ref.postScriptName}` : `imported:${ref.id}`;
}

export const isArtworkFontReference = (value: unknown): value is FontRef => {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  if (ref.kind === 'builtin') return typeof ref.id === 'string' && Object.hasOwn(BUILTIN_ARTWORK_FONTS, ref.id) &&
    typeof ref.weight === 'number' && Number.isInteger(ref.weight) && ref.weight >= BUILTIN_ARTWORK_FONTS[ref.id as BuiltinFontId].minWeight && ref.weight <= 900;
  const validName = (name: unknown) => typeof name === 'string' && name.trim() === name && !!name && name.length <= 150 &&
    !/[\u0000-\u001f\u007f]/.test(name);
  return validName(ref.family) && validName(ref.style) && validName(ref.postScriptName) &&
    (ref.kind === 'device' || (ref.kind === 'imported' && typeof ref.id === 'string' && /^[0-9a-f]{64}$/.test(ref.id) &&
    (ref.share === undefined || typeof ref.share === 'boolean')));
};

export function assetBytes(file: string) {
  const cached = assets.get(file);
  if (cached) return cached;
  const pending = fetch('/assets/' + file).then(response => {
    if (!response.ok) throw new Error('内置字体加载失败');
    return response.arrayBuffer();
  }).catch(error => {
    assets.delete(file);
    throw error;
  });
  assets.set(file, pending);
  return pending;
}

function legacyFont(node: CardNode) {
  const style = node.fontStyle || 'normal';
  const family = node.fontFamily || 'Work Sans, PingFang SC, Microsoft YaHei';
  return { style, family };
}

export const INLINE_TEXT_FONT = { kind: 'builtin', id: 'noto-sans-sc', weight: 400 } as const;
const inlineFamily = JSON.stringify(fontRefKey(INLINE_TEXT_FONT));

export function artworkFontCss(node: CardNode, size: number, inline?: InlineTextStyle) {
  if (inline?.symbol) return `${inline.bold ? 700 : 400} ${size}px ${inlineFamily}, sans-serif`;
  const ref = node.fontRef ?? (inline ? outlineFontReference(node) : undefined);
  const fallback = inline ? `${inlineFamily}, "Work Sans", "PingFang SC", "Microsoft YaHei", sans-serif`
    : '"Work Sans", "PingFang SC", "Microsoft YaHei", sans-serif';
  if (!ref) {
    const { style, family } = legacyFont(node);
    const weight = inline?.bold === undefined ? style : `${style.includes('italic') ? 'italic ' : ''}${inline.bold ? 700 : 400}`;
    return `${weight} ${size}px ${family}${inline ? `, ${fallback}` : ', sans-serif'}`;
  }
  const weight = inline?.bold !== undefined ? (inline.bold ? 700 : 400) : ref.kind === 'builtin' ? ref.weight : 'normal';
  return `${weight} ${size}px ${JSON.stringify(fontRefKey(ref))}, ${fallback}`;
}

export function artworkFontBold(node: CardNode) {
  const ref = node.fontRef;
  if (ref?.kind === 'builtin') return ref.weight >= 700;
  if (ref) return /(?:bold|heavy|black|粗)/i.test(ref.style);
  return /(?:bold|[789]00)/i.test(node.fontStyle || '');
}

export function outlineFontReference(node: CardNode): FontRef | undefined {
  if (node.fontRef) return node.fontRef;
  const { style, family } = legacyFont(node);
  if (family.split(',')[0].trim().replace(/^['"]|['"]$/g, '') !== 'Work Sans') return;
  if (style === 'normal') return { kind: 'builtin', id: 'work-sans', weight: 400 };
  if (style === 'bold') return { kind: 'builtin', id: 'work-sans', weight: 700 };
}

async function observeDevicePermission() {
  if (listeningToPermission || !navigator.permissions) return;
  listeningToPermission = true;
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' as PermissionName });
    status.addEventListener('change', () => {
      devicePermissionRevision++;
      if (status.state === 'granted') {
        clearUnavailableFonts('device:');
        publish();
        return;
      }
      devices.clear();
      deviceRefs.clear();
      for (const [key, font] of loadedFonts) {
        if (!key.startsWith('device:')) continue;
        if (font.face) document.fonts.delete(font.face);
        loadedFonts.delete(key);
      }
      publish();
    });
  } catch {
    // Browsers that expose local fonts may omit the Permissions API descriptor.
  }
}

export function loadFontCatalog() {
  if (!catalogPending) catalogPending = entries<string, FontFile>(store)
    .then(records => {
      for (const [id, file] of records) if (file?.blob instanceof Blob && file.id === id) imports.set(id, file);
      publish();
    }).catch(() => { catalogPending = undefined; });
  return catalogPending;
}

export function getFontCatalog() {
  return {
    imported: [...imports.values()].sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight)
      .map(({ id, family, style, postScriptName }) => ({ kind: 'imported' as const, id, family, style, postScriptName })),
    device: [...deviceRefs.values()].sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style)),
  };
}

export function canReadDeviceFonts() {
  return typeof (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts === 'function';
}

export async function requestDeviceFonts() {
  const host = window as Window & { queryLocalFonts?: () => Promise<DeviceFont[]> };
  if (!host.queryLocalFonts) throw new Error('当前浏览器无法读取设备字体，可导入 TTF 或 OTF。');
  let list: DeviceFont[];
  try { list = await host.queryLocalFonts(); }
  catch { throw new Error('未获得设备字体权限，可在浏览器设置中允许访问，或导入字体文件。'); }
  if (!list.length) {
    const status = await navigator.permissions?.query({ name: 'local-fonts' as PermissionName }).catch(() => undefined);
    if (status?.state !== 'granted') throw new Error('未获得设备字体权限，可在浏览器设置中允许访问，或导入字体文件。');
    throw new Error('当前设备未返回可用字体。');
  }
  for (const font of list) {
    const { family, style, postscriptName: postScriptName } = font;
    const ref = { kind: 'device', family, style, postScriptName } as const;
    if (isArtworkFontReference(ref)) {
      devices.set(postScriptName, font);
      deviceRefs.set(postScriptName, ref);
    }
  }
  clearUnavailableFonts('device:');
  void observeDevicePermission();
  publish();
}

async function hashFont(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function fileReference(file: FontFile, share?: boolean): ImportedFontReference {
  const { id, family, style, postScriptName } = file;
  return { kind: 'imported', id, family, style, postScriptName, share };
}

export async function importArtworkFont(blob: Blob, expected?: ImportedFontReference) {
  if (!blob.size || blob.size > MAX_FONT_BYTES) throw new Error('字体文件必须小于 24 MB。');
  const buffer = await blob.arrayBuffer();
  const info = readOpenType(buffer);
  const id = await hashFont(buffer);
  if (expected && (expected.id !== id || expected.family !== info.family || expected.style !== info.style ||
    expected.postScriptName !== info.postScriptName || !expected.share || !info.shareable)) {
    throw new Error('项目包字体与字体引用不一致，或不允许随包分发。');
  }
  const { family, style, postScriptName, format, weight, shareable } = info;
  const file = { id, family, style, postScriptName, format, weight, shareable, blob };
  const ref = fileReference(file, expected?.share);
  const face = new FontFace(fontRefKey(ref), buffer);
  try { await face.load(); }
  catch { throw new Error('浏览器无法加载该字体文件，请选择其他 TTF 或 OTF。'); }
  try { await set(id, file, store); }
  catch { throw new Error('字体未能保存在本机，请检查浏览器存储后重试。'); }
  imports.set(id, file);
  registerFont(fontRefKey(ref), { face, hasGlyph: info.hasGlyph });
  publish();
  return ref;
}

async function importedFile(ref: ImportedFontReference) {
  const file = imports.get(ref.id) ?? await get<FontFile>(ref.id, store);
  if (!file || file.family !== ref.family || file.style !== ref.style || file.postScriptName !== ref.postScriptName) return;
  return file;
}

export function importedFontShareable(ref: ImportedFontReference) {
  return imports.get(ref.id)?.shareable ?? false;
}

export async function shareableProjectFont(ref: ImportedFontReference) {
  if (!ref.share) return;
  const file = await importedFile(ref);
  if (!file?.shareable) return;
  return { bytes: await file.blob.arrayBuffer(), format: file.format };
}

function findRange(ranges: number[], codePoint: number) {
  let low = 0, high = ranges.length / 2;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ranges[mid * 2 + 1] < codePoint) low = mid + 1;
    else high = mid;
  }
  return low * 2 < ranges.length && ranges[low * 2] <= codePoint;
}

async function builtinCoverage(id: BuiltinFontId) {
  let ranges = glyphRanges.get(id);
  if (!ranges) {
    ranges = fetch(`/assets/fonts/${id}.coverage.json`).then(response => {
      if (!response.ok) throw new Error('字形索引读取失败。');
      return response.json() as Promise<number[]>;
    }).catch(error => {
      glyphRanges.delete(id);
      throw error;
    });
    glyphRanges.set(id, ranges);
  }
  const coverage = await ranges;
  return (codePoint: number) => findRange(coverage, codePoint);
}

type FontStatus = { face?: FontFace; hasGlyph?: OpenTypeInfo['hasGlyph']; problem?: string };
const loadedFonts = new Map<string, FontStatus>();
const loadingFonts = new Map<string, Promise<FontStatus>>();

function registerFont(key: string, status: FontStatus) {
  const previous = loadedFonts.get(key)?.face;
  if (previous && previous !== status.face) document.fonts.delete(previous);
  if (status.face) document.fonts.add(status.face);
  loadedFonts.set(key, status);
}

function clearUnavailableFonts(prefix: string) {
  for (const [key, font] of loadedFonts) if (key.startsWith(prefix) && font.problem) loadedFonts.delete(key);
}

async function loadArtworkFont(ref: FontRef): Promise<FontStatus> {
  const alias = fontRefKey(ref);
  if (ref.kind === 'builtin') {
    const spec = BUILTIN_ARTWORK_FONTS[ref.id];
    const face = new FontFace(alias, `url("/assets/${spec.file}") format("woff2")`, { weight: `${spec.minWeight} 900` });
    const [, hasGlyph] = await Promise.all([face.load(), builtinCoverage(ref.id)]);
    return { face, hasGlyph };
  }
  if (ref.kind === 'imported') {
    const asset = await importedFile(ref);
    if (!asset) return { problem: '本机缺少该字体文件，导入原字体或选择替换。' };
    const buffer = await asset.blob.arrayBuffer();
    const face = new FontFace(alias, buffer);
    await face.load();
    return { face, hasGlyph: readOpenType(buffer).hasGlyph };
  }
  await observeDevicePermission();
  const host = window as Window & { queryLocalFonts?: (options: { postscriptNames: string[] }) => Promise<DeviceFont[]> };
  if (!host.queryLocalFonts) return { problem: '当前浏览器无法访问设备字体，可导入原字体文件或选择替换。' };
  let device = devices.get(ref.postScriptName);
  if (navigator.permissions) {
    const permission = await navigator.permissions.query({ name: 'local-fonts' as PermissionName }).catch(() => undefined);
    if (permission && permission.state !== 'granted') return { problem: '请重新授权设备字体，或导入原字体。' };
    if (!device && permission?.state === 'granted') {
      [device] = await host.queryLocalFonts({ postscriptNames: [ref.postScriptName] }).catch(() => []);
    }
  }
  if (device) {
    try {
      const buffer = await (await device.blob()).arrayBuffer();
      const info = readOpenType(buffer, true);
      if (info.postScriptName === ref.postScriptName) {
        const face = await new FontFace(alias, buffer).load();
        return { face, hasGlyph: info.hasGlyph };
      }
    } catch { /* Fall back to the font already installed on this device. */ }
  }
  const names = new Set([ref.postScriptName, device?.fullName].filter(Boolean));
  const source = [...names].map(name => `local(${JSON.stringify(name)})`).join(', ');
  const face = await new FontFace(alias, source).load().catch(() => undefined);
  return face ? { face } : { problem: '设备上找不到所选字族和字重，安装原字体或选择替换。' };
}

export function ensureArtworkFont(node: Pick<CardNode, 'fontRef'>) {
  const ref = node.fontRef;
  if (!ref) return document.fonts.ready.then((): FontStatus => ({}));
  const key = fontRefKey(ref);
  const cached = loadedFonts.get(key);
  if (cached) return Promise.resolve(cached);
  const loading = loadingFonts.get(key);
  if (loading) return loading;
  const permissionRevision = devicePermissionRevision;
  const pending = loadArtworkFont(ref).catch((): FontStatus => ({ problem: '字体加载失败，请重新选择或导入。' }))
    .then((status): FontStatus | Promise<FontStatus> => {
      if (ref.kind === 'device' && permissionRevision !== devicePermissionRevision) {
        loadingFonts.delete(key);
        return ensureArtworkFont(node);
      }
      const current = loadedFonts.get(key);
      if (current?.face) return current;
      registerFont(key, status);
      publish();
      return status;
    }).finally(() => { if (loadingFonts.get(key) === pending) loadingFonts.delete(key); });
  loadingFonts.set(key, pending);
  return pending;
}

export async function ensureArtworkTextFonts(node: CardNode) {
  if (!node.textStyles?.length) return ensureArtworkFont(node);
  const fontRef = node.fontRef ?? outlineFontReference(node);
  const [base] = await Promise.all([ensureArtworkFont({ fontRef }), ensureArtworkFont({ fontRef: INLINE_TEXT_FONT })]);
  return base;
}

function missingGlyphs(text: string | undefined, font: FontStatus) {
  if (!font.hasGlyph) return [];
  const hasGlyph = font.hasGlyph;
  return Array.from(new Set(Array.from(text || '').filter(character =>
    !/[\s\p{Default_Ignorable_Code_Point}]/u.test(character) && !hasGlyph(character.codePointAt(0)!))));
}

export function artworkFontReady(node: Pick<CardNode, 'fontRef' | 'text' | 'textStyles'>) {
  const fallback = node.textStyles?.length ? loadedFonts.get(fontRefKey(INLINE_TEXT_FONT)) : undefined;
  if (node.textStyles?.length && !fallback?.face) return false;
  if (!node.fontRef) return true;
  const status = loadedFonts.get(fontRefKey(node.fontRef));
  return !!status?.face && missingGlyphs(textWithoutInlineSymbols(node.text, node.textStyles), status)
    .every(character => fallback?.hasGlyph?.(character.codePointAt(0)!));
}

export async function artworkFontProblem(node: CardNode) {
  const status = await ensureArtworkTextFonts(node);
  if (status.problem) return status.problem;
  const fallback = node.textStyles?.length ? loadedFonts.get(fontRefKey(INLINE_TEXT_FONT)) : undefined;
  if (fallback?.problem) return fallback.problem;
  const missing = missingGlyphs(textWithoutInlineSymbols(node.text, node.textStyles), status)
    .filter(character => !fallback?.hasGlyph?.(character.codePointAt(0)!));
  if (missing.length) return `所选字体缺少字形 ${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}，请选择覆盖这些字符的字体。`;
}

export function artworkTextNodes(side: CardSide): CardNode[] {
  return [...side.nodes, ...side.effects.flatMap(effect => effect.maskContent ?? []),
    ...side.regions.flatMap(region => region.snapshot ? [region.snapshot] : [])].filter(node => node.type === 'text');
}

export async function ensureProjectFonts(project: Project) {
  await Promise.all(projectCards(project).flatMap(card => [card.front, card.back]).flatMap(artworkTextNodes)
    .filter(node => node.fontRef || node.textStyles?.length).map(ensureArtworkTextFonts));
  await document.fonts.ready;
}

export function useArtworkFonts(project: Project) {
  const version = useFontRevision();
  useEffect(() => { void ensureProjectFonts(project); }, [project, version]);
  return version;
}

export function regionTextNodes(side: CardSide, rootIds: string[]): CardNode[] {
  const results = new Set<CardNode>();
  const visited = new Set<string>();
  const collect = (id: string, depth = 0) => {
    if (depth >= 16 || visited.has(id)) return;
    visited.add(id);
    const region = side.regions.find(item => item.id === id);
    if (!region) return;
    if (region.kind === 'union') for (const child of region.sources ?? []) collect(child, depth + 1);
    if (region.kind !== 'node') return;
    const linked = side.nodes.find(node => node.id === region.nodeId);
    const layer = region.binding === 'fixed' ? region.snapshot ?? linked : linked;
    if (layer?.type === 'text' && (layer.visible || region.maskSource)) results.add(layer);
    if (layer?.clipRegionId) collect(layer.clipRegionId, depth + 1);
  };
  for (const id of rootIds) collect(id);
  return [...results];
}

export async function projectFontProblems(project: Project, sides: SideName[] = ['front', 'back'], effects = true) {
  const checks = sides.flatMap(side => {
    const face = project[side];
    const artwork = face.nodes.filter(node => node.visible && node.opacity > 0);
    const applied = effects ? face.effects.filter(effect => processLayerEnabled(effect) && !['spot', 'primer'].includes(processKind(effect))) : [];
    const regionIds = [...artwork.flatMap(node => node.clipRegionId ? [node.clipRegionId] : []), ...applied.map(effect => effect.regionId)];
    const drawn = new Set([...artwork, ...regionTextNodes(face, regionIds),
      ...applied.flatMap(effect => effect.maskContent?.filter(node => node.visible) ?? [])]);
    return [...drawn].filter(node => node.type === 'text' && node.fontRef && node.text?.trim())
      .map(async node => ({ node, side, message: await artworkFontProblem(node) }));
  });
  return (await Promise.all(checks)).flatMap(({ node, side, message }) => message ? [{ node, side, message }] : []);
}
