import type { PathCoordinate, PathPoint } from './model';
import { MAX_PATH_POINTS } from './vectorPaths';

const lexicalNumber = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[Ee][-+]?\\d+)?';
const numberToken = new RegExp(lexicalNumber, 'gy');
const commandToken = /[MmLlHhVvCcSsQqTtAaZz]/;
const separators = /[\s,]*/y;
const flagToken = /[01]/y;
const tau = 2 * Math.PI;
const empty: PathPoint = { x: 0, y: 0 };
type Point = PathCoordinate;

export function svgNumbers(value: string) {
  const matches = value.match(new RegExp(lexicalNumber, 'g')) ?? [];
  if (value.replace(new RegExp(lexicalNumber, 'g'), '').replace(/[\s,]/g, '') || matches.some(item => !Number.isFinite(+item))) {
    throw new Error('SVG 数值格式无效。');
  }
  return matches.map(Number);
}

const reflect = (point: Point | undefined, pivot: Point) => point
  ? { x: 2 * pivot.x - point.x, y: 2 * pivot.y - point.y } : pivot;

function arcControls(from: Point, to: Point, rx: number, ry: number, rotation: number, large: boolean, sweep: boolean): { point: Point; out?: Point; in?: Point }[] {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (from.x === to.x && from.y === to.y) return [];
  if (!rx || !ry) return [{ point: to }];
  const theta = rotation / 360 * tau;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const dx = (from.x - to.x) / 2, dy = (from.y - to.y) / 2;
  const x = cos * dx + sin * dy, y = -sin * dx + cos * dy;
  const adjust = Math.max(1, Math.hypot(x / rx, y / ry));
  rx *= adjust; ry *= adjust;
  const u = x / rx, v = y / ry;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, 1 / (u * u + v * v) - 1));
  const cx = k * v, cy = -k * u;
  const start = Math.atan2(v - cy, u - cx);
  const end = Math.atan2(-v - cy, -u - cx);
  const forward = (end - start + tau) % tau;
  const angle = sweep ? forward : forward - tau;
  const count = Math.ceil(Math.abs(angle) / (Math.PI / 2));
  const step = angle / count, control = 4 / 3 * Math.tan(step / 4);
  const toWorld = (u: number, v: number) => ({
    x: (from.x + to.x) / 2 + cos * rx * (u + cx) - sin * ry * (v + cy),
    y: (from.y + to.y) / 2 + sin * rx * (u + cx) + cos * ry * (v + cy),
  });
  return Array.from({ length: count }, (_, index) => {
    const a = start + index * step, b = a + step;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    return { out: toWorld(ca - control * sa, sa + control * ca), in: toWorld(cb + control * sb, sb - control * cb),
      point: index === count - 1 ? to : toWorld(cb, sb) };
  });
}

export function parseSvgPath(path: string): { points: PathPoint[]; closed: boolean; contours?: PathPoint[][] } {
  let points: PathPoint[] = [];
  const completed: PathPoint[][] = [];
  let pointCount = 0;
  let position = 0, command = '', previous = '', closed = false;
  let quadratic: Point | undefined;
  const skip = () => { separators.lastIndex = position; position += separators.exec(path)?.[0].length ?? 0; };
  const read = (flag = false) => {
    skip();
    const token = flag ? flagToken : numberToken;
    token.lastIndex = position;
    const parsed = token.exec(path)?.[0];
    if (parsed === undefined || !Number.isFinite(+parsed)) throw new Error('SVG 路径数值无效。');
    position = token.lastIndex;
    return +parsed;
  };
  const add = (point: Point, out?: Point, incoming?: Point) => {
    if (++pointCount > MAX_PATH_POINTS) throw new Error('SVG 路径节点过多。');
    if (out) points[points.length - 1].out = out;
    points.push({ ...point, in: incoming });
  };
  while (position < path.length) {
    skip();
    if (position === path.length) break;
    if (closed && !/[Mm]/.test(path[position])) throw new Error('闭合轮廓后需要移动到下一条轮廓。');
    if (commandToken.test(path[position])) command = path[position++];
    const op = command.toUpperCase();
    const relative = command !== op;
    const from = closed ? points[0] : points.at(-1) ?? empty;
    if (!points.length && op !== 'M') throw new Error('SVG 路径需要以移动命令开始。');
    const point = () => ({ x: read() + (relative ? from.x : 0), y: read() + (relative ? from.y : 0) });
    switch (op) {
      case 'M':
        if (points.length) {
          if (!closed) throw new Error('含开放子路径的复合图形暂不支持节点编辑。');
          completed.push(points);
          points = [];
          closed = false;
        }
        add(point());
        command = relative ? 'l' : 'L';
        break;
      case 'L': add(point()); break;
      case 'H': add({ x: read() + (relative ? from.x : 0), y: from.y }); break;
      case 'V': add({ x: from.x, y: read() + (relative ? from.y : 0) }); break;
      case 'C': {
        const out = point(), incoming = point();
        add(point(), out, incoming);
        break;
      }
      case 'S': {
        const out = reflect(previous === 'C' || previous === 'S' ? from.in : undefined, from);
        const incoming = point();
        add(point(), out, incoming);
        break;
      }
      case 'Q':
      case 'T': {
        quadratic = op === 'Q' ? point() : reflect(previous === 'Q' || previous === 'T' ? quadratic : undefined, from);
        const to = point();
        const control = ({ x, y }: Point) => ({ x: x + 2 / 3 * (quadratic!.x - x), y: y + 2 / 3 * (quadratic!.y - y) });
        add(to, control(from), control(to));
        break;
      }
      case 'A': {
        const rx = read(), ry = read(), rotation = read(), large = !!read(true), sweep = !!read(true);
        for (const { point: to, out, in: incoming } of arcControls(from, point(), rx, ry, rotation, large, sweep)) add(to, out, incoming);
        break;
      }
      case 'Z': {
        const first = points[0], last = points.at(-1)!;
        if (points.length > 2 && first.x === last.x && first.y === last.y) {
          first.in = last.in;
          points.pop();
        }
        closed = true;
        break;
      }
      default: throw new Error('SVG 路径命令无效或不受支持。');
    }
    previous = op;
  }
  if (!completed.length) return { points, closed };
  if (!closed) throw new Error('含开放子路径的复合图形暂不支持节点编辑。');
  const [first,...contours] = [...completed,points];
  return {points:first, contours, closed};
}
