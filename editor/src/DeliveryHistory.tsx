import { useEffect, useState } from 'react';
import { createStore, get, set } from 'idb-keyval';
import { importProject } from './io';
import { copyProject, projectCards, uid, type Project, type SideName } from './model';
import { createStoredProject, workspaceHeaders, type StoredProject } from './projects';
import { rememberCurrentCard } from './cardMembers';
import { browserRuntime } from './runtime';
import { listDeliveryVersions, readDeliveryVersion } from './browserProjects';
import packageInfo from '../package.json';

type Output = {
  mode:'image'|'print'; faces:SideName[]; profile:string; dpi:number; output:string; checksum:string;
};
type Delivery = Output & {
  id:string; projectId:string; revision:number; cardId:string; cardIndex:number; cardName:string;
  time:number; engine:string; sourceHash:string;
};
type Entry = Delivery & {source:Blob};
const store = createStore('prism-delivery-packages','deliveries');
const endpoint = (id:string) => '/api/projects/'+encodeURIComponent(id)+'/deliveries';
const hexDigest=async(blob:Blob)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('');

async function checkResponse(response:Response) {
  if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error||'交付版本读取失败');
  return response;
}

export async function saveDelivery(project:Project,output:Omit<Output,'checksum'>,file:Blob,source:Blob) {
  let engine=`${packageInfo.name}/${packageInfo.version}`;
  if(output.mode==='print'){
    const {default:JSZip}=await import('jszip');
    const report=(await JSZip.loadAsync(file)).file('preflight-report.json');
    const version=report&&JSON.parse(await report.async('text')).engine;
    if(typeof version==='string')engine=version;
  }
  const entry:Delivery={...output,id:uid(),projectId:project.id,revision:project.version,
    cardId:project.cardId??project.id+'_1',cardIndex:project.activeCardIndex??0,
    cardName:project.cardName??'卡牌 1',time:Date.now(),engine,
    checksum:await hexDigest(file),sourceHash:await hexDigest(source)};
  if(browserRuntime){
    await set([project.id,entry.id],{...entry,source} satisfies Entry,store);
    return;
  }
  const data=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);
    reader.readAsDataURL(source);
  });
  await checkResponse(await fetch(endpoint(project.id),{method:'POST',headers:{...workspaceHeaders(),'Content-Type':'application/json'},
    body:JSON.stringify({entry,source:data})}));
}

type Summary=Partial<Delivery>&Pick<Delivery,'id'|'revision'>;
async function list(id:string):Promise<Summary[]> {
  let results:Delivery[];
  if(browserRuntime){
    const { keys }=await import('idb-keyval');
    const matching=(await keys(store)).filter(key=>Array.isArray(key)&&key[0]===id);
    results=(await Promise.all(matching.map(key=>get<Entry>(key,store)))).flatMap(value=>{if(!value)return [];const {source:_,...metadata}=value;return [metadata]});
  }else{
    results=await (await checkResponse(await fetch(endpoint(id),{headers:workspaceHeaders()}))).json();
  }
  // Older exports have one source snapshot per revision without output metadata.
  const scope=workspaceHeaders()['X-Prism-Workspace'];
  const legacy=scope&&scope!=='local'?[]:await listDeliveryVersions(id).catch(()=>[]);
  return [...results.sort((a,b)=>b.time-a.time),...legacy.map(revision=>({id:'legacy-'+revision,revision}))];
}

export function DeliveryHistory({projectId,onOpen}:{projectId:string;onOpen:(record:StoredProject)=>void}){
  const [items,setItems]=useState<Summary[]>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true;
    setError('');
    list(projectId).then(entries=>{if(active)setItems(entries)}).catch(e=>{if(active)setError(e.message)});
    return()=>{active=false};
  },[projectId,retry]);
  const open=async(item:Summary)=>{
    if(busy)return;
    setBusy(true);setError('');
    try{
      let project:Project|undefined;
      if(item.id.startsWith('legacy-'))project=await readDeliveryVersion(projectId,item.revision);
      else {
        const source=browserRuntime?(await get<Entry>([projectId,item.id],store))?.source:
          await (await checkResponse(await fetch(endpoint(projectId)+'/'+encodeURIComponent(item.id),{headers:workspaceHeaders()}))).blob();
        if(!source||await hexDigest(source)!==item.sourceHash)throw new Error('交付源稿缺失或校验失败');
        project=await importProject(new File([source],'交付源稿.cardproj'));
      }
      if(!project)throw new Error('找不到该交付版本');
      const copy=copyProject(project,(project.name.slice(0,465)+' · 交付 v'+item.revision),1);
      const record=await createStoredProject(copy);
      const card=projectCards(copy)[item.cardIndex??0];
      if(card)rememberCurrentCard(copy.id,card.id);
      onOpen(record);
    }catch(e){setError((e as Error).message)}finally{setBusy(false)}
  };
  return <div className="card-manager-body">
    {!items&&!error&&<p role="status">正在读取…</p>}
    {error&&<div role="alert">{error} <button type="button" onClick={()=>setRetry(n=>n+1)}>重试</button></div>}
    {items?.length===0&&<p>尚无交付版本</p>}
    {!!items?.length&&<ul className="member-list">{items.map(item=><li key={item.id}>
      <button type="button" disabled={busy} className="member-open" onClick={()=>void open(item)}>
        <span className="member-name"><strong>{item.cardName??'历史工程'} · v{item.revision}</strong>
          <small>{item.time?new Date(item.time).toLocaleString()+' · '+(item.mode==='image'?'数字文件':'印刷文件'):'旧版交付'}</small></span>
        <span style={{marginLeft:'auto'}}>打开副本</span>
      </button></li>)}</ul>}
  </div>;
}
