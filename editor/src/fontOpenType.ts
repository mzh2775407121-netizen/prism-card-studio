export const MAX_FONT_BYTES = 24 * 1024 * 1024;
export const FONT_FILE_ACCEPT = '.ttf,.otf';

export interface OpenTypeInfo {
  family: string;
  style: string;
  postScriptName: string;
  format: 'otf' | 'ttf';
  weight: number;
  shareable: boolean;
  hasGlyph: (codePoint: number) => boolean;
}

function invalidFont(): never {
  throw new Error('字体文件损坏或不完整。');
}

function fontTables(view: DataView) {
  const signature = view.getUint32(0);
  if (signature !== 0x00010000 && signature !== 0x4f54544f && signature !== 0x74727565) {
    throw new Error('请选择静态 TTF 或 OTF 字体。');
  }
  const tableCount = view.getUint16(4);
  const directory = new Map<string, DataView>();
  if (!tableCount || tableCount > 256 || 12 + tableCount * 16 > view.byteLength) invalidFont();
  for (let index = 0; index < tableCount; index++) {
    const entry = 12 + index * 16;
    const tag = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + entry, 4));
    const offset = view.getUint32(entry + 8);
    const length = view.getUint32(entry + 12);
    if (offset + length > view.byteLength) invalidFont();
    directory.set(tag, new DataView(view.buffer, view.byteOffset + offset, length));
  }
  return { directory, format: signature === 0x4f54544f ? 'otf' as const : 'ttf' as const };
}

function fontNames(view?: DataView) {
  const names = new Map<number, { value: string; priority: number }>();
  if (!view || view.byteLength < 6) return names;
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  if (6 + count * 12 > view.byteLength || storage > view.byteLength) invalidFont();
  for (let index = 0; index < count; index++) {
    const record = 6 + index * 12;
    const platform = view.getUint16(record);
    const macRoman = platform === 1 && view.getUint16(record + 2) === 0;
    if (platform !== 0 && platform !== 3 && !macRoman) continue;
    const language = view.getUint16(record + 4);
    const nameId = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const start = storage + view.getUint16(record + 10);
    if (start + length > view.byteLength || (!macRoman && length % 2)) continue;
    const value = new TextDecoder(macRoman ? 'macintosh' : 'utf-16be').decode(new Uint8Array(view.buffer, view.byteOffset + start, length))
      .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 150);
    const priority = language === 0x0804 || language === 0x0404 ? 4 : language === 0x0409 ? 3 : macRoman ? 1 : 2;
    if (value && priority > (names.get(nameId)?.priority || 0)) names.set(nameId, { value, priority });
  }
  return names;
}

function coverage(view: DataView | undefined): OpenTypeInfo['hasGlyph'] {
  if (!view || view.byteLength < 4) return invalidFont();
  const count = view.getUint16(2);
  if (4 + count * 8 > view.byteLength) return invalidFont();
  const formats = new Map<number, DataView>();
  for (let index = 0; index < count; index++) {
    const entry = 4 + index * 8;
    const platform = view.getUint16(entry);
    const encoding = view.getUint16(entry + 2);
    if (platform !== 0 && (platform !== 3 || ![1, 10].includes(encoding))) continue;
    const offset = view.getUint32(entry + 4);
    if (offset + 16 > view.byteLength) continue;
    const format = view.getUint16(offset);
    const length = format === 4 ? view.getUint16(offset + 2) : format === 12 ? view.getUint32(offset + 4) : 0;
    if (length >= 16 && offset + length <= view.byteLength) {
      formats.set(format, new DataView(view.buffer, view.byteOffset + offset, length));
    }
  }
  const full = formats.get(12);
  const basic = formats.get(4);
  const groups = full?.getUint32(12) || 0;
  const segments = (basic?.getUint16(6) || 0) / 2;
  if ((!full && !basic) || (full && 16 + groups * 12 > full.byteLength) ||
      (basic && (segments < 1 || !Number.isInteger(segments) || 16 + segments * 8 > basic.byteLength))) return invalidFont();
  return codePoint => {
    if (full) {
      let low = 0, high = groups - 1;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        const entry = 16 + mid * 12;
        const start = full.getUint32(entry);
        const end = full.getUint32(entry + 4);
        if (codePoint < start) high = mid - 1;
        else if (codePoint > end) low = mid + 1;
        else return full.getUint32(entry + 8) + codePoint - start !== 0;
      }
    }
    if (!basic || codePoint > 0xffff) return false;
    let low = 0, high = segments - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (codePoint > basic.getUint16(14 + mid * 2)) low = mid + 1;
      else high = mid;
    }
    const end = basic.getUint16(14 + low * 2);
    const start = basic.getUint16(16 + segments * 2 + low * 2);
    if (codePoint < start || codePoint > end) return false;
    const delta = basic.getInt16(16 + segments * 4 + low * 2);
    const range = 16 + segments * 6 + low * 2;
    const offset = basic.getUint16(range);
    if (!offset) return ((codePoint + delta) & 0xffff) !== 0;
    const glyphIndex = range + offset + (codePoint - start) * 2;
    if (glyphIndex + 2 > basic.byteLength) return false;
    const glyph = basic.getUint16(glyphIndex);
    return glyph > 0 && ((glyph + delta) & 0xffff) !== 0;
  };
}

export function readOpenType(buffer: ArrayBuffer, allowVariable = false): OpenTypeInfo {
  if (buffer.byteLength < 12 || buffer.byteLength > MAX_FONT_BYTES) invalidFont();
  const { directory, format } = fontTables(new DataView(buffer));
  if (!allowVariable && directory.has('fvar')) throw new Error('请选择静态 TTF 或 OTF，暂不支持可变字体文件。');
  const names = fontNames(directory.get('name'));
  const family = names.get(16)?.value ?? names.get(1)?.value;
  const style = names.get(17)?.value ?? names.get(2)?.value;
  const postScriptName = names.get(6)?.value;
  if (!family || !style || !postScriptName) throw new Error('字体缺少字族、字重或 PostScript 名称。');
  const os2 = directory.get('OS/2');
  const fsType = os2 && os2.byteLength >= 10 ? os2.getUint16(8) : undefined;
  return {
    family, style, postScriptName, format, weight: os2 && os2.byteLength >= 6 ? os2.getUint16(4) : 400,
    shareable: fsType !== undefined && (fsType & 0x0202) === 0 && ((fsType & 0x000c) === 0 || (fsType & 0x0008) !== 0),
    hasGlyph: coverage(directory.get('cmap')),
  };
}
