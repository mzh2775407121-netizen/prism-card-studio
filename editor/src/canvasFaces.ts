import { bindCardFaces, cloneProjectCard, copyCardFace, isolateFace, physicalCardFace, replaceCardFace, swapCardFaceRoles, unlinkCardFaces } from './cardMembers';
import { alignPairedCanvasFaces, canvasFaceKey, canvasLayoutSnapshot, type CanvasFace } from './canvasLayout';
import { validateCardDesign } from './io';
import { projectAtCard, projectCards, projectWithMembers, type CanvasFacePositions, type Project, type ProjectCard } from './model';

export { canvasFaceKey, preserveCanvasLayout, translateCanvasFaces, type CanvasFace } from './canvasLayout';
export { insertProjectCard as insertCanvasCard } from './cardMembers';

export function faceRole(project:Project, target:CanvasFace) {
  return physicalCardFace(projectAtCard(project,target.cardId),target.face);
}

function visibleCard(cards: readonly ProjectCard[], target: CanvasFace) {
  return cards.find(card => card.id === target.cardId && !(card.singleSided && target.face === 'back'));
}

export function canUnlinkCanvasFace(project: Project, target: CanvasFace) {
  const card = visibleCard(projectCards(project), target);
  return Boolean(card && !card.singleSided && !card[target.face].canvasLocked && !card.back.canvasLocked);
}

export function unlinkCanvasFace(project: Project, target: CanvasFace): Project {
  if (!canUnlinkCanvasFace(project, target)) throw Error('请选择未锁定的双面卡牌');
  return unlinkCardFaces(project, target.cardId, target.face);
}

function selectedFaceKeys(positions: CanvasFacePositions, faces: readonly CanvasFace[]) {
  const keys = new Set(faces.map(canvasFaceKey));
  if (keys.size === 0 || [...keys].some(key => !Object.hasOwn(positions, key))) return undefined;
  return keys;
}

export function canDeleteCanvasFaces(project: Project, faces: readonly CanvasFace[]) {
  const positions = canvasLayoutSnapshot(project);
  const keys = selectedFaceKeys(positions, faces);
  if (!keys || keys.size === Object.keys(positions).length) return false;
  const cards = projectCards(project);
  return !faces.some(target => visibleCard(cards, target)?.[target.face].canvasLocked);
}

export function deleteCanvasFaces(project: Project, faces: readonly CanvasFace[]): Project {
  const positions = canvasLayoutSnapshot(project);
  const selected = selectedFaceKeys(positions, faces);
  if (!selected) throw Error('请选择要删除的卡面');
  if (selected.size === Object.keys(positions).length) throw Error('项目至少需要保留一个卡面');

  const cards = projectCards(project);
  if (faces.some(target => visibleCard(cards, target)?.[target.face].canvasLocked)) throw Error('请先解锁选中的卡面');
  const activeIndex = project.activeCardIndex ?? 0;
  let { projectCover } = project;
  if (projectCover && selected.has(canvasFaceKey(projectCover))) projectCover = undefined;
  const survivors = cards.flatMap((card, index) => {
    const front = canvasFaceKey({ cardId: card.id, face: 'front' });
    const back = canvasFaceKey({ cardId: card.id, face: 'back' });
    const deleteFront = selected.has(front);
    const deleteBack = selected.has(back);
    if (!deleteFront && !deleteBack) return [{ card, index }];
    if (card.singleSided || (deleteFront && deleteBack)) return [];

    // A surviving back becomes a standalone back in the visible front slot.
    if (deleteFront) {
      positions[front] = positions[back];
      if (projectCover?.cardId === card.id && projectCover.face === 'back') projectCover = { cardId: card.id, face: 'front' };
    }
    return [{ card: isolateFace(project, card, deleteFront ? 'back' : 'front', card.id), index }];
  });
  const active = survivors.find(item => item.index >= activeIndex) ?? survivors.at(-1)!;
  return projectWithMembers({ ...project, projectCover, canvasFacePositions: positions }, survivors.map(item => item.card), active.card.id);
}

export function canCombineCanvasFaces(project: Project, faces: readonly CanvasFace[]) {
  if (faces.length !== 2) return false;
  const cards = projectCards(project);
  const [first, second] = faces.map(target => visibleCard(cards, target));
  if (!first || !second || first[faces[0].face].canvasLocked || second[faces[1].face].canvasLocked) return false;
  if (first.id !== second.id && [first, second].some(card => !card.singleSided && card.back.canvasLocked)) return false;
  return physicalCardFace(first, faces[0].face) !== physicalCardFace(second, faces[1].face) &&
    first.widthMm === second.widthMm && first.heightMm === second.heightMm;
}

export function combineCanvasFaces(project: Project, faces: readonly CanvasFace[]): Project {
  if (!canCombineCanvasFaces(project, faces)) throw Error('请选择尺寸相同的一张正面和一张背面');
  const [source, target] = faces;
  if (source.cardId !== target.cardId) return pairCanvasFaces(project, source, target);
  const card = projectCards(project).find(card => card.id === source.cardId)!;
  const anchor = canvasLayoutSnapshot(project)[canvasFaceKey({ cardId: card.id, face: 'front' })];
  return alignPairedCanvasFaces(projectAtCard(project, card.id), card, anchor);
}

export function pairCanvasFaces(project:Project, source:CanvasFace, target:CanvasFace):Project {
  const sourceRole=faceRole(project,source), targetRole=faceRole(project,target);
  if(sourceRole===targetRole)throw Error(sourceRole==='front'?'请选择一个背面':'请选择一个正面');
  if(source.cardId===target.cardId)throw Error('这两个卡面已绑定');
  if (!canCombineCanvasFaces(project, [source, target])) throw Error('请选择尺寸相同且可组合的未锁定卡面');
  let next=project;
  const separate=(item:CanvasFace)=>{
    if(projectAtCard(next,item.cardId).singleSided)return item.cardId;
    next=unlinkCanvasFace(next,item);
    return next.cardId!;
  };
  const sourceId=separate(source),targetId=separate(target);
  return sourceRole==='front'?bindCardFaces(next,sourceId,targetId):bindCardFaces(next,targetId,sourceId);
}

function selectedCanvasCard(project: Project, faces: readonly CanvasFace[]) {
  if (faces.length < 1 || faces.length > 2) return undefined;
  const cards = projectCards(project);
  const target = visibleCard(cards, faces[0]);
  if (!target || faces.length === 2 && (target.singleSided || faces[1].cardId !== target.id || faces[1].face === faces[0].face)) return undefined;
  return target;
}

export function canSwapCanvasFaces(project: Project, faces: readonly CanvasFace[]) {
  const card = selectedCanvasCard(project, faces);
  return Boolean(card && !card.front.canvasLocked && (card.singleSided || !card.back.canvasLocked));
}

export function swapCanvasFaces(project: Project, faces: readonly CanvasFace[]): Project {
  const card = selectedCanvasCard(project, faces);
  if (!card) throw Error('请选择一个卡面或一张完整卡牌');
  if (card.front.canvasLocked || (!card.singleSided && card.back.canvasLocked)) throw Error('请先解锁要切换正反面的卡面');

  const positions = canvasLayoutSnapshot(project);
  let { projectCover } = project;
  if (!card.singleSided) {
    const front = canvasFaceKey({ cardId: card.id, face: 'front' });
    const back = canvasFaceKey({ cardId: card.id, face: 'back' });
    // Keep the artwork in place while its physical role and storage slot change.
    const frontPosition = positions[front];
    positions[front] = positions[back];
    positions[back] = frontPosition;
    if (projectCover?.cardId === card.id) {
      projectCover = { cardId: card.id, face: projectCover.face === 'front' ? 'back' : 'front' };
    }
  }
  const cards = projectCards(project).map(item => item.id === card.id ? swapCardFaceRoles(item) : item);
  return projectWithMembers({ ...project, projectCover, canvasFacePositions: positions }, cards, project.cardId ?? project.id + '_1');
}

export function canCopyCanvasFaces(project: Project, faces: readonly CanvasFace[]) {
  return Boolean(selectedCanvasCard(project, faces));
}

export function copyCanvasFaces(project: Project, faces: readonly CanvasFace[]): ProjectCard {
  const card = selectedCanvasCard(project, faces);
  if (!card) throw Error('请选择一个卡面或一张完整卡牌');
  return faces.length === 1 ? copyCardFace(project, card.id, faces[0].face) : cloneProjectCard(card, card.name.slice(0, 495) + ' 副本');
}

export function canReplaceCanvasFaces(project: Project, faces: readonly CanvasFace[], source: ProjectCard) {
  const target = selectedCanvasCard(project, faces);
  if (!target || faces.some(({ face }) => target[face].canvasLocked)) return false;
  if (faces.length === 2) return !source.singleSided;
  if (!source.singleSided) return false;
  if (target.singleSided) return true;
  if (target.widthMm !== source.widthMm || target.heightMm !== source.heightMm) return false;
  const preserved = target.production?.steps.filter(step => step.face !== faces[0].face).length ?? 0;
  const incoming = source.production?.steps.filter(step => step.face === 'front').length ?? 0;
  return preserved + incoming <= 250;
}

export function replaceCanvasFaces(project: Project, faces: readonly CanvasFace[], source: ProjectCard): Project {
  if (!canReplaceCanvasFaces(project, faces, source)) throw Error('无法用剪贴板中的卡牌替换所选卡面');
  const cardId = faces[0].cardId;
  const copy = cloneProjectCard(source);
  const cards = projectCards(project).map(card => {
    if (card.id !== cardId) return card;
    return faces.length === 1 ? replaceCardFace(project, card, faces[0].face, copy) : { ...copy, id: card.id, name: card.name };
  });
  return projectWithMembers({ ...project, canvasFacePositions: canvasLayoutSnapshot(project) }, cards, project.cardId ?? cardId);
}

const facePrefix='prism-card-face/v1\n';
export function encodeClipboardFace(card:ProjectCard) {
  return facePrefix+JSON.stringify(card);
}
export function decodeClipboardFace(text:string):ProjectCard|undefined {
  if(!text.startsWith(facePrefix))return undefined;
  const card=JSON.parse(text.slice(facePrefix.length)) as ProjectCard;
  validateCardDesign(card);
  if(typeof card.name!=='string'||card.name.length>500||!card.name.trim())throw Error('剪贴板中的卡面数据无效');
  return card;
}
