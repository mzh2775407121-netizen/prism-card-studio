import { artworkBounds, type Bounds } from './artworkAlignment';
import type { CanvasFace } from './canvasFaces';
import { artworkBoundsHaveArea, artworkIntersectsFace, clipBoundsToTrim, type CanvasFacePlacement } from './canvasCardRows';
import { buildLayerTree, type LayerTreeItem, type LayerUnitRef } from './layerGroups';

export type CanvasMarqueeLayers = CanvasFace & { units: LayerUnitRef[] };
export type CanvasMarqueeSelection = { boards: CanvasFace[]; layers: CanvasMarqueeLayers[] };

type MarqueeOptions = { activeFace?: CanvasFace; plate?: string | null; flashOnly?: boolean; hideBleed?: boolean };
type Hit = { inCard?: Bounds; locked: boolean; crossed: boolean; covered: boolean };

const epsilon = 1e-6;
const contains = (outer: Bounds, inner: Bounds) => outer.left <= inner.left + epsilon &&
  outer.top <= inner.top + epsilon && outer.right >= inner.right - epsilon && outer.bottom >= inner.bottom - epsilon;
const overlaps = (a: Bounds, b: Bounds) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function intersection(a: Bounds, b: Bounds): Bounds {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

function finishedArtworkHit(placement: CanvasFacePlacement, bounds: Bounds, box: Bounds): Omit<Hit, 'locked'> | undefined {
  if (!artworkBoundsHaveArea(bounds)) return;
  if (!artworkIntersectsFace(placement, bounds)) {
    return { crossed: overlaps(box, bounds), covered: contains(box, bounds) };
  }
  const inCard = clipBoundsToTrim(placement, bounds);
  if (!artworkBoundsHaveArea(inCard)) return;
  return { inCard, covered: contains(box, inCard),
    crossed: artworkBoundsHaveArea(clipBoundsToTrim(placement, intersection(box, bounds))) };
}

function selectedUnits(items: readonly LayerTreeItem[], hits: ReadonlyMap<string, Hit>, wholeBoard: boolean) {
  function visit(item: LayerTreeItem): { covered: boolean; units: LayerUnitRef[] } {
    if (item.kind === 'group') {
      const children = item.children.map(visit);
      if (children.every(child => child.covered)) return { covered: true, units: [{ kind: 'group', id: item.id }] };
      return { covered: false, units: children.flatMap(child => child.units) };
    }
    const hit = hits.get(item.id);
    if (!hit || hit.locked || wholeBoard && hit.inCard || !hit.crossed) {
      return { covered: false, units: [] };
    }
    return { covered: hit.covered, units: [{ kind: item.kind, id: item.id }] };
  }
  return items.flatMap(item => visit(item).units);
}

/** Classify the same world-space marquee for both live highlights and the final selection. */
export function hitCanvasMarquee(placements: readonly CanvasFacePlacement[], box: Bounds, options: MarqueeOptions = {}): CanvasMarqueeSelection {
  const result: CanvasMarqueeSelection = { boards: [], layers: [] };
  for (const placement of placements) {
    const { cardId, slot: face, project, x, y, guides, content } = placement;
    const side = project[face];
    const target = { cardId, face };
    const restricted = (options.plate || options.flashOnly) && (!options.activeFace ||
      options.activeFace.cardId === cardId && options.activeFace.face === face);
    const local = { left: box.left - x, top: box.top - y, right: box.right - x, bottom: box.bottom - y };
    const { trim: { width, height }, bleed } = guides;
    const trim = { left: 0, top: 0, right: width, bottom: height };
    if (!overlaps(local, content)) continue;
    const artboard = { left: bleed.x, top: bleed.y, right: bleed.x + bleed.width, bottom: bleed.y + bleed.height };
    const hits = new Map<string, Hit>();
    const onCard: Bounds[] = [];
    if (!restricted) for (const node of side.nodes) {
      if (!node.visible || node.type === 'empty') continue;
      const bounds = artworkBounds(node);
      const hit = options.hideBleed ? finishedArtworkHit(placement, bounds, local) : {
        inCard: overlaps(bounds, artboard) ? intersection(bounds, artboard) : undefined,
        crossed: overlaps(local, bounds),
        covered: contains(local, bounds),
      };
      if (!hit) continue;
      hits.set(node.id, { ...hit, locked: node.locked });
      if (hit.inCard) onCard.push(hit.inCard);
    }
    const wholeBoard = contains(local, trim) || onCard.length > 0 && onCard.every(bounds => contains(local, bounds));
    if (wholeBoard) result.boards.push(target);
    if (side.canvasLocked || hits.size === 0) continue;
    const tree = buildLayerTree(side, { artwork: node => hits.has(node.id) || node.locked, process: effect => effect.visible });
    const units = selectedUnits(tree, hits, wholeBoard);
    if (units.length) result.layers.push({ ...target, units });
  }
  return result;
}
