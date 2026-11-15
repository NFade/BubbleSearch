// Запускает сервер API (с перезапуском при правках) и Vite для интерфейса.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!fs.existsSync(path.join(root, 'web', 'node_modules'))) {
  console.log('Устанавливаю зависимости интерфейса…');
  const r = spawnSync(npm, ['install'], { cwd: path.join(root, 'web'), stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const children = [
  // --watch следит за всеми импортированными файлами (server/, shared/). Связка --watch-path с
  // --env-file-if-exists на Node 26 перезапускает сервер по кругу без всяких правок.
  spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'server/main.ts'], { cwd: root, stdio: 'inherit' }),
  spawn(npm, ['run', 'dev'], { cwd: path.join(root, 'web'), stdio: 'inherit' }),
];

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
for (const c of children) c.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
