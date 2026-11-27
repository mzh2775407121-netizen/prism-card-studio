import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'prism-cover-test-'));
const vite = await createServer({ root, cacheDir, configFile: false, optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, watch: null } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });

const { copyProject, createProject, hydrateProject, projectCards, projectWithMembers, serializeProject } =
  await vite.ssrLoadModule('/src/model.ts');

test('工程封面保存、切换卡牌及复制时保留对应卡面，卡面锁定可恢复', () => {
  const project = hydrateProject(createProject('blank'));
  const [first] = projectCards(project);
  const second = { ...structuredClone(first), id: 'second-card' };
  second.back.canvasLocked = true;
  const document = projectWithMembers(project, [first, second], first.id);
  document.projectCover = { cardId: second.id, face: 'back' };

  const saved = JSON.parse(JSON.stringify(serializeProject(document)));
  const loaded = hydrateProject(saved);
  assert.deepEqual(loaded.projectCover, document.projectCover);
  assert.equal(loaded.additionalCards[0].back.canvasLocked, true);
  assert.equal(projectCards(loaded)[0].projectCover, undefined);
  assert.deepEqual(projectWithMembers(loaded, projectCards(loaded), second.id).projectCover, document.projectCover);

  const copy = copyProject(loaded);
  const [, copiedCover] = projectCards(copy);
  assert.notEqual(copiedCover.id, second.id);
  assert.deepEqual(copy.projectCover, { cardId: copiedCover.id, face: 'back' });
});

test('移除封面卡面和载入无封面的历史工程会回退到默认封面', () => {
  const project = createProject('blank');
  const [card] = projectCards(project);
  const old = hydrateProject(JSON.parse(JSON.stringify(project)));
  assert.equal(old.projectCover, undefined);

  const marked = { ...old, projectCover: { cardId: card.id, face: 'back' } };
  const after = projectWithMembers(marked, [{ ...card, singleSided: true }], card.id);
  assert.equal(after.projectCover, undefined);
  const malformed = { ...serializeProject(marked), projectCover: { cardId: 'missing-id', face: 'front' } };
  assert.equal(hydrateProject(malformed).projectCover, undefined);
});
