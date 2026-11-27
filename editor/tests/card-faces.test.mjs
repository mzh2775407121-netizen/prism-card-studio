import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'prism-face-test-'));
const vite = await createServer({ root, cacheDir, configFile: false, optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, watch: null } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { copyProject, createProject, hydrateProject, projectCards, projectAtCard, serializeProject, projectWithMembers } = await vite.ssrLoadModule('/src/model.ts');
const { bindCardFaces, blankCardAfter, copyCardFace, insertProjectCard, projectForFaceOutput, unlinkCardFaces } = await vite.ssrLoadModule('/src/cardMembers.ts');
const { stockKeys, confirmedStockFinish } = await vite.ssrLoadModule('/src/stockMaterials.ts');
const { canCombineCanvasFaces, combineCanvasFaces, canDeleteCanvasFaces, deleteCanvasFaces,
  copyCanvasFaces, canReplaceCanvasFaces, replaceCanvasFaces, encodeClipboardFace, decodeClipboardFace,
  canSwapCanvasFaces, swapCanvasFaces,
} = await vite.ssrLoadModule('/src/canvasFaces.ts');
const { canvasFaceKey, canvasLayoutSnapshot, preserveCanvasLayout, translateCanvasFaces } = await vite.ssrLoadModule('/src/canvasLayout.ts');

function setup() {
  const project = hydrateProject(createProject('ocean'));
  project.material = 'holo';
  project.back.stockFinish = { style: 'dots', opacity: .65 };
  project.production = { dieShape: 'card', steps: [
    { id: 'front:artwork', kind: 'artwork', face: 'front', name: '彩稿' },
    { id: 'back:artwork', kind: 'artwork', face: 'back', name: '彩稿', requiresStepId: 'front:artwork' },
    { id: 'laminate', kind: 'lamination', face: 'both', name: '覆膜' },
    { id: 'back:layer:' + project.back.effects[0].id, layerId: project.back.effects[0].id,
      kind: 'layer', face: 'back', name: '背面箔', requiresStepId: 'back:artwork' },
    { id: 'die', kind: 'die', face: 'both', name: '模切', requiresStepId: 'laminate' },
  ] };
  return project;
}

test('拆分两面、工程保存重开和重新绑定保留内容、混排工序、依赖及原卡标识', () => {
  const original = setup();
  original.projectCover = { cardId: original.cardId, face: 'back' };
  const split = unlinkCardFaces(original, original.cardId, 'back');
  assert.equal(split.looseFace, 'back');
  assert.deepEqual(split.front.nodes, original.back.nodes);
  assert.equal(split.front.stockFinish.opacity, .65);
  const loaded = hydrateProject(JSON.parse(JSON.stringify(serializeProject(split))));
  const [front, back] = projectCards(loaded);
  assert.equal(front.id, original.cardId);
  assert.equal(back.looseFace, 'back');
  assert.deepEqual(loaded.projectCover, { cardId: back.id, face: 'front' });
  assert.equal(back.production.steps[0].id, 'front:artwork');
  assert.equal(back.production.steps[0].requiresStepId, undefined);
  const output = projectForFaceOutput(projectAtCard(loaded, back.id));
  assert.deepEqual(output.back.nodes, original.back.nodes);
  assert.ok(output.production.steps.some(step => step.id === 'back:layer:' + original.back.effects[0].id));
  const rebound = bindCardFaces(loaded, front.id, back.id);
  assert.equal(projectCards(rebound).length, 1);
  assert.equal(rebound.cardId, front.id);
  assert.deepEqual(rebound.projectCover, original.projectCover);
  assert.deepEqual(rebound.front.nodes, original.front.nodes);
  assert.deepEqual(rebound.back.effects, original.back.effects);
  assert.deepEqual(JSON.parse(JSON.stringify(rebound.production)), original.production);
});

test('粘贴为独立背面，重建素材与工艺关联；从该面继续新建为空白双面', () => {
  const original = setup();
  const copy = copyCardFace(original, original.cardId, 'back');
  assert.equal(copy.looseFace, 'back');
  assert.notEqual(copy.front.nodes[0].id, original.back.nodes[0].id);
  const effect = copy.front.effects[0];
  assert.ok(copy.front.regions.some(region => region.id === effect.regionId));
  assert.ok(copy.production.steps.some(step => step.id === 'front:layer:' + effect.id && step.layerId === effect.id));
  copy.front.nodes[0].name = '独立修改';
  assert.notEqual(copy.front.nodes[0].name, original.back.nodes[0].name);
  const current = insertProjectCard(original, copy);
  assert.equal(current.looseFace, 'back');
  const blank = blankCardAfter(current);
  assert.equal(blank.singleSided, false);
  for (const side of [blank.front, blank.back]) assert.equal(side.nodes.length + side.effects.length, 0);
});

test('异源卡面绑定采用正面纸张、保留独立光效和社区来源、取消失效料号', () => {
  const original = setup();
  const front = copyCardFace(original, original.cardId, 'front');
  const back = copyCardFace(original, original.cardId, 'back');
  back.communityOrigin = { workId: 'community-work', edition: 1, author: '原作者' };
  back.material = 'silver';
  back.production.printer = '印厂';
  back.production.stockCode = 'ABC';
  back.production.printProfile = { product: '样卡', version: '1', reference: '打样依据', route: 'raster' };
  const project = projectWithMembers(original, [front, back], back.id);
  back.front.stockFinish.match = { ...stockKeys(project), orientationDeg: 72, transparent: false,
    materialCode: 'silver-1', patternCode: 'dots-4', method: 'composite' };
  assert.ok(confirmedStockFinish(project,'front'));
  const mixed = bindCardFaces(project, front.id, back.id);
  assert.equal(mixed.material, front.material);
  assert.equal(mixed.back.stockFinish.style, 'dots');
  assert.equal(mixed.back.stockFinish.match, undefined);
  assert.equal(mixed.back.stockFinish.appearance.orientationDeg, 72);
  assert.ok(mixed.back.stockFinish.reviewRequired);
  assert.deepEqual(mixed.communityOrigin, back.communityOrigin);
  const [a, b] = projectCards(unlinkCardFaces(mixed, front.id, 'front'));
  assert.equal(a.communityOrigin, undefined);
  assert.deepEqual(b.communityOrigin, back.communityOrigin);
});

test('不同资产来源随卡面绑定、翻面及工程往返保留作者和版本', () => {
  const original = setup();
  const frontOrigin = { assetId: 'asset-a', version: 2, authorId: 'creator-a', author: '作者甲' };
  const backOrigin = { assetId: 'asset-b', version: 3, authorId: 'creator-b', author: '作者乙' };
  const front = { ...copyCardFace(original, original.cardId, 'front'), assetOrigin: frontOrigin };
  const back = { ...copyCardFace(original, original.cardId, 'back'), assetOrigin: backOrigin };
  const project = projectWithMembers(original, [front, back], front.id);
  const bound = bindCardFaces(project, front.id, back.id);
  assert.deepEqual(bound.assetFaceOrigins, { front: frontOrigin, back: backOrigin });
  const swapped = swapCanvasFaces(bound, [{ cardId: front.id, face: 'front' }]);
  const loaded = hydrateProject(JSON.parse(JSON.stringify(serializeProject(swapped))));
  assert.deepEqual(loaded.assetFaceOrigins, { front: backOrigin, back: frontOrigin });
  const separated = projectCards(unlinkCardFaces(loaded, front.id, 'back'));
  assert.deepEqual(separated.find(card => card.looseFace !== 'back').assetOrigin, backOrigin);
  assert.deepEqual(separated.find(card => card.looseFace === 'back').assetOrigin, frontOrigin);
});

test('保留旧单面工程的隐藏画稿，尺寸不同时原子拒绝绑定', () => {
  const original = setup();
  const front = projectCards({ ...original, singleSided: true })[0];
  const back = copyCardFace(original, original.cardId, 'back');
  const project = projectWithMembers(original, [front, back], front.id);
  const bound = bindCardFaces(project, front.id, back.id);
  const preserved = projectCards(bound).find(card => card.looseFace === 'back');
  assert.deepEqual(preserved.front.nodes, original.back.nodes);
  const mismatch = projectWithMembers(project, [front, { ...back, widthMm: 65 }], front.id);
  assert.throws(() => bindCardFaces(mismatch, front.id, back.id), /尺寸不同/);
  assert.equal(projectCards(mismatch).length, 2);
});

test('批量移动仅更改卡面位置，切换当前卡、重开或复制项目后仍保留布局', () => {
  const original = setup();
  const extra = blankCardAfter(original);
  const project = insertProjectCard(original, extra);
  const front = { cardId: original.cardId, face: 'front' };
  const back = { cardId: extra.id, face: 'back' };
  const before = canvasLayoutSnapshot(project);
  const delta = { x: -1400.5, y: 380.25 };
  const moved = translateCanvasFaces(project, [front, back], delta);
  const expected = structuredClone(before);
  for (const key of [canvasFaceKey(front), canvasFaceKey(back)]) {
    expected[key].x += delta.x;
    expected[key].y += delta.y;
  }
  assert.deepEqual(canvasLayoutSnapshot(moved), expected);
  assert.deepEqual(projectCards(moved), projectCards(project));
  assert.deepEqual(canvasLayoutSnapshot(projectAtCard(moved, original.cardId)), expected);
  assert.deepEqual(canvasLayoutSnapshot(hydrateProject(JSON.parse(JSON.stringify(serializeProject(moved))))), expected);
  const duplicate = copyProject(moved);
  assert.deepEqual(Object.values(canvasLayoutSnapshot(duplicate)), Object.values(expected));
  assert.ok(projectCards(duplicate).every(card => card.id !== original.cardId && card.id !== extra.id));
  const removed = preserveCanvasLayout(moved, projectWithMembers(moved, projectCards(moved).slice(0, 1), front.cardId));
  assert.deepEqual(canvasLayoutSnapshot(removed), {
    [canvasFaceKey(front)]: expected[canvasFaceKey(front)],
    [canvasFaceKey({ ...front, face: 'back' })]: expected[canvasFaceKey({ ...front, face: 'back' })],
  });
});

test('组合固定正面并排列背面，原搭档保留位置，允许重新排列现有配对', () => {
  const original = setup();
  const extra = { ...blankCardAfter(original), material: 'matte', cornerRadiusMm: 1.8, bleedMm: 5 };
  const front = { cardId: original.cardId, face: 'front' };
  const originalBack = { ...front, face: 'back' };
  const extraFront = { cardId: extra.id, face: 'front' };
  const back = { ...extraFront, face: 'back' };
  const moved = translateCanvasFaces(insertProjectCard(original, extra), [front, back], { x: -600, y: 700 });
  const before = canvasLayoutSnapshot(moved);
  assert.ok(canCombineCanvasFaces(moved, [front, back]));
  for (const targets of [[front], [front, extraFront], [front, extraFront, back]]) {
    assert.equal(canCombineCanvasFaces(moved, targets), false);
  }
  assert.equal(canCombineCanvasFaces({ ...moved, widthMm: extra.widthMm - 1 }, [front, back]), false);

  const result = combineCanvasFaces(moved, [back, front]);
  const after = canvasLayoutSnapshot(result);
  const anchor = before[canvasFaceKey(front)];
  assert.deepEqual(after[canvasFaceKey(front)], anchor);
  const width = (original.widthMm + original.bleedMm * 2) * 10;
  assert.deepEqual(after[canvasFaceKey(originalBack)], { x: anchor.x + width + Math.max(48, width * .165), y: anchor.y });
  assert.deepEqual(after[canvasFaceKey(extraFront)], before[canvasFaceKey(extraFront)]);
  const looseBack = projectCards(result).find(card => card.looseFace);
  assert.ok(looseBack);
  assert.deepEqual(after[canvasFaceKey({ cardId: looseBack.id, face: 'front' })], before[canvasFaceKey(originalBack)]);
  assert.equal(result.material, original.material);
  assert.equal(result.bleedMm, original.bleedMm);

  const offset = translateCanvasFaces(result, [originalBack], { x: 80, y: 500 });
  const realigned = combineCanvasFaces(offset, [front, originalBack]);
  assert.deepEqual(canvasLayoutSnapshot(realigned), after);
});

test('删除正面保留背面的位置、卡牌标识、工序与来源', () => {
  const original = setup();
  const origin = { workId: 'back-work', edition: 1, author: '背面作者' };
  original.faceOrigins = { front: { ...origin, workId: 'front-work' }, back: origin };
  const front = { cardId: original.cardId, face: 'front' };
  const back = { ...front, face: 'back' };
  original.back.canvasLocked = true;
  original.projectCover = back;
  const project = translateCanvasFaces(original, [back], { x: 370, y: 55 });

  assert.equal(canDeleteCanvasFaces(project, [front]), true);
  const updated = deleteCanvasFaces(project, [front]);
  assert.equal(updated.cardId, original.cardId);
  assert.equal(updated.cardName, original.cardName);
  assert.equal(updated.singleSided, true);
  assert.equal(updated.looseFace, 'back');
  assert.deepEqual(updated.front, original.back);
  assert.deepEqual(updated.back, { nodes: [], regions: [], effects: [] });
  assert.deepEqual(updated.communityOrigin, origin);
  assert.equal(updated.faceOrigins, undefined);
  assert.deepEqual(updated.projectCover, front);
  assert.equal(canDeleteCanvasFaces(project, [back]), false);
  assert.throws(() => deleteCanvasFaces(project, [back]), /解锁/);
  assert.deepEqual(updated.production.steps.map(step => [step.id, step.requiresStepId]), [
    ['front:artwork', undefined], ['laminate', undefined],
    ['front:layer:' + original.back.effects[0].id, 'front:artwork'], ['die', 'laminate'],
  ]);
  assert.deepEqual(canvasLayoutSnapshot(updated), { [canvasFaceKey(front)]: canvasLayoutSnapshot(project)[canvasFaceKey(back)] });
  const stored = JSON.parse(JSON.stringify(serializeProject(updated)));
  const reopened = hydrateProject(stored);
  assert.deepEqual(JSON.parse(JSON.stringify(serializeProject(reopened))), stored);
  assert.deepEqual(canvasLayoutSnapshot(reopened), canvasLayoutSnapshot(updated));
  assert.equal(project.singleSided, original.singleSided);
  assert.deepEqual(project.front, original.front);
});

test('双面卡交换正反面时保持画布位置，封面、素材和工艺随对应卡面', () => {
  const original = setup();
  const front = { cardId: original.cardId, face: 'front' };
  const back = { ...front, face: 'back' };
  const frontOrigin = { workId: 'front-work', edition: 1, author: '正面作者' };
  const backOrigin = { ...frontOrigin, workId: 'back-work', author: '背面作者' };
  original.faceOrigins = { front: frontOrigin, back: backOrigin };
  original.projectCover = front;
  original.production.steps[2].requiresStepId = 'back:artwork';
  original.production.steps.push({ id: 'front-finish', kind: 'coating', face: 'front', name: '自定义工序',
    requiresStepId: 'front:artwork' });
  const other = blankCardAfter(original);
  const project = translateCanvasFaces(insertProjectCard(original, other), [back], { x: -180, y: 60 });
  const before = structuredClone(serializeProject(project));
  const positions = canvasLayoutSnapshot(project);
  const [frontKey, backKey] = [canvasFaceKey(front), canvasFaceKey(back)];
  assert.ok(canSwapCanvasFaces(project, [back]));
  assert.ok(canSwapCanvasFaces(project, [back, front]));
  assert.equal(canSwapCanvasFaces(project, [back, back]), false);
  assert.equal(canSwapCanvasFaces(project, [back, { cardId: other.id, face: 'front' }]), false);

  const swapped = swapCanvasFaces(project, [back]);
  assert.equal(swapped.cardId, other.id);
  const card = projectAtCard(swapped, original.cardId);
  assert.deepEqual(card.front, original.back);
  assert.deepEqual(card.back, original.front);
  assert.deepEqual(card.faceOrigins, { front: backOrigin, back: frontOrigin });
  assert.deepEqual(swapped.projectCover, back);
  assert.deepEqual(canvasLayoutSnapshot(swapped), { ...positions,
    [frontKey]: positions[backKey], [backKey]: positions[frontKey],
  });
  assert.deepEqual(card.production.steps.map(step => [step.id, step.face, step.requiresStepId]), [
    ['back:artwork', 'back', undefined],
    ['front:artwork', 'front', 'back:artwork'],
    ['laminate', 'both', 'front:artwork'],
    ['front:layer:' + original.back.effects[0].id, 'front', 'front:artwork'],
    ['die', 'both', 'laminate'],
    ['front-finish', 'back', 'back:artwork'],
  ]);
  assert.deepEqual(serializeProject(hydrateProject(serializeProject(swapped))), serializeProject(swapped));
  assert.deepEqual(serializeProject(swapCanvasFaces(swapped, [back, front])), before);
  assert.deepEqual(serializeProject(project), before);

  original.back.canvasLocked = true;
  assert.equal(canSwapCanvasFaces(original, [front]), false);
  assert.throws(() => swapCanvasFaces(original, [front]), /解锁/);
});

test('独立卡面切换正反面时保留位置和印刷内容，拆分的原搭档可以反向组合', () => {
  const original = setup();
  const standalone = copyCardFace(original, original.cardId, 'back');
  const project = projectWithMembers(original, [standalone], standalone.id);
  const target = { cardId: standalone.id, face: 'front' };
  project.projectCover = target;
  assert.ok(canSwapCanvasFaces(project, [target]));
  const front = swapCanvasFaces(project, [target]);
  assert.equal(front.looseFace, undefined);
  assert.deepEqual(front.projectCover, target);
  assert.deepEqual(front.front, standalone.front);
  assert.deepEqual(front.production, standalone.production);
  assert.deepEqual(canvasLayoutSnapshot(front), canvasLayoutSnapshot(project));
  const back = swapCanvasFaces(front, [target]);
  assert.equal(back.looseFace, 'back');
  const output = projectForFaceOutput(back);
  assert.deepEqual(output.back, standalone.front);
  assert.ok(output.production.steps.some(step => step.id === 'back:layer:' + standalone.front.effects[0].id));
  assert.equal(canSwapCanvasFaces(back, [{ ...target, face: 'back' }]), false);

  const split = unlinkCardFaces(original, original.cardId, 'back');
  const newFront = swapCanvasFaces(split, [{ cardId: split.cardId, face: 'front' }]);
  const newBack = swapCanvasFaces(newFront, [{ cardId: original.cardId, face: 'front' }]);
  const paired = bindCardFaces(newBack, split.cardId, original.cardId);
  const expected = swapCanvasFaces(original, [{ cardId: original.cardId, face: 'front' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(paired.production)), JSON.parse(JSON.stringify(expected.production)));
});

test('删除整卡后保持其他画板位置，选择相邻卡牌，保留最后一个卡面', () => {
  const original = setup();
  const firstId = original.cardId;
  const second = blankCardAfter(original);
  const project = insertProjectCard(original, second);
  const firstFront = { cardId: firstId, face: 'front' };
  const secondFront = { cardId: second.id, face: 'front' };
  const secondBack = { ...secondFront, face: 'back' };
  const positions = canvasLayoutSnapshot(project);
  project.projectCover = secondFront;

  const onlyFirst = deleteCanvasFaces(project, [secondFront, secondBack]);
  assert.equal(onlyFirst.cardId, firstId);
  assert.equal(onlyFirst.projectCover, undefined);
  assert.deepEqual(projectCards(onlyFirst), projectCards(original));
  assert.deepEqual(canvasLayoutSnapshot(onlyFirst), Object.fromEntries(Object.entries(positions).filter(([key]) => key.startsWith(firstId + ':'))));

  const frontOnly = deleteCanvasFaces(onlyFirst, [{ ...firstFront, face: 'back' }]);
  assert.equal(frontOnly.singleSided, true);
  assert.equal(frontOnly.looseFace, undefined);
  assert.deepEqual(frontOnly.front.nodes, original.front.nodes);
  assert.equal(canDeleteCanvasFaces(frontOnly, [firstFront]), false);
  assert.throws(() => deleteCanvasFaces(frontOnly, [firstFront]), /保留一个卡面/);
  assert.equal(canDeleteCanvasFaces(project, [{ cardId: 'stale-card', face: 'front' }]), false);
});

test('双面卡剪贴板保留工艺，粘贴替换保持目标卡牌标识与两面位置', () => {
  const original = setup();
  original.back.canvasLocked = true;
  const front = { cardId: original.cardId, face: 'front' };
  const back = { ...front, face: 'back' };
  const copy = decodeClipboardFace(encodeClipboardFace(copyCanvasFaces(original, [front, back])));
  assert.equal(copy.singleSided, original.singleSided);
  assert.equal(copy.back.canvasLocked, undefined);
  assert.notEqual(copy.back.effects[0].id, original.back.effects[0].id);
  assert.ok(copy.production.steps.some(step => step.layerId === copy.back.effects[0].id));

  const blank = blankCardAfter(original);
  const targetFront = { cardId: blank.id, face: 'front' };
  const targetBack = { ...targetFront, face: 'back' };
  const project = translateCanvasFaces(insertProjectCard(original, blank), [targetBack], { x: 130, y: 240 });
  project.projectCover = targetBack;
  assert.equal(canReplaceCanvasFaces(project, [targetFront, targetBack], copy), true);
  assert.equal(canReplaceCanvasFaces(project, [front, back], copy), false);
  assert.equal(canCombineCanvasFaces(project, [front, targetBack]), false);
  const next = replaceCanvasFaces(project, [targetFront, targetBack], copy);
  assert.equal(next.cardId, blank.id);
  assert.equal(next.cardName, blank.name);
  assert.equal(next.back.nodes.length, original.back.nodes.length);
  assert.notEqual(next.back.effects[0].id, copy.back.effects[0].id);
  assert.deepEqual(next.projectCover, targetBack);
  assert.deepEqual(canvasLayoutSnapshot(next), canvasLayoutSnapshot(project));
});

test('单面粘贴替换只修改选中面，保留其余卡面与共享印制参数', () => {
  const original = setup();
  original.production.printer = '原印厂';
  original.front.canvasLocked = true;
  const target = { cardId: original.cardId, face: 'back' };
  const source = copyCanvasFaces(original, [{ ...target, face: 'front' }]);
  source.communityOrigin = { workId: 'clipboard-work', edition: 1, author: '剪贴板作品作者' };
  assert.equal(canReplaceCanvasFaces(original, [target], { ...source, widthMm: source.widthMm + 1 }), false);
  const next = replaceCanvasFaces(original, [target], source);
  assert.deepEqual(canvasLayoutSnapshot(next), canvasLayoutSnapshot(original));
  assert.equal(next.front, original.front);
  assert.notEqual(next.back.nodes[0].id, source.front.nodes[0].id);
  assert.equal(next.back.nodes[0].name, source.front.nodes[0].name);
  assert.equal(next.production.printer, original.production.printer);
  assert.equal(next.production.steps.filter(step => step.kind === 'lamination').length, 1);
  assert.equal(next.production.steps.some(step => step.id === 'back:layer:' + original.back.effects[0].id), false);
  assert.deepEqual(next.faceOrigins.back, source.communityOrigin);
});
