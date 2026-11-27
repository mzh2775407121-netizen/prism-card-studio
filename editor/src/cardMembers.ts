import {
  canvasFacePositionKey, createProject, getFlashStyle, getStockFinish, processKind, projectAtCard, projectCards, projectForCard, projectWithMembers, uid,
  type CardNode, type CardSide, type Project, type ProjectCard, type SideName, type StockFinish,
} from './model';
import { alignPairedCanvasFaces, canvasLayoutSnapshot, placeInsertedCanvasCard, preserveCanvasLayout } from './canvasLayout';
import { confirmedStockFinish } from './stockMaterials';
import type { ProductionPlan, ProductionStep } from './production';

const lastCardKey = (projectId: string) => 'prism-current-card:' + projectId;

export function rememberCurrentCard(projectId: string, cardId: string) {
  try { localStorage.setItem(lastCardKey(projectId), cardId); } catch { /* Storage can be unavailable. */ }
}

export function lastOpenedCard(project: Project): Project {
  let id: string | null;
  try { id = localStorage.getItem(lastCardKey(project.id)); } catch { return project; }
  if (!id || !projectCards(project).some(card => card.id === id)) return project;
  return projectAtCard(project, id);
}

export function cloneProjectCard(card: ProjectCard, name = card.name): ProjectCard {
  const copy = structuredClone(card);
  if (copy.production) delete copy.production.splitOrder;
  copy.id = uid();
  copy.name = name;
  const processIds = new Map<string, string>();
  const stepIds = new Map<string, string>();
  for (const face of ['front', 'back'] as const) {
    const side = copy[face];
    delete side.canvasLocked;
    const ids = new Map<string, string>();
    const remap = (id: string) => {
      let result = ids.get(id);
      if (!result) { result = uid(); ids.set(id, result); }
      return result;
    };
    const mappedNodes = new WeakSet<CardNode>();
    const remapNode = (node: CardNode) => {
      if (mappedNodes.has(node)) return;
      mappedNodes.add(node);
      node.id = remap(node.id);
      if (node.groupId) node.groupId = remap(node.groupId);
      if (node.clipRegionId) node.clipRegionId = remap(node.clipRegionId);
      for (const effect of node.visualEffects ?? []) effect.id = remap(effect.id);
      if (node.gradient?.stopIds) node.gradient.stopIds = node.gradient.stopIds.map(remap);
    };
    for (const group of side.groups ?? []) {
      group.id = remap(group.id);
      if (group.parentId) group.parentId = remap(group.parentId);
    }
    for (const node of side.nodes) remapNode(node);
    for (const region of side.regions) {
      region.id = remap(region.id);
      if (region.nodeId) region.nodeId = remap(region.nodeId);
      if (region.sources) region.sources = region.sources.map(remap);
      if (region.snapshot) remapNode(region.snapshot);
    }
    for (const effect of side.effects) {
      const original = effect.id;
      effect.id = remap(original);
      processIds.set(face + ':' + original, effect.id);
      stepIds.set(face + ':layer:' + original, face + ':layer:' + effect.id);
      effect.regionId = remap(effect.regionId);
      if (effect.groupId) effect.groupId = remap(effect.groupId);
      effect.maskContent?.forEach(remapNode);
    }
  }
  for (const step of copy.production?.steps ?? []) {
    if (step.kind !== 'layer' && step.kind !== 'artwork' && step.kind !== 'die') stepIds.set(step.id, uid());
  }
  for (const step of copy.production?.steps ?? []) {
    step.id = stepIds.get(step.id) ?? step.id;
    if (step.layerId) step.layerId = processIds.get(step.face + ':' + step.layerId) ?? step.layerId;
    if (step.requiresStepId) step.requiresStepId = stepIds.get(step.requiresStepId) ?? step.requiresStepId;
  }
  return copy;
}

function withoutSupplierMatch(finish: StockFinish): StockFinish {
  if (!finish.match) return finish;
  const { match, ...rest } = finish;
  const { orientationDeg, method, transparent } = match;
  return { ...rest, appearance: { orientationDeg, method, transparent }, reviewRequired: true };
}

export function blankCardAfter(project: Project): ProjectCard {
  const blank = createProject('blank');
  const cards = projectCards(project);
  const names = new Set(cards.map(card => card.name));
  let index = cards.length + 1;
  while (names.has('卡牌 ' + index)) index++;
  const face = (side: SideName): CardSide => {
    return { ...blank[side], stockFinish: withoutSupplierMatch(structuredClone(getStockFinish(project, side))) };
  };
  return { id: uid(), name: '卡牌 ' + index, widthMm: project.widthMm, heightMm: project.heightMm,
    bleedMm: project.bleedMm, cornerRadiusMm: project.cornerRadiusMm, singleSided: false,
    material: project.material, stockSpec: structuredClone(project.stockSpec), stockReflection: project.stockReflection,
    front: face('front'), back: face('back'),
    production: project.production && { dieShape: project.production.dieShape, steps: [], printProfile: structuredClone(project.production.printProfile) },
  };
}

export function insertProjectCard(project: Project, card: ProjectCard): Project {
  const cards = projectCards(project);
  if (cards.some(item => item.id === card.id)) throw new Error('卡牌已加入项目');
  cards.splice((project.activeCardIndex ?? 0) + 1, 0, card);
  return placeInsertedCanvasCard(project, projectWithMembers(project, cards, card.id), card);
}

export function physicalCardFace(card: Pick<ProjectCard, 'singleSided' | 'looseFace'>, slot: SideName): SideName {
  return card.singleSided && card.looseFace === 'back' && slot === 'front' ? 'back' : slot;
}

function selectedCard(project: Project, id: string) {
  const card = projectCards(project).find(item => item.id === id);
  if (!card) throw new Error('所选卡牌已移出项目');
  return card;
}

function faceStepId(id: string, from: SideName, to: SideName) {
  if (id === from + ':artwork' || id.startsWith(from + ':layer:')) return to + id.slice(from.length);
  return id;
}

function swappedFaceStepId(id: string) {
  return id.startsWith('front:') ? faceStepId(id, 'front', 'back') : faceStepId(id, 'back', 'front');
}

export function swapCardFaceRoles(card: ProjectCard): ProjectCard {
  const plan = card.production;
  const production = plan && { ...plan };
  if (production && !card.singleSided) {
    production.steps = production.steps.map(step => ({
      ...step,
      id: swappedFaceStepId(step.id),
      face: step.face === 'both' ? 'both' : step.face === 'front' ? 'back' : 'front',
      ...(step.requiresStepId && { requiresStepId: swappedFaceStepId(step.requiresStepId) }),
    }));
  }
  if (production?.splitOrder) {
    // Split order refers to the physical faces of the original pair.
    const split = production.splitOrder;
    production.splitOrder = {
      ...split,
      ids: split.ids.map(swappedFaceStepId),
      crossDependencies: Object.fromEntries(Object.entries(split.crossDependencies).map(([id, required]) =>
        [swappedFaceStepId(id), swappedFaceStepId(required)])),
    };
  }
  if (card.singleSided) {
    return { ...card, looseFace: card.looseFace === 'back' ? undefined : 'back', production };
  }
  return {
    ...card,
    front: card.back,
    back: card.front,
    ...(card.faceOrigins && { faceOrigins: { front: card.faceOrigins.back, back: card.faceOrigins.front } }),
    ...(card.assetFaceOrigins && { assetFaceOrigins: { front: card.assetFaceOrigins.back, back: card.assetFaceOrigins.front } }),
    production,
  };
}

function belongsToOtherFace(id: string, steps: ProductionStep[], face: SideName) {
  const opposite = face === 'front' ? 'back' : 'front';
  return id === opposite + ':artwork' || id.startsWith(opposite + ':layer:') || steps.some(step => step.id === id && step.face === opposite);
}

function stepsOnFace(steps: ProductionStep[], from: SideName, to: SideName): ProductionStep[] {
  return steps.filter(step => step.face === from || step.face === 'both').map(step => {
    const required = step.requiresStepId;
    return { ...step, id: faceStepId(step.id, from, to), face: step.face === 'both' ? 'both' : to,
      requiresStepId: required && !belongsToOtherFace(required, steps, from) ? faceStepId(required, from, to) : undefined };
  });
}

const unusedSide = (): CardSide => ({ nodes: [], regions: [], effects: [] });

export function isolateFace(project: Project, card: ProjectCard, slot: SideName, id: string): ProjectCard {
  const role = physicalCardFace(card, slot);
  const source = projectForCard(project, card);
  const { faceOrigins, communityOrigin, assetFaceOrigins, assetOrigin, looseFace: _previousRole, ...design } = card;
  const side = { ...card[slot], stockFinish: getStockFinish(source, slot) };
  const origin = faceOrigins ? faceOrigins[slot] : communityOrigin;
  const privateOrigin=assetFaceOrigins?assetFaceOrigins[slot]:assetOrigin;
  const plan = card.production;
  return { ...design, id, singleSided: true, ...(role === 'back' && { looseFace: 'back' }),
    ...(origin && { communityOrigin: origin }), ...(privateOrigin&&{assetOrigin:privateOrigin}), front: side, back: unusedSide(),
    production: plan && { ...plan, steps: stepsOnFace(plan.steps, slot, 'front') } };
}

export function copyCardFace(project: Project, cardId: string, slot: SideName): ProjectCard {
  const card = selectedCard(project, cardId);
  if (card.singleSided && slot === 'back') throw new Error('所选卡面不存在');
  const isolated = isolateFace(project, card, slot, card.id);
  const name = card.name.slice(0, 490) + (isolated.looseFace === 'back' ? ' · 背面副本' : ' · 正面副本');
  return cloneProjectCard(isolated, name);
}

export function unlinkCardFaces(project: Project, cardId: string, slot: SideName): Project {
  const cards = projectCards(project);
  const index = cards.findIndex(card => card.id === cardId);
  const card = cards[index];
  if (!card || card.singleSided) throw new Error('请选择一张已绑定的双面卡');
  const front = isolateFace(project, card, 'front', card.id);
  const back = isolateFace(project, card, 'back', uid());
  const steps = card.production?.steps;
  if (steps?.length && front.production && back.production) {
    const crossDependencies = Object.fromEntries(steps.filter(step => step.requiresStepId &&
      (step.face === 'both' || belongsToOtherFace(step.requiresStepId, steps, step.face)))
      .map(step => [step.id, step.requiresStepId!]));
    const split = { pair: uid(), ids: steps.map(step => step.id), crossDependencies };
    front.production.splitOrder = split;
    back.production.splitOrder = split;
  }
  cards.splice(index, 1, front, back);
  const { projectCover } = project;
  const workspace = projectCover?.cardId === cardId && projectCover.face === 'back'
    ? { ...project, projectCover: { cardId: back.id, face: 'front' as const } } : project;
  const next = preserveCanvasLayout(project, projectWithMembers(workspace, cards, slot === 'front' ? front.id : back.id));
  next.canvasFacePositions![canvasFacePositionKey(back.id, 'front')] =
    canvasLayoutSnapshot(project)[canvasFacePositionKey(card.id, 'back')];
  return next;
}

function joinProduction(front?: ProductionPlan, back?: ProductionPlan): ProductionPlan | undefined {
  if (!front && !back) return;
  const split = front?.splitOrder && front.splitOrder.pair === back?.splitOrder?.pair ? front.splitOrder : undefined;
  const steps = stepsOnFace(front?.steps ?? [], 'front', 'front');
  const reverse = stepsOnFace(back?.steps ?? [], 'front', 'back');
  const existing = new Map(steps.map(step => [step.id, step]));
  const ids = new Map<string, string>();
  for (const step of reverse) {
    const other = existing.get(step.id);
    if (!other) continue;
    if (step.kind === 'die' || split && step.face === 'both' && other.face === 'both') continue;
    ids.set(step.id, uid());
  }
  for (const step of reverse) {
    if (existing.has(step.id) && !ids.has(step.id)) continue;
    steps.push({ ...step, id: ids.get(step.id) ?? step.id,
      requiresStepId: step.requiresStepId && (ids.get(step.requiresStepId) ?? step.requiresStepId) });
  }
  if (steps.length > 250) throw new Error('合并后工序超过 250 道，请先精简工序');
  if (split) {
    const order = new Map(split.ids.map((id, index) => [id, index]));
    steps.sort((a,b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    for (const step of steps) if (!step.requiresStepId && Object.hasOwn(split.crossDependencies, step.id)) {
      const required = split.crossDependencies[step.id];
      if (steps.some(item => item.id === required)) step.requiresStepId = required;
    }
  } else {
    steps.sort((a,b) => Number(a.kind === 'die') - Number(b.kind === 'die'));
  }
  // Shared substrate, cutting and supplier settings belong to the front card.
  const plan: ProductionPlan = { ...(front ?? { dieShape: 'card' }), steps };
  delete plan.splitOrder;
  return plan;
}

function hasHiddenDesign(card: ProjectCard) {
  const side = card.back;
  return side.nodes.length || side.effects.length || side.groups?.length || side.reference ||
    side.regions.some(region => !['full', 'border'].includes(region.kind) || region.inverted || region.strokes.length || region.maskSource) ||
    side.stockFinish && side.stockFinish.style !== 'none' || card.production?.steps.some(step => step.face === 'back');
}

export function replaceCardFace(project: Project, card: ProjectCard, slot: SideName, source: ProjectCard): ProjectCard {
  if (card.singleSided) return { ...source, id: card.id, name: card.name, looseFace: card.looseFace };

  const sourceProject = projectForCard(project, source);
  const face = { ...source.front, stockFinish: getStockFinish(sourceProject, 'front') };
  if (face.stockFinish.match && !confirmedStockFinish(projectForCard(project, card), face))
    face.stockFinish = withoutSupplierMatch(face.stockFinish);
  if (card.previewStyle !== source.previewStyle) face.effects = face.effects.map(effect =>
    processKind(effect) === 'reflection' && !effect.flashStyle ? { ...effect, flashStyle: getFlashStyle(sourceProject, effect) } : effect);

  const incoming = stepsOnFace(source.production?.steps ?? [], 'front', slot).filter(step => step.face === slot);
  const original = card.production?.steps ?? [];
  const first = original.findIndex(step => step.face === slot);
  const steps = original.filter(step => step.face !== slot);
  const die = steps.findIndex(step => step.kind === 'die');
  steps.splice(first >= 0 ? first : die >= 0 ? die : steps.length, 0, ...incoming);
  const opposite = slot === 'front' ? 'back' : 'front';
  const stepIds = new Set([...steps.map(step => step.id), 'front:artwork', 'back:artwork', 'die',
    ...card[opposite].effects.map(effect => opposite + ':layer:' + effect.id),
    ...face.effects.map(effect => slot + ':layer:' + effect.id)]);
  const oldOrigin = card.faceOrigins ? card.faceOrigins[opposite] : card.communityOrigin;
  const newOrigin = source.faceOrigins ? source.faceOrigins.front : source.communityOrigin;
  const oldAsset=card.assetFaceOrigins?card.assetFaceOrigins[opposite]:card.assetOrigin;
  const newAsset=source.assetFaceOrigins?source.assetFaceOrigins.front:source.assetOrigin;
  return { ...card, [slot]: face, communityOrigin: oldOrigin ?? newOrigin,
    faceOrigins: oldOrigin || newOrigin ? { [opposite]: oldOrigin, [slot]: newOrigin } : undefined,
    assetOrigin:oldAsset??newAsset, assetFaceOrigins:oldAsset||newAsset?{[opposite]:oldAsset,[slot]:newAsset}:undefined,
    production: card.production || steps.length ? { ...(card.production ?? { dieShape: 'card' }), splitOrder: undefined,
      steps: steps.map(step => step.requiresStepId && !stepIds.has(step.requiresStepId) ? { ...step, requiresStepId: undefined } : step) } : undefined,
  };
}

export function bindCardFaces(project: Project, frontId: string, backId: string): Project {
  const cards = projectCards(project);
  const front = selectedCard(project, frontId);
  const back = selectedCard(project, backId);
  if (!front.singleSided || !back.singleSided || front.looseFace || back.looseFace !== 'back' || frontId === backId)
    throw new Error('请选择一个独立正面和一个独立背面');
  if (front.widthMm !== back.widthMm || front.heightMm !== back.heightMm)
    throw new Error('正背面的成品尺寸不同，请先将宽高调为一致');
  const backProject = projectForCard(project, back);
  const backSide = { ...back.front, stockFinish: getStockFinish(backProject, 'front') };
  if (front.previewStyle !== back.previewStyle) backSide.effects = backSide.effects.map(effect =>
    processKind(effect) === 'reflection' && !effect.flashStyle ? { ...effect, flashStyle: getFlashStyle(backProject, effect) } : effect);
  const frontOrigin = front.faceOrigins ? front.faceOrigins.front : front.communityOrigin;
  const backOrigin = back.faceOrigins ? back.faceOrigins.front : back.communityOrigin;
  const paired: ProjectCard = { ...front, singleSided: false, back: backSide,
    production: joinProduction(front.production, back.production) };
  if (frontOrigin || backOrigin) {
    paired.communityOrigin = frontOrigin ?? backOrigin;
    paired.faceOrigins = { front: frontOrigin, back: backOrigin };
  }
  const frontAsset=front.assetFaceOrigins?front.assetFaceOrigins.front:front.assetOrigin;
  const backAsset=back.assetFaceOrigins?back.assetFaceOrigins.front:back.assetOrigin;
  if(frontAsset||backAsset){
    paired.assetOrigin=frontAsset??backAsset;
    paired.assetFaceOrigins={front:frontAsset,back:backAsset};
  }
  if (backSide.stockFinish.match && !confirmedStockFinish(projectForCard(project, paired), 'back'))
    backSide.stockFinish = withoutSupplierMatch(backSide.stockFinish);
  // Older single-sided cards may still store work on their hidden back.
  const result = cards.flatMap(card => {
    if (card.id !== front.id && card.id !== back.id) return [card];
    const kept = card.id === front.id ? [paired] : [];
    if (hasHiddenDesign(card)) kept.push(isolateFace(project, card, 'back', uid()));
    return kept;
  });
  const { projectCover } = project;
  const workspace = projectCover?.cardId === backId && projectCover.face === 'front'
    ? { ...project, projectCover: { cardId: paired.id, face: 'back' as const } } : project;
  const next = preserveCanvasLayout(project, projectWithMembers(workspace, result, paired.id));
  const anchor = canvasLayoutSnapshot(project)[canvasFacePositionKey(frontId, 'front')];
  return alignPairedCanvasFaces(next, paired, anchor);
}

/** A read-only projection for physical output. Never store it in the workspace. */
export function projectForFaceOutput(project: Project): Project {
  if (!project.singleSided || project.looseFace !== 'back') return project;
  const { looseFace: _role, production, ...rest } = project;
  return { ...rest, singleSided: false, front: unusedSide(), back: project.front,
    production: production && { ...production, splitOrder: undefined, steps: stepsOnFace(production.steps, 'front', 'back') } };
}
