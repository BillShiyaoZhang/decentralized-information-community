import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[2] ?? join(root, 'artifacts'));
await mkdir(output, { recursive: true });
// npm launches this script with npm_execpath, avoiding Windows .cmd quoting issues.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请使用 npm run package:core -- [输出目录] 运行');
const result = spawnSync(process.execPath, [npm, 'pack', './packages/core', '--pack-destination', output, '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
