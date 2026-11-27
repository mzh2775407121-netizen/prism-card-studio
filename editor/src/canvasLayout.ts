import {
  canvasFacePositionKey, MAX_CANVAS_POSITION, projectCards, type CanvasFacePoint, type CanvasFacePositions, type Project, type ProjectCard, type SideName,
} from './model';

export interface CanvasFace { cardId: string; face: SideName }

export function canvasFaceKey({ cardId, face }: CanvasFace) {
  return canvasFacePositionKey(cardId, face);
}

function bleedWidth(card: ProjectCard) {
  return (card.widthMm + card.bleedMm * 2) * 10;
}

function columnGap(width: number) {
  return Math.max(48, width * .165);
}

export function canvasBoardPlacements(project: Project) {
  const cards = projectCards(project);
  const columnWidth = Math.max(...cards.map(bleedWidth));
  const backColumn = columnWidth + columnGap(columnWidth);
  let rowTop = 0;
  return cards.flatMap(card => {
    const slots: SideName[] = card.singleSided ? ['front'] : ['front', 'back'];
    const bleed = card.bleedMm * 10;
    const rowHeight = card.heightMm * 10 + bleed * 2;
    const top = rowTop;
    rowTop += rowHeight + Math.max(96, rowHeight * .235);
    return slots.map(slot => {
      const role = card.looseFace === 'back' && card.singleSided ? 'back' : slot;
      const { x, y } = project.canvasFacePositions?.[canvasFacePositionKey(card.id, slot)] ??
        { x: (role === 'back' ? backColumn : 0) + bleed, y: top + bleed };
      return { card, slot, role, x, y };
    });
  });
}

export function canvasLayoutSnapshot(project: Project): CanvasFacePositions {
  return Object.fromEntries(canvasBoardPlacements(project).map(({card, slot, x, y}) =>
    [canvasFacePositionKey(card.id, slot), { x, y }]));
}

export function preserveCanvasLayout(previous: Project, next: Project): Project {
  const positions = { ...canvasLayoutSnapshot(previous), ...next.canvasFacePositions };
  const canvasFacePositions = Object.fromEntries(canvasBoardPlacements(next).map(({card, slot, x, y}) => {
    const key = canvasFacePositionKey(card.id, slot);
    return [key, positions[key] ?? { x, y }];
  }));
  return { ...next, canvasFacePositions };
}

export function translateCanvasFaces(project: Project, targets: readonly CanvasFace[], delta: CanvasFacePoint): Project {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y) || (!delta.x && !delta.y)) return project;
  const positions = canvasLayoutSnapshot(project);
  const keys = [...new Set(targets.map(canvasFaceKey))].filter(key => Object.hasOwn(positions, key));
  if (!keys.length) return project;
  for (const axis of ['x', 'y'] as const) {
    const min = Math.min(...keys.map(key => positions[key][axis]));
    const max = Math.max(...keys.map(key => positions[key][axis]));
    const shift = Math.max(-MAX_CANVAS_POSITION - min, Math.min(delta[axis], MAX_CANVAS_POSITION - max));
    for (const key of keys) positions[key][axis] += shift;
  }
  return { ...project, canvasFacePositions: positions };
}

export function alignPairedCanvasFaces(project: Project, card: ProjectCard, anchor: CanvasFacePoint): Project {
  const width = bleedWidth(card);
  return { ...project, canvasFacePositions: { ...canvasLayoutSnapshot(project),
    [canvasFacePositionKey(card.id, 'front')]: anchor,
    [canvasFacePositionKey(card.id, 'back')]: { x: Math.min(MAX_CANVAS_POSITION, anchor.x + width + columnGap(width)), y: anchor.y },
  } };
}

export function placeInsertedCanvasCard(previous: Project, next: Project, card: ProjectCard): Project {
  const bottom = Math.max(...canvasBoardPlacements(previous).map(face => face.y + (face.card.heightMm + face.card.bleedMm) * 10));
  const nextHeight = (card.heightMm + card.bleedMm * 2) * 10;
  const width = bleedWidth(card);
  const y = Math.min(MAX_CANVAS_POSITION, bottom + Math.max(96, nextHeight * .235) + card.bleedMm * 10);
  const positioned = preserveCanvasLayout(previous, next);
  const frontX = card.bleedMm * 10;
  if (!card.singleSided) return alignPairedCanvasFaces(positioned, card, { x: frontX, y });
  return { ...positioned, canvasFacePositions: { ...positioned.canvasFacePositions,
    [canvasFacePositionKey(card.id, 'front')]: { x: card.looseFace === 'back' ? frontX + width + columnGap(width) : frontX, y },
  } };
}
