import { FLASH_STYLES, getFlashStyle, getStockReflection, plateFor, processKind, processLayerEnabled, pentagon, type CardNode, type CardSide, type Effect, type Project, type Region, type SideName } from './model';

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
  const inset = node.stroke ? Math.min(node.strokeWidth || 0, node.width / 4) : 0;
  const x = node.align === 'center' ? node.width / 2 : node.align === 'right' ? node.width - inset : inset;
  context.letterSpacing = `${node.letterSpacing || 0}px`;
  const lines = textLines(context, node.text || '', node.width - inset * 2);
  context.beginPath();
  context.rect(0, 0, node.width, node.height);
  context.clip();
  context.lineJoin = 'round';
  lines.forEach((line, index) => {
    const y = index * size * (node.lineHeight || 1.3);
    if (node.stroke && node.strokeWidth) {
      context.strokeStyle = node.stroke;
      context.lineWidth = node.strokeWidth * 2;
      context.strokeText(line, x, y);
    }
    context.fillText(line, x, y);
  });
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
    if (node.cornerRadius) {
      context.beginPath();
      context.roundRect(0, 0, node.width, node.height, node.cornerRadius);
      context.clip();
    }
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, node.width, node.height);
  } else if (node.type === 'text') {
    drawCardText(context, mask && node.stroke ? { ...node, stroke: '#ffffff' } : node);
  } else {
    drawShape(context, node, mask);
  }
  context.restore();
}

export function drawShape(context: CanvasRenderingContext2D, node: CardNode, mask = false) {
  const { width, height } = node;
  context.fillStyle = mask ? '#fff' : node.fill;
  if (node.gradient && !mask) {
    const angle = node.gradient.angle * Math.PI / 180;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const length = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
    const fill = context.createLinearGradient(width/2-dx*length, height/2-dy*length, width/2+dx*length, height/2+dy*length);
    node.gradient.stops.forEach(([offset, color]) => fill.addColorStop(offset, color));
    context.fillStyle = fill;
  }
  context.beginPath();
  if (node.type === 'ellipse') context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  else if (node.type === 'polygon') {
    const points = node.polygon?.map((value, i) => value * (i % 2 ? height : width)) || pentagon(width, height);
    context.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) context.lineTo(points[i], points[i + 1]);
    context.closePath();
  } else if (node.cornerRadius) context.roundRect(0, 0, width, height, node.cornerRadius);
  else context.rect(0, 0, width, height);
  if (node.fill !== 'transparent' || node.gradient) context.fill();
  if (node.stroke && node.strokeWidth) {
    context.strokeStyle = mask ? '#fff' : node.stroke;
    context.lineWidth = node.strokeWidth;
    context.lineJoin = 'round';
    context.stroke();
  }
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
    if (node) {
      await drawNode(context, region.binding === 'fixed' && region.bounds ? { ...node, ...region.bounds } : node, true);
      const clip = side.regions.find(item => item.id === node.clipRegionId);
      const branch = new Set(visited).add(region.id);
      if (clip && !branch.has(clip.id) && branch.size < 16) {
        const cutout = await renderRegionMask(project, side, clip, scale, branch, cached);
        context.globalCompositeOperation = 'destination-in';
        context.drawImage(cutout, 0, 0, width, height);
        context.globalCompositeOperation = 'source-over';
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

export async function renderEffectMask(project: Project, side: CardSide, effect: Effect, scale = 1) {
  const region = side.regions.find(item => item.id === effect.regionId);
  const area = region && await renderRegionMask(project, side, region, scale);
  if (!area) return makeCanvas(project.widthMm * 10 * scale, project.heightMm * 10 * scale);
  if (effect.maskContent === undefined) return area;
  const mask = makeCanvas(area.width, area.height);
  const context = mask.getContext('2d')!;
  context.scale(scale, scale);
  for (const node of effect.maskContent) {
    if (node.type !== 'image' || node.maskInk !== 'dark' || !node.visible) {
      await drawNode(context, node, true);
      continue;
    }
    const image = makeCanvas(mask.width, mask.height);
    const ink = image.getContext('2d', { willReadFrequently: true })!;
    ink.scale(scale, scale);
    await drawNode(ink, node, true);
    const pixels = ink.getImageData(0, 0, image.width, image.height);
    for (let i=0;i<pixels.data.length;i+=4) {
      const luma = pixels.data[i]*.2126 + pixels.data[i+1]*.7152 + pixels.data[i+2]*.0722;
      pixels.data[i+3] *= (255-luma)/255;
    }
    ink.putImageData(pixels,0,0);
    context.drawImage(image,0,0,mask.width/scale,mask.height/scale);
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

async function renderMaterial(project: Project, side: CardSide, scale: number, light: number) {
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const canvas = makeCanvas(width * scale, height * scale);
  const context = canvas.getContext('2d')!;
  context.scale(scale, scale);
  const stock = getStockReflection(project);
  if (stock !== 'none') {
    context.globalAlpha = stock === 'mirror' ? .11 : .16;
    paintFinish(context, { id: 'material', name: 'material', type: stock === 'mirror' ? 'silver' : 'holo',
      pattern: stock === 'radial' ? 'radial' : 'linear', regionId: '', opacity: 1, angle: 115, visible: true }, width, height, light);
    context.globalAlpha = 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    // Opaque white ink prevents the metallic stock showing through that area.
    context.globalCompositeOperation = 'destination-out';
    for (const effect of side.effects) {
      if (processKind(effect) !== 'white' || !processLayerEnabled(effect)) continue;
      context.drawImage(await renderEffectMask(project, side, effect, scale), 0, 0);
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
    if (!effect.visible || effect.opacity <= 0 || processKind(effect) === 'white') continue;
    const mask = await renderEffectMask(project, side, effect, scale);
    const layer = makeCanvas(output.width, output.height);
    const context = layer.getContext('2d')!;
    context.scale(scale, scale);
    if (processKind(effect) === 'reflection') await paintLocalFlash(project, context, effect, width, height, light);
    else paintFinish(context, effect, width, height, light);
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
    n.fill !== 'transparent' && !n.clipRegionId && !n.gradient);
  context.fillStyle = options.plate ? '#ffffff' : ground?.fill || '#ffffff';
  if (!options.transparentGround) context.fillRect(0, 0, width + bleed * 2, height + bleed * 2);
  context.translate(bleed, bleed);
  if (options.plate) {
    for (const effect of side.effects) {
      if (!processLayerEnabled(effect) || !effectBelongsToPlate(effect, options.plate) ||
          (options.layerId && effect.id !== options.layerId)) continue;
      const area = await renderEffectMask(project, side, effect, scale);
      const mask = makeCanvas(area.width, area.height);
      const maskContext = mask.getContext('2d')!;
      maskContext.drawImage(area, 0, 0);
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
  const cached = new Map<string, HTMLCanvasElement>();
  for (const node of side.nodes) {
    const clip = node.clipRegionId && side.regions.find(region => region.id === node.clipRegionId);
    if (!clip) { await drawNode(context, node); continue; }
    if (!node.visible) continue;
    const area = await renderRegionMask(project, side, clip, scale, new Set(), cached);
    const clipped = makeCanvas(area.width, area.height);
    const target = clipped.getContext('2d')!;
    target.scale(scale, scale);
    await drawNode(target, { ...node, blend: undefined });
    target.resetTransform();
    target.globalCompositeOperation = 'destination-in';
    target.drawImage(area, 0, 0);
    context.globalCompositeOperation = (node.blend || 'source-over') as GlobalCompositeOperation;
    context.drawImage(clipped, 0, 0, width, height);
    context.globalCompositeOperation = 'source-over';
  }
  if (options.effects !== false) {
    const effects = await renderEffects(project, side, scale, options.light || 0, options.material !== false);
    context.drawImage(effects, 0, 0, width, height);
  }
  context.restore();
  return canvas;
}
