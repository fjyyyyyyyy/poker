// This project serves native ES modules directly; there is no bundling step.
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const files = (await readdir(root)).filter(file => /\.(m?js)$/.test(file));
for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))], { stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status || 1);
}
console.log(`已校验 ${files.length} 个原生 JavaScript 模块，可直接由 npm start 托管。`);
