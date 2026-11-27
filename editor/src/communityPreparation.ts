import { listCardAssets, readCardAsset, saveCardAsset, type CardAssetVersion } from './cardAssets';
import { prepareCardAsset } from './cardAssetSnapshot';
import { clippedText, imageCrop, loadImage, makeCanvas } from './render';
import { outlineFontReference } from './artworkFonts';
import { outlineTextNode } from './fontOutlines';
import { patternTileWidth } from './layerAppearance';
import { readImage } from './io';
import { projectForCard, type CardNode, type ImageCrop, type ImageFill, type PathPoint, type ProjectCard } from './model';
import { MAX_PATH_POINTS, splitPathSegment } from './vectorPaths';
import { workspaceSignal } from './projects';

function artworkNodes(card: ProjectCard) {
  return (card.singleSided ? [card.front] : [card.front, card.back]).flatMap((side, index) => {
    const face = card.looseFace === 'back' || index ? '背面' : '正面';
    return [
      ...side.nodes.map((node, i) => ({ node, label: node.name, key: 'node-' + i })),
      ...side.regions.flatMap((region, i) => region.snapshot
        ? [{ node: region.snapshot, label: region.name + ' · ' + region.snapshot.name, key: 'region-' + i }] : []),
      ...side.effects.flatMap((effect, i) => (effect.maskContent ?? []).map((node, j) =>
        ({ node, label: effect.name + ' · ' + node.name, key: 'effect-' + i + '-' + j }))),
    ].map(item => ({ ...item, label: face + ' · ' + item.label, key: index + '-' + item.key }));
  });
}

export function publicCardImages(card: ProjectCard) {
  return artworkNodes(card).flatMap(({ node, label, key }) => [
    ...(node.type === 'image' && node.src ? [{ key: key + '-image', label, target: node as { src?: string } }] : []),
    ...(node.imageFill?.src ? [{ key: key + '-fill', label: label + ' · 图片填充', target: node.imageFill }] : []),
  ]);
}

export function restrictedPublicFont(node: CardNode) {
  const ref = outlineFontReference(node);
  return node.type === 'text' && (ref ? ref.kind !== 'builtin' : !!node.fontFamily);
}

export async function publicReplacementImage(file: File) {
  const image = await readImage(file);
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(image.src)) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  return image.src;
}

async function outlinePublicText(node: CardNode) {
  const context = makeCanvas(1, 1).getContext('2d')!;
  if (node.textStyles?.length) throw new Error('暂无法为局部文字样式转曲');
  // Defer to the established font permission and glyph consistency checks.
  const commands = await outlineTextNode(context, node);
  if (!commands.length || clippedText(context, node)) throw new Error('文字为空或超出文本框');
  const contours: PathPoint[][] = [];
  let contour: PathPoint[] = [];
  const coordinate = (x: number, y: number) => {
    if (x < 0 || x > node.width || y < 0 || y > node.height) throw new Error('文字轮廓超出文本框');
    return { x: x / node.width, y: y / node.height };
  };
  for (const command of commands) {
    if (command[0] === 'M') {
      contour = [coordinate(command[1], command[2])];
    } else if (command[0] === 'L') {
      contour.push(coordinate(command[1], command[2]));
    } else if (command[0] === 'C') {
      const previous = contour.at(-1)!;
      previous.out = coordinate(command[1], command[2]);
      contour.push({ ...coordinate(command[5], command[6]), in: coordinate(command[3], command[4]) });
    } else {
      const first = contour[0], last = contour.at(-1);
      if (first && last && contour.length > 1 && first.x === last.x && first.y === last.y) {
        if (last.in) first.in = last.in;
        contour.pop();
      }
      if (contour.length === 2) contour = splitPathSegment(contour, 0);
      if (contour.length >= 3) contours.push(contour);
    }
  }
  if (!contours.length || contours.flat().length > MAX_PATH_POINTS) throw new Error('轮廓数量超过单图层限制');
  const [pathPoints, ...holes] = contours;
  return {
    ...node, type: 'path' as const, text: undefined, textStyles: undefined, fontRef: undefined, fontFamily: undefined, fontStyle: undefined,
    pathClosed: true, pathPoints, contours: holes.length ? holes : undefined, fillRule: 'nonzero' as const,
    strokeWidth: node.strokeWidth === undefined ? undefined : node.strokeWidth * 2,
    strokeAlign: 'center' as const, strokeLineJoin: 'round' as const,
    layoutItem: { ...node.layoutItem, heightMode: node.layoutItem?.heightMode === 'fill' ? 'fill' as const : 'fixed' as const },
  };
}

async function pixelsInFrame(src:string, node:CardNode, crop?:ImageCrop) {
  const image=await loadImage(src);
  const frame=imageCrop(image,{...node,crop});
  if (frame.x===0 && frame.y===0 && frame.width===image.naturalWidth && frame.height===image.naturalHeight) return src;
  const canvas=makeCanvas(frame.width,frame.height);
  const ctx=canvas.getContext('2d');
  if (!ctx) throw new Error('无法生成图框内的图片');
  ctx.drawImage(image,frame.x,frame.y,frame.width,frame.height,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/png');
}

async function trimTiledPattern(node: CardNode, fill: ImageFill, tileWidth: number) {
  const image = await loadImage(fill.src);
  const scale = tileWidth / image.naturalWidth;
  // Each tile starts at the layer's origin. Only oversized tiles have unused source pixels.
  const width = Math.min(image.naturalWidth, Math.ceil(node.width / scale));
  const height = Math.min(image.naturalHeight, Math.ceil(node.height / scale));
  if (width === image.naturalWidth && height === image.naturalHeight) return;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法生成图框内的图案');
  ctx.drawImage(image, 0, 0, width, height, 0, 0, width, height);
  fill.src = canvas.toDataURL('image/png');
  fill.tileScale = tileWidth / node.width * (width / image.naturalWidth);
  delete fill.crop;
}

export async function preparePublicVersion(asset: CardAssetVersion, trim: boolean,
  fonts: 'keep' | 'replace' | 'outline', replacements: Record<string, string>) {
  const guard=workspaceSignal();
  const card=structuredClone(asset.card);
  const existing=(await listCardAssets()).find(i=>i.id===asset.assetId);
  guard.throwIfAborted();
  if (!existing || existing.version!==asset.version) throw new Error('请从我的资产打开最新版本后处理素材');
  for (const { key, target } of publicCardImages(card)) {
    if (replacements[key]) {
      target.src = replacements[key];
      if ('presetId' in target) delete target.presetId;
    }
  }
  for (const { node: n, label } of artworkNodes(card)) {
    guard.throwIfAborted();
    if (restrictedPublicFont(n)) {
      if (fonts === 'replace') {
        n.fontRef={kind:'builtin',id:'noto-sans-sc',weight:n.fontStyle?.includes('bold')?700:400};
        n.fontFamily='思源黑体';
      } else if (fonts === 'outline') {
        try {
          Object.assign(n, await outlinePublicText(n));
        } catch (error) {
          throw new Error('「' + label + '」无法转曲，请替换字体。' + (error instanceof Error ? error.message : ''));
        }
      }
    }
    if (!trim) continue;
    if (n.type==='image' && n.src) {
      n.src=await pixelsInFrame(n.src,n,n.crop);
      n.crop={x:0,y:0,width:1,height:1,space:'source'};
    }
    if (n.imageFill && n.imageFill.fit!=='contain') {
      const tileWidth = patternTileWidth(n, n.imageFill);
      if (tileWidth !== undefined) await trimTiledPattern(n, n.imageFill, tileWidth);
      else {
        n.imageFill.src=await pixelsInFrame(n.imageFill.src,n,n.imageFill.crop);
        n.imageFill.crop={x:0,y:0,width:1,height:1,space:'source'};
      }
    }
  }
  guard.throwIfAborted();
  const project=projectForCard({id:existing.projectId,name:asset.name,version:asset.version,updatedAt:0},card);
  const snapshot=await prepareCardAsset(project);
  guard.throwIfAborted();
  const row=await saveCardAsset(asset.assetId,asset.version,existing.projectId,snapshot,asset.name);
  guard.throwIfAborted();
  return readCardAsset(row.id,row.version);
}
