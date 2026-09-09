import { readFile } from 'node:fs/promises';
import { validateGraph, graphStats } from '../packages/core/index.js';
const path = process.argv[2] ?? process.env.GRAPH_FILE ?? 'examples/campus/graph.json';
try { const graph = validateGraph(JSON.parse(await readFile(path, 'utf8'))); console.log(JSON.stringify({ valid: true, ...graphStats(graph) }, null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
