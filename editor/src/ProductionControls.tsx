import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Square, Type } from 'lucide-react';
import { getStockFinish, STOCK_REFLECTIONS, uid, type CardNode, type CardSide, type Effect, type Project, type Region,
  type SideName, type StockFinish, type StockFinishMatch, type StockReflection, type StockSpec } from './model';
import { STOCKS, STOCK_CORES, STOCK_FINISH_STYLES, STOCK_FINISH_METHODS, stockPreset, confirmedStockFinish,
  isMetalFinish, isTransparentStock, stockFinishConflict, stockFinishHasPattern, needsStockFinishMatch, stockKeys } from './stockMaterials';
import { LAYER_KINDS, type LayerKind } from './layers';
import InspectorMenu from './InspectorMenu';
import { readImage } from './io';
import { makeCanvas, renderEffectMask } from './render';
import './production-controls.css';

export function StockPicker({material,spec,onMaterial,onSpec,presetMeasurements=false}:{
  material:string;spec:StockSpec;onMaterial:(material:string)=>void;onSpec:(spec:StockSpec)=>void; presetMeasurements?:boolean;
}) {
  const stock = stockPreset(material);
  const plastic = stock?.plastic === true;
  const metric = plastic ? 'thicknessMm' : 'grammageGsm';
  const label = plastic ? '片厚' : '克重';
  const unit = plastic ? 'mm' : 'g/m²';
  const measurements = plastic ? stock?.thicknesses : stock?.weights;
  const measure = spec[metric];
  const core = spec.core ?? (stock?.cores?.length === 1 ? stock.cores[0] : undefined);
  const corePlaceholder = plastic ? '不适用' : '待确认';
  return <div className="stock-picker">
    <label className="field">卡基材料
      <span className="stock-select"><select value={material} onChange={event=>onMaterial(event.target.value)}>
        {!stock&&<option value={material}>{material}</option>}
        {STOCKS.map(stock=><option key={stock.id} value={stock.id}>{stock.name} · {stock.note}</option>)}
      </select></span>
    </label>
    <div className="stock-spec-fields">
      {presetMeasurements?<label className="stock-measure stock-select stock-preset-field">
        <span>{label}</span>
        <span className="stock-preset-value" aria-hidden="true">
          {measure?.toFixed(2)??'待确认'}
          {measure!==undefined&&<span>{unit}</span>}
        </span>
        <select aria-label={label} value={measure??''} disabled={!measurements?.length}
          onChange={event=>onSpec({...spec,[metric]:Number(event.target.value)})}>
          {!measurements?.length&&<option value="">待确认</option>}
          {measurements?.map(value=><option key={value} value={value}>{value.toFixed(2)} {unit}</option>)}
        </select>
      </label>:<label className="stock-measure">
        <span>{label}</span><input key={material+':'+(spec[metric]??'')} type="number" aria-label={label}
          defaultValue={spec[metric]} placeholder="待确认" min={plastic ? .01 : 1} max={plastic ? 10 : 2000} step="any"
          onBlur={event=>{
            const field=event.currentTarget;
            if(!field.validity.valid){field.value=String(spec[metric]??'');return}
            const value=field.value===''?undefined:field.valueAsNumber;
            if(value!==spec[metric])onSpec({...spec,[metric]:value});
          }} onKeyDown={event=>{
            if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur()}
          }}/><span aria-hidden="true">{unit}</span>
      </label>}
      <label className={`stock-measure stock-select stock-core${presetMeasurements?' stock-preset-field':''}`}>
        <span>选配</span>
        {presetMeasurements&&<span className="stock-preset-value" aria-hidden="true">{core?STOCK_CORES[core]:corePlaceholder}</span>}
        <select aria-label="选配芯层" value={core??''} disabled={!stock?.cores||stock.cores.length===1}
          onChange={event=>onSpec({...spec,core:(event.target.value||undefined) as StockSpec['core']})}>
          <option value="">{corePlaceholder}</option>
          {stock?.cores?.map(core=><option key={core} value={core}>{STOCK_CORES[core]}</option>)}
          {spec.core&&!stock?.cores?.includes(spec.core)&&<option value={spec.core}>{STOCK_CORES[spec.core]}</option>}
        </select>
      </label>
    </div>
  </div>;
}

export function StockFinishControls({project,side,onChange,onMatch}:{
  project:Project;side:SideName;
  onChange:(finish:StockFinish,continuous?:boolean)=>void;onMatch:()=>void;
}) {
  const finish = getStockFinish(project,side);
  const match = confirmedStockFinish(project,side);
  const choices = finish.style==='radial' ? [...STOCK_FINISH_STYLES,'radial' as const] : STOCK_FINISH_STYLES;
  const pending = needsStockFinishMatch(project,side);
  const clearStock = isTransparentStock(project.material);
  const affectsTransparency = clearStock && finish.style!=='none' &&
    (isMetalFinish(finish.style)||match?.transparent===false);
  return <div className="stock-finish">
    <div className="section-heading">底材反光</div>
    <label className="field">反光样式<span className="stock-select"><select value={finish.style} onChange={event=>{
      const style=event.target.value as StockReflection;
      if(style!==finish.style)onChange({...finish,style,match:undefined,reviewRequired:finish.reviewRequired||!!finish.match||undefined});
    }}>
      {choices.map(choice=><option value={choice} key={choice}>
        {STOCK_REFLECTIONS[choice]}{clearStock&&isMetalFinish(choice)?' · 不透光':''}
      </option>)}
    </select></span></label>
    {finish.style!=='none'&&<>
      <label className="check-field"><input type="checkbox" checked={finish.visible!==false}
        onChange={event=>onChange({...finish,visible:event.target.checked})}/>显示反光预览</label>
      <label className="range-field"><span>预览透明度<b>{Math.round(finish.opacity*100)}%</b></span>
        <input aria-label="预览透明度" type="range" min={0} max={100} value={Math.round(finish.opacity*100)}
          onChange={event=>onChange({...finish,opacity:Number(event.target.value)/100},true)}/>
      </label>
    </>}
    {affectsTransparency&&<p className="stock-finish-message">不透明反光覆盖的区域会失去透光效果。保留透光时，请匹配透明镭射膜。</p>}
    {(pending||match)&&<div className="stock-match-row">
      <span>{pending?'待印厂确认':'已匹配用料'}{match&&<small>{match.materialCode}{match.patternCode?' · '+match.patternCode:''}</small>}</span>
      <button type="button" className="button" onClick={onMatch}>{match?'编辑匹配':finish.style==='none'?'确认无反光':'匹配用料'}</button>
    </div>}
  </div>;
}

export function StockFinishMatchForm({project,side,onApply,onClose,onPlan}:{
  project:Project;side:SideName;onApply:(match?:StockFinishMatch)=>void;onClose:()=>void;onPlan:()=>void;
}) {
  const {style}=getStockFinish(project,side);
  const existing=confirmedStockFinish(project,side);
  const keys=stockKeys(project);
  const [materialCode,setMaterialCode]=useState(existing?.materialCode??'');
  const [patternCode,setPatternCode]=useState(existing?.patternCode??'');
  const [orientation,setOrientation]=useState(String(existing?.orientationDeg??0));
  const [method,setMethod]=useState<StockFinishMatch['method']>(existing?.method??'composite');
  const [transparent,setTransparent]=useState(existing?.transparent??(isTransparentStock(project.material)&&!isMetalFinish(style)));
  const [acknowledged,setAcknowledged]=useState(Boolean(existing));
  const conflict=stockFinishConflict(style,{transparent});
  const patterned=stockFinishHasPattern(style);
  const angle=Number(orientation);
  const valid=style==='none'||Boolean(materialCode.trim()&&(!patterned||patternCode.trim())&&orientation.trim()&&Math.abs(angle)<=360);
  const edit=()=>setAcknowledged(false);
  return <form className="stock-match-form" onSubmit={event=>{
    event.preventDefault();
    if(!keys.profileKey||!valid||conflict||!acknowledged)return;
    onApply(style==='none'?undefined:{...keys,materialCode:materialCode.trim(),patternCode:patternCode.trim()||undefined,orientationDeg:angle,method,transparent});
  }}>
    <div className="new-content">
      {!keys.profileKey?<p>填写印厂、卡基料号及厂家规格后，确认该卡面的反光用料。</p>:<>
        {style!=='none'&&<>
        <div className="stock-spec-fields">
          <label className="field">反光材料料号<input value={materialCode} maxLength={120}
            onChange={event=>{setMaterialCode(event.target.value);edit()}}/></label>
          <label className="field">纹样号<input value={patternCode} maxLength={120} required={patterned}
            onChange={event=>{setPatternCode(event.target.value);edit()}}/></label>
        </div>
        <div className="stock-spec-fields">
          <label className="field">加工方式<span className="stock-select"><select value={method}
            onChange={event=>{setMethod(event.target.value as StockFinishMatch['method']);edit()}}>
            {Object.entries(STOCK_FINISH_METHODS).map(([id,name])=><option value={id} key={id}>{name}</option>)}
          </select></span></label>
          <label className="field">纹向（°）<input type="number" min={-360} max={360} step="any"
            value={orientation} onChange={event=>{setOrientation(event.target.value);edit()}}/></label>
        </div>
        <label className="check-field"><input type="checkbox" checked={transparent}
          onChange={event=>{setTransparent(event.target.checked);edit()}}/>反光材料透光</label>
        {conflict&&<p className="stock-finish-message" role="alert">{conflict}</p>}
        </>}
        <label className="check-field"><input type="checkbox" checked={acknowledged}
          onChange={event=>setAcknowledged(event.target.checked)}/>{style==='none'?'印厂已确认此面无反光':'印厂已确认此组合'}</label>
      </>}
    </div>
    <div className="modal-footer">
      <button type="button" className="button" onClick={onClose}>取消</button>
      {keys.profileKey?<button type="submit" className="button primary" disabled={!valid||!!conflict||!acknowledged}>保存匹配</button>:
        <button type="button" className="button primary" onClick={onPlan}>设置印厂规格</button>}
    </div>
  </form>;
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
    ...(regions.length >= 2 ? [{ value: 'union:', label: '组合已有蒙版…' }] : []),
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
