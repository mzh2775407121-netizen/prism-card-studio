import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Project } from './model';
import { ProjectRequestError, writeProject, type StoredProject } from './projects';

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

  const saveNow = useCallback(() => {
    window.clearTimeout(timer.current);
    if (conflict.current) return Promise.resolve(false);
    if (running.current) return running.current;
    if (saved.current === current.current) return Promise.resolve(true);
    setState({ status: 'saving' });

    running.current = (async () => {
      try {
        while (saved.current !== current.current) {
          const pending = attempt.current ?? { project: current.current, mutation: crypto.randomUUID() };
          attempt.current = pending;
          const result = await writeProject(pending.project, revision.current, pending.mutation);
          revision.current = result.revision;
          saved.current = pending.project;
          attempt.current = null;
        }
        setState({ status: 'saved' });
        return true;
      } catch (error) {
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
  }, [current]);

  const queueSave = useCallback(() => {
    if (conflict.current) return;
    setState({ status: 'saving' });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void saveNow(); }, 420);
  }, [saveNow]);

  useEffect(() => {
    function preventLoss(event: BeforeUnloadEvent) {
      if (current.current === saved.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', preventLoss);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener('beforeunload', preventLoss);
    };
  }, [current]);

  return { state, queueSave, saveNow };
}
