import assert from 'node:assert/strict';
import test from 'node:test';
import {
  remapTextDraft, replaceTextRange, styleTextRange, textWithoutInlineSymbols, validTextStyles,
} from '../src/textStyles.ts';

test('段内加粗和颜色可分别编辑，原来的样式随中间文字更改', () => {
  const initial = { text: '攻击 20 点' };
  const bold = styleTextRange(initial, 3, 5, { bold: true });
  const colored = styleTextRange(bold, 4, 5, { color: '#237ac2' });
  assert.deepEqual(colored.textStyles, [
    { start: 3, end: 4, bold: true },
    { start: 4, end: 5, bold: true, color: '#237ac2' },
  ]);
  const replaced = replaceTextRange(colored, 4, 5, '00');
  assert.equal(replaced.text, '攻击 200 点');
  assert.deepEqual(replaced.textStyles, [
    { start: 3, end: 4, bold: true },
    { start: 4, end: 6, bold: true, color: '#237ac2' },
  ]);
});

test('行内符号独立随文字移动，删除后不影响相邻样式', () => {
  const draft = styleTextRange({ text: 'Power 20' }, 6, 8, { bold: true });
  const inserted = replaceTextRange(draft, 8, 8, '★', { symbol: true });
  assert.equal(textWithoutInlineSymbols(inserted.text, inserted.textStyles), 'Power 20');
  assert.ok(validTextStyles(inserted.text, inserted.textStyles));
  assert.equal(validTextStyles('Power 20A', inserted.textStyles), false);
  const moved = replaceTextRange(inserted, 0, 0, '技能 ');
  assert.equal(moved.textStyles.at(-1).start, 11);
  assert.deepEqual(replaceTextRange(moved, 11, 12, '').textStyles, [{ start: 9, end: 11, bold: true }]);
});

test('重复文字编辑按光标移动样式，工程验证拒绝重叠与恶意颜色', () => {
  const draft = { text: 'aaa', textStyles: [{ start: 1, end: 2, bold: true }] };
  assert.deepEqual(remapTextDraft(draft, 'aaaa', 0).textStyles, [{ start: 2, end: 3, bold: true }]);
  assert.equal(validTextStyles('abc', [{ start: 0, end: 2, bold: true }, { start: 1, end: 3, bold: false }]), false);
  assert.equal(validTextStyles('abc', [{ start: 0, end: 1, color: 'url(other)' }]), false);
});
