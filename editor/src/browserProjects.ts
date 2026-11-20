import {
  hydrateProject, isStockReflection, isValidProjectNote, isValidStockFinish, isValidStockSpec,
  serializeProject, type Project, type StoredProjectDocument,
} from './model';
import { ProjectRequestError, type ProjectSummary, type StoredProject } from './projects';

const DATABASE_NAME = 'prism-project-library';
const SUMMARIES = 'summaries';
const DOCUMENTS = 'documents';
const DELIVERIES = 'deliveries';
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MUTATION_ID = /^[a-fA-F0-9-]{36}$/;

type SavedSummary = ProjectSummary & { mutation: string };

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    let blocked = false;
    request.onupgradeneeded = event => {
      const database = request.result;
      if (event.oldVersion < 1) {
        database.createObjectStore(SUMMARIES, { keyPath: 'id' });
        database.createObjectStore(DOCUMENTS, { keyPath: 'id' });
      }
      database.createObjectStore(DELIVERIES);
    };
    request.onblocked = () => {
      blocked = true;
      reject(new ProjectRequestError('浏览器项目库正在另一个窗口中使用，请关闭该窗口后重试。', 0));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function databaseOperation<T>(names: string[], mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase();
    const transaction = database.transaction(names, mode);
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const [value] = await Promise.all([operation(transaction), committed]);
    return value;
  } catch (error) {
    if (error instanceof ProjectRequestError) throw error;
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new ProjectRequestError('浏览器存储空间不足，请导出项目包备份后重试。', 507);
    }
    throw new ProjectRequestError('浏览器项目库暂时无法读写，请重试。', 0);
  } finally {
    database?.close();
  }
}

function toSummary(record: SavedSummary): ProjectSummary {
  const { id, name, widthMm, heightMm, updatedAt, archivedAt, revision, cardCount = 1 } = record;
  return { id, name, widthMm, heightMm, updatedAt, archivedAt, revision, cardCount };
}

function validateRevision(revision: number, minimum: number) {
  return Number.isSafeInteger(revision) && revision >= minimum;
}

function documentForSave(project: Project): StoredProjectDocument {
  if (!project || typeof project.id !== 'string' || !PROJECT_ID.test(project.id)) {
    throw new ProjectRequestError('项目标识无效', 404);
  }
  if (typeof project.name !== 'string' || !project.name.trim() || [...project.name.trim()].length > 500) {
    throw new ProjectRequestError('请输入有效的项目名称', 400);
  }
  if (!isValidProjectNote(project.note)) {
    throw new ProjectRequestError('项目备注无效', 400);
  }
  if (!validateRevision(project.version, 1)) throw new ProjectRequestError('项目版本无效', 400);
  if (project.additionalCards !== undefined && !Array.isArray(project.additionalCards)) {
    throw new ProjectRequestError('项目卡牌列表无效', 400);
  }
  const document = serializeProject(project);
  const within = (value: number, low: number, high: number) => Number.isFinite(value) && low <= value && value <= high;
  const validText = (value: unknown, limit: number) => typeof value === 'string' && !!value.trim() && value.length <= limit;
  const ids = new Set<string>();
  for (const card of document.cards) {
    if (!card || !validText(card.id, 302) || !validText(card.name, 500) || ids.has(card.id)) {
      throw new ProjectRequestError('卡牌名称或标识无效', 400);
    }
    ids.add(card.id);
    if (!within(card.widthMm, 10, 500) || !within(card.heightMm, 10, 500) || !within(card.bleedMm, 0, 20)) {
      throw new ProjectRequestError('卡片尺寸或出血无效', 400);
    }
    if (typeof card.material !== 'string' || (card.stockSpec !== undefined && !isValidStockSpec(card.stockSpec))) {
      throw new ProjectRequestError('卡基规格无效', 400);
    }
    if (card.stockReflection !== undefined && !isStockReflection(card.stockReflection)) {
      throw new ProjectRequestError('底材反光类型无效', 400);
    }
    for (const face of [card.front, card.back]) {
      if (!face || ![face.nodes, face.regions, face.effects].every(items => Array.isArray(items) &&
        items.every(item => item && typeof item === 'object' && !Array.isArray(item)))) {
        throw new ProjectRequestError('项目缺少完整的正反面数据', 400);
      }
      if (face.stockFinish !== undefined && !isValidStockFinish(face.stockFinish)) {
        throw new ProjectRequestError('卡面反光参数无效', 400);
      }
    }
  }
  return document;
}

export function listBrowserProjects(): Promise<ProjectSummary[]> {
  return databaseOperation([SUMMARIES], 'readonly', async transaction => {
    const records: SavedSummary[] = await result(transaction.objectStore(SUMMARIES).getAll());
    return records.map(toSummary).sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export function recordDeliveryVersion(project: Project) {
  return databaseOperation([DELIVERIES], 'readwrite', async transaction => {
    const versions = transaction.objectStore(DELIVERIES);
    const key = [project.id, project.version];
    const saved: Project | StoredProjectDocument | undefined = await result(versions.get(key));
    const document = serializeProject(project);
    if (!saved) {
      await result(versions.add(document, key));
    } else if (JSON.stringify({ ...serializeProject(hydrateProject(saved)), updatedAt: 0 }) !== JSON.stringify({ ...document, updatedAt: 0 })) {
      throw new ProjectRequestError('此版本已有另一份交付工程，请为这份文件下载独立工程包。', 409);
    }
  });
}

export function listDeliveryVersions(id: string): Promise<number[]> {
  return databaseOperation([DELIVERIES], 'readonly', async transaction => {
    const keys = await result(transaction.objectStore(DELIVERIES).getAllKeys(
      IDBKeyRange.bound([id, 1], [id, Number.MAX_SAFE_INTEGER]),
    ));
    return keys.map(key => (key as [string, number])[1]).sort((a, b) => b - a);
  });
}

export function readDeliveryVersion(id: string, version: number): Promise<Project | undefined> {
  return databaseOperation([DELIVERIES], 'readonly', async transaction => {
    const saved: Project | StoredProjectDocument | undefined = await result(transaction.objectStore(DELIVERIES).get([id, version]));
    return saved && hydrateProject(saved);
  });
}

export async function readBrowserProject(id: string): Promise<StoredProject> {
  if (typeof id !== 'string' || !PROJECT_ID.test(id)) throw new ProjectRequestError('项目标识无效', 404);
  return databaseOperation([SUMMARIES, DOCUMENTS], 'readonly', async transaction => {
    const [summary, project]: [SavedSummary | undefined, Project | StoredProjectDocument | undefined] = await Promise.all([
      result(transaction.objectStore(SUMMARIES).get(id)),
      result(transaction.objectStore(DOCUMENTS).get(id)),
    ]);
    if (!summary || !project) throw new ProjectRequestError('项目不存在', 404);
    return { ...toSummary(summary), project: hydrateProject(project) };
  });
}

export async function writeBrowserProject(project: Project, revision: number, mutation: string): Promise<ProjectSummary> {
  if (!validateRevision(revision, 0) || typeof mutation !== 'string' || !MUTATION_ID.test(mutation)) {
    throw new ProjectRequestError('保存版本无效', 400);
  }
  const document = documentForSave(project);
  return databaseOperation([SUMMARIES, DOCUMENTS], 'readwrite', async transaction => {
    const summaries = transaction.objectStore(SUMMARIES);
    const previous: SavedSummary | undefined = await result(summaries.get(project.id));
    if (previous?.mutation === mutation && previous.revision === revision + 1) return toSummary(previous);
    if ((previous?.revision ?? 0) !== revision || (previous && previous.archivedAt !== null)) {
      throw new ProjectRequestError('此项目已有更新，请重新打开或将当前修改另存为副本', 409);
    }
    const updatedAt = Date.now();
    const { id, name, widthMm, heightMm } = project;
    const record = { id, name, widthMm, heightMm, updatedAt, archivedAt: null,
      revision: revision + 1, mutation, cardCount: document.cards.length };
    // Prepare both records before enqueueing writes. If a request or structured
    // clone fails, abort so metadata and document cannot diverge.
    try {
      const summaryWrite = summaries.put(record);
      const documentWrite = transaction.objectStore(DOCUMENTS).put({ ...document, updatedAt });
      await Promise.all([result(summaryWrite), result(documentWrite)]);
    } catch (error) {
      try { transaction.abort(); } catch { /* Already aborted by IndexedDB. */ }
      throw error;
    }
    return toSummary(record);
  });
}

export async function archiveBrowserProject(project: ProjectSummary, archived: boolean): Promise<ProjectSummary> {
  if (typeof project.id !== 'string' || !PROJECT_ID.test(project.id)) {
    throw new ProjectRequestError('项目标识无效', 404);
  }
  if (!validateRevision(project.revision, 1) || typeof archived !== 'boolean') {
    throw new ProjectRequestError('项目状态无效', 400);
  }
  return databaseOperation([SUMMARIES], 'readwrite', async transaction => {
    const summaries = transaction.objectStore(SUMMARIES);
    const previous: SavedSummary | undefined = await result(summaries.get(project.id));
    if (!previous || previous.revision !== project.revision) {
      throw new ProjectRequestError('项目状态已变化，请刷新项目库', 409);
    }
    const record = { ...previous, archivedAt: archived ? Date.now() : null, revision: previous.revision + 1 };
    await result(summaries.put(record));
    return toSummary(record);
  });
}
