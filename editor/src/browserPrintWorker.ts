/// <reference types="vite/client" />
/// <reference lib="webworker" />

import serverSource from '../server.py?raw';
import storeSource from '../project_store.py?raw';
import printRuntime from '../print-runtime.json';

interface Pyodide {
  loadPackage(packages: string[]): Promise<void>;
  unpackArchive(bytes: ArrayBuffer, format: string, options: { extractDir: string }): void;
  runPython(code: string): unknown;
  globals: { set(name: string, value: string): void; delete(name: string): void };
  FS: {
    writeFile(path: string, data: string): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    analyzePath(path: string): { exists: boolean };
  };
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const PYODIDE_URL = new URL('/print-engine/pyodide/', scope.location.origin).href;
const WHEELS_URL = new URL('/print-engine/wheels/', scope.location.origin);
const MAX_REQUEST_BYTES = 120 * 1024 * 1024;
const OUTPUT_PATH = '/prism-print.zip';

async function fetchWheel(wheel: { name: string; sha256: string }) {
  const response = await fetch(new URL(wheel.name, WHEELS_URL));
  if (!response.ok) throw new Error('Unable to download print dependency');
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== wheel.sha256) throw new Error('Print dependency integrity check failed');
  return bytes;
}

async function initialize() {
  const { loadPyodide } = await import(/* @vite-ignore */ PYODIDE_URL + 'pyodide.mjs') as {
    loadPyodide(options: { indexURL: string }): Promise<Pyodide>;
  };
  const pyodide = await loadPyodide({ indexURL: PYODIDE_URL });
  const [, wheels] = await Promise.all([
    pyodide.loadPackage(printRuntime.packages),
    Promise.all(printRuntime.wheels.map(fetchWheel)),
  ]);
  const sitePackages = pyodide.runPython('import sysconfig\nsysconfig.get_path("purelib")') as string;
  for (const wheel of wheels) pyodide.unpackArchive(wheel, 'zip', { extractDir: sitePackages });
  pyodide.FS.writeFile('server.py', serverSource);
  pyodide.FS.writeFile('project_store.py', storeSource);
  pyodide.runPython(`
import json
from pathlib import Path
from server import export_package, ExportError

def prism_export(request, output_path):
    try:
        Path(output_path).write_bytes(export_package(json.loads(request)))
    except ExportError as error:
        return str(error)
    return ""
`);
  return pyodide;
}

void initialize().then(pyodide => {
  scope.addEventListener('message', (event: MessageEvent<object>) => {
    try {
      const request = JSON.stringify(event.data);
      if (typeof request !== 'string' || new Blob([request]).size > MAX_REQUEST_BYTES) {
        scope.postMessage({ type: 'error', message: '请求大小须在 120 MB 以内。' });
        return;
      }
      pyodide.globals.set('_prism_request', request);
      const error = pyodide.runPython(`prism_export(_prism_request, '${OUTPUT_PATH}')`);
      if (error) {
        scope.postMessage({ type: 'error', message: error });
        return;
      }
      const bytes = pyodide.FS.readFile(OUTPUT_PATH).slice().buffer;
      scope.postMessage({ type: 'result', bytes }, [bytes]);
    } catch (error) {
      console.error('Prism print export error', error);
      scope.postMessage({ type: 'error', message: '文件生成失败，请保留当前项目并重试。' });
    } finally {
      pyodide.globals.delete('_prism_request');
      if (pyodide.FS.analyzePath(OUTPUT_PATH).exists) pyodide.FS.unlink(OUTPUT_PATH);
    }
  });
  scope.postMessage({ type: 'ready' });
}).catch(error => {
  console.error('Prism print runtime load error', error);
  scope.postMessage({ type: 'startup-error', message: '印前组件无法加载，请检查网络后重试。' });
});
