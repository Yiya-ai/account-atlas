import {copyFile, mkdir, readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const packageName of ['tesseract.js', 'tesseract.js-core']) {
  const installed = JSON.parse(await readFile(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8'));
  if (installed.version !== '7.0.0') throw new Error('OCR runtime protocol requires pinned version 7.0.0');
}
const models = path.join(root, 'public/ocr/models');
const manifest = JSON.parse((await readFile(path.join(models, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
for (const entry of manifest.files) {
  const bytes = await readFile(path.join(models, entry.file));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`OCR model checksum mismatch: ${entry.file}`);
}
const runtime = path.join(root, 'public/ocr/runtime');
await mkdir(runtime, {recursive:true});
await copyFile(path.join(root, 'node_modules/tesseract.js/dist/worker.min.js'), path.join(runtime, 'worker.min.js'));
await copyFile(path.join(root, 'node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt'), path.join(runtime, 'worker.min.js.LICENSE.txt'));
await copyFile(path.join(root, 'node_modules/tesseract.js/LICENSE.md'), path.join(runtime, 'TESSERACT-JS-LICENSE.txt'));
const core = path.join(root, 'node_modules/tesseract.js-core');
for (const name of await readdir(core)) {
  // OEM 1 only: ship all three CPU variants, including non-SIMD fallback.
  if (/^tesseract-core(?:-simd|-relaxedsimd)?-lstm\.wasm(?:\.js)?$/.test(name)) await copyFile(path.join(core, name), path.join(runtime, name));
}
await copyFile(path.join(core, 'LICENSE'), path.join(runtime, 'TESSERACT-CORE-LICENSE.txt'));
console.log('Bundled same-origin OCR runtime and verified offline language models.');
