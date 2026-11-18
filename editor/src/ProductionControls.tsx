import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Square, Type } from 'lucide-react';
import { STOCK_REFLECTIONS, uid, type CardNode, type CardSide, type Effect, type Project, type Region, type StockReflection } from './model';
import { LAYER_KINDS, type LayerKind } from './layers';
import InspectorMenu from './InspectorMenu';
import { readImage } from './io';
import { makeCanvas, renderEffectMask } from './render';
import './production-controls.css';

export const STOCKS = [
  {id:'matte',name:'哑光白卡',note:'白色不透底',color:'#e9e4da'},
  {id:'black',name:'黑芯卡纸',note:'遮光夹层',color:'#535a56'},
  {id:'silver',name:'金属银卡',note:'银色金属表面',color:'#b8bec2'},
  {id:'holo',name:'镭射卡基',note:'镀铝基材与镭射纹样',color:'#bfd1cd'},
];

export function defaultStockReflection(material: string): StockReflection {
  return material === 'silver' ? 'mirror' : material === 'holo' ? 'rainbow' : 'none';
}

export function StockPicker({material,reflection,onMaterial,onReflection}:{
  material:string;reflection:StockReflection;onMaterial:(material:string)=>void;onReflection:(value:StockReflection)=>void;
}) {
  const choices: StockReflection[] = ['matte','black'].includes(material) ? ['none'] : ['none','mirror','rainbow','radial'];
  return <div className="stock-picker">
    <label className="field">卡基材料
      <span className="stock-select"><select value={material} onChange={event=>onMaterial(event.target.value)}>
        {STOCKS.map(stock=><option key={stock.id} value={stock.id}>{stock.name} · {stock.note}</option>)}
      </select></span>
    </label>
    <label className="field">底材反光
      <span className="stock-select"><select value={reflection} onChange={event=>onReflection(event.target.value as StockReflection)}>
        {choices.map(choice=><option value={choice} key={choice}>{STOCK_REFLECTIONS[choice]}</option>)}
      </select></span>
    </label>
  </div>;
}

export function LayerTypeField({ kind, disabled, onChange }: {
  kind: LayerKind; disabled?: boolean; onChange: (kind: LayerKind) => void;
}) {
  return <div className="field">
    图层属性
    <InspectorMenu ariaLabel="图层属性" value={kind} disabled={disabled}
      options={[{ value: 'artwork', label: '彩稿' }, ...LAYER_KINDS.filter(([value]) => value !== 'artwork')
        .map(([value, label]) => ({ value, label }))]}
      onChange={value => onChange(value as LayerKind)}/>
  </div>;
}

const maskShapes = [
  ['paint','画笔'], ['rect','矩形'], ['ellipse','椭圆'], ['polygon','多边形'],
] as const;
export type MaskShape = typeof maskShapes[number][0];
export function LayerMaskField({ name, regions, value, artwork, noMask, disabled, sources, onChange, compact }: {
  name: string; regions: Region[]; value?: string; artwork?: boolean; noMask?: boolean; disabled?: boolean; compact?: boolean;
  sources?: CardNode[]; onChange: (value: string) => void;
}) {
  const options = [
    ...(artwork ? [{ value: '', label: '无蒙版' }] : []),
    ...regions.map(region => ({ value: region.id, label: region.name })),
    ...(sources || []).map(node => ({ value: 'node:' + node.id, label: node.name + ' · 轮廓', group: '图层轮廓' })),
    ...maskShapes.map(([shape, label]) => ({ value: 'draw:' + shape, label: '绘制' + label + '蒙版' })),
    ...(regions.filter(region => region.kind !== 'full').length >= 2 ? [{ value: 'union:', label: '组合已有蒙版…' }] : []),
  ];
  return <div className="field">
    {!compact && name}
    <InspectorMenu ariaLabel={name} menuTitle={name} menuWidth={230}
      value={noMask ? '' : value ?? ''} placeholder="选择或绘制蒙版" options={options}
      disabled={disabled} onChange={onChange}/>
  </div>;
}
const shapeFor=(project:Project,side:CardSide,effect:Effect,type:CardNode['type']):CardNode=>{
  const region=side.regions.find(item=>item.id===effect.regionId);
  const area=region?.bounds || {x:0,y:0,width:project.widthMm*10,height:project.heightMm*10};
  const width=area.width*(type==='image'?1:.72), height=area.height*(type==='text'?.3:1);
  return {type,id:uid(),name:type==='text'?'蒙版文字':type==='image'?'蒙版图片':'蒙版形状',
    x:area.x+(area.width-width)/2,y:area.y+(area.height-height)/2,width,height,rotation:0,visible:true,locked:false,fill:'#ffffff',opacity:1,
    ...(type==='text'?{text:'白墨',fontSize:Math.max(8,Math.min(55,height*.42)),fontStyle:'bold',align:'center'}:{})};
};

export function imageMaskNode(project: Project, side: CardSide, effect: Effect, image: {src:string;width:number;height:number}, name: string): CardNode {
  const node = shapeFor(project,side,effect,'image');
  const scale = Math.min(node.width/image.width, node.height/image.height);
  const width = image.width*scale, height = image.height*scale;
  return { ...node, src:image.src, name:name.slice(0,100), x:node.x+(node.width-width)/2, y:node.y+(node.height-height)/2,
    width, height, maskInk:image.src.startsWith('data:image/jpeg;')?'dark':'alpha' };
}

export function MaskContentEditor({project,side,effect,onApply,onClose}:{
  project:Project;side:CardSide;effect:Effect;onApply:(nodes:CardNode[])=>void;onClose:()=>void;
}){
  const [nodes,setNodes]=useState<CardNode[]>(effect.maskContent||[]);
  const [selected,setSelected]=useState(nodes.at(-1)?.id);
  const input=useRef<HTMLInputElement>(null);
  const canvas=useRef<HTMLCanvasElement>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const current=nodes.find(node=>node.id===selected);
  const update=(patch:Partial<CardNode>)=>setNodes(list=>list.map(node=>node.id===selected?{...node,...patch}:node));
  const add=(node:CardNode)=>{setNodes(list=>[...list,node]);setSelected(node.id)};
  useEffect(()=>{
    let active=true;
    renderEffectMask(project,side,{...effect,maskContent:nodes},.55).then(mask=>{
      const target=canvas.current;
      if(!active||!target)return;
      target.width=mask.width;target.height=mask.height;
      const ink=makeCanvas(mask.width,mask.height),context=ink.getContext('2d')!;
      context.drawImage(mask,0,0);context.globalCompositeOperation='source-in';
      context.fillStyle='#303030';context.fillRect(0,0,ink.width,ink.height);
      target.getContext('2d')?.drawImage(ink,0,0);
    }).catch(()=>{if(active)setError('无法预览蒙版，请检查上传的图片。')});
    return ()=>{active=false};
  },[project,side,effect,nodes]);
  return <><div className="new-content mask-content">
    <div className="mask-card"><canvas ref={canvas} aria-label="深色为工艺覆盖区域"/></div>
    <div className="mask-tools"><div className="mask-actions">
      <button className="button" onClick={()=>add(shapeFor(project,side,effect,'text'))}><Type size={15}/>文字</button>
      <button className="button" onClick={()=>add(shapeFor(project,side,effect,'rect'))}><Square size={15}/>图形</button>
      <button className="button" disabled={loading} onClick={()=>input.current?.click()}><ImagePlus size={15}/>图片</button>
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={async event=>{
        const file=event.target.files?.[0];event.target.value='';if(!file)return;
        setError('');setLoading(true);
        try{const image=await readImage(file);add(imageMaskNode(project,side,effect,image,file.name));}
        catch(issue){setError((issue as Error).message);}
        finally{setLoading(false);}
      }}/>
    </div>
    {error&&<p role="alert" className="library-error">{error}</p>}
    {nodes.length>0&&<label className="field">蒙版内容<select value={selected||''} onChange={event=>setSelected(event.target.value)}>
      {nodes.map((node,index)=><option value={node.id} key={node.id}>{node.name} {index+1}</option>)}
    </select></label>}
    {current?.type==='text'&&<><label className="field">蒙版文字<input value={current.text} onChange={event=>update({text:event.target.value})}/></label>
     <label className="field">字号<input type="number" min="4" value={current.fontSize} onChange={event=>update({fontSize:Math.max(4,+event.target.value)})}/></label></>}
    {current?.type==='image'&&<label className="field">从图片提取<select value={current.maskInk||'alpha'} onChange={event=>update({maskInk:event.target.value as CardNode['maskInk']})}><option value="alpha">不透明轮廓</option><option value="dark">黑色与深色区域</option></select></label>}
    {current&&<><div className="field-grid">{(['x','y','width','height'] as const).map(key=><label className="field" key={key}>{({x:'X',y:'Y',width:'宽',height:'高'})[key]} mm
      <input type="number" step=".1" value={+((current[key])/10).toFixed(1)} onChange={event=>update({[key]:key==='width'||key==='height'?Math.max(1,+event.target.value*10):+event.target.value*10})}/>
    </label>)}</div><button className="button" onClick={()=>{const next=nodes.filter(node=>node.id!==selected);setNodes(next);setSelected(next.at(-1)?.id);}}>移除所选内容</button></>}
    <p className="micro-copy">深色会出现在当前工艺版，超出作用区域的内容会被裁掉。</p></div>
  </div><div className="modal-footer"><button className="button" onClick={onClose}>取消</button>
    <button className="button primary" disabled={loading||!nodes.length} onClick={()=>onApply(nodes)}>应用蒙版内容</button></div></>;
}
