import { Fragment, useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent, type ReactNode, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { Stage, Layer, Group, Rect, Circle, Ellipse, Shape, Image as KonvaImage, Line, Transformer } from 'react-konva';
import Konva from 'konva';
import { PrintGuideLines } from './PrintGuides';
import { processKind, type AutoLayout, type CardNode, type CardSide, type GradientPoint, type LayerGradient, type PathPoint, type Project, type Region, type SideName, type Stroke } from './model';
import { applyAutoLayout, layoutParent, offsetLayoutItem } from './autoLayout';
import { artworkPath, loadImage, makeCanvas, drawArtwork, renderCard, renderEffectMask, renderEffects, renderRegionMask, renderStockReflection, renderStockWhiteMask } from './render';
import { isTransparentStock } from './stockMaterials';
import { getStockAppearance, stockGroundColor } from './stockOptics';
import { activeImageFill, fillType, gradientAngle, gradientPoints, hasFill, hasStroke } from './layerAppearance';
import { visualEffectPadding } from './visualEffects';
import { isOpenVector, MAX_PATH_POINTS, normalizePath, smoothPathPoint, traceVectorPath } from './vectorPaths';
import { editedPath, editPathSegment, movePathPoint, pathDraft, PathNodeActions, PathNodes, splitSegmentIndex, type PathEditDraft } from './PathNodeEditor';
import { findLayerGroup, layerGroupMembers, type LayerUnitRef } from './layerGroups';
import { moveArtworkGroup, moveCanvasLayerUnits } from './transferLayer';
import { artworkBounds, snapArtwork } from './artworkAlignment';
import CanvasTextEditor, { expandedTextDraft } from './CanvasTextEditor';
import type { TextDraft } from './textStyles';
import type { FontPreviewStyle } from './LayerTypography';
import { useCanvasCamera, type Camera } from './canvasNavigation';
import { useCanvasRightMouse } from './canvasRightMouse';
import { useArtworkFonts } from './artworkFonts';
import { artworkIntersectsFace, boardBounds, canvasCardRows, hasFinishedArtwork, spreadBounds, trimContainsPoint, type CanvasFacePlacement } from './canvasCardRows';
import { canvasFaceKey, type CanvasFace } from './canvasFaces';
import { hitCanvasMarquee, type CanvasMarqueeSelection } from './canvasMarquee';
import './editor-canvas.css';

type Point = { x: number; y: number };
type BoardGesture = {
  pointerId: number;
  start: Point;
  detach: () => void;
  initialSelection: CanvasFace[];
  mixedSelection?: CanvasMarqueeSelection;
  board?: CanvasFace;
  artworkId?: string;
  additive: boolean;
  scale: number;
};
type MaskMarqueeGesture = { pointerId: number; detach: () => void };
type BrushStroke = Extract<Stroke, { size: number }>;
const boardDragThreshold = 4;

function sameBoard(a: CanvasFace, b: CanvasFace) {
  return a.cardId === b.cardId && a.face === b.face;
}

function includesBoard(selection: CanvasFace[], target: CanvasFace) {
  return selection.some(board => sameBoard(board, target));
}

function toggleBoard(selection: CanvasFace[], target: CanvasFace) {
  return includesBoard(selection, target)
    ? selection.filter(board => !sameBoard(board, target)) : [...selection, target];
}

function boardTarget(placement: CanvasFacePlacement): CanvasFace {
  return { cardId: placement.cardId, face: placement.slot };
}

function artworkIdsOf(side: CardSide, units: LayerUnitRef[]) {
  return new Set(units.flatMap(unit => unit.kind === 'artwork' ? [unit.id] : unit.kind === 'group'
    ? layerGroupMembers(side, unit.id).artworkIds : []));
}

function marqueeBounds(a: Point, b: Point) {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

function maskMarqueePath(start: Point, end: Point, scale: number): PathPoint[] | null {
  const { left, right, top, bottom } = marqueeBounds(start, end);
  if (Math.hypot(right - left, bottom - top) * scale < boardDragThreshold || right === left || bottom === top) return null;
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}

const FACES = ['front', 'back'] as const;
const FACE_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const EDITOR_BLUE = '#237ac2';
const EDITOR_FOCUS = '#69b5f6';
const PIXEL_PREVIEW_SCALE = 32;

function SelectionSize({ x, y, widthMm, heightMm, kind }: Point & {
  widthMm: number; heightMm: number; kind: 'face' | 'layer';
}) {
  return <span className="canvas-selection-size" data-selection-size={kind} style={{ left: x, top: y }}>
    {Number(widthMm.toFixed(2))} × {Number(heightMm.toFixed(2))} mm
  </span>;
}

function artworkSelectionSize(nodes: CardNode[], group: boolean, layout?: AutoLayout) {
  if (layout) return { x: layout.x + layout.width / 2, y: layout.y + layout.height,
    widthMm: layout.width / 10, heightMm: layout.height / 10 };
  if (!nodes.length) return undefined;
  const bounds = nodes.map(artworkBounds);
  const left = Math.min(...bounds.map(item => item.left)), right = Math.max(...bounds.map(item => item.right));
  const top = Math.min(...bounds.map(item => item.top)), bottom = Math.max(...bounds.map(item => item.bottom));
  return { x: (left + right) / 2, y: bottom,
    widthMm: (group ? right - left : nodes[0].width) / 10, heightMm: (group ? bottom - top : nodes[0].height) / 10 };
}

export const ZOOM_STEP = 1.2;
export type EditorTool = 'select' | 'hand' | 'brush' | 'eraser' | 'geometry' | 'line' | 'pen' | 'mask-marquee' | 'mask-pen';
export type CreatedVector = Pick<CardNode, 'x' | 'y' | 'width' | 'height' | 'pathPoints' | 'pathClosed'> & { type: 'line' | 'path' };
type VectorDraft = { face: SideName; points: PathPoint[] };
type LineGesture = { face: SideName; start: Point; end: Point };

function vectorFromPoints(points: PathPoint[], type: 'line' | 'path', closed: boolean): CreatedVector {
  return { type, ...normalizePath(points), pathClosed: closed };
}

function snapAngle(start: Point, end: Point, enabled: boolean): Point {
  if (!enabled) return end;
  const angle = Math.round(Math.atan2(end.y - start.y, end.x - start.x) / (Math.PI / 4)) * Math.PI / 4;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  return { x: start.x + Math.cos(angle) * distance, y: start.y + Math.sin(angle) * distance };
}

export interface CanvasNavigation {
  fit: () => void;
  focusCard: (id: string, view?: Camera) => void;
  captureView: (id: string) => Camera | null;
  worldAt: (screen: Point) => Point;
  pinView: () => void;
  hasPathDraft: () => boolean;
  zoomBy: (factor: number) => void;
  editPath: (face: SideName, id: string) => void;
}

export interface EditorCanvasProps {
  project: Project;
  side: SideName;
  selectedId: string | null;
  selectedIds?: string[];
  selectedUnits?: LayerUnitRef[];
  artworkGroupId?: string;
  onSelect: (id: string | null, additive?: boolean, direct?: boolean) => void;
  onCanvasMenu: (target: CanvasFace, point: Point, screen: Point, nodeId?: string) => void;
  onActivateMember: (id: string, face: SideName, nodeId?: string, direct?: boolean) => void;
  onFaceMenu: (id: string, face: SideName, screen: Point) => void;
  selectedBoards: CanvasFace[];
  canvasSelection?: CanvasMarqueeSelection;
  hasLayerSelection: boolean;
  onSelectBoards: (boards: CanvasFace[]) => void;
  onMoveBoards: (boards: CanvasFace[], delta: Point) => void;
  onSelectMarquee: (selection: CanvasMarqueeSelection, additive: boolean) => void;
  onMoveMarquee: (selection: CanvasMarqueeSelection, delta: Point) => void;
  onSelectFace: (face: SideName, nodeId?: string, direct?: boolean) => void;
  onDrillArtwork: (face: SideName, nodeId: string) => boolean;
  onSelectPath?: (face: SideName, nodeId: string) => void;
  onTransferArtwork: (from: SideName, to: SideName, id: string, position: Point, groupId?: string) => boolean;
  sidebarDropFace?: SideName;
  faceLocked?: boolean;
  onChange: (side: CardSide, face: SideName) => void;
  tool: EditorTool;
  onCreateVector: (face: SideName, vector: CreatedVector) => void;
  spaceHeld: boolean;
  magicMouseZoom?: boolean;
  onStartSpacePan: () => void;
  navigationBlocked?: boolean;
  contextMenuOpen?: boolean;
  navigationRef: Ref<CanvasNavigation>;
  initialCamera?: Camera | null;
  finishedView?: boolean;
  showGuides: boolean;
  samplingColor?: boolean;
  regionId: string | null;
  regionMode: boolean;
  highlightRegion?: boolean;
  onRegionChange: (region: Region) => void;
  maskSelection?: PathPoint[] | null;
  onMaskSelectionChange?: (points: PathPoint[] | null) => void;
  fontPreview?: { node: CardNode; style: FontPreviewStyle };
  textEdit?: { face: SideName; id: string };
  onTextEdit?: (face: SideName, id: string) => void;
  onTextCommit?: (face: SideName, id: string, text: TextDraft) => void;
  onTextCancel?: () => void;
  plate?: string | null;
  flashOnly?: boolean;
  brushSize?: number;
  layerPlate?: string;
  effectPreviewId?: string;
  editGradient?: boolean;
  onGradientChange?: (gradient: LayerGradient) => void;
  onGradientStart?: () => void;
  radialEffectId?: string;
  onRadialCenterChange?: (id: string, center: GradientPoint) => void;
  cardBoundsRef: Ref<HTMLDivElement>;
}

function artworkId(face: SideName, nodeId: string) {
  return `${face}-artwork-${nodeId}`;
}

function directArtworkSelection(event: Pick<MouseEvent, 'altKey' | 'metaKey'>) {
  return event.altKey || event.metaKey;
}

function ArtworkNode({ node, face, passiveId, interactive, outsideTrim, canDrag = true, onSelect, onCommit, onDrag, onDrop, onTransformPreview, onDoubleActivate }: {
  node: CardNode; face: SideName; passiveId?: string; interactive: boolean; onSelect: (additive: boolean, direct: boolean) => void;
  outsideTrim?: { width: number; height: number };
  canDrag?: boolean;
  onCommit: (node: CardNode) => void; onDrag: (node: CardNode, bypass: boolean) => void;
  onDrop: (node: CardNode, cancelled: boolean) => void;
  onTransformPreview: (node: CardNode) => void;
  onDoubleActivate: () => void;
}) {
  const minimumSize = node.type === 'line' || node.type === 'path' ? 1 : 8;
  const [loaded, setLoaded] = useState<{ src: string; image: HTMLImageElement }>();
  const src = activeImageFill(node)?.src;
  const image = loaded?.src === src ? loaded?.image : undefined;
  const [, setFontsReady] = useState(false);
  useEffect(() => {
    let current = true;
    if (node.type === 'text') document.fonts.ready.then(() => { if (current) setFontsReady(true); });
    return () => { current = false; };
  }, [node.type]);
  useEffect(() => {
    let current = true;
    if (src) loadImage(src).then(value => {
      if (current) setLoaded({ src, image: value });
    }).catch(() => { if (current) setLoaded(undefined); });
    return () => { current = false; };
  }, [src]);
  const common = {
    id: passiveId ? passiveId + '-' + artworkId(face, node.id) : artworkId(face, node.id), artworkNodeId: node.id, name: 'artwork-node', x: node.x, y: node.y,
    width: node.width, height: node.height, rotation: node.rotation,
    opacity: node.opacity, visible: node.visible,
    draggable: interactive && !node.locked && canDrag, listening: interactive && !node.locked,
    stroke: hasStroke(node) ? node.stroke : undefined,
    strokeWidth: (node.strokeWidth || 0) * (isOpenVector(node) ? 1 : node.strokeAlign === 'outside' ? 2 : node.strokeAlign === 'inside' ? 0 : 1),
    globalCompositeOperation: (node.blend || 'source-over') as GlobalCompositeOperation,
    onMouseDown: (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (event.evt.button !== 0) return;
      event.cancelBubble = true;
      onSelect(event.evt.shiftKey, directArtworkSelection(event.evt));
    },
    onTouchStart: (event: Konva.KonvaEventObject<TouchEvent>) => { event.cancelBubble = true; onSelect(false, false); },
    onDblClick: (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (!directArtworkSelection(event.evt)) onDoubleActivate();
    },
    onDblTap: onDoubleActivate,
    onDragMove: (event: Konva.KonvaEventObject<DragEvent>) => onDrag({ ...node, x: event.target.x(), y: event.target.y() }, event.evt.altKey),
    onDragEnd: (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      const cancelled = !event.evt || event.evt.type === 'touchcancel';
      if (cancelled) event.target.position({ x: node.x, y: node.y });
      onDrop({ ...node, x: event.target.x(), y: event.target.y() }, cancelled);
    },
    onTransform: (event: Konva.KonvaEventObject<Event>) => {
      const target = event.target;
      onTransformPreview({ ...node, x: target.x(), y: target.y(), rotation: target.rotation(),
        width: Math.max(minimumSize, target.width() * target.scaleX()),
        height: Math.max(minimumSize, target.height() * target.scaleY()),
        ...(node.type === 'text' ? { fontSize: (node.fontSize || 24) * target.scaleY() } : {}) });
    },
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => {
      const target = event.target;
      const next = { ...node, x: target.x(), y: target.y(), rotation: target.rotation(),
        width: Math.max(minimumSize, target.width() * target.scaleX()),
        height: Math.max(minimumSize, target.height() * target.scaleY()) };
      if (node.type === 'text') next.fontSize = (node.fontSize || 24) * target.scaleY();
      target.scaleX(1); target.scaleY(1);
      onCommit(next);
    },
  };
  if (node.type === 'empty') return null;
  return <Shape {...common} perfectDrawEnabled={false} lineJoin="round"
    sceneFunc={(context, shape) => {
      const raw = context._context;
      if (!outsideTrim) { drawArtwork(raw, node, image); return; }
      const padding = Math.max(1, node.strokeWidth || 0) * 4;
      const outset = visualEffectPadding(node);
      const visible = new Path2D();
      visible.rect(-padding - outset.left, -padding - outset.top,
        node.width + padding * 2 + outset.left + outset.right, node.height + padding * 2 + outset.top + outset.bottom);
      const trim = new Path2D();
      trim.rect(0, 0, outsideTrim.width, outsideTrim.height);
      visible.addPath(trim, new DOMMatrix(shape.getTransform().copy().invert().getMatrix()));
      raw.save();
      raw.clip(visible, 'evenodd');
      drawArtwork(raw, node, image);
      raw.restore();
    }}
    hitFunc={(context, shape) => {
      const raw = context._context;
      const path = artworkPath(node);
      raw.save();
      if (node.flipX || node.flipY) {
        raw.translate(node.width / 2, node.height / 2);
        raw.scale(node.flipX ? -1 : 1, node.flipY ? -1 : 1);
        raw.translate(-node.width / 2, -node.height / 2);
      }
      raw.fillStyle = shape.colorKey;
      if (!isOpenVector(node)) raw.fill(path,node.fillRule ?? 'nonzero');
      if (common.stroke && common.strokeWidth) {
        raw.strokeStyle = shape.colorKey;
        raw.lineWidth = Math.max(common.strokeWidth, isOpenVector(node) ? 8 / Math.max(.01, shape.getAbsoluteScale().x) : 0);
        raw.lineCap = 'round';
        raw.stroke(path);
      }
      raw.restore();
    }}/>;
}

function GradientHandles({ node, scale, onStart, onChange }: {
  node: CardNode & { gradient: LayerGradient };
  scale: number; onStart?: () => void; onChange: (gradient: LayerGradient) => void;
}) {
  const reflectPoint = ([x, y]: GradientPoint): GradientPoint => [node.flipX ? node.width - x : x, node.flipY ? node.height - y : y];
  const points = gradientPoints(node.gradient, node.width, node.height).map(reflectPoint) as [GradientPoint, GradientPoint];
  return <Group x={node.x} y={node.y} rotation={node.rotation} name="gradient-handles">
    <Line points={points.flat()} stroke="#f7f7f7" strokeWidth={3 / scale} opacity={.9} listening={false}/>
    <Line points={points.flat()} stroke={EDITOR_BLUE} strokeWidth={1.5 / scale} listening={false}/>
    {points.map(([x, y], index) => <Circle key={index} name={'gradient-handle-' + index}
      x={x} y={y} radius={6 / scale} hitStrokeWidth={12 / scale}
      fill={index ? '#ffffff' : EDITOR_FOCUS} stroke={EDITOR_BLUE} strokeWidth={1.6 / scale} draggable
      onMouseDown={event => { event.cancelBubble = true; }}
      onTouchStart={event => { event.cancelBubble = true; }}
      onDragStart={onStart}
      onDragMove={event => {
        const clamp = (value: number) => Math.max(-2, Math.min(3, value));
        const x = clamp(event.target.x() / node.width) * node.width;
        const y = clamp(event.target.y() / node.height) * node.height;
        const moved = [...points] as [GradientPoint, GradientPoint];
        moved[index] = [x, y];
        event.target.position({ x, y });
        const canonical = moved.map(reflectPoint) as [GradientPoint, GradientPoint];
        const [start, end] = canonical;
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) < .25) return;
        const angle = gradientAngle(canonical);
        const axes = node.gradient.radialAxis;
        let radialAxis: GradientPoint | undefined;
        if (axes) {
          const original = gradientPoints(node.gradient, node.width, node.height);
          const originalLength = Math.hypot(original[1][0] - original[0][0], original[1][1] - original[0][1]);
          const factor = Math.hypot(end[0] - start[0], end[1] - start[1]) / originalLength;
          const delta = (angle - gradientAngle(original)) * Math.PI / 180;
          const dx = axes[0] * node.width, dy = axes[1] * node.height;
          radialAxis = [(dx * Math.cos(delta) - dy * Math.sin(delta)) * factor / node.width,
            (dx * Math.sin(delta) + dy * Math.cos(delta)) * factor / node.height];
          if (radialAxis.some(axis => !Number.isFinite(axis) || Math.abs(axis) > 5)) return;
        }
        onChange({ ...node.gradient, radialAxis, angle,
          endpoints: [[start[0] / node.width, start[1] / node.height], [end[0] / node.width, end[1] / node.height]] });
      }}/>)}
  </Group>;
}

function RadialCenterHandle({ node, center, scale, onStart, onChange }: {
  node: CardNode; center: GradientPoint; scale: number; onStart?: () => void; onChange: (center: GradientPoint) => void;
}) {
  const reflect = ([x, y]: GradientPoint): GradientPoint => [node.flipX ? 1 - x : x, node.flipY ? 1 - y : y];
  const [x, y] = reflect(center);
  return <Group x={node.x} y={node.y} rotation={node.rotation} name="radial-center-handle">
    <Circle x={x * node.width} y={y * node.height} radius={7 / scale} hitStrokeWidth={14 / scale}
      fill={EDITOR_FOCUS} stroke="#fff" strokeWidth={1.5 / scale} draggable
      onMouseDown={event => { event.cancelBubble = true; }} onTouchStart={event => { event.cancelBubble = true; }}
      onDragStart={onStart} onDragMove={event => {
        const clamp = (value: number) => Math.max(0, Math.min(1, value));
        const nextX = clamp(event.target.x() / node.width);
        const nextY = clamp(event.target.y() / node.height);
        event.target.position({ x: nextX * node.width, y: nextY * node.height });
        const next = reflect([nextX, nextY]).map(value => Math.round(value * 10000) / 10000) as GradientPoint;
        onChange(next);
      }}/>
  </Group>;
}

function useFaceArtwork(placement: CanvasFacePlacement, side: CardSide, finishedView: boolean, flashOnly = false) {
  const { project, slot: face } = placement;
  const [clipped, setClipped] = useState<HTMLCanvasElement>();
  const [effects, setEffects] = useState<HTMLCanvasElement>();
  const [stock, setStock] = useState<Awaited<ReturnType<typeof renderStockReflection>>>();
  const [whiteStock, setWhiteStock] = useState<HTMLCanvasElement>();
  const cardArtworkIds = useMemo(() => finishedView ? new Set(side.nodes
    .filter(node => artworkIntersectsFace(placement, artworkBounds(node))).map(node => node.id)) : undefined,
  [finishedView, placement, side.nodes]);
  const hasClips = side.nodes.some(node => node.type !== 'empty' && node.clipRegionId && node.visible &&
    (!cardArtworkIds || cardArtworkIds.has(node.id)));
  useEffect(() => {
    if (!hasClips) { setClipped(undefined); return; }
    let current = true;
    renderCard({ ...project, [face]: side }, face, { effects: false, transparentGround: true, artworkIds: cardArtworkIds })
      .then(canvas => { if (current) setClipped(canvas); })
      .catch(() => { if (current) setClipped(undefined); });
    return () => { current = false; };
  }, [hasClips, cardArtworkIds, side, face, project.widthMm, project.heightMm]);
  useEffect(() => {
    let current = true;
    const effectSide = flashOnly ? { ...side, effects: side.effects.filter(effect => processKind(effect) === 'reflection') } : side;
    if (!effectSide.effects.length) { setEffects(undefined); return; }
    renderEffects(project, effectSide)
      .then(canvas => { if (current) setEffects(canvas); })
      .catch(() => { if (current) setEffects(undefined); });
    return () => { current = false; };
  }, [project.widthMm, project.heightMm, project.previewStyle, side, flashOnly]);
  useEffect(() => {
    if (flashOnly) return;
    let current = true;
    renderStockReflection(project, side, 1, true)
      .then(canvas => { if (current) setStock(canvas); })
      .catch(() => { if (current) setStock(undefined); });
    return () => { current = false; };
  }, [project.widthMm, project.heightMm, project.bleedMm, project.cornerRadiusMm, project.production?.dieShape,
    project.material, project.stockReflection, project.stockSpec, project.production?.printer, project.production?.stockCode,
    project.production?.printProfile, side, flashOnly]);
  useEffect(() => {
    if (!isTransparentStock(project.material) || flashOnly) return;
    let current = true;
    renderStockWhiteMask(project, side, 1, true)
      .then(canvas => { if (current) setWhiteStock(canvas); })
      .catch(() => { if (current) setWhiteStock(undefined); });
    return () => { current = false; };
  }, [project.widthMm, project.heightMm, project.bleedMm, project.material, side, flashOnly]);
  return { cardArtworkIds, clipped: hasClips ? clipped : undefined, effects, stock: flashOnly ? undefined : stock,
    whiteStock: !flashOnly && isTransparentStock(project.material) ? whiteStock : undefined };
}

function traceTrim(context: Konva.Context, placement: CanvasFacePlacement) {
  const { width, height, cornerRadius } = placement.guides.trim;
  const dieShape = placement.project.production?.dieShape;
  if (dieShape === 'ellipse') {
    context.moveTo(width, height / 2);
    context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, 2 * Math.PI);
  } else context.roundRect(0, 0, width, height, dieShape === 'rectangle' ? 0 : cornerRadius);
  context.closePath();
}

function traceBleed(context: Konva.Context, placement: CanvasFacePlacement) {
  const { x, y, width, height, cornerRadius } = placement.guides.bleed;
  context.roundRect(x, y, width, height, cornerRadius);
  context.closePath();
}

function CanvasFaceSurface({ placement, side, finishedView, flashOnly, x, y, scale, children }: {
  placement: CanvasFacePlacement; side: CardSide; finishedView: boolean; flashOnly?: boolean;
  x: number; y: number; scale: number;
  children: (artwork: ReturnType<typeof useFaceArtwork>) => ReactNode;
}) {
  const artwork = useFaceArtwork(placement, side, finishedView, flashOnly);
  return <Group name={`canvas-member-face card-face-${placement.slot}`} memberId={placement.cardId}
    faceSlot={placement.slot} x={x} y={y} scaleX={scale} scaleY={scale}>
    {children(artwork)}
  </Group>;
}

function previewDrag(project: Project, face: SideName, dragged?: CardNode, selectedIds: readonly string[] = [], groupId?: string,
  destination?: SideName, units?: LayerUnitRef[],
) {
  const side = project[face];
  if (!dragged) return side;
  const original = side.nodes.find(node => node.id === dragged.id);
  const translating = original && original.width === dragged.width &&
    original.height === dragged.height && original.rotation === dragged.rotation;
  if (translating && groupId && layerGroupMembers(side, groupId).artworkIds.includes(dragged.id)) {
    return moveArtworkGroup(project, face, groupId, { x: dragged.x - original.x, y: dragged.y - original.y },
      { previewAcrossFaces: Boolean(destination) }) ?? side;
  }
  if (translating && selectedIds.includes(dragged.id) && units?.some(unit => unit.kind === 'group')) {
    return moveCanvasLayerUnits(project, face, units, { x: dragged.x - original.x, y: dragged.y - original.y });
  }
  return { ...side, nodes: side.nodes.map(node => {
    if (node.id === dragged.id) return dragged;
    return original && selectedIds.includes(original.id) && selectedIds.includes(node.id) && node.visible && !node.locked
      ? { ...node, x: node.x + dragged.x - original.x, y: node.y + dragged.y - original.y } : node;
  }) };
}

function previewArtwork(side: CardSide, draft?: CardNode, reflow = true): CardSide {
  if (!draft) return side;
  const view = { ...side, nodes: side.nodes.map(node => node.id === draft.id ? draft : node) };
  return reflow && layoutParent(side, draft.id) ? applyAutoLayout(view) : view;
}

export default function EditorCanvas({ project, initialCamera, side: sideName, selectedId, selectedIds, selectedUnits, artworkGroupId, onSelect, onCanvasMenu, onSelectFace, onActivateMember, onFaceMenu, selectedBoards, canvasSelection, hasLayerSelection, onSelectBoards, onMoveBoards, onSelectMarquee, onMoveMarquee, onDrillArtwork, onSelectPath, onTransferArtwork, sidebarDropFace, faceLocked, onChange,
  tool, onCreateVector, spaceHeld, magicMouseZoom, onStartSpacePan, navigationBlocked, contextMenuOpen, navigationRef, finishedView = false, showGuides, samplingColor, regionId, regionMode, highlightRegion, onRegionChange, maskSelection, onMaskSelectionChange, fontPreview, textEdit, onTextEdit, onTextCommit, onTextCancel, plate, flashOnly,
  brushSize = 30, layerPlate, effectPreviewId, editGradient, onGradientChange, onGradientStart, radialEffectId, onRadialCenterChange, cardBoundsRef }: EditorCanvasProps) {
  const holder = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const boardGesture = useRef<BoardGesture | null>(null);
  const boardArtworkClick = useRef<{ board: CanvasFace; nodeId: string; time: number } | null>(null);
  const [boardDrag, setBoardDrag] = useState<{ boards: CanvasFace[]; delta: Point; mixedSelection?: CanvasMarqueeSelection } | null>(null);
  const [marquee, setMarquee] = useState<ReturnType<typeof marqueeBounds> | null>(null);
  const maskMarquee = useRef<MaskMarqueeGesture | null>(null);
  const [draftMaskMarquee, setDraftMaskMarquee] = useState<PathPoint[] | null>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const resizeGesture = useRef<{ start?: { width: number; height: number }; proportional: boolean } | null>(null);
  const [size, setSize] = useState({ width: 600, height: 700 });
  const [panning, setPanning] = useState(false);
  const [dragged, setDragged] = useState<{ face: SideName; node: CardNode; destination?: SideName } | null>(null);
  const [snap, setSnap] = useState<{x?:number;y?:number}>({});
  const snapBounds=useMemo(()=>Object.fromEntries(FACES.map(face=>[face,project[face].nodes.filter(n=>n.visible&&n.type!=='empty')
    .map(n=>({id:n.id,bounds:artworkBounds(n)}))])) as Record<SideName,{id:string;bounds:ReturnType<typeof artworkBounds>}[]>,[project.front,project.back]);
  const [regionImage, setRegionImage] = useState<{ image: HTMLCanvasElement; includeBleed: boolean }>();
  const [platePreview, setPlatePreview] = useState<{ face: SideName; channel: string; layer?: string; image: HTMLCanvasElement }>();
  const [draftStroke, setDraftStroke] = useState<BrushStroke | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const panStart = useRef<{ id: number; pointer: Point; camera: Camera } | null>(null);
  const currentStroke = useRef<BrushStroke | null>(null);
  const geometryStart = useRef<{ x: number; y: number } | null>(null);
  const geometryRegion = useRef<Region | null>(null);
  const [vectorDraft, setVectorDraft] = useState<VectorDraft | null>(null);
  const vectorRef = useRef<VectorDraft | null>(null);
  const penHandle = useRef<number | null>(null);
  const lastPenClick = useRef<{ face: SideName; point: Point; time: number } | null>(null);
  const [lineDraft, setLineDraft] = useState<LineGesture | null>(null);
  const lineRef = useRef<LineGesture | null>(null);
  const [vectorHover, setVectorHover] = useState<Point | null>(null);
  const [textDraft, setTextDraft] = useState<{ face: SideName; id: string; content: TextDraft }>();
  const [fontsReady, setFontsReady] = useState(false);
  const fontRevision = useArtworkFonts(project);
  const activeCardId = project.cardId ?? project.id + '_1';
  const selection = useMemo(() => selectedIds?.length ? selectedIds : selectedId ? [selectedId] : [], [selectedIds, selectedId]);
  const currentSide = project[sideName];
  const overlayHidden = !!samplingColor;
  const [pathEdit, setPathEdit] = useState<PathEditDraft | null>(null);
  const pathTarget = pathEdit?.projectId === activeCardId && pathEdit.face === sideName && selectedId === pathEdit.id &&
    tool === 'select' && !regionMode && !plate && !flashOnly && !textEdit
    ? currentSide.nodes.find(node => node.id === pathEdit.id && node.visible && !node.locked)
    : undefined;
  const pathView = useMemo(() => pathTarget && pathEdit?.dirty ? editedPath(pathTarget, pathEdit) : undefined, [pathEdit, pathTarget]);
  useEffect(() => { if (pathEdit && !pathTarget) setPathEdit(null); }, [pathEdit, pathTarget]);
  const beginPathEdit = (face: SideName, id: string) => {
    if (tool !== 'select' || samplingColor || regionMode || plate || flashOnly || textEdit ||
      project[face].canvasLocked || (faceLocked && face !== sideName)) return;
    const node = project[face].nodes.find(item => item.id === id && item.visible && !item.locked);
    const initial = node && pathDraft(node);
    if (!node || !initial) return;
    if (onSelectPath) onSelectPath(face, id);
    else if (face === sideName) onSelect(id);
    else onSelectFace(face, id);
    setPathEdit({ projectId: activeCardId, face, id, ...initial, selected: null, dirty: node.type !== 'path' && node.type !== 'line' });
  };
  const updatePath = (update: (draft: PathEditDraft) => PathEditDraft) => {
    setPathEdit(draft => draft && update(draft));
  };
  const changeAnchor = (change: (points: PathPoint[], index: number, closed: boolean) => PathPoint[]) => {
    updatePath(draft => {
      if (draft.selected === null) return draft;
      const points = change(draft.points, draft.selected, draft.closed);
      return points === draft.points ? draft : { ...draft, points, dirty: true };
    });
  };
  const removePathAnchor = () => updatePath(draft => {
    if (draft.selected === null || draft.points.length <= (draft.closed ? 3 : 2)) return draft;
    const points = draft.points.filter((_, index) => index !== draft.selected);
    return { ...draft, points, selected: Math.min(draft.selected, points.length - 1), dirty: true };
  });
  const finishPathEdit = () => {
    if (pathView && pathEdit && pathEdit.points.length >= (pathEdit.closed ? 3 : 2)) {
      onChange(previewArtwork(currentSide, pathView), pathEdit.face);
    }
    setPathEdit(null);
  };
  const previewFontNode = useMemo(() => fontPreview && ({ ...fontPreview.node, ...fontPreview.style }), [fontPreview]);
  const textTarget = textEdit && project[textEdit.face].nodes.find(node => node.id === textEdit.id && node.type === 'text' && node.visible && !node.locked);
  const draftNode = useMemo(() => {
    if (!textTarget || !textEdit) return undefined;
    const target = textEdit.face === sideName && textTarget.id === previewFontNode?.id ? previewFontNode : textTarget;
    const content = textDraft?.face === textEdit.face && textDraft.id === textEdit.id
      ? textDraft.content : { text: target.text || '', textStyles: target.textStyles };
    const draft = layoutParent(project[textEdit.face], target.id) ? { ...target, ...content } : expandedTextDraft(target, content);
    const visibleFill = hasFill(draft) && (draft.fillOpacity ?? 1) > 0;
    const visibleStroke = hasStroke(draft) && (draft.strokeOpacity ?? 1) > 0;
    return draft.opacity > 0 && (visibleFill || visibleStroke) ? draft : {
      ...draft, opacity: 1, fill: EDITOR_FOCUS, fillMode: 'solid' as const,
      fillHidden: false, fillOpacity: 1, strokeHidden: true, clipRegionId: undefined,
    };
  }, [project, textTarget, textEdit?.face, textEdit?.id, textDraft, fontsReady, fontRevision, previewFontNode, sideName]);
  useEffect(() => { setTextDraft(undefined); }, [textEdit?.face, textEdit?.id]);
  useEffect(() => {
    let alive = true;
    document.fonts.ready.then(() => { if (alive) setFontsReady(true); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (textEdit && !textTarget) onTextCancel?.(); }, [textEdit, textTarget, onTextCancel]);
  const activeGroup = findLayerGroup(currentSide, artworkGroupId);
  const groupMembers = useMemo(() => activeGroup ? layerGroupMembers(currentSide, activeGroup.id) : undefined, [currentSide, activeGroup]);
  const groupLocked = Boolean(groupMembers && currentSide.nodes.some(node => groupMembers.artworkIds.includes(node.id) && node.locked));
  const frontDrag = dragged?.face === 'front' ? dragged.node : undefined;
  const backDrag = dragged?.face === 'back' ? dragged.node : undefined;
  const frontDestination = frontDrag ? dragged?.destination : undefined;
  const backDestination = backDrag ? dragged?.destination : undefined;
  const front = useMemo(() => {
    const editing = sideName === 'front';
    const view = previewDrag(project, 'front', frontDrag, editing ? selection : [], editing ? activeGroup?.id : undefined, frontDestination, editing ? selectedUnits : undefined);
    if (editing && pathView) return previewArtwork(view, pathView, false);
    const draft = textEdit?.face === 'front' ? draftNode : editing && !frontDrag ? previewFontNode : undefined;
    return previewArtwork(view, draft);
  }, [project, frontDrag, frontDestination, sideName, selection, selectedUnits, activeGroup?.id, pathView, draftNode, textEdit?.face, previewFontNode]);
  const back = useMemo(() => {
    const editing = sideName === 'back';
    const view = previewDrag(project, 'back', backDrag, editing ? selection : [], editing ? activeGroup?.id : undefined, backDestination, editing ? selectedUnits : undefined);
    if (editing && pathView) return previewArtwork(view, pathView, false);
    const draft = textEdit?.face === 'back' ? draftNode : editing && !backDrag ? previewFontNode : undefined;
    return previewArtwork(view, draft);
  }, [project, backDrag, backDestination, sideName, selection, selectedUnits, activeGroup?.id, pathView, draftNode, textEdit?.face, previewFontNode]);
  const views = { front, back };
  const textNode = draftNode && textEdit && views[textEdit.face].nodes.find(node => node.id === draftNode.id);
  const side = views[sideName];
  const handleTarget = !marquee && !overlayHidden && !pathTarget && !textNode && !regionMode && !highlightRegion && !plate && !flashOnly && tool === 'select'
    ? side.nodes.find(node => node.id === selectedId && node.visible && !node.locked)
    : undefined;
  const gradientNode = editGradient && handleTarget?.gradient && !handleTarget.fillHidden &&
    ['linear', 'radial'].includes(fillType(handleTarget)) ? handleTarget : undefined;
  const radialEffect = radialEffectId ? handleTarget?.visualEffects?.find(item => item.id === radialEffectId && item.enabled) : undefined;
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const placements = useMemo(() => canvasCardRows(project), [project]);
  const lockedBoard = (target: CanvasFace) => Boolean(placements.find(face => sameBoard(boardTarget(face), target))?.project[target.face].canvasLocked);
  const activeFaces = placements.filter(face => face.cardId === activeCardId);
  const maskMarqueeMode = regionMode && tool === 'mask-marquee';
  const maskPenMode = regionMode && tool === 'mask-pen';
  const editingRegionId = regionMode ? regionId : null;
  const boundsCamera = (bounds: ReturnType<typeof spreadBounds>): Camera => {
    const w = bounds.right - bounds.left, h = bounds.bottom - bounds.top;
    const fitScale = Math.max(.01, Math.min(size.width * .737 / w, (size.height - (showGuides ? 144 : 120)) / h));
    return { scale: fitScale, fitScale, x: (size.width - (bounds.left + bounds.right) * fitScale) / 2,
      y: (size.height - (bounds.top + bounds.bottom) * fitScale) / 2 + (showGuides ? 12 : 0) };
  };
  const fittedCamera = boundsCamera(spreadBounds(placements));
  const cameraBusy = (allowContextDismissal = false) => Boolean(navigationBlocked || (!allowContextDismissal && contextMenuOpen) ||
    samplingColor || sidebarDropFace || panStart.current || rightMouse.isActive() || boardGesture.current || maskMarquee.current ||
    currentStroke.current || geometryStart.current || lineRef.current || penHandle.current !== null || Konva.isDragReady() ||
    transformerRef.current?.isTransforming());
  const handMode = tool === 'hand' || spaceHeld;
  const camera = useCanvasCamera(holder, fittedCamera, cameraBusy, () => {
    lastPenClick.current = null;
    setPointer(null);
    setVectorHover(null);
  }, initialCamera, handMode, magicMouseZoom);
  const releaseSidebarField = () => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && !holder.current?.contains(focused) &&
      focused.matches('input,textarea,select,[contenteditable]')) focused.blur();
  };
  const rightMouse = useCanvasRightMouse(camera, setPanning, () => {
    releaseSidebarField();
    lastPenClick.current = null;
    setPointer(null);
    setVectorHover(null);
  });
  const { origin } = camera;
  const { scale } = origin;
  const faceOffset = (slot: SideName) => activeFaces.find(face => face.slot === slot) ?? activeFaces[0];
  const faceLeft = (face: SideName) => origin.x + faceOffset(face).x * scale;
  const faceTop = (face: SideName) => origin.y + faceOffset(face).y * scale;
  const clampMaskPoint = (point: Point) => {
    const { trim, bleed } = faceOffset(sideName).guides;
    const { x, y, width, height } = finishedView ? trim : bleed;
    return { x: Math.max(x, Math.min(x + width, point.x)), y: Math.max(y, Math.min(y + height, point.y)) };
  };
  const faceDisabled = Boolean(faceLocked || regionMode);
  const faceContainsPoint = (placement: CanvasFacePlacement, x: number, y: number) => {
    if (finishedView) return trimContainsPoint(placement, x, y);
    const board = boardBounds(placement);
    return x >= board.left && x <= board.right && y >= board.top && y <= board.bottom;
  };
  const placementAt = (point?: Point | null) => {
    if (!point || point.x < 0 || point.x > size.width || point.y < 0 || point.y > size.height) return;
    const x = (point.x - origin.x) / scale, y = (point.y - origin.y) / scale;
    return [...drawOrder].reverse().find(face => faceContainsPoint(face, x, y));
  };
  const faceAt = (point?: Point | null) => {
    const face = placementAt(point);
    return face?.cardId === activeCardId ? face.slot : undefined;
  };
  const pendingFocus = useRef<{id:string;view?:Camera} | null>(null);
  const focusCard = (id: string, view?: Camera) => {
    const faces = placements.filter(face => face.cardId === id);
    if (!faces.length) { pendingFocus.current = {id,view}; return; }
    pendingFocus.current = null;
    if (view) {
      const anchor = faces.find(face => face.slot === 'front') ?? faces[0];
      camera.write({ ...view, fitScale: fittedCamera.fitScale,
        x: view.x - anchor.x * view.scale, y: view.y - anchor.y * view.scale });
      return;
    }
    const bounds = spreadBounds(faces);
    const fit = boundsCamera(bounds);
    camera.flush();
    const current = camera.read();
    const readable = current.scale >= fit.scale * .35;
    if (readable && current.x + bounds.left * current.scale >= 8 && current.x + bounds.right * current.scale <= size.width - 8 &&
      current.y + bounds.top * current.scale >= 28 && current.y + bounds.bottom * current.scale <= size.height - 8) return;
    const scale = readable ? Math.min(current.scale, fit.scale) : fit.scale;
    camera.write({ fitScale: fittedCamera.fitScale, scale,
      x: (size.width - (bounds.left + bounds.right) * scale) / 2,
      y: (size.height - (bounds.top + bounds.bottom) * scale) / 2 + (showGuides ? 12 : 0) });
  };
  useLayoutEffect(() => {
    const focus = pendingFocus.current;
    if (focus) focusCard(focus.id,focus.view);
  }, [placements, size]);
  const draggedGroupId = (face: SideName, nodeId: string) => face === sideName && groupMembers?.artworkIds.includes(nodeId) ? activeGroup?.id : undefined;
  const dragDestination = (from: SideName, nodeId: string) => {
    if (from === sideName && selection.length > 1 && !draggedGroupId(from, nodeId)) return undefined;
    const destination = faceAt(stageRef.current?.getPointerPosition());
    return !faceDisabled && destination && destination !== from && !project[destination].canvasLocked ? destination : undefined;
  };
  useImperativeHandle(navigationRef, () => ({
    fit: camera.fit,
    focusCard,
    captureView: id => {
      const view = camera.capture();
      const anchor = placements.find(face => face.cardId === id && face.slot === 'front');
      return view && anchor ? { ...view, x: view.x + anchor.x * view.scale, y: view.y + anchor.y * view.scale } : null;
    },
    pinView: () => camera.write(camera.read()),
    worldAt: screen => {
      const point = canvasPoint({ clientX: screen.x, clientY: screen.y });
      const view = camera.read();
      return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
    },
    hasPathDraft: () => Boolean(vectorRef.current || lineRef.current || pathEdit),
    zoomBy: factor => camera.zoomAt(factor, { x: size.width / 2, y: size.height / 2 }),
    editPath: beginPathEdit,
  }));
  const activeRegion = side.regions.find(item => item.id === regionId);
  const paintedRegion = useMemo(() => activeRegion && draftStroke
    ? { ...activeRegion, strokes: [...activeRegion.strokes, draftStroke] } : activeRegion,
  [activeRegion, draftStroke]);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let current = true;
    if ((!regionMode && !highlightRegion) || !paintedRegion) {
      setRegionImage(undefined);
      return;
    }
    if (!regionMode) setRegionImage(undefined);
    const activeEffect = !regionMode && side.effects.find(effect => effect.id === effectPreviewId);
    const maskPromise = activeEffect ? renderEffectMask(project,side,activeEffect)
      : renderRegionMask(project,side,paintedRegion,1,undefined,undefined,regionMode);
    maskPromise.then(mask => {
      const canvas = makeCanvas(mask.width, mask.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(mask, 0, 0);
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = '#55d7be';
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (current) setRegionImage({ image: canvas, includeBleed: regionMode });
    }).catch(() => {});
    return () => { current = false; };
  }, [project.widthMm, project.heightMm, project.bleedMm, side, paintedRegion, regionMode, highlightRegion,effectPreviewId]);

  useEffect(() => {
    let current = true;
    if (!plate) { setPlatePreview(undefined); return; }
    renderCard(project, sideName, { plate, layerId:layerPlate }).then(image => {
      if (current) setPlatePreview({ face: sideName, channel: plate, layer: layerPlate, image });
    }).catch(() => { if (current) setPlatePreview(undefined); });
    return () => { current = false; };
  }, [project, sideName, plate, layerPlate]);
  const plateImage = platePreview?.face === sideName && platePreview.channel === plate &&
    platePreview.layer === layerPlate ? platePreview.image : undefined;

  useEffect(() => {
    const transformer = transformerRef.current;
    const node = selectedId && stageRef.current?.findOne('#' + artworkId(sideName, selectedId));
    const selected = side.nodes.find(item => item.id === selectedId);
    const placement = finishedView && selected && placements.find(item => item.cardId === activeCardId && item.slot === sideName);
    const visibleInView = !finishedView || (placement && selected && hasFinishedArtwork(placement, artworkBounds(selected)));
    transformer?.nodes(node && selected && visibleInView && !overlayHidden && !pathTarget && !textNode && !activeGroup && selection.length <= 1 && selected.visible && !selected.locked && !regionMode && !highlightRegion && tool === 'select' && !plate && !flashOnly && !gradientNode && !radialEffect ? [node] : []);
    transformer?.getLayer()?.batchDraw();
  }, [sideName, selectedId, selection.length, currentSide.nodes, tool, regionMode, highlightRegion, plate, flashOnly, gradientNode, radialEffect, activeGroup, textNode, pathTarget, overlayHidden, finishedView, placements, activeCardId]);

  const cardPoint = (face: SideName = sideName) => {
    const position = stageRef.current?.getPointerPosition();
    if (!position) return null;
    return { x: (position.x - faceLeft(face)) / scale, y: (position.y - faceTop(face)) / scale };
  };
  const updateVector = (draft: VectorDraft | null) => { vectorRef.current = draft; setVectorDraft(draft); };
  const cancelDrawing = () => {
    updateVector(null); penHandle.current = null; lastPenClick.current = null;
    lineRef.current = null; setLineDraft(null);
    setVectorHover(null);
  };
  const finishVector = (closed = false) => {
    const draft = vectorRef.current;
    cancelDrawing();
    if (maskPenMode) {
      if (draft && draft.points.length >= 3) onMaskSelectionChange?.(draft.points);
      return;
    }
    if (!draft || draft.points.length < (closed ? 3 : 2)) return;
    onCreateVector(draft.face, vectorFromPoints(draft.points, 'path', closed));
  };
  const finishDrawingGesture = () => {
    penHandle.current = null;
    const line = lineRef.current;
    lineRef.current = null; setLineDraft(null);
    if (line && Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y) * scale >= 3) {
      onCreateVector(line.face, vectorFromPoints([line.start, line.end], 'line', false));
    }
  };
  function cancelBoardGesture() {
    const gesture = boardGesture.current;
    if (!gesture) return;
    boardGesture.current = null;
    gesture.detach();
    const element = holder.current;
    if (element?.hasPointerCapture(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId);
    setBoardDrag(null);
    setMarquee(null);
  }
  function cancelMaskMarquee() {
    const gesture = maskMarquee.current;
    if (!gesture) return;
    maskMarquee.current = null;
    gesture.detach();
    const element = holder.current;
    if (element?.hasPointerCapture(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId);
    setDraftMaskMarquee(null);
  }
  useEffect(() => () => boardGesture.current?.detach(), []);
  useEffect(() => () => maskMarquee.current?.detach(), []);
  useEffect(() => { cancelBoardGesture(); }, [project.id, tool, regionMode, faceDisabled, overlayHidden]);
  useEffect(() => { cancelMaskMarquee(); }, [project.id, activeCardId, sideName, tool, regionMode, regionId, finishedView, overlayHidden]);
  useEffect(() => { cancelDrawing(); }, [project.id, activeCardId, tool, regionMode, editingRegionId, plate]);
  useEffect(() => {
    if (vectorRef.current && vectorRef.current.face !== sideName) cancelDrawing();
  }, [sideName]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (rightMouse.isActive() && event.key === 'Escape') return;
      if (boardGesture.current && event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); cancelBoardGesture(); return;
      }
      if (!(event.target instanceof HTMLElement) || event.target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      if (regionMode && event.key === 'Escape' && (maskMarquee.current || maskPenMode && vectorRef.current || maskSelection)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (maskMarquee.current) cancelMaskMarquee();
        else if (maskPenMode && vectorRef.current) cancelDrawing();
        else onMaskSelectionChange?.(null);
        return;
      }
      if (maskPenMode && event.key === 'Enter' && vectorRef.current && !event.target.closest('button,[role="button"]')) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (vectorRef.current.points.length >= 3) finishVector(true);
        return;
      }
      if (pathEdit && pathTarget && !overlayHidden && ['Escape', 'Enter', 'Delete', 'Backspace'].includes(event.key)) {
        if (event.key === 'Enter' && event.target.closest('.path-node-actions button')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'Escape') setPathEdit(null);
        else if (event.key === 'Enter') finishPathEdit();
        else removePathAnchor();
        return;
      }
      if (!['pen', 'line'].includes(tool)) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); cancelDrawing();
      } else if (event.key === 'Enter' && tool === 'pen') {
        event.preventDefault(); event.stopPropagation(); finishVector();
      }
    };
    const blur = () => { cancelDrawing(); cancelBoardGesture(); cancelMaskMarquee(); };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', blur); };
  });
  const finishStroke = () => {
    if (currentStroke.current && activeRegion) onRegionChange({ ...activeRegion, strokes: [...activeRegion.strokes, currentStroke.current] });
    currentStroke.current = null;
    setDraftStroke(null);
    if (geometryRegion.current) onRegionChange(geometryRegion.current);
    geometryStart.current = null;
    geometryRegion.current = null;
  };
  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if (!(event.button === 1 || (event.button === 0 && handMode)) || cameraBusy(true)) return;
    if (event.target instanceof Element && (event.target.closest('button:not([data-face-label]),select,[role="menu"],[role="dialog"]') ||
      (event.button !== 1 && event.target.closest('[data-canvas-text-editor]')))) return;
    event.preventDefault();
    if (event.button === 0 && spaceHeld) onStartSpacePan();
    lastPenClick.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    panStart.current = { id: event.pointerId, pointer: { x: event.clientX, y: event.clientY }, camera: camera.read() };
    setPointer(null);
    setPanning(true);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const start = panStart.current;
    if (start?.id !== event.pointerId) return;
    const dx = event.clientX - start.pointer.x;
    const dy = event.clientY - start.pointer.y;
    const x = start.camera.x + dx, y = start.camera.y + dy;
    const previous = camera.read();
    if (x !== previous.x || y !== previous.y) camera.write({ ...start.camera, x, y });
  };
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    if (panStart.current?.id !== event.pointerId) return;
    panStart.current = null;
    setPanning(false);
  };
  useEffect(() => {
    const interruptPan = () => {
      const start = panStart.current;
      if (!start) return;
      panStart.current = null;
      const element = holder.current;
      if (element?.hasPointerCapture(start.id)) element.releasePointerCapture(start.id);
      setPanning(false);
    };
    const visibilityChanged = () => { if (document.hidden) { interruptPan(); cancelBoardGesture(); cancelMaskMarquee(); } };
    window.addEventListener('blur', interruptPan);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      window.removeEventListener('blur', interruptPan);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, []);
  const canvasPoint = (event: { clientX: number; clientY: number }) => {
    const bounds = holder.current!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const boardGesturesEnabled = tool === 'select' && !faceDisabled && !overlayHidden &&
    !textEdit && !pathTarget && !handMode && !sidebarDropFace;
  const doubleActivateArtwork = (face: SideName, id: string) => {
    boardArtworkClick.current = null;
    const node = project[face].nodes.find(item => item.id === id);
    if (!node?.visible || node.locked || project[face].canvasLocked) return;
    if (onDrillArtwork(face, id)) return;
    if (node.type === 'text') onTextEdit?.(face, id);
    else if (node.type === 'path' || node.type === 'line') beginPathEdit(face, id);
  };
  const startMaskMarquee = (event: PointerEvent<HTMLDivElement>) => {
    if (overlayHidden || !event.isPrimary || event.button !== 0 || cameraBusy() || !(event.target instanceof Element) ||
      !stageRef.current?.content.contains(event.target)) return;
    const screen = canvasPoint(event);
    const placement = placementAt(screen);
    if (placement?.cardId !== activeCardId || placement.slot !== sideName) return;
    const localPoint = (screen: Point) => clampMaskPoint({
      x: (screen.x - faceLeft(sideName)) / scale, y: (screen.y - faceTop(sideName)) / scale,
    });
    const pointerId = event.pointerId;
    const start = localPoint(screen);
    const pathAt = (event: globalThis.PointerEvent) => maskMarqueePath(start, localPoint(canvasPoint(event)), scale);
    const isGesture = (event: globalThis.PointerEvent) => maskMarquee.current?.pointerId === event.pointerId;
    const move = (event: globalThis.PointerEvent) => {
      if (!isGesture(event)) return;
      event.stopPropagation();
      setDraftMaskMarquee(pathAt(event));
    };
    const end = (event: globalThis.PointerEvent) => {
      if (!isGesture(event)) return;
      const selection = pathAt(event);
      event.stopPropagation();
      cancelMaskMarquee();
      onMaskSelectionChange?.(selection);
    };
    const cancel = (event: globalThis.PointerEvent) => {
      if (isGesture(event)) cancelMaskMarquee();
    };
    const detach = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', cancel, true);
    };
    event.preventDefault();
    event.stopPropagation();
    maskMarquee.current = { pointerId, detach };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', cancel, true);
    event.currentTarget.setPointerCapture(pointerId);
  };
  const startCanvasPointer = (event: PointerEvent<HTMLDivElement>) => {
    // Apply pending pan and stop wheel zoom before hit-testing the pointer press.
    if (camera.hasPending() && flushSync(camera.flush)) stageRef.current?.draw();
    if (event.button === 2) {
      if (cameraBusy(true) || event.pointerType !== 'mouse' || !(event.target instanceof Element)) return;
      if (event.target.closest('[data-canvas-text-editor]')) return;
      const label = event.target.closest<HTMLButtonElement>('button[data-face-label]');
      if (!label && !stageRef.current?.content.contains(event.target)) return;
      const at = canvasPoint(event);
      rightMouse.begin(event, screen => {
        if (label?.dataset.memberId) {
          if (!faceDisabled && !textEdit) {
            onFaceMenu(label.dataset.memberId, label.dataset.memberFace === 'back' ? 'back' : 'front', screen);
          }
        } else openCanvasMenuAt(at, screen);
      });
      return;
    }
    if (event.isPrimary && (event.button === 0 || event.button === 1) && event.target instanceof Element &&
      (event.target.closest('[data-face-label]') || stageRef.current?.content.contains(event.target))) releaseSidebarField();
    startPan(event);
    if (maskMarqueeMode && !handMode) { startMaskMarquee(event); return; }
    if (!event.isPrimary || event.pointerType === 'touch' || event.button !== 0 || !boardGesturesEnabled ||
      cameraBusy() || !(event.target instanceof Element)) return;
    const stage = stageRef.current;
    if (!stage) return;
    const label = event.target.closest<HTMLButtonElement>('button[data-face-label]');
    let board: CanvasFace | undefined, artworkId: string | undefined, mixedSelection: CanvasMarqueeSelection | undefined;
    if (label?.dataset.memberId) {
      board = { cardId: label.dataset.memberId, face: label.dataset.memberFace === 'back' ? 'back' : 'front' };
    } else {
      if (!stage.content.contains(event.target)) return;
      const point = canvasPoint(event);
      const hit = stage.getIntersection(point);
      const face = hit?.findAncestor('.canvas-member-face');
      if (face) board = { cardId: face.getAttr('memberId'), face: face.getAttr('faceSlot') };
      if (hit && hit.name() !== 'card-ground') {
        const art = hit.findAncestor('.artwork-node', true);
        if (!art || !board || directArtworkSelection(event)) return;
        const placement = placements.find(item => sameBoard(boardTarget(item), board!));
        if (!placement) return;
        const insideBoard = faceContainsPoint(placement, (point.x - origin.x) / scale, (point.y - origin.y) / scale);
        artworkId = art.getAttr('artworkNodeId') as string;
        const picked = canvasSelection?.layers.find(layers => sameBoard(layers, board!));
        if (!event.shiftKey && canvasSelection && (insideBoard && includesBoard(canvasSelection.boards, board) ||
          picked && artworkIdsOf(placement.project[placement.slot], picked.units).has(artworkId))) mixedSelection = canvasSelection;
        const selectingBoard = event.shiftKey && selectedBoards.length > 0;
        const movingBoards = includesBoard(selectedBoards, board);
        if (!mixedSelection && (!insideBoard || !selectingBoard && !movingBoards)) return;
      }
    }
    if (board && !artworkId && !event.shiftKey && !directArtworkSelection(event) &&
      canvasSelection && includesBoard(canvasSelection.boards, board)) mixedSelection = canvasSelection;
    if (!label) event.preventDefault();
    event.stopPropagation();
    boardArtworkClick.current = null;
    // A fast move can cross a drawer before the browser retargets to the captured element.
    const detach = () => {
      window.removeEventListener('pointermove', moveBoardPointer, true);
      window.removeEventListener('pointerup', endBoardPointer, true);
      window.removeEventListener('pointercancel', cancelBoardPointer, true);
    };
    boardGesture.current = {
      pointerId: event.pointerId, start: canvasPoint(event), detach, board, artworkId, additive: event.shiftKey,
      initialSelection: selectedBoards, mixedSelection, scale: camera.read().scale,
    };
    window.addEventListener('pointermove', moveBoardPointer, true);
    window.addEventListener('pointerup', endBoardPointer, true);
    window.addEventListener('pointercancel', cancelBoardPointer, true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const draggedBoards = (gesture: BoardGesture, board: CanvasFace) => includesBoard(gesture.initialSelection, board)
    ? gesture.initialSelection : gesture.additive ? [...gesture.initialSelection, board] : [board];
  const readBoardMovement = (gesture: BoardGesture, position: Point) => {
    const x = position.x - gesture.start.x, y = position.y - gesture.start.y;
    return Math.hypot(x, y) < boardDragThreshold ? null : { x: x / gesture.scale, y: y / gesture.scale };
  };
  const moveBoardPointer = (event: globalThis.PointerEvent) => {
    const gesture = boardGesture.current;
    if (gesture?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const position = canvasPoint(event);
    const delta = readBoardMovement(gesture, position);
    if (gesture.board) {
      const { mixedSelection } = gesture;
      const boards = mixedSelection?.boards ?? draggedBoards(gesture, gesture.board);
      setBoardDrag(delta && !boards.some(lockedBoard) ? { boards, delta, mixedSelection } : null);
    } else {
      setMarquee(delta ? marqueeBounds(gesture.start, position) : null);
    }
  };
  const endBoardPointer = (event: globalThis.PointerEvent) => {
    const gesture = boardGesture.current;
    if (gesture?.pointerId !== event.pointerId) return;
    const position = canvasPoint(event);
    const delta = readBoardMovement(gesture, position);
    if (delta) event.stopPropagation();
    cancelBoardGesture();
    if (gesture.board) {
      if (delta) {
        if (gesture.mixedSelection) {
          if (!gesture.mixedSelection.boards.some(lockedBoard)) {
            camera.write(camera.read());
            onMoveMarquee(gesture.mixedSelection, delta);
          }
          return;
        }
        const boards = draggedBoards(gesture, gesture.board);
        if (boards.some(lockedBoard)) return;
        camera.write(camera.read());
        onSelectBoards(boards);
        onMoveBoards(boards, delta);
      } else if (gesture.artworkId && !gesture.additive) {
        boardArtworkClick.current = { board: gesture.board, nodeId: gesture.artworkId, time: event.timeStamp };
        if (gesture.board.cardId !== activeCardId) onActivateMember(gesture.board.cardId, gesture.board.face, gesture.artworkId);
        else if (gesture.board.face !== sideName) onSelectFace(gesture.board.face, gesture.artworkId);
        else onSelect(gesture.artworkId);
      } else {
        onSelectBoards(gesture.additive ? toggleBoard(gesture.initialSelection, gesture.board) : [gesture.board]);
      }
      return;
    }
    if (delta) onSelectMarquee(marqueeSelection(marqueeBounds(gesture.start, position)), gesture.additive);
    else if (!gesture.additive) {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches('[data-face-label]') && holder.current?.contains(focused)) focused.blur();
      onSelectBoards([]);
    }
  };
  const cancelBoardPointer = (event: globalThis.PointerEvent) => {
    if (boardGesture.current?.pointerId === event.pointerId) cancelBoardGesture();
  };
  function marqueeSelection(box: ReturnType<typeof marqueeBounds>) {
    const view = camera.read();
    return hitCanvasMarquee(placements, { left: (box.left - view.x) / view.scale, top: (box.top - view.y) / view.scale,
      right: (box.right - view.x) / view.scale, bottom: (box.bottom - view.y) / view.scale },
    { activeFace: { cardId: activeCardId, face: sideName }, plate, flashOnly, hideBleed: finishedView });
  }
  const down = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (pathTarget || overlayHidden || handMode || panStart.current || rightMouse.isActive() || boardGesture.current || maskMarqueeMode ||
      ('button' in event.evt && event.evt.button !== 0)) return;
    const clicked = placementAt(stageRef.current?.getPointerPosition());
    if (maskPenMode && (!activeRegion || clicked?.cardId !== activeCardId || clicked.slot !== sideName)) return;
    if (clicked && clicked.cardId !== activeCardId) {
      if (!faceDisabled) onActivateMember(clicked.cardId, clicked.slot);
      return;
    }
    const point = cardPoint();
    if (!point) return;
    if ((!regionMode && !plate && ['line', 'pen'].includes(tool)) || maskPenMode) {
      const targetFace = maskPenMode ? sideName : vectorRef.current?.face ?? faceAt(stageRef.current?.getPointerPosition()) ?? sideName;
      if (!maskPenMode && (project[targetFace].canvasLocked || targetFace !== sideName && faceDisabled)) return;
      const position = maskPenMode ? clampMaskPoint(point) : cardPoint(targetFace)!;
      if (targetFace !== sideName) onSelectFace(targetFace);
      const additive = 'shiftKey' in event.evt && event.evt.shiftKey;
      if (tool === 'line') {
        const gesture = { face: targetFace, start: position, end: position };
        lineRef.current = gesture; setLineDraft(gesture);
        return;
      }
      const draft = vectorRef.current;
      if (draft && draft.points.length >= 3 && Math.hypot(position.x - draft.points[0].x, position.y - draft.points[0].y) * scale <= 9) {
        finishVector(true); return;
      }
      // Konva treats the entire card as one double-click target; a pen double-click
      // must also land at the same screen position, including for touch input.
      const screenPoint = stageRef.current!.getPointerPosition()!;
      const previousClick = lastPenClick.current;
      const now = performance.now();
      if (draft && draft.points.length >= (maskPenMode ? 3 : 2) && previousClick?.face === targetFace &&
        now - previousClick.time <= 450 && Math.hypot(screenPoint.x - previousClick.point.x, screenPoint.y - previousClick.point.y) <= 6) {
        finishVector(maskPenMode); return;
      }
      lastPenClick.current = { face: targetFace, point: { ...screenPoint }, time: now };
      const previous = draft?.points.at(-1);
      const snapped = previous ? snapAngle(previous, position, additive) : position;
      const next = maskPenMode ? clampMaskPoint(snapped) : snapped;
      if (previous && Math.hypot(next.x - previous.x, next.y - previous.y) * scale < 2) return;
      if ((draft?.points.length || 0) >= MAX_PATH_POINTS) { finishVector(maskPenMode); return; }
      if (maskPenMode && !draft && maskSelection) onMaskSelectionChange?.(null);
      const points = [...(draft?.points || []), next];
      updateVector({ face: targetFace, points }); penHandle.current = points.length - 1;
      setVectorHover(next);
      return;
    }
    if (regionMode && activeRegion && tool === 'geometry') {
      if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return;
      if (activeRegion.kind === 'polygon') {
        onRegionChange({ ...activeRegion, points: [...(activeRegion.points || []), point.x, point.y] });
      } else geometryStart.current = point;
      return;
    }
    if (regionMode && activeRegion && ['brush', 'eraser'].includes(tool)) {
      if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return;
      currentStroke.current = { points: [point.x, point.y], size: brushSize,
        erase: activeRegion.inverted ? tool !== 'eraser' : tool === 'eraser' };
      setDraftStroke(currentStroke.current);
      return;
    }
    if (event.target === event.target.getStage() || event.target.name() === 'card-ground') {
      const targetFace = faceAt(stageRef.current?.getPointerPosition());
      if (targetFace) {
        if (!faceDisabled) onSelectFace(targetFace);
      } else { onSelect(null); onSelectBoards([]); }
    }
  };
  const move = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (panStart.current || handMode) return;
    const shift = 'shiftKey' in event.evt && event.evt.shiftKey;
    if (lineRef.current) {
      const gesture = lineRef.current, point = cardPoint(gesture.face);
      if (point) { const next = { ...gesture, end: snapAngle(gesture.start, point, shift) }; lineRef.current = next; setLineDraft(next); }
      return;
    }
    if ((tool === 'pen' || maskPenMode) && vectorRef.current) {
      const draft = vectorRef.current, point = cardPoint(draft.face);
      if (!point) return;
      const last = draft.points.at(-1)!;
      const hover = snapAngle(last, point, shift);
      setVectorHover(maskPenMode ? clampMaskPoint(hover) : hover);
      if (penHandle.current !== null) {
        const index = penHandle.current, anchor = draft.points[index];
        const end = snapAngle(anchor, point, shift);
        if (Math.hypot(end.x - anchor.x, end.y - anchor.y) * scale > 3) {
          lastPenClick.current = null;
          const points = draft.points.map((item, i) => i === index ? { ...item,
            in: { x: 2 * anchor.x - end.x, y: 2 * anchor.y - end.y }, out: end } : item);
          updateVector({ ...draft, points });
        }
      }
      return;
    }
    if (!regionMode) return;
    const point = cardPoint();
    setPointer(point);
    if (point && geometryStart.current && activeRegion) {
      const start = geometryStart.current;
      const x = Math.max(0, Math.min(width, point.x));
      const y = Math.max(0, Math.min(height, point.y));
      const next = { ...activeRegion, bounds: {
        x: Math.min(start.x, x), y: Math.min(start.y, y),
        width: Math.max(1, Math.abs(start.x - x)), height: Math.max(1, Math.abs(start.y - y)), rotation: 0,
      } };
      geometryRegion.current = next;
      onRegionChange(next);
    }
    if (point && currentStroke.current) {
      currentStroke.current = { ...currentStroke.current, points: [...currentStroke.current.points, point.x, point.y] };
      setDraftStroke(currentStroke.current);
    }
  };
  const commitNode = (face: SideName, node: CardNode) => {
    setDragged(null); setSnap({});
    const currentSide = project[face];
    const previous = currentSide.nodes.find(item => item.id === node.id);
    if (!previous) return;
    if (currentSide.canvasLocked || previous.locked) {
      stageRef.current?.findOne('#' + artworkId(face, node.id))?.position(previous);
      return;
    }
    const translating = node.width === previous.width &&
      node.height === previous.height && node.rotation === previous.rotation;
    const delta = { x: node.x - previous.x, y: node.y - previous.y };
    if (translating && !delta.x && !delta.y) return;
    const groupId = draggedGroupId(face, node.id);
    if (groupId && translating) {
      const next = moveArtworkGroup(project, face, groupId, delta);
      if (next) onChange(next, face);
      else stageRef.current?.findOne('#' + artworkId(face, node.id))?.position(previous);
      return;
    }
    if (translating && face === sideName && selection.includes(node.id) && selectedUnits?.some(unit => unit.kind === 'group')) {
      const next = moveCanvasLayerUnits(project, face, selectedUnits, delta);
      if (next !== currentSide) onChange(next, face);
      else stageRef.current?.findOne('#' + artworkId(face, node.id))?.position(previous);
      return;
    }
    onChange({ ...currentSide, nodes: currentSide.nodes.map(item => {
      const isDragged = item.id === node.id;
      const selectedTogether = face === sideName && selection.includes(node.id) && selection.includes(item.id);
      if (!isDragged && !(selectedTogether && item.visible && !item.locked)) return item;
      if (translating && layoutParent(currentSide, item.id)) {
        return { ...item, layoutItem: offsetLayoutItem(item.layoutItem, delta) };
      }
      return isDragged ? node : { ...item, x: item.x + delta.x, y: item.y + delta.y };
    }) }, face);
  };
  const dragNode = (face: SideName, node: CardNode, bypass: boolean) => {
    const destination = dragDestination(face, node.id);
    const groupId = draggedGroupId(face, node.id);
    const target=destination??face;
    const from = faceOffset(face), to = faceOffset(target);
    const omit=new Set([node.id,...(face===sideName?selection:[]),...(groupId?groupMembers?.artworkIds??[]:[])]);
    const guides=bypass ? undefined : snapArtwork(artworkBounds({...node,x:node.x+from.x-to.x,y:node.y+from.y-to.y}),
      snapBounds[target].filter(item=>!omit.has(item.id)).map(item=>item.bounds),width,height,5/scale);
    node.x+=guides?.x.delta??0;node.y+=guides?.y.delta??0;
    stageRef.current?.findOne('#' + artworkId(face, node.id))?.position({ x: node.x, y: node.y });
    setDragged({face,node,destination});setSnap({x:guides?.x.line,y:guides?.y.line});

  };
  const dropNode = (face: SideName, node: CardNode, cancelled: boolean) => {
    const destination = cancelled ? undefined : dragDestination(face, node.id);
    if (!cancelled && !destination) {
      commitNode(face, node);
      return;
    }
    setDragged(null); setSnap({});
    const groupId = draggedGroupId(face, node.id);
    if (destination) {
      const original = project[face].nodes.find(item => item.id === node.id);
      if (original) stageRef.current?.findOne('#' + artworkId(face, node.id))?.position({x: original.x, y: original.y});
    }
    if (destination && !onTransferArtwork(face, destination, node.id, {
      x: node.x + faceOffset(face).x - faceOffset(destination).x,
      y: node.y + faceOffset(face).y - faceOffset(destination).y,
    }, groupId)) {
      if (groupId) {
        const original = project[face].nodes.find(item => item.id === node.id);
        if (original) stageRef.current?.findOne('#' + artworkId(face, node.id))?.position(original);
      } else commitNode(face, node);
    }
  };
  const dropTarget = dragged?.destination ?? sidebarDropFace;
  const snapFace = dragged?.destination ?? dragged?.face;
  const penCanClose = !!(vectorDraft && vectorDraft.points.length >= 3 && vectorHover &&
    Math.hypot(vectorHover.x - vectorDraft.points[0].x, vectorHover.y - vectorDraft.points[0].y) * scale <= 9);
  const vectorTool = !regionMode && ['line', 'pen'].includes(tool);
  const maskOutline = draftMaskMarquee ?? maskSelection;
  // Keep the source above the destination while Konva is still dragging the original node.
  const pendingSelection = marquee ? marqueeSelection(marquee) : undefined;
  const showingExistingSelection = !marquee || Boolean(boardGesture.current?.additive);
  const committedBoards = canvasSelection?.boards ?? selectedBoards;
  const highlightedBoards = boardDrag?.boards ?? [
    ...(showingExistingSelection ? committedBoards : []), ...(pendingSelection?.boards ?? []),
  ];
  const highlightedLayers = [
    ...(showingExistingSelection ? canvasSelection?.layers ?? [] : []), ...(pendingSelection?.layers ?? []),
  ];
  const showSelectionSize = !overlayHidden && !marquee && !pathTarget && !textNode && !regionMode;
  const faceSizeVisible = !finishedView && showSelectionSize && highlightedBoards.length === 1 && !highlightedLayers.length;
  const showLayerSize = showSelectionSize && !highlightedBoards.length && !canvasSelection && selectedUnits?.length === 1 &&
    tool === 'select' && !plate && !flashOnly && !currentSide.canvasLocked;
  const sizedLayers = showLayerSize ? side.nodes.filter(node => node.visible && !node.locked && selection.includes(node.id)) : [];
  const sizedLayersVisible = !finishedView || sizedLayers.some(node => hasFinishedArtwork(faceOffset(sideName), artworkBounds(node)));
  const layerSize = showLayerSize && sizedLayersVisible
    ? artworkSelectionSize(sizedLayers,
      Boolean(activeGroup), activeGroup && side.groups?.find(group => group.id === activeGroup.id)?.autoLayout)
    : undefined;
  const movedLayerViews = useMemo(() => {
    const moved = new Map<string, CardSide>();
    if (boardDrag?.mixedSelection) for (const layers of boardDrag.mixedSelection.layers) {
      if (includesBoard(boardDrag.boards, layers)) continue;
      const placement = placements.find(item => sameBoard(boardTarget(item), layers));
      if (placement) moved.set(canvasFaceKey(layers), moveCanvasLayerUnits(placement.project, placement.slot, layers.units, boardDrag.delta));
    }
    return moved;
  }, [boardDrag, placements]);
  const positionForBoard = (placement: CanvasFacePlacement) => {
    const delta = boardDrag && includesBoard(boardDrag.boards, boardTarget(placement)) ? boardDrag.delta : undefined;
    return { x: placement.x + (delta?.x ?? 0), y: placement.y + (delta?.y ?? 0) };
  };
  const visible = placements.filter(face => {
    if (face.cardId === activeCardId || movedLayerViews.has(canvasFaceKey(boardTarget(face)))) return true;
    const { content } = face;
    const { x, y } = positionForBoard(face);
    return origin.x + (x + content.right) * scale >= -64 && origin.x + (x + content.left) * scale <= size.width + 64 &&
      origin.y + (y + content.bottom) * scale >= -64 && origin.y + (y + content.top) * scale <= size.height + 64;
  });
  const restingOrder = [...visible.filter(face => face.cardId !== activeCardId),
    ...(dragged?.destination === 'back' ? [...activeFaces].reverse() : activeFaces)];
  const foregroundBoards = boardDrag?.boards ?? committedBoards;
  const onTop = (placement: CanvasFacePlacement) => includesBoard(foregroundBoards, boardTarget(placement));
  const drawOrder = [...restingOrder.filter(face => !onTop(face)), ...restingOrder.filter(onTop)];


  const openCanvasMenuAt = (at: Point, screen: Point) => {
    if (faceDisabled || textEdit || pathTarget || overlayHidden) return;
    const stage = stageRef.current;
    if (!stage) return;
    const shape = stage.getIntersection(at);
    const hit = shape?.findAncestor('.artwork-node', true);
    const surface = shape?.findAncestor('.canvas-member-face', true);
    const placement = surface ? placements.find(item => item.cardId === surface.getAttr('memberId') && item.slot === surface.getAttr('faceSlot')) : placementAt(at);
    const target = placement ? boardTarget(placement) : { cardId: activeCardId, face: sideName };
    const face = target.face;
    const contents = (placement?.project ?? project)[face];
    const hitId = hit?.getAttr('artworkNodeId') as string | undefined;
    const view = camera.read();
    const world = { x: (at.x - view.x) / view.scale, y: (at.y - view.y) / view.scale };
    if (placement && contents.canvasLocked) {
      onFaceMenu(placement.cardId, placement.slot, screen); return;
    }
    const picked = canvasSelection?.layers.find(layers => sameBoard(layers, target));
    const pickedLayer = hitId && picked && artworkIdsOf(contents, picked.units).has(hitId);
    if (placement && !pickedLayer && includesBoard(committedBoards, target) && faceContainsPoint(placement, world.x, world.y)) {
      onFaceMenu(placement.cardId, placement.slot, screen); return;
    }
    const layers = contents.nodes;
    let node = hitId ? layers.find(item => item.id === hitId) : undefined;
    // Locked artwork ignores normal pointer input, but its context menu must still allow unlocking.
    const active = target.cardId === activeCardId;
    const owner = placement ?? activeFaces.find(item => item.slot === face);
    const outsideTrim = finishedView && owner && !trimContainsPoint(owner, world.x, world.y);
    if (!(active && face === sideName && (plate || flashOnly))) {
      const context = stage.content.querySelector('canvas')?.getContext('2d');
      for (let i=layers.length-1; context && i>=0 && layers[i]!==node; i--) {
        const candidate=layers[i];
        if (!candidate.visible || candidate.type==='empty' || !candidate.locked) continue;
        if (outsideTrim && owner && artworkIntersectsFace(owner, artworkBounds(candidate))) continue;
        const id=artworkId(face,candidate.id);
        const shape=stage.findOne('#'+(active?id:target.cardId+'-'+id));
        if (!shape) continue;
        const local=shape.getAbsoluteTransform().copy().invert().point(at);
        const x=candidate.flipX?candidate.width-local.x:local.x, y=candidate.flipY?candidate.height-local.y:local.y;
        context.save(); context.resetTransform();
        context.lineWidth=Math.max(candidate.strokeWidth||0,8/view.scale);
        const path=artworkPath(candidate);
        const inside=isOpenVector(candidate)?context.isPointInStroke(path,x,y):context.isPointInPath(path,x,y,candidate.fillRule ?? 'nonzero');
        context.restore();
        if (inside) { node=candidate; break; }
      }
    }
    const offset = placement ?? faceOffset(face);
    const point = { x: world.x - offset.x, y: world.y - offset.y };
    if (placement && !node) onFaceMenu(placement.cardId, face, screen);
    else onCanvasMenu(target, point, screen, node?.id);
  };

  return <div ref={holder} className="editor-canvas" data-testid="editor-canvas"
    data-canvas-view={finishedView ? 'finished' : 'edit'}
    data-canvas-tool={tool} data-vector-points={vectorDraft?.points.length || 0}
    data-mask-selection-points={regionMode ? maskOutline?.length ?? 0 : undefined}
    data-path-edit={pathTarget?.id} data-path-points={pathTarget ? pathEdit?.points.length : undefined}
    data-drawing-face={vectorDraft?.face ?? lineDraft?.face}
    data-active-member={activeCardId} data-selected-count={selection.length}
    data-artwork-group={activeGroup?.id} data-group-locked={groupLocked || undefined}
    data-selected-board-count={committedBoards.length} data-moving-boards={Boolean(boardDrag) || undefined}
    onPointerDownCapture={startCanvasPointer} onPointerMove={movePan} onPointerUp={endPan}
    onPointerCancel={endPan} onLostPointerCapture={event => {
      endPan(event);
      if (maskMarquee.current?.pointerId === event.pointerId) cancelMaskMarquee();
    }}
    onDoubleClickCapture={event => {
      const click = boardArtworkClick.current;
      boardArtworkClick.current = null;
      if (!click || !boardGesturesEnabled || directArtworkSelection(event) || event.timeStamp - click.time > Konva.dblClickWindow ||
        click.board.cardId !== activeCardId || click.board.face !== sideName) return;
      const hit = stageRef.current?.getIntersection(canvasPoint(event))?.findAncestor('.artwork-node', true);
      if (hit?.id() !== artworkId(click.board.face, click.nodeId)) return;
      // The first click ran through the board gesture rather than Konva's click tracker.
      event.stopPropagation();
      doubleActivateArtwork(click.board.face, click.nodeId);
    }}
    style={{ width: '100%', height: '100%', minHeight: 100, position: 'relative', overflow: 'hidden',
      backgroundPosition: `${origin.x % 12}px ${origin.y % 12}px`,
      touchAction: 'none', cursor: panning || boardDrag ? 'grabbing' : handMode ? 'grab' : regionMode && ['brush', 'eraser'].includes(tool) ? 'none' : tool === 'geometry' || vectorTool || maskMarqueeMode || maskPenMode ? 'crosshair' : 'default' }}>
    <Stage ref={stageRef} width={size.width} height={size.height} onMouseDown={down} onTouchStart={down}
      onContextMenu={event => {
        event.evt.preventDefault();
        if (!cameraBusy()) openCanvasMenuAt(canvasPoint(event.evt), { x: event.evt.clientX, y: event.evt.clientY });
      }}
      onMouseMove={move} onTouchMove={move}
      onMouseUp={() => { finishStroke(); finishDrawingGesture(); }} onTouchEnd={() => { finishStroke(); finishDrawingGesture(); }}
      onTouchCancel={() => { finishStroke(); cancelDrawing(); }}
      onMouseLeave={() => { finishStroke(); finishDrawingGesture(); setPointer(null); setVectorHover(null); }}>
      <Layer imageSmoothingEnabled={scale < PIXEL_PREVIEW_SCALE}>
        {drawOrder.map(placement => {
          const { project: member, slot: face, role, guides: { bleed: bleedBounds, trim: trimBounds } } = placement;
          const active = placement.cardId === activeCardId;
          const editing = active && face === sideName;
          const facePlate = editing ? plate : undefined;
          const painting = editing && regionMode;
          const showMask = !overlayHidden && editing && (regionMode || highlightRegion);
          const original = member[face];
          const target = boardTarget(placement);
          const view = movedLayerViews.get(canvasFaceKey(target)) ?? (active ? views[face] : original);
          const highlightedArtwork = artworkIdsOf(original, highlightedLayers.filter(layers => sameBoard(layers, target)).flatMap(layers => layers.units));
          const { width, height } = trimBounds;
          const ground = facePlate ? '#ffffff' : stockGroundColor(member.material, getStockAppearance(member, original));
          const clipToBleed = (context: Konva.Context) => {
            context.beginPath();
            traceBleed(context, placement);
          };
          const clipToTrim = (context: Konva.Context) => {
            context.beginPath();
            traceTrim(context, placement);
          };
          const position = positionForBoard(placement);
          const screenX = origin.x + position.x * scale, screenY = origin.y + position.y * scale;
          return <CanvasFaceSurface key={placement.cardId + ':' + face} placement={placement} side={view}
            finishedView={finishedView} flashOnly={editing && flashOnly} x={screenX} y={screenY} scale={scale}>
            {composite => <>
            <Group clipFunc={finishedView ? clipToTrim : undefined}>
            <Rect name="card-ground" {...bleedBounds} fill={ground}
              shadowColor="#000000" shadowOpacity={0.28} shadowBlur={34 / scale} shadowOffsetY={14 / scale} />
            {composite.whiteStock && !facePlate && <Group clipFunc={clipToBleed} listening={false}>
              <KonvaImage image={composite.whiteStock} x={bleedBounds.x} y={bleedBounds.y}
                width={bleedBounds.width} height={bleedBounds.height} />
            </Group>}
            {composite.stock && !painting && !facePlate && <KonvaImage name="stock-reflection" image={composite.stock.canvas}
              x={bleedBounds.x} y={bleedBounds.y} width={bleedBounds.width} height={bleedBounds.height}
              opacity={composite.stock.opacity} globalCompositeOperation={composite.stock.blend} listening={false} />}
            </Group>
            {!facePlate && original.nodes.map((node, index) => {
              const clipArtwork = composite.cardArtworkIds?.has(node.id);
              return <Group key={node.id} clipFunc={clipArtwork ? clipToTrim : undefined}>
                <ArtworkNode face={face}
                  passiveId={active ? undefined : placement.cardId}
                  node={active && dragged?.face === face && dragged.node.id === node.id ? node : view.nodes[index]}
                  outsideTrim={composite.clipped && (!finishedView || clipArtwork) ? trimBounds : undefined}
                  interactive={!original.canvasLocked && tool === 'select' && !pathTarget && !overlayHidden && !regionMode && !handMode && !panning && !(editing && flashOnly) && (editing || !faceDisabled)}
                  canDrag={!(active && textEdit?.face === face && textNode?.id === node.id) &&
                    !(editing && groupLocked && groupMembers?.artworkIds.includes(node.id))}
                  onSelect={(additive, direct) => {
                    if (editing) {
                      const selectedWithOthers = groupMembers?.artworkIds.includes(node.id) || selection.length > 1 && selection.includes(node.id);
                      if (direct || additive || !selectedWithOthers) onSelect(node.id, additive, direct);
                    } else if (active) onSelectFace(face, node.id, direct);
                    else onActivateMember(placement.cardId, face, node.id, direct);
                  }}
                  onCommit={value => commitNode(face, value)} onDrag={(value,bypass) => dragNode(face,value,bypass)}
                  onDrop={(value, cancelled) => dropNode(face, value, cancelled)}
                  onTransformPreview={value => setDragged({ face, node: value })}
                  onDoubleActivate={() => { if (active) doubleActivateArtwork(face, node.id); }} />
              </Group>;
            })}
            <Group clipFunc={finishedView ? clipToTrim : clipToBleed}>
              {!facePlate && composite.clipped && <KonvaImage image={composite.clipped} width={width} height={height} listening={false} />}
              {composite.effects && !painting && !facePlate && <KonvaImage image={composite.effects} width={width} height={height} listening={false} />}
              {facePlate && plateImage && <KonvaImage image={plateImage} width={width} height={height} listening={false} />}
              {!overlayHidden && painting && <Rect width={width} height={height} fill="#000000" opacity={.3} listening={false} />}
              {!overlayHidden && painting && activeRegion?.kind === 'polygon' && activeRegion.points?.map((value, i, points) =>
                i % 2 === 0 ? <Ellipse key={i} x={value} y={points[i+1]} radiusX={3 / scale} radiusY={3 / scale}
                  fill={EDITOR_FOCUS} stroke={EDITOR_BLUE} strokeWidth={1 / scale} listening={false}/> : null)}
              {showMask && regionImage && <KonvaImage image={regionImage.image}
                x={regionImage.includeBleed ? bleedBounds.x : 0} y={regionImage.includeBleed ? bleedBounds.y : 0}
                width={regionImage.includeBleed ? bleedBounds.width : width} height={regionImage.includeBleed ? bleedBounds.height : height}
                opacity={painting ? .65 : .32} listening={false} />}
            </Group>
            {!overlayHidden && !pathTarget && !facePlate && original.nodes.filter(node => node.visible && !node.locked &&
              !(textEdit?.face === face && textNode?.id === node.id) && (highlightedArtwork.has(node.id) ||
                showingExistingSelection && editing && (groupMembers?.artworkIds.includes(node.id) ||
                  (selection.length > 1 || marquee) && selection.includes(node.id))))
              .map(node => {
                const shown = view.nodes.find(item => item.id === node.id) || node;
                if (finishedView && !hasFinishedArtwork(placement, artworkBounds(shown))) return null;
                return <Rect key={'selection-' + node.id} x={shown.x} y={shown.y} width={shown.width} height={shown.height}
                  rotation={shown.rotation} stroke={EDITOR_BLUE} strokeWidth={1 / scale} listening={false}/>;
              })}
            {!overlayHidden && painting && maskOutline && <Group clipFunc={finishedView ? clipToTrim : clipToBleed} listening={false}>
              <Shape sceneFunc={context => {
                const raw = context._context;
                raw.save();
                raw.beginPath(); traceVectorPath(raw, maskOutline, 1, 1, true);
                raw.fillStyle = 'rgba(35,122,194,.18)'; raw.fill('evenodd');
                raw.strokeStyle = EDITOR_FOCUS; raw.lineWidth = 1.5 / scale;
                raw.setLineDash([5 / scale, 3 / scale]); raw.stroke();
                raw.restore();
              }}/>
            </Group>}
            {active && !overlayHidden && lineDraft?.face === face && <Group listening={false}>
              <Line points={[lineDraft.start.x, lineDraft.start.y, lineDraft.end.x, lineDraft.end.y]}
                stroke={EDITOR_FOCUS} strokeWidth={1.5 / scale} lineCap="round"/>
              {[lineDraft.start, lineDraft.end].map((point, index) => <Rect key={index}
                x={point.x - 3 / scale} y={point.y - 3 / scale} width={6 / scale} height={6 / scale}
                fill="#ffffff" stroke={EDITOR_BLUE} strokeWidth={1 / scale}/>)}
            </Group>}
            {active && !overlayHidden && vectorDraft?.face === face && <Group listening={false}>
              <Shape sceneFunc={context => {
                const raw = context._context;
                const points = vectorHover && penHandle.current === null ? [...vectorDraft.points, vectorHover] : vectorDraft.points;
                raw.beginPath(); traceVectorPath(raw, points, 1, 1);
                raw.strokeStyle = EDITOR_FOCUS; raw.lineWidth = 1.5 / scale; raw.lineJoin = 'round'; raw.stroke();
              }}/>
              {vectorDraft.points.map((point, index) => <Group key={index}>
                {[point.in, point.out].map((handle, handleIndex) => handle && <Group key={handleIndex}>
                  <Line points={[point.x, point.y, handle.x, handle.y]} stroke="#a3a3a3" strokeWidth={1 / scale}/>
                  <Circle x={handle.x} y={handle.y} radius={2.8 / scale} fill="#ffffff" stroke={EDITOR_BLUE} strokeWidth={1 / scale}/>
                </Group>)}
                {index === 0 && penCanClose && <Circle x={point.x} y={point.y} radius={7 / scale}
                  stroke={EDITOR_FOCUS} strokeWidth={1.3 / scale} fill="rgba(35,122,194,.16)"/>}
                <Rect x={point.x - 3 / scale} y={point.y - 3 / scale} width={6 / scale} height={6 / scale}
                  fill={index === vectorDraft.points.length - 1 ? EDITOR_FOCUS : '#ffffff'} stroke={EDITOR_BLUE} strokeWidth={1 / scale}/>
              </Group>)}
            </Group>}
            {!finishedView && !overlayHidden && !showGuides && <Rect name="card-frame" {...bleedBounds}
              stroke="rgba(220,220,220,.5)" strokeWidth={1 / scale} listening={false} />}
            {!finishedView && !overlayHidden && showGuides && <PrintGuideLines project={member} face={role} scale={scale} />}
            {active && !overlayHidden && snapFace === face && snap.x !== undefined && <Line points={[snap.x, -30, snap.x, height + 30]} stroke={EDITOR_FOCUS} strokeWidth={1 / scale} listening={false} />}
            {active && !overlayHidden && snapFace === face && snap.y !== undefined && <Line points={[-30, snap.y, width + 30, snap.y]} stroke={EDITOR_FOCUS} strokeWidth={1 / scale} listening={false} />}
            {!overlayHidden && !pathTarget && editing && <Transformer ref={transformerRef} rotateEnabled={!regionMode} flipEnabled={false} keepRatio={false} listening={!handMode && !panning}
              borderStroke={EDITOR_BLUE} anchorStroke={EDITOR_BLUE} anchorFill="#ffffff" anchorSize={7}
              anchorCornerRadius={2} borderStrokeWidth={1} rotateAnchorOffset={24}
              onTransformStart={() => { resizeGesture.current = { proportional: false }; }}
              onTransformEnd={() => { resizeGesture.current = null; }}
              anchorDragBoundFunc={(_previous, next, event) => {
                if (resizeGesture.current) resizeGesture.current.proportional = event?.shiftKey === true;
                return next;
              }}
              boundBoxFunc={(oldBox, newBox) => {
                const selected = currentSide.nodes.find(node => node.id === selectedId);
                const openVector = selected?.type === 'line' || selected?.type === 'path';
                let minWidth = openVector ? .1 : 10;
                let minHeight = minWidth;
                const gesture = resizeGesture.current;
                if (gesture) gesture.start ??= { width: oldBox.width, height: oldBox.height };
                const anchor = transformerRef.current?.getActiveAnchor();
                const start = gesture?.proportional && anchor !== 'rotater' ? gesture.start : undefined;
                if (start && start.width > 0 && start.height > 0) {
                  // Konva constrains corners. A side handle also expands about the perpendicular midpoint.
                  const ratio = start.width / start.height;
                  const horizontal = anchor === 'middle-left' || anchor === 'middle-right';
                  const vertical = anchor === 'top-center' || anchor === 'bottom-center';
                  if (horizontal || vertical) {
                    const width = vertical ? Math.abs(newBox.height) * ratio : newBox.width;
                    const height = horizontal ? Math.abs(newBox.width) / ratio : newBox.height;
                    const dx = (newBox.width - width) / 2, dy = (newBox.height - height) / 2;
                    const cos = Math.cos(newBox.rotation), sin = Math.sin(newBox.rotation);
                    newBox = { ...newBox, width, height,
                      x: newBox.x + dx * cos - dy * sin, y: newBox.y + dx * sin + dy * cos };
                  }
                  if (selected && selected.width > 0 && selected.height > 0) {
                    const minimumNodeSize = openVector ? 1 : 8;
                    minWidth = Math.max(minWidth, minimumNodeSize * start.width / selected.width);
                    minHeight = Math.max(minHeight, minimumNodeSize * start.height / selected.height);
                  }
                }
                return Math.abs(newBox.width) < minWidth || Math.abs(newBox.height) < minHeight ? oldBox : newBox;
              }} />}
            {!overlayHidden && editing && gradientNode?.gradient && !handMode && !panning && onGradientChange && <GradientHandles
              node={{ ...gradientNode, gradient: gradientNode.gradient }} scale={scale}
              onStart={onGradientStart} onChange={onGradientChange}/>}
            {!overlayHidden && editing && handleTarget && radialEffect?.kind === 'radial-blur' && !handMode && !panning && onRadialCenterChange && <RadialCenterHandle
              node={handleTarget} center={radialEffect.center} scale={scale} onStart={onGradientStart}
              onChange={center => onRadialCenterChange(radialEffect.id, center)}/>}
            {active && !overlayHidden && pathEdit?.face === face && pathTarget && <PathNodes draft={pathEdit} node={pathTarget} scale={scale}
              interactive={!handMode && !panning}
              onSelect={selected => updatePath(draft => ({ ...draft, selected }))}
              onMove={(index, position, handle) => updatePath(draft => ({ ...draft, selected: index, dirty: true,
                points: draft.points.map((point, at) => at === index ? movePathPoint(point, position, handle) : point),
              }))}
              onInsert={index => updatePath(draft => editPathSegment(draft, index))}/>}
            {!overlayHidden && !handMode && !panning && painting && pointer && ['brush', 'eraser'].includes(tool) && <Ellipse
              x={pointer.x} y={pointer.y} radiusX={brushSize / 2} radiusY={brushSize / 2}
              stroke={tool === 'eraser' ? '#ffb19d' : '#ffffff'} strokeWidth={1.5 / scale}
              fill="rgba(255,255,255,.08)" listening={false} />}
            </>}
          </CanvasFaceSurface>;
        })}
      </Layer>
    </Stage>
    {layerSize && <SelectionSize kind="layer" x={faceLeft(sideName) + layerSize.x * scale}
      y={faceTop(sideName) + layerSize.y * scale} widthMm={layerSize.widthMm} heightMm={layerSize.heightMm}/>}
    {textNode && textEdit && <CanvasTextEditor key={`${project.id}:${activeCardId}:${textEdit.face}:${textNode.id}`}
      node={textNode} face={textEdit.face} scale={scale} showOutline={!finishedView}
      left={faceLeft(textEdit.face) + textNode.x * scale} top={faceTop(textEdit.face) + textNode.y * scale}
      onDraft={content => setTextDraft({ ...textEdit, content })}
      onCommit={content => onTextCommit?.(textEdit.face, textNode.id, content)} onCancel={() => onTextCancel?.()}/>}
    {!overlayHidden && pathEdit && pathTarget && <PathNodeActions draft={pathEdit}
      onOutline={index=>updatePath(draft=>{
        if(!draft.outlines?.[index])return draft;
        const outlines=draft.outlines.map((p,i)=>i===draft.activeOutline?draft.points:p);
        return {...draft,outlines,activeOutline:index,points:outlines[index],selected:null};
      })}
      onAdd={() => updatePath(draft => editPathSegment(draft, splitSegmentIndex(draft)))}
      onRemove={removePathAnchor}
      onCorner={() => changeAnchor((points, index) => points.map((point, at) => at === index ? { x: point.x, y: point.y } : point))}
      onSmooth={() => changeAnchor((points, index, closed) => points.map((point, at) => at === index ? smoothPathPoint(points, index, closed) : point))}
      onToggle={() => updatePath(draft => ({ ...draft, closed: !draft.closed, dirty: true }))}
      onApply={finishPathEdit} onCancel={() => setPathEdit(null)}/>}
    {!overlayHidden && vectorTool && !handMode && <div className="canvas-tool-hint" role="status" aria-live="polite">
      <strong>{tool === 'pen' ? penCanClose ? '闭合路径' : vectorDraft ? `钢笔 · ${vectorDraft.points.length} 个节点` : '钢笔' : '直线'}</strong>
      <span>{tool === 'pen' ? '单击添加节点 · 拖动设置曲线 · Enter 完成 · Esc 取消' :
        '拖动绘制 · Shift 锁定角度 · Esc 取消'}</span>
    </div>}
    {visible.map(placement => {
      const { cardId, slot: face, role, guides: { bleed: bleedBounds, trim } } = placement;
      const active = cardId === activeCardId;
      const editing = active && face === sideName;
      const position = positionForBoard(placement);
      const target = boardTarget(placement);
      const marked = !overlayHidden && includesBoard(highlightedBoards, target);
      const pressed = marked || (!overlayHidden && (highlightedLayers.some(layers => sameBoard(layers, target)) ||
        showingExistingSelection && !highlightedBoards.length && hasLayerSelection && editing));
      const left = origin.x + position.x * scale, top = origin.y + position.y * scale;
      const boardLeft = left + bleedBounds.x * scale, boardTop = top + bleedBounds.y * scale;
      const label = role === 'front' ? '正面' : '背面';
      const labelOnScreen = boardLeft >= 0 && boardLeft + 38 <= size.width && boardTop >= 24 && boardTop <= size.height;
      return <Fragment key={cardId + ':' + face}>
        <div data-member-id={cardId} data-member-face={face} data-card-artboard={face} data-board-space="bleed"
          data-selected-board={marked || undefined}
          data-drop-target={active && dropTarget === face ? true : undefined} aria-hidden="true"
          style={{ position: 'absolute', pointerEvents: 'none', left: boardLeft, top: boardTop,
            width: bleedBounds.width * scale, height: bleedBounds.height * scale, borderRadius: bleedBounds.cornerRadius * scale }} />
        <div ref={editing ? cardBoundsRef : undefined} data-card-bounds={editing ? true : undefined} data-card-face={active ? face : undefined}
          data-card-trim={face} aria-hidden="true"
          style={{ position: 'absolute', pointerEvents: 'none', left, top, width: trim.width * scale, height: trim.height * scale, borderRadius: trim.cornerRadius * scale }}>
          {marked && !finishedView && <div className="canvas-face-selection">
            {FACE_CORNERS.map(corner => <span key={corner} className="canvas-face-selection-corner" data-corner={corner}/>)}
          </div>}
        </div>
        {marked && faceSizeVisible && <SelectionSize kind="face" x={left + trim.width * scale / 2}
          y={top + trim.height * scale} widthMm={placement.project.widthMm} heightMm={placement.project.heightMm}/>}
        <button type="button" className="canvas-face-label" data-member-id={cardId} data-member-face={face} data-face-label={face} data-selected-board={marked || undefined} aria-pressed={pressed} title={placement.project.cardName + " · " + label + (placement.project[face].canvasLocked ? ' · 已锁定' : '')}
          data-drop-target={active && dropTarget === face ? true : undefined}
          disabled={faceDisabled && !editing} tabIndex={labelOnScreen ? 0 : -1} style={{ left: boardLeft, top: boardTop }}
          onContextMenu={event => {
            event.preventDefault();
            if (!faceDisabled) onFaceMenu(cardId, face, { x: event.clientX, y: event.clientY });
          }}
          onKeyDown={event => {
            if (faceDisabled || !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onFaceMenu(cardId, face, { x: rect.left, y: rect.bottom });
          }}
          onClick={event => {
            if (faceDisabled) return;
            if (!event.detail || !boardGesturesEnabled || event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === 'touch') {
              onSelectBoards(event.shiftKey ? toggleBoard(selectedBoards, target) : [target]);
            }
          }}>{label}</button>
      </Fragment>;
    })}
    {marquee && <div className="canvas-board-marquee" aria-hidden="true" style={{
      left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top,
    }}/>}
  </div>;
}
