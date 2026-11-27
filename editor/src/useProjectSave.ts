import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Project } from './model';
import { accountWorkspace, currentWorkspace, ProjectRequestError, readProject, workspaceSignal, writeProject, type StoredProject } from './projects';
import { discardAccountDraft, retainAccountDraft } from './accountDrafts';

type SaveState = { status: 'saved' | 'saving' } | { status: 'error' | 'conflict'; message: string };
type Attempt = { project: Project; mutation: string };

export function useProjectSave(initial: StoredProject, current: RefObject<Project>) {
  const [state, setState] = useState<SaveState>({ status: 'saved' });
  const saved = useRef(initial.project);
  const revision = useRef(initial.revision);
  const attempt = useRef<Attempt | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const conflict = useRef(false);
  const owner=useRef(currentWorkspace());
  const lifetime=useRef(workspaceSignal());
  const ownsWorkspace=useCallback(()=>!lifetime.current.aborted&&currentWorkspace()===owner.current,[]);

  const saveNow = useCallback(() => {
    window.clearTimeout(timer.current);
    if (!ownsWorkspace() || conflict.current) return Promise.resolve(false);
    if (running.current) return running.current;
    if (saved.current.version === current.current.version) return Promise.resolve(true);
    setState({ status: 'saving' });

    running.current = (async () => {
      try {
        while (saved.current.version !== current.current.version) {
          if (!ownsWorkspace()) return false;
          const pending = attempt.current ?? { project: current.current, mutation: crypto.randomUUID() };
          attempt.current = pending;
          const result = await writeProject(pending.project, revision.current, pending.mutation);
          if (!ownsWorkspace()) return false;
          revision.current = result.revision;
          saved.current = pending.project;
          attempt.current = null;
        }
        if(accountWorkspace(owner.current))void discardAccountDraft(owner.current,initial.id).catch(()=>{});
        setState({ status: 'saved' });
        return true;
      } catch (error) {
        if (!ownsWorkspace()) return false;
        const status = error instanceof ProjectRequestError ? error.status : 0;
        conflict.current = status === 409;
        // The server may have committed a request whose response did not arrive.
        // Retry that same operation before sending a newer edit.
        if (status >= 400 && status < 500 && status !== 408) attempt.current = null;
        setState({
          status: conflict.current ? 'conflict' : 'error',
          message: error instanceof Error ? error.message : '无法保存修改，请重试。',
        });
        return false;
      } finally {
        running.current = null;
      }
    })();
    return running.current;
  }, [current,initial.id,ownsWorkspace]);

  const queueSave = useCallback(() => {
    if (!ownsWorkspace() || conflict.current) return;
    setState({ status: 'saving' });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void saveNow(); }, 420);
  }, [saveNow,ownsWorkspace]);

  useEffect(() => {
    function preventLoss(event: BeforeUnloadEvent) {
      if (current.current.version === saved.current.version) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', preventLoss);
    const keepAccountDraft=()=>{
      window.clearTimeout(timer.current);
      if(accountWorkspace(owner.current)&&current.current.version!==saved.current.version)
        void retainAccountDraft(owner.current,current.current,revision.current).catch(()=>{});
    };
    window.addEventListener('prism-workspace-changed',keepAccountDraft);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener('beforeunload', preventLoss);
      window.removeEventListener('prism-workspace-changed',keepAccountDraft);
    };
  }, [current]);

  const refresh = useCallback(async (draft: () => boolean, apply: (row: StoredProject) => void) => {
    if (!ownsWorkspace() || conflict.current || running.current || attempt.current) return;
    const seen = revision.current;
    const row = await readProject(initial.id);
    if (!ownsWorkspace() || running.current || attempt.current || seen !== revision.current || row.revision <= seen) return;
    if (draft() || saved.current.version !== current.current.version || row.archivedAt !== null) {
      window.clearTimeout(timer.current);
      conflict.current = true;
      setState({ status: 'conflict', message: row.archivedAt !== null ? '项目已归档，请另存当前草稿。' : '另一台设备已更新此项目，请保留当前草稿或查看最新版。' });
      return;
    }
    revision.current = row.revision;
    saved.current = row.project;
    apply(row);
  }, [initial.id,current,ownsWorkspace]);

  return { state, queueSave, saveNow, refresh };
}
