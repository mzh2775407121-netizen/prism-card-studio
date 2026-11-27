import type { CardNode, PathPoint } from './model';

export const MAX_PATH_POINTS = 2048;

export function isOpenVector(node: CardNode) {
  return node.type === 'line' || (node.type === 'path' && !node.pathClosed);
}

type PathTarget = Pick<Path2D, 'moveTo' | 'lineTo' | 'bezierCurveTo' | 'closePath'>;

export function traceVectorPath(
  target: PathTarget, points: readonly PathPoint[], width: number, height: number, closed = false,
) {
  if (!points.length) return;
  const first = points[0];
  target.moveTo(first.x * width, first.y * height);
  const segment = (from: PathPoint, to: PathPoint) => {
    if (!from.out && !to.in) {
      target.lineTo(to.x * width, to.y * height);
      return;
    }
    const a = from.out ?? from;
    const b = to.in ?? to;
    target.bezierCurveTo(a.x * width, a.y * height, b.x * width, b.y * height, to.x * width, to.y * height);
  };
  for (let index = 1; index < points.length; index++) segment(points[index - 1], points[index]);
  if (closed && points.length > 2) {
    segment(points[points.length - 1], first);
    target.closePath();
  }
}

type Point = Pick<PathPoint, 'x' | 'y'>;

export function mapVectorPoints(points: readonly PathPoint[], map: (point: Point) => Point): PathPoint[] {
  return points.map(point => ({ ...map(point), in: point.in && map(point.in), out: point.out && map(point.out) }));
}

export function vectorBounds(points: readonly PathPoint[], closed = false, curveBounds = false) {
  const horizontal: number[] = [];
  const vertical: number[] = [];
  const push = (point: Point) => { horizontal.push(point.x); vertical.push(point.y); };
  points.forEach((to, index) => {
    push(to);
    if (!curveBounds) {
      if (to.in) push(to.in);
      if (to.out) push(to.out);
      return;
    }
    const from = index ? points[index - 1] : closed ? points.at(-1) : undefined;
    if (!from || (!from.out && !to.in)) return;
    const control1 = from.out ?? from;
    const control2 = to.in ?? to;
    for (const axis of ['x', 'y'] as const) {
      const a = -from[axis] + 3 * control1[axis] - 3 * control2[axis] + to[axis];
      const b = 2 * (from[axis] - 2 * control1[axis] + control2[axis]);
      const c = control1[axis] - from[axis];
      const discriminant = b * b - 4 * a * c;
      const times = Math.abs(a) < 1e-8 ? [-c / b] : discriminant >= 0
        ? [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)] : [];
      for (const t of times) {
        if (t <= 0 || t >= 1 || !Number.isFinite(t)) continue;
        const s = 1 - t;
        const value = s ** 3 * from[axis] + 3 * s ** 2 * t * control1[axis] + 3 * s * t ** 2 * control2[axis] + t ** 3 * to[axis];
        (axis === 'x' ? horizontal : vertical).push(value);
      }
    }
  });
  const x = Math.min(...horizontal), y = Math.min(...vertical);
  return { x, y, width: Math.max(...horizontal) - x, height: Math.max(...vertical) - y };
}

export function normalizePath(points: readonly PathPoint[]) {
  const { x, y, width: spanX, height: spanY } = vectorBounds(points);
  const width = Math.max(1, spanX), height = Math.max(1, spanY);
  return { x, y, width, height, pathPoints: mapVectorPoints(points, point => ({
    x: (point.x - x) / width, y: (point.y - y) / height,
  })) };
}

export function normalizeContours(contours: PathPoint[][]) {
  const box = normalizePath(contours.flat());
  const normalized = contours.map(points => mapVectorPoints(points, p => ({
    x: (p.x-box.x)/box.width, y: (p.y-box.y)/box.height,
  })));
  return { ...box, pathPoints: normalized[0], contours: normalized.length>1 ? normalized.slice(1) : undefined };
}

const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function splitPathSegment(points: readonly PathPoint[], index: number, t = .5) {
  const next = (index + 1) % points.length;
  const from = points[index], to = points[next];
  const copy = [...points];
  if (!from.out && !to.in) {
    copy.splice(index + 1, 0, lerp(from, to, t));
    return copy;
  }
  const a = lerp(from, from.out ?? from, t), b = lerp(from.out ?? from, to.in ?? to, t), c = lerp(to.in ?? to, to, t);
  const d = lerp(a, b, t), e = lerp(b, c, t);
  copy[index] = { ...from, out: a };
  copy[next] = { ...to, in: c };
  copy.splice(index + 1, 0, { ...lerp(d, e, t), in: d, out: e });
  return copy;
}

export function smoothPathPoint(points: readonly PathPoint[], index: number, closed: boolean): PathPoint {
  const point = points[index];
  const previous = points[index - 1] ?? (closed ? points.at(-1) : undefined);
  const next = points[index + 1] ?? (closed ? points[0] : undefined);
  const a = previous ?? point, b = next ?? point;
  const direction = { x: b.x - a.x, y: b.y - a.y };
  const length = Math.hypot(direction.x, direction.y);
  if (!length) return point;
  const handle = (neighbor: Point, sign: number) => {
    const offset = sign * Math.hypot(neighbor.x - point.x, neighbor.y - point.y) / (3 * length);
    return { x: point.x + direction.x * offset, y: point.y + direction.y * offset };
  };
  return { x: point.x, y: point.y, in: previous && handle(previous, -1), out: next && handle(next, 1) };
}

const ARC = .5522847498307936;

export function ellipsePath(x: number, y: number, rx: number, ry: number): PathPoint[] {
  const dx = rx * ARC, dy = ry * ARC;
  return [
    { x: x + rx, y, in: { x: x + rx, y: y - dy }, out: { x: x + rx, y: y + dy } },
    { x, y: y + ry, in: { x: x + dx, y: y + ry }, out: { x: x - dx, y: y + ry } },
    { x: x - rx, y, in: { x: x - rx, y: y + dy }, out: { x: x - rx, y: y - dy } },
    { x, y: y - ry, in: { x: x - dx, y: y - ry }, out: { x: x + dx, y: y - ry } },
  ];
}

export function rectanglePath(x: number, y: number, width: number, height: number, rx = 0, ry = rx): PathPoint[] {
  const right = x + width, bottom = y + height;
  rx = Math.min(width / 2, rx); ry = Math.min(height / 2, ry);
  if (!rx || !ry) return [{ x, y }, { x: right, y }, { x: right, y: bottom }, { x, y: bottom }];
  const dx = rx * ARC, dy = ry * ARC;
  return [
    { x: x + rx, y, in: { x: x + rx - dx, y } },
    { x: right - rx, y, out: { x: right - rx + dx, y } },
    { x: right, y: y + ry, in: { x: right, y: y + ry - dy } },
    { x: right, y: bottom - ry, out: { x: right, y: bottom - ry + dy } },
    { x: right - rx, y: bottom, in: { x: right - rx + dx, y: bottom } },
    { x: x + rx, y: bottom, out: { x: x + rx - dx, y: bottom } },
    { x, y: bottom - ry, in: { x, y: bottom - ry + dy } },
    { x, y: y + ry, out: { x, y: y + ry - dy } },
  ];
}
