type ImageFormat = 'png' | 'jpeg';

type EncodingOptions = {
  quality?: number;
  failureMessage?: string;
};

const PNG_HEADER = 0x49484452; // IHDR
const PNG_DENSITY = 0x70485973; // pHYs
const PNG_SRGB = 0x73524742; // sRGB
const PNG_ICC = 0x69434350; // iCCP
const PNG_COLOR_INFO = 0x63494350; // cICP

function pngChunk(type: number, payload: Uint8Array) {
  const chunk = new Uint8Array(payload.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length);
  view.setUint32(4, type);
  chunk.set(payload, 8);
  let crc = -1;
  for (const value of chunk.subarray(4, -4)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  view.setUint32(chunk.length - 4, (crc ^ -1) >>> 0);
  return chunk;
}

function pngDensity(blob: Blob, view: DataView, dpi: number, isSrgb: boolean) {
  // pHYs measures pixels per metre. Keep the encoded image data intact.
  const density = new Uint8Array(9);
  const densityView = new DataView(density.buffer);
  const pixelsPerMeter = Math.round(dpi / .0254);
  densityView.setUint32(0, pixelsPerMeter);
  densityView.setUint32(4, pixelsPerMeter);
  density[8] = 1;

  if (view.byteLength < 33 || view.getBigUint64(0) !== 0x89504e470d0a1a0an ||
      view.getUint32(8) !== 13 || view.getUint32(12) !== PNG_HEADER) throw new Error('PNG 文件结构无效');
  const chunks: Blob[] = [];
  let hasColorInfo = false;
  for (let offset = 33; offset < view.byteLength;) {
    if (view.byteLength - offset < 12) throw new Error('PNG 文件结构无效');
    const size = view.getUint32(offset) + 12;
    if (size > view.byteLength - offset) throw new Error('PNG 文件结构无效');
    const type = view.getUint32(offset + 4);
    if (type === PNG_SRGB || type === PNG_ICC || type === PNG_COLOR_INFO) hasColorInfo = true;
    if (type !== PNG_DENSITY) chunks.push(blob.slice(offset, offset + size));
    offset += size;
  }

  const parts: BlobPart[] = [blob.slice(0, 33)];
  if (isSrgb && !hasColorInfo) parts.push(pngChunk(PNG_SRGB, Uint8Array.of(0)));
  return new Blob([...parts, pngChunk(PNG_DENSITY, density), ...chunks], { type: 'image/png' });
}

function jpegDensity(blob: Blob, view: DataView, dpi: number) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) throw new Error('JPEG 文件结构无效');
  const density = Uint8Array.of(1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255);
  if (view.byteLength >= 20 && view.getUint16(2) === 0xffe0 && view.getUint16(4) >= 16 &&
      view.getUint32(6) === 0x4a464946 && view.getUint8(10) === 0) {
    return new Blob([blob.slice(0, 13), density, blob.slice(18)], { type: 'image/jpeg' });
  }
  const jfif = Uint8Array.of(0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, ...density, 0, 0);
  return new Blob([blob.slice(0, 2), jfif, blob.slice(2)], { type: 'image/jpeg' });
}

export async function encodeDigitalImage(canvas: HTMLCanvasElement, format: ImageFormat, dpi: number, {
  quality = .94, failureMessage = '无法生成图片，请降低分辨率后重试',
}: EncodingOptions = {}) {
  if (!Number.isInteger(dpi) || dpi < 1 || dpi > 65535) throw new Error('图片分辨率无效');
  const mime = `image/${format}`;
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    data => data?.type === mime ? resolve(data) : reject(new Error(failureMessage)), mime, quality));
  const view = new DataView(await blob.arrayBuffer());
  if (format === 'jpeg') return jpegDensity(blob, view, dpi);

  const context = canvas.getContext('2d');
  const colorSpace = context?.getContextAttributes?.().colorSpace ?? 'srgb';
  return pngDensity(blob, view, dpi, context !== null && colorSpace === 'srgb');
}
