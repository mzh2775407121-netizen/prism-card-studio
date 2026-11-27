export interface InlineTextStyle {
  bold?: boolean;
  color?: string;
  symbol?: true;
}

export interface TextStyleRange extends InlineTextStyle {
  start: number;
  end: number;
}

export interface TextDraft {
  text: string;
  textStyles?: TextStyleRange[];
}

export const MAX_TEXT_LENGTH = 50_000;
export const INLINE_SYMBOLS = [
  { text: '★', label: '星形' },
  { text: '◆', label: '菱形' },
  { text: '●', label: '圆形' },
  { text: '▲', label: '三角形' },
  { text: '◇', label: '空心菱形' },
  { text: '✚', label: '十字' },
] as const;

const hexColor = /^#[0-9a-f]{6}$/i;

function styled(range: InlineTextStyle) {
  return range.bold !== undefined || !!range.color || !!range.symbol;
}

function sameStyle(first: InlineTextStyle, second: InlineTextStyle) {
  return first.bold === second.bold && first.color === second.color && first.symbol === second.symbol;
}

export function validTextStyles(text: string, styles: unknown) {
  if (!Array.isArray(styles) || styles.length > text.length) return false;
  let end = 0;
  return styles.every(value => {
    if (!value || typeof value !== 'object') return false;
    const range = value as TextStyleRange;
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < end || range.end <= range.start || range.end > text.length ||
        (range.bold !== undefined && typeof range.bold !== 'boolean') ||
        (range.color !== undefined && (typeof range.color !== 'string' || !hexColor.test(range.color))) ||
        (range.symbol !== undefined && (range.symbol !== true ||
          [...text.slice(range.start, range.end)].some(value => !INLINE_SYMBOLS.some(item => item.text === value)))) ||
        !styled(range)) return false;
    end = range.end;
    return true;
  });
}

export function textSpans({ text, textStyles }: TextDraft): TextStyleRange[] {
  const spans: TextStyleRange[] = [];
  let cursor = 0;
  for (const range of textStyles ?? []) {
    if (range.start > cursor) spans.push({ start: cursor, end: range.start });
    spans.push(range);
    cursor = range.end;
  }
  if (cursor < text.length) spans.push({ start: cursor, end: text.length });
  return spans;
}

function compact(spans: TextStyleRange[]) {
  const ranges: TextStyleRange[] = [];
  for (const range of spans) {
    if (!styled(range) || range.end <= range.start) continue;
    const previous = ranges.at(-1);
    if (previous && previous.end === range.start && sameStyle(previous, range)) previous.end = range.end;
    else ranges.push({ ...range });
  }
  return ranges.length ? ranges : undefined;
}

export function styleTextRange(draft: TextDraft, start: number, end: number, patch: InlineTextStyle): TextDraft {
  if (start >= end) return draft;
  const parts = textSpans(draft).flatMap(span => {
    if (span.end <= start || span.start >= end) return [span];
    return [
      { ...span, end: Math.min(span.end, start) },
      { ...span, ...patch, start: Math.max(start, span.start), end: Math.min(end, span.end) },
      { ...span, start: Math.max(end, span.start) },
    ];
  });
  return { text: draft.text, textStyles: compact(parts) };
}

export function replaceTextRange(draft: TextDraft, start: number, end: number, insert: string,
  patch?: InlineTextStyle): TextDraft {
  let retained = insert.slice(0, MAX_TEXT_LENGTH - (draft.text.length - (end - start)));
  if (retained.length < insert.length && /[\uD800-\uDBFF]$/.test(retained)) retained = retained.slice(0, -1);
  const delta = retained.length - (end - start);
  const ranges = draft.textStyles ?? [];
  const from = ranges.find(range => range.start <= start && start < range.end)
    ?? ranges.find(range => range.start < start && start === range.end);
  const before = ranges.filter(range => range.start < start).map(range => ({ ...range, end: Math.min(range.end, start) }));
  const after = ranges.filter(range => range.end > end)
    .map(range => ({ ...range, start: Math.max(range.start, end) + delta, end: range.end + delta }));
  const insertion = { bold: from?.bold, color: from?.color, ...patch, start, end: start + retained.length };
  return { text: draft.text.slice(0, start) + retained + draft.text.slice(end),
    textStyles: compact([...before, insertion, ...after]) };
}

export function remapTextDraft(draft: TextDraft, next: string, selectionStart: number): TextDraft {
  if (draft.text === next) return draft;
  const source = draft.text;
  let start = 0;
  const prefix = Math.min(source.length, next.length, selectionStart);
  while (start < prefix && source[start] === next[start]) start++;
  let oldEnd = source.length, newEnd = next.length;
  while (oldEnd > start && newEnd > start && source[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  return replaceTextRange(draft, start, oldEnd, next.slice(start, newEnd));
}

export function textWithoutInlineSymbols(text: string | undefined, ranges: TextStyleRange[] | undefined) {
  if (!text || !ranges?.some(range => range.symbol)) return text;
  return textSpans({ text, textStyles: ranges }).map(range => range.symbol ? '' : text.slice(range.start, range.end)).join('');
}
