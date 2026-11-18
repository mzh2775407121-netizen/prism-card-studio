import type { CardNode, GradientPoint, ImageFill, LayerGradient } from './model';
import { isOpenVector } from './vectorPaths';

export const MIN_GRADIENT_STOPS = 2;
export const MAX_GRADIENT_STOPS = 12;
const appearanceKeys = [
  'fill', 'fillOpacity', 'fillHidden', 'gradient', 'fillMode', 'imageFill',
  'stroke', 'strokeWidth', 'strokeOpacity', 'strokeHidden', 'strokeAlign', 'strokeStyle',
  'cornerRadius', 'blend', 'opacity',
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

export type FillType = 'solid' | 'linear' | 'radial' | 'image';

export function fillType(node: CardNode): FillType {
  if (node.fillMode === 'solid' || node.fillMode === 'image') return node.fillMode;
  if (node.fillMode === 'gradient') return node.gradient?.kind ?? 'linear';
  if (node.type === 'image') return 'image';
  return node.gradient ? node.gradient.kind ?? 'linear' : 'solid';
}

export function getImageFill(node: CardNode): ImageFill | undefined {
  return node.imageFill ?? (node.type === 'image' && node.src ? { src: node.src, crop: node.crop } : undefined);
}

export function activeImageFill(node: CardNode): ImageFill | undefined {
  return !isOpenVector(node) && fillType(node) === 'image' ? getImageFill(node) : undefined;
}

export function hasFill(node: CardNode) {
  if (isOpenVector(node)) return false;
  const mode = fillType(node);
  return !node.fillHidden && (mode === 'image' ? Boolean(getImageFill(node)) :
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

