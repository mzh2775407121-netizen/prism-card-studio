type PrintReply =
  | { type: 'ready' }
  | { type: 'startup-error'; message: string }
  | { type: 'result'; bytes: ArrayBuffer }
  | { type: 'error'; message: string };

interface PrintRuntime {
  worker: Worker;
  ready: Promise<void>;
  stop: (reason: unknown) => void;
}

let runtime: PrintRuntime | undefined;
let printing = false;

function startRuntime(): PrintRuntime {
  if (runtime) return runtime;

  const worker = new Worker(new URL('./browserPrintWorker.ts', import.meta.url), { type: 'module' });
  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const current: PrintRuntime = {
    worker,
    ready,
    stop(reason) {
      window.clearTimeout(timeout);
      worker.terminate();
      if (runtime === current) runtime = undefined;
      rejectReady(reason);
    },
  };

  const timeout = window.setTimeout(() => {
    current.stop(new Error('印前组件加载超时，请检查网络后重试。'));
  }, 90_000);
  worker.addEventListener('message', (event: MessageEvent<PrintReply>) => {
    if (event.data.type === 'ready') {
      window.clearTimeout(timeout);
      resolveReady();
    } else if (event.data.type === 'startup-error') {
      current.stop(new Error(event.data.message));
    }
  });
  worker.addEventListener('error', () => {
    current.stop(new Error('浏览器无法运行印前组件，请重试。'));
  });
  runtime = current;
  return current;
}

function waitUntilReady(current: PrintRuntime, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    current.ready.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function prepareBrowserPrint(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await waitUntilReady(startRuntime(), signal);
}

export async function exportBrowserPrint(payload: object, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (printing) throw new Error('已有导出任务正在运行，请稍后重试。');
  printing = true;

  try {
    const current = startRuntime();
    await waitUntilReady(current, signal);
    signal.throwIfAborted();

    return await new Promise<Blob>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        current.worker.removeEventListener('message', result);
        current.worker.removeEventListener('error', fail);
        current.worker.removeEventListener('messageerror', fail);
      };
      const abort = () => {
        cleanup();
        current.stop(signal.reason);
        reject(signal.reason);
      };
      const fail = () => {
        cleanup();
        const error = new Error('印刷文件生成失败，请重试。');
        current.stop(error);
        reject(error);
      };
      const result = (event: MessageEvent<PrintReply>) => {
        if (event.data.type === 'result') {
          cleanup();
          resolve(new Blob([event.data.bytes], { type: 'application/zip' }));
        } else if (event.data.type === 'error') {
          cleanup();
          reject(new Error(event.data.message));
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      current.worker.addEventListener('message', result);
      current.worker.addEventListener('error', fail);
      current.worker.addEventListener('messageerror', fail);
      try {
        current.worker.postMessage(payload);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  } finally {
    printing = false;
  }
}
