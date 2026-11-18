import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Archive01Icon, Copy01Icon, Download01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons';
import { getCardCornerRadiusMm } from './model';
import { readProject, type ProjectSummary } from './projects';
import { renderCard } from './render';
import { WORKBENCH_PREVIEW_VERSION, workbenchOverview } from './workbenchPreview';
import WorkbenchComposer from './WorkbenchComposer';

const assets = '/assets/workbench/';
type Preview = { src: string; radius: string; overview?: string };
const previews = new Map<string, Promise<Preview>>();
const setExamples = [
  ['闪耀群星', '12 张卡'], ['深海奇遇', '16 张卡'], ['幻兽图鉴', '36 张卡'], ['时光碎片', '6 张卡'], ['天际巡游', '18 张卡'],
];
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

function loadPreview(item: ProjectSummary, overview: boolean) {
  const portraitKey = `v${WORKBENCH_PREVIEW_VERSION}:${item.id}:${item.revision}`;
  const wholeKey = portraitKey + ':overview';
  const key = overview ? wholeKey : portraitKey;
  const cached = previews.get(key) ?? previews.get(wholeKey);
  if (cached) return cached;
  const request = readProject(item.id).then(async ({ project, revision }) => {
    const canvas = await renderCard(project, 'front', { scale: 200 / (10 * Math.max(project.heightMm, project.widthMm)) });
    const radius = getCardCornerRadiusMm(project);
    const preview: Preview = {
      src: canvas.toDataURL('image/png'),
      radius: `${100 * radius / project.widthMm}% / ${100 * radius / project.heightMm}%`,
    };
    if (overview && revision === item.revision && !previews.has(portraitKey)) {
      cachePreview(portraitKey, Promise.resolve(preview));
    }
    const image = overview ? await workbenchOverview(project, canvas).catch(() => undefined) : undefined;
    // A missing attachment or a new revision can make this result temporary.
    if ((revision !== item.revision || (overview && !image)) && previews.get(key) === request) previews.delete(key);
    return image ? { ...preview, overview: image } : preview;
  }).catch(error => {
    if (previews.get(key) === request) previews.delete(key);
    throw error;
  });
  cachePreview(key, request);
  return request;
}

function cachePreview(key: string, request: Promise<Preview>) {
  if (previews.size >= 32) {
    const oldest = previews.keys().next().value;
    if (oldest) previews.delete(oldest);
  }
  previews.set(key, request);
}

function ProjectCover({ item, overview = false }: { item: ProjectSummary; overview?: boolean }) {
  const region = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<Preview>();
  useEffect(() => {
    let active = true;
    const observe = new IntersectionObserver(([entry], observer) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      loadPreview(item, overview).then(result => { if (active) setPreview(result); }).catch(() => {});
    }, { rootMargin: '100px' });
    if (region.current) observe.observe(region.current);
    return () => { active = false; observe.disconnect(); };
  }, [item, overview]);
  const whole = overview && preview?.overview;
  return <span ref={region} className="workbench-cover" aria-hidden="true">
    {preview ? <img src={whole || preview.src} alt="" className={whole ? 'workbench-overview' : undefined} style={whole ? undefined : { borderRadius: preview.radius }} /> : <span className="workbench-card-placeholder" />}
  </span>;
}

type WorkbenchProps = {
  items: ProjectSummary[];
  recent: ProjectSummary[];
  archived: boolean;
  showAll: boolean;
  ready: boolean;
  offline: boolean;
  busy: boolean;
  message: string;
  error: boolean;
  onShowAll: () => void;
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

export default function ProjectWorkbench(p: WorkbenchProps) {
  const [menu, setMenu] = useState<string>();
  const [chatOpen, setChatOpen] = useState(true);
  const [developmentNotice, setDevelopmentNotice] = useState<{ text: string }>();
  const available = p.ready && !p.busy;
  const visible = p.showAll || p.archived ? p.items : p.items.slice(0, 5);
  const developing = (label: string) => setDevelopmentNotice({ text: label + '正在开发' });
  useEffect(() => {
    if (!developmentNotice) return;
    const timer = window.setTimeout(() => setDevelopmentNotice(undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [developmentNotice]);
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
            <span><img src={assets + 'create.svg'} alt="" /></span>新建项目
          </button>
          {p.recent.map(item => <button className="workbench-recent" key={item.id + ':' + item.revision} disabled={!available} onClick={() => p.onOpen(item)}>
            <ProjectCover item={item} overview /><span className="workbench-recent-meta"><strong>{item.name}</strong><small>单卡 · {projectDate(item.updatedAt)}</small></span>
          </button>)}
        </div>
      </section>}
      <section className="workbench-section" aria-labelledby="workbench-projects">
        <div className="workbench-section-title">
          <h2 id="workbench-projects">{p.archived ? '已归档' : '我的单卡'}</h2>
        </div>
        {!p.ready ? <p className="workbench-empty" role="status">{p.offline ? '启动本机 Prism 服务后重试。' : '正在读取项目…'}</p>
          : visible.length ? <ul className="workbench-project-grid">
            {visible.map(item => <li key={item.id} className="workbench-project"
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(current => current === item.id ? undefined : current); }}
              onKeyDown={event => { if (event.key === 'Escape' && menu === item.id) { setMenu(undefined); event.currentTarget.querySelector<HTMLButtonElement>('.workbench-more')?.focus(); } }}>
              <button className="workbench-open" title={item.name} aria-label={(p.archived ? '归档项目 ' : '打开 ') + item.name} disabled={!available || p.archived} onClick={() => p.onOpen(item)}>
                <ProjectCover key={item.revision} item={item} />
                <span className="workbench-project-meta"><strong>{item.name}</strong><small>{item.widthMm}mm × {item.heightMm}mm</small>
                  <time dateTime={new Date(item.updatedAt).toISOString()}>{projectDate(item.updatedAt)}</time>
                </span>
              </button>
              {p.archived ? <button className="workbench-restore" disabled={!available} onClick={() => p.onRestore(item)}>恢复</button> : <>
                <button aria-label={`更多操作 ${item.name}`} className="workbench-more" aria-expanded={menu === item.id} disabled={!available}
                  onClick={() => setMenu(menu === item.id ? undefined : item.id)}><HugeiconsIcon icon={MoreHorizontalIcon} size={16} /></button>
                {menu === item.id && <div className="workbench-menu">
                  <button onClick={() => { setMenu(undefined); p.onDuplicate(item); }}><HugeiconsIcon icon={Copy01Icon} size={16} />复制</button>
                  <button onClick={() => { setMenu(undefined); p.onExport(item); }}><HugeiconsIcon icon={Download01Icon} size={16} />导出项目包</button>
                  <button onClick={() => { setMenu(undefined); p.onArchive(item); }}><HugeiconsIcon icon={Archive01Icon} size={16} />归档</button>
                </div>}
              </>}
            </li>)}
          </ul> : <p className="workbench-empty">{p.archived ? '暂无已归档项目' : '暂无单卡，创建或导入项目后会显示在这里。'}</p>}
        {visible.length < p.items.length && <button className="workbench-more-projects" onClick={p.onShowAll}>查看全部单卡</button>}
      </section>
      {!p.archived && <section className="workbench-section" aria-labelledby="workbench-sets">
        <div className="workbench-section-title">
          <h2 id="workbench-sets">我的套卡</h2>
          <button className="workbench-tool" onClick={() => developing('新建套卡')}>新建套卡</button>
        </div>
        <ul className="workbench-project-grid">
          {setExamples.map(([name, count]) => <li className="workbench-project" key={name}>
            <button className="workbench-open workbench-open-set" onClick={() => developing('套卡功能')} aria-label={`套卡示例 ${name}，${count}`}>
              <span className="workbench-set-cover" aria-hidden="true">{['back', 'middle', 'front'].map(side =>
                <img key={side} src={assets + 'set-card-' + side + '.png'} alt="" />)}</span>
              <span className="workbench-project-meta"><strong>{name}</strong><small>{count}</small><small className="workbench-demo-label">示例</small></span>
            </button>
          </li>)}
        </ul>
      </section>}
      <div className={`workbench-feedback ${developmentNotice ? 'visible' : ''}`} role="status" aria-live="polite">{developmentNotice?.text}</div>
    </main>
  </>;
}
