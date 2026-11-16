import { useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent, type Ref } from 'react';
import { Stage, Layer, Group, Rect, Ellipse, Image as KonvaImage, Line, Transformer } from 'react-konva';
import Konva from 'konva';
import { PrintGuideLines, printGuideBounds } from './PrintGuides';
import { pentagon, type CardNode, type CardSide, type Project, type Region, type SideName, type Stroke } from './model';
import { imageCrop, loadImage, makeCanvas, drawCardText, drawShape, renderCard, renderEffectMask, renderEffects, renderRegionMask } from './render';

type Point = { x: number; y: number };
type Camera = Point & { scale: number; fitScale: number };
const MIN_ZOOM = .1;
const MAX_ZOOM = 32;
export const ZOOM_STEP = 1.2;

export interface CanvasNavigation {
  fit: () => void;
  zoomBy: (factor: number) => void;
}

export interface EditorCanvasProps {
  project: Project;
  side: SideName;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (side: CardSide) => void;
  tool: 'select' | 'hand' | 'brush' | 'eraser' | 'geometry';
  spaceHeld: boolean;
  navigationRef: Ref<CanvasNavigation>;
  showGuides: boolean;
  hasModeNotice?: boolean;
  regionId: string | null;
  regionMode: boolean;
  highlightRegion?: boolean;
  onRegionChange: (region: Region) => void;
  onTextEdit?: (id: string) => void;
  plate?: string | null;
  brushSize?: number;
  onZoom?: (zoom: number) => void;
  referenceOpacity?: number;
  layerPlate?: string;
  effectPreviewId?: string;
  cardBoundsRef: Ref<HTMLDivElement>;
}

function ArtworkNode({ node, interactive, onSelect, onCommit, onDrag, onTransformPreview, onTextEdit }: {
  node: CardNode; interactive: boolean; onSelect: () => void;
  onCommit: (node: CardNode) => void; onDrag: (node: CardNode) => void;
  onTransformPreview: (node: CardNode) => void;
  onTextEdit?: () => void;
}) {
  const shape = useMemo(() => {
    if (!node.gradient && !node.polygon) return undefined;
    if (!['rect','ellipse','polygon'].includes(node.type)) return undefined;
    const scale = Math.min(2, 2600 / Math.max(node.width,node.height));
    const layer = makeCanvas(node.width*scale,node.height*scale);
    const context = layer.getContext('2d')!;
    context.scale(scale,scale);
    drawShape(context,node);
    return layer;
  },[node]);
  const [image, setImage] = useState<HTMLImageElement>();
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let live = true;
    if (node.type === 'text') document.fonts.load('14px "Work Sans"').then(() => {
      if (live) setFontsReady(true);
    }).catch(() => {});
    return () => { live = false; };
  }, [node.type]);
  const textImage = useMemo(() => {
    if (node.type !== 'text') return undefined;
    const scale = Math.min(2, 2600 / Math.max(node.width, node.height));
    const image = makeCanvas(node.width * scale, node.height * scale);
    const context = image.getContext('2d')!;
    context.scale(scale, scale);
    context.fillStyle = node.fill;
    drawCardText(context, node);
    return image;
  }, [node.type, node.width, node.height, node.text, node.fill, node.fontSize, node.fontStyle, node.fontFamily, node.align, node.lineHeight, node.stroke, node.strokeWidth, node.letterSpacing, fontsReady]);
  useEffect(() => {
    let current = true;
    if (node.type === 'image' && node.src) loadImage(node.src).then(value => {
      if (current) setImage(value);
    }).catch(() => { if (current) setImage(undefined); });
    return () => { current = false; };
  }, [node.src, node.type]);
  const common = {
    id: node.id, name: 'artwork-node', x: node.x, y: node.y,
    width: node.width, height: node.height, rotation: node.rotation,
    opacity: node.opacity, visible: node.visible,
    draggable: interactive && !node.locked, listening: interactive && !node.locked,
    fill: node.fill, stroke: node.stroke, strokeWidth: node.strokeWidth || 0,
    globalCompositeOperation: (node.blend || 'source-over') as GlobalCompositeOperation,
    onMouseDown: (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (event.evt.button !== 0) return;
      event.cancelBubble = true; onSelect();
    },
    onTouchStart: (event: Konva.KonvaEventObject<TouchEvent>) => { event.cancelBubble = true; onSelect(); },
    onDblClick: () => onTextEdit?.(),
    onDblTap: () => onTextEdit?.(),
    onDragMove: (event: Konva.KonvaEventObject<DragEvent>) => onDrag({ ...node, x: event.target.x(), y: event.target.y() }),
    onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => onCommit({ ...node, x: event.target.x(), y: event.target.y() }),
    onTransform: (event: Konva.KonvaEventObject<Event>) => {
      const target = event.target;
      onTransformPreview({ ...node, x: target.x(), y: target.y(), rotation: target.rotation(),
        width: Math.max(8, target.width() * target.scaleX()),
        height: Math.max(8, target.height() * target.scaleY()),
        ...(node.type === 'text' ? { fontSize: (node.fontSize || 24) * target.scaleY() } : {}) });
    },
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => {
      const target = event.target;
      const next = { ...node, x: target.x(), y: target.y(), rotation: target.rotation(),
        width: Math.max(8, target.width() * target.scaleX()),
        height: Math.max(8, target.height() * target.scaleY()) };
      if (node.type === 'text') next.fontSize = (node.fontSize || 24) * target.scaleY();
      target.scaleX(1); target.scaleY(1);
      onCommit(next);
    },
  };
  if (shape) return <KonvaImage {...common} fill={undefined} stroke={undefined} image={shape}/>;
  if (node.type === 'text') return <KonvaImage {...common} fill={undefined} stroke={undefined} image={textImage} />;
  if (node.type === 'ellipse') return <Group {...common}>
    <Ellipse x={node.width / 2} y={node.height / 2} radiusX={node.width / 2} radiusY={node.height / 2}
      fill={node.fill} stroke={node.stroke} strokeWidth={node.strokeWidth || 0} />
  </Group>;
  if (node.type === 'polygon') return <Group {...common}>
    <Line points={pentagon(node.width,node.height)} closed fill={node.fill} stroke={node.stroke} strokeWidth={node.strokeWidth || 0}/>
  </Group>;
  if (node.type === 'image' && image) return <KonvaImage {...common} fill={undefined} image={image}
    crop={imageCrop(image, node)} cornerRadius={node.cornerRadius || 0} />;
  return <Rect {...common} cornerRadius={node.cornerRadius || 0} />;
}

export default function EditorCanvas({ project, side: sideName, selectedId, onSelect, onChange,
  tool, spaceHeld, navigationRef, showGuides, hasModeNotice, regionId, regionMode, highlightRegion, onRegionChange, onTextEdit, plate,
  brushSize = 30, onZoom, referenceOpacity = 0, layerPlate, effectPreviewId, cardBoundsRef }: EditorCanvasProps) {
  const holder = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [size, setSize] = useState({ width: 600, height: 700 });
  const [manualCamera, setManualCamera] = useState<Camera | null>(null);
  const [panning, setPanning] = useState(false);
  const [draggedNode, setDraggedNode] = useState<CardNode | null>(null);
  const [snap, setSnap] = useState({ x: false, y: false });
  const [effectImage, setEffectImage] = useState<HTMLCanvasElement>();
  const [regionImage, setRegionImage] = useState<HTMLCanvasElement>();
  const [clippedArt, setClippedArt] = useState<HTMLCanvasElement>();
  const [plateImage, setPlateImage] = useState<HTMLCanvasElement>();
  const [reference, setReference] = useState<{ src: string; image: HTMLImageElement }>();
  const [draftStroke, setDraftStroke] = useState<Stroke | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const panStart = useRef<{ id: number; pointer: Point; camera: Camera } | null>(null);
  const currentStroke = useRef<Stroke | null>(null);
  const geometryStart = useRef<{ x: number; y: number } | null>(null);
  const geometryRegion = useRef<Region | null>(null);
  const currentSide = project[sideName];
  const referenceSrc = currentSide.reference?.src;
  const side = useMemo(() => {
    if (!draggedNode) return currentSide;
    const original = currentSide.nodes.find(node => node.id === draggedNode.id);
    const translateGroup = original?.groupId && original.width === draggedNode.width &&
      original.height === draggedNode.height && original.rotation === draggedNode.rotation;
    return { ...currentSide, nodes: currentSide.nodes.map(node => {
      if (node.id === draggedNode.id) return draggedNode;
      return translateGroup && node.groupId === original?.groupId && !node.locked
        ? { ...node, x: node.x + draggedNode.x - original.x, y: node.y + draggedNode.y - original.y } : node;
    }) };
  }, [currentSide, draggedNode]);
  const hasClips = side.nodes.some(node => node.clipRegionId && node.visible);
  useEffect(() => {
    if (!hasClips) {setClippedArt(undefined);return;}
    let current = true;
    const snapshot = {...project,[sideName]:side};
    renderCard(snapshot,sideName,{effects:false,transparentGround:true}).then(image => {
      if (current) setClippedArt(image);
    }).catch(() => {if(current)setClippedArt(undefined);});
    return () => {current=false;};
  },[hasClips,side,sideName,project.widthMm,project.heightMm]);
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const { bleed: bleedBounds, trim: { cornerRadius } } = printGuideBounds(project);
  const trimFit = Math.min((size.width - 130) / width, (size.height - 130) / height);
  const fit = showGuides ? Math.min(trimFit,
    (size.width - 52) / bleedBounds.width, (size.height - (hasModeNotice ? 144 : 122)) / bleedBounds.height) : trimFit;
  const fitScale = Math.max(.06, fit);
  const fittedCamera: Camera = {
    x: (size.width - width * fitScale) / 2,
    y: (size.height - height * fitScale) / 2 + (showGuides ? (hasModeNotice ? 22 : 10) : 0),
    scale: fitScale, fitScale,
  };
  const origin = manualCamera ?? fittedCamera;
  const { scale } = origin;
  const zoom = scale / origin.fitScale;
  const handMode = tool === 'hand' || spaceHeld;
  const zoomAt = (factor: number, anchor: Point) => {
    if (panStart.current || currentStroke.current || geometryStart.current || Konva.isDragging() ||
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
    fit: () => { if (!panStart.current && !currentStroke.current && !geometryStart.current &&
      !Konva.isDragging() && !transformerRef.current?.isTransforming()) setManualCamera(null); },
    zoomBy: factor => zoomAt(factor, { x: size.width / 2, y: size.height / 2 }),
  }));
  useEffect(() => { onZoom?.(zoom); }, [onZoom, zoom]);
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
  useEffect(() => { setDraggedNode(null); }, [currentSide]);

  useEffect(() => {
    if (!referenceSrc || !referenceOpacity) return;
    let current = true;
    loadImage(referenceSrc).then(image => {
      if (current) setReference({ src: referenceSrc, image });
    }).catch(() => {});
    return () => { current = false; };
  }, [referenceSrc, Boolean(referenceOpacity)]);

  useEffect(() => {
    let current = true;
    renderEffects(project, side, 1).then(canvas => { if (current) setEffectImage(canvas); }).catch(() => {});
    return () => { current = false; };
  }, [project.widthMm, project.heightMm, project.material, project.stockReflection, project.previewStyle, side]);

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
    if (!plate) { setPlateImage(undefined); return; }
    renderCard(project, sideName, { plate, layerId:layerPlate }).then(canvas => { if (current) setPlateImage(canvas); }).catch(() => {});
    return () => { current = false; };
  }, [project, sideName, plate, layerPlate]);

  useEffect(() => {
    const transformer = transformerRef.current;
    const node = selectedId && stageRef.current?.findOne('#' + selectedId);
    const selected = side.nodes.find(item => item.id === selectedId);
    transformer?.nodes(node && selected && selected.visible && !selected.locked && !regionMode && !highlightRegion && tool === 'select' && !plate ? [node] : []);
    transformer?.getLayer()?.batchDraw();
  }, [selectedId, currentSide.nodes, tool, regionMode, highlightRegion, plate]);

  const cardPoint = () => {
    const position = stageRef.current?.getPointerPosition();
    if (!position) return null;
    return { x: (position.x - origin.x) / scale, y: (position.y - origin.y) / scale };
  };
  const finishStroke = () => {
    if (currentStroke.current && activeRegion) onRegionChange({ ...activeRegion, strokes: [...activeRegion.strokes, currentStroke.current] });
    currentStroke.current = null;
    setDraftStroke(null);
    if (geometryRegion.current) onRegionChange(geometryRegion.current);
    geometryStart.current = null;
    geometryRegion.current = null;
  };
  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if (panStart.current || !(event.button === 1 || (event.button === 0 && handMode)) ||
      currentStroke.current || geometryStart.current || Konva.isDragging() ||
      transformerRef.current?.isTransforming()) return;
    event.preventDefault();
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
    if (event.target === event.target.getStage() || event.target.name() === 'card-ground') onSelect(null);
  };
  const move = () => {
    if (panStart.current) return;
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
  const commitNode = (node: CardNode) => {
    setDraggedNode(null); setSnap({ x: false, y: false });
    const previous = currentSide.nodes.find(item => item.id === node.id);
    const translateGroup = previous?.groupId && node.width === previous.width &&
      node.height === previous.height && node.rotation === previous.rotation;
    const dx = node.x - (previous?.x ?? node.x);
    const dy = node.y - (previous?.y ?? node.y);
    onChange({ ...currentSide, nodes: currentSide.nodes.map(item => {
      if (item.id === node.id) return node;
      return translateGroup && item.groupId === previous?.groupId && !item.locked
        ? { ...item, x: item.x + dx, y: item.y + dy } : item;
    }) });
  };
  const dragNode = (node: CardNode) => {
    const closeX = Math.abs(node.x + node.width / 2 - width / 2) < 6 / scale;
    const closeY = Math.abs(node.y + node.height / 2 - height / 2) < 6 / scale;
    if (closeX) node.x = (width - node.width) / 2;
    if (closeY) node.y = (height - node.height) / 2;
    stageRef.current?.findOne('#' + node.id)?.position({ x: node.x, y: node.y });
    setDraggedNode(node); setSnap({ x: closeX, y: closeY });
  };

  return <div ref={holder} className="editor-canvas" data-testid="editor-canvas"
    onPointerDownCapture={startPan} onPointerMove={movePan} onPointerUp={endPan}
    onPointerCancel={endPan} onLostPointerCapture={endPan}
    style={{ width: '100%', height: '100%', minHeight: 100, position: 'relative', overflow: 'hidden',
      backgroundPosition: `${origin.x % 17}px ${origin.y % 17}px`,
      touchAction: 'none', cursor: panning ? 'grabbing' : handMode ? 'grab' : regionMode && ['brush', 'eraser'].includes(tool) ? 'none' : tool === 'geometry' ? 'crosshair' : 'default' }}>
    <Stage ref={stageRef} width={size.width} height={size.height} onMouseDown={down} onTouchStart={down}
      onMouseMove={move} onTouchMove={move} onMouseUp={finishStroke} onTouchEnd={finishStroke} onTouchCancel={finishStroke}
      onMouseLeave={() => { finishStroke(); setPointer(null); }}
      onWheel={event => {
        const wheel = event.evt;
        wheel.preventDefault();
        const anchor = stageRef.current?.getPointerPosition();
        const delta = wheel.deltaY * (wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? size.height : 1);
        if (anchor && delta) zoomAt(Math.exp(-Math.max(-240, Math.min(240, delta)) * .002), anchor);
      }}>
      <Layer>
        <Group x={origin.x} y={origin.y} scaleX={scale} scaleY={scale}>
          <Rect name="card-ground" width={width} height={height} fill="#ffffff" cornerRadius={cornerRadius}
            shadowColor="#000000" shadowOpacity={0.28} shadowBlur={34 / scale} shadowOffsetY={14 / scale} />
          {/* Artwork stays interactive across the workspace. The card's composite and guides use trim coordinates. */}
          {!plate && currentSide.nodes.map((node, index) => <ArtworkNode key={node.id} node={draggedNode?.id === node.id ? node : side.nodes[index]}
            interactive={tool === 'select' && !regionMode && !handMode && !panning}
            onSelect={() => onSelect(node.id)} onCommit={commitNode} onDrag={dragNode}
            onTransformPreview={setDraggedNode}
            onTextEdit={() => { if (node.type === 'text') onTextEdit?.(node.id); }} />)}
          <Group clipFunc={context => { context.beginPath(); context.roundRect(0, 0, width, height, cornerRadius); context.closePath(); }}>
            {!plate && hasClips && clippedArt && <>
              <Rect width={width} height={height} fill="#ffffff" listening={false} />
              <KonvaImage image={clippedArt} width={width} height={height} listening={false} />
            </>}
            {effectImage && !regionMode && !plate && <KonvaImage image={effectImage} width={width} height={height} listening={false} />}
            {!!referenceOpacity && !regionMode && !plate && reference && reference.src === referenceSrc && <KonvaImage
              image={reference.image} width={width} height={height} opacity={referenceOpacity} listening={false} />}
            {plate && plateImage && <KonvaImage image={plateImage} width={width} height={height} listening={false} />}
            {regionMode && <Rect width={width} height={height} fill="#000000" opacity={.3} listening={false} />}
            {regionMode && activeRegion?.kind === 'polygon' && activeRegion.points?.map((value, i, points) =>
              i % 2 === 0 ? <Ellipse key={i} x={value} y={points[i+1]} radiusX={3 / scale} radiusY={3 / scale}
                fill="#a0ffdb" stroke="#264638" strokeWidth={1 / scale} listening={false}/> : null)}
            {(regionMode || highlightRegion) && regionImage && <KonvaImage image={regionImage} width={width} height={height} opacity={regionMode ? .65 : .32} listening={false} />}
          </Group>
          {showGuides ? <PrintGuideLines project={project} scale={scale} /> :
            <Rect width={width} height={height} cornerRadius={cornerRadius}
              stroke="rgba(214,225,216,.5)" strokeWidth={1 / scale} listening={false} />}
          {snap.x && <Line points={[width / 2, -30, width / 2, height + 30]} stroke="#64dabc" strokeWidth={1 / scale} listening={false} />}
          {snap.y && <Line points={[-30, height / 2, width + 30, height / 2]} stroke="#64dabc" strokeWidth={1 / scale} listening={false} />}
          <Transformer ref={transformerRef} rotateEnabled={!regionMode} flipEnabled={false} listening={!handMode && !panning}
            borderStroke="#77d8c4" anchorStroke="#449a86" anchorFill="#ffffff" anchorSize={7}
            anchorCornerRadius={2} borderStrokeWidth={1} rotateAnchorOffset={24}
            boundBoxFunc={(oldBox, newBox) => Math.abs(newBox.width) < 10 || Math.abs(newBox.height) < 10 ? oldBox : newBox} />
          {!handMode && !panning && regionMode && pointer && ['brush', 'eraser'].includes(tool) && <Ellipse
            x={pointer.x} y={pointer.y} radiusX={brushSize / 2} radiusY={brushSize / 2}
            stroke={tool === 'eraser' ? '#ffb19d' : '#ffffff'} strokeWidth={1.5 / scale}
            fill="rgba(255,255,255,.08)" listening={false} />}
        </Group>
      </Layer>
    </Stage>
    <div ref={cardBoundsRef} data-card-bounds aria-hidden="true"
      style={{ position: 'absolute', pointerEvents: 'none', left: origin.x, top: origin.y, width: width * scale, height: height * scale }} />
    {!showGuides && <div style={{ position: 'absolute', left: origin.x, top: origin.y + height * scale + 20,
      width: width * scale, color: '#9a9a9a', fontSize: 11, display: 'flex', justifyContent: 'space-between', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
      <span>{sideName === 'front' ? '正面' : '背面'} · {project.widthMm} × {project.heightMm} mm</span>
      <span>{regionMode || highlightRegion ? '绿色为作用区域' : plate ? '生产工艺版' : '材质效果示意'}</span>
    </div>}
  </div>;
}
