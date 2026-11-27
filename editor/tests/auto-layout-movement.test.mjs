import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'prism-layout-movement-'));
const vite = await createServer({ root, cacheDir, configFile: false, optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { applyAutoLayout, offsetLayoutItem, setAutoLayout } = await vite.ssrLoadModule('/src/autoLayout.ts');
const { moveCanvasLayerUnits } = await vite.ssrLoadModule('/src/transferLayer.ts');

const frame = (overrides = {}) => ({ x: 10, y: 20, width: 250, height: 40, direction: 'horizontal',
  widthMode: 'fixed', heightMode: 'hug', align: 'start', gap: 8,
  padding: { left: 4, top: 3, right: 4, bottom: 3 }, ...overrides });
const rect = (id, groupId, overrides = {}) => ({ id, name: id, groupId, type: 'rect', x: 20, y: 30,
  width: 50, height: 20, fill: '#123456', opacity: 1, rotation: 0, locked: false, visible: true, ...overrides });
const node = (side, id) => side.nodes.find(item => item.id === id);
const group = (side, id) => side.groups.find(item => item.id === id);

test('智能布局子项可微调位置，原槽位、兄弟图层和固定轮廓保持稳定', () => {
  const before = applyAutoLayout({
    nodes: [rect('target', 'parent', { layoutItem: { widthMode: 'fill' } }),
      rect('locked', 'parent', { locked: true }), rect('hidden', 'parent', { visible: false })],
    groups: [{ id: 'parent', name: 'Parent', autoLayout: frame() }],
    regions: [], effects: [],
  });
  const target = node(before, 'target');
  const fixed = { id: 'contour', nodeId: target.id, kind: 'node', binding: 'fixed', strokes: [] };
  const moved = applyAutoLayout({ ...before, regions: [fixed], nodes: before.nodes.map(item => item === target
    ? { ...item, layoutItem: offsetLayoutItem(item.layoutItem, { x: -13, y: 21 }) } : item) });
  assert.deepEqual(node(moved, target.id), { ...target, x: target.x - 13, y: target.y + 21,
    layoutItem: { ...target.layoutItem, offset: { x: -13, y: 21 } } });
  assert.equal(node(moved, 'locked'), node(before, 'locked'));
  assert.equal(node(moved, 'hidden'), node(before, 'hidden'));
  assert.equal(group(moved, 'parent'), group(before, 'parent'));
  assert.equal(moved.regions[0].snapshot.x, target.x);
  assert.equal(moved.regions[0].snapshot.y, target.y);
  assert.equal(applyAutoLayout(moved), moved);

  const removed = setAutoLayout(moved, 'parent', undefined);
  assert.deepEqual(node(removed, target.id), { ...node(moved, target.id), layoutItem: target.layoutItem });
});

test('智能布局中的普通组和嵌套智能组可微调，并带动各自的内容', () => {
  const before = applyAutoLayout({
    nodes: [rect('plain-leaf', 'plain'), rect('auto-leaf', 'auto'), rect('auto-hidden', 'auto', { visible: false }),
      rect('untouched', 'parent')],
    groups: [{ id: 'parent', name: 'Parent', autoLayout: frame() },
      { id: 'plain', name: 'Plain', parentId: 'parent' },
      { id: 'auto', name: 'Auto', parentId: 'parent', autoLayout: frame({ width: 75 }) }],
    regions: [], effects: [],
  });
  const delta = { x: 23, y: -8 };
  const moved = applyAutoLayout({ ...before, groups: before.groups.map(item => item.parentId
    ? { ...item, layoutItem: offsetLayoutItem(item.layoutItem, delta) } : item) });
  for (const id of ['plain-leaf', 'auto-leaf', 'auto-hidden']) {
    const previous = node(before, id);
    assert.deepEqual(node(moved, id), { ...previous, x: previous.x + delta.x, y: previous.y + delta.y });
  }
  assert.equal(node(moved, 'untouched'), node(before, 'untouched'));
  assert.equal(group(moved, 'parent'), group(before, 'parent'));
  assert.equal(applyAutoLayout(moved), moved);

  const removed = setAutoLayout(moved, 'parent', undefined);
  assert.equal(group(removed, 'plain').layoutItem, undefined);
  assert.equal(group(removed, 'auto').layoutItem, undefined);
  assert.deepEqual(removed.nodes, moved.nodes);
});

test('位置偏移忽略非有限值，并在移回原位后清理元数据', () => {
  const sizing = { widthMode: 'fill' };
  assert.equal(offsetLayoutItem(sizing, { x: Infinity, y: 4 }), sizing);
  const limited = offsetLayoutItem(sizing, { x: 1e40, y: -1e40 });
  assert.deepEqual(limited, { ...sizing, offset: { x: 1_000_000, y: -1_000_000 } });
  assert.deepEqual(offsetLayoutItem(limited, { x: -1_000_000, y: 1_000_000 }), sizing);
  assert.equal(offsetLayoutItem({ offset: { x: 1, y: 0 } }, { x: -1, y: -0 }), undefined);
});

test('组合与子图层同时被框选时，子图层只移动一次，锁定层留在原处', () => {
  const before = applyAutoLayout({
    nodes: [rect('child', 'group'), rect('loose', 'parent'), rect('locked', 'parent', { locked: true })],
    groups: [{ id: 'parent', name: 'Parent', autoLayout: frame() }, { id: 'group', name: 'Group', parentId: 'parent' }],
    regions: [], effects: [],
  });
  const selected = [{ kind: 'group', id: 'group' }, ...['child', 'loose', 'locked'].map(id => ({ kind: 'artwork', id }))];
  const delta = { x: 14, y: -6 };
  const after = moveCanvasLayerUnits({ front: before }, 'front', selected, delta);
  for (const id of ['child', 'loose']) {
    assert.equal(node(after, id).x, node(before, id).x + delta.x);
    assert.equal(node(after, id).y, node(before, id).y + delta.y);
  }
  assert.equal(node(after, 'locked'), node(before, 'locked'));
  assert.equal(group(after, 'parent'), group(before, 'parent'));
});
