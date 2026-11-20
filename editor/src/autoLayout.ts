import { buildLayerTree, findLayerGroup, type LayerTreeItem } from './layerGroups';
import { cardTextLayout } from './render';
import type { AutoLayout, CardNode, CardSide, LayerGroup, LayoutDirection, LayoutSizeMode } from './model';

type Point = { x: number; y: number };
type Axis = 'width' | 'height';
type Bounds = Point & { width: number; height: number };
type Entry = { item: LayerTreeItem; bounds: Bounds; children: Entry[]; visible: boolean };

const MAX_SIZE = 100_000;
const size = (value: number) => Math.max(.001, Math.min(value, MAX_SIZE));
const epsilon = .000001;
const same = (a: number, b: number) => Math.abs(a - b) < epsilon;
const sameBounds = (a: Bounds, b: Bounds) =>
  same(a.x,b.x) && same(a.y,b.y) && same(a.width,b.width) && same(a.height,b.height);

function entryTree(side: CardSide): Entry[] {
  function visit(item: LayerTreeItem): Entry {
    if (item.kind === 'artwork') return { item, bounds: item.node, children: [], visible: item.node.visible };
    if (item.kind === 'process') return { item, bounds: {x:0,y:0,width:0,height:0}, children: [], visible: false };
    const children = item.children.map(visit);
    const available = children.filter(child => child.visible);
    const content = available.length ? available : children;
    const x = Math.min(...content.map(entry => entry.bounds.x));
    const y = Math.min(...content.map(entry => entry.bounds.y));
    const width = Math.max(...content.map(entry => entry.bounds.x + entry.bounds.width)) - x;
    const height = Math.max(...content.map(entry => entry.bounds.y + entry.bounds.height)) - y;
    return {
      item, children, visible: available.length > 0,
      bounds: item.group.autoLayout ?? (content.length ? {x,y,width,height} : {x:0,y:0,width:0,height:0}),
    };
  }
  return buildLayerTree(side,{process:false}).map(visit);
}

function findEntry(entries: Entry[], id: string): Entry | undefined {
  for (const entry of entries) {
    if (entry.item.id === id) return entry;
    const child = findEntry(entry.children, id);
    if (child) return child;
  }
  return undefined;
}

function entryLayout(entry: Entry) {
  return entry.item.kind === 'group' ? entry.item.group.autoLayout : undefined;
}

function childMode(entry: Entry, axis: Axis, managed: boolean): LayoutSizeMode | undefined {
  if (!managed) return undefined;
  const item = entry.item;
  const sizing = item.kind === 'artwork' ? item.node.layoutItem : item.kind === 'group' ? item.group.layoutItem : undefined;
  const mode = axis === 'width' ? sizing?.widthMode : sizing?.heightMode;
  if (!mode && axis === 'height' && item.kind === 'artwork' && item.node.type === 'text') return 'hug';
  return mode;
}

function groupMode(entry: Entry, layout: AutoLayout, axis: Axis, managed: boolean) {
  const mode = childMode(entry, axis, managed);
  if (mode === 'fixed' || mode === 'hug') return mode;
  return axis === 'width' ? layout.widthMode : layout.heightMode;
}

function along(layout: AutoLayout, axis: Axis) {
  return axis === 'width' ? layout.direction === 'horizontal' : layout.direction === 'vertical';
}

function padding(layout: AutoLayout, axis: Axis) {
  return axis === 'width' ? layout.padding.left + layout.padding.right : layout.padding.top + layout.padding.bottom;
}

function gaps(layout: AutoLayout, count: number) {
  return layout.gap * Math.max(0,count - 1);
}

function fit(layout: AutoLayout, axis: Axis, childSizes: number[]) {
  const content = along(layout, axis)
    ? childSizes.reduce((sum,value) => sum + value, gaps(layout,childSizes.length))
    : Math.max(0,...childSizes);
  return size(content + padding(layout,axis));
}

function allocate(layout: AutoLayout, axis: Axis, total: number, fixed: boolean, children: Entry[], natural: number[]) {
  const fills = children.map(child => fixed && childMode(child,axis,true) === 'fill' &&
    (child.item.kind === 'artwork' || Boolean(entryLayout(child))));
  const count = fills.filter(Boolean).length;
  if (!count) return {sizes:natural,fills};
  let available = total - padding(layout,axis);
  if (along(layout,axis)) {
    natural.forEach((value,index) => { if (!fills[index]) available -= value; });
    available = (available - gaps(layout,children.length)) / count;
  }
  return {sizes:natural.map((value,index) => fills[index] ? size(available) : value),fills};
}

let measurementContext: CanvasRenderingContext2D | null | undefined;

function contextForText() {
  if (measurementContext === undefined && typeof document !== 'undefined') {
    measurementContext = document.createElement('canvas').getContext('2d');
  }
  return measurementContext;
}

function textWidth(node: CardNode) {
  const context = contextForText();
  if (!context) return node.width;
  const {font,inset} = cardTextLayout(context,{ ...node, text: '', width: MAX_SIZE });
  context.save();
  try {
    context.font = font;
    context.letterSpacing = `${node.letterSpacing ?? 0}px`;
    const width = Math.max(0,...(node.text || '').split('\n').map(line => context.measureText(line).width));
    // Round upward so measuring and wrapping cannot disagree at a glyph boundary.
    return size(Math.ceil((width + inset * 2 + epsilon) * 1000) / 1000);
  } finally {
    context.restore();
  }
}

function textHeight(node: CardNode, width: number) {
  const context = contextForText();
  return context ? size(cardTextLayout(context,{...node,width}).contentHeight) : node.height;
}

function measureFree(entry: Entry, axis: Axis, measure: (child: Entry) => number) {
  const children = entry.children.filter(child => child.visible);
  if (!children.length) return entry.bounds[axis];
  const position = axis === 'width' ? 'x' : 'y';
  return Math.max(...children.map(child => child.bounds[position] + measure(child))) - entry.bounds[position];
}

/** Arrange managed groups in document coordinates. Artwork retains final coordinates for masks and all export paths. */
export function applyAutoLayout(side: CardSide, previousOrigin?: Point & { id: string }): CardSide {
  if (!side.groups?.some(group => group.autoLayout)) return side;
  const roots = entryTree(side);
  const nodes = new Map<string, CardNode>();
  const frames = new Map<string, AutoLayout>();
  const widthCache = new Map<Entry,number>();
  const heightCache = new Map<Entry,{width:number;fixedWidth:boolean;height:number}>();

  function preferredWidth(entry: Entry, managed: boolean): number {
    const cached = widthCache.get(entry);
    if (cached !== undefined) return cached;
    const layout = entryLayout(entry);
    let width = entry.bounds.width;
    if (layout && entry.visible && groupMode(entry,layout,'width',managed) === 'hug') {
      width = fit(layout,'width',entry.children.filter(child => child.visible).map(child => preferredWidth(child,true)));
    } else if (!layout && entry.item.kind === 'group') {
      width = measureFree(entry,'width',child => preferredWidth(child,false));
    } else if (entry.item.kind === 'artwork' && entry.item.node.type === 'text' && childMode(entry,'width',managed) === 'hug') {
      width = textWidth(entry.item.node);
    }
    widthCache.set(entry,width);
    return width;
  }

  function widths(entry: Entry, layout: AutoLayout, children: Entry[], width: number, managed: boolean, forced: boolean) {
    return allocate(layout, 'width', width, forced || groupMode(entry,layout,'width',managed) === 'fixed',
      children, children.map(child => preferredWidth(child,true)));
  }

  function preferredHeight(entry: Entry, width: number, managed: boolean, fixedWidth = false): number {
    const cached = heightCache.get(entry);
    if (cached?.width === width && cached.fixedWidth === fixedWidth) return cached.height;
    const layout = entryLayout(entry);
    let height = entry.bounds.height;
    if (layout && entry.visible && groupMode(entry,layout,'height',managed) === 'hug') {
      const children = entry.children.filter(child => child.visible);
      const horizontal = widths(entry,layout,children,width,managed,fixedWidth);
      height = fit(layout,'height',children.map((child,index) =>
        preferredHeight(child,horizontal.sizes[index],true,horizontal.fills[index])));
    } else if (!layout && entry.item.kind === 'group') {
      height = measureFree(entry,'height',child => preferredHeight(child,preferredWidth(child,false),false));
    } else if (entry.item.kind === 'artwork' && entry.item.node.type === 'text' && childMode(entry,'height',managed) === 'hug') {
      height = textHeight(entry.item.node,width);
    }
    heightCache.set(entry,{width,fixedWidth,height});
    return height;
  }

  function place(entry: Entry, rectangle: Bounds, managed: boolean, fixedWidth = false, fixedHeight = false) {
    const { item, bounds } = entry;
    const originalOrigin = previousOrigin?.id === item.id ? previousOrigin : bounds;
    const {x,y,width,height} = rectangle;
    if (item.kind === 'artwork') {
      if (!sameBounds(item.node,rectangle)) nodes.set(item.id,{...item.node,...rectangle});
      return;
    }
    if (item.kind !== 'group') return;
    const layout = item.group.autoLayout;
    if (layout && !sameBounds(layout,rectangle)) frames.set(item.id,{...layout,...rectangle});
    if (!layout || !entry.visible) {
      const dx = x - originalOrigin.x, dy = y - originalOrigin.y;
      for (const child of entry.children) {
        const childWidth = preferredWidth(child,false);
        place(child,{ x:child.bounds.x + dx,y:child.bounds.y + dy,
          width:childWidth,height:preferredHeight(child,childWidth,false) },false);
      }
      return;
    }
    const children = entry.children.filter(child => child.visible);
    const horizontalSizing = widths(entry,layout,children,width,managed,fixedWidth);
    const verticalSizing = allocate(layout,'height',height,fixedHeight || groupMode(entry,layout,'height',managed) === 'fixed',children,
      children.map((child,index) => preferredHeight(child,horizontalSizing.sizes[index],true,horizontalSizing.fills[index])));
    const horizontal = layout.direction === 'horizontal';
    const align = layout.align === 'center' ? .5 : layout.align === 'end' ? 1 : 0;
    let shift = 0;
    children.forEach((child,index) => {
      const childWidth = horizontalSizing.sizes[index], childHeight = verticalSizing.sizes[index];
      const leftover = horizontal
        ? height - padding(layout,'height') - childHeight
        : width - padding(layout,'width') - childWidth;
      const cross = Math.max(0,leftover) * align;
      place(child,{ x:x + layout.padding.left + (horizontal ? shift : cross),
        y:y + layout.padding.top + (horizontal ? cross : shift),width:childWidth,height:childHeight },true,
      horizontalSizing.fills[index],verticalSizing.fills[index]);
      shift += (horizontal ? childWidth : childHeight) + layout.gap;
    });
    // Hidden children do not consume space, but they still follow a whole-frame translation.
    for (const child of entry.children) if (!child.visible) {
      place(child,{...child.bounds,x:child.bounds.x + x - originalOrigin.x,y:child.bounds.y + y - originalOrigin.y},false);
    }
  }

  for (const root of roots) if (root.item.kind === 'group') {
    const width = preferredWidth(root,false);
    place(root,{...root.bounds,width,height:preferredHeight(root,width,false)},false);
  }
  if (!nodes.size && !frames.size) return side;
  const before = new Map(side.nodes.map(node => [node.id,node]));
  return {
    ...side,
    nodes: side.nodes.map(node => nodes.get(node.id) ?? node),
    groups: side.groups.map(group => frames.has(group.id) ? { ...group, autoLayout: frames.get(group.id) } : group),
    regions: side.regions.map(region => {
      const source = region.nodeId && nodes.has(region.nodeId) ? before.get(region.nodeId) : undefined;
      // Legacy fixed contours may reference a node without retaining their original shape.
      return source && region.kind === 'node' && region.binding === 'fixed' && !region.snapshot
        ? {...region,snapshot:source} : region;
    }),
  };
}

/** Read the initial frame from the selected artwork's existing coordinates. */
export function createAutoLayout(side: CardSide, groupId: string, direction: LayoutDirection = 'vertical'): AutoLayout | undefined {
  const entry = findEntry(entryTree(side), groupId);
  if (entry?.item.kind !== 'group' || !entry.visible) return undefined;
  const {x,y,width,height} = entry.bounds;
  return { x,y,width:size(width),height:size(height),direction,
    widthMode: direction === 'vertical' ? 'fixed' : 'hug',heightMode:'hug',
    gap:10,padding:{top:0,right:0,bottom:0,left:0},align:'start' };
}

export function setAutoLayout(side: CardSide, groupId: string, layout: AutoLayout | undefined): CardSide {
  const groups = side.groups;
  const group = findLayerGroup(side, groupId);
  if (!groups || !group || (!layout && !group.autoLayout)) return side;
  let nodes = side.nodes;
  let previousOrigin = group.autoLayout;
  if (layout && !group.autoLayout) {
    const entry = findEntry(entryTree(side), groupId);
    if (!entry?.children.length) return side;
    previousOrigin = layout && {...layout,x:entry.bounds.x,y:entry.bounds.y};
    const primary = layout.direction === 'horizontal' ? 'x' : 'y';
    const secondary = primary === 'x' ? 'y' : 'x';
    const sorted = [...entry.children].sort((a,b) => a.bounds[primary] - b.bounds[primary] ||
      a.bounds[secondary] - b.bounds[secondary]);
    const items = new Map<string,number>();
    function index(child: Entry, order: number) {
      if (child.item.kind === 'artwork') items.set(child.item.id,order);
      else child.children.forEach(nested => index(nested,order));
    }
    sorted.forEach(index);
    // LayerTree reads the stacking array back to front, so arrange siblings in reverse there.
    const ordered = side.nodes.filter(node => items.has(node.id)).sort((a,b) => items.get(b.id)! - items.get(a.id)!);
    let position = 0;
    nodes = side.nodes.map(node => items.has(node.id) ? ordered[position++] : node);
  }
  return applyAutoLayout({ ...side, nodes, groups: groups.map(item => item.id === groupId
    ? { ...item, autoLayout: layout } : item) }, layout && previousOrigin
    ? {id:groupId,x:previousOrigin.x,y:previousOrigin.y} : undefined);
}

export function layoutParent(side: CardSide, id: string): LayerGroup | undefined {
  if (!side.groups?.length) return undefined;
  const owner = side.nodes.find(node => node.id === id)?.groupId ?? side.groups.find(group => group.id === id)?.parentId;
  const parent = owner && side.groups.find(group => group.id === owner);
  return parent && parent.autoLayout ? parent : undefined;
}

export function scaleAutoLayout(layout: AutoLayout, sx: number, sy: number, dx = 0, dy = 0): AutoLayout {
  return {
    ...layout, x:layout.x * sx + dx, y:layout.y * sy + dy,
    width: size(layout.width * sx), height: size(layout.height * sy),
    gap: layout.gap * (layout.direction === 'horizontal' ? sx : sy),
    padding: { top:layout.padding.top * sy,right:layout.padding.right * sx,
      bottom:layout.padding.bottom * sy,left:layout.padding.left * sx },
  };
}
