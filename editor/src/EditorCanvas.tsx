import { Fragment, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent, type Ref } from 'react';
import { Stage, Layer, Group, Rect, Circle, Ellipse, Shape, Image as KonvaImage, Line, Transformer } from 'react-konva';
import Konva from 'konva';
import { PrintGuideLines, printGuideBounds } from './PrintGuides';
import { processKind, type CardNode, type CardSide, type GradientPoint, type LayerGradient, type PathPoint, type Project, type Region, type SideName, type Stroke } from './model';
import { applyAutoLayout, layoutParent } from './autoLayout';
import { artworkPath, loadImage, makeCanvas, drawArtwork, renderCard, renderEffectMask, renderEffects, renderRegionMask, renderStockReflection, renderStockWhiteMask } from './render';
import { isTransparentStock } from './stockMaterials';
import { getStockAppearance, stockGroundColor } from './stockOptics';
import { activeImageFill, fillType, gradientAngle, gradientPoints, hasFill, hasStroke } from './layerAppearance';
import { isOpenVector, MAX_PATH_POINTS, traceVectorPath } from './vectorPaths';
import { findLayerGroup, layerGroupMembers } from './layerGroups';
import { moveArtworkGroup } from './transferLayer';
import CanvasTextEditor, { expandedTextDraft } from './CanvasTextEditor';
import './editor-canvas.css';

type Point = { x: number; y: number };
type Camera = Point & { scale: number; fitScale: number };
const MIN_ZOOM = .1;
const MAX_ZOOM = 32;
const FACES = ['front', 'back'] as const;
const EDITOR_BLUE = '#237ac2';
const EDITOR_FOCUS = '#69b5f6';
export const ZOOM_STEP = 1.2;
export type EditorTool = 'select' | 'hand' | 'brush' | 'eraser' | 'geometry' | 'line' | 'pen';
export type CreatedVector = Pick<CardNode, 'x' | 'y' | 'width' | 'height' | 'pathPoints' | 'pathClosed'> & { type: 'line' | 'path' };
type VectorDraft = { face: SideName; points: PathPoint[] };
type LineGesture = { face: SideName; start: Point; end: Point };

function vectorFromPoints(points: PathPoint[], type: 'line' | 'path', closed: boolean): CreatedVector {
  const positions = points.flatMap(point => [point, ...(point.in ? [point.in] : []), ...(point.out ? [point.out] : [])]);
  const x = Math.min(...positions.map(point => point.x));
  const y = Math.min(...positions.map(point => point.y));
  const width = Math.max(1, Math.max(...positions.map(point => point.x)) - x);
  const height = Math.max(1, Math.max(...positions.map(point => point.y)) - y);
  const normalize = (point: Point) => ({ x: (point.x - x) / width, y: (point.y - y) / height });
  return { type, x, y, width, height, pathClosed: closed,
    pathPoints: points.map(point => ({ ...normalize(point),
      ...(point.in ? { in: normalize(point.in) } : {}), ...(point.out ? { out: normalize(point.out) } : {}) })) };
}

function snapAngle(start: Point, end: Point, enabled: boolean): Point {
  if (!enabled) return end;
  const angle = Math.round(Math.atan2(end.y - start.y, end.x - start.x) / (Math.PI / 4)) * Math.PI / 4;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  return { x: start.x + Math.cos(angle) * distance, y: start.y + Math.sin(angle) * distance };
}

export interface CanvasNavigation {
  fit: () => void;
  zoomBy: (factor: number) => void;
}

export interface EditorCanvasProps {
  project: Project;
  side: SideName;
  selectedId: string | null;
  selectedIds?: string[];
  artworkGroupId?: string;
  onSelect: (id: string | null, additive?: boolean) => void;
  onCanvasMenu: (face: SideName, point: Point, screen: Point, nodeId?: string) => void;
  onSelectFace: (face: SideName, nodeId?: string) => void;
  onTransferArtwork: (from: SideName, to: SideName, id: string, position: Point, groupId?: string) => boolean;
  sidebarDropFace?: SideName;
  faceLocked?: boolean;
  onChange: (side: CardSide, face: SideName) => void;
  tool: EditorTool;
  onCreateVector: (face: SideName, vector: CreatedVector) => void;
  spaceHeld: boolean;
  navigationRef: Ref<CanvasNavigation>;
  showGuides: boolean;
  regionId: string | null;
  regionMode: boolean;
  highlightRegion?: boolean;
  onRegionChange: (region: Region) => void;
  textEdit?: { face: SideName; id: string };
  onTextEdit?: (face: SideName, id: string) => void;
  onTextCommit?: (face: SideName, id: string, text: string) => void;
  onTextCancel?: () => void;
  plate?: string | null;
  flashOnly?: boolean;
  brushSize?: number;
  layerPlate?: string;
  effectPreviewId?: string;
  editGradient?: boolean;
  onGradientChange?: (gradient: LayerGradient) => void;
  onGradientStart?: () => void;
  cardBoundsRef: Ref<HTMLDivElement>;
}

function artworkId(face: SideName, nodeId: string) {
  return `${face}-artwork-${nodeId}`;
}

function ArtworkNode({ node, face, interactive, outsideTrim, canDrag = true, onSelect, onCommit, onDrag, onDrop, onTransformPreview, onTextEdit }: {
  node: CardNode; face: SideName; interactive: boolean; onSelect: (additive: boolean) => void;
  outsideTrim?: { width: number; height: number };
  canDrag?: boolean;
  onCommit: (node: CardNode) => void; onDrag: (node: CardNode) => void;
  onDrop: (node: CardNode, cancelled: boolean) => void;
  onTransformPreview: (node: CardNode) => void;
  onTextEdit?: () => void;
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
    id: artworkId(face, node.id), name: 'artwork-node', x: node.x, y: node.y,
    width: node.width, height: node.height, rotation: node.rotation,
    opacity: node.opacity, visible: node.visible,
    draggable: interactive && !node.locked && canDrag, listening: interactive && !node.locked,
    stroke: hasStroke(node) ? node.stroke : undefined,
    strokeWidth: (node.strokeWidth || 0) * (isOpenVector(node) ? 1 : node.strokeAlign === 'outside' ? 2 : node.strokeAlign === 'inside' ? 0 : 1),
    globalCompositeOperation: (node.blend || 'source-over') as GlobalCompositeOperation,
    onMouseDown: (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (event.evt.button !== 0) return;
      event.cancelBubble = true; onSelect(event.evt.shiftKey);
    },
    onTouchStart: (event: Konva.KonvaEventObject<TouchEvent>) => { event.cancelBubble = true; onSelect(false); },
    onDblClick: () => onTextEdit?.(),
    onDblTap: () => onTextEdit?.(),
    onDragMove: (event: Konva.KonvaEventObject<DragEvent>) => onDrag({ ...node, x: event.target.x(), y: event.target.y() }),
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
      const visible = new Path2D();
      visible.rect(-padding, -padding, node.width + padding * 2, node.height + padding * 2);
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
      if (!isOpenVector(node)) raw.fill(path);
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
        onChange({ ...node.gradient, angle: gradientAngle(canonical),
          endpoints: [[start[0] / node.width, start[1] / node.height], [end[0] / node.width, end[1] / node.height]] });
      }}/>)}
  </Group>;
}

function useFaceArtwork(project: Project, face: SideName, side: CardSide, flashOnly = false) {
  const [clipped, setClipped] = useState<HTMLCanvasElement>();
  const [effects, setEffects] = useState<HTMLCanvasElement>();
  const [stock, setStock] = useState<Awaited<ReturnType<typeof renderStockReflection>>>();
  const [whiteStock, setWhiteStock] = useState<HTMLCanvasElement>();
  const hasClips = side.nodes.some(node => node.type !== 'empty' && node.clipRegionId && node.visible);
  useEffect(() => {
    if (!hasClips) { setClipped(undefined); return; }
    let current = true;
    renderCard({ ...project, [face]: side }, face, { effects: false, transparentGround: true })
      .then(canvas => { if (current) setClipped(canvas); })
      .catch(() => { if (current) setClipped(undefined); });
    return () => { current = false; };
  }, [hasClips, side, face, project.widthMm, project.heightMm]);
  useEffect(() => {
    let current = true;
    const effectSide = flashOnly ? { ...side, effects: side.effects.filter(effect => processKind(effect) === 'reflection') } : side;
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
  return { clipped: hasClips ? clipped : undefined, effects, stock: flashOnly ? undefined : stock,
    whiteStock: !flashOnly && isTransparentStock(project.material) ? whiteStock : undefined };
}

function previewDrag(project: Project, face: SideName, dragged?: CardNode, selectedIds: readonly string[] = [], groupId?: string,
  destination?: SideName,
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
  return { ...side, nodes: side.nodes.map(node => {
    if (node.id === dragged.id) return dragged;
    return original && selectedIds.includes(original.id) && selectedIds.includes(node.id) && node.visible && !node.locked
      ? { ...node, x: node.x + dragged.x - original.x, y: node.y + dragged.y - original.y } : node;
  }) };
}

function previewText(side: CardSide, draft?: CardNode): CardSide {
  if (!draft) return side;
  const view = { ...side, nodes: side.nodes.map(node => node.id === draft.id ? draft : node) };
  return layoutParent(side, draft.id) ? applyAutoLayout(view) : view;
}

export default function EditorCanvas({ project, side: sideName, selectedId, selectedIds, artworkGroupId, onSelect, onCanvasMenu, onSelectFace, onTransferArtwork, sidebarDropFace, faceLocked, onChange,
  tool, onCreateVector, spaceHeld, navigationRef, showGuides, regionId, regionMode, highlightRegion, onRegionChange, textEdit, onTextEdit, onTextCommit, onTextCancel, plate, flashOnly,
  brushSize = 30, layerPlate, effectPreviewId, editGradient, onGradientChange, onGradientStart, cardBoundsRef }: EditorCanvasProps) {
  const holder = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [size, setSize] = useState({ width: 600, height: 700 });
  const [manualCamera, setManualCamera] = useState<Camera | null>(null);
  const [panning, setPanning] = useState(false);
  const [dragged, setDragged] = useState<{ face: SideName; node: CardNode; destination?: SideName } | null>(null);
  const [snap, setSnap] = useState({ x: false, y: false });
  const [regionImage, setRegionImage] = useState<HTMLCanvasElement>();
  const [platePreview, setPlatePreview] = useState<{ face: SideName; channel: string; layer?: string; image: HTMLCanvasElement }>();
  const [draftStroke, setDraftStroke] = useState<Stroke | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const panStart = useRef<{ id: number; pointer: Point; camera: Camera } | null>(null);
  const currentStroke = useRef<Stroke | null>(null);
  const geometryStart = useRef<{ x: number; y: number } | null>(null);
  const geometryRegion = useRef<Region | null>(null);
  const [vectorDraft, setVectorDraft] = useState<VectorDraft | null>(null);
  const vectorRef = useRef<VectorDraft | null>(null);
  const penHandle = useRef<number | null>(null);
  const lastPenClick = useRef<{ face: SideName; point: Point; time: number } | null>(null);
  const [lineDraft, setLineDraft] = useState<LineGesture | null>(null);
  const lineRef = useRef<LineGesture | null>(null);
  const [vectorHover, setVectorHover] = useState<Point | null>(null);
  const [textDraft, setTextDraft] = useState<{ face: SideName; id: string; text: string }>();
  const [fontsReady, setFontsReady] = useState(false);
  const selection = useMemo(() => selectedIds?.length ? selectedIds : selectedId ? [selectedId] : [], [selectedIds, selectedId]);
  const currentSide = project[sideName];
  const textTarget = textEdit && project[textEdit.face].nodes.find(node => node.id === textEdit.id && node.type === 'text' && node.visible && !node.locked);
  const draftNode = useMemo(() => {
    if (!textTarget || !textEdit) return undefined;
    const text = textDraft?.face === textEdit.face && textDraft.id === textEdit.id ? textDraft.text : textTarget.text || '';
    const draft = layoutParent(project[textEdit.face], textTarget.id) ? { ...textTarget, text } : expandedTextDraft(textTarget, text);
    const visibleFill = hasFill(draft) && (draft.fillOpacity ?? 1) > 0;
    const visibleStroke = hasStroke(draft) && (draft.strokeOpacity ?? 1) > 0;
    return draft.opacity > 0 && (visibleFill || visibleStroke) ? draft : {
      ...draft, opacity: 1, fill: EDITOR_FOCUS, fillMode: 'solid' as const,
      fillHidden: false, fillOpacity: 1, strokeHidden: true, clipRegionId: undefined,
    };
  }, [project, textTarget, textEdit?.face, textEdit?.id, textDraft, fontsReady]);
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
    const view = previewDrag(project, 'front', frontDrag, editing ? selection : [], editing ? activeGroup?.id : undefined, frontDestination);
    return previewText(view, textEdit?.face === 'front' ? draftNode : undefined);
  }, [project, frontDrag, frontDestination, sideName, selection, activeGroup?.id, draftNode, textEdit?.face]);
  const back = useMemo(() => {
    const editing = sideName === 'back';
    const view = previewDrag(project, 'back', backDrag, editing ? selection : [], editing ? activeGroup?.id : undefined, backDestination);
    return previewText(view, textEdit?.face === 'back' ? draftNode : undefined);
  }, [project, backDrag, backDestination, sideName, selection, activeGroup?.id, draftNode, textEdit?.face]);
  const views = { front, back };
  const textNode = draftNode && textEdit && views[textEdit.face].nodes.find(node => node.id === draftNode.id);
  const side = views[sideName];
  const artwork = {
    front: useFaceArtwork(project, 'front', front, sideName === 'front' && flashOnly),
    back: useFaceArtwork(project, 'back', back, sideName === 'back' && flashOnly),
  };
  const gradientNode = editGradient && !textNode && !regionMode && !highlightRegion && !plate && !flashOnly && tool === 'select'
    ? side.nodes.find(node => node.id === selectedId && node.gradient && ['linear','radial'].includes(fillType(node)) &&
      node.visible && !node.locked && !node.fillHidden)
    : undefined;
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const { bleed: bleedBounds, trim: trimBounds } = printGuideBounds(project);
  const { cornerRadius } = trimBounds;
  const clipToBleed = (context: Konva.Context) => {
    context.beginPath();
    context.roundRect(bleedBounds.x, bleedBounds.y, bleedBounds.width, bleedBounds.height, bleedBounds.cornerRadius);
    context.closePath();
  };
  const faceWidth = width + Math.max(width * .165, project.bleedMm * 20 + 24);
  const faces: readonly SideName[] = project.singleSided ? ['front'] : FACES;
  const spreadWidth = (project.singleSided ? 0 : faceWidth) + width;
  const spreadWithBleed = (project.singleSided ? 0 : faceWidth) + bleedBounds.width;
  const boardFit = Math.min((size.width * .737) / spreadWithBleed, (size.height - 120) / bleedBounds.height);
  const fit = showGuides ? Math.min(boardFit,
    (size.width - Math.min(52, size.width * .12)) / spreadWithBleed,
    (size.height - 144) / bleedBounds.height) : boardFit;
  const fitScale = Math.max(.01, fit);
  const fittedCamera: Camera = {
    x: (size.width - spreadWidth * fitScale) / 2,
    y: (size.height - height * fitScale) / 2 + (showGuides ? 12 : 0),
    scale: fitScale, fitScale,
  };
  const origin = manualCamera ?? fittedCamera;
  const { scale } = origin;
  const faceOffset = (face: SideName) => face === 'back' ? faceWidth : 0;
  const faceLeft = (face: SideName) => origin.x + faceOffset(face) * scale;
  const faceDisabled = Boolean(faceLocked || regionMode);
  const faceAt = (point?: Point | null) => {
    if (!point || point.x < 0 || point.x > size.width || point.y < 0 || point.y > size.height ||
      point.y < origin.y + bleedBounds.y * scale || point.y > origin.y + (bleedBounds.y + bleedBounds.height) * scale) return undefined;
    return faces.find(face => point.x >= faceLeft(face) + bleedBounds.x * scale &&
      point.x <= faceLeft(face) + (bleedBounds.x + bleedBounds.width) * scale);
  };
  const draggedGroupId = (face: SideName, nodeId: string) => face === sideName && groupMembers?.artworkIds.includes(nodeId) ? activeGroup?.id : undefined;
  const dragDestination = (from: SideName, nodeId: string) => {
    if (from === sideName && selection.length > 1 && !draggedGroupId(from, nodeId)) return undefined;
    const destination = faceAt(stageRef.current?.getPointerPosition());
    return !faceDisabled && destination !== from ? destination : undefined;
  };
  const handMode = tool === 'hand' || spaceHeld;
  const zoomAt = (factor: number, anchor: Point) => {
    if (panStart.current || currentStroke.current || geometryStart.current || lineRef.current || penHandle.current !== null || Konva.isDragging() ||
      transformerRef.current?.isTransforming()) return;
    setManualCamera(previous => {
      const camera = previous ?? fittedCamera;
      const nextScale = Math.min(camera.fitScale * MAX_ZOOM, Math.max(camera.fitScale * MIN_ZOOM, camera.scale * factor));
      if (nextScale === camera.scale) return previous;
      const ratio = nextScale / camera.scale;
      return { ...camera, scale: nextScale,
        x: anchor.x + (camera.x - anchor.x) * ratio,
        y: anchor.y + (camera.y - anchor.y) * ratio };
    });
  };
  useImperativeHandle(navigationRef, () => ({
    fit: () => { if (!panStart.current && !currentStroke.current && !geometryStart.current && !lineRef.current && penHandle.current === null &&
      !Konva.isDragging() && !transformerRef.current?.isTransforming()) setManualCamera(null); },
    zoomBy: factor => zoomAt(factor, { x: size.width / 2, y: size.height / 2 }),
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
    const maskPromise = activeEffect ? renderEffectMask(project,side,activeEffect) : renderRegionMask(project,side,paintedRegion,1);
    maskPromise.then(mask => {
      const canvas = makeCanvas(mask.width, mask.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(mask, 0, 0);
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = '#55d7be';
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (current) setRegionImage(canvas);
    }).catch(() => {});
    return () => { current = false; };
  }, [project.widthMm, project.heightMm, side, paintedRegion, regionMode, highlightRegion,effectPreviewId]);

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
    transformer?.nodes(node && selected && !textNode && !activeGroup && selection.length <= 1 && selected.visible && !selected.locked && !regionMode && !highlightRegion && tool === 'select' && !plate && !flashOnly && !gradientNode ? [node] : []);
    transformer?.getLayer()?.batchDraw();
  }, [sideName, selectedId, selection.length, currentSide.nodes, tool, regionMode, highlightRegion, plate, flashOnly, gradientNode, activeGroup, textNode]);

  const cardPoint = (face: SideName = sideName) => {
    const position = stageRef.current?.getPointerPosition();
    if (!position) return null;
    return { x: (position.x - faceLeft(face)) / scale, y: (position.y - origin.y) / scale };
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
  useEffect(() => { cancelDrawing(); }, [project.id, tool, regionMode, plate]);
  useEffect(() => {
    if (vectorRef.current && vectorRef.current.face !== sideName) cancelDrawing();
  }, [sideName]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      if (!['pen', 'line'].includes(tool)) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); cancelDrawing();
      } else if (event.key === 'Enter' && tool === 'pen') {
        event.preventDefault(); event.stopPropagation(); finishVector();
      }
    };
    const blur = () => cancelDrawing();
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
    if (event.button !== 1 && event.target instanceof Element && event.target.closest('[data-canvas-text-editor]')) return;
    if (panStart.current || !(event.button === 1 || (event.button === 0 && handMode)) ||
      currentStroke.current || geometryStart.current || lineRef.current || penHandle.current !== null || Konva.isDragging() ||
      transformerRef.current?.isTransforming()) return;
    event.preventDefault();
    lastPenClick.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    panStart.current = { id: event.pointerId, pointer: { x: event.clientX, y: event.clientY }, camera: origin };
    setPointer(null);
    setPanning(true);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const start = panStart.current;
    if (start?.id !== event.pointerId) return;
    const dx = event.clientX - start.pointer.x;
    const dy = event.clientY - start.pointer.y;
    setManualCamera(previous => dx || dy || previous ? {
      ...start.camera, x: start.camera.x + dx, y: start.camera.y + dy,
    } : null);
  };
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    if (panStart.current?.id !== event.pointerId) return;
    panStart.current = null;
    setPanning(false);
  };
  const down = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (handMode || panStart.current || ('button' in event.evt && event.evt.button !== 0)) return;
    const point = cardPoint();
    if (!point) return;
    if (!regionMode && !plate && ['line', 'pen'].includes(tool)) {
      const targetFace = vectorRef.current?.face ?? faceAt(stageRef.current?.getPointerPosition()) ?? sideName;
      if (targetFace !== sideName && faceDisabled) return;
      const position = cardPoint(targetFace)!;
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
      if (draft && draft.points.length >= 2 && previousClick?.face === targetFace &&
        now - previousClick.time <= 450 && Math.hypot(screenPoint.x - previousClick.point.x, screenPoint.y - previousClick.point.y) <= 6) {
        finishVector(); return;
      }
      lastPenClick.current = { face: targetFace, point: { ...screenPoint }, time: now };
      const previous = draft?.points.at(-1);
      const next = previous ? snapAngle(previous, position, additive) : position;
      if (previous && Math.hypot(next.x - previous.x, next.y - previous.y) * scale < 2) return;
      if ((draft?.points.length || 0) >= MAX_PATH_POINTS) { finishVector(); return; }
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
      if (targetFace && targetFace !== sideName) {
        if (!faceDisabled) onSelectFace(targetFace);
      } else onSelect(null);
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
    if (tool === 'pen' && vectorRef.current) {
      const draft = vectorRef.current, point = cardPoint(draft.face);
      if (!point) return;
      const last = draft.points.at(-1)!;
      setVectorHover(snapAngle(last, point, shift));
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
    setDragged(null); setSnap({ x: false, y: false });
    const currentSide = project[face];
    const previous = currentSide.nodes.find(item => item.id === node.id);
    const translating = previous && node.width === previous.width &&
      node.height === previous.height && node.rotation === previous.rotation;
    const dx = node.x - (previous?.x ?? node.x);
    const dy = node.y - (previous?.y ?? node.y);
    const groupId = draggedGroupId(face, node.id);
    if (groupId && translating) {
      const next = moveArtworkGroup(project, face, groupId, { x: dx, y: dy });
      if (next) onChange(next, face);
      else if (previous) stageRef.current?.findOne('#' + artworkId(face, node.id))?.position(previous);
      return;
    }
    onChange({ ...currentSide, nodes: currentSide.nodes.map(item => {
      if (item.id === node.id) return node;
      const selectedTogether = face === sideName && selection.includes(node.id) && selection.includes(item.id);
      return selectedTogether && item.visible && !item.locked
        ? { ...item, x: item.x + dx, y: item.y + dy } : item;
    }) }, face);
  };
  const dragNode = (face: SideName, node: CardNode) => {
    const destination = dragDestination(face, node.id);
    const groupId = draggedGroupId(face, node.id);
    if (!destination && groupId && layoutParent(project[face], groupId)) {
      const original = project[face].nodes.find(item => item.id === node.id);
      if (original) stageRef.current?.findOne('#' + artworkId(face, node.id))?.position(original);
      if (dragged) setDragged(null);
      if (snap.x || snap.y) setSnap({ x: false, y: false });
      return;
    }
    const centerX = faceOffset(destination ?? face) - faceOffset(face) + width / 2;
    const closeX = Math.abs(node.x + node.width / 2 - centerX) < 6 / scale;
    const closeY = Math.abs(node.y + node.height / 2 - height / 2) < 6 / scale;
    if (closeX) node.x = centerX - node.width / 2;
    if (closeY) node.y = (height - node.height) / 2;
    stageRef.current?.findOne('#' + artworkId(face, node.id))?.position({ x: node.x, y: node.y });
    setDragged({ face, node, destination }); setSnap({ x: closeX, y: closeY });
  };
  const dropNode = (face: SideName, node: CardNode, cancelled: boolean) => {
    const destination = cancelled ? undefined : dragDestination(face, node.id);
    if (!cancelled && !destination) {
      commitNode(face, node);
      return;
    }
    setDragged(null); setSnap({ x: false, y: false });
    const groupId = draggedGroupId(face, node.id);
    if (destination && !onTransferArtwork(face, destination, node.id, {
      x: node.x + faceOffset(face) - faceOffset(destination), y: node.y,
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
  // Keep the source above the destination while Konva is still dragging the original node.
  const drawOrder = !project.singleSided && dragged?.destination === 'back' ? ['back', 'front'] as const : faces;

  return <div ref={holder} className="editor-canvas" data-testid="editor-canvas"
    data-canvas-tool={tool} data-vector-points={vectorDraft?.points.length || 0}
    data-drawing-face={vectorDraft?.face ?? lineDraft?.face}
    data-selected-count={selection.length}
    data-artwork-group={activeGroup?.id} data-group-locked={groupLocked || undefined}
    onPointerDownCapture={startPan} onPointerMove={movePan} onPointerUp={endPan}
    onPointerCancel={endPan} onLostPointerCapture={endPan}
    style={{ width: '100%', height: '100%', minHeight: 100, position: 'relative', overflow: 'hidden',
      backgroundPosition: `${origin.x % 8}px ${origin.y % 8}px`,
      touchAction: 'none', cursor: panning ? 'grabbing' : handMode ? 'grab' : regionMode && ['brush', 'eraser'].includes(tool) ? 'none' : tool === 'geometry' || vectorTool ? 'crosshair' : 'default' }}>
    <Stage ref={stageRef} width={size.width} height={size.height} onMouseDown={down} onTouchStart={down}
      onContextMenu={event => {
        event.evt.preventDefault();
        if (faceDisabled || textEdit) return;
        const stage = stageRef.current!;
        stage.setPointersPositions(event.evt);
        const hit = event.target.findAncestor('.artwork-node', true);
        const hitFace = hit?.findAncestor('.card-face-back') ? 'back' : hit ? 'front' : undefined;
        const face = hitFace ?? faceAt(stage.getPointerPosition()) ?? sideName;
        let node = hit && project[face].nodes.find(item => artworkId(face,item.id) === hit.id());
        // Locked artwork ignores normal pointer input, but its context menu must still allow unlocking.
        const layers = project[face].nodes;
        const at = stage.getPointerPosition();
        if (at && !(face === sideName && (plate || flashOnly))) {
          const context = stage.content.querySelector('canvas')?.getContext('2d');
          for (let i=layers.length-1; context && i>=0 && layers[i]!==node; i--) {
            const candidate=layers[i];
            if (!candidate.visible || candidate.type==='empty' || !candidate.locked) continue;
            const shape=stage.findOne('#'+artworkId(face,candidate.id));
            if (!shape) continue;
            const local=shape.getAbsoluteTransform().copy().invert().point(at);
            const x=candidate.flipX?candidate.width-local.x:local.x, y=candidate.flipY?candidate.height-local.y:local.y;
            context.save(); context.resetTransform();
            context.lineWidth=Math.max(candidate.strokeWidth||0,8/scale);
            const path=artworkPath(candidate);
            const inside=isOpenVector(candidate)?context.isPointInStroke(path,x,y):context.isPointInPath(path,x,y);
            context.restore();
            if (inside) { node=candidate; break; }
          }
        }
        const point = cardPoint(face);
        if (point) onCanvasMenu(face, point, {x:event.evt.clientX,y:event.evt.clientY}, node?.id);
      }}
      onMouseMove={move} onTouchMove={move}
      onMouseUp={() => { finishStroke(); finishDrawingGesture(); }} onTouchEnd={() => { finishStroke(); finishDrawingGesture(); }}
      onTouchCancel={() => { finishStroke(); cancelDrawing(); }}
      onMouseLeave={() => { finishStroke(); finishDrawingGesture(); setPointer(null); setVectorHover(null); }}
      onWheel={event => {
        const wheel = event.evt;
        wheel.preventDefault();
        const anchor = stageRef.current?.getPointerPosition();
        const delta = wheel.deltaY * (wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? size.height : 1);
        if (anchor && delta) zoomAt(Math.exp(-Math.max(-240, Math.min(240, delta)) * .002), anchor);
      }}>
      <Layer>
        {drawOrder.map(face => {
          const editing = face === sideName;
          const facePlate = editing ? plate : undefined;
          const painting = editing && regionMode;
          const showMask = editing && (regionMode || highlightRegion);
          const original = project[face];
          const composite = artwork[face];
          const ground = facePlate ? '#ffffff' : stockGroundColor(project.material, getStockAppearance(project, original));
          return <Group key={face} name={`card-face-${face}`} x={faceLeft(face)} y={origin.y} scaleX={scale} scaleY={scale}>
            <Rect name="card-ground" {...bleedBounds} fill={ground}
              shadowColor="#000000" shadowOpacity={0.28} shadowBlur={34 / scale} shadowOffsetY={14 / scale} />
            {composite.whiteStock && !facePlate && <Group clipFunc={clipToBleed} listening={false}>
              <KonvaImage image={composite.whiteStock} x={bleedBounds.x} y={bleedBounds.y}
                width={bleedBounds.width} height={bleedBounds.height} />
            </Group>}
            {composite.stock && !painting && !facePlate && <KonvaImage name="stock-reflection" image={composite.stock.canvas}
              x={bleedBounds.x} y={bleedBounds.y} width={bleedBounds.width} height={bleedBounds.height}
              opacity={composite.stock.opacity} globalCompositeOperation={composite.stock.blend} listening={false} />}
            {/* Artwork stays interactive beyond the trim area, in the coordinates of its own face. */}
            {!facePlate && original.nodes.map((node, index) => <ArtworkNode key={node.id} face={face}
              node={dragged?.face === face && dragged.node.id === node.id ? node : views[face].nodes[index]}
              outsideTrim={composite.clipped ? trimBounds : undefined}
              interactive={tool === 'select' && !regionMode && !handMode && !panning && !(editing && flashOnly) && (editing || !faceDisabled)}
              canDrag={!(textEdit?.face === face && textNode?.id === node.id) &&
                (editing && activeGroup && groupMembers?.artworkIds.includes(node.id)
                  ? !groupLocked && (!project.singleSided || !layoutParent(original, activeGroup.id))
                  : !layoutParent(original, node.id))}
              onSelect={additive => {
                if (editing) { if (additive || !(activeGroup && groupMembers?.artworkIds.includes(node.id)) && !(selection.length > 1 && selection.includes(node.id))) onSelect(node.id, additive); }
                else onSelectFace(face, node.id);
              }}
              onCommit={value => commitNode(face, value)} onDrag={value => dragNode(face, value)}
              onDrop={(value, cancelled) => dropNode(face, value, cancelled)}
              onTransformPreview={value => setDragged({ face, node: value })}
              onTextEdit={() => { if (node.type === 'text' && node.visible && !node.locked) onTextEdit?.(face, node.id); }} />)}
            <Group clipFunc={clipToBleed}>
              {!facePlate && composite.clipped && <KonvaImage image={composite.clipped} width={width} height={height} listening={false} />}
              {composite.effects && !painting && !facePlate && <KonvaImage image={composite.effects} width={width} height={height} listening={false} />}
              {facePlate && plateImage && <KonvaImage image={plateImage} width={width} height={height} listening={false} />}
              {painting && <Rect width={width} height={height} fill="#000000" opacity={.3} listening={false} />}
              {painting && activeRegion?.kind === 'polygon' && activeRegion.points?.map((value, i, points) =>
                i % 2 === 0 ? <Ellipse key={i} x={value} y={points[i+1]} radiusX={3 / scale} radiusY={3 / scale}
                  fill={EDITOR_FOCUS} stroke={EDITOR_BLUE} strokeWidth={1 / scale} listening={false}/> : null)}
              {showMask && regionImage && <KonvaImage image={regionImage} width={width} height={height} opacity={painting ? .65 : .32} listening={false} />}
            </Group>
            {!facePlate && original.nodes.filter(node => node.visible && !node.locked && !(textEdit?.face === face && textNode?.id === node.id) &&
              editing && ((activeGroup && groupMembers?.artworkIds.includes(node.id)) ||
                (selection.length > 1 && selection.includes(node.id))))
              .map(node => {
                const shown = views[face].nodes.find(item => item.id === node.id) || node;
                return <Rect key={'selection-' + node.id} x={shown.x} y={shown.y} width={shown.width} height={shown.height}
                  rotation={shown.rotation} stroke={EDITOR_BLUE} strokeWidth={1 / scale} listening={false}/>;
              })}
            {lineDraft?.face === face && <Group listening={false}>
              <Line points={[lineDraft.start.x, lineDraft.start.y, lineDraft.end.x, lineDraft.end.y]}
                stroke={EDITOR_FOCUS} strokeWidth={1.5 / scale} lineCap="round"/>
              {[lineDraft.start, lineDraft.end].map((point, index) => <Rect key={index}
                x={point.x - 3 / scale} y={point.y - 3 / scale} width={6 / scale} height={6 / scale}
                fill="#ffffff" stroke={EDITOR_BLUE} strokeWidth={1 / scale}/>)}
            </Group>}
            {vectorDraft?.face === face && <Group listening={false}>
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
            <Rect name="card-frame" {...bleedBounds}
              stroke="rgba(220,220,220,.5)" strokeWidth={1 / scale} listening={false} />
            {showGuides && <PrintGuideLines project={project} scale={scale} />}
            {snapFace === face && snap.x && <Line points={[width / 2, -30, width / 2, height + 30]} stroke={EDITOR_FOCUS} strokeWidth={1 / scale} listening={false} />}
            {snapFace === face && snap.y && <Line points={[-30, height / 2, width + 30, height / 2]} stroke={EDITOR_FOCUS} strokeWidth={1 / scale} listening={false} />}
            {editing && <Transformer ref={transformerRef} rotateEnabled={!regionMode} flipEnabled={false} listening={!handMode && !panning}
              borderStroke={EDITOR_BLUE} anchorStroke={EDITOR_BLUE} anchorFill="#ffffff" anchorSize={7}
              anchorCornerRadius={2} borderStrokeWidth={1} rotateAnchorOffset={24}
              boundBoxFunc={(oldBox, newBox) => {
                const selected = currentSide.nodes.find(node => node.id === selectedId);
                const minimum = selected?.type === 'line' || selected?.type === 'path' ? .1 : 10;
                return Math.abs(newBox.width) < minimum || Math.abs(newBox.height) < minimum ? oldBox : newBox;
              }} />}
            {editing && gradientNode?.gradient && !handMode && !panning && onGradientChange && <GradientHandles
              node={{ ...gradientNode, gradient: gradientNode.gradient }} scale={scale}
              onStart={onGradientStart} onChange={onGradientChange}/>}
            {!handMode && !panning && painting && pointer && ['brush', 'eraser'].includes(tool) && <Ellipse
              x={pointer.x} y={pointer.y} radiusX={brushSize / 2} radiusY={brushSize / 2}
              stroke={tool === 'eraser' ? '#ffb19d' : '#ffffff'} strokeWidth={1.5 / scale}
              fill="rgba(255,255,255,.08)" listening={false} />}
          </Group>;
        })}
      </Layer>
    </Stage>
    {textNode && textEdit && <CanvasTextEditor key={`${project.id}:${textEdit.face}:${textNode.id}`}
      node={textNode} face={textEdit.face} scale={scale}
      left={faceLeft(textEdit.face) + textNode.x * scale} top={origin.y + textNode.y * scale}
      onDraft={text => setTextDraft({ ...textEdit, text })}
      onCommit={text => onTextCommit?.(textEdit.face, textNode.id, text)} onCancel={() => onTextCancel?.()}
      onWheel={event => {
        const bounds = holder.current?.getBoundingClientRect();
        if (!bounds) return;
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
        if (delta) zoomAt(Math.exp(-Math.max(-240, Math.min(240, delta)) * .002),
          { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      }}/>}
    {vectorTool && !handMode && <div className="canvas-tool-hint" role="status" aria-live="polite">
      <strong>{tool === 'pen' ? penCanClose ? '闭合路径' : vectorDraft ? `钢笔 · ${vectorDraft.points.length} 个节点` : '钢笔' : '直线'}</strong>
      <span>{tool === 'pen' ? '单击添加节点 · 拖动设置曲线 · Enter 完成 · Esc 取消' :
        '拖动绘制 · Shift 锁定角度 · Esc 取消'}</span>
    </div>}
    {faces.map(face => {
      const editing = face === sideName;
      const left = faceLeft(face);
      const boardLeft = left + bleedBounds.x * scale;
      const boardTop = origin.y + bleedBounds.y * scale;
      const label = face === 'front' ? '正面' : '背面';
      const labelOnScreen = boardLeft >= 0 && boardLeft + 34 <= size.width && boardTop >= 26 && boardTop <= size.height;
      return <Fragment key={face}>
        <div data-card-artboard={face} data-board-space="bleed"
          data-drop-target={dropTarget === face ? true : undefined} aria-hidden="true"
          style={{ position: 'absolute', pointerEvents: 'none', left: boardLeft, top: boardTop,
            width: bleedBounds.width * scale, height: bleedBounds.height * scale, borderRadius: bleedBounds.cornerRadius * scale }} />
        <div ref={editing ? cardBoundsRef : undefined} data-card-bounds={editing ? true : undefined} data-card-face={face}
          data-card-trim={face} aria-hidden="true"
          style={{ position: 'absolute', pointerEvents: 'none', left, top: origin.y, width: width * scale, height: height * scale, borderRadius: cornerRadius * scale }} />
        <button type="button" className="canvas-face-label" data-face-label={face} aria-pressed={editing}
          data-drop-target={dropTarget === face ? true : undefined}
          disabled={faceDisabled && !editing} tabIndex={labelOnScreen ? 0 : -1} style={{ left: boardLeft, top: boardTop }}
          onClick={() => { if (!faceDisabled) onSelectFace(face); }}>{label}</button>
      </Fragment>;
    })}
  </div>;
}
