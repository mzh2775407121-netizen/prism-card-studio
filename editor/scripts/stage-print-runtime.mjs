import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const runtime = JSON.parse(await readFile(new URL('../print-runtime.json', import.meta.url), 'utf8'));
const output = resolve(process.argv[2] || 'dist', 'print-engine');
const pyodide = join(output, 'pyodide');
const wheels = join(output, 'wheels');
const distribution = 'https://cdn.jsdelivr.net/pyodide/v' + runtime.pyodideVersion + '/full/';

async function download(url, file, sha256) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(url + ' returned HTTP ' + response.status);
  const data = Buffer.from(await response.arrayBuffer());
  if (sha256 && createHash('sha256').update(data).digest('hex') !== sha256) {
    throw new Error('Print runtime checksum mismatch: ' + file);
  }
  await writeFile(file, data);
  return data;
}

await Promise.all([mkdir(pyodide, { recursive: true }), mkdir(wheels, { recursive: true })]);
const lockName = 'pyodide-lock.json';
const lock = JSON.parse(await download(distribution + lockName, join(pyodide, lockName)));
const packages = new Map();
function include(name) {
  if (packages.has(name)) return;
  const entry = lock.packages[name];
  if (!entry?.file_name || !entry.sha256) throw new Error('Missing Pyodide package: ' + name);
  packages.set(name, entry);
  for (const dependency of entry.depends) include(dependency);
}
runtime.packages.forEach(include);
await Promise.all([
  ...['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip'].map(name =>
    download(distribution + name, join(pyodide, name))),
  download('https://raw.githubusercontent.com/pyodide/pyodide/' + runtime.pyodideVersion + '/LICENSE', join(pyodide, 'LICENSE')),
  ...Array.from(packages.values(), entry =>
    download(distribution + entry.file_name, join(pyodide, entry.file_name), entry.sha256)),
  ...runtime.wheels.map(wheel => download(wheel.url, join(wheels, wheel.name), wheel.sha256)),
]);
console.log('Browser print runtime staged in ' + output);
