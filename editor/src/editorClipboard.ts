export type ClipboardPayload =
  | { kind: 'empty' }
  | { kind: 'unreadable' }
  | { kind: 'svg'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'image'; file: File };

const svgType = 'image/svg+xml';
const textType = 'text/plain';
const htmlType = 'text/html';
const rasterTypes = ['image/png', 'image/jpeg', 'image/webp'];
const maxSvgBytes = 2_000_000;

type ClipboardFormats = {
  svg?: () => Promise<string>;
  svgFallback?: () => Promise<string>;
  text?: () => Promise<string>;
  html?: () => Promise<string>;
  image?: () => Promise<File | null>;
  hasOtherData: boolean;
};

function startsWithSvg(text: string) {
  let markup = text.trimStart().replace(/^<\?xml\s[^?]*\?>\s*/, '');
  while (markup.startsWith('<!--')) {
    const end = markup.indexOf('-->');
    if (end === -1) return false;
    markup = markup.slice(end + 3).trimStart();
  }
  return /^<svg(?=[\s/>])/.test(markup);
}

function svgDataUrl(text: string) {
  if (text.length > maxSvgBytes * 3) return undefined;
  const match = /^data:image\/svg\+xml(?:;charset=utf-8|;utf8)?(;base64)?,([\s\S]*)$/i.exec(text.trim());
  if (!match) return undefined;
  const source = match[1]
    ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(match[2]), character => character.charCodeAt(0)))
    : decodeURIComponent(match[2]);
  return source || undefined;
}

function inlineSvg(html: string) {
  if (html.length > maxSvgBytes || !/(?:<svg[\s/>]|data:image\/svg\+xml)/i.test(html)) return undefined;
  const template = document.createElement('template');
  template.innerHTML = html;
  const svg = template.content.querySelector('svg');
  if (svg?.namespaceURI === 'http://www.w3.org/2000/svg') return new XMLSerializer().serializeToString(svg);
  const image = template.content.querySelector('img[src^="data:image/svg+xml" i]')?.getAttribute('src');
  if (image) return svgDataUrl(image);
}

async function readSvg(blob: Blob) {
  if (!blob.size || blob.size > maxSvgBytes) throw new Error('Invalid clipboard SVG size');
  return blob.text();
}

async function readFormats(formats: ClipboardFormats): Promise<ClipboardPayload> {
  const explicitSvg = await formats.svg?.();
  if (explicitSvg?.trim()) return { kind: 'svg', text: explicitSvg };
  if (formats.svg) return { kind: 'unreadable' };

  const text = await formats.text?.();
  if (text && startsWithSvg(text)) return { kind: 'svg', text };
  const encodedSvg = text && svgDataUrl(text);
  if (encodedSvg) return { kind: 'svg', text: encodedSvg };
  const html = await formats.html?.();
  const svg = html && inlineSvg(html);
  if (svg) return { kind: 'svg', text: svg };
  if (formats.svgFallback) {
    const source = await formats.svgFallback();
    return source ? { kind: 'svg', text: source } : { kind: 'unreadable' };
  }

  const image = await formats.image?.();
  if (image?.size) return { kind: 'image', file: image };
  if (formats.image) return { kind: 'unreadable' };
  if (text) return { kind: 'text', text };
  return { kind: html || formats.hasOtherData ? 'unreadable' : 'empty' };
}

function isSvgFormat(type: string) {
  const mime = type.toLowerCase().replace(/^web /, '').split(';')[0].trim();
  return mime === svgType || mime === 'application/svg+xml';
}

function isSvgFile(file: File) {
  return isSvgFormat(file.type) || /\.svg$/i.test(file.name);
}

export async function readPasteEvent(data: DataTransfer | null, allowSystemRead = false): Promise<ClipboardPayload> {
  if (!data) return { kind: 'unreadable' };
  try {
    const types = Array.from(data.types);
    // A native paste event exposes its data only during event dispatch.
    const files = [...Array.from(data.files), ...Array.from(data.items)
      .filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file)];
    const svgFile = files.find(isSvgFile);
    const svgFormat = types.find(isSvgFormat);
    const svg = svgFormat ? data.getData(svgFormat) : '';
    const text = data.getData(textType);
    const html = data.getData(htmlType);
    const image = rasterTypes.map(type => files.find(file => file.type === type)).find(Boolean)
      ?? files.find(file => !file.type && /\.(png|jpe?g|webp)$/i.test(file.name));
    return await readFormats({
      svg: svg.trim() ? async () => svg : svgFile ? () => readSvg(svgFile) : undefined,
      // Some browser paste events list SVG MIME but expose its bytes only through Clipboard.read().
      svgFallback: svgFormat && !svg.trim() && !svgFile ? async () => {
        if (!allowSystemRead) return '';
        const payload = await readSystemClipboard();
        return payload.kind === 'svg' ? payload.text : '';
      } : undefined,
      text: async () => text,
      html: async () => html,
      image: image ? async () => image : undefined,
      hasOtherData: files.length > 0 || types.some(type => type !== textType && type !== htmlType),
    });
  } catch {
    return { kind: 'unreadable' };
  }
}

export async function readSystemClipboard(): Promise<ClipboardPayload> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.read) return { kind: 'unreadable' };
  try {
    const items = await clipboard.read();
    let hasUnreadableItem = false;
    for (const item of items) {
      const svg = item.types.find(isSvgFormat);
      const image = rasterTypes.find(type => item.types.includes(type));
      const payload = await readFormats({
        svg: svg ? async () => readSvg(await item.getType(svg)) : undefined,
        text: item.types.includes(textType) ? async () => (await item.getType(textType)).text() : undefined,
        html: item.types.includes(htmlType) ? async () => (await item.getType(htmlType)).text() : undefined,
        image: image ? async () => new File([await item.getType(image)], `剪贴板图片.${image.split('/')[1]}`, { type: image }) : undefined,
        hasOtherData: item.types.some(type => type !== textType && type !== htmlType),
      });
      if (payload.kind === 'unreadable') hasUnreadableItem = true;
      else if (payload.kind !== 'empty') return payload;
    }
    return { kind: hasUnreadableItem ? 'unreadable' : 'empty' };
  } catch {
    return { kind: 'unreadable' };
  }
}
