import type { Project } from './model';
import { listLegacyProjects } from './io';

export interface ProjectSummary {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  updatedAt: number;
  archivedAt: number | null;
  revision: number;
}

export interface StoredProject extends ProjectSummary {
  project: Project;
}

export class ProjectRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path = '', body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/projects' + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new ProjectRequestError('本机项目服务连接失败，请重试。', 0);
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new ProjectRequestError(result.error || '本机项目库无法读取，请重试。', response.status);
  }
  return response.json() as Promise<T>;
}

export const listProjects = () => request<ProjectSummary[]>();
export const readProject = (id: string) => request<StoredProject>('/' + encodeURIComponent(id));
export const writeProject = (project: Project, revision: number, mutation: string) =>
  request<ProjectSummary>('/' + encodeURIComponent(project.id), { project, revision, mutation });

export async function createStoredProject(project: Project): Promise<StoredProject> {
  const summary = await writeProject(project, 0, project.id);
  return { ...summary, project: { ...project, updatedAt: summary.updatedAt } };
}

export const archiveProject = (project: ProjectSummary, archived: boolean) =>
  request<ProjectSummary>('/' + encodeURIComponent(project.id) + '/archive', { revision: project.revision, archived });

export async function openLibrary() {
  const items = await listProjects();
  const existing = new Set(items.map(item => item.id));
  let legacy: Project[];
  try {
    legacy = await listLegacyProjects();
  } catch {
    return { items, notice: '旧版浏览器项目读取失败。已有项目包仍可导入。' };
  }

  let failures = 0;
  for (const project of legacy) {
    if (existing.has(project.id)) continue;
    try {
      const saved = await writeProject(project, 0, crypto.randomUUID());
      items.push(saved);
      existing.add(saved.id);
    } catch (error) {
      if (error instanceof ProjectRequestError && error.status === 409) {
        const saved = await readProject(project.id).catch(() => null);
        if (saved) { items.push(saved); continue; }
      }
      failures++;
    }
  }
  return {
    items: items.sort((a, b) => b.updatedAt - a.updatedAt),
    notice: failures ? `${failures} 个旧版项目尚未迁移，仍可刷新重试。` : '',
  };
}
