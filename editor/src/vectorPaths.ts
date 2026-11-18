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
