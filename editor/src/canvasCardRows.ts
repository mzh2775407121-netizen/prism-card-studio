import { artworkBounds, type Bounds } from './artworkAlignment';
import { printGuideBounds } from './PrintGuides';
import { projectForCard, type Project, type SideName } from './model';
import { canvasBoardPlacements } from './canvasLayout';
import { visualEffectPadding } from './visualEffects';

const geometryTolerance = 1e-6;

export interface CanvasFacePlacement {
  cardId: string;
  slot: SideName;
  role: SideName;
  x: number;
  y: number;
  project: Project;
  guides: ReturnType<typeof printGuideBounds>;
  content: Bounds;
}

function include(bounds: Bounds, other: Bounds) {
  return {
    left: Math.min(bounds.left, other.left), top: Math.min(bounds.top, other.top),
    right: Math.max(bounds.right, other.right), bottom: Math.max(bounds.bottom, other.bottom),
  };
}

export function boardBounds(face: CanvasFacePlacement): Bounds {
  const { x, y, guides: { bleed } } = face;
  return { left: x + bleed.x, top: y + bleed.y,
    right: x + bleed.x + bleed.width, bottom: y + bleed.y + bleed.height };
}

/** Bounding box of the part of a face-local rectangle that remains after trimming. */
export function clipBoundsToTrim(face: CanvasFacePlacement, box: Bounds): Bounds | undefined {
  const { width, height, cornerRadius } = face.guides.trim;
  if (!(width > 0 && height > 0 && Number.isFinite(width + height))) return undefined;
  const left = Math.max(0, box.left), top = Math.max(0, box.top);
  const right = Math.min(width, box.right), bottom = Math.min(height, box.bottom);
  if (!(left <= right && top <= bottom)) return undefined;
  const dieShape = face.project.production?.dieShape;
  const halfWidth = width / 2, halfHeight = height / 2;
  const radius = Math.min(cornerRadius, halfWidth, halfHeight);
  if (dieShape === 'rectangle' || dieShape !== 'ellipse' && radius === 0) return { left, top, right, bottom };

  // The cross section closest to the center is the widest one in each direction.
  const dx = Math.max(left - halfWidth, halfWidth - right, 0);
  const dy = Math.max(top - halfHeight, halfHeight - bottom, 0);
  const reach = (halfSize: number, crossSize: number, distance: number) => {
    if (dieShape === 'ellipse') return halfSize * Math.sqrt(Math.max(0, 1 - (distance / crossSize) ** 2));
    const fromArc = Math.max(0, distance - (crossSize - radius));
    return halfSize - radius + Math.sqrt(Math.max(0, radius ** 2 - fromArc ** 2));
  };
  const reachX = reach(halfWidth, halfHeight, dy);
  const reachY = reach(halfHeight, halfWidth, dx);
  const clipped = { left: Math.max(left, halfWidth - reachX), right: Math.min(right, halfWidth + reachX),
    top: Math.max(top, halfHeight - reachY), bottom: Math.min(bottom, halfHeight + reachY) };
  if (clipped.left <= clipped.right + geometryTolerance && clipped.top <= clipped.bottom + geometryTolerance) {
    return { ...clipped, right: Math.max(clipped.left, clipped.right), bottom: Math.max(clipped.top, clipped.bottom) };
  }
}

export function trimContainsPoint(face: CanvasFacePlacement, x: number, y: number) {
  const localX = x - face.x, localY = y - face.y;
  return Boolean(clipBoundsToTrim(face, { left: localX, right: localX, top: localY, bottom: localY }));
}

export function artworkBoundsHaveArea(bounds?: Bounds): bounds is Bounds {
  return !!bounds && bounds.right > bounds.left + geometryTolerance && bounds.bottom > bounds.top + geometryTolerance;
}

/** An artwork box belongs to its face when it overlaps the rectangular bleed box. */
export function artworkIntersectsFace(face: CanvasFacePlacement, bounds: Bounds) {
  const { x, y, width, height } = face.guides.bleed;
  return Math.min(bounds.right, x + width) > Math.max(bounds.left, x) + geometryTolerance &&
    Math.min(bounds.bottom, y + height) > Math.max(bounds.top, y) + geometryTolerance;
}

export function hasFinishedArtwork(face: CanvasFacePlacement, bounds: Bounds) {
  return artworkBoundsHaveArea(bounds) && (!artworkIntersectsFace(face, bounds) ||
    artworkBoundsHaveArea(clipBoundsToTrim(face, bounds)));
}

export function spreadBounds(faces: CanvasFacePlacement[]): Bounds {
  return faces.map(boardBounds).reduce(include);
}

export function canvasCardRows(project: Project): CanvasFacePlacement[] {
  const activeId = project.cardId ?? project.id + '_1';
  return canvasBoardPlacements(project).map(({card, slot, role, x, y}) => {
    const member = card.id === activeId ? project : projectForCard(project, card);
    const guides = printGuideBounds(card);
    const bounds: Bounds = { left: guides.bleed.x, top: guides.bleed.y,
      right: guides.bleed.x + guides.bleed.width, bottom: guides.bleed.y + guides.bleed.height };
    let content = bounds;
    for (const node of member[slot].nodes) {
      if (!node.visible || node.type === 'empty') continue;
      const box = artworkBounds(node);
      const padding = visualEffectPadding(node);
      // Blur and shadow extents may rotate with the node.
      const outset = Math.max(padding.left, padding.right, padding.top, padding.bottom);
      content = include(content, { left: box.left - outset, top: box.top - outset,
        right: box.right + outset, bottom: box.bottom + outset });
    }
    return { cardId: card.id, project: member, slot, role, x, y, guides, content };
  });
}
