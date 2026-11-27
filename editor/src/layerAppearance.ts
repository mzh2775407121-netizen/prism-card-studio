import type { CardNode, GradientPoint, ImageFill, LayerGradient } from './model';
import { PATTERN_TILE_SCALE } from './model';
import { isOpenVector } from './vectorPaths';

export const MIN_GRADIENT_STOPS = 2;
export const MAX_GRADIENT_STOPS = 24;
export const MAX_VISUAL_EFFECTS = 12;
export const MAX_STYLE_PRESETS = 32;
export const MAX_STYLE_PRESET_NAME = 40;
export const roundGradientOffset = (offset: number) => Math.round(offset * 10000) / 10000;
export { gradientStopIds } from './model';
export const METAL_GRADIENTS: { label: string; stops: LayerGradient['stops'] }[] = [
  { label: '哑银', stops: [[0,'#58606E'],[.22,'#AAB4C0'],[.42,'#E8EDF2'],[.47,'#F9FAFD'],[.51,'#8D9BA9'],[.74,'#CED6DD'],[1,'#657282']] },
  { label: '暖金', stops: [[0,'#693B17'],[.21,'#B17035'],[.38,'#E8B75D'],[.47,'#FFF1BD'],[.50,'#FFE6A4'],[.53,'#AD682B'],[.78,'#E0A854'],[1,'#855223']] },
  { label: '深色金属', stops: [[0,'#141924'],[.22,'#2C3444'],[.4,'#4C586A'],[.465,'#8794A5'],[.5,'#273041'],[.72,'#475568'],[1,'#161C26']] },
];
const appearanceKeys = [
  'fill', 'fillOpacity', 'fillHidden', 'gradient', 'fillMode', 'imageFill',
  'stroke', 'strokeWidth', 'strokeOpacity', 'strokeHidden', 'strokeAlign', 'strokeStyle',
  'cornerRadius', 'blend', 'opacity', 'visualEffects',
] as const;
type AppearanceValues = Pick<CardNode, typeof appearanceKeys[number]>;
export type LayerAppearance = { sourceType: CardNode['type']; values: AppearanceValues };

export function copyAppearance(node: CardNode): LayerAppearance {
  const values = structuredClone(Object.fromEntries(appearanceKeys.map(key => [key, node[key]]))) as AppearanceValues;
  const mode = fillType(node);
  values.fillMode = mode === 'linear' || mode === 'radial' ? 'gradient' : mode;
  values.imageFill = structuredClone(getImageFill(node));
  return { sourceType: node.type, values };
}

export function pasteAppearance(target: CardNode, appearance: LayerAppearance): Partial<CardNode> {
  const next = structuredClone(appearance.values);
  if (![appearance.sourceType, target.type].every(type => type === 'image' || type === 'rect')) next.cornerRadius = target.cornerRadius;
  if (appearance.sourceType === 'text' || target.type === 'text' || isOpenVector(target)) {
    next.strokeAlign = target.strokeAlign;
  }
  if (appearance.sourceType === 'text' || target.type === 'text') {
    next.strokeStyle = target.strokeStyle;
  }
  return next;
}

export type FillType = 'solid' | 'linear' | 'radial' | 'image' | 'pattern';

export function fillType(node: CardNode): FillType {
  if (node.fillMode === 'solid' || node.fillMode === 'image' || node.fillMode === 'pattern') return node.fillMode;
  if (node.fillMode === 'gradient') return node.gradient?.kind ?? 'linear';
  if (node.type === 'image') return 'image';
  return node.gradient ? node.gradient.kind ?? 'linear' : 'solid';
}

export function getImageFill(node: CardNode): ImageFill | undefined {
  return node.imageFill ?? (node.type === 'image' && node.src ? { src: node.src, crop: node.crop } : undefined);
}

export function activeImageFill(node: CardNode): ImageFill | undefined {
  const mode = fillType(node);
  return !isOpenVector(node) && (mode === 'image' || mode === 'pattern') ? getImageFill(node) : undefined;
}

export function patternTileWidth(node: CardNode, fill: ImageFill | undefined) {
  if (node.fillMode !== 'pattern' || fill?.fit !== 'tile') return undefined;
  return node.width * (fill.tileScale ?? PATTERN_TILE_SCALE.default);
}

export function hasFill(node: CardNode) {
  if (isOpenVector(node)) return false;
  const mode = fillType(node);
  return !node.fillHidden && (mode === 'image' || mode === 'pattern' ? Boolean(getImageFill(node)) :
    mode === 'solid' ? node.fill !== 'transparent' : Boolean(node.gradient));
}

export function hasStroke(node: CardNode) {
  return !node.strokeHidden && Boolean(node.stroke && node.strokeWidth && node.strokeWidth > 0);
}

export function gradientPoints(gradient: LayerGradient, width: number, height: number): [GradientPoint, GradientPoint] {
  if (gradient.endpoints) return gradient.endpoints.map(([x, y]) => [x * width, y * height]) as [GradientPoint, GradientPoint];
  if (gradient.kind === 'radial') return [[width / 2, height / 2], [width, height / 2]];
  const angle = gradient.angle * Math.PI / 180;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const length = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  return [[width / 2 - dx * length, height / 2 - dy * length], [width / 2 + dx * length, height / 2 + dy * length]];
}

export function gradientAngle([a,b]: [GradientPoint,GradientPoint]) {
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI + 360) % 360;
}

