import { useEffect, useState } from 'react';
import { workspaceHeaders, workspaceSignal } from './projects';

type Status={enabled:boolean;url:string;password:string;projectId:string};

async function control(action?:string,projectId?:string):Promise<Status>{
  const scope=workspaceSignal();
  const headers=workspaceHeaders();
  const response=await fetch('/api/lan',action
    ? {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({action,projectId}),signal:scope}
    : {headers,signal:scope});
  if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error||'局域网服务暂时不可用');
  return response.json();
}

export function LanShare({projectId,name}:{projectId:string;name:string}) {
  const [status,setStatus]=useState<Status>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [feedback,setFeedback]=useState('');
  useEffect(()=>{let alive=true;control().then(value=>{if(alive)setStatus(value)}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[]);
  const change=async(action:string)=>{
    setBusy(true);setError('');setFeedback('');
    try{setStatus(await control(action,projectId))}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  };
  const copy=async(value:string)=>{
    try{await navigator.clipboard.writeText(value);setFeedback('已复制')}catch{setFeedback('请选中并复制')}
  };
  return <div className="card-manager-body lan-share-body">
    {status?.enabled?<>
      <p>{status.projectId===projectId?'正在共享「'+name+'」':'另一项目正在共享'}</p>
      {status.projectId===projectId&&<>
        <label>访问网址<input aria-label="访问网址" readOnly value={status.url} onFocus={e=>e.target.select()}/><button onClick={()=>void copy(status.url)}>复制网址</button></label>
        <label>访问密码<input aria-label="访问密码" readOnly value={status.password} onFocus={e=>e.target.select()}/><button onClick={()=>void copy(status.password)}>复制密码</button></label>
        <p>第二台设备首次连接，请从本机传送并信任此证书，再用同一网络打开网址。</p>
        <a href="/api/lan/certificate" download="Prism-LAN.crt">下载本机信任证书</a>
      </>}
      <div className="member-bar"><button disabled={busy} onClick={()=>void change('stop')}>停止共享</button>
       {status.projectId===projectId&&<button disabled={busy} onClick={()=>void change('rotate')}>更换密码</button>}</div>
    </>:status?<><p>持有密码的同网设备可编辑「{name}」。</p><div className="member-bar"><button disabled={busy} onClick={()=>void change('start')}>开启此项目的共享</button></div></>:!error&&<p>正在读取…</p>}
    {feedback&&<span role="status">{feedback}</span>}{error&&<p role="alert">{error}</p>}
  </div>;
}
