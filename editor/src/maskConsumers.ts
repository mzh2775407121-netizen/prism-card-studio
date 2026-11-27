import type { CardNode, CardSide, Region } from './model';
import { layerGroupMembers, type LayerUnitRef } from './layerGroups';

/** Every region whose rendered pixels depend on one of the given regions. */
export function dependentRegions(face: CardSide, roots: Iterable<string>) {
  const parents = new Map<string, string[]>();
  const nodes = new Map(face.nodes.map(node => [node.id, node]));
  for (const region of face.regions) {
    const contour = region.kind === 'node'
      ? (region.binding === 'fixed' ? region.snapshot : undefined) ?? nodes.get(region.nodeId ?? '')
      : undefined;
    for (const id of [...region.sources ?? [], contour?.clipRegionId]) {
      if (!id) continue;
      if (!parents.has(id)) parents.set(id, []);
      parents.get(id)!.push(region.id);
    }
  }
  const result = new Set(roots);
  for (const id of result) for (const parent of parents.get(id) ?? []) result.add(parent);
  return result;
}

export function maskConsumers(face: CardSide, ids: Set<string>) {
  return [...face.nodes.filter(node => node.clipRegionId && ids.has(node.clipRegionId)),
    ...face.effects.filter(effect => ids.has(effect.regionId) || effect.maskContent?.some(node => node.clipRegionId && ids.has(node.clipRegionId)))];
}

export type Removal = { name: string; artworkIds: string[]; effectIds: string[]; groupIds: string[] };

export function removalForLayerUnits(face: CardSide, units: readonly LayerUnitRef[], name = '所选图层'): Removal | undefined {
  const groups = units.filter(unit => unit.kind === 'group').map(unit => layerGroupMembers(face, unit.id));
  const artwork = new Set([...units.filter(unit => unit.kind === 'artwork').map(unit => unit.id),
    ...groups.flatMap(group => group.artworkIds)]);
  const effects = new Set([...units.filter(unit => unit.kind === 'process').map(unit => unit.id),
    ...groups.flatMap(group => group.effectIds)]);
  const artworkIds = face.nodes.filter(node => artwork.has(node.id)).map(node => node.id);
  const effectIds = face.effects.filter(effect => effects.has(effect.id)).map(effect => effect.id);
  const groupIds = [...new Set(groups.flatMap(group => group.groups.map(item => item.id)))];
  if (artworkIds.length || effectIds.length || groupIds.length) return { name, artworkIds, effectIds, groupIds };
}

export function removeRegion(face: CardSide, id: string, fixed?: {root:string;regions:Region[]}): CardSide {
  const removed = fixed ? new Set([id]) : dependentRegions(face,[id]);
  const remap = (value?:string) => value && removed.has(value) ? fixed?.root : value;
  const node = (item:CardNode) => item.clipRegionId && removed.has(item.clipRegionId) ? {...item,clipRegionId:remap(item.clipRegionId)} : item;
  return {...face, nodes:face.nodes.map(node), effects:face.effects.flatMap(effect=>{
    const regionId=remap(effect.regionId);
    return regionId ? [{...effect,regionId,maskContent:effect.maskContent?.map(node)}] : [];
  }),regions:[...face.regions.filter(region=>!removed.has(region.id)).map(region=>({
    ...region,sources:region.sources?.map(source=>remap(source)!),snapshot:region.snapshot&&node(region.snapshot),
  })),...fixed?.regions??[]]};
}

export function sourceMaskImpact(face: CardSide, target: Pick<Removal,'artworkIds'|'effectIds'>) {
  const nodes = new Set(target.artworkIds), effects = new Set(target.effectIds);
  const roots = face.regions.filter(region => region.nodeId && nodes.has(region.nodeId) && !(region.binding === 'fixed' && region.snapshot));
  const ids = dependentRegions(face,roots.map(region=>region.id));
  return { ids, users:maskConsumers(face,ids).filter(item=>!nodes.has(item.id)&&!effects.has(item.id)) };
}

export function removeSelection(face: CardSide, target: Removal, removeRelated: boolean): CardSide {
  const { ids } = sourceMaskImpact(face, target);
  const removed = new Map(face.nodes.filter(node=>target.artworkIds.includes(node.id)).map(node=>[node.id,node]));
  const keepNode = (node:CardNode) => removeRelated && node.clipRegionId && ids.has(node.clipRegionId) ? {...node,clipRegionId:undefined} : node;
  const regions = face.regions.filter(region=>!removeRelated || !ids.has(region.id)).map(region=>{
    const source = region.nodeId && removed.get(region.nodeId);
    if (!source) return region;
    return {...region,binding:'fixed' as const,nodeId:undefined,snapshot:structuredClone(region.snapshot ?? source),
      bounds:region.binding==='fixed'?region.bounds:undefined};
  });
  return {...face, regions, groups:face.groups?.filter(group=>!target.groupIds.includes(group.id)),
    nodes:face.nodes.filter(node=>!removed.has(node.id)).map(keepNode),
    effects:face.effects.filter(effect=>!target.effectIds.includes(effect.id) && (!removeRelated || !ids.has(effect.regionId))).map(effect=>
      removeRelated && effect.maskContent?.some(node=>node.clipRegionId && ids.has(node.clipRegionId)) ? {...effect,maskContent:effect.maskContent.map(keepNode)} : effect)};
}
