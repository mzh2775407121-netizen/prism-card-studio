import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'prism-print-order-test-'));
const vite = await createServer({ root, cacheDir, configFile: false, optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, watch: null } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });

const { createProject } = await vite.ssrLoadModule('/src/model.ts');
const { createPrintJobProfile, isPrintJobProfile, printSubmissionSides } = await vite.ssrLoadModule('/src/printProfiles.ts');
const { factoryProductionOrder } = await vite.ssrLoadModule('/src/production.ts');
const { makeProcess } = await vite.ssrLoadModule('/src/layers.ts');

test('技术打样保持双面，厂规可只交正面，独立反面继续读取原图层槽位', () => {
  const project = createProject('blank');
  project.production = { dieShape: 'card', steps: [], printProfile: { ...createPrintJobProfile(project, 'raster'), faces: 'front' } };
  assert.deepEqual(printSubmissionSides(project, false), ['front', 'back']);
  assert.deepEqual(printSubmissionSides(project, true), ['front']);
  const looseBack = { ...project, singleSided: true, looseFace: 'back' };
  assert.equal(createPrintJobProfile(looseBack, 'raster').faces, 'either');
  assert.deepEqual(printSubmissionSides(looseBack, false), ['front']);
});

test('同面生产工序按厂规定序，技术打样沿用默认顺序', () => {
  const project = createProject('blank');
  for (const side of ['front', 'back']) {
    const { regions, effects } = project[side];
    effects.push(makeProcess('white', regions[0], '白墨', 'ink-' + side));
    effects.push(makeProcess('foil', regions[0], '箔版', 'foil-' + side));
  }
  const profile = { ...createPrintJobProfile(project, 'specialty'),
    processRules: [{ stage: 'white', after: 'foil', required: true }] };
  assert.ok(isPrintJobProfile(profile));
  const generated = factoryProductionOrder(project, ['front', 'back'], profile);
  assert.deepEqual(generated.issues, []);
  const index = id => generated.steps.findIndex(step => step.id === id);
  for (const side of ['front', 'back']) {
    assert.ok(index(side + ':layer:foil-' + side) < index(side + ':layer:ink-' + side));
  }
  const technical = factoryProductionOrder(project, ['front']);
  assert.deepEqual(technical.steps.map(step => step.id), ['front:layer:ink-front', 'front:artwork', 'front:layer:foil-front', 'die']);
});

test('缺少同一交稿面的必需工序或厂规约束冲突时给出定位', () => {
  const project = createProject('blank');
  project.back.effects.push(makeProcess('foil', project.back.regions[0], '背面箔', 'back-foil'));
  const profile = { ...createPrintJobProfile(project, 'specialty'),
    processRules: [{ stage: 'foil', after: 'white', required: true }] };
  project.front.effects.push(makeProcess('white', project.front.regions[0], '正面白墨', 'front-white'));
  const missing = factoryProductionOrder(project, ['front', 'back'], profile);
  assert.equal(missing.issues[0].step.id, 'back:layer:back-foil');
  assert.match(missing.issues[0].message, /缺少/);
  project.back.effects.push(makeProcess('white', project.back.regions[0], '背面白墨', 'back-white'));
  profile.processRules.push({ stage: 'white', after: 'foil' });
  const cycle = factoryProductionOrder(project, ['front', 'back'], profile);
  assert.match(cycle.issues[0].message, /冲突/);
  assert.equal(isPrintJobProfile({ ...profile, processRules: [{ stage: 'foil', after: 'foil' }] }), false);
});
