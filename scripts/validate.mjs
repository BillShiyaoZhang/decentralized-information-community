import { readFile } from 'node:fs/promises';
import { validateGraph, graphStats } from '../packages/core/index.js';
import { loadCommunity } from './community-config.mjs';
try { const graph = process.argv[2] ? validateGraph(JSON.parse(await readFile(process.argv[2], 'utf8'))) : (await loadCommunity()).graph; console.log(JSON.stringify({ valid: true, ...graphStats(graph) }, null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
