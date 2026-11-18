import { getCardCornerRadiusMm, type CardNode, type Project, type SideName } from './model';
import { drawNode, makeCanvas, renderCard } from './render';

export const WORKBENCH_PREVIEW_VERSION = 2;

function extent(node: CardNode) {
  const angle = node.rotation * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const padding = node.strokeWidth ?? 0;
  const points = [[0, 0], [node.width, 0], [0, node.height], [node.width, node.height]]
    .map(([x, y]) => [node.x + x * cos - y * sin, node.y + x * sin + y * cos]);
  return {
    left: Math.min(...points.map(([x]) => x)) - padding,
    top: Math.min(...points.map(([, y]) => y)) - padding,
    right: Math.max(...points.map(([x]) => x)) + padding,
    bottom: Math.max(...points.map(([, y]) => y)) + padding,
  };
}

async function drawWorkspaceFace(
  context: CanvasRenderingContext2D,
  project: Project,
  face: SideName,
  card: HTMLCanvasElement,
  box: { x: number; w: number; h: number },
) {
  const side = project[face];
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const radius = getCardCornerRadiusMm(project) * 10;
  let left = 0, top = 0, right = width, bottom = height;
  const loose = side.nodes.filter(node => node.visible && node.opacity > 0 && node.type !== 'empty' && !node.clipRegionId)
    .filter(node => {
      const bounds = extent(node);
      if (bounds.left >= 0 && bounds.top >= 0 && bounds.right <= width && bounds.bottom <= height) return false;
      left = Math.min(left, bounds.left);
      top = Math.min(top, bounds.top);
      right = Math.max(right, bounds.right);
      bottom = Math.max(bottom, bounds.bottom);
      return true;
    });
  const boundsWidth = right - left;
  const boundsHeight = bottom - top;
  const scale = Math.min(box.w / boundsWidth, box.h / boundsHeight);
  context.save();
  context.translate(box.x + (box.w - boundsWidth * scale) / 2 - left * scale, 12 + (box.h - boundsHeight * scale) / 2 - top * scale);
  context.scale(scale, scale);
  const outside = new Path2D();
  outside.rect(left - 1, top - 1, boundsWidth + 2, boundsHeight + 2);
  outside.roundRect(0, 0, width, height, radius);
  context.save();
  context.clip(outside, 'evenodd');
  for (const node of loose) {
    await drawNode(context, node).catch(() => {});
  }
  context.restore();
  context.beginPath();
  context.roundRect(0, 0, width, height, radius);
  context.clip();
  context.drawImage(card, 0, 0, width, height);
  context.restore();
}

export async function workbenchOverview(project: Project, front: HTMLCanvasElement) {
  const canvas = makeCanvas(512, 248);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#202020';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff16';
  for (let x = 7; x < canvas.width; x += 12) {
    for (let y = 7; y < canvas.height; y += 12) context.fillRect(x, y, 1, 1);
  }
  const back = await renderCard(project, 'back', { scale: 240 / (10 * Math.max(project.widthMm, project.heightMm)) });
  const boardWidth = 232;
  await drawWorkspaceFace(context, project, 'front', front, { x: 16, w: boardWidth, h: 224 });
  await drawWorkspaceFace(context, project, 'back', back, { x: 32 + boardWidth, w: boardWidth, h: 224 });
  return canvas.toDataURL('image/png');
}
