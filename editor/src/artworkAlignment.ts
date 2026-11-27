import { pentagon, type CardNode, type CardSide } from './model';
import { hasStroke } from './layerAppearance';
import { isOpenVector, mapVectorPoints, vectorBounds } from './vectorPaths';
import { layoutParent } from './autoLayout';

export type Bounds = { left:number; top:number; right:number; bottom:number };
export function artworkBounds(node: CardNode): Bounds {
  const { width, height } = node;
  const angle = node.rotation * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const stroke = hasStroke(node) && (node.strokeOpacity ?? 1) > 0 && node.type !== 'text';
  const alignment = isOpenVector(node) ? 'center' : node.strokeAlign ?? 'center';
  const padding = stroke ? (node.strokeWidth ?? 0) * (alignment === 'outside' ? 1 : alignment === 'center' ? .5 : 0) : 0;

  function world(x:number,y:number) {
    const localX=node.flipX?width-x:x, localY=node.flipY?height-y:y;
    return {x:node.x+localX*cos-localY*sin, y:node.y+localX*sin+localY*cos};
  }
  function withStroke(left:number,top:number,right:number,bottom:number):Bounds {
    return {left:left-padding,top:top-padding,right:right+padding,bottom:bottom+padding};
  }
  if(node.type==='ellipse') {
    const center=world(width/2,height/2);
    const rx=Math.hypot(width*cos,height*sin)/2, ry=Math.hypot(width*sin,height*cos)/2;
    return withStroke(center.x-rx,center.y-ry,center.x+rx,center.y+ry);
  }
  if(node.type==='path'&&node.pathPoints?.length) {
    const contours=[node.pathPoints,...(node.contours??[])];
    const boxes=contours.map(points=>vectorBounds(mapVectorPoints(points,p=>world(p.x*width,p.y*height)),!!node.pathClosed,true));
    return withStroke(Math.min(...boxes.map(b=>b.x)),Math.min(...boxes.map(b=>b.y)),
      Math.max(...boxes.map(b=>b.x+b.width)),Math.max(...boxes.map(b=>b.y+b.height)));
  }
  let points = [[0,0],[width,0],[0,height],[width,height]];
  if(node.type==='polygon') {
    const polygon=node.polygon??pentagon(1,1);
    points=polygon.flatMap((v,i)=>i%2?[]:[[v*width,polygon[i+1]*height]]);
  } else if(node.type==='line'&&node.pathPoints?.length) {
    points=node.pathPoints.slice(0,2).map(p=>[p.x*width,p.y*height]);
  }
  const transformed=points.map(([x,y])=>world(x,y));
  return withStroke(Math.min(...transformed.map(p=>p.x)),Math.min(...transformed.map(p=>p.y)),
    Math.max(...transformed.map(p=>p.x)),Math.max(...transformed.map(p=>p.y)));
}

type Axis = 'x' | 'y';
export type AlignmentMode = 'start' | 'center' | 'end' | 'distribute';
function edges(bounds:Bounds,axis:Axis) {
  return axis==='x'?[bounds.left,bounds.right]:[bounds.top,bounds.bottom];
}

export function alignArtwork(side:CardSide,ids:readonly string[],axis:Axis,mode:AlignmentMode):CardSide {
  const targets=new Set(ids);
  const chosen=side.nodes.filter(n=>targets.has(n.id));
  if(chosen.length < (mode==='distribute'?3:2) || chosen.some(n=>n.locked || layoutParent(side,n.id)))return side;
  const bounds=chosen.map(n=>({n,edges:edges(artworkBounds(n),axis)}))
    .sort((a,b)=>a.edges[0]-b.edges[0] || a.edges[1]-b.edges[1]);
  const low=Math.min(...bounds.map(b=>b.edges[0])),high=Math.max(...bounds.map(b=>b.edges[1]));
  const offsets=new Map<string,number>();
  if(mode==='distribute') {
    const span=bounds.at(-1)!.edges[1]-bounds[0].edges[0];
    const gap=(span-bounds.reduce((sum,b)=>sum+b.edges[1]-b.edges[0],0))/(bounds.length-1);
    let cursor=bounds[0].edges[0];
    for(const b of bounds) {
      offsets.set(b.n.id,cursor-b.edges[0]);
      cursor+=b.edges[1]-b.edges[0]+gap;
    }
  } else {
    const fraction=mode==='start'?0:mode==='center'?.5:1;
    for(const b of bounds) offsets.set(b.n.id,low+(high-low)*fraction-b.edges[0]-(b.edges[1]-b.edges[0])*fraction);
  }
  if([...offsets.values()].every(value=>Math.abs(value)<1e-8))return side;
  return {...side,nodes:side.nodes.map(n=>offsets.has(n.id)?{...n,[axis]:n[axis]+offsets.get(n.id)!}:n)};
}

export function snapArtwork(box:Bounds,others:Bounds[],width:number,height:number,tolerance:number) {
  function nearest(axis:Axis) {
    const [a,b]=edges(box,axis),middle=(a+b)/2;
    const length=axis==='x'?width:height;
    let delta=Infinity,line:number|undefined, preceding=-Infinity,following=Infinity;
    function propose(change:number,at:number) {
      if(Math.abs(change)<Math.abs(delta)&&Math.abs(change)<=tolerance){delta=change;line=at}
    }
    for(const guide of [0,length/2,length]) {
      for(const edge of [a,middle,b]) propose(guide-edge,guide);
    }
    for(const neighbor of others) {
      const [start,end]=edges(neighbor,axis);
      for(const guide of [start,(start+end)/2,end])
        for(const edge of [a,middle,b]) propose(guide-edge,guide);
      const perpendicular=axis==='x'?'y':'x';
      const [ca,cb]=edges(box,perpendicular),[na,nb]=edges(neighbor,perpendicular);
      if(na>cb||nb<ca)continue;
      if(end<=a)preceding=Math.max(preceding,end);
      if(start>=b)following=Math.min(following,start);
    }
    if(Number.isFinite(preceding)&&Number.isFinite(following)){
      const ideal=(preceding+following)/2;
      propose(ideal-middle,ideal);
    }
    return {delta:line===undefined?0:delta,line};
  }
  return {x:nearest('x'),y:nearest('y')};
}
