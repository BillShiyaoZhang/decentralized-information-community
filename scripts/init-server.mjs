import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SqliteStore } from '../server/store.mjs';
import { loadCommunity, projectRoot } from './community-config.mjs';
// Deliberately refuses an existing database; this is an initial import, never a reset.
const { graph, graphFile } = await loadCommunity();
const directory = resolve(process.env.DATA_DIR || `${projectRoot}/.runtime`);
await mkdir(directory, { recursive: true });
const filename = `${directory}/community.sqlite`;
let reservation;
try { reservation = await open(filename, 'wx'); }
catch (error) { if (error.code === 'EEXIST') throw new Error('数据库已存在，未覆盖。请选择新的 DATA_DIR 或新的 Compose 项目名。'); throw error; }
await reservation.close();
let store;
try {
  store = new SqliteStore(filename, graph);
  const imported = store.load();
  console.log(JSON.stringify({ imported: true, graphFile, id: imported.id, revision: imported.revision, nodes: imported.nodes.length, edges: imported.edges.length }));
} catch (error) {
  store?.close(); store = null;
  // The file was exclusively created by this invocation and has not accepted writes.
  await unlink(filename).catch(() => {});
  throw error;
} finally { store?.close(); }
