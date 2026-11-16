export type SideName = 'front' | 'back';
export type TemplateName = 'ocean' | 'botanical' | 'editorial' | 'blank';
export type EffectType = 'holo' | 'gold' | 'silver' | 'gloss' | 'emboss' | 'grain' | 'white';
export type ProcessKind = 'reflection' | 'white' | 'foil' | 'varnish';
export type StockReflection = 'none' | 'mirror' | 'rainbow' | 'radial';
export const FLASH_STYLES = {
  cosmos: {label:'星空闪',texture:'cosmos-bottom.png'},
  geometric: {label:'几何镭射',texture:'geometric.png'},
  glitter: {label:'细闪',texture:'glitter.png'},
  linear: {label:'虹彩斜纹',texture:''},
  radial: {label:'放射光束',texture:''},
} as const;
export type FlashStyle = keyof typeof FLASH_STYLES;
export interface ImageCrop { x: number; y: number; width: number; height: number; space?: 'source' }
export interface CardNode {
  id: string; name: string; type: 'image' | 'text' | 'rect' | 'ellipse' | 'polygon';
  x: number; y: number; width: number; height: number; rotation: number;
  opacity: number; visible: boolean; locked: boolean; fill: string;
  stroke?: string; strokeWidth?: number; text?: string; fontSize?: number;
  fontFamily?: string; fontStyle?: string; align?: string; src?: string;
  crop?: ImageCrop;
  blend?: string; lineHeight?: number; letterSpacing?: number; cornerRadius?: number; groupId?: string;
  clipRegionId?: string;
  maskInk?: 'alpha' | 'dark';
  polygon?: number[];
  gradient?: { angle: number; stops: [number, string][] };
}
export interface Stroke { points: number[]; size: number; erase: boolean }
export interface Region {
  id: string; name: string; kind: 'full' | 'border' | 'node' | 'paint' | 'rect' | 'ellipse' | 'polygon' | 'union';
  nodeId?: string; binding: 'fixed' | 'follow'; inverted: boolean; strokes: Stroke[];
  bounds?: { x: number; y: number; width: number; height: number; rotation: number };
  snapshot?: CardNode;
  points?: number[];
  sources?: string[];
}
export interface Effect {
  id: string; name: string; type: EffectType; regionId: string;
  opacity: number; angle: number; visible: boolean;
  process?: ProcessKind;
  pattern?: 'linear' | 'radial' | 'grain';
  flashStyle?: FlashStyle;
  maskContent?: CardNode[];
}
export interface CardSide { nodes: CardNode[]; regions: Region[]; effects: Effect[]; reference?: { src: string; name: string } }
export interface Project {
  id: string; name: string; version: number; widthMm: number; heightMm: number;
  bleedMm: number; material: string; previewStyle?: 'cosmos' | 'geometric' | 'glitter' | 'original'; front: CardSide; back: CardSide; updatedAt: number;
  cornerRadiusMm?: number;
  stockReflection?: StockReflection;
}

export const DEFAULT_CARD_CORNER_MM = 1.8;

export function getCardCornerRadiusMm(project: Pick<Project, 'widthMm' | 'heightMm' | 'cornerRadiusMm'>) {
  return Math.max(0, Math.min(project.cornerRadiusMm ?? DEFAULT_CARD_CORNER_MM, project.widthMm / 2, project.heightMm / 2));
}

export const PROCESS_LABELS: Record<ProcessKind, string> = {
  reflection: '局部闪光', white: '白墨', foil: '箔版', varnish: '光油',
};
export const STOCK_REFLECTIONS: Record<StockReflection, string> = {
  none: '无反光', mirror: '银色镜面', rainbow: '虹彩镭射', radial: '放射镭射',
};

export function getStockReflection(project: Project): StockReflection {
  return project.stockReflection ?? (project.material === 'holo' ? 'rainbow' : project.material === 'silver' ? 'mirror' : 'none');
}

export function processKind(effect: Effect): ProcessKind {
  if (effect.process) return effect.process;
  if (effect.type === 'white') return 'white';
  if (effect.type === 'gloss' || effect.type === 'emboss') return 'varnish';
  return effect.type === 'grain' ? 'reflection' : 'foil';
}

export function getFlashStyle(project: Project, effect: Effect): FlashStyle {
  if (effect.flashStyle) return effect.flashStyle;
  if (effect.pattern === 'radial' || effect.pattern === 'linear') return effect.pattern;
  if (effect.pattern === 'grain' || effect.type === 'grain') return 'glitter';
  return project.previewStyle && project.previewStyle !== 'original' ? project.previewStyle : 'linear';
}

export function plateFor(effect: Effect): 'white' | 'foil' | 'clear' | undefined {
  const kind = processKind(effect);
  return kind === 'varnish' ? 'clear' : kind === 'reflection' ? undefined : kind;
}

export function processLayerEnabled(effect: Effect): boolean {
  return effect.visible && (effect.process !== undefined && plateFor(effect) !== undefined || effect.opacity > 0);
}

export const uid = () => crypto.randomUUID();
export const EFFECT_NAMES: Record<EffectType, string> = {
  holo: '镭射流光', gold: '香槟金箔', silver: '镜面银箔', gloss: '局部亮光',
  emboss: '浮雕纹理', grain: '细闪颗粒', white: '白墨遮底',
};
export const TEMPLATE_NAMES: Record<TemplateName, string> = {
  ocean: '潮汐档案', botanical: '植物手记', editorial: '远山来信', blank: '空白卡牌',
};

function node(type: CardNode['type'], name: string, x: number, y: number, width: number,
  height: number, extra: Partial<CardNode> = {}): CardNode {
  return { id: uid(), type, name, x, y, width, height, rotation: 0, opacity: 1,
    visible: true, locked: false, fill: '#ffffff', ...extra };
}
function text(name: string, content: string, x: number, y: number, width: number,
  size: number, fill: string, extra: Partial<CardNode> = {}): CardNode {
  return node('text', name, x, y, width, size * 1.5, {
    text: content, fontSize: size, fontFamily: 'Work Sans, PingFang SC, Microsoft YaHei', fill, ...extra,
  });
}
function region(name: string, kind: Region['kind'], extra: Partial<Region> = {}): Region {
  return { id: uid(), name, kind, binding: 'fixed', inverted: false, strokes: [], ...extra };
}

export function createProject(template: TemplateName = 'ocean', name?: string): Project {
  const palette = template === 'botanical'
    ? { base: '#172c26', accent: '#d4bc7d', ink: '#f5edd8', title: '植物手记', latin: 'BOTANICAL STUDIES', label: 'FIELD NOTES / NO. 03', note: '把时间藏进叶脉，将自然留在掌心。' }
    : template === 'editorial'
    ? { base: '#223139', accent: '#d5b27f', ink: '#f4efdf', title: '远山来信', latin: 'BEYOND THE RIDGE', label: 'LANDSCAPE / NO. 12', note: '越过群山的风，带来远方的回声。' }
    : { base: '#102c3a', accent: '#dfc58c', ink: '#f5eedb', title: '潮汐档案', latin: 'PELAGIC', label: 'DEEP SEA / NO. 07', note: '在深蓝之下，收藏海洋的微光。' };
  const blank: CardSide = { nodes: [], regions: [region('整张卡面', 'full'), region('卡片边框', 'border')], effects: [] };
  if (template === 'blank') {
    return { id: uid(), name: name || TEMPLATE_NAMES.blank, version: 1, widthMm: 63,
      heightMm: 88, bleedMm: 3, cornerRadiusMm: DEFAULT_CARD_CORNER_MM, material: 'matte', front: structuredClone(blank),
      back: structuredClone(blank), updatedAt: Date.now() };
  }
  const artwork = node('image', '主视觉', 25, 25, 580, 717, {
    src: `/assets/${template}.jpg`, fill: palette.base,
    ...(template === 'ocean' ? { crop: { x: .13, y: .17, width: .74, height: .74 } } : {}),
  });
  const title = text('卡牌名称', palette.title, 49, 700, 530, 54, palette.ink,
    { fontStyle: 'bold', height: 78 });
  const nodes: CardNode[] = [
    node('rect', '卡片底色', 0, 0, 630, 880, { fill: palette.base, locked: true }),
    artwork,
    node('rect', '标题底衬', 25, 680, 580, 175, { fill: palette.base, opacity: 0.96 }),
    node('rect', '外框线', 16, 16, 598, 848, { fill: 'transparent', stroke: palette.accent, strokeWidth: 1.5, locked: true }),
    node('rect', '内框线', 25, 25, 580, 830, { fill: 'transparent', stroke: palette.accent, strokeWidth: 1, locked: true }),
    text('系列标识', 'ARCHIVE / ' + palette.label, 48, 48, 530, 13, palette.ink, { fontFamily: 'Work Sans', fontStyle: 'bold' }),
    title,
    text('英文名称', palette.latin, 51, 773, 440, 20, palette.accent, { fontFamily: 'Work Sans', fontStyle: 'bold' }),
    node('rect', '信息分隔线', 49, 814, 532, 1, { fill: palette.accent, opacity: 0.55 }),
    text('收藏序号', 'EDITION 001 / 100', 49, 830, 285, 10, palette.ink, { fontFamily: 'Work Sans' }),
    text('系列年份', '2026  ·  COLLECTOR’S SERIES', 335, 830, 247, 10, palette.ink, { fontFamily: 'Work Sans', align: 'right' }),
  ];
  const all = region('整张卡面', 'full');
  const border = region('卡片边框', 'border');
  const artRegion = region('主视觉区域', 'node', { nodeId: artwork.id, binding: 'follow' });
  const titleRegion = region('标题轮廓', 'node', { nodeId: title.id, binding: 'follow' });
  const effects: Effect[] = [
    { id: uid(), name: '边缘镀金', type: 'gold', regionId: border.id, opacity: 0.85, angle: 32, visible: true },
    { id: uid(), name: '主视觉流光', type: 'holo', regionId: artRegion.id, opacity: 0.18, angle: 125, visible: true },
    { id: uid(), name: '标题亮光', type: 'gloss', regionId: titleRegion.id, opacity: 0.55, angle: 45, visible: true },
  ];
  const backNodes = [
    node('rect', '背面底色', 0, 0, 630, 880, { fill: palette.base, locked: true }),
    node('rect', '背面外框', 25, 25, 580, 830, { fill: 'transparent', stroke: palette.accent, strokeWidth: 1.5, locked: true }),
    node('ellipse', '系列印记', 232, 250, 166, 166, { fill: 'transparent', stroke: palette.accent, strokeWidth: 1.2 }),
    text('印记文字', 'A', 241, 279, 148, 76, palette.accent, { fontFamily: 'Georgia', align: 'center' }),
    text('背面标题', palette.title, 65, 466, 500, 35, palette.ink, { align: 'center', fontStyle: 'bold' }),
    text('背面副标题', palette.latin, 65, 529, 500, 16, palette.accent, { align: 'center', fontFamily: 'Work Sans' }),
    text('背面说明', palette.note, 90, 620, 450, 17, palette.ink, { align: 'center' }),
    text('背面版权', 'ARCHIVE COLLECTION  /  2026', 65, 810, 500, 12, palette.accent, { align: 'center', fontFamily: 'Work Sans' }),
  ];
  const backBorder = region('背面边框', 'border');
  return {
    id: uid(), name: name || TEMPLATE_NAMES[template], version: 1, widthMm: 63,
    heightMm: 88, bleedMm: 3, cornerRadiusMm: DEFAULT_CARD_CORNER_MM, material: 'holo', updatedAt: Date.now(),
    front: { nodes, regions: [all, border, artRegion, titleRegion], effects },
    back: { nodes: backNodes, regions: [region('整张卡面', 'full'), backBorder], effects: [
      { id: uid(), name: '背面金箔', type: 'gold', regionId: backBorder.id, opacity: 0.8, angle: 32, visible: true },
    ] },
  };
}

export function pentagon(width: number, height: number): number[] {
  return Array.from({ length: 5 }, (_, index) => {
    const angle = index * 2 * Math.PI / 5 - Math.PI / 2;
    return [width * (.5 + .5 * Math.cos(angle)), height * (.5 + .5 * Math.sin(angle))];
  }).flat();
}
