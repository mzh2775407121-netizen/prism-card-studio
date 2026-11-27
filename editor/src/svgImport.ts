import { readImage } from './io';
import { MAX_GRADIENT_STOPS } from './layerAppearance';
import { uid, type CardNode, type GradientPoint, type LayerGradient, type LayerGroup, type PathPoint, type VisualEffect } from './model';
import { parseSvgPath, svgNumbers } from './svgPathData';
import { ellipsePath, mapVectorPoints, MAX_PATH_POINTS, normalizeContours, rectanglePath, splitPathSegment, vectorBounds } from './vectorPaths';

const namespace = 'http://www.w3.org/2000/svg';
const maxObjects = 400;
const metric = { px: 254 / 96, in: 254, cm: 100, mm: 10, pt: 254 / 72, pc: 254 / 6 };
const shapes = new Set(['rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'path']);
const gradients = new Set(['linearGradient', 'radialGradient']);
const styleKeys = new Set(['color', 'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'opacity', 'display', 'visibility', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stop-color', 'stop-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'vector-effect', 'filter', 'clip-path', 'mask',
  'flood-color', 'flood-opacity', 'color-interpolation-filters']);
const baseKeys = new Set(['id', 'class', 'style', 'transform', 'role', 'version', 'focusable', 'tabindex']);
const nonRenderingStyleKeys = new Set(['cursor', 'pointer-events']);
const attrs: Record<string, string[]> = {
  svg: ['viewBox', 'width', 'height', 'preserveAspectRatio'], rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], polygon: ['points'], polyline: ['points'],
  line: ['x1', 'y1', 'x2', 'y2'], path: ['d'],
  linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  filter: ['x', 'y', 'width', 'height', 'filterUnits', 'primitiveUnits'],
  feDropShadow: ['in', 'result', 'dx', 'dy', 'stdDeviation', 'x', 'y', 'width', 'height'],
  feGaussianBlur: ['in', 'result', 'stdDeviation', 'edgeMode', 'x', 'y', 'width', 'height'],
  stop: ['offset'],
};
const unsupported: Record<string, string> = {
  filter: '滤镜', mask: '高级蒙版', 'clip-path': '剪切路径', clipPath: '剪切路径', text: '文字', tspan: '文字',
  image: '嵌入图片', foreignObject: '嵌入网页内容', script: '脚本', style: '样式表', class: '样式类',
  href: '引用', use: '复用引用', pattern: '图案填充', marker: '标记',
};
const names: Record<string, string> = { rect: '矩形', ellipse: '椭圆', circle: '圆形', path: '路径', line: '直线', polygon: '多边形', polyline: '折线', g: '组合' };

type Box = { x: number; y: number; width: number; height: number };
type StageSize = Pick<Box, 'width' | 'height'>;
type Paint = {
  color: string; fill: string; fillOpacity: number; stroke: string; strokeWidth: number; strokeOpacity: number;
  displayed: boolean; visibility: string; fillRule: string; strokeCap: string; strokeJoin: string; strokeMiter: number;
  strokeDash: string; strokeDashOffset: string;
};

function unsupportedItem(name: string): never {
  throw new Error(`SVG 含有暂不支持的${unsupported[name] ?? '项目'}（${name}）。`);
}

function length(value: string, acceptedPercent?: number) {
  const match = value.trim().match(/^([-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[Ee][-+]?\d+)?)([a-z%]*)$/i);
  if (!match) throw new Error(`SVG 尺寸格式无效（${value.slice(0, 45)}）。`);
  const amount = +match[1], unit = match[2].toLowerCase();
  const factor = unit === '' ? 1 : unit === '%' && acceptedPercent !== undefined ? acceptedPercent / 100 :
    Object.hasOwn(metric, unit) ? metric[unit as keyof typeof metric] / metric.px : undefined;
  if (factor === undefined || !Number.isFinite(amount * factor)) throw new Error('SVG 尺寸单位不受支持。');
  return amount * factor;
}

function field(element: Element, attribute: string, defaultValue = '0', percentage?: number) {
  return length(element.getAttribute(attribute) ?? defaultValue, percentage);
}

function viewportLength(value: string, viewBoxLength?: number) {
  const relative = /^(\d*\.\d+|\d+\.?\d*)r?em$/i.exec(value.trim());
  return relative ? +relative[1] * 16 : length(value, viewBoxLength);
}

function title(element: Element, fallback: string) {
  return (Array.from(element.children).find(child => child.localName === 'title')?.textContent?.trim() ||
    element.getAttribute('aria-label') || element.getAttribute('id') || fallback).slice(0, 150);
}

function properties(element: Element) {
  const result = new Map<string, string>();
  for (const attribute of element.attributes) {
    const { name, localName, value, namespaceURI } = attribute;
    if (namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
    if (namespaceURI || /^on/i.test(name)) unsupportedItem(localName);
    if (styleKeys.has(name)) result.set(name, value.trim());
    else if (!baseKeys.has(name) && !nonRenderingStyleKeys.has(name) && !/^(?:aria|data)-[\w-]+$/.test(name)
      && !(attrs[element.localName] ?? []).includes(name)) unsupportedItem(name);
  }
  for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
    if (!declaration.trim()) continue;
    const match = /^\s*([a-zA-Z-]+)\s*:\s*(.+?)\s*$/.exec(declaration);
    if (!match) unsupportedItem('style');
    const key = match[1].toLowerCase();
    if (nonRenderingStyleKeys.has(key)) continue;
    if (!styleKeys.has(key)) unsupportedItem(key);
    result.set(key, match[2].replace(/\s*!important\s*$/i, ''));
  }
  return result;
}

function opacity(value: string | undefined, fallback: number) {
  return value === undefined ? fallback : Math.min(1, Math.max(0, length(value, 1)));
}

function matrix(text: string | null) {
  let transform = new DOMMatrix();
  const value = text?.trim() ?? '';
  const operations = /([A-Za-z]+)\s*\(([^()]*)\)/g;
  let previous = 0;
  for (const operation of value.matchAll(operations)) {
    const [, name, coordinates] = operation;
    if (value.slice(previous, operation.index).replace(/[\s,]/g, '')) unsupportedItem('transform');
    previous = operation.index + operation[0].length;
    const p = svgNumbers(coordinates);
    let next: DOMMatrix | undefined;
    if (name === 'matrix' && p.length === 6) next = new DOMMatrix(p);
    if (name === 'translate' && [1, 2].includes(p.length)) next = new DOMMatrix().translate(p[0], p[1] ?? 0);
    if (name === 'scale' && [1, 2].includes(p.length)) next = new DOMMatrix().scale(p[0], p[1] ?? p[0]);
    if (name === 'rotate' && [1, 3].includes(p.length)) next = new DOMMatrix().translate(p[1] ?? 0, p[2] ?? 0)
      .rotate(p[0]).translate(-(p[1] ?? 0), -(p[2] ?? 0));
    if (name === 'skewX' && p.length === 1) next = new DOMMatrix().skewX(p[0]);
    if (name === 'skewY' && p.length === 1) next = new DOMMatrix().skewY(p[0]);
    if (!next) unsupportedItem('transform');
    transform = transform.multiply(next);
  }
  if (value.slice(previous).replace(/[\s,]/g, '')) unsupportedItem('transform');
  if (!Number.isFinite(transform.a * transform.d - transform.b * transform.c)) unsupportedItem('transform');
  return transform;
}

function unitScale(transform: DOMMatrix) {
  const a = Math.hypot(transform.a, transform.b), b = Math.hypot(transform.c, transform.d);
  const tolerance = Math.max(a, b) * 1e-7;
  return Math.abs(a - b) <= tolerance && Math.abs(transform.a * transform.c + transform.b * transform.d) <= tolerance * Math.max(a, b)
    ? a : undefined;
}

let colorContext: CanvasRenderingContext2D | undefined;

function cssColor(value: string, opacity = 1) {
  if (/(?:var\s*\(|currentcolor|\binherit\b|\binitial\b|\bunset\b|\brevert\b)/i.test(value) || !CSS.supports('color', value)) {
    throw new Error(`SVG 颜色格式不受支持（${value.slice(0, 45)}）。`);
  }
  if (!colorContext) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    colorContext = canvas.getContext('2d', { willReadFrequently: true })!;
  }
  colorContext.fillStyle = value;
  const paint = String(colorContext.fillStyle);
  const byte = (n: number) => Math.round(n).toString(16).padStart(2, '0').toUpperCase();
  const alpha = (rgb: string, amount: number) => amount >= 1 ? rgb : rgb + byte(amount * 255);
  if (/^#[a-f0-9]{6}$/i.test(paint)) return alpha(paint.toUpperCase(), opacity);
  const rgba = /^rgba?\(([^)]+)\)$/.exec(paint)?.[1].split(',').map(Number);
  if (rgba && rgba.length >= 3 && rgba.every(Number.isFinite)) {
    const [r, g, b, a = 1] = rgba;
    return alpha('#' + byte(r) + byte(g) + byte(b), a * opacity);
  }
  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
  return alpha('#' + byte(r) + byte(g) + byte(b), a / 255 * opacity);
}

function inheritedValue(value: string | undefined, inherited: string, initial: string) {
  if (value === undefined || /^(inherit|unset|revert)$/i.test(value)) return inherited;
  return /^initial$/i.test(value) ? initial : value;
}

function resolvedColor(value: string, color: string) {
  return /^currentColor$/i.test(value) ? color : value;
}

function paintStyle(parent: Paint, values: Map<string, string>, viewport: StageSize): Paint {
  const diagonal = Math.hypot(viewport.width, viewport.height) / Math.SQRT2;
  const strokeWidth = length(inheritedValue(values.get('stroke-width'), String(parent.strokeWidth), '1'), diagonal);
  if (strokeWidth < 0) throw new Error('SVG 描边宽度无效。');
  return {
    color: resolvedColor(inheritedValue(values.get('color'), parent.color, defaultPaint.color), parent.color),
    fill: inheritedValue(values.get('fill'), parent.fill, defaultPaint.fill),
    fillOpacity: opacity(inheritedValue(values.get('fill-opacity'), String(parent.fillOpacity), '1'), 1),
    fillRule: inheritedValue(values.get('fill-rule'), parent.fillRule, defaultPaint.fillRule),
    stroke: inheritedValue(values.get('stroke'), parent.stroke, defaultPaint.stroke),
    strokeWidth,
    strokeOpacity: opacity(inheritedValue(values.get('stroke-opacity'), String(parent.strokeOpacity), '1'), 1),
    strokeCap: inheritedValue(values.get('stroke-linecap'), parent.strokeCap, defaultPaint.strokeCap),
    strokeJoin: inheritedValue(values.get('stroke-linejoin'), parent.strokeJoin, defaultPaint.strokeJoin),
    strokeMiter: length(inheritedValue(values.get('stroke-miterlimit'), String(parent.strokeMiter), '4')),
    strokeDash: inheritedValue(values.get('stroke-dasharray'), parent.strokeDash, 'none'),
    strokeDashOffset: inheritedValue(values.get('stroke-dashoffset'), parent.strokeDashOffset, '0'),
    displayed: parent.displayed && values.get('display') !== 'none',
    visibility: inheritedValue(values.get('visibility'), parent.visibility, 'visible'),
  };
}

const defaultPaint: Paint = { color: '#000000', fill: '#000000', fillOpacity: 1, fillRule: 'nonzero',
  stroke: 'none', strokeWidth: 1, strokeOpacity: 1, strokeCap: 'butt', strokeJoin: 'miter', strokeMiter: 4,
  strokeDash: 'none', strokeDashOffset: '0', displayed: true, visibility: 'visible' };

type ShapeGeometry = {
  contours?: PathPoint[][];
  points: PathPoint[];
  closed: boolean;
  primitive?: { type: 'rect'; circularCorners: boolean; cornerRadius: number } | { type: 'ellipse' | 'line' | 'polygon' };
};

function shapeGeometry(element: Element, viewport: StageSize): ShapeGeometry {
  const x = (key: string, fallback?: string) => field(element, key, fallback, viewport.width);
  const y = (key: string, fallback?: string) => field(element, key, fallback, viewport.height);
  const { localName } = element;
  if (localName === 'path') return parseSvgPath(element.getAttribute('d') ?? '');
  if (localName === 'rect') {
    const width = x('width'), height = y('height');
    const rx = x('rx', element.getAttribute('ry') ?? '0'), ry = y('ry', element.getAttribute('rx') ?? '0');
    if (width <= 0 || height <= 0 || rx < 0 || ry < 0) throw new Error('SVG 矩形尺寸无效。');
    return { points: rectanglePath(x('x'), y('y'), width, height, rx, ry), closed: true,
      primitive: { type: 'rect' as const, circularCorners: Math.abs(rx - ry) < 1e-8, cornerRadius: Math.min(rx, width / 2, height / 2) } };
  }
  if (localName === 'ellipse' || localName === 'circle') {
    const radius = localName === 'circle' ? field(element, 'r', '0', Math.hypot(viewport.width, viewport.height) / Math.SQRT2) : undefined;
    const rx = radius ?? x('rx'), ry = radius ?? y('ry');
    if (rx <= 0 || ry <= 0) throw new Error('SVG 椭圆尺寸无效。');
    return { points: ellipsePath(x('cx'), y('cy'), rx, ry), closed: true, primitive: { type: 'ellipse' as const } };
  }
  if (localName === 'line') {
    return { points: [{ x: x('x1'), y: y('y1') }, { x: x('x2'), y: y('y2') }], closed: false, primitive: { type: 'line' as const } };
  }
  const coordinates = svgNumbers(element.getAttribute('points') ?? '');
  if (coordinates.length % 2 || coordinates.length > MAX_PATH_POINTS * 2) throw new Error('SVG 多边形节点无效。');
  const points = coordinates.filter((_, index) => index % 2 === 0).map((x, index) => ({ x, y: coordinates[index * 2 + 1] }));
  return { points, closed: localName === 'polygon',
    primitive: localName === 'polygon' && points.length <= 256 ? { type: 'polygon' as const } : undefined };
}

function readGradient(element: Element, object: Box, node: Box, world: DOMMatrix, viewport: StageSize,
  colorAt: (element: Element) => string): LayerGradient {
  const units = element.getAttribute('gradientUnits') ?? 'objectBoundingBox';
  if (!['objectBoundingBox', 'userSpaceOnUse'].includes(units)) unsupportedItem('gradientUnits');
  if ((element.getAttribute('spreadMethod') ?? 'pad') !== 'pad') unsupportedItem('spreadMethod');
  const bounded = units === 'objectBoundingBox';
  const transform = world.multiply(bounded
    ? new DOMMatrix().translate(object.x, object.y).scale(object.width, object.height) : new DOMMatrix())
    .multiply(matrix(element.getAttribute('gradientTransform')));
  const x = ( key: string, fallback: string) => field(element, key, fallback, bounded ? 1 : viewport.width);
  const y = ( key: string, fallback: string) => field(element, key, fallback, bounded ? 1 : viewport.height);
  const normalize = ({ x, y }: DOMPoint): GradientPoint => [(x - node.x) / node.width, (y - node.y) / node.height];
  const kind = element.localName === 'radialGradient' ? 'radial' : 'linear';
  let start: DOMPoint, end: DOMPoint;
  let radialAxis: GradientPoint | undefined;
  if (kind === 'radial') {
    const cx = x('cx', '50%'), cy = y('cy', '50%');
    const r = field(element, 'r', '50%', bounded ? 1 : Math.hypot(viewport.width, viewport.height) / Math.SQRT2);
    const fx = x('fx', element.getAttribute('cx') ?? '50%'), fy = y('fy', element.getAttribute('cy') ?? '50%');
    if (r <= 0 || !Number.isFinite(transform.inverse().a) || field(element, 'fr', '0', 1) !== 0 || fx !== cx || fy !== cy) {
      throw new Error('SVG 含有偏心或无半径的径向渐变。当前支持同心径向渐变。');
    }
    start = transform.transformPoint(new DOMPoint(cx, cy));
    end = transform.transformPoint(new DOMPoint(cx + r, cy));
    if (!unitScale(transform)) {
      const vertical = transform.transformPoint(new DOMPoint(cx, cy + r));
      radialAxis = [(vertical.x - start.x) / node.width, (vertical.y - start.y) / node.height];
      if (radialAxis.some(value => !Number.isFinite(value) || Math.abs(value) > 5)) throw new Error('SVG 渐变副轴超出可编辑范围。');
    }
  } else {
    const x1 = x('x1', '0%'), y1 = y('y1', '0%');
    const dx = x('x2', '100%') - x1, dy = y('y2', '0%') - y1;
    start = transform.transformPoint(new DOMPoint(x1, y1));
    if (!dx && !dy) throw new Error('SVG 线性渐变的端点重合。');
    const inverse = transform.inverse();
    const nx = inverse.a * dx + inverse.b * dy, ny = inverse.c * dx + inverse.d * dy;
    const scale = (dx * dx + dy * dy) / (nx * nx + ny * ny);
    end = new DOMPoint(start.x + nx * scale, start.y + ny * scale);
  }
  const endpoints: [GradientPoint, GradientPoint] = [normalize(start), normalize(end)];
  if (endpoints.some(point => point.some(value => !Number.isFinite(value) || value < -2 || value > 3))) {
    throw new Error('SVG 渐变端点超出可编辑范围。');
  }
  const stops: LayerGradient['stops'] = [];
  for (const child of element.children) {
    if (['title', 'desc'].includes(child.localName)) continue;
    if (child.localName !== 'stop') unsupportedItem(child.localName);
    const style = properties(child);
    const position = Math.max(stops.at(-1)?.[0] ?? 0, opacity(child.getAttribute('offset') ?? '0', 0));
    const color = cssColor(resolvedColor(style.get('stop-color') ?? '#000000', colorAt(child)), opacity(style.get('stop-opacity'), 1));
    stops.push([position, color]);
  }
  if (!stops.length || stops.length > MAX_GRADIENT_STOPS) throw new Error(`SVG 渐变须有 1–${MAX_GRADIENT_STOPS} 个色标。`);
  if (stops.length === 1) stops.push([1, stops[0][1]]);
  return { kind, angle: Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI, endpoints, stops, radialAxis };
}

function localReference(value: string | undefined) {
  return value && /^url\(\s*(['"]?)#([\w.:-]+)\1\s*\)$/i.exec(value)?.[2];
}

function hasEffect(value: string | undefined) {
  return Boolean(value && value !== 'none');
}

function simpleFilter(filter: Element, object: Box, transform: DOMMatrix, viewport: StageSize,
  strokePadding: number, colorAt: (element: Element) => string): VisualEffect | undefined {
  const primitives = [...filter.children].filter(child => !['title', 'desc', 'metadata'].includes(child.localName));
  const primitive = primitives[0];
  const scale = unitScale(transform);
  if (!scale || primitives.length !== 1 || (filter.getAttribute('primitiveUnits') ?? 'userSpaceOnUse') !== 'userSpaceOnUse' ||
    (primitive.getAttribute('in') ?? 'SourceGraphic') !== 'SourceGraphic' ||
    ['x','y','width','height'].some(key => primitive.hasAttribute(key))) unsupportedItem('filter');
  const shadow = primitive.localName === 'feDropShadow';
  if (!shadow && (primitive.localName !== 'feGaussianBlur' || (primitive.getAttribute('edgeMode') ?? 'none') !== 'none')) {
    unsupportedItem('filter');
  }
  const deviation = svgNumbers(primitive.getAttribute('stdDeviation') ?? (shadow ? '2' : '0'));
  const sigma = deviation[0];
  if (!Number.isFinite(sigma) || sigma < 0 || deviation.length > 2 ||
    (deviation.length === 2 && deviation[1] !== sigma)) unsupportedItem('filter');
  const x = shadow ? field(primitive, 'dx', '2') : 0;
  const y = shadow ? field(primitive, 'dy', '2') : 0;
  const margin = sigma * 3;
  const objectUnits = (filter.getAttribute('filterUnits') ?? 'objectBoundingBox') === 'objectBoundingBox';
  if (!objectUnits && filter.getAttribute('filterUnits') !== 'userSpaceOnUse') unsupportedItem('filter');
  const lengthX = (key: string, fallback: string) => field(filter, key, fallback, objectUnits ? 1 : viewport.width);
  const lengthY = (key: string, fallback: string) => field(filter, key, fallback, objectUnits ? 1 : viewport.height);
  const left = objectUnits ? object.x + lengthX('x', '-10%') * object.width : lengthX('x', '-10%');
  const top = objectUnits ? object.y + lengthY('y', '-10%') * object.height : lengthY('y', '-10%');
  const right = left + lengthX('width', '120%') * (objectUnits ? object.width : 1);
  const bottom = top + lengthY('height', '120%') * (objectUnits ? object.height : 1);
  // A native effect cannot crop the result to an SVG filter region.
  if (left > object.x - strokePadding + Math.min(0, x - margin) + 1e-6 ||
    top > object.y - strokePadding + Math.min(0, y - margin) + 1e-6 ||
    right < object.x + object.width + strokePadding + Math.max(0, x + margin) - 1e-6 ||
    bottom < object.y + object.height + strokePadding + Math.max(0, y + margin) - 1e-6) unsupportedItem('filter');
  const radius = sigma * scale;
  if (radius > 500) unsupportedItem('filter');
  if (!shadow) return radius ? { id: uid(), enabled: true, kind: 'gaussian-blur', radius } : undefined;
  const dx = transform.a * x + transform.c * y, dy = transform.b * x + transform.d * y;
  if (Math.abs(dx) > 500 || Math.abs(dy) > 500) unsupportedItem('filter');
  const style = properties(primitive);
  const color = cssColor(resolvedColor(style.get('flood-color') ?? '#000000', colorAt(primitive)));
  return { id: uid(), enabled: true, kind: 'drop-shadow', x: dx, y: dy, radius, spread: 0,
    color, opacity: opacity(style.get('flood-opacity'), 1) };
}

async function openSvg(file: File) {
  if (file.size > 2_000_000) throw new Error('SVG 文件需小于 2 MB。');
  const source = await file.text();
  if (/<!\s*(?:doctype|entity)|<\?xml-stylesheet/i.test(source)) unsupportedItem('SVG 声明');
  const parser = new DOMParser();
  let document = parser.parseFromString(source, 'image/svg+xml');
  let root = document.documentElement;
  if (root.nodeName === 'svg' && root.namespaceURI === null && !root.hasAttribute('xmlns')) {
    const standalone = root.outerHTML.replace(/^<svg(?=[\s/>])/, `<svg xmlns="${namespace}"`);
    document = parser.parseFromString(standalone, 'image/svg+xml');
    root = document.documentElement;
  }
  if (root.namespaceURI !== namespace || root.localName !== 'svg' || document.querySelector('parsererror')) {
    throw new Error('无法读取此 SVG 文件。');
  }
  return root;
}

export async function readEditableSvg(file: File, target: StageSize, sizing: 'fit' | 'actual' = 'fit') {
  const root = await openSvg(file);
  const children = [...root.querySelectorAll('*')];
  if (children.length > maxObjects * 3) throw new Error('SVG 元素过多，请分批导入。');
  const definitions = new Map<string, Element>();
  const styles = new Map<Element, Map<string, string>>();
  for (const element of [root, ...children]) {
    const tag = element.localName;
    if (element.namespaceURI !== namespace || !shapes.has(tag) && !gradients.has(tag)
      && !['svg', 'defs', 'title', 'desc', 'g', 'stop', 'metadata', 'filter', 'feDropShadow', 'feGaussianBlur'].includes(tag)) {
      unsupportedItem(tag.startsWith('fe') ? 'filter' : tag);
    }
    styles.set(element, properties(element));
    if (gradients.has(tag) || tag === 'filter') {
      const id = element.id;
      if (!id || definitions.has(id)) throw new Error('SVG 渐变或滤镜标识为空或重复。');
      definitions.set(id, element);
    }
  }
  const colorAt = (element: Element) => {
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const color = styles.get(ancestor)?.get('color');
      if (color && !/^(currentColor|inherit|unset|revert)$/i.test(color)) {
        return inheritedValue(color, defaultPaint.color, defaultPaint.color);
      }
    }
    return defaultPaint.color;
  };
  const dimensions = svgNumbers(root.getAttribute('viewBox') ?? '');
  if (dimensions.length && (dimensions.length !== 4 || dimensions[2] <= 0 || dimensions[3] <= 0)) {
    throw new Error('SVG 视图框尺寸无效。');
  }
  const explicitWidth = root.getAttribute('width'), explicitHeight = root.getAttribute('height');
  const rawWidth = explicitWidth === null ? dimensions[2] : viewportLength(explicitWidth, dimensions[2]);
  const rawHeight = explicitHeight === null ? dimensions[3] : viewportLength(explicitHeight, dimensions[3]);
  if (!(rawWidth > 0 && rawHeight > 0)) throw new Error('SVG 缺少可用的尺寸或视图框。');
  const viewport = { width: dimensions[2] ?? rawWidth, height: dimensions[3] ?? rawHeight };
  const preserve = (root.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet').trim();
  const fitRule = /^(none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(meet|slice))?$/.exec(preserve);
  if (!fitRule || fitRule[2] === 'slice') unsupportedItem('preserveAspectRatio');
  const physical = [explicitWidth, explicitHeight].some(value => value && /(?:in|cm|mm|pt|pc)$/i.test(value.trim()));
  const fitScale = Math.min(target.width / rawWidth, target.height / rawHeight) * .84;
  const cardScale = physical ? metric.px : sizing === 'actual' ? Math.min(metric.px, fitScale) : fitScale;
  let sx = rawWidth / viewport.width, sy = rawHeight / viewport.height;
  if (fitRule[1] !== 'none') sx = sy = Math.min(sx, sy);
  const alignment = (which: string) => which === 'Min' ? 0 : which === 'Max' ? 1 : .5;
  const dx = (rawWidth - viewport.width * sx) * alignment(fitRule[1].slice(1, 4));
  const dy = (rawHeight - viewport.height * sy) * alignment(fitRule[1].slice(5, 8));
  const artboard = new DOMMatrix().translate((target.width - rawWidth * cardScale) / 2, (target.height - rawHeight * cardScale) / 2)
    .scale(cardScale).translate(dx, dy).scale(sx, sy).translate(-(dimensions[0] ?? 0), -(dimensions[1] ?? 0));
  const groupId = uid();
  const groups: LayerGroup[] = [{ id: groupId, name: file.name.replace(/\.svg$/i, '').slice(0, 150) || 'SVG 素材' }];
  const nodes: CardNode[] = [];
  const rootStyle = styles.get(root)!;
  if (opacity(rootStyle.get('opacity'), 1) !== 1) unsupportedItem('svg opacity');
  for (const effect of ['filter', 'clip-path', 'mask']) if (hasEffect(rootStyle.get(effect))) unsupportedItem(effect);
  const walk = (container: Element, inherited: Paint, parentTransform: DOMMatrix, group: string, depth: number) => {
    if (depth > 20) throw new Error('SVG 图层嵌套过深。');
    for (const element of container.children) {
      const tag = element.localName;
      if (['defs', 'title', 'desc', 'metadata', 'filter'].includes(tag) || gradients.has(tag)) continue;
      const values = styles.get(element)!;
      const style = paintStyle(inherited, values, viewport);
      const transform = parentTransform.multiply(matrix(element.getAttribute('transform')));
      const layerOpacity = opacity(values.get('opacity'), 1);
      for (const effect of ['clip-path', 'mask']) if (hasEffect(values.get(effect))) unsupportedItem(effect);
      if (tag === 'g') {
        if (layerOpacity !== 1) unsupportedItem('g opacity');
        if (hasEffect(values.get('filter'))) unsupportedItem('filter');
        const id = uid();
        groups.push({ id, name: title(element, names.g), parentId: group });
        walk(element, style, transform, id, depth + 1);
        continue;
      }
      if (!shapes.has(tag)) unsupportedItem(tag);
      if (nodes.length >= maxObjects) throw new Error('SVG 可编辑图层过多，请分批导入。');
      let { points, closed, primitive, contours } = shapeGeometry(element, viewport);
      const hasStroke = style.stroke !== 'none' && style.strokeWidth > 0;
      const hasFill = style.fill !== 'none' && tag !== 'line' && style.fillOpacity > 0;
      const curved = points.some(point => point.in || point.out);
      if (hasFill && !closed && (points.length > 2 || curved)) {
        if (hasStroke) throw new Error('SVG 开放路径同时使用填充和描边。请先将填充和描边拆成独立路径。');
        closed = true;
      }
      const outlines = [points, ...(contours ?? [])].map(outline => {
        if (closed && outline.length === 2 && outline.some(p=>p.in||p.out))
          outline = splitPathSegment(outline, outline[0].out || outline[1].in ? 0 : 1);
        if (outline.length < (closed ? 3 : 2)) throw new Error('SVG 路径的有效节点不足。');
        return outline;
      });
      if (outlines.reduce((total, outline) => total+outline.length,0)>MAX_PATH_POINTS) throw new Error('SVG 路径节点过多。');
      const boxes = outlines.map(outline=>vectorBounds(outline,closed,true));
      const left = Math.min(...boxes.map(b=>b.x)), top = Math.min(...boxes.map(b=>b.y));
      const object = { x:left,y:top,width:Math.max(...boxes.map(b=>b.x+b.width))-left,height:Math.max(...boxes.map(b=>b.y+b.height))-top };
      const geometry = normalizeContours(outlines.map(outline=>mapVectorPoints(outline, point => {
        const { x, y } = transform.transformPoint(new DOMPoint(point.x, point.y));
        return { x, y };
      })));
      const vectorValues = [geometry.x, geometry.y, geometry.width, geometry.height];
      if (vectorValues.some(value => !Number.isFinite(value) || Math.abs(value) > 100_000)) throw new Error('SVG 图形坐标超出可编辑范围。');
      const uniform = unitScale(transform);
      const vectorEffect = values.get('vector-effect') ?? 'none';
      if (hasStroke && !['none','non-scaling-stroke'].includes(vectorEffect)) unsupportedItem('vector-effect');
      const strokeScale = vectorEffect === 'non-scaling-stroke' ? cardScale : uniform;
      const strokeWidth = hasStroke ? style.strokeWidth * (strokeScale ?? 0) : 0;
      if (hasStroke && (!strokeScale || strokeWidth > 1000)) throw new Error('SVG 描边含有非等比变换或宽度超出可编辑范围。');
      if (hasStroke && (!['butt', 'round', 'square'].includes(style.strokeCap) ||
        !['miter', 'round', 'bevel'].includes(style.strokeJoin) || style.strokeMiter < 1 || style.strokeMiter > 1000)) {
        throw new Error('SVG 描边端点、连接或斜接限制不受支持。');
      }
      let strokeStyle: CardNode['strokeStyle'];
      if (hasStroke && style.strokeDash !== 'none') {
        const pattern = svgNumbers(style.strokeDash);
        if (pattern.some(value => value !== 0)) {
          if (vectorEffect === 'non-scaling-stroke' || pattern.length !== 2 || length(style.strokeDashOffset)) unsupportedItem('stroke-dasharray');
          const [dash, gap] = pattern.map(value => value / style.strokeWidth);
          if (dash === 4 && gap === 2.5) strokeStyle = 'dashed';
          else if (!dash && gap === 3 && style.strokeCap === 'round') strokeStyle = 'dotted';
          else unsupportedItem('stroke-dasharray');
        }
      }
      if (hasFill && !['nonzero','evenodd'].includes(style.fillRule)) unsupportedItem('fill-rule');
      const reference = localReference(style.fill);
      const definition = reference && definitions.get(reference);
      const gradient = hasFill && definition && gradients.has(definition.localName)
        ? readGradient(definition, object, geometry, transform, viewport, colorAt) : undefined;
      const fill = hasFill && closed && !gradient ? cssColor(resolvedColor(style.fill, style.color)) : 'transparent';
      let visualEffect: VisualEffect | undefined;
      if (hasEffect(values.get('filter'))) {
        const id = localReference(values.get('filter'));
        const filter = id && definitions.get(id);
        if (!filter || filter.localName !== 'filter' || vectorEffect !== 'none') unsupportedItem('filter');
        if (filter.querySelector('feGaussianBlur') && (gradient || hasFill && hasStroke) &&
          styles.get(filter)?.get('color-interpolation-filters') !== 'sRGB') unsupportedItem('filter');
        const strokePadding = hasStroke ? style.strokeWidth / 2 * Math.max(
          style.strokeJoin === 'miter' ? style.strokeMiter : 1, style.strokeCap === 'square' ? Math.SQRT2 : 1,
        ) : 0;
        visualEffect = simpleFilter(filter, object, transform, viewport, strokePadding, colorAt);
      }
      const rectangular = primitive?.type === 'rect' && primitive.circularCorners && !transform.b && !transform.c && Boolean(uniform);
      const elliptical = primitive?.type === 'ellipse' && !transform.b && !transform.c;
      const type = rectangular ? 'rect' : elliptical ? 'ellipse' : primitive?.type === 'line' || primitive?.type === 'polygon' ? primitive.type : 'path';
      const { pathPoints, contours: extra, ...box } = geometry;
      nodes.push({
        ...box, id: uid(), name: title(element, `${names[tag]} ${nodes.length + 1}`), groupId: group,
        type, rotation: 0, opacity: layerOpacity, visible: style.displayed && style.visibility === 'visible', locked: false,
        fill, fillOpacity: style.fillOpacity, fillMode: gradient ? 'gradient' : 'solid', gradient,
        stroke: hasStroke ? cssColor(resolvedColor(style.stroke, style.color)) : undefined, strokeWidth, strokeOpacity: style.strokeOpacity,
        ...(hasStroke ? { strokeLineCap: style.strokeCap as CanvasLineCap, strokeLineJoin: style.strokeJoin as CanvasLineJoin,
          strokeMiterLimit: style.strokeMiter, ...(strokeStyle ? {strokeStyle} : {}) } : {}),
        ...(visualEffect ? { visualEffects: [visualEffect] } : {}),
        ...(type === 'rect' && primitive?.type === 'rect' ? { cornerRadius: primitive.cornerRadius * (uniform ?? 1) } : {}),
        ...(type === 'path' || type === 'line' ? { pathPoints, pathClosed: closed, contours:extra, fillRule:style.fillRule === 'evenodd' ? 'evenodd' : undefined } : {}),
        ...(type === 'polygon' ? { polygon: pathPoints.flatMap(point => [point.x, point.y]) } : {}),
      });
    }
  };
  walk(root, paintStyle(defaultPaint, rootStyle, viewport), artboard.multiply(matrix(root.getAttribute('transform'))), groupId, 0);
  if (!nodes.length) throw new Error('SVG 中没有可编辑的图形。');
  return { nodes, groups, groupId };
}

const rasterElements = new Set([
  'svg', 'defs', 'title', 'desc', 'g', 'stop', 'style', 'text', 'tspan', 'textPath', 'image', 'a',
  'clipPath', 'mask', 'filter', 'symbol', 'use', 'pattern', 'marker',
  'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence',
]);
const rasterLinks = new Set(['use', 'linearGradient', 'radialGradient', 'pattern', 'textPath']);
const xlinkNamespace = 'http://www.w3.org/1999/xlink';
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/';
const fragmentOnly = /^#[\p{L}\p{N}_.:-]+$/u;
const cssFragment = /\burl\(\s*(['"]?)(#[\p{L}\p{N}_.:-]+)\1\s*\)/giu;
const embeddedRaster = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/i;
const maxRasterEdge = 4096;
const maxRasterBytes = 20 * 1024 * 1024;

function localCssReferences(value: string) {
  let css = value;
  if (value.includes('/*')) {
    const pieces: string[] = [];
    let cursor = 0;
    for (let start = value.indexOf('/*'); start !== -1; start = value.indexOf('/*', cursor)) {
      const end = value.indexOf('*/', start + 2);
      if (end === -1) throw new Error('SVG 样式中的注释未闭合。');
      pieces.push(value.slice(cursor, start), ' ');
      cursor = end + 2;
    }
    pieces.push(value.slice(cursor));
    css = pieces.join('');
  }
  const references: string[] = [];
  const rest = css.replace(cssFragment, (_match, _quote, fragment: string) => {
    references.push(fragment.slice(1));
    return '';
  });
  if (/[\\@]/.test(rest) || /\b(?:url|src|(?:-webkit-)?image-set|image|paint)\s*\(|(?:https?:)?\/\/|(?:data|blob|file|javascript):/i.test(rest)) {
    throw new Error('SVG 含有外部资源或不受支持的样式引用。');
  }
  return references;
}

async function validateRasterSvg(root: Element) {
  const elements = [root, ...root.querySelectorAll('*')];
  if (elements.length > maxObjects * 3) throw new Error('SVG 元素过多，请分批导入。');
  for (const element of elements) if (element.localName === 'metadata') element.remove();
  const ids = new Map<string, Element>();
  const links = new Map<Element, string[]>();
  const cssLinks: string[] = [];
  let embeddedPixels = 0;
  for (const element of elements) {
    if (element !== root && !root.contains(element)) continue;
    const tag = element.localName;
    if (element.namespaceURI !== namespace || !shapes.has(tag) && !gradients.has(tag) && !rasterElements.has(tag)) unsupportedItem(tag);
    if (element.id && !ids.has(element.id)) ids.set(element.id, element);
    if (tag === 'feConvolveMatrix' && svgNumbers(element.getAttribute('order') ?? '3').some(value => value < 1 || value > 15)) {
      throw new Error('SVG 滤镜的卷积范围过大。');
    }
    if (tag === 'feTurbulence' && Number(element.getAttribute('numOctaves') ?? '1') > 10) throw new Error('SVG 滤镜的纹理层数过多。');
    const references: string[] = [];
    for (const attribute of [...element.attributes]) {
      const { localName, namespaceURI, value } = attribute;
      if (namespaceURI === xmlnsNamespace || namespaceURI === xmlNamespace && ['space', 'lang'].includes(localName)) continue;
      if (localName === 'href' && (!namespaceURI || namespaceURI === xlinkNamespace)) {
        const href = value.trim();
        if (rasterLinks.has(tag) && fragmentOnly.test(href)) {
          references.push(href.slice(1));
          continue;
        }
        const embedded = tag === 'image' && embeddedRaster.exec(href);
        if (embedded) {
          const bytes = Uint8Array.from(atob(embedded[2]), character => character.charCodeAt(0));
          const image = await readImage(new File([bytes], 'SVG image', { type: 'image/' + embedded[1] }));
          if (!image.src.startsWith('data:image/' + embedded[1].toLowerCase() + ';')) throw new Error('SVG 内嵌图片的格式无效。');
          embeddedPixels += image.width * image.height;
          if (embeddedPixels > 24_000_000) throw new Error('SVG 内嵌图片超过 2400 万像素。');
          continue;
        }
        throw new Error('SVG 的引用需要指向同一文件内的图形或资源。');
      }
      if (namespaceURI || /^(?:on|src$)/i.test(localName)) unsupportedItem(localName);
      if (/^(?:aria-|data-)/.test(localName) || ['id', 'class', 'role'].includes(localName)) continue;
      references.push(...localCssReferences(value));
    }
    if (tag === 'style') {
      if (element.childElementCount) unsupportedItem(tag);
      cssLinks.push(...localCssReferences(element.textContent || ''));
    }
    links.set(element, references);
  }

  // Bound nested resource expansion before handing the XML to a browser image decoder.
  const costs = new Map<Element, number>();
  const visiting = new Set<Element>();
  function count(element: Element, depth: number): number {
    if (depth > 64 || visiting.has(element)) throw new Error('SVG 图形引用存在循环或嵌套过深。');
    const cached = costs.get(element);
    if (cached !== undefined) return cached;
    visiting.add(element);
    const references = (links.get(element) ?? []).map(id => {
      const target = ids.get(id);
      if (!target) throw new Error('SVG 缺少引用的图形或资源。');
      return target;
    });
    let cost = 1;
    for (const child of [...element.children, ...references]) {
      cost += count(child, depth + 1);
      if (cost > 12000) throw new Error('SVG 图形引用过多，请缩减后导入。');
    }
    visiting.delete(element);
    costs.set(element, cost);
    return cost;
  }
  count(root, 0);
  if (cssLinks.some(id => !ids.has(id))) throw new Error('SVG 样式缺少引用的图形或资源。');
}

function rasterSvgSize(root: SVGSVGElement, target: StageSize, sizing: 'fit' | 'actual') {
  const box = svgNumbers(root.getAttribute('viewBox') ?? '');
  if (box.length && (box.length !== 4 || box[2] <= 0 || box[3] <= 0)) throw new Error('SVG 视图框尺寸无效。');
  const widthAttr = root.style.width || root.getAttribute('width')?.trim();
  const heightAttr = root.style.height || root.getAttribute('height')?.trim();
  const explicitWidth = widthAttr && widthAttr !== 'auto' ? viewportLength(widthAttr, box[2] ?? 300) : undefined;
  const explicitHeight = heightAttr && heightAttr !== 'auto' ? viewportLength(heightAttr, box[3] ?? 150) : undefined;
  const width = explicitWidth ?? (explicitHeight && box[3] ? explicitHeight * box[2] / box[3] : box[2] ?? 300);
  const height = explicitHeight ?? (explicitWidth && box[2] ? explicitWidth * box[3] / box[2] : box[3] ?? 150);
  if (!(width > 0 && height > 0) || Math.max(width, height) > 100_000) throw new Error('SVG 缺少可用的画布尺寸。');
  const physical = [widthAttr, heightAttr].some(value => value && /(?:in|cm|mm|pt|pc)$/i.test(value));
  const fitScale = Math.min(target.width / width, target.height / height) * .84;
  const outputScale = physical ? metric.px : sizing === 'actual' ? Math.min(metric.px, fitScale) : fitScale;
  const longEdge = Math.max(width, height);
  const rasterScale = Math.min(maxRasterEdge / longEdge, Math.max(1600 / longEdge, 600 * outputScale / 254));
  if (!box.length) root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const rasterWidth = Math.max(1, Math.round(width * rasterScale)), rasterHeight = Math.max(1, Math.round(height * rasterScale));
  for (const [dimension, pixels] of [['width', rasterWidth], ['height', rasterHeight]] as const) {
    root.setAttribute(dimension, String(pixels));
    root.style.setProperty(dimension, pixels + 'px', 'important');
    root.style.setProperty('min-' + dimension, '0', 'important');
    root.style.setProperty('max-' + dimension, 'none', 'important');
  }
  return { width: width * outputScale, height: height * outputScale, rasterWidth, rasterHeight };
}

function hasRasterInk(context: CanvasRenderingContext2D, width: number, height: number) {
  for (let row = 0; row < height; row += 64) {
    const pixels = context.getImageData(0, row, width, Math.min(height - row, 64)).data;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
  }
  return false;
}

export async function rasterizeLocalSvg(file: File, target: StageSize, sizing: 'fit' | 'actual' = 'fit') {
  const root: Element = await openSvg(file);
  if (!(root instanceof SVGSVGElement)) throw new Error('无法读取此 SVG 文件。');
  await validateRasterSvg(root);
  const { width, height, rasterWidth, rasterHeight } = rasterSvgSize(root, target, sizing);
  // Load as an image only. The SVG markup is never mounted in the application document.
  const blob = new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const canvas = document.createElement('canvas');
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    canvas.width = rasterWidth;
    canvas.height = rasterHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法建立 SVG 渲染画布。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (!hasRasterInk(context, canvas.width, canvas.height)) throw new Error('SVG 中没有可见的图形。');
    let result: Blob;
    for (;;) {
      result = await new Promise<Blob>((resolve, reject) => canvas.toBlob(data => {
        if (data) resolve(data);
        else reject(new Error('无法将 SVG 转换为 PNG。'));
      }, 'image/png'));
      if (result.size <= maxRasterBytes) break;
      canvas.width = Math.max(1, Math.floor(canvas.width * .75));
      canvas.height = Math.max(1, Math.floor(canvas.height * .75));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    }
    return { file: new File([result], file.name.replace(/\.svg$/i, '') + '.png', { type: 'image/png' }), width, height };
  } finally {
    canvas.width = canvas.height = 0;
    URL.revokeObjectURL(url);
  }
}
