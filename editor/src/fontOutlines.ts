import {
  artworkFontProblem, assetBytes, BUILTIN_ARTWORK_FONTS, ensureArtworkFont, ensureArtworkTextFonts, fontRefKey, INLINE_TEXT_FONT,
  outlineFontReference, shareableProjectFont, type ArtworkFontReference,
} from './artworkFonts';
import { cardTextLayout } from './render';
import type { CardNode } from './model';
import type { Font, GlyphCommand } from 'fontkit';

type Point = [number, number];
type Command = ['M' | 'L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];
type OutlineRef = Exclude<ArtworkFontReference, { kind: 'device' }>;
const fonts = new Map<string, Promise<Font>>();
const nonGlyph = /[\s\p{Default_Ignorable_Code_Point}]/u;

function fontWithOutlines(ref: OutlineRef) {
  const key = fontRefKey(ref);
  let font = fonts.get(key);
  if (!font) {
    const binary = ref.kind === 'builtin' ? assetBytes(BUILTIN_ARTWORK_FONTS[ref.id].file)
      : shareableProjectFont(ref).then(file => {
        if (!file) throw new Error('所选字体文件缺失或无法用于转曲。');
        return file.bytes;
      });
    font = Promise.all([import('fontkit'), binary]).then(([fontkit, bytes]) => fontkit.create(new Uint8Array(bytes)))
      .catch(error => {
        fonts.delete(key);
        throw error;
      });
    fonts.set(key, font);
  }
  return font;
}

async function loadOutline(ref: OutlineRef) {
  const base = await fontWithOutlines(ref);
  return ref.kind === 'builtin' ? base.getVariation({ wght: ref.weight }) : base;
}

function addGlyph(
  destination: Command[], commands: GlyphCommand[], originX: number, originY: number, scale: number,
) {
  let current: Point = [originX, originY];
  let start = current;
  const position = (x: number, y: number): Point => [originX + x * scale, originY - y * scale];
  for (const { command, args } of commands) {
    switch (command) {
      case 'moveTo':
        start = current = position(args[0], args[1]);
        destination.push(['M', ...current]);
        break;
      case 'lineTo':
        current = position(args[0], args[1]);
        destination.push(['L', ...current]);
        break;
      case 'bezierCurveTo': {
        const first = position(args[0], args[1]);
        const second = position(args[2], args[3]);
        current = position(args[4], args[5]);
        destination.push(['C', ...first, ...second, ...current]);
        break;
      }
      case 'quadraticCurveTo': {
        const control = position(args[0], args[1]);
        const end = position(args[2], args[3]);
        destination.push(['C', current[0] + (control[0] - current[0]) * 2 / 3,
          current[1] + (control[1] - current[1]) * 2 / 3, end[0] + (control[0] - end[0]) * 2 / 3,
          end[1] + (control[1] - end[1]) * 2 / 3, ...end]);
        current = end;
        break;
      }
      case 'closePath':
        current = start;
        destination.push(['Z']);
        break;
    }
  }
}

/** Outline the same line boxes as the canvas in the layer's local units. */
export async function outlineTextNode(context: CanvasRenderingContext2D, node: CardNode): Promise<Command[]> {
  if (!node.text?.trim()) return [];
  if (node.textStyles?.length) throw new Error('段内样式需要保留为可编辑文字，请替换字体或使用技术打样图片。');
  const ref = outlineFontReference(node);
  if (!ref || ref.kind === 'device') throw new Error('所选字体无法验证转曲授权，请换为内置字体或导入获授权的字体文件。');
  if (ref.kind === 'imported' && !ref.share) throw new Error('所选字体尚未授权转曲，请在字体排印中确认授权或替换字体。');
  if (node.fontRef) {
    const problem = await artworkFontProblem(node);
    if (problem) throw new Error(problem);
  } else {
    await ensureArtworkFont(node);
  }
  const font = await loadOutline(ref);
  const { font: css, size, inset, lines, lineAdvance, top, baselineOffset } = cardTextLayout(context, node);
  const scale = size / font.unitsPerEm;
  const spacing = node.letterSpacing || 0;
  const path: Command[] = [];

  context.save();
  try {
    context.font = css;
    context.textBaseline = 'alphabetic';
    context.letterSpacing = `${spacing}px`;
    for (const [lineIndex, text] of lines.entries()) {
      const line = text.replace(/[\r\t\f\v]/g, ' ');
      if (!line.trim()) continue;
      if (Array.from(line).some(character => !nonGlyph.test(character) && !font.hasGlyphForCodePoint(character.codePointAt(0)!))) {
        throw new Error('所选字体缺少必要字形，请选择覆盖这些字符的字体后重新转曲。');
      }
      const run = font.layout(line, spacing ? { liga: false, clig: false } : undefined);
      const advances = run.positions.map(position => position.xAdvance * scale + (position.xAdvance ? spacing : 0));
      const width = context.measureText(line).width;
      const shapedWidth = advances.reduce((sum, advance) => sum + advance, 0);
      if (Math.abs(shapedWidth - width) > Math.max(1, size * .08)) {
        throw new Error('字体的转曲排版与画布不一致，请选择其他字体或使用技术打样图片。');
      }
      let x = node.align === 'center' ? (node.width - width) / 2
        : node.align === 'right' ? node.width - inset - width : inset;
      const baseline = top + lineIndex * lineAdvance + baselineOffset;
      run.glyphs.forEach((glyph, index) => {
        const position = run.positions[index];
        const { commands } = glyph.path;
        if (!commands.length && glyph.codePoints.some(codePoint => !nonGlyph.test(String.fromCodePoint(codePoint)))) {
          throw new Error('所选字体包含不可转曲的字形，请更换字体或使用技术打样图片。');
        }
        addGlyph(path, commands, x + position.xOffset * scale, baseline - position.yOffset * scale, scale);
        x += advances[index];
      });
      if (path.length > 300_000) throw new Error('文字转曲路径过多，请减少内容或拆分交付文件。');
    }
  } finally {
    context.restore();
  }
  return path;
}

/**
 * Canvas positions the styled runs first. Only mint vector paths when the
 * available font outlines agree with each run's measured browser advance.
 */
export async function outlineTextStyles(context: CanvasRenderingContext2D, node: CardNode) {
  const base = outlineFontReference(node);
  const status = await ensureArtworkTextFonts(node);
  if (status.problem || !base || base.kind === 'device' || (base.kind === 'imported' && !base.share)) {
    throw new Error('当前字体无法转曲');
  }
  const { styled, size, inset, top, lineAdvance, baselineOffset } = cardTextLayout(context, node);
  const sections: { color?: string; path: Command[] }[] = [];
  const loaded = new Map<string, Promise<Font>>();
  const fontFor = (ref: OutlineRef) => {
    const key = fontRefKey(ref) + (ref.kind === 'builtin' ? ':' + ref.weight : '');
    let promise = loaded.get(key);
    if (!promise) { promise = loadOutline(ref); loaded.set(key, promise); }
    return promise;
  };
  const spacing = node.letterSpacing || 0;
  let count = 0;
  for (const [index, line] of (styled ?? []).entries()) {
    let x = node.align === 'center' ? (node.width - line.width) / 2 : node.align === 'right' ? node.width - inset - line.width : inset;
    const y = top + index * lineAdvance + baselineOffset;
    for (const run of line.runs) {
      const start = x;
      x += run.width;
      const text = run.text.replace(/[\r\t\f\v]/g, ' ');
      if (!text.trim()) continue;
      if (base.kind === 'imported' && run.style.bold !== undefined && !run.style.symbol) {
        throw new Error('该字重使用浏览器合成字形');
      }
      const weight = run.style.bold !== undefined ? (run.style.bold ? 700 : 400) : base.kind === 'builtin' ? base.weight : 400;
      const fallback = await fontFor({ ...INLINE_TEXT_FONT, weight });
      const font = run.style.symbol ? fallback : await fontFor(base.kind === 'builtin' ? { ...base, weight } : base);
      const fragments: { font: Font; text: string }[] = [];
      for (const character of text) {
        const codePoint = character.codePointAt(0)!;
        const previous = fragments.at(-1);
        const selected = font.hasGlyphForCodePoint(codePoint) ? font
          : fallback.hasGlyphForCodePoint(codePoint) ? fallback
            : nonGlyph.test(character) ? previous?.font ?? font : undefined;
        if (!selected) throw new Error('文字包含不可转曲的回退字形');
        if (previous?.font === selected) previous.text += character;
        else fragments.push({ font: selected, text: character });
      }
      const path: Command[] = [];
      let left = start;
      for (const fragment of fragments) {
        const scale = size / fragment.font.unitsPerEm;
        const shaped = fragment.font.layout(fragment.text, spacing ? { liga: false, clig: false } : undefined);
        for (const [glyphIndex, glyph] of shaped.glyphs.entries()) {
          const position = shaped.positions[glyphIndex];
          if (!glyph.path.commands.length && glyph.codePoints.some(codePoint => !nonGlyph.test(String.fromCodePoint(codePoint)))) {
            throw new Error('文字包含不可转曲的字形');
          }
          addGlyph(path, glyph.path.commands, left + position.xOffset * scale, y - position.yOffset * scale, scale);
          left += position.xAdvance * scale + (position.xAdvance ? spacing : 0);
        }
      }
      if (Math.abs(left - start - run.width) > Math.max(1, size * .08)) throw new Error('转曲排版与画布不一致');
      const previous = sections.at(-1);
      if (previous && previous.color === run.style.color) {
        for (const command of path) previous.path.push(command);
      } else if (path.length) sections.push({ color: run.style.color, path });
      count += path.length;
      if (count > 300_000 || sections.length > 32) throw new Error('文字样式变化或路径过多');
    }
  }
  return sections;
}
