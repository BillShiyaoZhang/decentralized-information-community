import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyChange } from '../packages/core/index.js';
const [, , graphFile, proposalFile, output] = process.argv;
if (!graphFile || !proposalFile || !output) { console.error('Usage: npm run apply -- graph.json proposal.json output.json'); process.exitCode = 1; }
else {
  const target = resolve(output), lockPath = `${target}.lock`, temporary = `${target}.${process.pid}.tmp`;
  const lock = await open(lockPath, 'wx');
  try {
  const graph = JSON.parse(await readFile(graphFile, 'utf8'));
  if (resolve(graphFile) !== target) {
    try { await readFile(target); throw new Error('输出文件已存在；使用同一输入/输出路径做版本检查，或指定新文件'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const proposal = JSON.parse(await readFile(proposalFile, 'utf8'));
  const next = applyChange(graph, proposal);
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, target);
  console.log(`Accepted proposal ${proposal.id}; revision ${next.revision} written to ${output}`);
  } finally { await unlink(temporary).catch(() => {}); await lock.close(); await unlink(lockPath); }
}
