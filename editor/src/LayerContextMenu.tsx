import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import './layer-context-menu.css';

export type MenuPoint = {x:number;y:number};
export interface LayerCommand { label:string; shortcut?:string; icon?:ReactNode; enabled:boolean; run:()=>void }

export function LayerContextMenu({screen,commands,close,label='图层操作',onKeyboardClose,dividers=[3,6]}:{
  screen:MenuPoint; commands:LayerCommand[]; close:()=>void; label?:string; onKeyboardClose?:()=>void; dividers?:readonly number[];
}) {
  const ref=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const menu=ref.current!;
    menu.style.left=Math.max(4,Math.min(screen.x,window.innerWidth-menu.offsetWidth-4))+'px';
    menu.style.top=Math.max(4,Math.min(screen.y,window.innerHeight-menu.offsetHeight-4))+'px';
    menu.focus({preventScroll:true});
  },[screen]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node))close()};
    window.addEventListener('pointerdown',outside,true);
    window.addEventListener('blur',close);
    window.addEventListener('resize',close);
    return ()=>{window.removeEventListener('pointerdown',outside,true);window.removeEventListener('blur',close);window.removeEventListener('resize',close)};
  },[close]);
  return <div ref={ref} role="menu" aria-label={label} className="layer-context-menu" tabIndex={-1}
    onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
      if(event.key==='Escape'||event.key==='Tab'){
        if(event.key==='Escape'&&onKeyboardClose)event.preventDefault();
        event.stopPropagation();onKeyboardClose?.();close();return;
      }
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      const items=Array.from(ref.current!.querySelectorAll<HTMLButtonElement>('button:enabled'));
      const index=items.indexOf(document.activeElement as HTMLButtonElement);
      const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?index+1:index<=0?items.length-1:index-1;
      items[next%items.length]?.focus();
    }}>
    {commands.map((cmd,index)=><div key={cmd.label} className={dividers.includes(index)?'menu-divider':undefined}>
      <button type="button" role="menuitem" disabled={!cmd.enabled} onClick={()=>{cmd.run();close()}}>
        {cmd.icon?<span className="menu-item-label">{cmd.icon}{cmd.label}</span>:cmd.label}<span>{cmd.shortcut}</span>
      </button>
    </div>)}
  </div>;
}
