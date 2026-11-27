import { dataUrl, imageMime, localSource, validateCardDesign } from './io';
import { layerGroupAncestors, layerGroupMembers } from './layerGroups';
import { projectCards, projectForCard, type CardNode, type CardSide, type Project, type ProjectCard, type SideName } from './model';
import { artworkBounds } from './artworkAlignment';
import { intersectsPrint } from './vectorPrint';
import { renderCard } from './render';
import { artworkTextNodes, ensureProjectFonts, importArtworkFont, shareableProjectFont, type ImportedFontReference } from './artworkFonts';
import { confirmedStockFinish } from './stockMaterials';

export interface AssetSnapshot {
  card: ProjectCard;
  cover: string;
  backCover?: string;
  fonts: { ref: ImportedFontReference; data: string }[];
  digest: string;
}

function collectSide(project: Project, face: SideName): CardSide {
  const side = structuredClone(project[face]);
  const bleed = project.bleedMm * 10;
  const nodes = new Set<string>();
  const regions = new Set<string>();
  const groups = new Set<string>();
  const sideNodes = new Map(side.nodes.map(item => [item.id, item]));
  const sideRegions = new Map(side.regions.map(item => [item.id, item]));
  function keepGroup(id?: string) {
    for (const group of layerGroupAncestors(side, id)) {
      if (groups.has(group.id)) continue;
      groups.add(group.id);
      if (group.autoLayout) layerGroupMembers(side, group.id).artworkIds.forEach(keepNode);
    }
  }
  function keepNode(id: string) {
    if (nodes.has(id)) return;
    nodes.add(id);
    const node = sideNodes.get(id);
    if (!node) throw new Error('卡面蒙版引用了缺失的源图层，请重新选择作用区域。');
    keepGroup(node.groupId);
    if (node.clipRegionId) keepRegion(node.clipRegionId);
  }
  function keepRegion(id: string) {
    if (regions.has(id)) return;
    regions.add(id);
    const region = sideRegions.get(id);
    if (!region) throw new Error('工艺或裁切蒙版缺失，请在属性中重新选择区域。');
    if (region.nodeId && (region.binding === 'follow' || !region.snapshot && (sideNodes.has(region.nodeId) || !region.bounds))) keepNode(region.nodeId);
    if (region.snapshot?.clipRegionId) keepRegion(region.snapshot.clipRegionId);
    region.sources?.forEach(keepRegion);
  }
  for (const node of side.nodes) {
    const r = artworkBounds(node);
    if (intersectsPrint(node, project) || r.right >= -bleed && r.bottom >= -bleed && r.left <= project.widthMm * 10 + bleed &&
      r.top <= project.heightMm * 10 + bleed) keepNode(node.id);
  }
  side.effects.forEach(effect => {
    keepGroup(effect.groupId);
    keepRegion(effect.regionId);
    for (const item of effect.maskContent ?? []) if (item.clipRegionId) keepRegion(item.clipRegionId);
  });
  const match = confirmedStockFinish(project, face);
  if (side.stockFinish?.match) {
    const { style, visible, opacity, appearance } = side.stockFinish;
    side.stockFinish = { style, visible, opacity, reviewRequired: true, appearance: match
      ? { method: match.method, transparent: match.transparent, orientationDeg: match.orientationDeg } : appearance };
  }
  delete side.reference;
  side.nodes = side.nodes.filter(n => nodes.has(n.id));
  side.regions = side.regions.filter(r => regions.has(r.id));
  for (const region of side.regions) if (region.nodeId && !nodes.has(region.nodeId)) delete region.nodeId;
  side.groups = side.groups?.filter(g => groups.has(g.id));
  return side;
}

export async function cardCovers(card: ProjectCard, longEdgePx = 360) {
  const project = projectForCard({ id: card.id, name: card.name, version: 1, updatedAt: 0 }, card);
  await ensureProjectFonts(project);
  const scale = longEdgePx / (Math.max(card.widthMm, card.heightMm) * 10);
  async function preview(face: SideName) {
    return (await renderCard(project, face, { scale, effects: true })).toDataURL('image/webp', .86);
  }
  return { cover: await preview('front'), backCover: card.singleSided ? undefined : await preview('back') };
}

export async function prepareCardAsset(project: Project): Promise<AssetSnapshot> {
  const original = projectCards(project).find(card => card.id === (project.cardId ?? project.id + '_1'));
  if (!original) throw new Error('无法找到当前卡牌。');
  const card: ProjectCard = { ...structuredClone(original), front: collectSide(project, 'front'),
    back: original.singleSided ? { nodes: [], effects: [], regions: [] } : collectSide(project, 'back') };
  if (card.production) card.production = { dieShape: card.production.dieShape, steps: [] };
  const sources = new Map<string, Promise<string>>();
  async function embed(target: { src?: string }, name: string) {
    if (!target.src) throw new Error('「' + name + '」缺少图片，请替换后重试。');
    let pending = sources.get(target.src);
    if (!pending) {
      pending = localSource(target.src).then(bytes => dataUrl(new Blob([bytes.slice().buffer], {type:imageMime(bytes)})));
      sources.set(target.src, pending);
    }
    try { target.src = await pending; }
    catch { throw new Error('无法读取「' + name + '」的原图，请替换图片后重试。'); }
  }
  const fontRefs = new Map<string, ImportedFontReference>();
  const images: Promise<void>[] = [];
  for (const side of [card.front, card.back]) {
    const all: CardNode[] = [...side.nodes, ...side.effects.flatMap(e => e.maskContent ?? []),
      ...side.regions.flatMap(r => r.snapshot ? [r.snapshot] : [])];
    for (const n of all) {
      if (n.type === 'image') images.push(embed(n, n.name));
      if (n.imageFill) images.push(embed(n.imageFill, n.name));
    }
    for (const n of artworkTextNodes(side)) {
      if (n.fontRef?.kind === 'imported' && n.fontRef.share) fontRefs.set(n.fontRef.id,n.fontRef);
    }
  }
  await Promise.all(images);
  validateCardDesign(card);
  const fonts: AssetSnapshot['fonts'] = [];
  for (const ref of fontRefs.values()) {
    const font = await shareableProjectFont(ref);
    if (font) fonts.push({ref, data: await dataUrl(new Blob([font.bytes]))});
  }
  const encoded = new TextEncoder().encode(JSON.stringify({card, fonts:fonts.map(item=>item.ref.id)}));
  const buffer = await crypto.subtle.digest('SHA-256', encoded);
  const digest = [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2,'0')).join('');
  return { card, digest, fonts, ...await cardCovers(card) };
}

export async function restoreAssetFonts(snapshot: AssetSnapshot) {
  for (const font of snapshot.fonts ?? []) {
    if (!font.data.startsWith('data:application/octet-stream;base64,') && !font.data.startsWith('data:;base64,')) throw new Error('资产字体格式无效');
    await importArtworkFont(await (await fetch(font.data)).blob(),font.ref);
  }
}
