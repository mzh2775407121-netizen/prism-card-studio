import { FLASH_STYLES, getCardCornerRadiusMm, getFlashStyle, plateFor, processKind, processLayerEnabled, effectInProduction, pentagon, type CardNode, type CardSide, type Effect, type Project, type Region, type SideName } from './model';
import { activeImageFill, fillType, gradientPoints, hasFill, hasStroke } from './layerAppearance';
import { isOpenVector, traceVectorPath } from './vectorPaths';
import { getStockAppearance, paintStockOptics, REST_STOCK_LIGHT, stockBlendMode, stockFinishVisible, stockGroundColor, type StockOptics } from './stockOptics';
import { isTransparentStock } from './stockMaterials';

const imagePromises = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imagePromises.get(src);
  if (cached) return cached;
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => {
      imagePromises.delete(src);
      reject(new Error('图片无法读取，请重新上传素材'));
    };
    image.src = src;
  });
  imagePromises.set(src, promise);
  return promise;
}

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function coverCrop(image: HTMLImageElement, node: CardNode) {
  const ratio = Math.max(node.width / image.naturalWidth, node.height / image.naturalHeight);
  const width = node.width / ratio;
  const height = node.height / ratio;
  return { x: (image.naturalWidth - width) / 2, y: (image.naturalHeight - height) / 2, width, height };
}

export function imageCrop(image: HTMLImageElement, node: CardNode) {
  const cover = coverCrop(image, node);
  if (!node.crop) return cover;
  const crop = node.crop;
  if (crop.space === 'source') return {
    x: crop.x * image.naturalWidth, y: crop.y * image.naturalHeight,
    width: crop.width * image.naturalWidth, height: crop.height * image.naturalHeight,
  };
  if (crop.width <= 1 && crop.height <= 1) {
    const cropWidth = Math.max(.01, Math.min(1, crop.width));
    const cropHeight = Math.max(.01, Math.min(1, crop.height));
    return {
      x: cover.x + Math.max(0, Math.min(1 - cropWidth, crop.x)) * cover.width,
      y: cover.y + Math.max(0, Math.min(1 - cropHeight, crop.y)) * cover.height,
      width: cover.width * cropWidth,
      height: cover.height * cropHeight,
    };
  }
  return crop;
}

export function drawImageFill(context: CanvasRenderingContext2D, node: CardNode, image: HTMLImageElement) {
  const fill = activeImageFill(node);
  if (!fill) return;
  if (fill.fit === 'contain') {
    const scale = Math.min(node.width / image.naturalWidth, node.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.drawImage(image, (node.width - width) / 2, (node.height - height) / 2, width, height);
    return;
  }
  const crop = imageCrop(image, { ...node, crop: fill.crop });
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, node.width, node.height);
}

function imageTextPaint(context: CanvasRenderingContext2D, node: CardNode, image: HTMLImageElement) {
  const transform = context.getTransform();
  const scale = Math.min(2 * Math.max(Math.hypot(transform.a,transform.b),Math.hypot(transform.c,transform.d)),
    2600 / Math.max(node.width,node.height));
  const paint = makeCanvas(node.width * scale, node.height * scale);
  const local = paint.getContext('2d')!;
  local.scale(paint.width / node.width, paint.height / node.height);
  drawImageFill(local, node, image);
  const pattern = context.createPattern(paint, 'no-repeat');
  pattern?.setTransform(new DOMMatrix().scale(node.width / paint.width, node.height / paint.height));
  return pattern;
}

function textLines(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const char of paragraph) {
      if (line && context.measureText(line + char).width > width) {
        lines.push(line);
        line = char;
      } else line += char;
    }
    lines.push(line);
  }
  return lines;
}

function fillPaint(context: CanvasRenderingContext2D, node: CardNode) {
  const gradient = node.gradient;
  if (!gradient || fillType(node) === 'solid') return node.fill || '#fff';
  const [[x1, y1], [x2, y2]] = gradientPoints(gradient, node.width, node.height);
  const paint = gradient.kind === 'radial'
    ? context.createRadialGradient(x1, y1, 0, x1, y1, Math.max(.001, Math.hypot(x2 - x1, y2 - y1)))
    : context.createLinearGradient(x1, y1, x2 === x1 && y2 === y1 ? x2 + .001 : x2, y2);
  gradient.stops.forEach(([offset, color]) => paint.addColorStop(offset, color));
  return paint;
}

export function cardTextLayout(context: CanvasRenderingContext2D, node: CardNode) {
  context.save();
  const size = node.fontSize || 24;
  const font = `${node.fontStyle || 'normal'} ${size}px ${node.fontFamily || 'Work Sans, PingFang SC, Microsoft YaHei'}, sans-serif`;
  context.font = font;
  const inset = hasStroke(node) ? Math.min(node.strokeWidth || 0, node.width / 4) : 0;
  context.letterSpacing = `${node.letterSpacing || 0}px`;
  const lines = textLines(context, node.text || '', node.width - inset * 2);
  const lineAdvance = size * (node.lineHeight || 1.3);
  const contentHeight = size + Math.max(0, lines.length - 1) * lineAdvance;
  const spareHeight = Math.max(0, node.height - contentHeight);
  const top = node.verticalAlign === 'middle' ? spareHeight / 2 : node.verticalAlign === 'bottom' ? spareHeight : 0;
  context.textBaseline = 'alphabetic';
  const alphabetic = context.measureText('Mg').actualBoundingBoxAscent;
  context.textBaseline = 'top';
  const baselineOffset = alphabetic - context.measureText('Mg').actualBoundingBoxAscent;
  context.restore();
  return { font, size, inset, lines, lineAdvance, contentHeight, top, baselineOffset };
}

export function drawCardText(context: CanvasRenderingContext2D, node: CardNode, image?: HTMLImageElement) {
  context.save();
  const { font, inset, lines, lineAdvance, top } = cardTextLayout(context, node);
  context.font = font;
  context.textBaseline = 'top';
  context.textAlign = node.align === 'center' ? 'center' : node.align === 'right' ? 'right' : 'left';
  context.letterSpacing = `${node.letterSpacing || 0}px`;
  const stroke = hasStroke(node);
  const imageMode = fillType(node) === 'image';
  const fill = !hasFill(node) ? null : imageMode
    ? (image ? imageTextPaint(context,node,image) : null) : fillPaint(context,node);
  const x = node.align === 'center' ? node.width / 2 : node.align === 'right' ? node.width - inset : inset;
  context.beginPath();
  context.rect(0, 0, node.width, node.height);
  context.clip();
  const alpha = context.globalAlpha;
  if (fill) context.fillStyle = fill;
  if (stroke) {
    context.strokeStyle = node.stroke!;
    context.lineWidth = node.strokeWidth! * 2;
    context.lineJoin = 'round';
  }
  lines.forEach((line, index) => {
    const y = top + index * lineAdvance;
    if (stroke) {
      context.globalAlpha = alpha * (node.strokeOpacity ?? 1);
      context.strokeText(line, x, y);
    }
    if (fill) {
      context.globalAlpha = alpha * (node.fillOpacity ?? 1);
      context.fillText(line, x, y);
    }
  });
  context.restore();
}

export function artworkPath(node: CardNode) {
  const { width, height } = node;
  const path = new Path2D();
  if (node.type === 'line') {
    const [start, end] = node.pathPoints ?? [];
    if (start && end) {
      path.moveTo(start.x * width, start.y * height);
      path.lineTo(end.x * width, end.y * height);
    }
  } else if (node.type === 'path') traceVectorPath(path, node.pathPoints ?? [], width, height, node.pathClosed);
  else if (node.type === 'ellipse') path.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  else if (node.type === 'polygon') {
    const points = node.polygon?.map((value, i) => value * (i % 2 ? height : width)) || pentagon(width, height);
    path.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) path.lineTo(points[i], points[i + 1]);
    path.closePath();
  } else if (node.cornerRadius) path.roundRect(0, 0, width, height, Math.min(node.cornerRadius, width / 2, height / 2));
  else path.rect(0, 0, width, height);
  return path;
}

function drawStroke(context: CanvasRenderingContext2D, node: CardNode, path: Path2D) {
  if (!hasStroke(node)) return;
  const width = node.strokeWidth!;
  const align = isOpenVector(node) ? 'center' : node.strokeAlign ?? 'center';
  context.save();
  if (align === 'inside') context.clip(path);
  if (align === 'outside') {
    const inverse = new Path2D();
    const margin = width * 2;
    inverse.rect(-margin, -margin, node.width + margin * 2, node.height + margin * 2);
    inverse.addPath(path);
    context.clip(inverse, 'evenodd');
  }
  context.globalAlpha *= node.strokeOpacity ?? 1;
  context.strokeStyle = node.stroke!;
  context.lineWidth = align === 'center' ? width : width * 2;
  context.lineJoin = 'round';
  if (node.strokeStyle === 'dashed') context.setLineDash([width * 4, width * 2.5]);
  if (node.strokeStyle === 'dotted') {
    context.lineCap = 'round';
    context.setLineDash([0, width * 3]);
  }
  context.stroke(path);
  context.restore();
}

function paintArtworkContent(context: CanvasRenderingContext2D, node: CardNode, image?: HTMLImageElement) {
  if (node.type === 'empty') return;
  if (node.type === 'text') { drawCardText(context, node, image); return; }
  const path = artworkPath(node);
  if (activeImageFill(node)) {
    if (image && !node.fillHidden) {
      context.save();
      context.globalAlpha *= node.fillOpacity ?? 1;
      context.clip(path);
      drawImageFill(context, node, image);
      context.restore();
    }
  } else if (hasFill(node)) {
    context.save();
    context.globalAlpha *= node.fillOpacity ?? 1;
    context.fillStyle = fillPaint(context, node);
    context.fill(path);
    context.restore();
  }
  drawStroke(context, node, path);
}

export function applyLayerFlip(context: CanvasRenderingContext2D, node: CardNode) {
  const { flipX, flipY, width, height } = node;
  if (flipX || flipY) context.transform(flipX ? -1 : 1, 0, 0, flipY ? -1 : 1, flipX ? width : 0, flipY ? height : 0);
}

function paintArtwork(context: CanvasRenderingContext2D, node: CardNode, image?: HTMLImageElement) {
  if (!node.flipX && !node.flipY) {
    paintArtworkContent(context, node, image);
    return;
  }
  // The layer's local center stays fixed; rotation and page-space clips are outside this reflection.
  context.save();
  applyLayerFlip(context, node);
  paintArtworkContent(context, node, image);
  context.restore();
}

const artworkBuffers = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();

export function drawArtwork(context: CanvasRenderingContext2D, node: CardNode, image?: HTMLImageElement) {
  const combinesFillAndStroke = hasStroke(node) && hasFill(node);
  if (!combinesFillAndStroke || (context.globalAlpha === 1 && context.globalCompositeOperation === 'source-over')) {
    paintArtwork(context, node, image);
    return;
  }
  // Apply layer opacity and blending to the fill and outline together.
  let buffer = artworkBuffers.get(context);
  if (!buffer || buffer.width !== context.canvas.width || buffer.height !== context.canvas.height) {
    buffer = makeCanvas(context.canvas.width, context.canvas.height);
    artworkBuffers.set(context, buffer);
  }
  const local = buffer.getContext('2d')!;
  local.resetTransform();
  local.clearRect(0, 0, buffer.width, buffer.height);
  local.setTransform(context.getTransform());
  paintArtwork(local, node, image);
  context.save();
  context.resetTransform();
  context.drawImage(buffer, 0, 0);
  context.restore();
}

export async function drawNode(context: CanvasRenderingContext2D, node: CardNode, mask = false) {
  if (!node.visible || node.type === 'empty') return;
  const source = activeImageFill(node)?.src;
  const image = source ? await loadImage(source) : undefined;
  context.save();
  context.translate(node.x, node.y);
  context.rotate(node.rotation * Math.PI / 180);
  context.globalAlpha = mask ? 1 : node.opacity;
  if (!mask && node.blend) context.globalCompositeOperation = node.blend as GlobalCompositeOperation;
  drawArtwork(context, node, image);
  context.restore();
}
export async function renderRegionMask(project: Project, side: CardSide, region: Region, scale = 1, visited = new Set<string>(), cached = new Map<string, HTMLCanvasElement>(), includeBleed = false): Promise<HTMLCanvasElement> {
  const existing = cached.get(region.id);
  if (existing) return existing;
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const bleed = includeBleed ? project.bleedMm * 10 : 0;
  const canvas = makeCanvas((width + bleed * 2) * scale, (height + bleed * 2) * scale);
  const context = canvas.getContext('2d')!;
  context.setTransform(scale, 0, 0, scale, bleed * scale, bleed * scale);
  context.fillStyle = '#ffffff';
  if (region.kind === 'full') context.fillRect(-bleed, -bleed, width + bleed * 2, height + bleed * 2);
  if (region.kind === 'border') {
    context.fillRect(16, 16, width - 32, height - 32);
    context.clearRect(25, 25, width - 50, height - 50);
  }
  if (region.kind === 'node') {
    const linked = side.nodes.find(item => item.id === region.nodeId);
    const node = region.binding === 'fixed' ? region.snapshot || linked : linked;
    if (node) {
      const shape = region.binding === 'fixed' && region.bounds ? { ...node, ...region.bounds } : node;
      await drawNode(context, region.maskSource ? { ...shape, visible: true } : shape, true);
      const clip = side.regions.find(item => item.id === node.clipRegionId);
      const branch = new Set(visited).add(region.id);
      if (clip && !branch.has(clip.id) && branch.size < 16) {
        const cutout = await renderRegionMask(project, side, clip, scale, branch, cached, includeBleed);
        context.save();
        context.resetTransform();
        context.globalCompositeOperation = 'destination-in';
        context.drawImage(cutout, 0, 0);
        context.restore();
      }
    } else if (region.bounds) {
      context.save();
      context.translate(region.bounds.x, region.bounds.y);
      context.rotate(region.bounds.rotation * Math.PI / 180);
      context.fillRect(0, 0, region.bounds.width, region.bounds.height);
      context.restore();
    }
  }
  if (region.kind === 'rect' || region.kind === 'ellipse') {
    const bounds = region.bounds || { x: 80, y: 160, width: width - 160, height: height - 320, rotation: 0 };
    context.save();
    context.translate(bounds.x, bounds.y);
    context.rotate(bounds.rotation * Math.PI / 180);
    context.beginPath();
    if (region.kind === 'ellipse') context.ellipse(bounds.width / 2, bounds.height / 2, bounds.width / 2, bounds.height / 2, 0, 0, Math.PI * 2);
    else context.rect(0, 0, bounds.width, bounds.height);
    context.fill();
    context.restore();
  }
  if (region.kind === 'polygon' && region.points?.length) {
    context.beginPath();
    for (let index = 0; index < region.points.length; index += 2) {
      if (index === 0) context.moveTo(region.points[index], region.points[index + 1]);
      else context.lineTo(region.points[index], region.points[index + 1]);
    }
    context.closePath();
    context.fill();
  }
  if (region.kind === 'union' && !visited.has(region.id) && visited.size < 16) {
    const branch = new Set(visited).add(region.id);
    for (const id of region.sources || []) {
      const source = side.regions.find(item => item.id === id);
      if (!source || branch.has(id)) continue;
      const part = await renderRegionMask(project, side, source, scale, branch, cached, includeBleed);
      context.save();
      context.resetTransform();
      context.drawImage(part, 0, 0);
      context.restore();
    }
  }
  for (const stroke of region.strokes) {
    context.save();
    context.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    context.strokeStyle = '#ffffff';
    context.fillStyle = '#ffffff';
    context.lineWidth = stroke.size;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    for (let index = 0; index < stroke.points.length; index += 2) {
      if (index === 0) context.moveTo(stroke.points[index], stroke.points[index + 1]);
      else context.lineTo(stroke.points[index], stroke.points[index + 1]);
    }
    context.stroke();
    if (stroke.points.length === 2) {
      context.beginPath();
      context.arc(stroke.points[0], stroke.points[1], stroke.size / 2, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'source-over';
  if (region.inverted) {
    const inverse = makeCanvas(canvas.width, canvas.height);
    const ctx = inverse.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, inverse.width, inverse.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(canvas, 0, 0);
    cached.set(region.id, inverse);
    return inverse;
  }
  cached.set(region.id, canvas);
  return canvas;
}

export async function renderEffectMask(project: Project, side: CardSide, effect: Effect, scale = 1, includeBleed = false) {
  const bleed = includeBleed ? project.bleedMm * 10 : 0;
  const region = side.regions.find(item => item.id === effect.regionId);
  const area = region && await renderRegionMask(project, side, region, scale, new Set(), new Map(), includeBleed);
  if (!area) return makeCanvas((project.widthMm * 10 + bleed * 2) * scale, (project.heightMm * 10 + bleed * 2) * scale);
  if (effect.maskContent === undefined) return area;
  const mask = makeCanvas(area.width, area.height);
  const context = mask.getContext('2d')!;
  context.setTransform(scale, 0, 0, scale, bleed * scale, bleed * scale);
  for (const node of effect.maskContent) {
    if (node.type !== 'image' || node.maskInk !== 'dark' || !node.visible) {
      await drawNode(context, node, true);
      continue;
    }
    const image = makeCanvas(mask.width, mask.height);
    const ink = image.getContext('2d', { willReadFrequently: true })!;
    ink.setTransform(scale, 0, 0, scale, bleed * scale, bleed * scale);
    await drawNode(ink, node, true);
    const pixels = ink.getImageData(0, 0, image.width, image.height);
    for (let i=0;i<pixels.data.length;i+=4) {
      const luma = pixels.data[i]*.2126 + pixels.data[i+1]*.7152 + pixels.data[i+2]*.0722;
      pixels.data[i+3] *= (255-luma)/255;
    }
    ink.putImageData(pixels,0,0);
    context.save();
    context.resetTransform();
    context.drawImage(image, 0, 0);
    context.restore();
  }
  context.resetTransform();
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(area, 0, 0);
  return mask;
}

function paintFinish(context: CanvasRenderingContext2D, effect: Effect, width: number, height: number, light: number) {
  const angle = (effect.angle + light) * Math.PI / 180;
  const range = Math.max(width, height) * 0.75;
  const dx = Math.cos(angle) * range;
  const dy = Math.sin(angle) * range;
  const gradient = context.createLinearGradient(width / 2 - dx, height / 2 - dy, width / 2 + dx, height / 2 + dy);
  const palette = effect.type === 'gold'
    ? ['#8c6530', '#d4b068', '#fff2be', '#b28a44', '#f0d99c']
    : effect.type === 'silver'
    ? ['#7e8991', '#e1e8ec', '#ffffff', '#8e9ba5', '#e0e9ef']
    : effect.type === 'gloss' || effect.type === 'emboss'
    ? ['rgba(255,255,255,0)', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,.85)', 'rgba(255,255,255,.03)', 'rgba(255,255,255,0.12)']
    : ['#69d7df', '#9d8bd4', '#f3bdc6', '#f6e8a9', '#8bd7ad', '#70d0e0'];
  palette.forEach((color, index) => gradient.addColorStop(index / (palette.length - 1), color));
  context.fillStyle = effect.type === 'white' ? '#fdfdf5' : gradient;
  context.fillRect(0, 0, width, height);
  if (effect.type === 'holo') {
    context.globalAlpha = 0.055;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 0.7;
    for (let x = -height; x < width + height; x += 9) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + height * .7, height);
      context.stroke();
    }
  }
  if (effect.pattern === 'radial') {
    const rays = context.createConicGradient(angle/3, width * .83, height * .46);
    for (let i=0;i<=32;i++) {
      rays.addColorStop(i/32, i%2 ? 'rgba(255,244,212,.8)' : 'rgba(104,63,179,0)');
    }
    context.fillStyle = rays;
    context.fillRect(0,0,width,height);
  }
  if (effect.type === 'grain' || effect.pattern === 'grain') {
    context.clearRect(0, 0, width, height);
    let seed = 73129;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let index = 0; index < 3200; index++) {
      context.globalAlpha = 0.2 + random() * 0.8;
      context.fillStyle = index % 3 === 0 ? '#ffedbb' : '#ffffff';
      const x = random() * width;
      const y = random() * height;
      const size = 0.4 + random() * 1.8;
      context.fillRect(x, y, size, size);
    }
  }
  context.globalAlpha = 1;
}

const flashTextures = new Map<string, Promise<HTMLCanvasElement>>();

function flashTexture(file: string): Promise<HTMLCanvasElement> {
  const cached = flashTextures.get(file);
  if (cached) return cached;
  const pending = loadImage('/assets/album/' + file).then(image => {
    const texture = makeCanvas(image.width, image.height);
    const context = texture.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, texture.width, texture.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const luma = Math.max(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) / 255;
      pixels.data[i + 3] *= (Math.max(0, (luma - .06) / .94)) ** 1.45;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return texture;
  }).catch(error => { flashTextures.delete(file); throw error; });
  flashTextures.set(file, pending);
  return pending;
}

async function paintLocalFlash(project: Project, context: CanvasRenderingContext2D, effect: Effect, width: number, height: number, light: number) {
  const style = getFlashStyle(project, effect);
  if (style === 'linear' || style === 'radial') {
    paintFinish(context, { ...effect, type: 'holo', pattern: style }, width, height, light);
    return;
  }
  const texture = await flashTexture(FLASH_STYLES[style].texture);
  const radius = Math.hypot(width, height) / 2;
  const tileWidth = width * (style === 'geometric' ? .56 : style === 'glitter' ? .86 : 1.04);
  const tileHeight = tileWidth * texture.height / texture.width;
  const angle = (effect.angle + light) * Math.PI / 180;
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate(angle);
  for (let y = -radius; y < radius; y += tileHeight) {
    for (let x = -radius; x < radius; x += tileWidth) context.drawImage(texture, x, y, tileWidth, tileHeight);
  }
  context.restore();
  const dx = Math.cos(angle) * radius, dy = Math.sin(angle) * radius;
  const spectrum = context.createLinearGradient(width / 2 - dx, height / 2 - dy, width / 2 + dx, height / 2 + dy);
  ['#9de9f6','#e6b4fb','#fff5cf','#c1faee','#ffc6dc'].forEach((color,index) => spectrum.addColorStop(index / 4, color));
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = spectrum;
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = 'source-over';
}

export async function renderStockWhiteMask(project: Project, side: CardSide, scale: number, includeBleed = false) {
  const white = side.effects.filter(effect => processKind(effect) === 'white' && processLayerEnabled(effect));
  const masks = await Promise.all(white.map(effect => renderEffectMask(project, side, effect, scale, includeBleed)));
  if (!masks.length) return;
  const whiteMask = makeCanvas(masks[0].width, masks[0].height);
  const context = whiteMask.getContext('2d')!;
  for (const mask of masks) context.drawImage(mask, 0, 0);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, whiteMask.width, whiteMask.height);
  return whiteMask;
}

export async function prepareStockOptics(project: Project, side: CardSide, scale: number, includeBleed = false): Promise<StockOptics | undefined> {
  const finish = getStockAppearance(project, side);
  if (!stockFinishVisible(finish)) return;
  const bleed = includeBleed ? project.bleedMm * 10 : 0;
  const radius = getCardCornerRadiusMm(project) * 10;
  const roundedBleed = radius > 0 && (!project.production || project.production.dieShape === 'card');
  const cornerRadius = (includeBleed ? (roundedBleed ? radius + bleed : 0) : radius) * scale;
  const whiteMask = await renderStockWhiteMask(project, side, scale, includeBleed);
  return { finish, cornerRadius, whiteMask };
}

export async function renderStockReflection(project: Project, side: CardSide, scale: number, includeBleed = false) {
  const optics = await prepareStockOptics(project, side, scale, includeBleed);
  if (!optics) return;
  const margin = includeBleed ? project.bleedMm * 20 : 0;
  const canvas = makeCanvas((project.widthMm * 10 + margin) * scale, (project.heightMm * 10 + margin) * scale);
  paintStockOptics(canvas.getContext('2d')!, optics, REST_STOCK_LIGHT);
  return { canvas, opacity: optics.finish.opacity, blend: stockBlendMode(optics.finish) };
}

export async function renderEffects(project: Project, side: CardSide, scale = 1, light = 0, localFlash = true, includeBleed = false) {
  const margin = includeBleed ? project.bleedMm * 20 : 0;
  const width = project.widthMm * 10 + margin;
  const height = project.heightMm * 10 + margin;
  const output = makeCanvas(width * scale, height * scale);
  const outputContext = output.getContext('2d')!;
  for (const effect of side.effects) {
    const kind = processKind(effect);
    if (!effect.visible || effect.opacity <= 0 || kind === 'white' || kind === 'primer' || kind === 'spot' ||
        (kind === 'reflection' && !localFlash)) continue;
    const mask = await renderEffectMask(project, side, effect, scale, includeBleed);
    const layer = makeCanvas(output.width, output.height);
    const context = layer.getContext('2d')!;
    context.scale(scale, scale);
    if (kind === 'reflection') await paintLocalFlash(project, context, effect, width, height, light);
    else paintFinish(context, effect, width, height, kind === 'deboss' ? light + 180 : light);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(mask, 0, 0);
    outputContext.globalAlpha = effect.opacity;
    outputContext.drawImage(layer, 0, 0);
  }
  return output;
}

export function effectBelongsToPlate(effect: Effect, plate: string) {
  return plateFor(effect) === plate;
}

export interface RenderCardOptions {
  scale?: number; effects?: boolean; plate?: string; layerId?: string; transparentGround?: boolean; bleed?: boolean; light?: number;
  productionOnly?: boolean;
  /** Preview substrate simulation; disable when baking digital effects for print. */
  material?: boolean;
  /** Disable when local flash is rendered as separate, interactive layers. */
  localFlash?: boolean;
}

async function drawStockGround(context: CanvasRenderingContext2D, project: Project, side: CardSide, scale: number, bleed = false) {
  const { width, height } = context.canvas;
  context.save();
  context.resetTransform();
  context.fillStyle = stockGroundColor(project.material, getStockAppearance(project, side));
  context.fillRect(0, 0, width, height);
  if (isTransparentStock(project.material)) {
    const backing = await renderStockWhiteMask(project, side, scale, bleed);
    if (backing) context.drawImage(backing, 0, 0);
  }
  context.restore();
}

export async function renderStockGround(project: Project, side: CardSide, scale: number) {
  const canvas = makeCanvas(project.widthMm * 10 * scale, project.heightMm * 10 * scale);
  await drawStockGround(canvas.getContext('2d')!, project, side, scale);
  return canvas;
}

async function drawCardArtwork(context: CanvasRenderingContext2D, project: Project, side: CardSide, scale: number,
  nodes = side.nodes, includeBleed = false, cached = new Map<string, HTMLCanvasElement>()) {
  const bleed = includeBleed ? project.bleedMm * 10 : 0;
  for (const node of nodes) {
    if (!node.visible || node.type === 'empty') continue;
    const clip = node.clipRegionId && side.regions.find(region => region.id === node.clipRegionId);
    if (!clip) { await drawNode(context, node); continue; }
    const area = await renderRegionMask(project, side, clip, scale, new Set(), cached, includeBleed);
    const clipped = makeCanvas(area.width, area.height);
    const target = clipped.getContext('2d')!;
    target.setTransform(scale, 0, 0, scale, bleed * scale, bleed * scale);
    await drawNode(target, { ...node, blend: undefined });
    target.resetTransform();
    target.globalCompositeOperation = 'destination-in';
    target.drawImage(area, 0, 0);
    context.save();
    context.resetTransform();
    context.globalCompositeOperation = (node.blend || 'source-over') as GlobalCompositeOperation;
    context.drawImage(clipped, 0, 0);
    context.restore();
  }
}

export async function renderArtworkLayers(project: Project, side: CardSide, scale: number) {
  const passes: { nodes: CardNode[]; blend: GlobalCompositeOperation }[] = [];
  for (const node of side.nodes) {
    if (!node.visible || node.type === 'empty' || node.opacity <= 0) continue;
    const blend = (node.blend || 'source-over') as GlobalCompositeOperation;
    const previous = passes.at(-1);
    if (blend === 'source-over' && previous?.blend === blend) previous.nodes.push(node);
    else passes.push({ nodes: [blend === 'source-over' ? node : { ...node, blend: undefined }], blend });
  }
  const masks = new Map<string, HTMLCanvasElement>();
  const layers: { canvas: HTMLCanvasElement; blend: GlobalCompositeOperation }[] = [];
  for (const { nodes, blend } of passes) {
    const canvas = makeCanvas(project.widthMm * 10 * scale, project.heightMm * 10 * scale);
    const context = canvas.getContext('2d')!;
    context.scale(scale, scale);
    await drawCardArtwork(context, project, side, scale, nodes, false, masks);
    layers.push({ canvas, blend });
  }
  return layers;
}

export async function renderCard(project: Project, sideName: SideName, options: RenderCardOptions = {}) {
  await document.fonts.ready;
  const scale = options.scale || 1;
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const bleed = options.bleed ? project.bleedMm * 10 : 0;
  const side = project[sideName];
  const canvas = makeCanvas((width + bleed * 2) * scale, (height + bleed * 2) * scale);
  const context = canvas.getContext('2d')!;
  context.scale(scale, scale);
  if (!options.transparentGround) {
    if (options.plate || options.material === false) {
      const ground = !options.plate && side.nodes.find(n => n.type === 'rect' && n.visible && n.opacity === 1 &&
        n.rotation === 0 && n.x <= 0 && n.y <= 0 && n.x+n.width >= width && n.y+n.height >= height &&
        hasFill(n) && fillType(n) === 'solid' && /^(#[a-f\d]{3}|#[a-f\d]{6})$/i.test(n.fill) &&
        (n.fillOpacity ?? 1) === 1 && !n.clipRegionId);
      context.fillStyle = (ground && ground.fill) || '#ffffff';
      context.fillRect(0, 0, width + bleed * 2, height + bleed * 2);
    } else {
      await drawStockGround(context, project, side, scale, options.bleed);
    }
  }
  context.translate(bleed, bleed);
  if (options.plate) {
    context.resetTransform();
    for (const effect of side.effects) {
      if (!(options.productionOnly ? effectInProduction(effect) : processLayerEnabled(effect)) || !effectBelongsToPlate(effect, options.plate) ||
          (options.layerId && effect.id !== options.layerId)) continue;
      const area = await renderEffectMask(project, side, effect, scale, options.bleed);
      const mask = makeCanvas(area.width, area.height);
      const maskContext = mask.getContext('2d')!;
      maskContext.drawImage(area, 0, 0);
      maskContext.globalCompositeOperation = 'source-in';
      maskContext.fillStyle = '#000000';
      maskContext.fillRect(0, 0, mask.width, mask.height);
      context.drawImage(mask, 0, 0);
    }
    return canvas;
  }
  context.save();
  context.beginPath();
  context.rect(-bleed, -bleed, width + bleed * 2, height + bleed * 2);
  context.clip();
  const stock = options.effects !== false && options.material !== false
    ? await renderStockReflection(project, side, scale, options.bleed) : undefined;
  if (stock) {
    context.save();
    context.resetTransform();
    context.globalAlpha = stock.opacity;
    context.globalCompositeOperation = stock.blend;
    context.drawImage(stock.canvas, 0, 0);
    context.restore();
  }
  await drawCardArtwork(context, project, side, scale, side.nodes, options.bleed);
  if (options.effects !== false) {
    const effects = await renderEffects(project, side, scale, options.light || 0, options.localFlash !== false, options.bleed);
    context.save();
    context.resetTransform();
    context.drawImage(effects, 0, 0);
    context.restore();
  }
  context.restore();
  return canvas;
}
