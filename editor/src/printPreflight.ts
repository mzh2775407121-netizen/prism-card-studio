import JSZip from 'jszip';
import { effectInProduction, getStockReflection, plateFor, type CardNode, type CardSide, type Effect, type Project, type Region, type SideName } from './model';
import { activeImageFill, hasFill, hasStroke, patternTileWidth } from './layerAppearance';
import { artworkFontProblem, regionTextNodes } from './artworkFonts';
import { autoLayoutOverflow } from './autoLayout';
import { intersectsPrint, printNodeBounds, vectorRasterReason } from './vectorPrint';
import { outlineTextNode, outlineTextStyles } from './fontOutlines';
import { visualEffectsActive } from './visualEffects';
import { isOutsidePrintSafeArea } from './PrintGuides';
import { clippedText, imageCrop, loadImage, makeCanvas, renderCard, renderEffectMask } from './render';
import { findThinSection } from './plateDetails';
import { DIE_SHAPES, FACE_LABELS, PLATE_LABELS, factoryProductionOrder } from './production';
import { PRINT_SAFE_MARGIN_MM, printSpotNames, projectPrintProfile, validSpotName, type PrintJobProfile, type TechnicalPrintProfile } from './printProfiles';
import { effectiveStockSpec, needsStockFinishMatch, stockDelivery, stockPreset, STOCK_CORES, STOCK_FINISH_METHODS } from './stockMaterials';
import { encodeDigitalImage } from './digitalImage';
import { physicalCardFace, projectForFaceOutput } from './cardMembers';

export type PreflightTarget = { side: SideName; nodeId?: string; effectId?: string; groupId?: string; material?: boolean; reflection?: boolean };
export type PreflightIssue = { target: PreflightTarget; text: string; blocking: boolean };

function imageResolution(node: CardNode, image: HTMLImageElement, minPpi: number) {
  const fill = activeImageFill(node);
  const tileWidth = patternTileWidth(node, fill);
  if (tileWidth !== undefined || fill?.fit === 'contain') {
    const scale = tileWidth !== undefined ? tileWidth / image.naturalWidth : Math.min(node.width / image.naturalWidth, node.height / image.naturalHeight);
    return { ppi: 254 / scale, width: Math.ceil(image.naturalWidth * scale * minPpi / 254), height: Math.ceil(image.naturalHeight * scale * minPpi / 254) };
  }
  const crop = imageCrop(image, { ...node, crop: fill?.crop });
  return { ppi: Math.min(crop.width / node.width, crop.height / node.height) * 254,
    width: Math.ceil(node.width * minPpi / 254), height: Math.ceil(node.height * minPpi / 254) };
}


const availableFonts = new Set<string>();
function fontAvailable(context: CanvasRenderingContext2D, families: string) {
  const normalized = families.split(',').map(value => value.trim().replace(/^['"]|['"]$/g, ''));
  if (normalized.some(value => /^(?:sans-serif|serif|monospace|system-ui|cursive|fantasy)$/i.test(value))) return true;
  if (availableFonts.has(families)) return true;
  const probe = 'MW@~%āЬfij23409';
  const result = normalized.some(font => ['serif', 'monospace'].some(fallback => {
    context.font = `48px ${fallback}`;
    const baseline = context.measureText(probe).width;
    context.font = `48px ${JSON.stringify(font)}, ${fallback}`;
    return Math.abs(context.measureText(probe).width - baseline) > .01;
  }));
  if (result) availableFonts.add(families);
  return result;
}

function linkedMaskNode(face: CardSide, region: Region) {
  return region.binding === 'fixed' && region.snapshot ? region.snapshot : face.nodes.find(node => node.id === region.nodeId);
}

function hasRasterMaskEdit(face: CardSide, region: Region | undefined, visited = new Set<string>()): boolean {
  if (!region || visited.has(region.id)) return false;
  visited.add(region.id);
  if (region.kind === 'paint' || region.strokes.length) return true;
  const ids = [...region.sources ?? [], linkedMaskNode(face, region)?.clipRegionId];
  return ids.some(id => id && hasRasterMaskEdit(face, face.regions.find(item => item.id === id), visited));
}

type MaskPixels = { effect: Effect; width: number; height: number; scale: number; left: number; top: number; right: number; bottom: number; pixels: Uint8Array };
async function analyzeMask(project: Project, face: CardSide, effect: Effect, detailMm = 0): Promise<MaskPixels> {
  const span = Math.max(project.widthMm, project.heightMm) + 2 * project.bleedMm;
  const scale = detailMm ? Math.min(Math.max(1.2, 4 / (detailMm * 10)), 1800 / (span * 10)) : Math.min(1.2, 900 / (span * 10));
  const canvas = await renderEffectMask(project, face, effect, scale, true);
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 1;
  const pixels = new Uint8Array(width * height);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (data[index * 4 + 3] < 128) continue;
      pixels[index] = 1;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return { effect, width, height, scale, left, top, right, bottom, pixels };
}

async function hasPrintMaskCoverage(project: Project, face: CardSide, effect: Effect, dpi: number) {
  const canvas = await renderEffectMask(project, face, effect, dpi / 254, true);
  const { width, height } = canvas;
  const context = canvas.getContext('2d')!;
  try {
    for (let y = 0; y < height; y += 64) {
      const { data } = context.getImageData(0, y, width, Math.min(64, height - y));
      for (let index = 3; index < data.length; index += 4) if (data[index] > 127) return true;
    }
    return false;
  } finally {
    canvas.width = canvas.height = 1;
  }
}

function inkDistance(masks: MaskPixels[], within: number) {
  const { width, height } = masks[0];
  const distance = new Float32Array(width * height).fill(Infinity);
  for (const { pixels } of masks) {
    for (let index = 0; index < pixels.length; index++) {
      if (pixels[index]) distance[index] = 0;
    }
  }
  if (!within) return distance;
  const diagonal = Math.SQRT2;
  // 8-neighbour distance bounds same-resolution Euclidean separation
  // conservatively. Use it for confident conflicts, not false-precision claims.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x > 0) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
      if (y > 0) {
        distance[i] = Math.min(distance[i], distance[i - width] + 1);
        if (x > 0) distance[i] = Math.min(distance[i], distance[i - width - 1] + diagonal);
        if (x < width - 1) distance[i] = Math.min(distance[i], distance[i - width + 1] + diagonal);
      }
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y < height - 1) {
        distance[i] = Math.min(distance[i], distance[i + width] + 1);
        if (x > 0) distance[i] = Math.min(distance[i], distance[i + width - 1] + diagonal);
        if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + width + 1] + diagonal);
      }
    }
  }
  return distance;
}

function requestedDimensions(project: Project, dpi: number) {
  const scale = dpi / 25.4;
  return [project.widthMm, project.heightMm].map(side => Math.round((side + 2 * project.bleedMm) * scale)) as [number, number];
}

async function uncoveredBleed(project:Project, side:SideName) {
  if (!project.bleedMm) return [];
  const scale=Math.min(.4,480/(Math.max(project.widthMm,project.heightMm)*10));
  const canvas=await renderCard(project,side,{scale,bleed:true,transparentGround:true,effects:false,material:false});
  const {width,height}=canvas;
  const {data}=canvas.getContext('2d')!.getImageData(0,0,width,height);
  canvas.width=canvas.height=1;
  const bleed=Math.max(1,Math.round(project.bleedMm*10*scale));
  const alpha=(x:number,y:number)=>data[(y*width+x)*4+3];
  const edges=[
    {label:'左',points:(n:number)=>[[bleed,n],[0,n]],length:height},
    {label:'右',points:(n:number)=>[[width-bleed-1,n],[width-1,n]],length:height},
    {label:'上',points:(n:number)=>[[n,bleed],[n,0]],length:width},
    {label:'下',points:(n:number)=>[[n,height-bleed-1],[n,height-1]],length:width},
  ];
  return edges.filter(({points,length})=>[.16,.33,.5,.67,.84].filter(fraction=>{
    const [[x,y],[edgeX,edgeY]]=points(Math.round(fraction*(length-1)));
    return alpha(x,y)>=224&&alpha(edgeX,edgeY)<192;
  }).length>=3).map(edge=>edge.label);
}

function scopedIssues(project: Project, sides: SideName[], dpi: number, profile: PrintJobProfile, technical: TechnicalPrintProfile) {
  const target = { side: sides[0] ?? 'front', material: true } as const;
  const issues: PreflightIssue[] = [];
  const block = (text: string) => issues.push({ target, text, blocking: true });
  if (![project.production?.printer, project.production?.stockCode, profile.product, profile.version, profile.reference]
    .every(value => value?.trim())) block('请填写印厂、产品、材料料号、厂规版本和依据。');
  if (Math.abs(project.widthMm - profile.widthMm) > .005 || Math.abs(project.heightMm - profile.heightMm) > .005) {
    block(`成品尺寸须符合厂规 ${profile.widthMm} × ${profile.heightMm} mm。`);
  }
  if (Math.abs(project.bleedMm - profile.bleedMm) > .005) block(`出血须符合厂规 ${profile.bleedMm} mm。`);
  if (profile.safeMm * 2 >= Math.min(project.widthMm, project.heightMm)) block('厂规安全区内缩超过卡面可用范围。');
  if (profile.dpi !== dpi) block(`所选厂规要求 ${profile.dpi} PPI。`);
  if ((profile.faces === 'both' && (!sides.includes('front') || !sides.includes('back'))) ||
      (profile.faces === 'front' && (sides.length !== 1 || sides[0] !== 'front'))) {
    block(profile.faces === 'both' ? '所选厂规要求交付正反两面。' : '所选厂规要求仅交付正面。');
  }
  if (profile.colorRequirement === 'icc') block(profile.iccName.trim()
    ? `当前导出无法生成印厂所需的 ${profile.iccName.trim()} 输出条件。可改用技术打样包供确认。`
    : '请填写厂规要求的 ICC 或输出条件。');
  if (profile.route === 'specialty') {
    if (profile.requireVectorPlates) block('所选厂规要求全矢量工艺版。请先导出技术矢量包，按版核对交付报告并向印厂确认。');
    if (Object.values(profile.spotNames).some(value => value?.trim() && !validSpotName(value))) {
      block('专色名仅支持 1–64 位英文字母、数字、下划线、连字符或英文句点。');
    }
    const names = Object.values(printSpotNames(project, technical));
    if (new Set(names).size !== names.length || names.includes('CutContour')) block('专色名称不能与其它通道或刀线重名。');
  }
  return issues;
}

async function bleedCoverage(project: Project, side: SideName) {
  const scale = Math.min(.6, 640 / (Math.max(project.widthMm, project.heightMm) * 10));
  const artwork = await renderCard(project, side, { scale, bleed: true, transparentGround: true, effects: false, material: false });
  const { width, height } = artwork;
  const inset = Math.max(1, Math.round(project.bleedMm * 10 * scale));
  const data = artwork.getContext('2d')!.getImageData(0, 0, width, height).data;
  artwork.width = artwork.height = 1;
  const directions = ['上', '右', '下', '左'];
  const gaps: string[] = [];
  for (const [index, direction] of directions.entries()) {
    const horizontal = index % 2 === 0;
    // Sample one pixel inside the edge to allow the preview canvas to round up.
    const position = index === 0 || index === 3 ? 1 : (horizontal ? height : width) - 2;
    const start = Math.min(inset, Math.floor((horizontal ? width : height) / 3));
    const end = (horizontal ? width : height) - start;
    let openings = 0;
    for (let i = start; i < end; i++) {
      const x = horizontal ? i : position, y = horizontal ? position : i;
      if (data[(y * width + x) * 4 + 3] < 245) openings++;
    }
    if (openings > Math.max(1, (end - start) * .01)) gaps.push(direction);
  }
  return gaps;
}

export async function printPreflight(project: Project, sides: SideName[], technical: TechnicalPrintProfile,
  dpi: number, signal?: AbortSignal, applyFactory = true, vector = false): Promise<PreflightIssue[]> {
  if (project.singleSided && project.looseFace === 'back' && !sides.includes('back')) {
    const result = await printPreflight(projectForFaceOutput(project), sides.map(slot => physicalCardFace(project, slot)),
      technical, dpi, signal, applyFactory, vector);
    return result.map(issue => ({ ...issue, target: { ...issue.target, side: 'front' } }));
  }
  const profile = applyFactory ? projectPrintProfile(project) : undefined;
  const issues: PreflightIssue[] = profile ? scopedIssues(project, sides, dpi, profile, technical) : [];
  if (!sides.length || (project.singleSided && sides.includes('back'))) {
    issues.push({ target: { side: 'front', material: true }, text: '请选择当前工程可交稿的卡面。', blocking: true });
    return issues;
  }
  const target: PreflightTarget = { side: sides[0], material: true };
  const [width, height] = requestedDimensions(project, dpi);
  if (profile?.route !== 'raster' && (project.widthMm < 20 || project.widthMm > 300 || project.heightMm < 20 || project.heightMm > 300)) {
    issues.push({ target, text: '技术分版的成品宽高必须在 20–300 mm 之间。', blocking: true });
  }
  if (width * height > 24_000_000 || Math.max(width, height) > 16_384) {
    issues.push({ target, text: '含出血输出超过 2400 万像素或单边 16384 像素，请调整输出尺寸。', blocking: true });
    return issues;
  }
  const safeMm = profile?.safeMm ?? PRINT_SAFE_MARGIN_MM;
  const minPpi = profile?.minImagePpi || 300;
  await document.fonts.ready;
  signal?.throwIfAborted();
  const context = makeCanvas(1, 1).getContext('2d')!;
  for (const side of sides) {
    signal?.throwIfAborted();
    const face = project[side];
    const label = FACE_LABELS[side];
    const effects = face.effects.filter(effectInProduction);
    if (needsStockFinishMatch(project, side)) {
      issues.push({ target: { side, reflection: true }, blocking: Boolean(profile),
        text: `${label}底材反光待印厂确认，请匹配用料及加工方式。` });
      const related = new Set(effects.flatMap(effect => {
        const channel = plateFor(effect);
        return channel === 'white' || channel === 'primer' || channel === 'foil' || channel === 'clear' ? [PLATE_LABELS[channel]] : [];
      }));
      if (related.size) issues.push({ target: { side, reflection: true }, blocking: false,
        text: `请按${label}的新底材与反光用料复核${[...related].join('、')}工艺版。` });
    }
    const add = (text: string, blocking = false, nodeId?: string, effectId?: string) =>
      issues.push({ text, blocking, target: { side, nodeId, effectId } });
    const nodes = face.nodes.filter(node => node.visible && node.opacity > 0 && node.type !== 'empty' && intersectsPrint(node,project));
    for (const group of face.groups ?? []) {
      if (!group.autoLayout) continue;
      const overflow = autoLayoutOverflow(face,group.id);
      if (overflow) issues.push({target:{side,groupId:group.id},blocking:false,
        text:`${label}「${group.name}」自动布局溢出 ${Number((Math.max(overflow.width,overflow.height)/10).toFixed(2))} mm`});
    }
    if (!nodes.length) add(`${label}没有可见彩稿，将导出空白彩稿`);
    const imageProbes = await Promise.allSettled([...new Set(nodes.flatMap(node => {
      const source = activeImageFill(node)?.src;
      return source ? [source] : [];
    }))].map(async source => [source, await loadImage(source)] as const));
    signal?.throwIfAborted();
    const loadedImages = new Map(imageProbes.flatMap(probe => probe.status === 'fulfilled' ? [probe.value] : []));
    for (const node of nodes) {
      signal?.throwIfAborted();
      const name = `${label}「${node.name || '未命名图层'}」`;
      const fill = node.fillHidden?undefined:activeImageFill(node);
      if ((node.layoutItem?.widthMode==='fill'&&node.width<1)||(node.layoutItem?.heightMode==='fill'&&node.height<1))
        add(`${name}的自动布局子项尺寸过小，请检查最小尺寸`,false,node.id);
      if (vector) {
        const reason=vectorRasterReason(node);
        if (node.blend && node.blend!=='source-over') add(`${name}的混合模式需要栅格打样包`,true,node.id);
        else if (reason && reason!=='图片') add(`${name}的${reason}将局部栅格化`,false,node.id);
        else if (!reason&&node.type==='text'&&node.text?.trim()) {
          try {
            if (node.textStyles?.length) await outlineTextStyles(context,node);
            else await outlineTextNode(context,node);
          }
          catch(error) {
            if (node.textStyles?.length) add(`${name}的段内文字将局部栅格化（${(error as Error).message}）`,false,node.id);
            else add(`${name}${(error as Error).message}`,true,node.id);
          }
        }
      }
      if (visualEffectsActive(node)) {
        const {left,top,right,bottom}=printNodeBounds(node);
        const bleed=project.bleedMm*10;
        if(left<-bleed||top<-bleed||right>project.widthMm*10+bleed||bottom>project.heightMm*10+bleed)
          add(`${name}的效果延伸到出血范围外，输出时会裁切`,false,node.id);
      }
      if (node.type === 'image' && (node.fillMode ?? 'image') === 'image' && !fill && !node.fillHidden) {
        add(name + '缺少图片', true, node.id);
      } else if (fill) {
        const image = loadedImages.get(fill.src);
        if (image) {
          const resolution = imageResolution(node, image, minPpi);
          const ppi = Math.round(resolution.ppi);
          if (resolution.ppi < minPpi-.05) add(`${name}有效分辨率 ${ppi} PPI，最低 ${minPpi} PPI 需有效像素 ${resolution.width} × ${resolution.height} px`, !!profile?.minImagePpi, node.id);
        } else {
          add(name + '图片无法读取，请重新上传', true, node.id);
        }
      }
      if (node.type === 'text' || node.printSafe) {
        if ((node.type!=='text'||node.text?.trim()) && isOutsidePrintSafeArea(node, project, safeMm)) {
          add(`${name}超出正文安全区（内缩 ${safeMm} mm）`, false, node.id);
        }
        if (node.text?.trim()) {
          const fontIssue = node.fontRef ? await artworkFontProblem(node) :
            node.fontFamily && !fontAvailable(context, node.fontFamily) ? '所选字体未加载，当前使用回退字体' : undefined;
          if (fontIssue) add(name + fontIssue, Boolean(profile || (node.fontRef && vector)), node.id);
          else if (node.type === 'text' && (hasFill(node) || hasStroke(node))) {
            const clipped = clippedText(context, node);
            if (clipped) add(`${name}第 ${clipped.line} 行被裁切。框高 ${+(node.height/10).toFixed(2)} mm，完整显示至少需要 ${clipped.minHeight} mm`, Boolean(profile), node.id);
          }
        }
      }
      if (node.clipRegionId && !face.regions.some(region => region.id === node.clipRegionId)) {
        add(name + '的裁切蒙版找不到', true, node.id);
      }
    }
    const bleedGaps=nodes.length&&!profile?.requireBleedArtwork?await uncoveredBleed(project,side):[];
    if(bleedGaps.length) {
      const background=nodes.find(node=>node.width>=.8*project.widthMm*10&&node.height>=.8*project.heightMm*10);
      issues.push({target:{side,nodeId:background?.id,material:!background},blocking:false,
        text:`${label}${bleedGaps.join('、')}侧彩稿未覆盖到出血边缘`});
    }
    signal?.throwIfAborted();
    if (profile?.route !== 'raster' && effects.filter(plateFor).length > 64) {
      add(label + '超过 64 个独立工艺层，请调整本次印刷范围', true);
    }
    const masks: MaskPixels[] = [];
    for (const effect of effects) {
      const name = `${label}「${effect.name || '未命名工艺层'}」`;
      const channel = plateFor(effect);
      const region = face.regions.find(item => item.id === effect.regionId);
      if (!region || region.kind === 'node' && !region.bounds && !linkedMaskNode(face, region)) {
        add(name + '缺少作用区域或关联图层', true, undefined, effect.id);
        continue;
      }
      const maskText = [...regionTextNodes(face, [region.id]), ...effect.maskContent?.filter(node => node.visible && node.type === 'text') ?? []];
      for (const node of new Set(maskText)) {
        if (!node.fontRef || !node.text?.trim()) continue;
        const problem = await artworkFontProblem(node);
        if (problem) add(`${name}蒙版「${node.name}」${problem}`, Boolean(profile || vector), undefined, effect.id);
      }
      for (const node of [...effect.maskContent??[],linkedMaskNode(face,region)].filter((node):node is CardNode=>Boolean(node))) {
        const fill=node.fillHidden?undefined:activeImageFill(node);
        if (!fill||!node.visible) continue;
        try {
          const image=loadedImages.get(fill.src)??await loadImage(fill.src);
          const {ppi,width,height}=imageResolution(node,image,minPpi);
          if(ppi<minPpi-.05)add(`${name}蒙版「${node.name}」有效分辨率 ${Math.round(ppi)} PPI，需 ${width} × ${height} px`,!!profile?.minImagePpi,undefined,effect.id);
        } catch { add(`${name}的蒙版图片无法读取`,true,undefined,effect.id); }
      }
      if (effect.maskContent?.length === 0) {
        add(name + '的蒙版没有内容', !!channel, undefined, effect.id);
        continue;
      }
      if (!channel) continue;
      if (!effect.name.trim()) add(label + '有工艺层缺少名称', true, undefined, effect.id);
      if (profile?.route === 'raster') {
        add(name + '需要独立工艺版，请改用技术打样或取消纳入印刷输出', true, undefined, effect.id);
        continue;
      }
      if (technical === 'alternate' && channel === 'foil' && hasRasterMaskEdit(face, region)) {
        add(name + '含需要栅格化的蒙版编辑。技术配置 B 的箔版要求几何轮廓', true, undefined, effect.id);
      }
      if (getStockReflection(project, side) === 'none' && channel === 'white') {
        add(name + '使用白墨，请与印厂确认覆盖率及附着条件', false, undefined, effect.id);
      }
      try {
        const detailLimits = [profile?.minPlateWidthMm || 0, profile?.minKnockoutMm || 0].filter(value => value > 0);
        const mask = await analyzeMask(project, face, effect, detailLimits.length ? Math.min(...detailLimits) : 0);
        signal?.throwIfAborted();
        if (mask.right < 0) {
          const hasCoverage = await hasPrintMaskCoverage(project, face, effect, dpi);
          signal?.throwIfAborted();
          if (!hasCoverage) add(name + '在含出血范围内没有有效覆盖，请检查轮廓、图片和作用区域', true, undefined, effect.id);
          else if(detailLimits.length) add(name + '细节小于核稿预览的采样精度，请在最终分版中复核线宽和间隙', false, undefined, effect.id);
          continue;
        }
        if (profile?.route === 'specialty') {
          const pixelsPerMm = mask.scale * 10;
          const shortSideMm = (Math.min(mask.right - mask.left, mask.bottom - mask.top) + 2) / pixelsPerMm;
          if (profile.minPlateWidthMm > shortSideMm) {
            add(`${name}整层短边低于厂规线宽 ${profile.minPlateWidthMm} mm`, true, undefined, effect.id);
          }
          for (const [title, limit, ink] of [['局部线宽',profile.minPlateWidthMm,true],['反白间隙',profile.minKnockoutMm ?? 0,false]] as const) {
            if (!limit) continue;
            if (limit * pixelsPerMm < 3) {
              add(`${name}${title}限值 ${limit} mm 接近采样精度，请在该工艺版人工复核`, false, undefined, effect.id);
              continue;
            }
            const location = findThinSection(mask, limit * pixelsPerMm, ink);
            if (location) {
              const mm = (px: number) => +(px / pixelsPerMm - project.bleedMm).toFixed(2);
              add(`${name}${title}约 ${+(location.widthPx / pixelsPerMm).toFixed(2)} mm，低于厂规 ${limit} mm（X ${mm(location.x)}，Y ${mm(location.y)} mm）`, true, undefined, effect.id);
            }
          }
          const margin = Math.min(mask.left, mask.top, mask.width - 1 - mask.right, mask.height - 1 - mask.bottom) -
            project.bleedMm * pixelsPerMm;
          if (profile.plateTrimMarginMm > 0 && profile.plateTrimMarginMm > (margin + 1) / pixelsPerMm) {
            add(`${name}距离裁切边不足 ${profile.plateTrimMarginMm} mm`, true, undefined, effect.id);
          }
          if ((!profile.foilWhiteOverlap || profile.whiteFoilGapMm > 0) && (channel === 'white' || channel === 'foil')) masks.push(mask);
        }
      } catch (error) {
        signal?.throwIfAborted();
        add(name + '的蒙版无法渲染，请检查关联素材', true, undefined, effect.id);
      }
    }
    if (profile?.route === 'specialty' && masks.length > 1) {
      const whites = masks.filter(mask => plateFor(mask.effect) === 'white');
      const foils = masks.filter(mask => plateFor(mask.effect) === 'foil');
      if (whites.length && foils.length) {
        const gap = Math.max(0, profile.whiteFoilGapMm * whites[0].scale * 10 - 1);
        const distance = inkDistance(whites, gap);
        for (const foil of foils) {
          const overlap = !profile.foilWhiteOverlap && foil.pixels.some((ink, index) => ink > 0 && distance[index] === 0);
          if (overlap) add(`${label}「${foil.effect.name}」与白墨区重叠`, true, undefined, foil.effect.id);
          else if (profile.whiteFoilGapMm > 0 && foil.pixels.some((ink, index) => ink > 0 && distance[index] <= gap)) {
            add(`${label}「${foil.effect.name}」距白墨区不足 ${profile.whiteFoilGapMm} mm`, true, undefined, foil.effect.id);
          }
        }
      }
    }
    if (profile?.requireBleedArtwork && project.bleedMm > 0) {
      try {
        const gaps = await bleedCoverage(project, side);
        signal?.throwIfAborted();
        if (gaps.length) add(`${label}${gaps.join('、')}边图文未覆盖出血，请延伸背景`, true);
      } catch (error) {
        signal?.throwIfAborted();
        add(label + '无法检查出血，请检查图文素材', true);
      }
    }
  }
  const { steps, issues: orderIssues } = factoryProductionOrder(project, sides, profile);
  for (const { step, message } of orderIssues) {
    issues.push({ text: message, blocking: true,
      target: { side: step.face === 'both' ? sides[0] : step.face, effectId: step.layerId, material: !step.layerId } });
  }
  const positions = new Map(steps.map((step, index) => [step.id, index]));
  steps.forEach((step, index) => {
    if (!step.requiresStepId) return;
    const required = positions.get(step.requiresStepId);
    if (required !== undefined && required < index) return;
    const prior = steps.find(candidate => candidate.id === step.requiresStepId);
    issues.push({
      text: prior ? `「${step.name}」须排在「${prior.name}」之后` : `「${step.name}」的前置工序不在当前交稿范围`,
      blocking: true, target: { side: step.face === 'both' ? sides[0] ?? 'front' : step.face, effectId: step.layerId, material: !step.layerId },
    });
  });
  return issues;
}

export function orientPrintCanvas(canvas: HTMLCanvasElement, side: SideName, profile?: PrintJobProfile) {
  if (side !== 'back' || !profile || profile.backOrientation === 'normal') return canvas;
  const output = makeCanvas(canvas.width, canvas.height);
  const context = output.getContext('2d')!;
  if (profile.backOrientation === 'rotate180') context.setTransform(-1, 0, 0, -1, canvas.width, canvas.height);
  else context.setTransform(-1, 0, 0, 1, canvas.width, 0);
  context.drawImage(canvas, 0, 0);
  return output;
}

export async function exportFactoryRaster(project: Project, sides: SideName[], signal?: AbortSignal,
  preflight?: PreflightIssue[], includeGrain = false): Promise<Blob> {
  if (project.singleSided && project.looseFace === 'back') {
    return exportFactoryRaster(projectForFaceOutput(project), sides.map(slot => physicalCardFace(project, slot)), signal,
      preflight?.map(issue => ({ ...issue, target: { ...issue.target, side: 'back' } })), includeGrain);
  }
  const production = project.production;
  const profile = production?.printProfile;
  if (!production || profile?.route !== 'raster') throw new Error('请选择普通彩印的图片交稿方式');
  const issues = preflight ?? await printPreflight(project, sides, 'standard', profile.dpi, signal);
  if (issues.some(issue => issue.blocking)) throw new Error('请先处理印前检查的阻塞问题');
  const selected = (['front', 'back'] as const).filter(side => sides.includes(side));
  const faceFinishes = stockDelivery(project, selected);
  if (faceFinishes.some(finish => finish.status === 'pending')) throw new Error('请先确认各交稿卡面的底材反光');
  const zip = new JSZip();
  const files: Array<{ path: string; role: 'artwork' | 'report' | 'instructions'; side?: SideName; bytes: number; sha256: string }> = [];
  const addFile = async (path: string, bytes: ArrayBuffer, role: typeof files[number]['role'], side?: SideName) => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    files.push({ path, role, side, bytes: bytes.byteLength, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') });
    zip.file(path, bytes);
  };
  for (const side of selected) {
    signal?.throwIfAborted();
    const digitalEffects = project[side].effects.filter(effect => !plateFor(effect) && effectInProduction(effect))
      .map(effect => ({ ...effect, visible: true }));
    const artwork = includeGrain ? { ...project, [side]: { ...project[side], effects: digitalEffects } } : project;
    const rendered = await renderCard(artwork, side, { scale: profile.dpi / 254, bleed: true, effects: includeGrain, material: false });
    const canvas = orientPrintCanvas(rendered, side, profile);
    const data = await encodeDigitalImage(canvas, profile.rasterFormat, profile.dpi, {
      quality: .98, failureMessage: '无法生成交稿图片，请降低分辨率后重试',
    });
    const path = `${side}.${profile.rasterFormat === 'jpeg' ? 'jpg' : 'png'}`;
    await addFile(path, await data.arrayBuffer(), 'artwork', side);
    if (canvas !== rendered) canvas.width = canvas.height = 1;
    rendered.width = rendered.height = 1;
  }
  const createdAt = new Date().toISOString();
  const stockSpec = effectiveStockSpec(project);
  const projectInfo = {
    id: project.id, cardId: project.cardId ?? project.id + '_1', name: project.name, version: project.version,
    widthMm: project.widthMm, heightMm: project.heightMm, bleedMm: project.bleedMm,
    material: stockPreset(project.material)?.name ?? project.material, stockSpec, faceFinishes,
  };
  const report = {
    schemaVersion: 1,
    project: projectInfo,
    printer: production.printer, stockCode: production.stockCode, profile, createdAt,
    scope: 'RGB template upload', productionApproved: false, colorSpace: 'sRGB', sides: selected,
    flashTreatment: includeGrain ? 'artwork' : 'preview',
    trim: DIE_SHAPES[production.dieShape], pixels: requestedDimensions(project, profile.dpi),
    preflight: issues, files: [...files],
  };
  const { grammageGsm, thicknessMm, core } = stockSpec ?? {};
  const stockDetails = [
    projectInfo.material,
    grammageGsm !== undefined && `${grammageGsm} g/m²`,
    thicknessMm !== undefined && `${thicknessMm} mm`,
    core && STOCK_CORES[core],
  ].filter(Boolean);
  const instructions = [
    `${project.name} · ${selected.map(side => FACE_LABELS[side]).join('、')}`,
    `卡牌标识 ${projectInfo.cardId} · 源版本 ${project.version}`,
    `${production.printer} · ${profile.product} · 厂规 ${profile.version}`,
    `料号 ${production.stockCode} · ${profile.widthMm} × ${profile.heightMm} mm · 出血 ${profile.bleedMm} mm · ${profile.dpi} PPI`,
    `卡基 ${stockDetails.join(' · ')}`,
    ...faceFinishes.map(finish => [
      `${FACE_LABELS[finish.side]}底材反光 ${finish.label}`,
      finish.materialCode && `反光料号 ${finish.materialCode}`,
      finish.patternCode && `纹样号 ${finish.patternCode}`,
      finish.orientationDeg !== undefined && `纹向 ${finish.orientationDeg}°`,
      finish.method && STOCK_FINISH_METHODS[finish.method],
      finish.transparent !== undefined && (finish.transparent ? '反光材料透光' : '反光材料不透光'),
    ].filter(Boolean).join(' · ')),
    `厂规依据 ${profile.reference}`, '', '提交以下图片，其余文件供核对。', ...files.map(file => file.path),
  ].join('\n');
  const encode = new TextEncoder();
  await addFile('交稿说明.txt', encode.encode(instructions).buffer, 'instructions');
  await addFile('production-order.json', encode.encode(JSON.stringify({
    schemaVersion: 1, project: projectInfo, printer: production.printer,
    stockCode: production.stockCode, factoryProfile: profile, productionApproved: false,
    artwork: report.files,
  }, null, 2)).buffer, 'instructions');
  await addFile('preflight-report.json', encode.encode(JSON.stringify(report, null, 2)).buffer, 'report');
  zip.file('manifest.json', JSON.stringify({ projectId: project.id, cardId: projectInfo.cardId, version: project.version, createdAt, files }, null, 2));
  signal?.throwIfAborted();
  return zip.generateAsync({ type: 'blob' });
}
