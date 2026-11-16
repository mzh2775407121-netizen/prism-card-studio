import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Eye, EyeOff, ImagePlus, Layers3, Plus, Square, Type } from 'lucide-react';
import { PROCESS_LABELS, STOCK_REFLECTIONS, getStockReflection, getFlashStyle, FLASH_STYLES, processKind, uid, type CardNode, type CardSide, type Effect, type ProcessKind, type Project, type Region, type StockReflection } from './model';
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
    <label className="field">卡基材料<select value={material} onChange={event=>onMaterial(event.target.value)}>
      {STOCKS.map(stock=><option key={stock.id} value={stock.id}>{stock.name} · {stock.note}</option>)}
    </select></label>
    <label className="field">底材反光<select value={reflection} onChange={event=>onReflection(event.target.value as StockReflection)}>
      {choices.map(choice=><option value={choice} key={choice}>{STOCK_REFLECTIONS[choice]}</option>)}
    </select></label>
  </div>;
}

const layerOptions = [
  ['artwork','彩稿','图片、文字与形状，进入 CMYK 彩稿。'],
  ['reflection','局部闪光','独立的纹样层，可指定区域与方向。'],
  ['white','白墨','单独的白墨版，覆盖指定区域。'],
  ['foil','箔版','单独的箔版，指定箔材与覆盖区域。'],
  ['varnish','光油','单独的光油版，指定上光区域。'],
] as const;
export type LayerDraft = {
  kind: 'artwork' | ProcessKind;
  area: string;
  content: 'text' | 'rect' | 'ellipse' | 'image';
  contentMask: boolean;
  name: string;
};

export function CreateLayer({side, source, initial, onCreate, onClose}:{
  side:CardSide;source?:CardNode;initial:LayerDraft['kind'];onCreate:(draft:LayerDraft)=>void;onClose:()=>void;
}){
  const [kind,setKind]=useState(initial);
  const [area,setArea]=useState(source&&initial!=='artwork'?':contour':'');
  const [content,setContent]=useState<LayerDraft['content']>('text');
  const [contentMask,setContentMask]=useState(false);
  const [name,setName]=useState('');
  return <>
    <div className="new-content">
      <fieldset className="process-options"><legend>图层属性</legend>
        {layerOptions.map(([value,label,description])=><label key={value}><input type="radio" name="layer-kind" checked={kind===value} onChange={()=>{setKind(value);if(value==='artwork'&&area===':contour')setArea('')}}/><span><b>{label}</b><small>{description}</small></span></label>)}
      </fieldset>
      <label className="field">图层名称<input value={name} maxLength={100} onChange={event=>setName(event.target.value)} placeholder={layerOptions.find(option=>option[0]===kind)?.[1]}/></label>
      <label className="field">作用区域<select value={area} onChange={event=>setArea(event.target.value)}>
        <option value="">{kind==='artwork'?'整面自由排版':'整张卡面'}</option>
        {source&&kind!=='artwork'&&<option value=":contour">{source.name} · 图层轮廓</option>}
        {side.regions.filter(region=>region.kind!=='full').map(region=><option value={region.id} key={region.id}>{region.name}</option>)}
        <optgroup label="新绘制蒙版">{[['paint','画笔'],['rect','矩形'],['ellipse','椭圆'],['polygon','多边形']].map(([value,label])=>
          <option value={':'+value} key={value}>绘制{label}蒙版</option>)}</optgroup>
      </select></label>
      {kind==='artwork'?<label className="field">彩稿内容<select value={content} onChange={event=>setContent(event.target.value as LayerDraft['content'])}>
        <option value="text">文字</option><option value="image">上传图片</option><option value="rect">矩形</option><option value="ellipse">椭圆</option>
      </select></label>:<label className="check-field"><input type="checkbox" checked={contentMask} onChange={event=>setContentMask(event.target.checked)}/>在区域内用文字、图形或图片细化蒙版</label>}
    </div>
    <div className="modal-footer"><button className="button" onClick={onClose}>取消</button><button className="button primary" onClick={()=>onCreate({kind,name:name.trim(),area,content,contentMask})}>
      {area.startsWith(':')&&area!==':contour'?'开始绘制':kind==='artwork'&&content==='image'?'选择图片':'创建图层'}
    </button></div>
  </>;
}

export function ProductionStack({project,side,selected,onSelect,onToggle,onAdd,onArtwork,onStock}:{
  project:Project;side:CardSide;selected:string|null;onSelect:(effect:Effect)=>void;onToggle:(effect:Effect)=>void;
  onAdd:()=>void;onArtwork:()=>void;onStock:()=>void;
}){
  const effectGroup = (kind:ProcessKind) => {
    const effects = [...side.effects].reverse().filter(effect=>processKind(effect)===kind);
    return effects.length ? <section className="process-group" key={kind} aria-label={PROCESS_LABELS[kind]}>
      <h3>{PROCESS_LABELS[kind]} <small>{effects.length}</small></h3>
      {effects.map(effect=><div className={effect.id===selected?'process-row selected':'process-row'} key={effect.id}>
        <button onClick={()=>onSelect(effect)}><span className={'process-dot '+kind}/><span>{effect.name}<small>{kind==='reflection'?`${FLASH_STYLES[getFlashStyle(project,effect)].label} · `:''}{effect.maskContent!==undefined?`内容蒙版 · ${effect.maskContent.length} 项`:side.regions.find(region=>region.id===effect.regionId)?.name||'区域缺失'}</small></span></button>
        <button className="process-toggle" aria-label={effect.name+(effect.visible?'隐藏':'显示')} onClick={()=>onToggle(effect)}>{effect.visible?<Eye size={15}/>:<EyeOff size={15}/>}</button>
      </div>)}
    </section>:null;
  };
  return <div className="production-stack">
    <button className="button wide-button" onClick={onAdd}><Plus size={16}/>新建图层</button>
    {effectGroup('varnish')}{effectGroup('foil')}{effectGroup('reflection')}
    <button className="stack-link" onClick={onArtwork}><Layers3 size={16}/><span>彩稿<small>{side.nodes.length} 个图文层</small></span><ChevronRight size={14}/></button>
    {effectGroup('white')}
    <button className="stack-link" onClick={onStock}><span className="process-dot reflection"/><span>底材反光<small>{STOCK_REFLECTIONS[getStockReflection(project)]}</small></span><ChevronRight size={14}/></button>
    <button className="stack-link" onClick={onStock}><Layers3 size={16}/><span>卡基<small>{STOCKS.find(stock=>stock.id===project.material)?.name??project.material}</small></span><ChevronRight size={14}/></button>
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
      context.fillStyle='#24362e';context.fillRect(0,0,ink.width,ink.height);
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
