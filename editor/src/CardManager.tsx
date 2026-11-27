import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, FolderInput, GripVertical, Pencil, Save, Trash2 } from 'lucide-react';
import { projectCards, projectForCard, type Project, type ProjectCard } from './model';
import { renderCard } from './render';
import './card-manager.css';

function CardThumb({project,card}:{project:Project;card:ProjectCard}) {
  const [src,setSrc]=useState('');
  useEffect(()=>{
    let active=true;
    const projection=projectForCard(project,card);
    void renderCard(projection,'front',{scale:8/Math.max(card.widthMm,card.heightMm)})
      .then(canvas=>{if(active)setSrc(canvas.toDataURL())}).catch(()=>{if(active)setSrc('')});
    return ()=>{active=false};
  },[project.id,card.id,card.front,card.widthMm,card.heightMm,card.material]);
  return <span className="member-thumb">{src&&<img src={src} alt=""/>}</span>;
}

interface Props {
  project:Project;
  busy:boolean;
  onSwitch:(id:string)=>void;
  onCopy:()=>void;
  onRemove:()=>void;
  onName:(name:string)=>void;
  onMove:(id:string,to:number)=>void;
  onPublish:()=>void;
  onAsset:()=>void;
  onHistory:()=>void;
  onShare?:()=>void;
}

export default function CardManager({project,busy,onSwitch,onCopy,onRemove,onName,onMove,onPublish,onAsset,onHistory,onShare}:Props) {
  const cards=useMemo(()=>projectCards(project),[project]);
  const [renaming,setRenaming]=useState<string|null>(null);
  const [removing,setRemoving]=useState(false);
  const [over,setOver]=useState<string>();
  const dragged=useRef<string|null>(null);
  const current=cards[project.activeCardIndex??0];
  useEffect(()=>{setRenaming(null);setRemoving(false)},[current.id]);
  function rename(){
    const name=renaming?.trim();
    if(name) {onName(name);setRenaming(null)}
  }
  return <div className="card-manager-body">
    <div className="member-bar">
      <button type="button" onClick={onAsset} disabled={busy}><FolderInput/>从我的资产添加</button>
    </div>
    <ol className="member-list" aria-label="卡牌顺序">{cards.map((card,index)=>
      <li key={card.id} className={over===card.id?'member-drop':''} onDragOver={event=>{
        if(dragged.current){event.preventDefault();setOver(card.id)}
      }} onDrop={event=>{
        event.preventDefault();if(dragged.current&&!busy)onMove(dragged.current,index);
        dragged.current=null;setOver(undefined);
      }}>
        <button type="button" className="member-open" aria-pressed={card.id===current.id} disabled={busy}
          draggable={!busy} onDragStart={event=>{dragged.current=card.id;event.dataTransfer.setData('text/plain',card.id);event.dataTransfer.effectAllowed='move'}}
          onDragEnd={()=>{dragged.current=null;setOver(undefined)}} onClick={()=>onSwitch(card.id)}>
          <GripVertical size={14}/><span className="member-number">{index+1}</span><CardThumb card={card} project={project}/>
          <span className="member-name"><strong>{card.name}</strong><small>{card.widthMm} × {card.heightMm} mm · {card.singleSided?'单面':'双面'}</small></span>
        </button>
      </li>)}</ol>
    {renaming!==null?<form className="member-edit" onSubmit={event=>{event.preventDefault();rename()}}>
      <input aria-label="卡牌名称" autoFocus value={renaming} maxLength={500} onFocus={event=>event.target.select()} onChange={event=>setRenaming(event.target.value)}/>
      <button type="submit" disabled={!renaming.trim()}>保存</button><button type="button" onClick={()=>setRenaming(null)}>取消</button>
    </form>:removing?<div className="member-edit">
      <span>移除「{current.name}」？</span><button type="button" onClick={()=>{setRemoving(false);onRemove()}}>移除</button>
      <button type="button" onClick={()=>setRemoving(false)}>取消</button>
    </div>:<div className="member-controls">
      <button type="button" title="重命名卡牌" aria-label="重命名卡牌" onClick={()=>setRenaming(current.name)} disabled={busy}><Pencil/></button>
      <button type="button" title="复制当前卡" aria-label="复制当前卡" onClick={onCopy} disabled={busy}><Copy/></button>
      <button type="button" title="上移当前卡" aria-label="上移当前卡" onClick={()=>onMove(current.id,(project.activeCardIndex??0)-1)} disabled={busy||current.id===cards[0].id}><ArrowUp/></button>
      <button type="button" title="下移当前卡" aria-label="下移当前卡" onClick={()=>onMove(current.id,(project.activeCardIndex??0)+1)} disabled={busy||current.id===cards.at(-1)?.id}><ArrowDown/></button>
      <button type="button" title="移除当前卡" aria-label="移除当前卡" onClick={()=>setRemoving(true)} disabled={busy||cards.length===1}><Trash2/></button>
      <button type="button" className="member-publish" onClick={onPublish} disabled={busy}><Save/>设为资产</button>
    </div>}
    <div className="member-footer"><button type="button" onClick={onHistory} disabled={busy}>交付版本</button>{onShare&&<button type="button" onClick={onShare} disabled={busy}>局域网接力</button>}<span>{cards.length} 张卡</span></div>
  </div>;
}
