import type Konva from 'konva';
import { Circle, Group, Line, Rect, Shape } from 'react-konva';
import type { CardNode, PathCoordinate, PathPoint, SideName } from './model';
import { ellipsePath, mapVectorPoints, MAX_PATH_POINTS, normalizeContours, rectanglePath, splitPathSegment, traceVectorPath } from './vectorPaths';

export interface PathEditDraft {
  projectId: string;
  face: SideName;
  id: string;
  points: PathPoint[];
  closed: boolean;
  selected: number | null;
  dirty: boolean;
  outlines?: PathPoint[][];
  activeOutline?: number;
}

export function pathDraft(node: CardNode) {
  if (node.pathPoints) {
    const outlines = [node.pathPoints,...node.contours ?? []].map(points =>
      mapVectorPoints(points, point => ({ x: point.x * node.width, y: point.y * node.height })));
    return { points:outlines[0], outlines:outlines.length>1 ? outlines : undefined, activeOutline:0, closed:!!node.pathClosed };
  }
  if (node.type === 'rect') return { points: rectanglePath(0, 0, node.width, node.height, node.cornerRadius), closed: true };
  if (node.type === 'ellipse') return { points: ellipsePath(node.width / 2, node.height / 2, node.width / 2, node.height / 2), closed: true };
  if (node.type === 'polygon' && node.polygon) return {
    points: node.polygon.filter((_, index) => index % 2 === 0).map((x, index) => ({
      x: x * node.width, y: node.polygon![index * 2 + 1] * node.height,
    })), closed: true,
  };
  return undefined;
}

export function editedPath(node: CardNode, draft: PathEditDraft): CardNode {
  const geometry = normalizeContours(draft.outlines
    ? draft.outlines.map((outline,i)=>i===draft.activeOutline?draft.points:outline) : [draft.points]);
  const dx = node.flipX ? node.width - geometry.width - geometry.x : geometry.x;
  const dy = node.flipY ? node.height - geometry.height - geometry.y : geometry.y;
  const radians = node.rotation * Math.PI / 180;
  return {
    ...node,
    type: 'path',
    pathClosed: draft.closed,
    pathPoints: geometry.pathPoints,
    contours: geometry.contours,
    polygon: undefined,
    cornerRadius: undefined,
    width: geometry.width, height: geometry.height,
    x: node.x + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: node.y + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

type Handle = 'in' | 'out';

export function movePathPoint(point: PathPoint, position: PathCoordinate, handle?: Handle): PathPoint {
  if (handle) {
    const opposite = handle === 'in' ? 'out' : 'in';
    const next = { ...point, [handle]: position };
    if (point.in && point.out) {
      const ax = point.in.x - point.x, ay = point.in.y - point.y;
      const bx = point.out.x - point.x, by = point.out.y - point.y;
      const axLength = Math.hypot(ax, ay), bxLength = Math.hypot(bx, by);
      const stillSmooth = Math.abs(ax * by - ay * bx) <= .00001 * axLength * bxLength && ax * bx + ay * by < 0;
      const distance = Math.hypot(position.x - point.x, position.y - point.y);
      if (stillSmooth && distance) {
        const ratio = (opposite === 'in' ? axLength : bxLength) / distance;
        next[opposite] = { x: point.x + (point.x - position.x) * ratio, y: point.y + (point.y - position.y) * ratio };
      }
    }
    return next;
  }
  const moveHandle = (handle?: PathCoordinate) => handle && ({
    x: handle.x + position.x - point.x, y: handle.y + position.y - point.y,
  });
  return { ...position, in: moveHandle(point.in), out: moveHandle(point.out) };
}

export function editPathSegment(draft: PathEditDraft, index: number) {
  if (draftPointCount(draft) >= MAX_PATH_POINTS) return draft;
  return { ...draft, selected: index + 1, dirty: true, points: splitPathSegment(draft.points, index) };
}

function draftPointCount(draft:PathEditDraft) {
  return draft.points.length + (draft.outlines ?? []).reduce((sum,p,i)=>sum+(i===draft.activeOutline?0:p.length),0);
}

export function splitSegmentIndex(draft: PathEditDraft) {
  if (draft.selected === null) return 0;
  if (draft.closed || draft.selected < draft.points.length - 1) return draft.selected;
  return draft.selected - 1;
}

export function PathNodes({ draft, node, scale, onSelect, onMove, onInsert, interactive }: {
  draft: PathEditDraft;
  node: CardNode;
  scale: number;
  onSelect: (index: number) => void;
  onMove: (index: number, position: PathCoordinate, handle?: Handle) => void;
  onInsert: (index: number) => void;
  interactive: boolean;
}) {
  const accent = '#237ac2', focus = '#69b5f6';
  const stop = (event: Konva.KonvaEventObject<Event>) => { event.cancelBubble = true; };
  const drag = (index: number, handle?: Handle) => (event: Konva.KonvaEventObject<DragEvent>) => {
    stop(event);
    onMove(index, event.target.position(), handle);
  };
  const segmentAt = (index: number) => (context: Konva.Context) => {
    const from = draft.points[index], to = draft.points[(index + 1) % draft.points.length];
    const raw = context._context;
    raw.beginPath();
    traceVectorPath(raw, [from, to], 1, 1);
    raw.strokeStyle = focus; raw.lineWidth = 1.4 / scale; raw.stroke();
  };
  return <Group name="path-node-handles" x={node.x} y={node.y} rotation={node.rotation} listening={interactive}>
    <Group x={node.flipX ? node.width : 0} y={node.flipY ? node.height : 0}
      scaleX={node.flipX ? -1 : 1} scaleY={node.flipY ? -1 : 1}>
      {draft.points.slice(0, draft.closed ? undefined : -1).map((point, index) =>
        <Shape key={index} sceneFunc={segmentAt(index)}
          hitFunc={(context, shape) => {
            const to = draft.points[(index + 1) % draft.points.length];
            context.beginPath(); traceVectorPath(context, [point, to], 1, 1); context.strokeShape(shape);
          }}
          stroke={focus} strokeWidth={1.4 / scale} hitStrokeWidth={9 / scale}
          onMouseDown={stop} onTouchStart={stop} onDblClick={event => { stop(event); onInsert(index); }}
          onDblTap={event => { stop(event); onInsert(index); }}/>)}
      {draft.points.map((point, index) => index === draft.selected &&
        (['in', 'out'] as const).map(side => {
          const handle = point[side];
          if (!handle || (side === 'in' && !draft.closed && index === 0) ||
            (side === 'out' && !draft.closed && index === draft.points.length - 1)) return null;
          return <Group key={side}>
            <Line points={[point.x, point.y, handle.x, handle.y]} stroke={focus} strokeWidth={1 / scale} listening={false}/>
            <Circle name={"path-"+side+"-"+index} x={handle.x} y={handle.y} radius={3.8 / scale}
              fill="#ffffff" stroke={accent} strokeWidth={1 / scale} hitStrokeWidth={8 / scale} draggable={interactive}
              onMouseDown={stop} onTouchStart={stop} onDragStart={stop} onDragMove={drag(index, side)} onDragEnd={stop}/>
          </Group>;
        }))}
      {draft.points.map((point, index) => {
        const select = (event: Konva.KonvaEventObject<Event>) => { stop(event); onSelect(index); };
        return <Rect key={index} name={"path-anchor-"+index} x={point.x} y={point.y} width={8 / scale} height={8 / scale}
          offsetX={4 / scale} offsetY={4 / scale} cornerRadius={1.5 / scale}
          fill={index === draft.selected ? focus : '#ffffff'} stroke={accent} strokeWidth={1 / scale}
          hitStrokeWidth={8 / scale} draggable={interactive} onMouseDown={select} onTouchStart={select}
          onDragStart={select} onDragMove={drag(index)} onDragEnd={stop}/>;
      })}
    </Group>
  </Group>;
}

export function PathNodeActions({ draft, onAdd, onRemove, onCorner, onSmooth, onToggle, onOutline, onApply, onCancel }: {
  draft: PathEditDraft; onAdd: () => void; onRemove: () => void; onCorner: () => void; onSmooth: () => void;
  onToggle: () => void; onOutline:(index:number)=>void; onApply: () => void; onCancel: () => void;
}) {
  const minimum = draft.closed ? 3 : 2;
  const pointCount = draftPointCount(draft);
  return <div className="path-node-actions" role="group" aria-label="路径节点">
    {draft.outlines && <select aria-label="编辑轮廓" value={draft.activeOutline} onChange={e=>onOutline(Number(e.target.value))}>
      {draft.outlines.map((_,index)=><option key={index} value={index}>轮廓 {index+1}</option>)}
    </select>}
    <span aria-live="polite">{draft.points.length} 个节点</span>
    <button onClick={onAdd} disabled={pointCount >= MAX_PATH_POINTS} title="在选中线段上加点">加点</button>
    <button onClick={onRemove} disabled={draft.selected === null || draft.points.length <= minimum} title="删除节点 · Delete">删点</button>
    <button onClick={onCorner} disabled={draft.selected === null}>直角</button>
    <button onClick={onSmooth} disabled={draft.selected === null}>平滑</button>
    {!draft.outlines && <button onClick={onToggle} disabled={!draft.closed && draft.points.length < 3}>{draft.closed ? '开放' : '闭合'}</button>}
    <button onClick={onCancel} title="取消 · Esc">取消</button>
    <button className="path-node-apply" onClick={onApply} disabled={draft.points.length < minimum} title="完成 · Enter">完成</button>
  </div>;
}
