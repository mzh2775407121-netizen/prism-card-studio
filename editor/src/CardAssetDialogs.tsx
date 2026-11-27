import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, Search, X } from 'lucide-react';
import { downloadAssetPackage, importAssetPackage, inspectAssetPackage, listCardAssets, manageCardAsset, readCardAsset, saveCardAsset, type AssetPackagePreview, type CardAssetSummary } from './cardAssets';
import { cardCovers, prepareCardAsset, type AssetSnapshot } from './cardAssetSnapshot';
import { cloneProjectCard, insertProjectCard, rememberCurrentCard } from './cardMembers';
import { changeWorkspace, currentWorkspace, listProjects, readProject, recordAssetUse, workspaceSignal, writeProject, ProjectRequestError, type ProjectSummary, type StoredProject } from './projects';
import { createProject, projectCards, projectForCard, uid, type Project, type ProjectCard } from './model';
import './card-assets.css';
import { accountName, communityRequest, holdingCard, holdingImage, type Account, type Work } from './communityClient';
import { AccountForm } from './AccountForm';
import { browserRuntime } from './runtime';

const failure = (error:unknown) => error instanceof Error ? error.message : '此操作未完成，请重试。';

function AssetDialog({title,children,close,busy=false}:{title:string;children:ReactNode;close:()=>void;busy?:boolean}) {
  const element=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const dialog=element.current;
    dialog?.showModal();
    return ()=>dialog?.close();
  },[]);
  return <dialog ref={element} className="asset-dialog" aria-label={title} onCancel={event=>{event.preventDefault();if(!busy)close()}}>
    <header><h2>{title}</h2><button aria-label="关闭" disabled={busy} onClick={close}><X size={16}/></button></header>{children}
  </dialog>;
}

function Faces({cover,backCover}:{cover:string;backCover?:string}) {
  return <div className="asset-faces"><img src={cover} alt="正面"/>{backCover&&<img src={backCover} alt="背面"/>}</div>;
}

function AssetAuthors({card,author}:{card:ProjectCard;author?:string}) {
  if(card.faceOrigins||card.assetFaceOrigins) {
    return <>{(card.singleSided?['front'] as const:['front','back'] as const).map(side=>{
      const shared=card.faceOrigins?card.faceOrigins[side]:card.communityOrigin;
      const owned=card.assetFaceOrigins?card.assetFaceOrigins[side]:card.assetOrigin;
      const name=shared?.publishedAuthor??shared?.author??owned?.author;
      const edition=shared?.edition??owned?.version;
      if(!name||!edition)return null;
      const face=side==='back'||card.looseFace==='back'?'背面':'正面';
      return <p key={side}>{face}原作者 · {name} · v{edition}</p>;
    })}</>;
  }
  const shared=card.communityOrigin;
  if(shared)return <p>原作者 · {shared.publishedAuthor??shared.author} · 社区版本 {shared.edition}</p>;
  if(card.assetOrigin?.author)return <p>原作者 · {card.assetOrigin.author} · v{card.assetOrigin.version}</p>;
  return author?<p>作者 · {author}</p>:null;
}

export function PublishCardAsset({project,onClose,onViewAsset}:{project:Project;onClose:()=>void;onViewAsset:(asset:CardAssetSummary)=>void}) {
  const [data,setData]=useState<AssetSnapshot>();
  const [match,setMatch]=useState<CardAssetSummary[]>([]);
  const [choice,setChoice]=useState('');
  const [name,setName]=useState(project.cardName || project.name);
  const [error,setError]=useState('');
  const [attempt,setAttempt]=useState(0);
  const [busy,setBusy]=useState(false);
  const [saved,setSaved]=useState<CardAssetSummary>();
  const requestId=useRef(uid());
  const guard=useRef(false);
  useEffect(()=>{
    let active=true;
    setError('');
    Promise.all([prepareCardAsset(project),listCardAssets()]).then(([snap,rows])=>{
      if(!active)return;
      const same=rows.filter(item=>item.projectId===project.id && item.cardId===snap.card.id);
      setData(snap);setMatch(same);setChoice(same[0]?.id??'');setName(same[0]?.name??snap.card.name);
    }).catch(e=>{if(active)setError(failure(e))});
    return ()=>{active=false};
  },[project,attempt]);
  async function save() {
    if(!data || !name.trim() || guard.current)return;
    guard.current=true;setBusy(true);setError('');
    try {setSaved(await saveCardAsset(choice||requestId.current,match.find(item=>item.id===choice)?.version??0,project.id,data,name));}
    catch(e){setError(failure(e))}
    finally{guard.current=false;setBusy(false)}
  }
  return <AssetDialog title="设为资产" close={onClose} busy={busy}>
    <div className="asset-dialog-body">
      {data ? <Faces cover={data.cover} backCover={data.backCover}/> : !error && <p role="status">正在准备卡面…</p>}
      {saved ? <p role="status">「{saved.name}」已存入我的资产 · v{saved.version}</p> : <>
        {match.length>0&&<label>存入位置<select value={choice} onChange={e=>{
          setChoice(e.target.value);setName(match.find(i=>i.id===e.target.value)?.name??data?.card.name??'');
        }}><option value="">另存新资产</option>{match.map(i=><option key={i.id} value={i.id}>{i.name} · v{i.version}</option>)}</select></label>}
        <label>资产名称<input autoFocus disabled={!data||busy} readOnly={!!choice} maxLength={500} value={name} onChange={e=>setName(e.target.value)}/></label>
      </>}
      {error&&<p role="alert">{error}</p>}
    </div><footer><button disabled={busy} onClick={onClose}>{saved?'关闭':'取消'}</button>
      {!data&&error?<button onClick={()=>setAttempt(n=>n+1)}>重试</button>:<button className="asset-primary" disabled={!saved&&(!data||!name.trim()||busy)} onClick={saved?()=>onViewAsset(saved):save}>{saved?'查看资产':busy?'正在存入…':'存入我的资产'}</button>}
    </footer>
  </AssetDialog>;
}

function useAssets(accountId:string|undefined,includeBackCovers:boolean) {
  const [items,setItems]=useState<CardAssetSummary[]>([]);
  const [ready,setReady]=useState(false);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true;
    setError('');setReady(false);setItems([]);
    if(!accountId)return;
    const scope=workspaceSignal();
    listCardAssets(includeBackCovers).then(rows=>{
      if(active&&!scope.aborted){setItems(rows);setReady(true);}
    }).catch(e=>{if(active&&!scope.aborted){setError(failure(e));setReady(true);}});
    return ()=>{active=false};
  },[accountId,includeBackCovers,revision]);
  return {items,ready,error,refresh:()=>setRevision(v=>v+1)};
}

function AssetTile({name,detail,cover,backCover,onSelect,disabled}:{name:string;detail:string;cover?:string;backCover?:string;onSelect:()=>void;disabled?:boolean}) {
  return <li><button onClick={onSelect} disabled={disabled}>
    <span className="asset-tile-art">
      {cover&&<img src={cover} alt="" loading="lazy" decoding="async"/>}
      {backCover&&<img src={backCover} alt="" loading="lazy" decoding="async"/>}
    </span>
    <span className="asset-tile-meta"><strong>{name}</strong><small>{detail}</small></span>
  </button></li>;
}

function AssetDetail({item,initialVersion,initialRemove,account,publication,cloudReady,onUse,onClose,onChange,pick=false}:{
  item:CardAssetSummary;initialVersion?:number;initialRemove:boolean;account:Account;publication?:Work;cloudReady:boolean;
  onUse:(card:ProjectCard)=>void;onClose:()=>void;onChange:()=>void;pick?:boolean
}) {
  const [version,setVersion]=useState(initialVersion??item.version);
  const versions=item.versions ? [...item.versions].reverse() : Array.from({length:item.version},(_,i)=>item.version-i);
  const [draft,setDraft]=useState(item.name);
  const [mode,setMode]=useState<'read'|'rename'|'remove'>(initialRemove?'remove':'read');
  const [data,setData]=useState<Awaited<ReturnType<typeof readCardAsset>>>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [withdrawn,setWithdrawn]=useState(false);
  const guard=useRef(false);
  const [changedPublication,setPublished]=useState<Work|null>();
  const published=changedPublication===undefined?publication:changedPublication;
  useEffect(()=>{
    let active=true;setError('');setMessage('');setData(undefined);
    readCardAsset(item.id,version).then(result=>{if(active)setData(result)}).catch(e=>{if(active)setError(failure(e))});
    return ()=>{active=false};
  },[item.id,version]);
  async function download() {
    if(guard.current||!data)return;
    guard.current=true;setBusy(true);setError('');setMessage('');
    try{
      await downloadAssetPackage({kind:'owned',asset:item.id,assetVersion:version},item.name);
      setMessage('资产包已准备完成');
    }catch(e){setError(failure(e));}
    finally{guard.current=false;setBusy(false);}
  }
  async function submit() {
    if(guard.current)return;
    if(mode==='read'){
      if(data){
        const card=cloneProjectCard(data.card);
        card.assetOrigin={assetId:data.assetId,version:data.version,authorId:data.authorId??account.id,author:data.author??accountName(account)};
        onUse(card);
      }
      return;
    }
    const scope=workspaceSignal();
    guard.current=true;setBusy(true);setError('');
    try{
      if(mode==='remove') {
        const active=await communityRequest<Work|null>('publication/'+item.id);
        scope.throwIfAborted();
        if(active && (active.id!==published?.id || active.edition!==published?.edition)) {
          setPublished(active);
          throw new Error('此资产的发布状态已更新，请确认撤回和移除。');
        }
        if(active) {
          await communityRequest('withdraw-remove',{work:active.id,edition:active.edition});
          scope.throwIfAborted();
          setPublished(null);setWithdrawn(true);
        }
      }
      await manageCardAsset(item,mode,draft);
      if(!scope.aborted){onChange();onClose();}
    }
    catch(e){setError(failure(e));}
    finally{guard.current=false;setBusy(false);}
  }
  const needsFonts=data?.card.front.nodes.concat(data.card.back.nodes).some(node=>node.fontRef?.kind==='device'||node.fontRef?.kind==='imported'&&!node.fontRef.share);
  return <AssetDialog title={mode==='rename'?'重命名资产':mode==='remove'?'移除资产':item.name} close={onClose} busy={busy}>
    <div className="asset-dialog-body">
      {mode==='read'&&<>
        <Faces cover={data?.cover??item.cover} backCover={data?.backCover??(version===item.version?item.backCover:undefined)}/>
        <div className="asset-details"><span>{item.widthMm} × {item.heightMm} mm · {item.singleSided?'单面':'双面'}</span>
          <select aria-label="资产版本" disabled={busy} value={version} onChange={e=>setVersion(Number(e.target.value))}>{versions.map(v=><option value={v} key={v}>v{v}</option>)}</select></div>
        {data&&<AssetAuthors card={data.card} author={data.author}/>}
        {needsFonts&&<p>部分字体需在使用设备上安装或替换。</p>}
        {!pick&&<div className="asset-options"><button disabled={busy} onClick={()=>setMode('rename')}>重命名</button>
          <button disabled={busy} onClick={()=>setMode('remove')}>移除资产</button>
          <button disabled={busy||!data} onClick={()=>void download()}>{busy?'正在准备…':'下载资产'}</button></div>}
      </>}
      {mode==='rename'&&<label>资产名称<input autoFocus value={draft} maxLength={500} onChange={e=>setDraft(e.target.value)}/></label>}
      {mode==='remove'&&<p>{published ? '撤回公开作品并移除「'+item.name+'」？他人已领取的资产和已有项目会保留。' :
        '移除「'+item.name+'」及其版本？已加入项目的卡牌会保留。'}</p>}
      {mode==='remove'&&withdrawn&&<p role="status">已撤回公开作品，可以继续重试移除资产。</p>}
      {message&&<p role="status">{message}</p>}
      {error&&<p role="alert">{error}</p>}
    </div>
    <footer><button disabled={busy} onClick={mode==='read'?onClose:()=>setMode('read')}>{mode==='read'?'关闭':'取消'}</button>
      {mode==='read'&&!pick&&!data?.card.communityOrigin&&!data?.card.faceOrigins&&
        ![data?.card.assetOrigin,...Object.values(data?.card.assetFaceOrigins??{})].some(origin=>origin&&origin.authorId!==account.id)&&<button disabled={busy||!data} onClick={()=>{onClose();location.hash='/community/publish/'+item.id+'/'+version}}>发布到社区</button>}
      <button className="asset-primary" disabled={busy||(!data&&mode==='read')||(mode==='rename'&&!draft.trim())||(mode==='remove'&&!cloudReady)} onClick={submit}>
        {mode==='read'?'使用':mode==='rename'?'保存':published?'撤回并移除':'移除'}</button></footer>
  </AssetDialog>;
}

function AssetPackageImport({file,onClose,onRestored}:{file:File;onClose:()=>void;onRestored:(target:Awaited<ReturnType<typeof importAssetPackage>>)=>void}) {
  const [preview,setPreview]=useState<AssetPackagePreview>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [retry,setRetry]=useState(0);
  const lock=useRef(false);
  useEffect(()=>{
    let active=true;setError('');setPreview(undefined);
    inspectAssetPackage(file).then(data=>{if(active)setPreview(data)}).catch(e=>{if(active)setError(failure(e))});
    return()=>{active=false;};
  },[file,retry]);
  async function restore(){
    if(lock.current||!preview)return;
    lock.current=true;setBusy(true);setError('');
    try{onRestored(await importAssetPackage(file));}
    catch(e){setError(failure(e));}
    finally{lock.current=false;setBusy(false);}
  }
  return <AssetDialog title="导入资产包" close={onClose} busy={busy}>
    <div className="asset-dialog-body">
      {preview?<>{preview.cover&&<Faces cover={preview.cover} backCover={preview.backCover}/>}
        <p><strong>{preview.name}</strong> · v{preview.edition}</p>
        <p>{preview.author} · {preview.widthMm} × {preview.heightMm} mm · {preview.singleSided?'单面':'双面'}</p>
        {preview.faceSources?.map(source=><p key={source.face}>{source.face==='back'?'背面':'正面'}原作者 · {source.author} · v{source.version}</p>)}
        {preview.fontWarnings?.length?<p>{preview.fontWarnings.join('、')}需安装或替换。</p>:null}
      </>:!error&&<p role="status">正在验证资产包…</p>}
      {error&&<p role="alert">{error}</p>}
    </div>
    <footer><button disabled={busy} onClick={onClose}>取消</button>
      {!preview&&error?<button onClick={()=>setRetry(n=>n+1)}>重试验证</button>:
        <button className="asset-primary" disabled={!preview||busy} onClick={()=>void restore()}>{busy?'正在导入…':'导入到我的资产'}</button>}
    </footer>
  </AssetDialog>;
}

function AssetBrowser({onUse,pick=false,path}:{onUse:(card:ProjectCard)=>void;pick?:boolean;path?:string}) {
  const target=new URLSearchParams(path?.split('?')[1]);
  const [source,setSource]=useState('all');
  const [query,setQuery]=useState('');
  const [selected,setSelected]=useState<CardAssetSummary>();
  const [account,setAccount]=useState<Account|null>(null);
  const {items,ready,error,refresh}=useAssets(account?.id,!pick);
  const [auth,setAuth]=useState(false);
  const [file,setFile]=useState<File>();
  const packageInput=useRef<HTMLInputElement>(null);
  const [holdings,setHoldings]=useState<Work[]>([]);
  const [cloudReady,setCloudReady]=useState(false);
  const [cloudError,setCloudError]=useState('');
  const [taking,setTaking]=useState(false);
  const [sessionRevision,setSessionRevision]=useState(0);
  const accountUnavailable=browserRuntime||currentWorkspace()==='lan';
  const targetAsset=target.get('asset'), targetVersion=Number(target.get('v'));
  useEffect(()=>{
    const changed=()=>{
      setAccount(null);setHoldings([]);setCloudReady(false);setSelected(undefined);setFile(undefined);setCloudError('');
      setQuery('');setSource('all');setAuth(false);setTaking(false);
      setSessionRevision(n=>n+1);refresh();
    };
    window.addEventListener('prism-workspace-changed',changed);
    return()=>window.removeEventListener('prism-workspace-changed',changed);
  },[]);
  useEffect(()=>{
    if(accountUnavailable){setCloudReady(true);return;}
    let active=true;
    const scope=workspaceSignal();
    (async()=>{
      try {
        const session=await communityRequest<Account|null>('session');
        if(!active||scope.aborted)return;
        setAccount(session);
        if(session){
          const rows=await communityRequest<Work[]>('library');
          if(active&&!scope.aborted)setHoldings(rows);
        }
      } catch(e) {
        if(active&&!scope.aborted)setCloudError(failure(e));
      } finally {
        if(active&&!scope.aborted)setCloudReady(true);
      }
    })();
    return()=>{active=false;};
  },[accountUnavailable,sessionRevision]);
  const startLogin=()=>{
    if(accountUnavailable){setCloudError('当前站点未连接账号服务');return;}
    setAuth(true);
  };
  const keyword=query.trim().toLocaleLowerCase();
  const filtered=items.filter(i=>(i.name+' '+(pick?'':i.origin?.author??accountName(account))).toLocaleLowerCase().includes(keyword)
    && (source==='all'||(source==='community')===Boolean(i.origin)));
  const accountItems=holdings.filter(w=>!(!w.resourcesRestricted && w.ownedAsset && items.some(i=>i.id===w.ownedAsset)) &&
    (source==='all'||(source==='own')===w.mine) && (w.name+' '+w.author).toLocaleLowerCase().includes(keyword));
  const searched=!!keyword||source!=='all';
  const loaded=ready&&cloudReady;
  const selectedItem=selected??items.find(item=>item.id===targetAsset);
  const selectedVersion=selectedItem?.id===targetAsset&&Number.isInteger(targetVersion)&&targetVersion>0&&
    (selectedItem.versions?.includes(targetVersion)??targetVersion<=selectedItem.version)
    ? targetVersion : undefined;
  const initialRemove=!!selectedItem&&selectedItem.id===targetAsset&&target.get('remove')==='1';
  const closeDetail=()=>{
    setSelected(undefined);
    if(targetAsset) location.hash='/assets';
  };
  const openHolding=async(w:Work)=>{
    if(!pick){location.hash='/community/library/'+w.id+'/'+w.edition;return;}
    if(taking)return;
    const scope=workspaceSignal();
    setTaking(true);setCloudError('');
    try {
      const card=await holdingCard(w);
      if(!scope.aborted)onUse(cloneProjectCard(card));
    }
    catch(e){if(!scope.aborted)setCloudError(failure(e));}
    finally{if(!scope.aborted)setTaking(false);}
  };
  return <section className={pick?'asset-library':'asset-library asset-library-page workbench-page-content'}>
    {!pick&&<div className="asset-page-heading" data-workbench-motion><h1 tabIndex={-1} data-workbench-title>我的资产</h1>
      {account?<button type="button" className="cm-btn" onClick={()=>packageInput.current?.click()}>导入资产包</button>:
        cloudReady&&<button type="button" className="cm-btn" onClick={startLogin}>登录账号</button>}
      {account&&<input ref={packageInput} type="file" accept=".prismasset" hidden onChange={e=>{
        const selected=e.currentTarget.files?.[0];e.currentTarget.value='';if(selected)setFile(selected);
      }}/>}
    </div>}
    {account&&<div className="asset-filters" data-workbench-motion={pick?undefined:''}>
      <div className="asset-search-control">
        {!pick&&<Search size={15} aria-hidden/>}
        <input className="asset-search" type="search" aria-label={pick?'查找卡牌资产':'搜索卡名或作者'} placeholder={pick?'搜索资产名称':'搜索卡名或作者'} value={query} onChange={e=>setQuery(e.target.value)}/>
      </div>
      <div className="asset-source-control">
        <select aria-label="资产来源" value={source} onChange={e=>{setSelected(undefined);setSource(e.target.value);}}>
          <option value="all">全部来源</option><option value="own">我创建的</option><option value="community">从社区复制</option>
        </select>
        {!pick&&<ChevronDown size={12} aria-hidden/>}
      </div>
    </div>}
    <div className="asset-list-content" data-workbench-motion={pick?undefined:''}>
      {cloudError&&<p role="alert">{cloudError}</p>}
      {!account?<div className="asset-empty">
        <p role="status">{cloudReady?'登录后查看我的资产':'正在读取资产…'}</p>
        {pick&&cloudReady&&<button type="button" className="cm-btn" onClick={startLogin}>登录账号</button>}
      </div>:<>
      {error&&<p role="alert">{error} <button onClick={refresh}>重试</button></p>}
      {filtered.length||accountItems.length?<ul className="asset-grid">
        {filtered.map(item=>{
          const size=item.widthMm+' × '+item.heightMm+' mm';
          const detail=[size,item.origin?.author??accountName(account),'v'+item.version].filter(Boolean).join(' · ');
          return <AssetTile key={item.id} name={item.name} detail={detail} cover={item.cover}
            backCover={pick||item.singleSided?undefined:item.backCover} onSelect={()=>setSelected(item)}/>;
        })}
        {accountItems.map(w=>{
          const size=w.width+' × '+w.height+' mm';
          const detail=w.resourcesPending?'素材待替换':w.author+' · '+size+' · v'+w.edition;
          const cover=w.coverFace??'front';
          return <AssetTile key={w.id+'-'+w.edition} name={w.name} detail={detail} cover={w.resourcesRestricted?undefined:holdingImage(w,cover)}
            backCover={pick||w.single||w.resourcesRestricted?undefined:holdingImage(w,cover==='front'?'back':'front')} disabled={taking} onSelect={()=>void openHolding(w)}/>;
        })}
      </ul>:!error&&!cloudError&&<div className="asset-empty">
        <p role="status">{!loaded?'正在读取资产…':searched?'没有找到匹配的卡牌':'暂无卡牌资产'}</p>
        {!pick&&loaded&&!searched&&<a href="#/community">浏览社区<ArrowRight size={14} aria-hidden/></a>}
      </div>}
      </>}
    </div>
    {account&&selectedItem&&<AssetDetail key={account.id+'-'+selectedItem.id+'-'+selectedVersion+'-'+initialRemove} item={selectedItem} initialVersion={selectedVersion}
      initialRemove={initialRemove} cloudReady={cloudReady}
      account={account} publication={holdings.find(w=>w.ownedAsset===selectedItem.id&&w.state==='public'&&w.edition===w.currentEdition)}
      pick={pick} onChange={refresh} onClose={closeDetail} onUse={card=>{closeDetail();onUse(card)}}/>}
    {auth&&<AccountForm onDone={user=>{setAuth(false);changeWorkspace(user.id);}} onClose={()=>setAuth(false)}/>}
    {account&&file&&<AssetPackageImport file={file} onClose={()=>setFile(undefined)} onRestored={restored=>{
      setFile(undefined);setSource('all');refresh();setSessionRevision(n=>n+1);
      location.hash=restored.kind==='owned'?'/assets?'+new URLSearchParams({asset:restored.assetId,v:String(restored.assetVersion)}):
        '/community/library/'+restored.work+'/'+restored.edition;
    }}/>}
  </section>;
}
export { AssetBrowser };
export function PickCardAsset({onPick,onClose}:{onPick:(card:ProjectCard)=>void;onClose:()=>void}) {
  return <AssetDialog title="从我的资产添加" close={onClose}><div className="asset-dialog-body"><AssetBrowser pick onUse={onPick}/></div></AssetDialog>;
}

export function UseAssetDialog({card,onClose,onOpen}:{card:ProjectCard;onClose:()=>void;onOpen:(record:StoredProject)=>void}) {
  const [target,setTarget]=useState('');
  const [items,setItems]=useState<ProjectSummary[]>([]);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [cover,setCover]=useState<Awaited<ReturnType<typeof cardCovers>>>();
  const guard=useRef(false);
  const ids=useRef({project:uid(),mutation:uid(),card:uid()});
  const attempt=useRef<{next:Project;revision:number;mutation:string}|undefined>(undefined);
  useEffect(()=>{
    let active=true;
    listProjects().then(rows=>{if(active)setItems(rows.filter(r=>!r.archivedAt))}).catch(e=>{if(active)setError(failure(e))});
    cardCovers(card).then(result=>{if(active)setCover(result)}).catch(e=>{if(active)setError(failure(e))});
    return ()=>{active=false};
  },[card]);
  async function use() {
    if(guard.current)return;
    const scope=workspaceSignal();
    guard.current=true;setBusy(true);setError('');
    const done=(record:StoredProject)=>{
      scope.throwIfAborted();
      rememberCurrentCard(record.id,ids.current.card);
      void recordAssetUse(record.id,ids.current.card,card).catch(()=>{});
      onOpen(record);
    };
    try{
      if(!attempt.current){
        const instance=cloneProjectCard(card);
        instance.id=ids.current.card;
        let next:Project, revision=0;
        if(target){
          const record=await readProject(target);
          scope.throwIfAborted();
          if(record.archivedAt!==null)throw new Error('此项目已归档，请先恢复项目。');
          if(projectCards(record.project).some(c=>c.id===instance.id)){done(record);return;}
          if(record.project.production?.printProfile)instance.production={dieShape:instance.production?.dieShape??'card',steps:[],printProfile:structuredClone(record.project.production.printProfile)};
          next=insertProjectCard(record.project,instance);next.version++;revision=record.revision;
        } else next=projectForCard({...createProject('blank',card.name),id:ids.current.project},instance);
        next.updatedAt=Date.now();
        attempt.current={next,revision,mutation:ids.current.mutation};
      }
      const {next,revision,mutation}=attempt.current;
      scope.throwIfAborted();
      const summary=await writeProject(next,revision,mutation);
      done({...summary,project:next});
    }catch(e){
      if(e instanceof ProjectRequestError&&e.status===409&&attempt.current&&!scope.aborted){
        const committed=await readProject(attempt.current.next.id).catch(()=>undefined);
        if(!scope.aborted&&committed&&committed.archivedAt===null&&projectCards(committed.project).some(c=>c.id===ids.current.card)){
          done(committed);return;
        }
      }
      if(e instanceof ProjectRequestError&&e.status>=400&&e.status<500&&e.status!==408)attempt.current=undefined;
      setError(failure(e));guard.current=false;setBusy(false);
    }
  }
  const chosen=items.find(i=>i.id===target);
  return <AssetDialog title="使用卡牌资产" close={onClose} busy={busy}><div className="asset-dialog-body">
    {cover&&<Faces {...cover}/>}<p>{card.name} · {card.widthMm} × {card.heightMm} mm</p>
    <label>目标项目<select value={target} disabled={busy||!!attempt.current} onChange={e=>setTarget(e.target.value)}><option value="">新建项目</option>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
    {chosen&&<p>{chosen.cardCount} 张 → {chosen.cardCount+1} 张</p>}{error&&<p role="alert">{error}</p>}
  </div><footer><button disabled={busy} onClick={onClose}>取消</button><button className="asset-primary" disabled={busy} onClick={use}>{busy?'正在保存…':target?'加入项目':'创建项目'}</button></footer></AssetDialog>;
}
