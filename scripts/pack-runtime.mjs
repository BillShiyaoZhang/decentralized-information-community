import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..'), output = resolve(process.argv[2] ?? join(root, 'artifacts'));
await mkdir(output, { recursive: true });
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Use npm run package:runtime -- [output directory]');
for (const name of ['core', 'runtime']) {
  const result = spawnSync(process.execPath, [npm, 'pack', `./packages/${name}`, '--pack-destination', output, '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
