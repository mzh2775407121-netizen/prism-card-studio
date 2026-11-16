import { pentagon, type CardNode, type CardSide, type Effect, type Project, type Region, type SideName } from './model';

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

export function imageCrop(image: HTMLImageElement, node: CardNode) {
  const ratio = Math.max(node.width / image.naturalWidth, node.height / image.naturalHeight);
  const width = node.width / ratio;
  const height = node.height / ratio;
  const cover = { x: (image.naturalWidth - width) / 2, y: (image.naturalHeight - height) / 2, width, height };
  if (!node.crop) return cover;
  const crop = node.crop;
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

export function drawCardText(context: CanvasRenderingContext2D, node: CardNode) {
  const size = node.fontSize || 24;
  context.font = `${node.fontStyle || 'normal'} ${size}px ${node.fontFamily || 'Work Sans, PingFang SC, Microsoft YaHei'}, sans-serif`;
  context.textBaseline = 'top';
  context.textAlign = node.align === 'center' ? 'center' : node.align === 'right' ? 'right' : 'left';
  const x = node.align === 'center' ? node.width / 2 : node.align === 'right' ? node.width : 0;
  const lines = textLines(context, node.text || '', node.width);
  context.beginPath();
  context.rect(0, 0, node.width, node.height);
  context.clip();
  lines.forEach((line, index) => context.fillText(line, x, index * size * (node.lineHeight || 1.3)));
}

export async function drawNode(context: CanvasRenderingContext2D, node: CardNode, mask = false) {
  if (!node.visible) return;
  context.save();
  context.translate(node.x, node.y);
  context.rotate(node.rotation * Math.PI / 180);
  context.globalAlpha = mask ? 1 : node.opacity;
  if (!mask && node.blend) context.globalCompositeOperation = node.blend as GlobalCompositeOperation;
  context.fillStyle = mask ? '#ffffff' : node.fill || '#ffffff';
  context.strokeStyle = mask ? '#ffffff' : node.stroke || 'transparent';
  context.lineWidth = node.strokeWidth || 0;
  if (node.type === 'image' && node.src) {
    const image = await loadImage(node.src);
    const crop = imageCrop(image, node);
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, node.width, node.height);
  } else if (node.type === 'text') {
    drawCardText(context, node);
  } else {
    context.beginPath();
    if (node.type === 'ellipse') context.ellipse(node.width / 2, node.height / 2, node.width / 2, node.height / 2, 0, 0, Math.PI * 2);
    else if (node.type === 'polygon') {
      const points = pentagon(node.width, node.height);
      context.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) context.lineTo(points[i], points[i + 1]);
      context.closePath();
    } else context.rect(0, 0, node.width, node.height);
    if (node.fill !== 'transparent') context.fill();
    if (node.stroke && node.strokeWidth) context.stroke();
  }
  context.restore();
}

export async function renderRegionMask(project: Project, side: CardSide, region: Region, scale = 1, visited = new Set<string>(), cached = new Map<string, HTMLCanvasElement>()): Promise<HTMLCanvasElement> {
  const existing = cached.get(region.id);
  if (existing) return existing;
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const canvas = makeCanvas(width * scale, height * scale);
  const context = canvas.getContext('2d')!;
  context.scale(scale, scale);
  context.fillStyle = '#ffffff';
  if (region.kind === 'full') context.fillRect(0, 0, width, height);
  if (region.kind === 'border') {
    context.fillRect(16, 16, width - 32, height - 32);
    context.clearRect(25, 25, width - 50, height - 50);
  }
  if (region.kind === 'node') {
    const linked = side.nodes.find(item => item.id === region.nodeId);
    const node = region.binding === 'fixed' ? region.snapshot || linked : linked;
    if (node) await drawNode(context, region.binding === 'fixed' && region.bounds ? { ...node, ...region.bounds } : node, true);
    else if (region.bounds) {
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
      const part = await renderRegionMask(project, side, source, scale, branch, cached);
      context.drawImage(part, 0, 0, width, height);
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
  if (effect.type === 'grain') {
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

async function renderMaterial(project: Project, side: CardSide, scale: number, light: number) {
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const canvas = makeCanvas(width * scale, height * scale);
  const context = canvas.getContext('2d')!;
  context.scale(scale, scale);
  if (project.material === 'holo' || project.material === 'silver') {
    context.globalAlpha = project.material === 'holo' ? .085 : .11;
    paintFinish(context, { id: 'material', name: 'material', type: project.material === 'holo' ? 'holo' : 'silver',
      regionId: '', opacity: 1, angle: 115, visible: true }, width, height, light);
    context.globalAlpha = 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    // Opaque white ink prevents the metallic stock showing through that area.
    context.globalCompositeOperation = 'destination-out';
    for (const effect of side.effects) {
      if (effect.type !== 'white' || !effect.visible || effect.opacity <= 0) continue;
      const region = side.regions.find(item => item.id === effect.regionId);
      if (region) context.drawImage(await renderRegionMask(project, side, region, scale), 0, 0);
    }
  } else {
    context.fillStyle = project.material === 'black' ? 'rgba(9,20,23,.035)' : 'rgba(246,238,218,.025)';
    context.fillRect(0, 0, width, height);
    let seed = 37219;
    for (let index = 0; index < 1800; index++) {
      seed = seed * 16807 % 2147483647;
      const x = seed / 2147483647 * width;
      seed = seed * 16807 % 2147483647;
      const y = seed / 2147483647 * height;
      context.fillStyle = index % 2 ? 'rgba(255,255,255,.045)' : 'rgba(0,0,0,.025)';
      context.fillRect(x, y, .7, .7);
    }
  }
  return canvas;
}

export async function renderEffects(project: Project, side: CardSide, scale = 1, light = 0, material = true) {
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const output = makeCanvas(width * scale, height * scale);
  const outputContext = output.getContext('2d')!;
  if (material) outputContext.drawImage(await renderMaterial(project, side, scale, light), 0, 0);
  for (const effect of side.effects) {
    if (!effect.visible || effect.opacity <= 0 || effect.type === 'white') continue;
    const region = side.regions.find(item => item.id === effect.regionId);
    if (!region) continue;
    const mask = await renderRegionMask(project, side, region, scale);
    const layer = makeCanvas(output.width, output.height);
    const context = layer.getContext('2d')!;
    context.scale(scale, scale);
    paintFinish(context, effect, width, height, light);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(mask, 0, 0);
    outputContext.globalAlpha = effect.opacity;
    outputContext.drawImage(layer, 0, 0);
  }
  return output;
}

export function effectBelongsToPlate(effect: Effect, plate: string) {
  if (plate === 'foil') return ['gold', 'silver', 'holo'].includes(effect.type);
  if (plate === 'clear') return ['gloss', 'emboss'].includes(effect.type);
  return effect.type === plate;
}

export interface RenderCardOptions {
  scale?: number; effects?: boolean; plate?: string; bleed?: boolean; light?: number;
  /** Preview substrate simulation; disable when baking digital effects for print. */
  material?: boolean;
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
  const ground = side.nodes.find(n => n.type === 'rect' && n.visible && n.opacity === 1 &&
    n.rotation === 0 && n.x <= 0 && n.y <= 0 && n.x+n.width >= width && n.y+n.height >= height &&
    n.fill !== 'transparent');
  context.fillStyle = options.plate ? '#ffffff' : ground?.fill || '#ffffff';
  context.fillRect(0, 0, width + bleed * 2, height + bleed * 2);
  context.translate(bleed, bleed);
  if (options.plate) {
    for (const effect of side.effects) {
      if (!effect.visible || effect.opacity <= 0 || !effectBelongsToPlate(effect, options.plate)) continue;
      const region = side.regions.find(item => item.id === effect.regionId);
      if (!region) continue;
      const mask = await renderRegionMask(project, side, region, scale);
      const maskContext = mask.getContext('2d')!;
      maskContext.globalCompositeOperation = 'source-in';
      maskContext.fillStyle = '#000000';
      maskContext.fillRect(0, 0, mask.width, mask.height);
      context.drawImage(mask, 0, 0, width, height);
    }
    return canvas;
  }
  context.save();
  context.beginPath();
  context.rect(-bleed, -bleed, width + bleed * 2, height + bleed * 2);
  context.clip();
  for (const node of side.nodes) await drawNode(context, node);
  if (options.effects !== false) {
    const effects = await renderEffects(project, side, scale, options.light || 0, options.material !== false);
    context.drawImage(effects, 0, 0, width, height);
  }
  context.restore();
  return canvas;
}
