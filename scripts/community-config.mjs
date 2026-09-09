import { readFile } from 'node:fs/promises';
import { resolve, dirname, isAbsolute, relative, sep } from 'node:path';
import { validateGraph } from '../packages/core/index.js';
export const projectRoot = resolve(import.meta.dirname, '..');
const siteKeys = ['brand', 'brandCaption', 'tagline', 'heading', 'footer'];
export async function loadCommunity({ root = projectRoot, env = process.env } = {}) {
  const configFile = resolve(root, env.COMMUNITY_CONFIG || 'community.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  if (!config || config.schemaVersion !== 1 || typeof config.graphFile !== 'string' || !config.graphFile.trim()) throw new Error('community.config.json 需要 schemaVersion: 1 和 graphFile');
  const base = dirname(configFile);
  const configuredGraph = resolve(base, config.graphFile);
  const rel = relative(base, configuredGraph);
  if (isAbsolute(config.graphFile) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('配置中的 graphFile 必须位于配置文件所在目录内；外部快照可显式设置 GRAPH_FILE');
  if (!config.site || typeof config.site !== 'object' || Array.isArray(config.site)) throw new Error('缺少 site 展示配置');
  const site = {};
  for (const key of siteKeys) {
    const value = config.site[key];
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`site.${key} 必须为 1–200 字符文本`);
    site[key] = value;
  }
  const graphFile = env.GRAPH_FILE ? resolve(root, env.GRAPH_FILE) : configuredGraph;
  const graph = validateGraph(JSON.parse(await readFile(graphFile, 'utf8')));
  return { configFile, graphFile, graph, site };
}
