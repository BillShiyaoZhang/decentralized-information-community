import { applyChange, makeChange, searchGraph, graphStats, safeUrl } from './packages/core/index.js';
import { StaticAdapter, HttpAdapter } from './packages/adapters/index.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icons = {
  network: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="9" r="3"/><circle cx="9" cy="19" r="3"/><path d="m8.8 6.7 6.4 1.6M7 9l1 7m8-5-5 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  book: '<path d="M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4zM12 6v15"/>',
  note: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6"/>',
  link: '<path d="m9 15 6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2m-3 5-2 2a5 5 0 0 1-7-7l2-2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c6 5 6 13 0 18-6-5-6-13 0-18"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.note}</svg>`;
const state = { graph: null, selected: '', query: '', type: '', view: 'cards', adapter: null, site: {} };
const typeInfo = id => state.graph.ontology.nodeTypes.find(t => t.id === id);
const typeIndex = id => state.graph.ontology.nodeTypes.findIndex(t => t.id === id) % 4;
const nodeIcon = type => ['book', 'note', 'link', 'network'][typeIndex(type)] ?? 'note';
const badge = node => `<span class="badge type-${typeIndex(node.type)}">${icon(nodeIcon(node.type))}${esc(typeInfo(node.type)?.label ?? node.type)}</span>`;
function notify(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(() => $('#toast').hidden = true, 6000); }
function download(filename, data, raw = false) {
  const url = URL.createObjectURL(new Blob([raw ? data : JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function selectNode(id) { if (!state.graph.nodes.some(n => n.id === id)) return; state.selected = id; location.hash = encodeURIComponent(id); renderContent(); }
function shell() {
  const g = state.graph;
  $('#app').innerHTML = `<div class="workspace">
    <aside class="sidebar">
      <a class="brand" href="#" aria-label="社区首页"><span class="brand-mark">${icon('network')}</span><span>${esc(state.site.brand)}<span class="brand-en">${esc(state.site.brandCaption)}</span></span></a>
      <div class="community-label">当前社区</div><div class="community-name">${esc(g.title)}<span>${esc(state.site.tagline)}</span></div>
      <nav aria-label="内容类型"><button class="nav-item active" data-filter="">${icon('globe')}全部内容<span>${g.nodes.length}</span></button>${g.ontology.nodeTypes.map(t => `<button class="nav-item" data-filter="${esc(t.id)}">${icon(nodeIcon(t.id))}${esc(t.label)}<span>${g.nodes.filter(n => n.type === t.id).length}</span></button>`).join('')}</nav>
      <div class="side-section"><span class="eyebrow">社区结构</span><button class="nav-item" data-action="blueprint">${icon('network')}类型与关系蓝图</button></div>
      <div class="sidebar-bottom"><div class="mode-label">${icon(state.adapter.kind === 'static' ? 'globe' : 'network')}<span>${state.adapter.kind === 'static' ? '静态社区' : '私有服务器'}<small>${state.adapter.kind === 'static' ? '公开快照 · 本机草稿' : 'SQLite 持久化 · 共享写入'}</small></span></div><button class="side-button" data-action="transfer">${icon('download')}数据与提案</button>${state.adapter.kind === 'server' ? '<button class="side-button" data-action="access">设置写入令牌</button>' : ''}<div class="version">COMMUNITY ENGINE <span>v0.2</span></div></div>
    </aside>
    <main id="main"><header class="topbar"><div class="breadcrumb">社区知识网络<span>/</span><strong>${esc(g.title)}</strong></div><span class="avatar" aria-label="访客">访</span></header>
      <section class="page-heading"><div><div class="eyebrow">KNOWLEDGE, CONNECTED</div><h1>${esc(state.site.heading)}</h1><p>${esc(g.description ?? '从一个话题开始，一起补充、连接和发现。')}</p></div><button class="primary" data-action="create">${icon('plus')}贡献内容</button></section>
      <div class="notice" id="notice"></div>
      <section class="work-area" aria-label="知识工作区"><div class="collection"><div class="collection-toolbar"><label class="search">${icon('search')}<input id="search" type="search" placeholder="搜索话题、经验或关键词…" aria-label="搜索知识网络" autocomplete="off"><kbd>/</kbd></label><div class="view-switch" role="group" aria-label="显示方式"><button data-view="cards" class="active" aria-label="卡片视图" aria-pressed="true">${icon('grid')}</button><button data-view="graph" aria-label="关系图视图" aria-pressed="false">${icon('network')}</button></div></div><div id="results-meta"></div><div id="results"></div></div><aside id="detail" class="detail" aria-label="内容详情"></aside></section>
      <footer class="page-footer"><span>${esc(state.site.footer)}</span><span id="graph-stats"></span></footer>
    </main></div>`;
  $('#search').value = state.query;
  $('#search').addEventListener('input', e => { state.query = e.target.value; renderContent(); });
  renderContent();
}
function renderContent() {
  const g = state.graph, results = searchGraph(g, { query: state.query, type: state.type });
  document.querySelectorAll('[data-filter]').forEach(b => { b.classList.toggle('active', b.dataset.filter === state.type); b.setAttribute('aria-current', b.dataset.filter === state.type ? 'page' : 'false'); });
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === state.view); b.setAttribute('aria-pressed', String(b.dataset.view === state.view)); });
  const stats = graphStats(g);
  $('#graph-stats').textContent = `${stats.nodes} 个节点 · ${stats.edges} 条关联 · v${g.revision}`;
  $('#results-meta').innerHTML = `<h2>${esc(state.type ? typeInfo(state.type).label : '探索知识')} <span>${results.length}</span></h2><span>${state.query ? '按相关度排序' : state.view === 'graph' ? '点击节点，沿着关联探索' : '最近更新'}</span>`;
  const draftCount = state.adapter.kind === 'static' ? state.adapter.proposal().operations.length : 0;
  $('#notice').innerHTML = `${icon('network')}<span>${esc(state.adapter.warning || (state.adapter.kind === 'static' ? (draftCount ? `有 ${draftCount} 项本机修改。导出提案，经维护者合并后，其他人才能看到。` : '这是静态演示。你的贡献会保存为本机草稿，可导出提案交给社区维护者。') : '贡献保存到社区服务器。写入需要维护者提供的令牌；遇到版本冲突请先刷新。'))}</span><button data-action="${state.adapter.kind === 'static' ? 'transfer' : 'refresh'}">${state.adapter.kind === 'static' ? '管理提案' : '刷新数据'} ${icon('arrow')}</button>`;
  if (!results.length) $('#results').innerHTML = `<div class="empty">${icon('search')}<h3>还没有找到相关内容</h3><p>试试更短的关键词，或创建一个新话题。</p><button class="secondary" data-action="clear">清除筛选</button></div>`;
  else if (state.view === 'graph') renderGraph(results);
  else $('#results').innerHTML = `<div class="cards">${results.map(node => {
    const connections = g.edges.filter(e => e.from === node.id || e.to === node.id).length;
    return `<button class="content-card ${node.id === state.selected ? 'selected' : ''}" data-node="${esc(node.id)}" aria-pressed="${node.id === state.selected}"><div class="card-top">${badge(node)}<span>${connections} 条关联 ${icon('network')}</span></div><h3>${esc(node.title)}</h3><p>${esc(node.body || '这个话题正在等待大家补充。')}</p><div class="tags">${node.tags.slice(0, 3).map(t => `<span># ${esc(t)}</span>`).join('')}</div><div class="card-bottom"><span><i class="tiny-avatar">${esc(node.author.slice(0, 1))}</i>${esc(node.author)}</span><span>${esc(node.updatedAt.slice(5, 10).replace('-', '/'))}</span></div></button>`;
  }).join('')}</div>`;
  renderDetail();
}
function renderGraph(results) {
  const g = state.graph, ids = new Set(results.map(n => n.id));
  const center = { x: 380, y: 230 }, radius = Math.min(178, 90 + results.length * 8);
  const positions = new Map(results.map((node, i) => [node.id, results.length === 1 ? center : { x: center.x + Math.cos(i / results.length * Math.PI * 2 - Math.PI / 2) * radius * 1.45, y: center.y + Math.sin(i / results.length * Math.PI * 2 - Math.PI / 2) * radius }]));
  const edges = g.edges.filter(e => ids.has(e.from) && ids.has(e.to));
  $('#results').innerHTML = `<div class="graph-surface"><div class="graph-legend">${g.ontology.nodeTypes.map((t, i) => `<span><i class="dot type-${i % 4}"></i>${esc(t.label)}</span>`).join('')}</div><svg class="knowledge-graph" viewBox="0 0 760 460" role="img" aria-label="当前筛选下的知识关联图"><defs><marker id="edge-arrow" markerWidth="6" markerHeight="6" refX="28" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L6 3L0 6" fill="#91a6b2"/></marker></defs>${edges.map(edge => { const from = positions.get(edge.from), to = positions.get(edge.to); return `<path d="M${from.x},${from.y}L${to.x},${to.y}" class="graph-edge ${edge.from === state.selected || edge.to === state.selected ? 'connected' : ''}" marker-end="url(#edge-arrow)"><title>${esc(edge.reason)}</title></path>`; }).join('')}${results.map(n => { const p = positions.get(n.id); return `<g class="graph-node type-${typeIndex(n.type)} ${n.id === state.selected ? 'selected' : ''}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" data-node="${esc(n.id)}" aria-label="查看${esc(n.title)}"><circle r="${n.type === g.ontology.nodeTypes[0].id ? 23 : 17}"/><circle class="node-core" r="5"/><text y="43" text-anchor="middle">${esc(n.title.length > 13 ? n.title.slice(0, 12) + '…' : n.title)}</text><title>${esc(n.title)}</title></g>`; }).join('')}</svg><div class="graph-caption">关系箭头表示方向，详细理由见右侧内容。</div></div><div class="graph-node-list">${results.map(n => `<button data-node="${esc(n.id)}">${badge(n)}${esc(n.title)}</button>`).join('')}</div>`;
}
function renderDetail() {
  const node = state.graph.nodes.find(n => n.id === state.selected);
  if (!node) { $('#detail').innerHTML = '<div class="empty"><h3>选择一条内容</h3><p>查看它的来源和相邻知识。</p></div>'; return; }
  const edges = state.graph.edges.filter(e => e.from === node.id || e.to === node.id);
  $('#detail').innerHTML = `<div class="detail-header"><span>知识详情</span><button class="icon-button" data-action="edit" aria-label="编辑当前内容">${icon('edit')}</button></div><div class="detail-body">${badge(node)}<h2>${esc(node.title)}</h2><div class="byline"><i class="tiny-avatar">${esc(node.author.slice(0, 1))}</i><span>${esc(node.author)}<small>更新于 ${esc(node.updatedAt.slice(0, 10))}</small></span></div><p class="article-body">${esc(node.body || '这个话题正在等待大家补充。')}</p>${node.source && safeUrl(node.source) ? `<a class="source-link" href="${esc(node.source)}" target="_blank" rel="noopener noreferrer">${icon('link')}查看原始来源 ${icon('arrow')}</a>` : ''}<div class="tags detail-tags">${node.tags.map(t => `<button data-tag="${esc(t)}"># ${esc(t)}</button>`).join('')}</div><div class="relationship-heading"><h3>连接的知识 <span>${edges.length}</span></h3><button class="icon-button" data-action="relate" aria-label="添加关联">${icon('plus')}</button></div>${edges.length ? edges.map(e => { const other = state.graph.nodes.find(n => n.id === (e.from === node.id ? e.to : e.from)); const relation = state.graph.ontology.relationTypes.find(r => r.id === e.type); return `<button class="relation-card" data-node="${esc(other.id)}"><div><span class="relation-type">${e.from === node.id ? '指向' : '来自'} · ${esc(relation.label)}</span>${icon('arrow')}</div><h4>${esc(other.title)}</h4><p>${esc(e.reason)}</p></button>`; }).join('') : '<p class="muted">还没有关联。把它连接到另一个话题，让经验更容易被发现。</p>'}<button class="contribute-inline" data-action="create">${icon('plus')}我来补充一条</button><div class="record-id">ID · ${esc(node.id)}</div></div>`;
}
const closeButton = '<button type="button" class="icon-button" data-close aria-label="关闭">' + icon('close') + '</button>';
async function save(operations) {
  state.graph = await state.adapter.commit(makeChange(state.graph, operations));
  shell(); notify(state.adapter.kind === 'static' ? '已保存本机草稿。导出提案后可提交给维护者。' : '已保存到社区服务器');
}
function editor(edit = false) {
  const old = edit ? state.graph.nodes.find(n => n.id === state.selected) : null;
  const types = state.graph.ontology.nodeTypes;
  $('#editor').innerHTML = `<form id="node-form"><div class="modal-header"><div><span class="eyebrow">CONTRIBUTE</span><h2 id="editor-title">${old ? '编辑内容' : '为社区补充一块知识'}</h2></div>${closeButton}</div><p class="modal-intro">${state.adapter.kind === 'static' ? '保存到本机草稿，导出提案后由维护者合并。' : '内容将写入社区服务器。请确认来源和适用范围。'}</p><div class="form-grid"><label>内容类型<select name="type">${types.map(t => `<option value="${esc(t.id)}" ${t.id === old?.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label><label>贡献者<input name="author" maxlength="80" required value="${esc(old?.author ?? '')}" placeholder="你的署名"></label></div><label>标题<input name="title" maxlength="160" required value="${esc(old?.title ?? '')}" placeholder="用一句话说明这份知识"></label><label>正文 <span id="body-hint"></span><textarea name="body" rows="5" maxlength="20000" placeholder="写下具体经验、适用背景和仍不确定的地方…">${esc(old?.body ?? '')}</textarea></label><label>来源链接 <span id="source-hint"></span><input name="source" type="url" maxlength="2048" value="${esc(old?.source ?? '')}" placeholder="https://…"></label><label>标签 <span>用逗号分隔，最多 12 个</span><input name="tags" value="${esc(old?.tags.join(', ') ?? '')}" placeholder="例如：新生, 学习"></label><output class="form-error" id="node-error" role="alert"></output><div class="modal-footer"><button type="button" class="secondary" data-close>取消</button><button class="primary" type="submit">${old ? '保存修改' : '创建内容'} ${icon('arrow')}</button></div></form>`;
  const form = $('#node-form');
  const hints = () => { const required = typeInfo(form.elements.type.value).required ?? []; form.elements.body.required = required.includes('body'); form.elements.source.required = required.includes('source'); $('#body-hint').textContent = required.includes('body') ? '必填' : '可稍后补充'; $('#source-hint').textContent = required.includes('source') ? '必填' : '可选'; };
  form.elements.type.addEventListener('change', hints); hints();
  form.addEventListener('submit', async event => {
    event.preventDefault(); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try {
      const data = new FormData(form);
      const node = { ...old, id: old?.id ?? `node-${crypto.randomUUID()}`, type: data.get('type'), title: data.get('title').trim(), author: data.get('author').trim(), body: data.get('body').trim(), source: data.get('source').trim(), tags: [...new Set(data.get('tags').split(/[,，]/).map(t => t.trim()).filter(Boolean))], updatedAt: new Date().toISOString() };
      await save([{ op: 'putNode', value: node }]); selectNode(node.id); $('#editor').close();
    } catch (error) { $('#node-error').textContent = error.message; } finally { submit.disabled = false; }
  });
  $('#editor').showModal();
}
function relate() {
  const selected = state.graph.nodes.find(n => n.id === state.selected);
  if (!selected) return;
  $('#relation').innerHTML = `<form id="relation-form"><div class="modal-header"><h2 id="relation-title">连接两份知识</h2>${closeButton}</div><p class="modal-intro">关系有方向。请为这条连接写下具体理由。</p><label>起点<select name="from">${state.graph.nodes.map(n => `<option value="${esc(n.id)}" ${n.id === selected.id ? 'selected' : ''}>${esc(n.title)}</option>`).join('')}</select></label><label>关系类型<select name="type"></select></label><label>终点<select name="to"></select></label><label>关联理由<textarea name="reason" rows="3" maxlength="500" required placeholder="为什么这两份知识值得联系在一起？"></textarea></label><output id="relation-error" class="form-error" role="alert"></output><div class="modal-footer"><button type="button" class="secondary" data-close>取消</button><button type="submit" class="primary">建立关联</button></div></form>`;
  const form = $('#relation-form');
  const updateTargets = () => {
    const rule = state.graph.ontology.relationTypes.find(r => r.id === form.elements.type.value);
    const targets = state.graph.nodes.filter(n => n.id !== form.elements.from.value && rule?.to.includes(n.type));
    form.elements.to.innerHTML = targets.map(n => `<option value="${esc(n.id)}">${esc(n.title)}</option>`).join('');
    form.querySelector('[type="submit"]').disabled = !targets.length;
    $('#relation-error').textContent = targets.length ? '' : '蓝图中没有可用的目标，请先创建内容或切换起点。';
  };
  const updateTypes = () => { const from = state.graph.nodes.find(n => n.id === form.elements.from.value); form.elements.type.innerHTML = state.graph.ontology.relationTypes.filter(r => r.from.includes(from.type)).map(r => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join(''); updateTargets(); };
  form.elements.from.addEventListener('change', updateTypes); form.elements.type.addEventListener('change', updateTargets); updateTypes();
  form.addEventListener('submit', async event => {
    event.preventDefault(); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try { const data = new FormData(form); await save([{ op: 'putEdge', value: { id: `edge-${crypto.randomUUID()}`, from: data.get('from'), to: data.get('to'), type: data.get('type'), reason: data.get('reason').trim() } }]); $('#relation').close(); }
    catch (error) { $('#relation-error').textContent = error.message; } finally { submit.disabled = false; }
  }); $('#relation').showModal();
}
function blueprint() {
  const o = state.graph.ontology;
  $('#blueprint').innerHTML = `<div class="modal-header"><div><span class="eyebrow">ONTOLOGY</span><h2 id="blueprint-title">这个社区的知识蓝图</h2></div>${closeButton}</div><p class="modal-intro">蓝图定义可以贡献什么、怎样连接。每次保存都会检查这些约束。</p><h3>内容类型</h3><div class="schema-types">${o.nodeTypes.map(t => `<div>${badge({ type: t.id })}<p>${t.required?.length ? '必填：' + t.required.map(k => ({ body: '正文', source: '来源' })[k]).join('、') : '允许先创建话题，随后补充'}</p></div>`).join('')}</div><h3>关系规则</h3><div class="schema-relations">${o.relationTypes.map(r => `<div><strong>${esc(r.label)}</strong><span>${r.from.map(t => esc(typeInfo(t).label)).join(' / ')} ${icon('arrow')} ${r.to.map(t => esc(typeInfo(t).label)).join(' / ')}</span></div>`).join('')}</div><p class="muted">实际内容及其关联构成知识图谱。更换社区时，可以替换这份蓝图和示例数据。</p>`;
  $('#blueprint').showModal();
}
function transfer() {
  const local = state.adapter.kind === 'static';
  $('#transfer').innerHTML = `<div class="modal-header"><h2 id="transfer-title">让知识可以带走</h2>${closeButton}</div><p class="modal-intro">快照用于迁移或部署；提案用于提交增量修改，保留版本检查。</p><div class="transfer-options"><button data-action="snapshot">${icon('download')}<span><strong>下载当前快照</strong><small>包含当前可见的全部节点、关系与蓝图</small></span></button>${local ? `<button data-action="proposal">${icon('note')}<span><strong>导出投稿提案</strong><small>交给维护者审核后，通过 Git 合并到社区</small></span></button>` : ''}<button data-action="import">${icon('plus')}<span><strong>导入投稿提案</strong><small>先校验和预览，再确认合并到${local ? '本机草稿' : '服务器'}</small></span></button>${local ? '<button data-action="raw-draft"><span><strong>备份原始草稿</strong><small>保留未能载入的旧版本草稿，便于手动恢复</small></span></button><button class="danger-text" data-action="reset-draft"><span><strong>清除本机草稿</strong><small>恢复到已发布快照，清除前请导出备份</small></span></button>' : ''}</div><output id="transfer-error" class="form-error" role="alert"></output>`;
  $('#transfer').showModal();
}
function access() {
  $('#access').innerHTML = `<form id="access-form"><div class="modal-header"><h2 id="access-title">服务器写入权限</h2>${closeButton}</div><p class="modal-intro">使用服务器配置的写入令牌。令牌仅存于此页面内存，刷新后需要重新输入。</p><label>写入令牌<input name="token" type="password" autocomplete="off" required></label><div class="modal-footer"><button class="primary">应用令牌</button></div></form>`;
  $('#access-form').addEventListener('submit', event => { event.preventDefault(); state.adapter.token = new FormData(event.target).get('token'); $('#access').close(); notify('令牌已用于本次会话；保存时会由服务器验证'); }); $('#access').showModal();
}
const actions = {
  create: () => editor(), edit: () => editor(true), relate, blueprint, transfer, access,
  clear: () => { state.query = ''; state.type = ''; $('#search').value = ''; renderContent(); },
  refresh: async () => { state.graph = await state.adapter.load(); shell(); notify('已载入最新数据'); },
  snapshot: () => download(`${state.graph.id}-snapshot.json`, state.graph),
  proposal: () => { const p = state.adapter.proposal(); if (!p.operations.length) throw new Error('还没有本机修改。先贡献一条内容吧。'); download(`${state.graph.id}-proposal.json`, p); notify('提案已导出；提交到社区仓库的 PR，经维护者审核后发布'); },
  'raw-draft': () => { const raw = state.adapter.rawDraft(); if (!raw) throw new Error('没有保留的草稿'); download(`${state.graph.id}-draft-backup.json`, raw, true); },
  'reset-draft': async () => { if (!confirm('清除所有本机修改并恢复已发布快照？请先导出需要保留的草稿。')) return; state.graph = await state.adapter.reset(); shell(); $('#transfer').close(); notify('已恢复到已发布快照'); },
  import: () => { $('#import-file').value = ''; $('#import-file').click(); }
};
document.addEventListener('click', async event => {
  const close = event.target.closest('[data-close]'); if (close) return close.closest('dialog').close();
  const node = event.target.closest('[data-node]'); if (node) return selectNode(node.dataset.node);
  const filter = event.target.closest('[data-filter]'); if (filter) { state.type = filter.dataset.filter; return renderContent(); }
  const view = event.target.closest('[data-view]'); if (view) { state.view = view.dataset.view; return renderContent(); }
  const tag = event.target.closest('[data-tag]'); if (tag) { state.query = tag.dataset.tag; $('#search').value = state.query; return renderContent(); }
  const action = event.target.closest('[data-action]'); if (!action) return;
  try { await actions[action.dataset.action]?.(); } catch (error) { const out = $('#transfer-error'); if ($('#transfer').open && out) out.textContent = error.message; else notify(error.message); }
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('dialog[open]')) { event.preventDefault(); $('#search')?.focus(); }
  if (['Enter', ' '].includes(event.key) && event.target.matches('g[data-node]')) { event.preventDefault(); selectNode(event.target.dataset.node); }
});
window.addEventListener('hashchange', () => { let id; try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; } if (state.graph?.nodes.some(n => n.id === id)) { state.selected = id; renderContent(); } });
window.addEventListener('storage', event => { if (state.adapter?.kind === 'static' && event.key === state.adapter.key) notify('另一标签页修改了草稿。请刷新以载入最新版本。'); });
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('提案文件不能超过 2 MB');
    const change = JSON.parse(await file.text()); const next = applyChange(state.graph, change);
    const preview = change.operations.slice(0, 8).map(o => o.op === 'putNode' ? o.value.title : o.value.reason).join('\n');
    if (!confirm(`将合并 ${change.operations.length} 项修改，得到 ${next.nodes.length} 个节点、${next.edges.length} 条关联。\n\n${preview}\n\n确认合并？`)) return;
    state.graph = await state.adapter.commit(change); shell(); $('#transfer').close(); notify('提案已合并');
  } catch (error) { $('#transfer-error').textContent = error.message; }
});
async function init() {
  try {
    const response = await fetch('./runtime-config.json', { cache: 'no-store' }); if (!response.ok) throw new Error('无法读取运行配置');
    const config = await response.json();
    state.site = config.site ?? {};
    state.adapter = config.mode === 'server' ? new HttpAdapter(config.apiUrl) : new StaticAdapter(config.graphUrl);
    state.graph = await state.adapter.load();
    let requested = ''; try { requested = decodeURIComponent(location.hash.slice(1)); } catch { /* invalid bookmark */ }
    state.selected = state.graph.nodes.some(n => n.id === requested) ? requested : state.graph.nodes[0]?.id ?? '';
    document.title = `${state.graph.title} · 社区知识网络`; shell();
    registerTools();
  } catch (error) { $('#app').innerHTML = `<div class="load-error"><h1>知识网络暂时无法载入</h1><p>${esc(error.message)}</p><button class="primary" id="retry">重新尝试</button></div>`; $('#retry').addEventListener('click', init); }
}
function registerTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const tools = [
    { name: 'search_community', title: '搜索社区知识', description: 'Search the current community and show matching results.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: input => { if (!input || typeof input.query !== 'string' || input.query.length > 200) throw new Error('query 必须是不超过 200 字符的文本'); state.query = input.query; state.type = ''; $('#search').value = input.query; renderContent(); return searchGraph(state.graph, { query: input.query }).map(n => ({ id: n.id, title: n.title, type: n.type })); } },
    { name: 'show_community_node', title: '查看知识详情', description: 'Navigate to an existing node and show its content and relationships.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: input => { const node = state.graph.nodes.find(n => n.id === input?.id); if (!node) throw new Error('节点不存在'); selectNode(node.id); return { node, edges: state.graph.edges.filter(e => e.from === node.id || e.to === node.id) }; } }
  ];
  for (const tool of tools) { try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* optional browser API */ } }
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
await init();
