import { uid, type CardNode, type CardSide, type LayerGroup, type Project, type Region, type SideName } from './model';
import { findLayerGroup, layerGroupAncestors, layerGroupMembers, pruneLayerGroups, type LayerUnitRef } from './layerGroups';
import { applyAutoLayout, layoutParent, offsetLayoutItem } from './autoLayout';
import { mapVectorPoints } from './vectorPaths';

type Point = { x: number; y: number };
type Transfer = { project: Project; layerId: string; groupId?: string };

function availableId(used: Set<string>, preferred: string) {
  let id = preferred;
  while (used.has(id)) id = uid();
  used.add(id);
  return id;
}

function layerIds(side: CardSide) {
  return new Set([...side.nodes.map(node => node.id), ...side.effects.map(effect => effect.id),
    ...(side.groups || []).map(group => group.id)]);
}

function translate<T extends Point>(value: T, delta: Point): T {
  return { ...value, x: value.x + delta.x, y: value.y + delta.y };
}

function translatePoints(points: number[], delta: Point) {
  return points.map((value, index) => value + (index % 2 ? delta.y : delta.x));
}

function copyRegions(project: Project, origin: CardSide, target: CardSide, delta: Point, moved = new Map<string, string>(), moveCardRegions = false,
  motion?: { reusable: Set<string> }) {
  const regions = [...target.regions];
  const positions = new Map(regions.map((region, index) => [region.id, index]));
  const originals = new Map(origin.regions.map(region => [region.id, region]));
  const nodes = new Map(origin.nodes.map(node => [node.id, node]));
  const ids = new Map<string, string>();
  const used = new Set(target.regions.map(region => region.id));

  function copy(id?: string): string | undefined {
    if (!id) return undefined;
    const existing = ids.get(id);
    if (existing) return existing;
    const region = originals.get(id);
    if (!region) return undefined;
    // Register before visiting dependencies since node contours can have masks of their own.
    const newId = motion?.reusable.has(id) ? id : availableId(used, uid());
    ids.set(id, newId);
    const linked = region.nodeId ? nodes.get(region.nodeId) : undefined;
    const movedId = region.nodeId ? moved.get(region.nodeId) : undefined;
    const following = region.kind === 'node' && region.binding === 'follow' && movedId !== undefined;
    const snapshot = region.kind === 'node' && !following
      ? (region.binding === 'fixed' ? region.snapshot || linked : linked)
      : undefined;
    const implicitBounds = region.kind === 'rect' || region.kind === 'ellipse'
      ? { x: 80, y: 160, width: project.widthMm * 10 - 160, height: project.heightMm * 10 - 320, rotation: 0 }
      : undefined;
    const bounds = region.bounds ?? implicitBounds;
    // A whole-card area and the preset border have implicit page coordinates. Once a
    // group moves them, materialize those coordinates so they move with the group.
    const pageShape: Partial<Region> = !moveCardRegions ? {} : region.kind === 'full'
      ? { kind: 'rect', bounds: { x: delta.x, y: delta.y, width: project.widthMm * 10, height: project.heightMm * 10, rotation: 0 } }
      : region.kind === 'border' ? { kind: 'polygon', points: translatePoints([
        16, 16, project.widthMm * 10 - 16, 16,
        project.widthMm * 10 - 16, project.heightMm * 10 - 16, 16, project.heightMm * 10 - 16, 16, 16,
        25, 25, 25, project.heightMm * 10 - 25,
        project.widthMm * 10 - 25, project.heightMm * 10 - 25, project.widthMm * 10 - 25, 25, 25, 25,
      ], delta) } : {};
    const copied: Region = {
      ...region,
      id: newId,
      ...(motion ? { groupMotionCopy: true as const } : {}),
      binding: following ? 'follow' : 'fixed',
      nodeId: following ? movedId : undefined,
      bounds: bounds && translate(bounds, delta),
      snapshot: snapshot && {
        ...translate(snapshot, delta),
        clipRegionId: copy(snapshot.clipRegionId),
      },
      points: region.points && translatePoints(region.points, delta),
      strokes: region.strokes.map(stroke => stroke.kind === 'selection'
        ? { ...stroke, pathPoints: mapVectorPoints(stroke.pathPoints, point => translate(point, delta)) }
        : { ...stroke, points: translatePoints(stroke.points, delta) }),
      sources: region.sources?.map(copy).filter((source): source is string => source !== undefined),
      ...pageShape,
    };
    const position = positions.get(newId);
    if (position !== undefined) regions[position] = copied;
    else regions.push(copied);
    return newId;
  }
  return { regions, copy, ids };
}

export function frozenRegionCopies(project: Project, side: CardSide, id: string) {
  const copies = copyRegions(project, side, {...side, regions:[]}, {x:0,y:0});
  const root = copies.copy(id);
  if (!root || side.regions.length - 1 + copies.regions.length > 1000 ||
    copies.regions.some(region=>region.kind==='node' && !region.snapshot && !region.bounds || region.kind==='union' && !region.sources?.length)) return;
  return {root,regions:copies.regions.map(region=>region.id===root?{...region,name:region.name.slice(0,94)+' · 固定'}:region)};
}

function preserveSourceContours(regions: Region[], movedNodes: CardNode[], except = new Set<string>()): Region[] {
  const originals = new Map(movedNodes.map(node => [node.id, node]));
  return regions.map(region => {
    const linked = region.nodeId ? originals.get(region.nodeId) : undefined;
    if (region.kind !== 'node' || !linked || except.has(region.id)) return region;
    // Other layers keep the original contour, including its original mask chain.
    return { ...region, binding: 'fixed', nodeId: undefined,
      snapshot: region.binding === 'fixed' ? region.snapshot || linked : linked,
      bounds: region.binding === 'fixed' ? region.bounds : undefined };
  });
}

function reusableMotionRegions(side: CardSide, artworkIds: Set<string>, effectIds: Set<string>) {
  const regions = new Map(side.regions.map(region => [region.id, region]));
  const nodes = new Map(side.nodes.map(node => [node.id, node]));
  const references = (region: Region) => {
    const contour = region.kind === 'node'
      ? region.binding === 'fixed' ? region.snapshot || nodes.get(region.nodeId || '') : nodes.get(region.nodeId || '')
      : undefined;
    return [...(region.sources || []), region.snapshot?.clipRegionId, contour?.clipRegionId];
  };
  const reach = (roots: (string | undefined)[]) => {
    const seen = new Set<string>(), pending = [...roots];
    while (pending.length) {
      const id = pending.pop();
      if (!id || seen.has(id)) continue;
      const region = regions.get(id);
      if (!region) continue;
      seen.add(id); pending.push(...references(region));
    }
    return seen;
  };
  const roots = (inside: boolean) => [
    ...side.nodes.filter(node => artworkIds.has(node.id) === inside).map(node => node.clipRegionId),
    ...side.effects.filter(effect => effectIds.has(effect.id) === inside)
      .flatMap(effect => [effect.regionId, ...(effect.maskContent || []).map(node => node.clipRegionId)]),
  ];
  const owned = reach(roots(true));
  // Original named areas remain a reusable library, even when no layer currently
  // uses them. Protect their dependencies as well as every outside reader.
  const shared = reach([...roots(false), ...side.regions
    .filter(region => !region.groupMotionCopy || !owned.has(region.id)).map(region => region.id)]);
  return new Set([...owned].filter(id => regions.get(id)?.groupMotionCopy && !shared.has(id)));
}

function transferProduction(project: Project, from: SideName, to: SideName, effects: Map<string, string>) {
  if (!project.production || !effects.size) return project.production;
  const targetIds = new Set([...effects.values()].map(id => `${to}:layer:${id}`));
  const sourceIds = new Map([...effects].map(([source, target]) => [`${from}:layer:${source}`, target]));
  return { ...project.production, steps: project.production.steps
    .filter(step => !targetIds.has(step.id))
    .map(step => {
      const id = sourceIds.get(step.id);
      return id ? { ...step, id: `${to}:layer:${id}`, face: to, layerId: id } : step;
    }) };
}

/** Move a registered mixed group on its current face without changing outside mask users. */
export function moveArtworkGroup(project: Project, face: SideName, groupId: string, movement: Point,
  options: { previewAcrossFaces?: boolean } = {},
): CardSide | undefined {
  const side = project[face];
  const group = findLayerGroup(side, groupId);
  if (!group || side.canvasLocked || !Number.isFinite(movement.x) || !Number.isFinite(movement.y)) return undefined;
  const members = layerGroupMembers(side, groupId);
  const artworkIds = new Set(members.artworkIds), effectIds = new Set(members.effectIds);
  const nodes = side.nodes.filter(node => artworkIds.has(node.id));
  if (nodes.some(node => node.locked)) return undefined;
  const availableRegions = new Set(side.regions.map(region => region.id));
  if (side.effects.some(effect => effectIds.has(effect.id) && !availableRegions.has(effect.regionId))) return undefined;
  const managed = !options.previewAcrossFaces && Boolean(layoutParent(side, groupId));
  const layoutItem = managed ? offsetLayoutItem(group.layoutItem, movement) : group.layoutItem;
  const delta = managed ? {
    x: (layoutItem?.offset?.x ?? 0) - (group.layoutItem?.offset?.x ?? 0),
    y: (layoutItem?.offset?.y ?? 0) - (group.layoutItem?.offset?.y ?? 0),
  } : movement;
  if (!delta.x && !delta.y) return side;
  const moved = new Map(nodes.map(node => [node.id, node.id]));
  const masks = copyRegions(project, side, side, delta, moved, true,
    { reusable: reusableMotionRegions(side, artworkIds, effectIds) });
  const nextNodes = side.nodes.map(node => artworkIds.has(node.id)
    ? { ...translate(node, delta), clipRegionId: masks.copy(node.clipRegionId) } : node);
  const effects = side.effects.map(effect => effectIds.has(effect.id) ? {
    ...effect, regionId: masks.copy(effect.regionId)!,
    maskContent: effect.maskContent?.map(node => ({ ...translate(node, delta), clipRegionId: masks.copy(node.clipRegionId) })),
  } : effect);
  const groupIds = new Set(members.groups.map(item => item.id));
  const groups = side.groups?.map(item => groupIds.has(item.id) && (item.autoLayout || item.id === groupId && managed)
    ? { ...item,
      ...(item.autoLayout ? { autoLayout: translate(item.autoLayout, delta) } : {}),
      ...(item.id === groupId && managed ? { layoutItem } : {}),
    } : item);
  return { ...side, nodes: nextNodes, effects, groups,
    regions: preserveSourceContours(masks.regions, nodes, new Set(masks.ids.values())) };
}

export function moveCanvasLayerUnits(project: Project, face: SideName, units: LayerUnitRef[], delta: Point): CardSide {
  const side = project[face];
  if (side.canvasLocked || !Number.isFinite(delta.x) || !Number.isFinite(delta.y) || (!delta.x && !delta.y)) return side;
  const groups = new Set(units.filter(unit => unit.kind === 'group').map(unit => unit.id));
  const covered = (id?: string) => layerGroupAncestors(side, id).some(group => groups.has(group.id));
  let next = side;
  for (const id of groups) {
    if (!covered(findLayerGroup(side, id)?.parentId)) {
      next = moveArtworkGroup({ ...project, [face]: next }, face, id, delta) ?? next;
    }
  }
  const artwork = new Set(units.filter(unit => unit.kind === 'artwork').map(unit => unit.id));
  const moved = next.nodes.filter(node => artwork.has(node.id) && node.visible && !node.locked && !covered(node.groupId));
  if (!moved.length) return next === side ? side : applyAutoLayout(next);
  const ids = new Set(moved.map(node => node.id));
  return applyAutoLayout({ ...next, nodes: next.nodes.map(node => !ids.has(node.id) ? node
    : layoutParent(side, node.id) ? { ...node, layoutItem: offsetLayoutItem(node.layoutItem, delta) }
      : translate(node, delta)) });
}

/** Atomically transfer a registered group, including nested groups and process layers. */
export function transferGroup(project: Project, from: SideName, to: SideName, groupId: string, delta: Point = { x: 0, y: 0 }): Transfer | undefined {
  const origin = project[from], target = project[to];
  if (from === to || !findLayerGroup(origin, groupId) || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return undefined;
  const members = layerGroupMembers(origin, groupId);
  const artworkIds = new Set(members.artworkIds), effectIds = new Set(members.effectIds);
  const nodes = origin.nodes.filter(node => artworkIds.has(node.id));
  const effects = origin.effects.filter(effect => effectIds.has(effect.id));
  if ((!nodes.length && !effects.length) || nodes.some(node => node.locked)) return undefined;
  const availableRegions = new Set(origin.regions.map(region => region.id));
  if (effects.some(effect => !availableRegions.has(effect.regionId))) return undefined;
  const used = layerIds(target);
  const moved = new Map(nodes.map(node => [node.id, availableId(used, node.id)]));
  const movedEffects = new Map(effects.map(effect => [effect.id, availableId(used, effect.id)]));
  const usedGroups = new Set([
    ...used,
    ...(target.groups || []).map(group => group.id),
    ...target.nodes.flatMap(node => node.groupId ? [node.groupId] : []),
    ...target.effects.flatMap(effect => effect.groupId ? [effect.groupId] : []),
  ]);
  const groups = new Map(members.groups.map(group => [group.id, availableId(usedGroups, group.id)]));
  const masks = copyRegions(project, origin, target, delta, moved, true);
  const incoming = nodes.map(node => ({ ...translate(node, delta), id: moved.get(node.id)!,
    groupId: node.groupId && groups.get(node.groupId), clipRegionId: masks.copy(node.clipRegionId) }));
  const incomingEffects = effects.map(effect => ({ ...effect, id: movedEffects.get(effect.id)!,
    groupId: effect.groupId && groups.get(effect.groupId), regionId: masks.copy(effect.regionId)!,
    maskContent: effect.maskContent?.map(node => ({ ...translate(node, delta), clipRegionId: masks.copy(node.clipRegionId) })),
  }));
  return {
    project: { ...project, production: transferProduction(project, from, to, movedEffects),
      [from]: pruneLayerGroups({ ...origin,
        groups: origin.groups?.filter(group => !groups.has(group.id)),
        nodes: origin.nodes.filter(node => !artworkIds.has(node.id)),
        effects: origin.effects.filter(effect => !effectIds.has(effect.id)),
        regions: preserveSourceContours(origin.regions, nodes) }),
      [to]: { ...target, nodes: [...target.nodes, ...incoming], effects: [...target.effects, ...incomingEffects],
        regions: masks.regions, groups: [...(target.groups || []), ...members.groups.map(group => {
          const parentId = group.parentId ? groups.get(group.parentId) : undefined;
          return { ...group, id: groups.get(group.id)!, parentId,
            autoLayout: group.autoLayout && translate(group.autoLayout,delta),
            layoutItem: parentId ? group.layoutItem : undefined };
        })] },
    },
    layerId: incoming[0]?.id ?? incomingEffects[0].id,
    groupId: groups.get(groupId)!,
  };
}

export function transferArtwork(
  project: Project, from: SideName, to: SideName, nodeId: string, position: Point, groupId?: string,
): Transfer | undefined {
  const origin = project[from], target = project[to];
  const node = origin.nodes.find(item => item.id === nodeId);
  if (from === to || !node || node.locked || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return undefined;

  const delta = { x: position.x - node.x, y: position.y - node.y };
  if (groupId) {
    const members = layerGroupMembers(origin, groupId).artworkIds;
    const index = members.indexOf(nodeId);
    if (index === -1) return undefined;
    const result = transferGroup(project, from, to, groupId, delta);
    // The anchor is not necessarily the first member in stacking order.
    if (result) {
      const incoming = result.project[to].nodes.slice(target.nodes.length);
      return { ...result, layerId: incoming[index].id };
    }
    return undefined;
  }
  const layerId = availableId(layerIds(target), nodeId);
  const masks = copyRegions(project, origin, target, delta, new Map([[nodeId, layerId]]));
  const incoming = {
    ...node, ...position, id: layerId, groupId: undefined, layoutItem: undefined,
    clipRegionId: masks.copy(node.clipRegionId),
  };
  const remaining = origin.nodes.filter(item => item.id !== nodeId);
  const regions = preserveSourceContours(origin.regions, [node]);
  return {
    project: {
      ...project,
      [from]: pruneLayerGroups({ ...origin, nodes: remaining, regions }),
      [to]: { ...target, nodes: [...target.nodes, incoming], regions: masks.regions },
    },
    layerId,
  };
}

export function transferProcess(project: Project, from: SideName, to: SideName, effectId: string): Transfer | undefined {
  const origin = project[from], target = project[to];
  const effect = origin.effects.find(item => item.id === effectId);
  if (from === to || !effect) return undefined;
  const mask = copyRegions(project, origin, target, { x: 0, y: 0 });
  const regionId = mask.copy(effect.regionId);
  if (!regionId) return undefined;
  const maskContent = effect.maskContent?.map(node => ({...node, clipRegionId:mask.copy(node.clipRegionId)}));
  const layerId = availableId(layerIds(target), effectId);
  const production = transferProduction(project, from, to, new Map([[effectId, layerId]]));
  return {
    project: {
      ...project, production,
      [from]: pruneLayerGroups({ ...origin, effects: origin.effects.filter(item => item.id !== effectId) }),
      [to]: { ...target, regions: mask.regions, effects: [...target.effects, { ...effect, id: layerId, regionId, maskContent,
        groupId: findLayerGroup(origin, effect.groupId) ? undefined : effect.groupId }] },
    },
    layerId,
  };
}

/** Paste a snapshot, giving every pasted group, contour and layer its own identity. */
export function pasteLayerSelection(project: Project, origin: CardSide, target: CardSide,
  units: LayerUnitRef[], position: Point | 'above-original', replace?: {artworkIds:string[];effectIds:string[];parentId?:string}) {
  const inPlace = position === 'above-original';
  const selected = new Set(units.map(unit => unit.id));
  const groupIds = new Map<string,string>();
  const sourceGroups = new Map(units.filter(unit => unit.kind === 'group').map(unit => [unit.id, layerGroupMembers(origin, unit.id)]));
  for (const members of sourceGroups.values()) {
    for (const group of members.groups) if (!groupIds.has(group.id)) groupIds.set(group.id, uid());
    for (const id of [...members.artworkIds, ...members.effectIds]) selected.add(id);
  }
  function parentsOn(face: CardSide) {
    return new Map([...face.nodes.map(node => [node.id, node.groupId] as const),
      ...face.effects.map(effect => [effect.id, effect.groupId] as const),
      ...(face.groups ?? []).map(group => [group.id, group.parentId] as const)]);
  }
  const sourceParents = inPlace ? parentsOn(origin) : undefined;
  const targetParents = inPlace ? parentsOn(target) : undefined;
  const roots = inPlace ? units.filter(unit => !groupIds.has(sourceParents?.get(unit.id) ?? '')) : units;
  const targetGroups = new Map(target.groups?.map(group => [group.id, group]));
  const artwork = origin.nodes.filter(node => selected.has(node.id));
  const effects = origin.effects.filter(effect => selected.has(effect.id));
  const layoutFrames = (origin.groups || []).flatMap(group =>
    groupIds.has(group.id) && group.autoLayout ? [group.autoLayout] : []);
  const bounds = [...layoutFrames, ...artwork, ...effects.flatMap(effect => {
    const region = origin.regions.find(item => item.id === effect.regionId);
    return effect.maskContent?.length ? effect.maskContent : [region?.bounds ?? origin.nodes.find(node => node.id === region?.nodeId) ?? {x:0,y:0}];
  })];
  const delta = inPlace || !bounds.length ? { x: 0, y: 0 }
    : { x: position.x - Math.min(...bounds.map(node => node.x)), y: position.y - Math.min(...bounds.map(node => node.y)) };
  const ids = new Map(artwork.map(node => [node.id, replace?.artworkIds.length === 1 && artwork.length === 1 && !effects.length ? replace.artworkIds[0] : uid()]));
  const masks = copyRegions(project, origin, target, delta, ids, !inPlace);
  const parent = (id: string, sourceParent?: string) => {
    const clonedParent = sourceParent && groupIds.get(sourceParent);
    if (clonedParent) return clonedParent;
    if (!targetParents) return replace?.parentId;
    if (targetParents.has(id)) return targetParents.get(id);
    return sourceParent && targetGroups.has(sourceParent) ? sourceParent : undefined;
  };
  const copyLayoutItem = (item: CardNode | LayerGroup, parentId?: string) => {
    if (!parentId) return undefined;
    if (inPlace && targetGroups.get(parentId)?.autoLayout) return { ...item.layoutItem, absolute: true as const };
    return item.layoutItem;
  };
  const incoming = artwork.map(node => {
    const groupId = parent(node.id, node.groupId);
    return { ...translate(node,delta), id:ids.get(node.id)!, groupId,
      layoutItem: copyLayoutItem(node, groupId), clipRegionId:masks.copy(node.clipRegionId) };
  });
  const incomingEffects = effects.map(effect => {
    const id = replace?.effectIds.length === 1 && effects.length === 1 && !artwork.length ? replace.effectIds[0] : uid();
    ids.set(effect.id,id);
    return { ...effect, id, groupId:parent(effect.id, effect.groupId), regionId:masks.copy(effect.regionId)!,
      maskContent:effect.maskContent?.map(node => ({ ...translate(node,delta), id:uid(), clipRegionId:masks.copy(node.clipRegionId) })) };
  });
  const groups = (origin.groups || []).filter(group => groupIds.has(group.id)).map(group => {
    const parentId = parent(group.id, group.parentId);
    return { ...group, id:groupIds.get(group.id)!, parentId,
      autoLayout: group.autoLayout && translate(group.autoLayout,delta),
      layoutItem: copyLayoutItem(group, parentId) };
  });
  function insertAtSelection<T extends {id:string}>(existing:T[], added:T[], removed:string[]) {
    const replaced=new Set(removed);
    const last=existing.reduce((found,item,index)=>replaced.has(item.id)?index:found,-1);
    return last<0 ? [...existing,...added] : existing.flatMap((item,index)=>index===last?added:replaced.has(item.id)?[]:[item]);
  }
  function insertAboveSources<T extends {id:string}>(existing:T[], added:T[], layerKind:'artworkIds'|'effectIds') {
    const positionById = new Map(existing.map((layer,index) => [layer.id,index]));
    const pending = new Map(added.map(layer => [layer.id,layer]));
    const insertions = new Map<number,T[]>();
    for (const unit of roots) {
      const sourceIds = sourceGroups.get(unit.id)?.[layerKind] ?? [unit.id];
      const targetIds = unit.kind === 'group' ? layerGroupMembers(target,unit.id)[layerKind] : [unit.id];
      const top = targetIds.reduce((index,id) => Math.max(index,positionById.get(id) ?? -1),-1);
      if (top === -1) continue;
      for (const sourceId of sourceIds) {
        const copyId = ids.get(sourceId);
        const layer = copyId && pending.get(copyId);
        if (!layer) continue;
        const stack = insertions.get(top);
        if (stack) stack.push(layer);
        else insertions.set(top,[layer]);
        pending.delete(layer.id);
      }
    }
    return [...existing.flatMap((layer,index) => [layer,...(insertions.get(index) ?? [])]),...pending.values()];
  }
  const nodes = inPlace ? insertAboveSources<CardNode>(target.nodes,incoming,'artworkIds')
    : insertAtSelection<CardNode>(target.nodes,incoming,replace?.artworkIds??[]);
  const newEffects = inPlace ? insertAboveSources(target.effects,incomingEffects,'effectIds')
    : insertAtSelection(target.effects,incomingEffects,replace?.effectIds??[]);
  const preservedIds=new Set(incoming.map(node=>node.id));
  const removedNodes=target.nodes.filter(node=>replace?.artworkIds.includes(node.id)&&!preservedIds.has(node.id));
  const regions=preserveSourceContours(masks.regions,removedNodes);
  return { side:{ ...target,nodes,regions,effects:newEffects,groups:[...(target.groups || []),...groups] },
    units:roots.map(unit => ({kind:unit.kind,id:(unit.kind==='group'?groupIds:ids).get(unit.id)!})) };
}
