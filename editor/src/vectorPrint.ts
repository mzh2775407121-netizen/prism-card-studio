import { activeImageFill, fillType, gradientPoints, hasFill, hasStroke } from './layerAppearance';
import { pentagon, type CardNode, type Project, type SideName, type Effect } from './model';
import { renderCard, makeCanvas } from './render';
import { ellipsePath, isOpenVector, rectanglePath, traceVectorPath } from './vectorPaths';
import { outlineTextNode, outlineTextStyles } from './fontOutlines';
import { visualEffectPadding, visualEffectsActive } from './visualEffects';

type Point = [number,number];
type RGB = [number,number,number];
type Command = ['M'|'L',number,number] | ['C',number,number,number,number,number,number] | ['Z'];
type Fill = { kind:'solid'; color:RGB; opacity:number } | {
  kind:'linear'|'radial'; points:[Point,Point]; radialAxis?:Point; stops:[number,RGB][]; opacity:number;
};
type VectorPart = { type:'path'; id:string; path:Command[]; matrix:number[]; fill?:Fill; fillRule?:CanvasFillRule;
  stroke?:{color:RGB;width:number;opacity:number;style:'solid'|'dashed'|'dotted';cap?:CanvasLineCap;join?:CanvasLineJoin;miter?:number}; textBox?:Point };
type BitmapPart = { type:'bitmap'; id:string; image:string; box:[number,number,number,number] };

const colors = new Map<string,[RGB,number]>();
function color(context: CanvasRenderingContext2D, css: string): [RGB,number] {
  const cached = colors.get(css);
  if(cached) return cached;
  context.clearRect(0,0,1,1);context.fillStyle='#ffffff';context.fillStyle=css;context.fillRect(0,0,1,1);
  const [r,g,b,a] = context.getImageData(0,0,1,1).data;
  const result:[RGB,number]=[[r/255,g/255,b/255],a/255];
  colors.set(css,result);return result;
}

export function vectorRasterReason(node: CardNode) {
  if (visualEffectsActive(node)) return '图层效果';
  if (node.clipRegionId) return '裁切蒙版';
  if (!node.fillHidden && activeImageFill(node)) return '图片';
  if (hasStroke(node) && !isOpenVector(node) && node.type!=='text' && node.strokeAlign && node.strokeAlign!=='center') return '内侧或外侧描边';
  if (node.opacity<1 && hasFill(node) && hasStroke(node)) return '整体透明度';
  if (hasFill(node) && ['linear','radial'].includes(fillType(node))) {
    const context = makeCanvas(1,1).getContext('2d',{willReadFrequently:true})!;
    const stops = node.gradient?.stops ?? [];
    if (stops.some(([position,css],i)=>color(context,css)[1]!==1||(i>0&&position<=stops[i-1][0]))) return '透明色标或同位置硬边';
  }
  return undefined;
}

export function printNodeBounds(node:CardNode) {
  const angle=node.rotation*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  const effect=visualEffectPadding(node);
  const stroke=hasStroke(node)?node.strokeWidth??0:0;
  const left=-effect.left-stroke,top=-effect.top-stroke;
  const right=node.width+effect.right+stroke,bottom=node.height+effect.bottom+stroke;
  const points=[[left,top],[right,top],[left,bottom],[right,bottom]].map(([x,y])=>[node.x+x*cos-y*sin,node.y+x*sin+y*cos]);
  return {left:Math.min(...points.map(([x])=>x)),right:Math.max(...points.map(([x])=>x)),
    top:Math.min(...points.map(([,y])=>y)),bottom:Math.max(...points.map(([,y])=>y))};
}

export function intersectsPrint(node:CardNode,project:Project) {
  const bleed=project.bleedMm*10;
  const {left,right,top,bottom}=printNodeBounds(node);
  return right>=-bleed&&left<=project.widthMm*10+bleed&&bottom>=-bleed&&top<=project.heightMm*10+bleed;
}

function shapeCommands(node:CardNode):Command[] {
  const {width,height}=node;
  const path:Command[]=[];
  const target={moveTo:(x:number,y:number)=>void path.push(['M',x,y]),lineTo:(x:number,y:number)=>void path.push(['L',x,y]),
    bezierCurveTo:(...points:[number,number,number,number,number,number])=>void path.push(['C',...points]),closePath:()=>void path.push(['Z'])};
  if(node.type==='path'||node.type==='line') {
    traceVectorPath(target,node.pathPoints??[],width,height,node.type==='path'&&node.pathClosed);
    for(const contour of node.contours??[]) traceVectorPath(target,contour,width,height,true);
  }
  else if(node.type==='ellipse') traceVectorPath(target,ellipsePath(width/2,height/2,width/2,height/2),1,1,true);
  else if(node.type==='polygon') {
    const points=node.polygon?.map((value,i)=>value*(i%2?height:width))??pentagon(width,height);
    for(let i=0;i<points.length;i+=2) (i?target.lineTo:target.moveTo)(points[i],points[i+1]);
    target.closePath();
  } else traceVectorPath(target,rectanglePath(0,0,width,height,node.cornerRadius??0),1,1,true);
  return path;
}

function vectorMatrix(node:CardNode) {
  const angle=node.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const sx=node.flipX?-1:1,sy=node.flipY?-1:1,dx=node.flipX?node.width:0,dy=node.flipY?node.height:0;
  return [c*sx,s*sx,-s*sy,c*sy,node.x+c*dx-s*dy,node.y+s*dx+c*dy];
}

export function vectorPlateContours(project:Project,face:SideName,entry:Effect) {
  const side=project[face], region=side.regions.find(r=>r.id===entry.regionId);
  if(!region || region.inverted || region.strokes.length)return;
  let shapes:CardNode[];
  if(region.kind==='full' && entry.maskContent) {
    shapes=entry.maskContent.filter(n=>n.visible);
  } else if(region.kind==='node' && entry.maskContent===undefined) {
    const linked=side.nodes.find(n=>n.id===region.nodeId);
    const source=region.binding==='fixed'?region.snapshot??linked:linked;
    if(!source || !region.maskSource && !source.visible)return;
    shapes=[region.binding==='fixed'&&region.bounds?{...source,...region.bounds}:source];
  } else return;
  if(!shapes.length)return;
  const context=makeCanvas(1,1).getContext('2d',{willReadFrequently:true})!;
  const paths=[];
  for(const shape of shapes) {
    if(!['rect','ellipse','path','polygon'].includes(shape.type) || shape.clipRegionId || isOpenVector(shape) ||
       hasStroke(shape) || !hasFill(shape) || fillType(shape)!=='solid' || (shape.fillOpacity??1)!==1 ||
       color(context,shape.fill)[1]!==1 || shape.maskInk==='dark')return;
    paths.push({id:shape.id,type:'path' as const,path:shapeCommands(shape),matrix:vectorMatrix(shape),fillRule:shape.fillRule});
  }
  return paths;
}

async function vectorParts(context:CanvasRenderingContext2D,node:CardNode):Promise<VectorPart[]> {
  let fill:Fill|undefined;
  const mode=fillType(node);
  if (hasFill(node)) {
    const opacity=(node.fillOpacity??1)*node.opacity;
    if ((mode==='linear'||mode==='radial') && node.gradient) {
      const points=gradientPoints(node.gradient,node.width,node.height);
      const stops=node.gradient.stops.map(([position,value]):[number,RGB]=>[position,color(context,value)[0]]);
      const axis=node.gradient.radialAxis;
      if (stops.length>1) fill={kind:mode,points,stops,opacity,radialAxis:axis?[axis[0]*node.width,axis[1]*node.height]:undefined};
    } else {
      const [rgb,alpha]=color(context,node.fill);
      fill={kind:'solid',color:rgb,opacity:opacity*alpha};
    }
  }
  let stroke:VectorPart['stroke'];
  if (hasStroke(node)) {
    const [rgb,alpha]=color(context,node.stroke!);
    stroke={color:rgb,width:node.strokeWidth! * (node.type==='text' && node.textStyles?.length ? 2 : 1),
      opacity:(node.strokeOpacity??1)*node.opacity*alpha,
      style:node.type==='text'?'solid':node.strokeStyle??'solid',cap:node.strokeLineCap,join:node.strokeLineJoin,miter:node.strokeMiterLimit};
  }
  if(!fill&&!stroke)return [];
  const outlines=node.type==='text'&&node.textStyles?.length ? await outlineTextStyles(context,node)
    : [{path:node.type==='text'?await outlineTextNode(context,node):shapeCommands(node),color:undefined}];
  return outlines.filter(outline=>outline.path.length).map(outline=>({type:'path',id:node.id,path:outline.path,
    fillRule:node.fillRule,matrix:vectorMatrix(node),
    fill:fill&&outline.color?{kind:'solid',color:color(context,outline.color)[0],opacity:(node.fillOpacity??1)*node.opacity}:fill,stroke,
    textBox:node.type==='text'?[node.width,node.height]:undefined}));
}

function alphaBounds(canvas:HTMLCanvasElement) {
  const {width,height}=canvas;
  const context=canvas.getContext('2d')!;
  let left=width,right=-1,top=height,bottom=-1;
  for (let y=0;y<height;y+=64) {
    const {data}=context.getImageData(0,y,width,Math.min(64,height-y));
    for(let index=3;index<data.length;index+=4) if(data[index]) {
      const pixel=(index-3)/4,col=pixel%width,row=y+Math.floor(pixel/width);
      left=Math.min(left,col);right=Math.max(right,col);top=Math.min(top,row);bottom=Math.max(bottom,row);
    }
  }
  return right<left?undefined:{left,top,width:right-left+1,height:bottom-top+1};
}

export async function buildVectorArtwork(project:Project,side:SideName,dpi:number,signal:AbortSignal) {
  const scale=dpi/254,bleed=project.bleedMm*10;
  const context=makeCanvas(1,1).getContext('2d',{willReadFrequently:true})!;
  const parts:(VectorPart|BitmapPart)[]=[];
  const {nodes}=project[side];
  const paper=nodes.find(n=>n.type==='rect'&&n.visible&&n.opacity===1&&n.rotation===0&&n.x<=0&&n.y<=0&&
    n.x+n.width>=project.widthMm*10&&n.y+n.height>=project.heightMm*10&&hasFill(n)&&fillType(n)==='solid'&&
    /^(#[a-f\d]{3}|#[a-f\d]{6})$/i.test(n.fill)&&(n.fillOpacity??1)===1&&!n.clipRegionId);
  for(const node of nodes) {
    signal.throwIfAborted();
    if(!node.visible||node.opacity<=0||node.type==='empty'||!intersectsPrint(node,project))continue;
    if(node.blend&&node.blend!=='source-over')throw Error(`「${node.name}」的混合模式依赖背景，请改用栅格打样包`);
    if(!vectorRasterReason(node)) {
      try { parts.push(...await vectorParts(context,node)); continue; }
      catch(error) { if(node.type!=='text'||!node.textStyles?.length)throw error; }
    }
    const canvas=await renderCard(project,side,{scale,bleed:true,material:false,effects:false,
      transparentGround:true,artworkIds:new Set([node.id])});
    const box=alphaBounds(canvas);
    if(box) {
      const cropped=makeCanvas(box.width,box.height);
      cropped.getContext('2d')!.drawImage(canvas,box.left,box.top,box.width,box.height,0,0,box.width,box.height);
      parts.push({type:'bitmap',id:node.id,image:cropped.toDataURL('image/png'),
        box:[box.left/scale-bleed,box.top/scale-bleed,box.width/scale,box.height/scale]});
      cropped.width=cropped.height=1;
    }
    canvas.width=canvas.height=1;
  }
  return {paper:paper?color(context,paper.fill)[0]:undefined,parts};
}
