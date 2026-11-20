import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Archive01Icon, Copy01Icon, Download01Icon } from '@hugeicons/core-free-icons';
import { readProject, type ProjectSummary } from './projects';
import { WORKBENCH_PREVIEW_VERSION, workbenchOverview } from './workbenchPreview';
import WorkbenchComposer from './WorkbenchComposer';
import { browserRuntime } from './runtime';
import { LayerContextMenu, type MenuPoint } from './LayerContextMenu';

const assets = '/assets/workbench/';
const previews = new Map<string, Promise<string>>();
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

function loadPreview(item: ProjectSummary) {
  const key = `v${WORKBENCH_PREVIEW_VERSION}:${item.id}:${item.revision}`;
  const cached = previews.get(key);
  if (cached) return cached;
  const request = readProject(item.id).then(async ({ project, revision }) => {
    const preview = await workbenchOverview(project);
    if (revision !== item.revision && previews.get(key) === request) previews.delete(key);
    return preview;
  }).catch(error => {
    if (previews.get(key) === request) previews.delete(key);
    throw error;
  });
  cachePreview(key, request);
  return request;
}

function cachePreview(key: string, request: Promise<string>) {
  if (previews.size >= 32) {
    const oldest = previews.keys().next().value;
    if (oldest) previews.delete(oldest);
  }
  previews.set(key, request);
}

function ProjectCover({ item }: { item: ProjectSummary }) {
  const region = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    let active = true;
    const observe = new IntersectionObserver(([entry], observer) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      loadPreview(item).then(result => { if (active) setPreview(result); }).catch(() => {});
    }, { rootMargin: '100px' });
    if (region.current) observe.observe(region.current);
    return () => { active = false; observe.disconnect(); };
  }, [item]);
  return <span ref={region} className="workbench-cover" aria-hidden="true">
    {preview ? <img src={preview} alt="" /> : <span className="workbench-card-placeholder" />}
  </span>;
}

function ProjectListArt({ stacked }: { stacked: boolean }) {
  return <span className={stacked ? 'workbench-project-art is-stacked' : 'workbench-project-art'} aria-hidden="true">
    <img src={assets + (stacked ? 'project-set.png' : 'project-single.png')} alt="" loading="lazy" />
  </span>;
}

type WorkbenchProps = {
  items: ProjectSummary[];
  recent: ProjectSummary[];
  archived: boolean;
  ready: boolean;
  offline: boolean;
  busy: boolean;
  message: string;
  error: boolean;
  onToggleArchived: () => void;
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
  const [chatOpen, setChatOpen] = useState(true);
  const [developmentNotice, setDevelopmentNotice] = useState<{ text: string }>();
  const available = p.ready && !p.busy;
  const emptyMessage = p.archived ? '暂无已归档项目' : '暂无项目';
  const offlineMessage = browserRuntime ? '无法打开浏览器项目库，请检查站点存储权限后重试。' : '启动本机 Prism 服务后重试。';
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
        <button aria-current="page" onClick={p.archived ? p.onToggleArchived : undefined}>
          <img src={assets + 'workbench.svg'} alt="" />工作台
        </button>
        {([['资产', 'library.svg'], ['AI工具', 'ai-tools.svg'], ['社区', 'community.svg']] as const).map(([label, icon]) =>
          <button key={label} onClick={() => developing(label)}><img src={assets + icon} alt="" />{label}</button>)}
      </nav>
      <div className="workbench-chats">
        <button className="workbench-chat-heading" aria-expanded={chatOpen} onClick={() => setChatOpen(value => !value)}>
          对话<img src={assets + 'chat-chevron.svg'} alt="" />
        </button>
        {chatOpen && ['默认对话', '帮我创建', '帮我创建一张宝可梦卡牌'].map(label =>
          <button key={label} className="workbench-chat" onClick={() => developing('对话')}>{label}</button>)}
      </div>
    </aside>
    <main className="workbench-main">
      <header className="workbench-toolbar">
        <div className="workbench-utilities">
          <button aria-label="切换主题" title="切换主题" onClick={() => developing('主题切换')}><img src={assets + 'theme.svg'} alt="" /></button>
          <button aria-label="切换语言" title="切换语言" onClick={() => developing('语言切换')}><img src={assets + 'language.svg'} alt="" /></button>
        </div>
        <button className="workbench-tool" aria-pressed={p.archived} disabled={!available} onClick={p.onToggleArchived}>
          <HugeiconsIcon icon={Archive01Icon} size={16} />{p.archived ? '退出归档' : '已归档'}
        </button>
        <button className="workbench-tool" disabled={!available} onClick={p.onImport}>
          <img src={assets + 'import.svg'} alt="" />导入
        </button>
        <div className="workbench-utilities workbench-account">
          <button aria-label="积分" title="积分" onClick={() => developing('积分')}><img src={assets + 'project-count.svg'} alt="" /><span>积分</span></button>
          <button aria-label="账户" title="账户" onClick={() => developing('账户')}><img src={assets + 'local-avatar.png'} alt="" className="workbench-avatar" /></button>
        </div>
      </header>
      <div className="workbench-intro">
        <h1>你好，今天想要创作什么？</h1>
        <WorkbenchComposer/>
      </div>
      {p.message && <div className={`library-message ${p.error ? 'library-error' : ''}`} role={p.error ? 'alert' : 'status'}>
        <span>{p.message}</span>{p.offline && <button className="workbench-tool" onClick={p.onRefresh}>重试</button>}
      </div>}
      {!p.archived && <section className="workbench-section" aria-labelledby="workbench-recent">
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
      <section className="workbench-section" aria-labelledby="workbench-projects">
        <h2 id="workbench-projects">{p.archived ? '已归档' : '全部项目'}</h2>
        {p.items.length ? <ul className="workbench-project-grid">
            {p.items.map(item => <li key={item.id} className="workbench-project">
              <button className="workbench-open" title={item.name} aria-label={(p.archived ? '归档项目 ' : '打开 ') + item.name} disabled={!available || p.archived}
                onClick={() => p.onOpen(item)} {...(!p.archived && menuTrigger(item, 'library'))}>
                <ProjectListArt stacked={item.cardCount > 1} />
                <span className="workbench-project-meta"><strong>{item.name}</strong><small>{projectDetails(item)}</small>
                  <time dateTime={new Date(item.updatedAt).toISOString()}>{projectDate(item.updatedAt)}</time>
                </span>
              </button>
              {p.archived && <button className="workbench-restore" disabled={!available} onClick={() => p.onRestore(item)}>恢复</button>}
            </li>)}
          </ul> : <p className="workbench-empty" role="status">{listPlaceholder}</p>}
      </section>
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
