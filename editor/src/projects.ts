import { hydrateProject, serializeProject, type Project, type ProjectCard, type StoredProjectDocument } from './model';
import { browserRuntime } from './runtime';

export interface ProjectSummary {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  updatedAt: number;
  archivedAt: number | null;
  revision: number;
  cardCount: number;
}

export interface StoredProject extends ProjectSummary {
  project: Project;
}

export class ProjectRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

let workspaceScope = browserRuntime ? 'guest' : '';
let workspaceController = new AbortController();
export function currentWorkspace() { return workspaceScope; }
export function workspaceSignal() { return workspaceController.signal; }
export function accountWorkspace(scope=workspaceScope) { return Boolean(scope && scope!=='guest' && scope!=='local' && scope!=='lan'); }
export function projectWorkspace(scope=workspaceScope) { return accountWorkspace(scope) || scope==='lan'; }
export function workspaceHeaders() {
  return workspaceScope ? { 'X-Prism-Workspace': workspaceScope } : {} as Record<string,string>;
}
export function changeWorkspace(scope:string,broadcast=true,force=false) {
  if(workspaceScope===scope&&!force)return;
  const previous=workspaceScope;
  workspaceController.abort();
  workspaceController=new AbortController();
  workspaceScope = scope;
  window.dispatchEvent(new CustomEvent('prism-workspace-changed',{detail:{previous,scope}}));
  if(broadcast)try {localStorage.setItem('prism-account-switch',crypto.randomUUID());} catch { /* Private reads and writes also verify the server scope. */ }
}

export function invalidateWorkspace(status:number,actual?:string|null) {
  if((workspaceScope&&actual&&workspaceScope!==actual)||(accountWorkspace()&&status===401))changeWorkspace('',false);
}

async function request<T>(path = '', body?: object): Promise<T> {
  if(browserRuntime)throw new ProjectRequestError('当前站点未连接账号服务', 503);
  const signal=workspaceSignal();
  const discovery=!path&&!body;
  let response: Response;
  try {
    response = await fetch('/api/projects' + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { ...workspaceHeaders(), 'Content-Type': 'application/json' } : path ? workspaceHeaders() : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal,AbortSignal.timeout(45_000)]),
    });
  } catch {
    throw new ProjectRequestError('本机项目服务连接失败，请重试。', 0);
  }
  signal.throwIfAborted();
  const actual=response.headers.get('X-Prism-Workspace');
  invalidateWorkspace(response.status,actual);
  signal.throwIfAborted();
  if(discovery && actual && (response.ok || (actual==='guest' && response.status===401))) workspaceScope=actual;
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    signal.throwIfAborted();
    throw new ProjectRequestError(result.error || '本机项目库无法读取，请重试。', response.status);
  }
  const result=await response.json() as T;
  signal.throwIfAborted();
  return result;
}

export const listProjects = () => request<ProjectSummary[]>().then(items =>
  items.map(item => ({ ...item, cardCount: item.cardCount ?? 1 })));
export const readProject = (id: string) =>
  request<ProjectSummary & { project: Project | StoredProjectDocument }>('/' + encodeURIComponent(id)).then(record => {
    const project = hydrateProject(record.project);
    return { ...record, project, cardCount: record.cardCount ?? 1 + (project.additionalCards?.length ?? 0) };
  });
export const writeProject = (project: Project, revision: number, mutation: string) =>
  request<ProjectSummary>('/' + encodeURIComponent(project.id), { project: serializeProject(project), revision, mutation })
    .then(record => ({ ...record, cardCount: record.cardCount ?? 1 + (project.additionalCards?.length ?? 0) }));

export async function recordAssetUse(projectId:string,cardId:string, card:ProjectCard) {
  if(browserRuntime||!accountWorkspace())return;
  const origin=card.assetOrigin, received=card.communityOrigin;
  const source=origin?{kind:'owned',asset:origin.assetId,assetVersion:origin.version}:
    received?{kind:'received',work:received.workId,edition:received.edition}:undefined;
  if(source)await request('/'+encodeURIComponent(projectId)+'/asset-use',{cardId,source});
}

export async function createStoredProject(project: Project): Promise<StoredProject> {
  const summary = await writeProject(project, 0, project.id);
  return { ...summary, project: hydrateProject({ ...project, updatedAt: summary.updatedAt }) };
}

export const archiveProject = (project: ProjectSummary, archived: boolean) =>
  request<ProjectSummary>('/' + encodeURIComponent(project.id) + '/archive', { revision: project.revision, archived })
    .then(record => ({ ...record, cardCount: record.cardCount ?? project.cardCount }));

export async function openLibrary() {
  if(browserRuntime)return [];
  try {
    const items=await listProjects();
    return projectWorkspace()?items:[];
  } catch(error) {
    if(error instanceof ProjectRequestError && error.status===401 && workspaceScope==='guest')return [];
    throw error;
  }
}
