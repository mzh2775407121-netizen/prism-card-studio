import { PROCESS_LABELS, processKind, uid, type CardNode, type CardSide, type Effect, type ProcessKind, type Project, type Region } from './model';
import { findLayerGroup } from './layerGroups';

export type LayerKind = 'artwork' | ProcessKind;
export const LAYER_KINDS: [LayerKind, string][] = [
  ['varnish', PROCESS_LABELS.varnish],
  ['foil', PROCESS_LABELS.foil],
  ['reflection', PROCESS_LABELS.reflection],
  ['emboss', PROCESS_LABELS.emboss],
  ['deboss', PROCESS_LABELS.deboss],
  ['spot', PROCESS_LABELS.spot],
  ['artwork', '彩稿'],
  ['white', PROCESS_LABELS.white],
  ['primer', PROCESS_LABELS.primer],
];

const effectTypes = {
  varnish: 'gloss', foil: 'gold', reflection: 'holo', white: 'white',
  primer: 'gloss', spot: 'gloss', emboss: 'emboss', deboss: 'emboss',
} as const;

export function nextLayerName(side: CardSide) {
  const last = [...side.nodes, ...side.effects].reduce((max, { name }) => {
    const index = Number(/^图层\s*(\d{1,6})$/.exec(name)?.[1] || 0);
    return Math.max(max, index);
  }, 0);
  return '图层 ' + (last + 1);
}

export function createArtwork(side: CardSide, type: Exclude<CardNode['type'], 'empty'>): CardNode {
  return {
    id: uid(), name: nextLayerName(side), type,
    x: 0, y: 0, width: 1, height: 1, rotation: 0, visible: true, locked: false, fill: 'transparent', opacity: 1,
  };
}

const coversCard = (region: Region) => region.kind === 'full' && !region.inverted && !region.strokes.length;

export function fullCardRegion(side: CardSide): Region {
  return side.regions.find(coversCard)
    ?? { id: uid(), kind: 'full', name: '整张卡面', binding: 'fixed', inverted: false, strokes: [] };
}

export function makeProcess(kind: ProcessKind, region: Region, name: string, id: string = uid()): Effect {
  return {
    id, name, process: kind, type: effectTypes[kind], regionId: region.id,
    visible: true, opacity: kind === 'white' ? 1 : .45, angle: 45,
    ...(kind === 'reflection' && { flashStyle: 'geometric' }),
  };
}

function hasRegionContent(side: CardSide, region: Region): boolean {
  const byId = new Map(side.regions.map(item => [item.id, item]));
  const visited = new Set<string>();
  function hasContent(area: Region): boolean {
    if (visited.has(area.id)) return false;
    visited.add(area.id);
    const addsCoverage = area.strokes.some(stroke => stroke.erase === area.inverted &&
      (stroke.kind === 'selection' ? stroke.pathPoints.length >= 3 : stroke.points.length >= 2));
    if (area.inverted) return area.kind !== 'full' || addsCoverage;
    if (addsCoverage) return true;
    if (area.kind === 'paint') return false;
    if (area.kind === 'polygon') return (area.points?.length ?? 0) >= 6;
    if (area.kind === 'node') {
      const linked = side.nodes.find(node => node.id === area.nodeId);
      const shape = area.binding === 'fixed' ? area.snapshot ?? linked : linked;
      return shape ? shape.type !== 'empty' : Boolean(area.bounds);
    }
    if (area.kind === 'union') return area.sources?.some(id => {
      const source = byId.get(id);
      return source !== undefined && hasContent(source);
    }) ?? false;
    return true;
  }
  return hasContent(region);
}

export function classifyLayer(project: Project, side: CardSide, id: string, kind: LayerKind): CardSide {
  const node = side.nodes.find(item => item.id === id);
  const effect = side.effects.find(item => item.id === id);
  if (kind === 'artwork') {
    if (node) {
      if (node.type === 'empty' || !node.unclassified) return side;
      return { ...side, nodes: side.nodes.map(item => item.id === id ? { ...item, unclassified: undefined } : item) };
    }
    if (!effect) return side;
    const maskContents = effect.maskContent?.filter(item => item.type !== 'empty');
    if (maskContents?.length === 0) return side;
    const region = side.regions.find(item => item.id === effect.regionId);
    if (!region || !hasRegionContent(side, region)) return side;
    const clipRegionId = maskContents && coversCard(region) ? undefined : region.id;
    const contents: CardNode[] = maskContents ?? [{
      ...createArtwork(side, 'rect'), width: project.widthMm * 10, height: project.heightMm * 10, fill: '#2e3430',
    }];
    const groupId = findLayerGroup(side, effect.groupId)?.id ?? (contents.length > 1 ? uid() : contents[0]?.groupId);
    const nodes = contents.map((item, index) => ({
      ...item, id: index === contents.length - 1 ? id : uid(), name: index === contents.length - 1 ? effect.name : item.name,
      groupId, visible: effect.visible && item.visible, clipRegionId, unclassified: undefined,
    }));
    return { ...side, nodes: [...side.nodes, ...nodes], effects: side.effects.filter(item => item.id !== id) };
  }
  if (effect) {
    if (processKind(effect) === kind) return side;
    return { ...side, effects: side.effects.map(item => item.id === id
      ? { ...item, process: kind, type: effectTypes[kind], opacity: kind === 'white' ? 1 : item.opacity,
        ...(kind === 'reflection' && { flashStyle: item.flashStyle ?? 'geometric' }) }
      : item) };
  }
  if (!node || node.type === 'empty') return side;
  const region = side.regions.find(item => item.id === node.clipRegionId) ?? fullCardRegion(side);
  const regions = side.regions.map(item => item.nodeId === id
    ? { ...item, nodeId: undefined, binding: 'fixed' as const, snapshot: item.snapshot ?? node }
    : item);
  if (!regions.some(item => item.id === region.id)) regions.push(region);
  return {
    ...side, regions, nodes: side.nodes.filter(item => item.id !== id),
    effects: [...side.effects, {
      ...makeProcess(kind, region, node.name, id), visible: node.visible,
      groupId: findLayerGroup(side, node.groupId)?.id,
      maskContent: [{ ...node, clipRegionId: undefined, unclassified: undefined, visible: true }],
    }],
  };
}
