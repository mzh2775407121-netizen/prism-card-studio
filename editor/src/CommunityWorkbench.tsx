import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, Globe, Layers, Search, X } from 'lucide-react';
import { AccountForm } from './AccountForm';
import { downloadAssetPackage, readCardAsset, type CardAssetVersion } from './cardAssets';
import type { CardNode, ProjectCard } from './model';
import { changeWorkspace, workspaceSignal } from './projects';
import { preparePublicVersion, publicCardImages, publicReplacementImage, restrictedPublicFont } from './communityPreparation';
import { cardCovers } from './cardAssetSnapshot';
import { artworkBounds } from './artworkAlignment';
import { browserRuntime } from './runtime';
import './community.css';

import { accountName, clearPendingCopy, COMMUNITY_CATEGORIES, pendingCopy, PUBLISHABLE_COMMUNITY_CATEGORIES, communityRequest as request, holdingCard, holdingImage as imageUrl, type Account, type CommunityCategory, type CommunityResource, type Work } from './communityClient';

const root = '#/community';
const library = root + '/library';
const icons = '/assets/workbench/community-';
const entry = (work: Work) => library + '/' + work.id + '/' + work.edition;
const categories = Object.keys(COMMUNITY_CATEGORIES) as CommunityCategory[];
const visibleWorksPerRow = 5;
const acceptedImages = 'image/png,image/jpeg,image/webp';

function readCategory(value: string | null | undefined) {
  return categories.find(category => category === value);
}

function galleryHref(category?: CommunityCategory, query = '') {
  const path = category ? root + '/category/' + category : root;
  if (!query.trim()) return path;
  const params = new URLSearchParams({ q: query });
  return (category ? path : path + '/') + '?' + params;
}

function publicWorkHref(work: Work, category: CommunityCategory | undefined, query: string) {
  const params = new URLSearchParams();
  if (category) params.set('from', category);
  if (query.trim()) params.set('q', query);
  return root + '/' + work.id + (params.size ? '?' + params : '');
}

function inspectCard(card: ProjectCard) {
  const files = new Set<string>(), fonts = new Set<string>(), restricted = new Set<string>(), cropped = new Set<string>(), hidden = new Set<string>();
  const outside = new Set<string>();
  const bleed = card.bleedMm * 10;
  let layers = 0, masks = 0, processes = 0;
  const visit = (node:CardNode) => {
    if (node.type==='image' && node.src) files.add(node.src);
    if (node.imageFill?.src) files.add(node.imageFill.src);
    if (node.crop || node.imageFill?.crop) cropped.add(node.name);
    if (!node.visible) hidden.add(node.name);
    if (node.type==='text') {
      const ref = node.fontRef;
      fonts.add(ref?.kind==='builtin' ? ref.id : ref?.family || node.fontFamily || '默认字体');
      if (restrictedPublicFont(node)) restricted.add(node.name);
    }
  };
  for (const face of (card.singleSided ? [card.front] : [card.front, card.back])) {
    face.nodes.forEach(visit);
    for (const node of face.nodes) {
      const box = artworkBounds(node);
      if (box.right < -bleed || box.left > card.widthMm*10+bleed ||
          box.bottom < -bleed || box.top > card.heightMm*10+bleed) outside.add(node.name);
    }
    layers += face.nodes.length;
    masks += face.regions.length;
    processes += face.effects.length;
    for (const r of face.regions) if (r.snapshot) visit(r.snapshot);
    for (const fx of face.effects) fx.maskContent?.forEach(visit);
  }
  return {layers,masks,processes,images:files.size,fonts:[...fonts],restricted:[...restricted],cropped:[...cropped],hidden:[...hidden],outside:[...outside]};
}

type Props = {onUseCard:(card:ProjectCard)=>void};
type PublicationState = {state:'public'|'withdrawn'|'blocked';edition:number};

export default function CommunityWorkbench(p:Props & {path:string}) {
  if(browserRuntime)return <section className="community-page">
    <div className="cm-shell workbench-page-content">
      <header className="community-heading cm-top cm-top-browse" data-workbench-motion>
        <h1 tabIndex={-1} data-workbench-title>社区</h1>
      </header>
      <div className="cm-empty" data-workbench-motion><p role="status">当前站点未连接社区服务</p></div>
    </div>
  </section>;
  return <CommunityPage key={p.path} {...p}/>;
}

function CommunityPage({path,onUseCard}:Props & {path:string}) {
  const [pathname, search] = path.split('?');
  const [, , type, id, ver] = pathname.split('/');
  const params = new URLSearchParams(search);
  const isLibrary=type==='library', publish=type==='publish';
  const isGallery=!type || type==='category';
  const category=type==='category'?readCategory(id):undefined;
  const wid=isLibrary?id:!publish&&!isGallery?type:undefined;
  const previousCategory=wid&&!isLibrary?readCategory(params.get('from')):undefined;
  const [account,setAccount]=useState<Account|null>(null), [auth,setAuth]=useState(false), [reload,setReload]=useState(0);
  const [list,setList]=useState<Work[]>([]), [work,setWork]=useState<Work>(), [asset,setAsset]=useState<CardAssetVersion>();
  const [loading,setLoading]=useState(true), [busy,setBusy]=useState(false), [error,setError]=useState(''), [message,setMessage]=useState('');
  const [query,setQuery]=useState(params.get('q') ?? ''), [back,setBack]=useState(false), [grant,setGrant]=useState(false);
  const [workName,setWorkName]=useState(''),[desc,setDesc]=useState(''),[report,setReport]=useState(false),[reason,setReason]=useState('');
  const [publication,setPublication]=useState<PublicationState|null>();
  const [coverFace,setCoverFace]=useState<'front'|'back'>('front');
  const [confirm,setConfirm]=useState<'withdraw'|'remove'|'withdraw-remove'>();
  const [trim,setTrim]=useState(false),[fonts,setFonts]=useState<'keep'|'replace'|'outline'>('keep');
  const [replacements,setReplacements]=useState<Record<string,string>>({});
  const [resources,setResources]=useState<CommunityResource[]>([]);
  const [correctedCovers,setCorrectedCovers]=useState<Awaited<ReturnType<typeof cardCovers>>>();
  const [publishCategory,setPublishCategory]=useState<(typeof PUBLISHABLE_COMMUNITY_CATEGORIES)[number]>('card');
  const live=useRef(true), lock=useRef(false), returnToCopy=useRef(false), changingWorkspace=useRef(false);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{
    const workspaceChanged=()=>{
      if(changingWorkspace.current) return;
      setAccount(null);
      setWork(undefined);
      setAsset(undefined);
      setList([]);
      setResources([]);
      setCorrectedCovers(undefined);
      setPublication(undefined);
      setCoverFace('front');
      setBack(false);setWorkName('');setDesc('');setReason('');
      setTrim(false);setFonts('keep');setPublishCategory('card');
      setAuth(false);returnToCopy.current=false;setGrant(false);setReplacements({});
      setMessage('');setConfirm(undefined);setReport(false);
      setLoading(true);
      setReload(n=>n+1);
    };
    window.addEventListener('prism-workspace-changed',workspaceChanged);
    return ()=>window.removeEventListener('prism-workspace-changed',workspaceChanged);
  },[]);
  useEffect(()=>{
    let active=true;
    async function read() {
      setError('');setLoading(true);
      try{
        const u=await request<Account|null>('session');
        if (!active) return;
        setAccount(u);
        if (publish) {
          if(!u)return;
          if (!id || !Number.isInteger(Number(ver))) throw Error('未找到待发布的资产版本');
          const [saved,publicInfo]=await Promise.all([
            readCardAsset(id,Number(ver)),
            request<Work|null>('publication/'+encodeURIComponent(id)+'?includeInactive=1'),
          ]);
          if (active) {
            setAsset(saved);setPublication(publicInfo);setWorkName(current=>current||publicInfo?.name||saved.name);
            if(publicInfo){setCoverFace(!saved.card.singleSided&&publicInfo.coverFace==='back'?'back':'front');setDesc(current=>current||publicInfo.description);setPublishCategory(current=>current==='card'&&
              (publicInfo.category==='process'||publicInfo.category==='other')?publicInfo.category:current);}
          }
        } else if (isLibrary && !u) {
          setList([]); setWork(undefined);
        } else if (wid) {
          const value=await request<Work>(isLibrary?'holding/'+wid+'/'+ver:'work/'+wid);
          if(!active) return;
          setWork(value);
          const resume=!isLibrary&&u&&pendingCopy();
          if(resume&&resume.id===value.id&&!returnToCopy.current){
            clearPendingCopy();
            setMessage(value.state==='public'&&value.edition===resume.edition?'已登录，可以继续复制此版本。':'作品已更新或撤回，请查看当前版本。');
          }
          if(value.held) {
            const items=await request<CommunityResource[]>('resources/'+value.id+'/'+value.edition);
            if(!active) return;
            setResources(items);
            if(value.resourcesRestricted) {
              const previews=await cardCovers(await holdingCard(value));
              if(active) setCorrectedCovers(previews);
            }
          }
        } else {
          const values=await request<Work[]>(isLibrary?'library':'works');
          if(active) setList(values);
        }
      } catch(e){if(active)setError((e as Error).message);}
      finally{if(active)setLoading(false);}
    }
    void read();return()=>{active=false;};
  },[publish,id,ver,wid,isLibrary,reload]);
  async function action(run:(scope:AbortSignal)=>Promise<void>) {
    if(lock.current) return;
    const guard=workspaceSignal();
    lock.current=true;setBusy(true);setError('');setMessage('');
    try{await run(guard);}catch(e){if(live.current&&!guard.aborted)setError((e as Error).message);}
    finally{lock.current=false;if(live.current)setBusy(false);}
  }
  async function copy(w:Work) {
    await request('copy',{work:w.id,edition:w.edition});
    clearPendingCopy();
    if (live.current) location.hash=entry(w);
  }
  const inspected=asset && inspectCard(asset.card);
  const blocked=Boolean(asset?.card.communityOrigin || inspected?.restricted.length || publication?.state==='blocked');
  const unsavedPreparation=trim||fonts!=='keep'||Object.keys(replacements).length>0;
  const switchWorkspace=(scope:string)=>{
    changingWorkspace.current=true;
    try { changeWorkspace(scope); }
    finally { changingWorkspace.current=false; }
  };
  const accountDone=(u:Account)=>{
    setAuth(false);setAccount(u);switchWorkspace(u.id);
    if(returnToCopy.current && work) {
      returnToCopy.current=false;
      void action(async()=>{const current=await request<Work>('work/'+work.id);if(current.edition!==work.edition||current.state!=='public'){setWork(current);throw Error('作品已更新或撤回，请查看当前版本');}await copy(current);});
    } else setReload(n=>n+1);
  };
  const refresh=()=>setReload(n=>n+1);
  async function openMyAsset(value: Work, remove=false) {
    const scope=workspaceSignal();
    if (value.ownedAsset) {
      const original=await readCardAsset(value.ownedAsset,value.assetVersion??value.edition).catch(()=>undefined);
      if (!live.current||scope.aborted) return;
      if (original) {
        const target=new URLSearchParams({asset:original.assetId,v:String(original.version)});
        if(remove) target.set('remove','1');
        location.hash='/assets?'+target;
        return;
      }
    }
    if (live.current&&!scope.aborted) {
      if(remove) setConfirm('withdraw-remove');
      else location.hash=entry(value);
    }
  }
  const heading=publish?'发布到社区':isLibrary?'我的资产':category?COMMUNITY_CATEGORIES[category]:'社区';
  const searchTerm=query.trim().toLocaleLowerCase();
  const cards=list.filter(w=>(w.name+' '+w.author).toLocaleLowerCase().includes(searchTerm));
  const updateGallerySearch=(value:string)=>{
    setQuery(value);
    history.replaceState(history.state,'',galleryHref(category,value));
  };
  const showAccountActions=!isGallery || (!category && !loading && list.length===0);
  return <section className="community-page">
    <div className={'cm-shell'+(isGallery?' workbench-page-content':'')}>
      <header className={'community-heading cm-top'+(isGallery?' cm-top-browse':'')} data-workbench-motion><h1 tabIndex={-1} data-workbench-title>{heading}</h1>
        {showAccountActions && <div className="cm-actions">{!isLibrary && <a className="cm-btn" href="#/assets">{isGallery?<img src={icons+'account-assets.svg'} alt="" width={15} height={15}/>:<Layers size={15}/>}我的资产</a>}
        {isLibrary && <a className="cm-btn" href={root}><Globe size={15}/>社区</a>}
          {account ? <button className="cm-btn" title="退出当前账号" onClick={()=>void action(async()=>{
            await request('logout',{});
            clearPendingCopy();
            changeWorkspace('guest');
            if(publish||isLibrary)location.hash='/assets';
          })}>{accountName(account)} · 退出</button> :
          <button className="cm-btn" onClick={()=>setAuth(true)}>登录</button>}</div>}
      </header>
      {(wid||publish||category) && <a className="cm-back" data-workbench-motion href={publish||isLibrary?'#/assets':galleryHref(previousCategory,query)}>
        <ArrowLeft size={15}/>{publish?'我的资产':isLibrary?heading:previousCategory?COMMUNITY_CATEGORIES[previousCategory]:'社区'}
      </a>}
      {error && <div role="alert" className="cm-error">{error} <button className="cm-link" onClick={refresh}>刷新</button></div>}
      {message && <p role="status">{message}</p>}
      {loading && !isGallery ? <p className="cm-muted" data-workbench-motion>正在读取…</p> : publish && asset && inspected ?
        <div className="cm-detail" data-workbench-motion>
          <Faces name={asset.name} front={asset.cover} back={asset.backCover} flipped={back} onFlip={setBack}/>
          <div className="cm-panel"><h2>{asset.name}</h2><p className="cm-muted">{asset.card.widthMm} × {asset.card.heightMm} mm · v{asset.version}</p>
            <h3>可复制的内容</h3><p>{inspected.layers} 个图层 · {inspected.images} 张图片 · {inspected.masks} 个区域 · {inspected.processes} 个工艺层</p>
            {!!inspected.fonts.length && <p>字体　{inspected.fonts.join('、')}</p>}
            {!!inspected.cropped.length && <p>含完整裁切原图　{inspected.cropped.join('、')}</p>}
            {!!inspected.hidden.length && <p>含隐藏依赖　{inspected.hidden.join('、')}</p>}
            {!!inspected.outside.length && <p>含画板外依赖　{inspected.outside.join('、')}</p>}
            {asset.card.communityOrigin && <p className="cm-error">来自社区的卡仅可另存私有改版。</p>}
            {!!inspected.images && <>
              <details className="cm-materials">
                <summary>替换图片</summary>
                {publicCardImages(asset.card).map(({key,label,target})=><div className="cm-material" key={key}>
                  <img src={replacements[key]??target.src} alt="" width={38} height={38}/>
                  <span title={label}>{label}{replacements[key]?' · 已替换':''}</span>
                  <label className="cm-btn" aria-disabled={busy}>选择图片<input type="file" accept={acceptedImages}
                    aria-label={'替换'+label} disabled={busy} onChange={e=>{
                      const file=e.currentTarget.files?.[0];
                      e.currentTarget.value='';
                      if(file) void action(async scope=>{
                        const source=await publicReplacementImage(file);
                        if(live.current&&!scope.aborted){setReplacements(current=>({...current,[key]:source}));setGrant(false);}
                      });
                    }}/></label>
                  {replacements[key]&&<button type="button" className="cm-link" disabled={busy}
                    onClick={()=>setReplacements(current=>{
                      const next={...current};
                      delete next[key];
                      return next;
                    })}>还原</button>}
                </div>)}
              </details>
              <label className="cm-check"><input type="checkbox" checked={trim} onChange={e=>{setTrim(e.target.checked);setGrant(false);}}/>仅携带图框内的图片像素</label>
            </>}
            {!!inspected.restricted.length && <label>外部字体 · {inspected.restricted.join('、')}
              <select value={fonts} onChange={e=>{setFonts(e.target.value as typeof fonts);setGrant(false);}}>
                <option value="keep">选择处理方式</option>
                <option value="replace">替换为思源黑体</option>
                <option value="outline">转曲（文字将无法继续输入编辑）</option>
              </select>
            </label>}
            {unsavedPreparation && <button className="cm-btn" disabled={busy} onClick={()=>void action(async scope=>{
              const prepared=await preparePublicVersion(asset,trim,fonts,replacements);
              if(live.current&&!scope.aborted){setAsset(prepared);setGrant(false);setTrim(false);setFonts('keep');setReplacements({});history.replaceState(null,'',root+'/publish/'+prepared.assetId+'/'+prepared.version);setMessage('已保存发布用版本，请核对卡面');}
            })}>保存并预览发布用版本</button>}
            {publication?.state==='blocked'&&<p className="cm-error" role="status">该作品已下架，请处理后再发布。</p>}
            <label>作品名称<input required value={workName} maxLength={500} onChange={e=>setWorkName(e.target.value)}/></label>
            {!asset.card.singleSided&&<label>封面<select value={coverFace} onChange={e=>setCoverFace(e.target.value==='back'?'back':'front')}>
              <option value="front">正面</option><option value="back">背面</option>
            </select></label>}
            <label>作品分类<select value={publishCategory} onChange={e=>{
              const next=PUBLISHABLE_COMMUNITY_CATEGORIES.find(category=>category===e.target.value);
              if(next) setPublishCategory(next);
            }}>{PUBLISHABLE_COMMUNITY_CATEGORIES.map(category=><option key={category} value={category}>{COMMUNITY_CATEGORIES[category]}</option>)}</select></label>
            <label>作品说明<textarea value={desc} maxLength={600} onChange={e=>setDesc(e.target.value)}/></label>
            <label className="cm-check"><input type="checkbox" checked={grant} onChange={e=>setGrant(e.target.checked)}/>我有权分享以上内容，允许其他人复制、编辑并用于个人项目</label>
            <button className="cm-btn primary" disabled={blocked||busy||!grant||unsavedPreparation||!workName.trim()||publication===undefined} onClick={()=>{
              if(!account){setAuth(true);return;}
              void action(async()=>{
                const result=await request<{id:string}>('publish',{asset:asset.assetId,assetVersion:asset.version,expectedEdition:publication?.edition??0,
                  republish:publication?.state==='withdrawn',name:workName.trim(),description:desc,category:publishCategory,grant,
                  coverFace:asset.card.singleSided?'front':coverFace});
                const workId=result.id;
                if(live.current)location.hash=root+'/'+workId;
              });
            }}>{busy?'正在发布…':publication?.state==='public'?'发布新版':publication?.state==='withdrawn'?'重新发布':'发布到社区'}</button>
          </div>
        </div> : publish&&!account&&!error?<div className="cm-empty"><h2>登录后发布资产</h2><button className="cm-btn primary" onClick={()=>setAuth(true)}>登录</button></div>:work ?
        <div className="cm-detail" data-workbench-motion>
          {work.resourcesRestricted && !correctedCovers ? <div className="cm-faces cm-muted">原版预览因素材限制不可用</div> :
            <Faces name={work.name} front={correctedCovers?.cover??imageUrl(work,'front')}
              back={work.single?undefined:correctedCovers?.backCover??imageUrl(work,'back')} flipped={back} onFlip={setBack}/>}
          <div className="cm-panel"><h2>{work.name}</h2><p className="cm-muted">{work.author} · v{work.edition} · {work.width} × {work.height} mm · {work.single?'单面':'双面'}</p>
            {work.description && <p>{work.description}</p>}
            <h3>复用权限</h3><p>可复制到我的资产，编辑并用于个人项目。</p>
            {work.state!=='public' && <p className="cm-muted">{work.state==='withdrawn'?'作者已撤回公开版本':'公开作品已下架'}</p>}
            {work.resourcesRestricted && <section className="cm-materials" aria-label="受限素材">
              <h3>受限素材</h3>
              <p>{work.resourcesPending ? '已隐藏受限图片。替换仅用于这份资产，已有项目保留原稿。' : '此资产的受限图片已全部替换。'}</p>
              {work.held && resources.filter(item=>item.reason).map(item=><div className="cm-material cm-restricted" key={item.id}>
                <div><strong>{item.labels.join('、')}</strong>{!item.replaced&&<p className="cm-muted">{item.reason}</p>}</div>
                <label className="cm-btn" aria-disabled={busy}>{item.replaced?'重新替换':'替换图片'}
                  <input type="file" accept={acceptedImages} aria-label={'替换'+item.labels[0]} disabled={busy} onChange={e=>{
                    const file=e.currentTarget.files?.[0];
                    e.currentTarget.value='';
                    if(file) void action(async scope=>{
                      const source=await publicReplacementImage(file);
                      scope.throwIfAborted();
                      await request('replace-resource',{work:work.id,edition:work.edition,resource:item.id,source});
                      if(live.current){refresh();setMessage('已替换素材');}
                    });
                  }}/></label>
              </div>)}
            </section>}
            <div className="cm-actions">
            {isLibrary ? <button className="cm-btn primary" disabled={busy} onClick={()=>void action(async()=>{
              const card=await holdingCard(work);
              if(live.current)onUseCard(card);
            })}>使用<ArrowRight size={14}/></button> :
            <button className="cm-btn primary" disabled={busy} onClick={()=>{
              if(!account){returnToCopy.current=true;pendingCopy(work);setAuth(true);}
              else if(work.held||work.mine)void action(()=>openMyAsset(work));
              else void action(()=>copy(work));
            }}>{work.held||work.mine?'在我的资产中查看':'复制到我的资产'}</button>}
            {isLibrary&&work.held&&<button className="cm-btn" disabled={busy||!!work.resourcesPending} onClick={()=>void action(async()=>{
              await downloadAssetPackage({kind:'received',work:work.id,edition:work.edition},work.name);
              setMessage('资产包已准备完成');
            })}>下载资产</button>}
            {isLibrary && work.state==='public' && work.edition!==work.currentEdition && <a className="cm-btn" href={root+'/'+work.id}>查看新版</a>}
            {work.state==='public' && !work.resourcesRestricted && <button className="cm-btn" onClick={()=>void action(async()=>{await navigator.clipboard.writeText(location.href.split('#')[0]+root+'/'+work.id);setMessage('已复制作品链接');})}>复制链接</button>}
            {work.mine && work.state==='public' && work.edition===work.currentEdition && <button className="cm-link" onClick={()=>setConfirm('withdraw')}>撤回发布</button>}
            {isLibrary && <button className="cm-link" disabled={busy} onClick={()=>{
              if(work.mine&&work.state==='public'&&work.currentEdition===work.edition) void action(()=>openMyAsset(work,true));
              else setConfirm('remove');
            }}>移出我的资产</button>}
            {!work.mine && (work.state==='public'||work.held) && <button className="cm-link" onClick={()=>account?setReport(true):setAuth(true)}>举报</button>}</div>
            {confirm && <div className="cm-confirm"><p>{confirm==='withdraw'?'撤回后将停止新复制，已有副本仍可使用。':
              confirm==='withdraw-remove'?'同时撤回公开作品并移除账号资产。已有副本和项目会保留。':'移除账号资产后，已加入项目的卡会保留。'}</p>
              <button className="cm-btn" onClick={()=>setConfirm(undefined)}>取消</button> <button disabled={busy} className="cm-btn primary" onClick={()=>void action(async()=>{await request(confirm,{work:work.id,edition:work.edition});location.hash=isLibrary?'#/assets':root;})}>
                {confirm==='withdraw'?'确认撤回':confirm==='withdraw-remove'?'撤回并移除':'确认移除'}</button></div>}
            {report && <form onSubmit={e=>{
              e.preventDefault();
              const resource=new FormData(e.currentTarget).get('resource');
              void action(async()=>{await request('report',{work:work.id,edition:work.edition,reason,resource});setReport(false);setMessage('举报已提交');});
            }}>
              {!!resources.length && <label>举报对象<select name="resource"><option value="">整个作品</option>{resources.map(item=><option key={item.id} value={item.id}>{item.labels.join('、')}</option>)}</select></label>}
              <label>举报原因<textarea required maxLength={600} value={reason} onChange={e=>setReason(e.target.value)}/></label>
              <div className="cm-actions"><button type="button" className="cm-btn" disabled={busy} onClick={()=>setReport(false)}>取消</button><button className="cm-btn" disabled={busy}>提交举报</button></div>
            </form>}
          </div>
        </div> : !error && isGallery ?
          <CommunityGallery cards={cards} category={category} query={query} loading={loading} hasPublicWorks={list.length>0}
            onQueryChange={updateGallerySearch}/> : !error && isLibrary && (!wid || !account) && <>
          {!account ? <div className="cm-empty"><BookOpen/><h2>登录查看账号资产</h2><button className="cm-btn primary" onClick={()=>setAuth(true)}>登录</button></div> :
            <><label className="cm-search"><Search size={15}/><input aria-label="搜索卡名或作者" value={query} placeholder="搜索卡名或作者" onChange={e=>setQuery(e.target.value)}/></label>
            {cards.length ? <div className="cm-grid">{cards.map(w=><a key={w.id+'-'+w.edition} href={entry(w)} className="cm-tile">
              <span className="cm-art">{w.resourcesRestricted ? <Layers size={24} aria-hidden/> : <img src={imageUrl(w,'front')} alt="" loading="lazy"/>}</span>
              <strong>{w.name}</strong><small>{w.author} · v{w.edition}{w.resourcesPending?' · 素材待替换':''}</small>
            </a>)}</div> : <div className="cm-empty"><Layers/><h2>{query?'未找到匹配的卡牌':'还没有账号资产'}</h2>
              {!query && <a className="cm-btn" href={root}>浏览社区<ArrowRight size={14}/></a>}</div>}</>}
        </>}
    </div>
    {auth && <AccountForm onDone={accountDone} onMailLink={()=>{returnToCopy.current=false;setAuth(false);}}
      onClose={()=>{clearPendingCopy();returnToCopy.current=false;setAuth(false);}}/>}
  </section>;
}

function CommunityGallery({cards,category,query,loading,hasPublicWorks,onQueryChange}:{
  cards:Work[];
  category?:CommunityCategory;
  query:string;
  loading:boolean;
  hasPublicWorks:boolean;
  onQueryChange:(value:string)=>void;
}) {
  const searchInput=useRef<HTMLInputElement>(null);
  const searching=Boolean(query.trim());
  const clearSearch=()=>{
    onQueryChange('');
    searchInput.current?.focus();
  };
  const categoryCards=category?cards.filter(work=>(work.category??'card')===category):cards;
  const sections=!category && !searching && hasPublicWorks;
  const grid=(works: Work[]) => <div className="cm-grid cm-gallery-grid">
    {works.map(work=><a key={work.id+'-'+work.edition} href={publicWorkHref(work,category,query)} className="cm-tile">
      <span className="cm-art"><img src={imageUrl(work,work.coverFace??'front')} alt="" loading="lazy"/></span>
      <strong title={work.name}>{work.name}</strong>
      <small>{work.width} × {work.height} mm · {work.category && work.category!=='card'?COMMUNITY_CATEGORIES[work.category]:'单卡'}</small>
    </a>)}
  </div>;
  return <div className={'cm-gallery'+(sections?' cm-gallery-sections':'')}>
    <div className="cm-search cm-gallery-search" role="search" data-workbench-motion>
      <img src={icons+'search.svg'} alt="" width={15} height={15}/>
      <input ref={searchInput} type="search" aria-label="搜索卡名或作者" value={query} placeholder="搜索卡名或作者" onChange={e=>onQueryChange(e.target.value)}/>
      {query && <button type="button" className="cm-icon" aria-label="清空搜索" onClick={clearSearch}><X size={13}/></button>}
    </div>
    <div className={sections?'cm-gallery-sections':undefined} data-workbench-motion>
      {loading ? <p className="cm-muted" role="status">正在读取…</p> : sections ? categories.map(key=>{
        const works=cards.filter(work=>(work.category??'card')===key);
        const label=COMMUNITY_CATEGORIES[key];
        return <section className="cm-category" key={key} aria-label={label}>
          <h2 className="cm-category-title"><a href={galleryHref(key)}>{label}
            <span className="cm-category-arrow"><img src={icons+'category-chevron.svg'} alt="" width={9} height={5}/></span>
          </a></h2>
          {works.length>0 && grid(works.slice(0,visibleWorksPerRow))}
        </section>;
      }) : categoryCards.length>0 ? grid(categoryCards) :
        <div className="cm-empty cm-gallery-empty">
          <img src={icons+'empty.svg'} alt="" width={24} height={24}/>
          <h2>{searching?'未找到匹配的卡牌':category?'这个分类还没有作品':'还没有公开作品'}</h2>
          {searching ? <button className="cm-btn" onClick={clearSearch}>清空搜索</button> :
            !category && <a className="cm-btn" href="#/assets">前往我的资产<img src={icons+'arrow.svg'} alt="" width={14} height={14}/></a>}
        </div>}
    </div>
  </div>;
}

function Faces({name,front,back,flipped,onFlip}:{name:string;front:string;back?:string;flipped:boolean;onFlip:(v:boolean)=>void}) {
  const zoom = useRef<HTMLDialogElement>(null);
  const side = flipped && back ? '背面' : '正面';
  const src = flipped && back ? back : front;
  const switchSide = back && <div className="cm-segments">{[false,true].map(v=>
    <button key={String(v)} aria-pressed={flipped===v} onClick={()=>onFlip(v)}>
      {flipped===v && <Check size={12}/ >}{v?'背面':'正面'}
    </button>)}</div>;
  return <div className="cm-faces">
    <button className="cm-zoom-trigger" aria-label={'放大'+side} onClick={()=>zoom.current?.showModal()}>
      <img src={src} alt={name+side}/>
    </button>
    {switchSide}
    <dialog ref={zoom} className="cm-lightbox" aria-label={name+'大图'} onClick={e=>{if(e.target===e.currentTarget)zoom.current?.close();}}>
      <button className="cm-lightbox-close cm-btn" aria-label="关闭大图" onClick={()=>zoom.current?.close()}><X size={18}/></button>
      <img src={src} alt={name+side+'大图'}/>{switchSide}
    </dialog>
  </div>;
}
