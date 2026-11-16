import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { Stage, Layer, Group, Rect, Ellipse, Image as KonvaImage, Line, Transformer } from 'react-konva';
import Konva from 'konva';
import { pentagon, type CardNode, type CardSide, type Project, type Region, type SideName, type Stroke } from './model';
import { imageCrop, loadImage, makeCanvas, drawCardText, renderCard, renderEffects, renderRegionMask } from './render';

export interface EditorCanvasProps {
  project: Project;
  side: SideName;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (side: CardSide) => void;
  tool: 'select' | 'hand' | 'brush' | 'eraser' | 'geometry';
  zoom: number;
  showGuides: boolean;
  regionId: string | null;
  regionMode: boolean;
  highlightRegion?: boolean;
  onRegionChange: (region: Region) => void;
  onTextEdit?: (id: string) => void;
  plate?: string | null;
  brushSize?: number;
  onZoom?: (zoom: number) => void;
  cardBoundsRef: Ref<HTMLDivElement>;
}

function ArtworkNode({ node, interactive, onSelect, onCommit, onDrag, onTransformPreview, onTextEdit }: {
  node: CardNode; interactive: boolean; onSelect: () => void;
  onCommit: (node: CardNode) => void; onDrag: (node: CardNode) => void;
  onTransformPreview: (node: CardNode) => void;
  onTextEdit?: () => void;
}) {
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
  }, [node.type, node.width, node.height, node.text, node.fill, node.fontSize, node.fontStyle, node.fontFamily, node.align, node.lineHeight, fontsReady]);
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
    onMouseDown: (event: Konva.KonvaEventObject<MouseEvent>) => { event.cancelBubble = true; onSelect(); },
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
  if (node.type === 'text') return <KonvaImage {...common} fill={undefined} stroke={undefined} image={textImage} />;
  if (node.type === 'ellipse') return <Group {...common}>
    <Ellipse x={node.width / 2} y={node.height / 2} radiusX={node.width / 2} radiusY={node.height / 2}
      fill={node.fill} stroke={node.stroke} strokeWidth={node.strokeWidth || 0} />
  </Group>;
  if (node.type === 'polygon') return <Group {...common}>
    <Line points={pentagon(node.width,node.height)} closed fill={node.fill} stroke={node.stroke} strokeWidth={node.strokeWidth || 0}/>
  </Group>;
  if (node.type === 'image' && image) return <KonvaImage {...common} image={image} crop={imageCrop(image, node)} />;
  return <Rect {...common} />;
}

export default function EditorCanvas({ project, side: sideName, selectedId, onSelect, onChange,
  tool, zoom, showGuides, regionId, regionMode, highlightRegion, onRegionChange, onTextEdit, plate,
  brushSize = 30, onZoom, cardBoundsRef }: EditorCanvasProps) {
  const holder = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [size, setSize] = useState({ width: 600, height: 700 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draggedNode, setDraggedNode] = useState<CardNode | null>(null);
  const [snap, setSnap] = useState({ x: false, y: false });
  const [effectImage, setEffectImage] = useState<HTMLCanvasElement>();
  const [regionImage, setRegionImage] = useState<HTMLCanvasElement>();
  const [plateImage, setPlateImage] = useState<HTMLCanvasElement>();
  const [draftStroke, setDraftStroke] = useState<Stroke | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const currentStroke = useRef<Stroke | null>(null);
  const geometryStart = useRef<{ x: number; y: number } | null>(null);
  const geometryRegion = useRef<Region | null>(null);
  const currentSide = project[sideName];
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
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const fit = Math.min((size.width - 130) / width, (size.height - 130) / height);
  const scale = Math.max(0.06, fit * zoom);
  const origin = { x: (size.width - width * scale) / 2 + pan.x, y: (size.height - height * scale) / 2 + pan.y };
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
  useEffect(() => { setPan({ x: 0, y: 0 }); setDraggedNode(null); }, [project.id, sideName]);
  useEffect(() => { setDraggedNode(null); }, [currentSide]);

  useEffect(() => {
    let current = true;
    renderEffects(project, side, 1).then(canvas => { if (current) setEffectImage(canvas); }).catch(() => {});
    return () => { current = false; };
  }, [project.widthMm, project.heightMm, project.material, side]);

  useEffect(() => {
    let current = true;
    if ((!regionMode && !highlightRegion) || !paintedRegion) {
      setRegionImage(undefined);
      return;
    }
    if (!regionMode) setRegionImage(undefined);
    renderRegionMask(project, side, paintedRegion, 1).then(mask => {
      const canvas = makeCanvas(mask.width, mask.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(mask, 0, 0);
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = '#55d7be';
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (current) setRegionImage(canvas);
    }).catch(() => {});
    return () => { current = false; };
  }, [project.widthMm, project.heightMm, side, paintedRegion, regionMode, highlightRegion]);

  useEffect(() => {
    let current = true;
    if (!plate) { setPlateImage(undefined); return; }
    renderCard(project, sideName, { plate }).then(canvas => { if (current) setPlateImage(canvas); }).catch(() => {});
    return () => { current = false; };
  }, [project, sideName, plate]);

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
    panStart.current = null;
  };
  const down = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const position = stageRef.current?.getPointerPosition();
    const point = cardPoint();
    if (!point || !position) return;
    if (tool === 'hand') {
      panStart.current = { x: position.x, y: position.y, ox: pan.x, oy: pan.y };
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
    if (event.target === event.target.getStage() || event.target.name() === 'card-ground') onSelect(null);
  };
  const move = () => {
    const point = cardPoint();
    const position = stageRef.current?.getPointerPosition();
    setPointer(point);
    if (panStart.current && position) {
      setPan({ x: panStart.current.ox + position.x - panStart.current.x, y: panStart.current.oy + position.y - panStart.current.y });
    }
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
    style={{ width: '100%', height: '100%', minHeight: 100, position: 'relative', overflow: 'hidden',
      touchAction: 'none', cursor: tool === 'hand' ? 'grab' : regionMode && ['brush', 'eraser'].includes(tool) ? 'none' : tool === 'geometry' ? 'crosshair' : 'default' }}>
    <Stage ref={stageRef} width={size.width} height={size.height} onMouseDown={down} onTouchStart={down}
      onMouseMove={move} onTouchMove={move} onMouseUp={finishStroke} onTouchEnd={finishStroke}
      onMouseLeave={() => { finishStroke(); setPointer(null); }}
      onWheel={event => { event.evt.preventDefault(); onZoom?.(Math.max(.25, Math.min(3, zoom * (event.evt.deltaY > 0 ? .94 : 1.06)))); }}>
      <Layer>
        <Group x={origin.x} y={origin.y} scaleX={scale} scaleY={scale}>
          <Rect name="card-ground" width={width} height={height} fill="#ffffff" cornerRadius={18}
            shadowColor="#000000" shadowOpacity={0.28} shadowBlur={34 / scale} shadowOffsetY={14 / scale} />
          <Group clipFunc={context => { context.beginPath(); context.roundRect(0, 0, width, height, 18); context.closePath(); }}>
            {currentSide.nodes.map(node => <ArtworkNode key={node.id} node={draggedNode?.id===node.id ? node : side.nodes.find(item=>item.id===node.id)||node}
              interactive={tool === 'select' && !regionMode && !plate}
              onSelect={() => onSelect(node.id)} onCommit={commitNode} onDrag={dragNode}
              onTransformPreview={setDraggedNode}
              onTextEdit={() => { if (node.type === 'text') onTextEdit?.(node.id); }} />)}
            {effectImage && !regionMode && !plate && <KonvaImage image={effectImage} width={width} height={height} listening={false} />}
            {plate && plateImage && <KonvaImage image={plateImage} width={width} height={height} listening={false} />}
            {regionMode && <Rect width={width} height={height} fill="#000000" opacity={.3} listening={false} />}
            {regionMode && activeRegion?.kind === 'polygon' && activeRegion.points?.map((value, i, points) =>
              i % 2 === 0 ? <Ellipse key={i} x={value} y={points[i+1]} radiusX={3 / scale} radiusY={3 / scale}
                fill="#a0ffdb" stroke="#264638" strokeWidth={1 / scale} listening={false}/> : null)}
            {(regionMode || highlightRegion) && regionImage && <KonvaImage image={regionImage} width={width} height={height} opacity={regionMode ? .65 : .32} listening={false} />}
          </Group>
          {showGuides && <>
            <Rect x={30} y={30} width={width - 60} height={height - 60} stroke="#7ae4c8" strokeWidth={1 / scale} dash={[4 / scale, 5 / scale]} listening={false} />
            <Rect x={-project.bleedMm * 10} y={-project.bleedMm * 10}
              width={width + project.bleedMm * 20} height={height + project.bleedMm * 20}
              stroke="#e69c8d" strokeWidth={1 / scale} dash={[4 / scale, 5 / scale]} listening={false} />
          </>}
          {snap.x && <Line points={[width / 2, -30, width / 2, height + 30]} stroke="#64dabc" strokeWidth={1 / scale} listening={false} />}
          {snap.y && <Line points={[-30, height / 2, width + 30, height / 2]} stroke="#64dabc" strokeWidth={1 / scale} listening={false} />}
          <Transformer ref={transformerRef} rotateEnabled={!regionMode} flipEnabled={false}
            borderStroke="#77d8c4" anchorStroke="#449a86" anchorFill="#ffffff" anchorSize={7}
            anchorCornerRadius={2} borderStrokeWidth={1} rotateAnchorOffset={24}
            boundBoxFunc={(oldBox, newBox) => Math.abs(newBox.width) < 10 || Math.abs(newBox.height) < 10 ? oldBox : newBox} />
          {regionMode && pointer && ['brush', 'eraser'].includes(tool) && <Ellipse
            x={pointer.x} y={pointer.y} radiusX={brushSize / 2} radiusY={brushSize / 2}
            stroke={tool === 'eraser' ? '#ffb19d' : '#ffffff'} strokeWidth={1.5 / scale}
            fill="rgba(255,255,255,.08)" listening={false} />}
        </Group>
      </Layer>
    </Stage>
    <div ref={cardBoundsRef} data-card-bounds aria-hidden="true"
      style={{ position: 'absolute', pointerEvents: 'none', left: origin.x, top: origin.y, width: width * scale, height: height * scale }} />
    <div style={{ position: 'absolute', left: origin.x, top: origin.y + height * scale + 20,
      width: width * scale, color: '#9a9a9a', fontSize: 11, display: 'flex', justifyContent: 'space-between', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
      <span>{sideName === 'front' ? '正面' : '背面'} · {project.widthMm} × {project.heightMm} mm</span>
      <span>{regionMode || highlightRegion ? '绿色为作用区域' : plate ? '生产工艺版' : '材质效果示意'}</span>
    </div>
  </div>;
}
