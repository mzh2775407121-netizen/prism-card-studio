import { clearLayoutItemPlacement, uid, type CardNode, type CardSide, type Effect, type LayerGroup } from './model';

export const MAX_LAYER_GROUP_NAME_LENGTH = 100;
export const MAX_LAYER_GROUPS = 2000;

export type LayerTreeItem =
  | { kind: 'artwork'; id: string; node: CardNode }
  | { kind: 'process'; id: string; effect: Effect }
  | { kind: 'group'; id: string; group: LayerGroup; children: LayerTreeItem[] };

type GroupItem = Extract<LayerTreeItem, { kind: 'group' }>;
type LayerTreeFilter = {
  artwork?: false | ((node: CardNode) => boolean);
  process?: false | ((effect: Effect) => boolean);
};
type LayerSelection = {
  artworkIds?: readonly string[];
  effectIds?: readonly string[];
  groupIds?: readonly string[];
};
export type LayerUnitRef = { kind: LayerTreeItem['kind']; id: string };

function withoutLayoutPlacement<T extends CardNode | LayerGroup>(layer: T): T {
  const layoutItem = clearLayoutItemPlacement(layer.layoutItem);
  return layoutItem === layer.layoutItem ? layer : {...layer, layoutItem};
}

// Only records reachable from a root are registered. Missing parents and cycles cannot enter the tree.
function registeredGroups(side: CardSide) {
  const groups = new Map<string, LayerGroup>();
  if (!side.groups?.length || !Array.isArray(side.groups)) return groups;
  const leaves = new Set([...side.nodes, ...side.effects].map(layer => layer.id));
  const records = new Map<string, LayerGroup>();
  const seen = new Set<string>();
  for (const group of side.groups) {
    if (!group || typeof group.id !== 'string' || !group.id.trim() || leaves.has(group.id)) continue;
    if (seen.has(group.id)) { records.delete(group.id); continue; }
    seen.add(group.id);
    if (typeof group.name !== 'string' || !group.name.trim()) continue;
    if (group.parentId !== undefined && typeof group.parentId !== 'string') continue;
    records.set(group.id, group);
  }
  const children = new Map<string | undefined, LayerGroup[]>();
  for (const group of records.values()) {
    const siblings = children.get(group.parentId);
    if (siblings) siblings.push(group);
    else children.set(group.parentId, [group]);
  }
  const pending = [...(children.get(undefined) ?? [])];
  for (const group of pending) {
    groups.set(group.id, group);
    pending.push(...(children.get(group.id) ?? []));
  }
  return groups;
}

export function findLayerGroup(side: CardSide, groupId?: string) {
  return groupId ? registeredGroups(side).get(groupId) : undefined;
}

export function layerGroupAncestors(side: CardSide, groupId?: string) {
  const groups = registeredGroups(side);
  const ancestors: LayerGroup[] = [];
  for (let id = groupId; id;) {
    const group = groups.get(id);
    if (!group) break;
    ancestors.push(group);
    id = group.parentId;
  }
  return ancestors;
}

export function layerGroupMembers(side: CardSide, groupId: string) {
  const registered = registeredGroups(side);
  const ids = new Set<string>();
  const groups: LayerGroup[] = [];
  for (const group of registered.values()) {
    if (group.id !== groupId && (!group.parentId || !ids.has(group.parentId))) continue;
    ids.add(group.id);
    groups.push(group);
  }
  return {
    artworkIds: side.nodes.filter(node => node.groupId && ids.has(node.groupId)).map(node => node.id),
    effectIds: side.effects.filter(effect => effect.groupId && ids.has(effect.groupId)).map(effect => effect.id),
    groups,
  };
}

export function buildLayerTree(side: CardSide, filter: LayerTreeFilter = {}): LayerTreeItem[] {
  const groups = registeredGroups(side);
  const items: LayerTreeItem[] = [];
  const branches = new Map<string, GroupItem>();
  function siblings(groupId?: string): LayerTreeItem[] {
    const group = groupId ? groups.get(groupId) : undefined;
    if (!group) return items;
    let branch = branches.get(group.id);
    if (!branch) {
      branch = {kind: 'group', id: group.id, group, children: []};
      branches.set(group.id, branch);
      siblings(group.parentId).push(branch);
    }
    return branch.children;
  }
  if (filter.process !== false) {
    for (let index = side.effects.length - 1; index >= 0; index--) {
      const effect = side.effects[index];
      if (!filter.process || filter.process(effect)) siblings(effect.groupId).push({kind: 'process', id: effect.id, effect});
    }
  }
  if (filter.artwork !== false) {
    for (let index = side.nodes.length - 1; index >= 0; index--) {
      const node = side.nodes[index];
      if (node.type !== 'empty' && (!filter.artwork || filter.artwork(node))) {
        siblings(node.groupId).push({kind: 'artwork', id: node.id, node});
      }
    }
  }
  return items;
}

function leafIds(items: LayerTreeItem[]) {
  const artwork = new Set<string>();
  const process = new Set<string>();
  function visit(item: LayerTreeItem) {
    if (item.kind === 'group') item.children.forEach(visit);
    else (item.kind === 'artwork' ? artwork : process).add(item.id);
  }
  items.forEach(visit);
  return {artwork, process};
}

function lastMemberIndex<T extends {id: string}>(layers: T[], ids: Set<string>) {
  for (let index = layers.length - 1; index >= 0; index--) if (ids.has(layers[index].id)) return index;
  return -1;
}

function topmostBlock<T extends {id: string}>(layers: T[], selected: Set<string>): T[] {
  const top = lastMemberIndex(layers, selected);
  if (top < 0) return layers;
  return [
    ...layers.slice(0, top).filter(layer => !selected.has(layer.id)),
    ...layers.filter(layer => selected.has(layer.id)),
    ...layers.slice(top + 1),
  ];
}

export function groupLayers(side: CardSide, selection: LayerSelection, name?: string) {
  const chosen = {
    artwork: new Set(selection.artworkIds), process: new Set(selection.effectIds), group: new Set(selection.groupIds),
  };
  const selected: {item: LayerTreeItem; parentId?: string}[] = [];
  function collect(items: LayerTreeItem[], parentId?: string) {
    for (const item of items) {
      if (chosen[item.kind].has(item.id)) selected.push({item, parentId});
      else if (item.kind === 'group') collect(item.children, item.id);
    }
  }
  collect(buildLayerTree(side));
  const parentId = selected[0]?.parentId;
  if (selected.length < 2 || selected.some(entry => entry.parentId !== parentId)) return undefined;

  const items = selected.map(entry => entry.item);
  const members = leafIds(items);
  const direct = {
    artwork: new Set(items.filter(item => item.kind === 'artwork').map(item => item.id)),
    process: new Set(items.filter(item => item.kind === 'process').map(item => item.id)),
    group: new Set(items.filter(item => item.kind === 'group').map(item => item.id)),
  };
  const groups = Array.isArray(side.groups) ? side.groups : [];
  if (groups.length >= MAX_LAYER_GROUPS) return undefined;
  const names = new Set(groups.map(group => group?.name));
  let number = 1;
  while (names.has(`组合${number}`)) number++;
  const groupId = uid();
  const newGroup = {id: groupId, name: name?.trim().slice(0, MAX_LAYER_GROUP_NAME_LENGTH) || `组合${number}`, parentId};
  return {
    side: {
      ...side,
      nodes: topmostBlock(side.nodes, members.artwork).map(node => direct.artwork.has(node.id)
        ? {...withoutLayoutPlacement(node), groupId} : node),
      effects: topmostBlock(side.effects, members.process).map(effect => direct.process.has(effect.id) ? {...effect, groupId} : effect),
      groups: [...groups.map(group => direct.group.has(group?.id)
        ? {...withoutLayoutPlacement(group), parentId: groupId} : group), newGroup],
    },
    groupId,
  };
}

export function ungroupLayer(side: CardSide, groupId: string): CardSide {
  const group = findLayerGroup(side, groupId);
  if (!group) return side;
  const reparentLeaf = <T extends {groupId?: string}>(layer: T): T =>
    layer.groupId === groupId ? {...layer, groupId: group.parentId} : layer;
  const groups = (side.groups ?? []).filter(item => item?.id !== groupId)
    .map(item => item?.parentId === groupId ? {...withoutLayoutPlacement(item), parentId: group.parentId} : item);
  return {...side, nodes: side.nodes.map(node => node.groupId === groupId ? reparentLeaf(withoutLayoutPlacement(node)) : node),
    effects: side.effects.map(reparentLeaf), groups: groups.length ? groups : undefined};
}

export function renameLayerGroup(side: CardSide, groupId: string, name: string): CardSide {
  const group = findLayerGroup(side, groupId);
  const next = name.trim().slice(0, MAX_LAYER_GROUP_NAME_LENGTH);
  if (!group || !next || next === group.name) return side;
  return {...side, groups: side.groups?.map(item => item?.id === groupId ? {...item, name: next} : item)};
}

export function pruneLayerGroups(side: CardSide): CardSide {
  if (!side.groups?.length || !Array.isArray(side.groups)) return side;
  const groups = registeredGroups(side);
  const keep = new Set<string>();
  for (const layer of [...side.nodes, ...side.effects]) {
    for (let id = layer.groupId; id && !keep.has(id);) {
      const group = groups.get(id);
      if (!group) break;
      keep.add(id);
      id = group.parentId;
    }
  }
  if (keep.size === side.groups.length) return side;
  const remaining = side.groups.filter(group => group && keep.has(group.id));
  return {...side, groups: remaining.length ? remaining : undefined};
}

export type LayerDropPosition = 'before' | 'inside' | 'after';

export function reorderLayerUnits(
  side: CardSide, dragged: LayerUnitRef, target: LayerUnitRef, placement: LayerDropPosition = 'before',
): CardSide {
  if (dragged.id === target.id || (placement === 'inside' && target.kind !== 'group')) return side;
  const entries = new Map<string, LayerTreeItem>();
  function index(items: LayerTreeItem[]) {
    for (const item of items) {
      entries.set(item.id,item);
      if (item.kind === 'group') index(item.children);
    }
  }
  index(buildLayerTree(side));
  const source = entries.get(dragged.id), anchor = entries.get(target.id);
  if (!source || !anchor || source.kind !== dragged.kind || anchor.kind !== target.kind) return side;
  const parent = (item:LayerTreeItem) => item.kind === 'group' ? item.group.parentId :
    item.kind === 'artwork' ? item.node.groupId : item.effect.groupId;
  const parentId = placement === 'inside' ? anchor.id : parent(anchor);
  if (source.kind === 'group' && layerGroupAncestors(side,parentId).some(group => group.id === source.id)) return side;
  const moving = leafIds([source]), anchors = leafIds([anchor]);
  if (side.nodes.some(node => node.locked && moving.artwork.has(node.id))) return side;
  if (placement !== 'inside' && !((moving.artwork.size && anchors.artwork.size) || (moving.process.size && anchors.process.size))) return side;
  function reorder<T extends {id: string}>(layers: T[], kind: keyof typeof moving) {
    const block = layers.filter(layer => moving[kind].has(layer.id));
    if (!block.length) return layers;
    const remaining = layers.filter(layer => !moving[kind].has(layer.id));
    const last = lastMemberIndex(remaining,anchors[kind]);
    if (last < 0) return layers;
    const insert = placement === 'after' ? remaining.findIndex(layer => anchors[kind].has(layer.id)) : last + 1;
    remaining.splice(insert,0,...block);
    return remaining.every((layer,i) => layer === layers[i]) ? layers : remaining;
  }
  let nodes = reorder(side.nodes,'artwork'), effects = reorder(side.effects,'process');
  let groups = side.groups;
  if (parent(source) !== parentId) {
    if (source.kind === 'group') groups = groups?.map(group => group.id === source.id
      ? {...withoutLayoutPlacement(group), parentId} : group);
    if (source.kind === 'artwork') nodes = nodes.map(node => node.id === source.id
      ? {...withoutLayoutPlacement(node), groupId: parentId} : node);
    if (source.kind === 'process') effects = effects.map(e => e.id === source.id ? {...e,groupId:parentId} : e);
  }
  return nodes === side.nodes && effects === side.effects && groups === side.groups ? side : pruneLayerGroups({...side,nodes,effects,groups});
}
