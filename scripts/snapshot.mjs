import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { validateGraph } from '../packages/core/index.js';
const [, , database, output] = process.argv;
if (!database || !output) { console.error('Usage: npm run snapshot -- .runtime/community.sqlite snapshot.json'); process.exitCode = 1; }
else {
  const db = new DatabaseSync(database, { readOnly: true });
  try { const graph = validateGraph(JSON.parse(db.prepare('SELECT graph FROM snapshots ORDER BY revision DESC LIMIT 1').get().graph)); await writeFile(output, JSON.stringify(graph, null, 2) + '\n'); console.log(`Exported revision ${graph.revision}`); }
  finally { db.close(); }
}
