export type SideName = 'front' | 'back';
export type TemplateName = 'ocean' | 'botanical' | 'editorial' | 'blank';
export type EffectType = 'holo' | 'gold' | 'silver' | 'gloss' | 'emboss' | 'grain' | 'white';
export const PROCESS_LABELS = {
  reflection: '局部闪光', white: '白墨', foil: '箔版', varnish: '光油',
  primer: '底涂', spot: '专色', emboss: '压凸', deboss: '压凹',
} as const;
export type ProcessKind = keyof typeof PROCESS_LABELS;
export type PrintChannel = Exclude<ProcessKind, 'reflection' | 'varnish'> | 'clear';
export const PRINT_CHANNELS: PrintChannel[] = ['primer', 'white', 'spot', 'foil', 'clear', 'emboss', 'deboss'];
export const STOCK_REFLECTIONS = {
  none: '无反光', mirror: '亮银', 'matte-silver': '亚银', rainbow: '素面彩虹',
  dots: '点闪', 'cracked-ice': '碎冰', pillar: '光柱', radial: '放射镭射',
} as const;
export type StockReflection = keyof typeof STOCK_REFLECTIONS;
export interface StockFinishMatch {
  materialCode: string;
  patternCode?: string;
  orientationDeg: number;
  method: 'composite' | 'underprint' | 'overlaminate';
  transparent: boolean;
  profileKey: string;
  stockKey: string;
}
export interface StockFinish {
  style: StockReflection;
  opacity: number;
  visible?: boolean;
  match?: StockFinishMatch;
  reviewRequired?: boolean;
}
export interface StockSpec {
  grammageGsm?: number;
  thicknessMm?: number;
  core?: 'white' | 'none' | 'blue' | 'black' | 'gray';
}
export const FLASH_STYLES = {
  cosmos: {label:'星空闪',texture:'cosmos-bottom.png'},
  geometric: {label:'几何镭射',texture:'geometric.png'},
  glitter: {label:'细闪',texture:'glitter.png'},
  linear: {label:'虹彩斜纹',texture:''},
  radial: {label:'放射光束',texture:''},
} as const;
export type FlashStyle = keyof typeof FLASH_STYLES;
export interface ImageCrop { x: number; y: number; width: number; height: number; space?: 'source' }
export interface ImageFill { src: string; fit?: 'cover' | 'contain'; crop?: ImageCrop }
export type GradientPoint = [number, number];
export interface LayerGradient {
  kind?: 'linear' | 'radial';
  angle: number;
  stops: [number, string][];
  endpoints?: [GradientPoint, GradientPoint];
}
export interface PathCoordinate { x: number; y: number }
export interface PathPoint extends PathCoordinate { in?: PathCoordinate; out?: PathCoordinate }
export type LayoutDirection = 'horizontal' | 'vertical';
export type LayoutAlignment = 'start' | 'center' | 'end';
export type LayoutSizeMode = 'fixed' | 'hug' | 'fill';
export interface LayoutItem {
  widthMode?: LayoutSizeMode;
  heightMode?: LayoutSizeMode;
}
export interface AutoLayout {
  x: number; y: number; width: number; height: number;
  direction: LayoutDirection;
  widthMode: 'fixed' | 'hug';
  heightMode: 'fixed' | 'hug';
  align: LayoutAlignment;
  gap: number;
  padding: { top: number; right: number; bottom: number; left: number };
}
export interface CardNode {
  id: string; name: string; type: 'empty' | 'image' | 'text' | 'rect' | 'ellipse' | 'polygon' | 'line' | 'path';
  x: number; y: number; width: number; height: number; rotation: number;
  flipX?: boolean; flipY?: boolean;
  opacity: number; visible: boolean; locked: boolean; fill: string;
  stroke?: string; strokeWidth?: number; text?: string; fontSize?: number;
  fillOpacity?: number; fillHidden?: boolean;
  fillMode?: 'solid' | 'gradient' | 'image';
  imageFill?: ImageFill;
  strokeOpacity?: number; strokeHidden?: boolean;
  strokeAlign?: 'inside' | 'center' | 'outside'; strokeStyle?: 'solid' | 'dashed' | 'dotted';
  fontFamily?: string; fontStyle?: string; align?: string; src?: string;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  crop?: ImageCrop;
  blend?: string; lineHeight?: number; letterSpacing?: number; cornerRadius?: number; groupId?: string;
  clipRegionId?: string;
  unclassified?: boolean;
  maskInk?: 'alpha' | 'dark';
  polygon?: number[];
  pathPoints?: PathPoint[];
  pathClosed?: boolean;
  gradient?: LayerGradient;
  layoutItem?: LayoutItem;
}
export interface Stroke { points: number[]; size: number; erase: boolean }
export interface Region {
  id: string; name: string; kind: 'full' | 'border' | 'node' | 'paint' | 'rect' | 'ellipse' | 'polygon' | 'union';
  nodeId?: string; binding: 'fixed' | 'follow'; inverted: boolean; strokes: Stroke[];
  bounds?: { x: number; y: number; width: number; height: number; rotation: number };
  snapshot?: CardNode;
  points?: number[];
  sources?: string[];
  groupMotionCopy?: true;
  maskSource?: true;
}
export interface Effect {
  id: string; name: string; type: EffectType; regionId: string;
  opacity: number; angle: number; visible: boolean;
  productionEnabled?: boolean;
  process?: ProcessKind;
  pattern?: 'linear' | 'radial' | 'grain';
  flashStyle?: FlashStyle;
  maskContent?: CardNode[];
  groupId?: string;
}
export interface LayerGroup {
  id: string; name: string; parentId?: string;
  autoLayout?: AutoLayout;
  layoutItem?: LayoutItem;
}
export interface CardSide {
  nodes: CardNode[];
  regions: Region[];
  effects: Effect[];
  groups?: LayerGroup[];
  reference?: { src: string; name: string };
  stockFinish?: StockFinish;
}
interface CardDesign {
  widthMm: number; heightMm: number; bleedMm: number; material: string;
  previewStyle?: 'cosmos' | 'geometric' | 'glitter' | 'original'; front: CardSide; back: CardSide;
  cornerRadiusMm?: number;
  singleSided?: boolean;
  stockReflection?: StockReflection;
  stockSpec?: StockSpec;
  production?: import('./production').ProductionPlan;
}
interface ProjectIdentity {
  id: string; name: string; version: number; updatedAt: number;
  note?: string;
}
export interface ProjectCard extends CardDesign {
  id: string;
  name: string;
}
export interface StoredProjectDocument extends ProjectIdentity {
  cards: ProjectCard[];
}
// The single-card editor edits the first card in place. Storage serializes it
// alongside the other cards, leaving all existing editing and undo paths intact.
export interface Project extends ProjectIdentity, CardDesign {
  cardId?: string;
  cardName?: string;
  additionalCards?: ProjectCard[];
}

export function projectCards(project: Project): ProjectCard[] {
  const { cardId, cardName, additionalCards, id, name: _name, version: _version, updatedAt: _updatedAt, note: _note, ...design } = project;
  return [{ id: cardId ?? id + '_1', name: cardName ?? '卡牌 1', ...design }, ...(additionalCards ?? [])];
}

export function projectForCard(project: ProjectIdentity, card: ProjectCard): Project {
  const { id, name, version, updatedAt, note } = project;
  const { id: cardId, name: cardName, ...design } = card;
  return { ...design, id, name, version, updatedAt, note, cardId, cardName };
}

export function serializeProject(project: Project): StoredProjectDocument {
  const { id, name, version, updatedAt, note } = project;
  return { id, name, version, updatedAt, note, cards: projectCards(project) };
}

export function hydrateProject(document: Project | StoredProjectDocument): Project {
  if (!('cards' in document)) return { ...document, cardId: document.cardId ?? document.id + '_1', cardName: document.cardName ?? '卡牌 1' };
  const [first, ...additionalCards] = document.cards;
  return { ...projectForCard(document, first), ...(additionalCards.length ? { additionalCards } : {}) };
}

export function copyProject(project: Project, name = project.name, version = project.version): Project {
  const document = structuredClone(serializeProject(project));
  return hydrateProject({ ...document, id: uid(), name, version,
    cards: document.cards.map(card => ({ ...card, id: uid() })),
  });
}

export const MAX_PROJECT_NOTE_LENGTH = 500;
export const DEFAULT_CARD_CORNER_MM = 1.8;

export function isValidProjectNote(value: unknown): value is Project['note'] {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_PROJECT_NOTE_LENGTH * 2 &&
    [...value].length <= MAX_PROJECT_NOTE_LENGTH);
}

export function getCardCornerRadiusMm(project: Pick<Project, 'widthMm' | 'heightMm' | 'cornerRadiusMm'>) {
  return Math.max(0, Math.min(project.cornerRadiusMm ?? DEFAULT_CARD_CORNER_MM, project.widthMm / 2, project.heightMm / 2));
}

export function getStockReflection(project: Project, side?: SideName | CardSide): StockReflection {
  const face = typeof side === 'string' ? project[side] : side;
  if (face?.stockFinish) return face.stockFinish.style;
  return project.stockReflection ?? (project.material === 'holo' ? 'rainbow' : project.material === 'silver' ? 'mirror' : 'none');
}

export function getStockFinish(project: Project, side: SideName | CardSide): StockFinish {
  const face = typeof side === 'string' ? project[side] : side;
  return face.stockFinish ?? { style: getStockReflection(project), opacity: 1 };
}

export function isStockReflection(value: unknown): value is StockReflection {
  return typeof value === 'string' && Object.hasOwn(STOCK_REFLECTIONS, value);
}

function specRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function specNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function specText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= maxLength;
}

export function isValidStockSpec(value: unknown): value is StockSpec {
  return specRecord(value)
    && (value.grammageGsm === undefined || specNumber(value.grammageGsm, 1, 2000))
    && (value.thicknessMm === undefined || specNumber(value.thicknessMm, .01, 10))
    && (value.core === undefined || (typeof value.core === 'string' && ['white', 'none', 'blue', 'black', 'gray'].includes(value.core)))
    && (value.grammageGsm === undefined || value.thicknessMm === undefined);
}

export function isValidStockFinish(value: unknown): value is StockFinish {
  if (!specRecord(value) || !isStockReflection(value.style) || !specNumber(value.opacity, 0, 1)
    || (value.visible !== undefined && typeof value.visible !== 'boolean')
    || (value.reviewRequired !== undefined && typeof value.reviewRequired !== 'boolean')) return false;
  const match = value.match;
  return match === undefined || (value.style !== 'none' && specRecord(match)
    && specText(match.materialCode, 120) && (match.patternCode === undefined || specText(match.patternCode, 120))
    && specNumber(match.orientationDeg, -360, 360) && typeof match.transparent === 'boolean'
    && typeof match.method === 'string' && ['composite', 'underprint', 'overlaminate'].includes(match.method)
    && specText(match.profileKey, 4000) && specText(match.stockKey, 4000));
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

export function plateFor(effect: Effect): PrintChannel | undefined {
  const kind = processKind(effect);
  return kind === 'varnish' ? 'clear' : kind === 'reflection' ? undefined : kind;
}

export function processLayerEnabled(effect: Effect): boolean {
  return effect.visible && (effect.process !== undefined && plateFor(effect) !== undefined || effect.opacity > 0);
}

export function effectInProduction(effect: Effect): boolean {
  return effect.productionEnabled ?? processLayerEnabled(effect);
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
  if (template === 'blank') {
    const blankSide = (): CardSide => ({
      nodes: [], regions: [region('整张卡面', 'full'), region('卡片边框', 'border')], effects: [],
      stockFinish: { style: 'none', opacity: 1 },
    });
    return { id: uid(), name: name || TEMPLATE_NAMES.blank, version: 1, widthMm: 63,
      heightMm: 88, bleedMm: 3, cornerRadiusMm: DEFAULT_CARD_CORNER_MM, material: 'matte', front: blankSide(),
      back: blankSide(), updatedAt: Date.now(), cardId: uid(), cardName: '卡牌 1' };
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
