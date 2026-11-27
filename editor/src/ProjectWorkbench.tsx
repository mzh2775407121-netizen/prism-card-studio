import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Archive01Icon, Copy01Icon, Download01Icon } from '@hugeicons/core-free-icons';
import { projectWorkspace, readProject, workspaceHeaders, type ProjectSummary } from './projects';
import { WORKBENCH_PREVIEW_VERSION, workbenchFrontCovers, workbenchOverview } from './workbenchPreview';
import WorkbenchComposer from './WorkbenchComposer';
import WorkbenchAccount from './WorkbenchAccount';
import CommunityWorkbench from './CommunityWorkbench';
import { AssetBrowser, UseAssetDialog } from './CardAssetDialogs';
import type {ProjectCard} from './model';
import { LayerContextMenu, type MenuPoint } from './LayerContextMenu';
import { useWorkbenchNavigation } from './useWorkbenchNavigation';

const assets = '/assets/workbench/';
type PreviewKind = 'overview' | 'fronts';
type PreviewImages = (string | null)[];
const previews = new Map<string, Promise<PreviewImages>>();
const pendingProjects = new Map<string, ReturnType<typeof readProject>>();
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });
const relativeFormat = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

function projectDate(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return relativeFormat.format(-minutes, 'minute');
  if (minutes < 24 * 60) return relativeFormat.format(-Math.floor(minutes / 60), 'hour');
  if (minutes < 7 * 24 * 60) return relativeFormat.format(-Math.floor(minutes / 1440), 'day');
  return dateFormat.format(timestamp);
}

function projectDetails(item: ProjectSummary) {
  const count = item.cardCount ?? 1;
  return count > 1 ? `套卡 · ${count} 张` : `${item.widthMm} × ${item.heightMm} mm`;
}

function loadPreview(id: string, revision: number, scope: string, kind: PreviewKind) {
  const documentKey = JSON.stringify([scope, id, revision]);
  const key = `v${WORKBENCH_PREVIEW_VERSION}:${kind}:${documentKey}`;
  const cached = previews.get(key);
  if (cached) return cached;

  let record = pendingProjects.get(documentKey);
  if (!record) {
    const pending = readProject(id).finally(() => {
      if(pendingProjects.get(documentKey)===pending)pendingProjects.delete(documentKey);
    });
    record = pending;
    pendingProjects.set(documentKey, record);
  }
  const request = record.then(async saved => {
    const images = kind === 'overview' ? [await workbenchOverview(saved.project)] : await workbenchFrontCovers(saved.project);
    if ((saved.revision !== revision || images.includes(null)) && previews.get(key) === request) previews.delete(key);
    return images;
  }).catch(error => {
    if (previews.get(key) === request) previews.delete(key);
    throw error;
  });
  if (previews.size >= 64) {
    const oldest = previews.keys().next().value;
    if (oldest) previews.delete(oldest);
  }
  previews.set(key, request);
  return request;
}

function useProjectPreview({id, revision}: ProjectSummary, kind: PreviewKind) {
  const region = useRef<HTMLSpanElement>(null);
  const [images, setImages] = useState<PreviewImages>([]);
  const scope = workspaceHeaders()['X-Prism-Workspace'] ?? '';
  useEffect(() => {
    let active = true;
    setImages([]);
    const observe = new IntersectionObserver(([entry], observer) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      loadPreview(id, revision, scope, kind).then(result => { if (active) setImages(result); }).catch(() => {});
    }, { rootMargin: '100px' });
    if (region.current) observe.observe(region.current);
    return () => { active = false; observe.disconnect(); };
  }, [id, revision, scope, kind]);
  return {region, images};
}

function ProjectCover({ item }: { item: ProjectSummary }) {
  const {region, images: [preview]} = useProjectPreview(item, 'overview');
  return <span ref={region} className="workbench-cover" aria-hidden="true">
    {preview ? <img src={preview} alt="" /> : <span className="workbench-card-placeholder" />}
  </span>;
}

function ProjectListArt({ item }: { item: ProjectSummary }) {
  const {region, images} = useProjectPreview(item, 'fronts');
  return <span ref={region} className={images.length > 1 ? 'workbench-project-art is-stacked' : 'workbench-project-art'} aria-hidden="true">
    {(images.length ? images : [null]).map((src, index) => src
      ? <img key={index} src={src} alt="" draggable={false} />
      : <span key={index} className="workbench-front-placeholder" />)}
  </span>;
}

type WorkbenchProps = {
  items: ProjectSummary[];
  recent: ProjectSummary[];
  archived: boolean;
  ready: boolean;
  offline: boolean;
  busy: boolean;
  workspace: string;
  message: string;
  error: boolean;
  onSetArchived: (archived: boolean) => void;
  requireAccount: (action?: () => void) => void;
  onRefresh: () => void;
  onImport: () => void;
  onCreate: () => void;
  onOpen: (item: ProjectSummary) => void;
  onArchive: (item: ProjectSummary) => void;
  onRestore: (item: ProjectSummary) => void;
  onDuplicate: (item: ProjectSummary) => void;
  onExport: (item: ProjectSummary) => void;
};

type ProjectMenu = {
  item: ProjectSummary;
  area: 'recent' | 'library';
  trigger: HTMLButtonElement;
  screen: MenuPoint;
};

export default function ProjectWorkbench(p: WorkbenchProps) {
  const [menu, setMenu] = useState<ProjectMenu>();
  const [assetToUse, setAssetToUse] = useState<ProjectCard>();
  const closePageOverlays = useCallback(() => { setMenu(undefined); setAssetToUse(undefined); }, []);
  useEffect(()=>{
    const clear=()=>{previews.clear();pendingProjects.clear();closePageOverlays();};
    window.addEventListener('prism-workspace-changed',clear);
    return()=>window.removeEventListener('prism-workspace-changed',clear);
  },[closePageOverlays]);
  const { route, page, activePage, content, showHome, toggleArchive } = useWorkbenchNavigation(p.archived, p.onSetArchived, closePageOverlays);
  const [chatOpen, setChatOpen] = useState(true);
  const [developmentNotice, setDevelopmentNotice] = useState<{ text: string }>();
  const available = p.ready && !p.busy;
  const signedIn = projectWorkspace(p.workspace);
  const emptyMessage = p.archived ? '暂无已归档项目' : signedIn ? '暂无项目' : '登录后查看你的项目';
  const offlineMessage = '无法连接 Prism 服务，请重试。';
  const listPlaceholder = p.ready ? emptyMessage : p.offline ? offlineMessage : '正在读取项目…';
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const menuOpen = Boolean(menu && available && !p.archived);
  const developing = (label: string) => setDevelopmentNotice({ text: label + '正在开发' });
  useEffect(() => {
    if (!developmentNotice) return;
    const timer = window.setTimeout(() => setDevelopmentNotice(undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [developmentNotice]);
  useEffect(() => {
    if (!menuOpen) return;
    window.addEventListener('scroll', closeMenu, true);
    return () => window.removeEventListener('scroll', closeMenu, true);
  }, [closeMenu, menuOpen]);
  const menuTrigger = (item: ProjectSummary, area: ProjectMenu['area']) => ({
    'aria-haspopup': 'menu' as const,
    'aria-expanded': menuOpen && menu?.item.id === item.id && menu.area === area,
    onContextMenu: (event: MouseEvent<HTMLButtonElement>) => {
      if (!available) return;
      event.preventDefault();
      setMenu({ item, area, trigger:event.currentTarget, screen:{x:event.clientX,y:event.clientY} });
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!available || !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const trigger = event.currentTarget;
      const { left, bottom } = trigger.getBoundingClientRect();
      setMenu({ item, area, trigger, screen:{x:left,y:bottom} });
    },
  });
  return <>
    <aside className="workbench-sidebar">
      <div className="workbench-brand"><img src={assets + 'prism-mark.svg'} alt="" /><strong>Prism</strong></div>
      <nav aria-label="工作台导航">
        <button aria-current={activePage==='home'?'page':undefined} onClick={()=>showHome(false)}>
          <img src={assets + 'workbench.svg'} alt="" />工作台
        </button>
        {([['资产', 'library.svg'], ['AI工具', 'ai-tools.svg'], ['社区', 'community.svg']] as const).map(([label, icon]) =>
          <button key={label} aria-current={(activePage==='assets'&&label==='资产'||activePage==='community'&&label==='社区')?'page':undefined}
            onClick={() => { if(label==='资产')location.hash='/assets';else if(label==='社区')location.hash='/community';else p.requireAccount(()=>developing(label)); }}>
            <img src={assets + icon} alt="" />{label}</button>)}
      </nav>
      <div className="workbench-chats">
        <button className="workbench-chat-heading" aria-expanded={signedIn&&chatOpen} onClick={() => p.requireAccount(()=>setChatOpen(value=>!value))}>
          对话<img src={assets + 'chat-chevron.svg'} alt="" />
        </button>
        {signedIn && chatOpen && ['默认对话', '帮我创建', '帮我创建一张宝可梦卡牌'].map(label =>
          <button key={label} className="workbench-chat" onClick={() => developing('对话')}>{label}</button>)}
      </div>
    </aside>
    <main className="workbench-main">
      <header className="workbench-toolbar" aria-label="工作台顶部操作">
        <button type="button" className="workbench-tool workbench-import" disabled={!available} onClick={p.onImport}>
          <img src={assets + 'import.svg'} width={16} height={16} alt="" />导入
        </button>
        {signedIn ?
          <WorkbenchAccount workspace={p.workspace} archived={p.archived} archiveAvailable={available}
            requireAccount={p.requireAccount} onNotice={text=>setDevelopmentNotice({text})}
            onArchive={()=>p.requireAccount(toggleArchive)}/> :
          <button type="button" className="workbench-tool workbench-sign-in" onClick={()=>p.requireAccount()}>登录/注册</button>}
      </header>
      <div ref={content} className={'workbench-route-content'+(page==='home'&&p.archived?' workbench-page-content':'')}>
      {page==='assets' && !route.startsWith('#/community/library/') ? <AssetBrowser path={route} onUse={setAssetToUse}/> : page==='community'||page==='assets'
        ? <CommunityWorkbench path={route} onUseCard={setAssetToUse}/> : <>
      <div className="workbench-intro" hidden={p.archived}>
        <h1 tabIndex={-1} data-workbench-motion data-workbench-title={p.archived?undefined:''}>你好，今天想要创作什么？</h1>
        <WorkbenchComposer requireAccount={p.requireAccount}/>
      </div>
      {p.message && <div className={`library-message ${p.error ? 'library-error' : ''}`} role={p.error ? 'alert' : 'status'} data-workbench-motion>
        <span>{p.message}</span>{p.offline && <button className="workbench-tool" onClick={p.onRefresh}>重试</button>}
      </div>}
      {!p.archived && <section className="workbench-section" aria-labelledby="workbench-recent" data-workbench-motion>
        <h2 id="workbench-recent">最近项目</h2>
        <div className="workbench-recent-grid">
          <button className="workbench-create" disabled={!available} onClick={p.onCreate}>
            <span className="workbench-create-icon" aria-hidden="true">
              <img src={assets + 'create.svg'} alt="" />
              <img className="workbench-create-mark" src={assets + 'create-hover.svg'} alt="" />
            </span>
            新建项目
          </button>
          {p.recent.map(item => <button className="workbench-recent" key={item.id + ':' + item.revision} disabled={!available}
            onClick={() => p.onOpen(item)} {...menuTrigger(item, 'recent')}>
            <ProjectCover item={item} />
            <span className="workbench-recent-meta">
              <strong>{item.name}</strong>
              <small className="workbench-recent-detail">
                {item.cardCount > 1 ? '套卡' : '单卡'} · <time dateTime={new Date(item.updatedAt).toISOString()}>{projectDate(item.updatedAt)}</time>
              </small>
            </span>
          </button>)}
        </div>
      </section>}
      <section className="workbench-section" aria-labelledby="workbench-projects" data-workbench-motion={p.archived?undefined:''}>
        <h2 id="workbench-projects" tabIndex={p.archived?-1:undefined} data-workbench-title={p.archived?'':undefined}
          data-workbench-motion={p.archived?'':undefined}>
          {p.archived ? '已归档' : '全部项目'}
        </h2>
        {p.items.length ? <ul className="workbench-project-grid" data-workbench-motion={p.archived?'':undefined}>
            {p.items.map(item => <li key={item.id} className="workbench-project">
              <button className="workbench-open" title={item.name} aria-label={(p.archived ? '归档项目 ' : '打开 ') + item.name} disabled={!available || p.archived}
                onClick={() => p.onOpen(item)} {...(!p.archived && menuTrigger(item, 'library'))}>
                <ProjectListArt item={item} />
                <span className="workbench-project-meta"><strong>{item.name}</strong><small>{projectDetails(item)}</small>
                  <time dateTime={new Date(item.updatedAt).toISOString()}>{projectDate(item.updatedAt)}</time>
                </span>
              </button>
              {p.archived && <button className="workbench-restore" disabled={!available} onClick={() => p.onRestore(item)}>恢复</button>}
            </li>)}
          </ul> : <p className="workbench-empty" role="status" data-workbench-motion={p.archived?'':undefined}>{listPlaceholder}</p>}
      </section>
      </>}
      </div>
      {assetToUse&&<UseAssetDialog card={assetToUse} onClose={()=>setAssetToUse(undefined)} onOpen={record=>{setAssetToUse(undefined);p.onOpen(record)}}/>}
      <div className={`workbench-feedback ${developmentNotice ? 'visible' : ''}`} role="status" aria-live="polite">{developmentNotice?.text}</div>
    </main>
    {menuOpen && menu && <LayerContextMenu screen={menu.screen} label={menu.item.name+'的项目操作'} close={closeMenu}
      onKeyboardClose={() => menu.trigger.focus({preventScroll:true})}
      commands={[
        {label:'复制',icon:<HugeiconsIcon icon={Copy01Icon} size={16} aria-hidden="true"/>,enabled:true,run:() => p.onDuplicate(menu.item)},
        {label:'导出项目包',icon:<HugeiconsIcon icon={Download01Icon} size={16} aria-hidden="true"/>,enabled:true,run:() => {
          menu.trigger.focus({preventScroll:true});p.onExport(menu.item);
        }},
        {label:'归档',icon:<HugeiconsIcon icon={Archive01Icon} size={16} aria-hidden="true"/>,enabled:true,run:() => p.onArchive(menu.item)},
      ]}/>}
  </>;
}
