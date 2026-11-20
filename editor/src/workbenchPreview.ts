import { printGuideBounds } from './PrintGuides';
import { activeImageFill, hasFill, hasStroke } from './layerAppearance';
import { pentagon, projectCards, projectForCard, type CardNode, type Project, type SideName } from './model';
import { drawNode, loadImage, makeCanvas, renderCard, renderEffects, renderStockReflection, renderStockWhiteMask } from './render';
import { isTransparentStock } from './stockMaterials';
import { getStockAppearance, stockGroundColor } from './stockOptics';
import { isOpenVector } from './vectorPaths';

export const WORKBENCH_PREVIEW_VERSION = 6;
const FRONT_ONLY: readonly SideName[] = ['front'];
const BOTH_FACES: readonly SideName[] = ['front', 'back'];

type Bounds = { left: number; top: number; right: number; bottom: number };
type WorkspaceFace = {
  side: SideName;
  x: number;
  bounds: Bounds;
  nodes: CardNode[];
};

function artworkBounds(node: CardNode): Bounds {
  const { width, height } = node;
  const angle = node.rotation * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const stroke = hasStroke(node) && (node.strokeOpacity ?? 1) > 0 && node.type !== 'text';
  const alignment = isOpenVector(node) ? 'center' : node.strokeAlign ?? 'center';
  const padding = stroke ? (node.strokeWidth ?? 0) * (alignment === 'outside' ? 1 : alignment === 'center' ? .5 : 0) : 0;

  let points = [[0, 0], [width, 0], [0, height], [width, height]];
  if (node.type === 'polygon') {
    const polygon = node.polygon ?? pentagon(1, 1);
    points = polygon.flatMap((x, i) => i % 2 ? [] : [[x * width, polygon[i + 1] * height]]);
  } else if (node.pathPoints?.length && (node.type === 'line' || node.type === 'path')) {
    // A Bézier curve is contained by the hull of its control points.
    const path = node.type === 'line' ? node.pathPoints.slice(0, 2) : node.pathPoints;
    points = path.flatMap((point, index) => [
      point,
      ...(node.type === 'path' && point.in && (index > 0 || node.pathClosed) ? [point.in] : []),
      ...(node.type === 'path' && point.out && (index < path.length - 1 || node.pathClosed) ? [point.out] : []),
    ]).map(point => [point.x * width, point.y * height]);
  }
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const [x, y] of points) {
    const localX = node.flipX ? width - x : x;
    const localY = node.flipY ? height - y : y;
    const px = node.x + localX * cos - localY * sin;
    const py = node.y + localX * sin + localY * cos;
    bounds.left = Math.min(bounds.left, px - padding);
    bounds.top = Math.min(bounds.top, py - padding);
    bounds.right = Math.max(bounds.right, px + padding);
    bounds.bottom = Math.max(bounds.bottom, py + padding);
  }
  return bounds;
}

function union(first: Bounds, second: Bounds): Bounds {
  return {
    left: Math.min(first.left, second.left), top: Math.min(first.top, second.top),
    right: Math.max(first.right, second.right), bottom: Math.max(first.bottom, second.bottom),
  };
}

function workspace(project: Project) {
  const { trim, bleed } = printGuideBounds(project);
  // Match the editor's zoom-independent spacing between its front and back artboards.
  const backOffset = trim.width + Math.max(trim.width * .165, project.bleedMm * 20 + 24);
  const sides = project.singleSided ? FRONT_ONLY : BOTH_FACES;
  const faceBounds = { left: bleed.x, top: bleed.y, right: bleed.x + bleed.width, bottom: bleed.y + bleed.height };
  const faces: WorkspaceFace[] = sides.map(side => {
    const nodes = project[side].nodes.filter(node => node.visible && node.opacity > 0 && node.type !== 'empty'
      && (node.type !== 'text' || !!node.text?.trim())
      && ((hasFill(node) && (node.fillOpacity ?? 1) > 0) || (hasStroke(node) && (node.strokeOpacity ?? 1) > 0)));
    const bounds = nodes.reduce((extent, node) => union(extent, artworkBounds(node)), faceBounds);
    return { side, x: side === 'back' ? backOffset : 0, bounds, nodes };
  });
  const bounds = faces.reduce((extent, { bounds, x }) =>
    union(extent, { ...bounds, left: bounds.left + x, right: bounds.right + x }), faceBounds);
  return { project, faces, bounds };
}

async function drawWorkspaceFace(context: CanvasRenderingContext2D, project: Project, face: WorkspaceFace, scale: number) {
  const side = project[face.side];
  const { trim, bleed } = printGuideBounds(project);
  const transparent = isTransparentStock(project.material);
  const hasMasks = face.nodes.some(node => node.clipRegionId && side.regions.some(region => region.id === node.clipRegionId));
  const paintable = await Promise.all(side.nodes.map(async node => {
    const image = activeImageFill(node);
    if (!image) return node;
    return loadImage(image.src).then(() => node, () => ({ ...node, fillHidden: true, fillMode: 'solid' as const }));
  }));
  const renderSide = { ...side, nodes: paintable };
  const [maskedArtwork, whiteBacking, stock, effects] = await Promise.all([
    hasMasks ? renderCard({ ...project, [face.side]: renderSide }, face.side,
      { scale, effects: false, transparentGround: true }) : undefined,
    transparent ? renderStockWhiteMask(project, renderSide, scale, true) : undefined,
    renderStockReflection(project, renderSide, scale, true),
    side.effects.length ? renderEffects(project, renderSide, scale) : undefined,
  ]);

  context.save();
  context.translate(face.x, 0);
  const bleedPath = new Path2D();
  bleedPath.roundRect(bleed.x, bleed.y, bleed.width, bleed.height, bleed.cornerRadius);
  context.save();
  context.clip(bleedPath);
  context.fillStyle = stockGroundColor(project.material, getStockAppearance(project, side));
  context.fillRect(bleed.x, bleed.y, bleed.width, bleed.height);
  if (whiteBacking) context.drawImage(whiteBacking, bleed.x, bleed.y, bleed.width, bleed.height);
  if (stock) {
    context.globalAlpha = stock.opacity;
    context.globalCompositeOperation = stock.blend;
    context.drawImage(stock.canvas, bleed.x, bleed.y, bleed.width, bleed.height);
  }
  context.restore();

  context.save();
  if (maskedArtwork) {
    // Layers are masked inside the editor's trim rectangle. Off-board artwork remains visible.
    const { left, top, right, bottom } = face.bounds;
    const outside = new Path2D();
    outside.rect(left - 1, top - 1, right - left + 2, bottom - top + 2);
    outside.rect(trim.x, trim.y, trim.width, trim.height);
    context.clip(outside, 'evenodd');
  }
  for (const node of paintable) await drawNode(context, node);
  context.restore();

  context.clip(bleedPath);
  if (maskedArtwork) context.drawImage(maskedArtwork, trim.x, trim.y, trim.width, trim.height);
  if (effects) context.drawImage(effects, trim.x, trim.y, trim.width, trim.height);
  context.restore();
}

export async function workbenchOverview(project: Project) {
  await document.fonts.ready;
  const canvas = makeCanvas(512, 248);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ffffff16';
  for (let x = 7; x < canvas.width; x += 12) {
    for (let y = 7; y < canvas.height; y += 12) context.fillRect(x, y, 1, 1);
  }

  const members = projectCards(project).map(card => workspace(projectForCard(project, card)));
  const columns = Math.min(members.length, Math.ceil(Math.sqrt(members.length * 1.4)));
  const rows = Math.ceil(members.length / columns);
  const widths = Array<number>(columns).fill(0);
  const heights = Array<number>(rows).fill(0);
  members.forEach(({ bounds }, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    widths[col] = Math.max(widths[col], bounds.right - bounds.left);
    heights[row] = Math.max(heights[row], bounds.bottom - bounds.top);
  });
  const gap = 96;
  const prefix = (sizes: number[]) => sizes.reduce((positions, size) => {
    positions.push(positions[positions.length - 1] + size + gap);
    return positions;
  }, [0]);
  const xs = prefix(widths);
  const ys = prefix(heights);
  const width = xs[columns] - gap;
  const height = ys[rows] - gap;
  const scale = Math.min((canvas.width - 32) / width, (canvas.height - 24) / height);

  // One camera keeps every saved layer and artboard in the same coordinate space.
  context.translate((canvas.width - width * scale) / 2, (canvas.height - height * scale) / 2);
  context.scale(scale, scale);
  for (const [index, member] of members.entries()) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const { left, right, top, bottom } = member.bounds;
    context.save();
    context.translate(xs[col] + (widths[col] - (right - left)) / 2 - left, ys[row] + (heights[row] - (bottom - top)) / 2 - top);
    for (const face of member.faces) await drawWorkspaceFace(context, member.project, face, scale);
    context.restore();
  }
  return canvas.toDataURL('image/png');
}
