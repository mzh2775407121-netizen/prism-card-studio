import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'prism-canvas-marquee-'));
const vite = await createServer({ root, cacheDir, configFile: false, optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { hitCanvasMarquee } = await vite.ssrLoadModule('/src/canvasMarquee.ts');
const { artworkIntersectsFace, canvasCardRows, hasFinishedArtwork, trimContainsPoint } = await vite.ssrLoadModule('/src/canvasCardRows.ts');
const { createProject } = await vite.ssrLoadModule('/src/model.ts');
const { removalForLayerUnits, removeSelection } = await vite.ssrLoadModule('/src/maskConsumers.ts');

const rect = (id, x, y, extra = {}) => ({ id, name: id, type: 'rect', x, y, width: 50, height: 50,
  rotation: 0, opacity: 1, fill: '#fff', visible: true, locked: false, ...extra });
const group = (id, parentId) => ({ id, name: id, parentId });

function fixture(nodes, groups = [], dieShape = 'card', bleedMm = 3) {
  const project = createProject('blank');
  project.production = { dieShape, steps: [] };
  project.bleedMm = bleedMm;
  project.front = { ...project.front, nodes, groups };
  const placements = canvasCardRows(project);
  const front = placements[0];
  return {
    target: { cardId: front.cardId, face: 'front' },
    trimAt: (x, y) => trimContainsPoint(front, front.x + x, front.y + y),
    artworkOnFace: (left, top, right, bottom) => artworkIntersectsFace(front, { left, top, right, bottom }),
    artworkVisible: (left, top, right, bottom) => hasFinishedArtwork(front, { left, top, right, bottom }),
    hit: (left, top, right, bottom, options) => hitCanvasMarquee(placements, {
      left: front.x + left, top: front.y + top, right: front.x + right, bottom: front.y + bottom,
    }, options),
  };
}

test('框选部分组成员时选中图层，完整覆盖时选中组，覆盖全部卡内图层时选中卡面', () => {
  const { target, hit } = fixture([
    rect('left', 45, 50, { groupId: 'group' }), rect('right', 120, 50, { groupId: 'group' }), rect('unrelated', 260, 70),
  ], [group('group')]);
  assert.deepEqual(hit(40, 48, 94, 101), { boards: [], layers: [{ ...target, units: [{ id: 'left', kind: 'artwork' }] }] });
  assert.deepEqual(hit(40, 48, 171, 101), { boards: [], layers: [{ ...target, units: [{ id: 'group', kind: 'group' }] }] });
  assert.deepEqual(hit(40, 48, 311, 121), { boards: [target], layers: [] });
});

test('画板外素材可独立命中，并可和整个卡面一同框选', () => {
  const { target, hit } = fixture([rect('card-face', 40, 60), rect('loose', -200, -110)]);
  const outside = { ...target, units: [{ id: 'loose', kind: 'artwork' }] };
  assert.deepEqual(hit(-210, -120, -145, -40), { boards: [], layers: [outside] });
  assert.deepEqual(hit(0, 0, 630, 880), { boards: [target], layers: [] });
  assert.deepEqual(hit(-210, -120, 630, 880), { boards: [target], layers: [outside] });
});

test('成品框选按裁切线截掉卡面图层的所有溢出区域，独立画布素材仍可选中', () => {
  const { target, hit, artworkOnFace, artworkVisible } = fixture([
    rect('bleed', -28, 60, { width: 18 }), rect('outside', -100, 60),
    rect('touching', -20, 200, { width: 20 }), rect('crossing', -50, 140, { width: 80 }), rect('interior', 220, 200),
    rect('bleed-straddle', -50, 300, { width: 45 }), rect('touching-bleed', -80, 400),
  ]);
  const finished = { hideBleed: true };
  const empty = { boards: [], layers: [] };
  const layers = (...ids) => [{ ...target, units: ids.map(id => ({ id, kind: 'artwork' })) }];
  assert.equal(artworkOnFace(-31, 60, -28, 110), true);
  assert.equal(artworkOnFace(-80, 400, -30, 450), false);
  assert.equal(artworkVisible(-28, 60, -10, 110), false);
  assert.equal(artworkVisible(-31, 60, -28, 110), false);
  assert.equal(artworkVisible(-80, 400, -30, 450), true);
  assert.equal(artworkVisible(-28, 60, 1, 110), true);
  assert.deepEqual(hit(-105, 52, -5, 117).layers.map(layer => layer.units.length), [2]);
  assert.deepEqual(hit(-105, 52, -5, 117, finished), { boards: [], layers: layers('outside') });
  assert.deepEqual(hit(-30, 135, -1, 194, finished), empty);
  assert.deepEqual(hit(-25, 198, 10, 256, finished), empty);
  assert.deepEqual(hit(-30, 135, 31, 194, finished), { boards: [], layers: layers('crossing') });
  assert.deepEqual(hit(-51, 135, -30, 194, finished), empty);
  assert.deepEqual(hit(-51, 299, -29, 351), { boards: [], layers: layers('bleed-straddle') });
  assert.deepEqual(hit(-51, 299, -29, 351, finished), empty);
  assert.deepEqual(hit(-81, 399, -30, 451, finished), { boards: [], layers: layers('touching-bleed') });
  assert.deepEqual(hit(0, 0, 630, 880, finished), { boards: [target], layers: [] });
  assert.deepEqual(hit(-110, -10, 630, 880, finished), { boards: [target], layers: layers('touching-bleed', 'outside') });
});

test('出血四角为直角，成品点击和框选按矩形、圆角矩形与椭圆裁切', () => {
  for (const dieShape of ['rectangle', 'card', 'ellipse']) {
    const { target, hit, trimAt, artworkOnFace, artworkVisible } = fixture([
      rect('edge', 0, 0, { width: 320, height: 220 }), rect('interior', 310, 460),
      rect('outer-corner', -29, -29, { width: 4, height: 4 }),
    ], [], dieShape);
    const finished = { hideBleed: true };
    const layers = id => [{ ...target, units: [{ id, kind: 'artwork' }] }];
    assert.equal(trimAt(315, 440), true, dieShape);
    assert.equal(trimAt(-1, 440), false, dieShape);
    const cornerVisible = dieShape === 'rectangle';
    assert.equal(trimAt(2, 2), cornerVisible, dieShape);
    assert.deepEqual(hit(0, 0, 4, 4, finished), { boards: [], layers: cornerVisible ? layers('edge') : [] }, dieShape);

    assert.equal(artworkOnFace(-29, -29, -25, -25), true, dieShape);
    assert.equal(artworkVisible(-29, -29, -25, -25), false, dieShape);
    assert.deepEqual(hit(-29, -29, -24, -24), { boards: [], layers: layers('outer-corner') }, dieShape);
    assert.deepEqual(hit(-29, -29, -24, -24, finished), { boards: [], layers: [] }, dieShape);
  }
});

test('未设置出血时，仍按矩形、圆角矩形与椭圆的成品轮廓裁切', () => {
  for (const dieShape of ['rectangle', 'card', 'ellipse']) {
    const { target, hit, trimAt, artworkOnFace, artworkVisible } = fixture([
      rect('corner', 1, 1, { width: 4, height: 4 }), rect('center', 300, 400),
      rect('crossing', -100, 400, { width: 170 }), rect('independent', -80, 500, { width: 80 }),
    ], [], dieShape, 0);
    const cornerVisible = dieShape === 'rectangle';
    const finished = { hideBleed: true };
    const layers = id => [{ ...target, units: [{ id, kind: 'artwork' }] }];
    assert.equal(trimAt(2, 2), cornerVisible, dieShape);
    assert.equal(artworkOnFace(1, 1, 5, 5), true, dieShape);
    assert.equal(artworkVisible(1, 1, 5, 5), cornerVisible, dieShape);
    assert.deepEqual(hit(0, 0, 6, 6, finished), { boards: [], layers: cornerVisible ? layers('corner') : [] }, dieShape);
    assert.deepEqual(hit(-101, 398, -1, 451, finished), { boards: [], layers: [] }, dieShape);
    assert.deepEqual(hit(2, 398, 69, 451, finished), { boards: [], layers: layers('crossing') }, dieShape);
    assert.deepEqual(hit(-81, 498, 0, 551, finished), { boards: [], layers: layers('independent') }, dieShape);
  }
});

test('成品框选按图层处理组合内的独立素材，且不会把素材归入相邻卡面', () => {
  const { target, hit } = fixture([
    rect('attached', -50, 150, { width: 100, groupId: 'mixed' }),
    rect('independent', -185, 150, { groupId: 'mixed' }),
  ], [group('mixed')]);
  const finished = { hideBleed: true };
  assert.deepEqual(hit(-190, 145, -1, 205, finished), {
    boards: [], layers: [{ ...target, units: [{ id: 'independent', kind: 'artwork' }] }],
  });
  const project = createProject('blank');
  const [front, back] = canvasCardRows(project);
  const world = { x: back.x + 80, y: back.y + 120 };
  project.front.nodes.push(rect('front-independent', world.x - front.x, world.y - front.y));
  project.back.nodes.push(rect('back-owned', 80, 120), rect('back-other', 200, 200));
  const selection = hitCanvasMarquee(canvasCardRows(project), {
    left: world.x + 1, top: world.y + 1, right: world.x + 25, bottom: world.y + 25,
  }, finished);
  assert.deepEqual(selection, { boards: [], layers: [
    { cardId: front.cardId, face: 'front', units: [{ id: 'front-independent', kind: 'artwork' }] },
    { cardId: back.cardId, face: 'back', units: [{ id: 'back-owned', kind: 'artwork' }] },
  ] });
});

test('空白或锁定图层的部分命中不会提升为卡面，且隐藏的锁定成员不会阻止移动其他图层', () => {
  const empty = fixture([]);
  assert.deepEqual(empty.hit(100, 100, 200, 200), { boards: [], layers: [] });
  assert.deepEqual(empty.hit(0, 0, 630, 880), { boards: [empty.target], layers: [] });
  const { target, hit } = fixture([
    rect('free', 10, 10, { groupId: 'parent' }),
    rect('hidden-locked', 50, 20, { groupId: 'hidden', locked: true, visible: false }),
    rect('locked', 210, 115, { locked: true }),
  ], [group('parent'), group('hidden', 'parent')]);
  assert.deepEqual(hit(0, 0, 70, 70), { boards: [], layers: [{ ...target, units: [{ id: 'free', kind: 'artwork' }] }] });
  assert.deepEqual(hit(200, 100, 230, 170), { boards: [], layers: [] });
});

test('批量删除组、子图层和工艺时，保留未选中图层使用的蒙版轮廓', () => {
  const source = rect('source', 45, 50, { groupId: 'nested' });
  const masked = rect('masked', 200, 100, { clipRegionId: 'mask' });
  const retainedEffect = { id: 'retained-effect', regionId: 'mask' };
  const before = {
    nodes: [source, rect('plain', 120, 50), masked],
    effects: [retainedEffect, { id: 'selected-effect', regionId: 'mask', groupId: 'group' }],
    regions: [{ id: 'mask', kind: 'node', nodeId: source.id }],
    groups: [group('group'), group('nested', 'group')],
  };
  const removal = removalForLayerUnits(before, [
    { kind: 'group', id: 'group' }, { kind: 'artwork', id: 'source' }, { kind: 'artwork', id: 'plain' },
    { kind: 'process', id: 'selected-effect' },
  ]);
  assert.deepEqual(removal.artworkIds, ['source', 'plain']);
  assert.deepEqual(removal.effectIds, ['selected-effect']);
  assert.deepEqual(removal.groupIds, ['group', 'nested']);
  const after = removeSelection(before, removal, false);
  assert.deepEqual(after.nodes, [masked]);
  assert.deepEqual(after.effects, [retainedEffect]);
  assert.deepEqual(after.groups, []);
  assert.equal(after.regions[0].binding, 'fixed');
  assert.equal(after.regions[0].nodeId, undefined);
  assert.deepEqual(after.regions[0].snapshot, source);
});
