/** Portable JSON graph contract. This module has no browser or server dependencies. */
export class GraphError extends Error {
  constructor(message, code = 'INVALID_GRAPH') { super(message); this.name = 'GraphError'; this.code = code; }
}
const fail = (message) => { throw new GraphError(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, max = 20000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} 必须是 1–${max} 个字符的文本`);
};
const identifier = (value, name) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(value)) fail(`${name} 不是有效标识符`);
};
export function safeUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export function validateOntology(ontology) {
  if (!object(ontology) || !Array.isArray(ontology.nodeTypes) || !Array.isArray(ontology.relationTypes)) fail('缺少类型蓝图');
  const types = new Set();
  for (const type of ontology.nodeTypes) {
    if (!object(type)) fail('节点类型必须为对象');
    identifier(type.id, '类型 ID'); text(type.label, '类型名称', 60);
    if (types.has(type.id)) fail('类型 ID 重复'); types.add(type.id);
    if (type.required !== undefined && (!Array.isArray(type.required) || type.required.some(k => !['body', 'source'].includes(k)))) fail('required 只支持 body 和 source');
  }
  if (!types.size) fail('蓝图至少需要一种节点类型');
  const relations = new Set();
  for (const relation of ontology.relationTypes) {
    if (!object(relation)) fail('关系类型必须为对象');
    identifier(relation.id, '关系类型 ID'); text(relation.label, '关系名称', 60);
    if (relations.has(relation.id)) fail('关系类型 ID 重复'); relations.add(relation.id);
    for (const direction of ['from', 'to']) {
      if (!Array.isArray(relation[direction]) || !relation[direction].length || relation[direction].some(t => !types.has(t))) fail('关系引用了未知节点类型');
    }
  }
  return ontology;
}
export function validateGraph(graph) {
  if (!object(graph) || graph.schemaVersion !== 1) fail('只支持 schemaVersion: 1');
  identifier(graph.id, '社区 ID'); text(graph.title, '社区名称', 120);
  if (!Number.isSafeInteger(graph.revision) || graph.revision < 0) fail('revision 必须为非负整数');
  validateOntology(graph.ontology);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) fail('缺少 nodes / edges');
  if (graph.nodes.length > 10000 || graph.edges.length > 40000) fail('单个快照最多 10000 节点 / 40000 关系');
  const types = new Map(graph.ontology.nodeTypes.map(t => [t.id, t]));
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!object(node)) fail('节点必须为对象');
    identifier(node.id, '节点 ID'); text(node.title, '标题', 160); text(node.author, '贡献者', 80);
    if (nodes.has(node.id)) fail(`节点 ID 重复：${node.id}`);
    const type = types.get(node.type); if (!type) fail(`未知节点类型：${node.type}`);
    if (typeof node.body !== 'string' || node.body.length > 20000) fail('正文必须是最多 20000 字符的文本');
    if (typeof node.source !== 'string' || node.source.length > 2048 || (node.source && !safeUrl(node.source))) fail('来源必须为有效的 HTTP(S) 链接');
    for (const key of type.required ?? []) text(node[key], key);
    if (!Array.isArray(node.tags) || node.tags.length > 12 || node.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 40)) fail('标签格式不正确');
    if (typeof node.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(node.updatedAt) || !Number.isFinite(Date.parse(node.updatedAt)) || new Date(node.updatedAt).toISOString().slice(0, 19) !== node.updatedAt.slice(0, 19)) fail('更新时间必须为有效的 UTC ISO 日期');
    nodes.set(node.id, node);
  }
  const relations = new Map(graph.ontology.relationTypes.map(r => [r.id, r]));
  const edgeIds = new Set(); const triples = new Set();
  for (const edge of graph.edges) {
    if (!object(edge)) fail('关联必须为对象');
    identifier(edge.id, '关联 ID'); text(edge.reason, '关联理由', 500);
    if (edgeIds.has(edge.id)) fail('关联 ID 重复'); edgeIds.add(edge.id);
    const from = nodes.get(edge.from), to = nodes.get(edge.to), relation = relations.get(edge.type);
    if (!from || !to) fail('关联指向了不存在的节点');
    if (edge.from === edge.to) fail('不允许自关联');
    if (!relation || !relation.from.includes(from.type) || !relation.to.includes(to.type)) fail('关联不符合类型蓝图的方向约束');
    const key = `${edge.from}|${edge.type}|${edge.to}`;
    if (triples.has(key)) fail('相同关联已存在'); triples.add(key);
  }
  return graph;
}
export function applyChange(graph, change) {
  validateGraph(graph);
  if (!object(change) || change.schemaVersion !== 1 || change.graphId !== graph.id) fail('提案不属于当前社区');
  identifier(change.id, '提案 ID');
  if (change.baseRevision !== graph.revision) throw new GraphError('数据版本已变化，请重新载入最新快照再合并提案', 'CONFLICT');
  if (!Array.isArray(change.operations) || !change.operations.length || change.operations.length > 2000) fail('提案必须包含 1–2000 个操作');
  const next = structuredClone(graph);
  for (const operation of change.operations) {
    if (!object(operation) || !['putNode', 'putEdge'].includes(operation.op)) fail('不支持的操作');
    const list = operation.op === 'putNode' ? next.nodes : next.edges;
    const value = operation.value;
    if (!object(value)) fail('操作缺少数据');
    const index = list.findIndex(item => item.id === value.id);
    if (index === -1) list.push(structuredClone(value)); else list[index] = structuredClone(value);
  }
  next.revision++;
  return validateGraph(next);
}
export function makeChange(graph, operations, id = `change-${crypto.randomUUID()}`) {
  return { schemaVersion: 1, id, graphId: graph.id, baseRevision: graph.revision, operations };
}
/** Produce an additive/updating proposal relative to a published snapshot. */
export function diffGraphs(base, draft, id) {
  validateGraph(base); validateGraph(draft);
  const metadata = graph => Object.fromEntries(Object.entries(graph).filter(([k]) => !['nodes', 'edges', 'revision'].includes(k)));
  if (JSON.stringify(metadata(base)) !== JSON.stringify(metadata(draft))) fail('提案只能修改节点和关联，不能切换社区或修改蓝图与元数据');
  const operations = [];
  for (const [key, op] of [['nodes', 'putNode'], ['edges', 'putEdge']]) {
    const previous = new Map(base[key].map(value => [value.id, value]));
    if (base[key].some(value => !draft[key].some(v => v.id === value.id))) fail('当前提案协议不支持删除');
    for (const value of draft[key]) if (JSON.stringify(previous.get(value.id)) !== JSON.stringify(value)) operations.push({ op, value });
  }
  return makeChange(base, operations, id);
}
const normalize = value => value.normalize('NFKC').toLocaleLowerCase();
export function searchGraph(graph, { query = '', type = '', tag = '' } = {}) {
  const tokens = normalize(query.trim()).split(/\s+/).filter(Boolean);
  return graph.nodes.filter(node => (!type || node.type === type) && (!tag || node.tags.includes(tag)))
    .map(node => {
      const title = normalize(node.title), tags = normalize(node.tags.join(' ')), body = normalize(node.body);
      if (!tokens.every(t => `${title} ${tags} ${body}`.includes(t))) return null;
      return { node, score: tokens.reduce((sum, t) => sum + (title.includes(t) ? 8 : 0) + (tags.includes(t) ? 4 : 0) + (body.includes(t) ? 1 : 0), 0) };
    }).filter(Boolean).sort((a, b) => b.score - a.score || Date.parse(b.node.updatedAt) - Date.parse(a.node.updatedAt) || a.node.id.localeCompare(b.node.id)).map(r => r.node);
}
export function neighborhood(graph, nodeId, depth = 1) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 5) fail('深度须为 0–5 的整数');
  if (!graph.nodes.some(node => node.id === nodeId)) fail('节点不存在');
  const visited = new Set([nodeId]); let frontier = new Set([nodeId]);
  for (let i = 0; i < depth; i++) {
    const next = new Set();
    for (const edge of graph.edges) {
      if (frontier.has(edge.from) && !visited.has(edge.to)) next.add(edge.to);
      if (frontier.has(edge.to) && !visited.has(edge.from)) next.add(edge.from);
    }
    next.forEach(id => visited.add(id)); frontier = next;
  }
  return { nodes: graph.nodes.filter(n => visited.has(n.id)), edges: graph.edges.filter(e => visited.has(e.from) && visited.has(e.to)) };
}
export function graphStats(graph) {
  const degree = new Map(graph.nodes.map(n => [n.id, 0]));
  graph.edges.forEach(e => { degree.set(e.from, degree.get(e.from) + 1); degree.set(e.to, degree.get(e.to) + 1); });
  return { nodes: graph.nodes.length, edges: graph.edges.length, isolated: [...degree.values()].filter(d => d === 0).length,
    hubs: [...degree].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, connections]) => ({ id, connections })) };
}
