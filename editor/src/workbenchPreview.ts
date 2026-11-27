import { canvasCardRows, type CanvasFacePlacement } from './canvasCardRows';
import { activeImageFill } from './layerAppearance';
import { isValidProjectCover, projectCards, projectForCard, type Project } from './model';
import { drawNode, loadImage, makeCanvas, renderCard, renderEffects, renderStockReflection, renderStockWhiteMask } from './render';
import { renderStill } from './stillExport';
import { isTransparentStock } from './stockMaterials';
import { getStockAppearance, stockGroundColor } from './stockOptics';

export const WORKBENCH_PREVIEW_VERSION = 8;

export function workbenchFrontCovers(project: Project) {
  const cards = projectCards(project);
  const { projectCover } = project;
  const cover = projectCover && isValidProjectCover(projectCover, cards) && cards.find(card => card.id === projectCover.cardId);
  const first = cover && projectCover ? [{ card: cover, face: projectCover.face }] : [];
  const remaining = cards.filter(card => card.looseFace !== 'back' && (!cover || card.id !== cover.id))
    .map(card => ({ card, face: 'front' as const }));
  return Promise.all([...first, ...remaining].slice(0, 3).map(async ({ card, face }) => {
    const scale = Math.min(174 / card.widthMm, 246 / card.heightMm);
    const canvas = await renderStill(projectForCard(project, card), face, {
      width: Math.max(1, Math.round(card.widthMm * scale)),
      height: Math.max(1, Math.round(card.heightMm * scale)),
      background: 'transparent', resampling: 'high',
    });
    return canvas.toDataURL('image/png');
  }).map(request => request.catch(() => null)));
}

async function drawWorkspaceFace(context: CanvasRenderingContext2D, face: CanvasFacePlacement, scale: number) {
  const { project, slot, guides: { trim, bleed } } = face;
  const side = project[slot];
  const transparent = isTransparentStock(project.material);
  const hasMasks = side.nodes.some(node => node.visible && node.clipRegionId && side.regions.some(region => region.id === node.clipRegionId));
  const paintable = await Promise.all(side.nodes.map(async node => {
    const image = activeImageFill(node);
    if (!image) return node;
    return loadImage(image.src).then(() => node, () => ({ ...node, fillHidden: true, fillMode: 'solid' as const }));
  }));
  const renderSide = { ...side, nodes: paintable };
  const [maskedArtwork, whiteBacking, stock, effects] = await Promise.all([
    hasMasks ? renderCard({ ...project, [slot]: renderSide }, slot,
      { scale, effects: false, transparentGround: true }) : undefined,
    transparent ? renderStockWhiteMask(project, renderSide, scale, true) : undefined,
    renderStockReflection(project, renderSide, scale, true),
    side.effects.length ? renderEffects(project, renderSide, scale) : undefined,
  ]);

  context.save();
  context.translate(face.x, face.y);
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
    const { left, top, right, bottom } = face.content;
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

  const faces = canvasCardRows(project);
  const left = Math.min(...faces.map(face => face.x + face.content.left));
  const top = Math.min(...faces.map(face => face.y + face.content.top));
  const width = Math.max(...faces.map(face => face.x + face.content.right)) - left;
  const height = Math.max(...faces.map(face => face.y + face.content.bottom)) - top;
  const scale = Math.min((canvas.width - 32) / width, (canvas.height - 24) / height);
  context.translate((canvas.width - width * scale) / 2, (canvas.height - height * scale) / 2);
  context.scale(scale, scale);
  context.translate(-left, -top);

  // Overlapping artwork on the currently edited card is drawn last on the canvas.
  const activeId = project.cardId ?? project.id + '_1';
  const drawOrder = [...faces.filter(face => face.cardId !== activeId), ...faces.filter(face => face.cardId === activeId)];
  for (const face of drawOrder) await drawWorkspaceFace(context, face, scale);
  return canvas.toDataURL('image/png');
}
