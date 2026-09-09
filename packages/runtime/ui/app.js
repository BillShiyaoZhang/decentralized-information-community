let token = '';
const el = id => document.getElementById(id);
async function api(path, { method = 'GET', data, key } = {}) {
  const response = await fetch('/api/' + path, { method, cache: 'no-store', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${body.code ?? response.status}: ${typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? '操作失败'}`);
  return body;
}
async function refresh(query = '') {
  try {
    const graph = await api('graph');
    const nodes = query ? await api('search?q=' + encodeURIComponent(query)) : graph.nodes;
    el('cards').replaceChildren(); el('summary').textContent = `${nodes.length} 条公开内容`;
    for (const node of nodes) {
      const card = document.createElement('article'), title = document.createElement('h3'), body = document.createElement('p');
      title.textContent = node.title; body.textContent = node.body; card.append(title, body);
      if (node.source) { const link = document.createElement('a'); link.href = node.source; link.rel = 'noreferrer'; link.textContent = '查看来源'; card.append(link); }
      if (node.warnings?.length) { const warning = document.createElement('p'); warning.className = 'warning'; warning.textContent = node.warnings.join(' / '); card.append(warning); }
      el('cards').append(card);
    }
  } catch (error) { el('summary').textContent = error.message; }
}
el('search').addEventListener('submit', event => { event.preventDefault(); refresh(new FormData(event.target).get('query')); });
el('login').addEventListener('submit', async event => {
  event.preventDefault();
  try { const response = await api('auth/login', { method: 'POST', data: Object.fromEntries(new FormData(event.target)) }); token = response.token; el('identity').textContent = '已登录'; el('editor').hidden = false; event.target.reset(); }
  catch (error) { el('identity').textContent = error.message; }
});
el('logout').addEventListener('click', async () => { try { await api('auth/logout', { method: 'POST', data: {} }); } catch {} token = ''; el('identity').textContent = '已退出本设备'; el('editor').hidden = true; el('result').textContent = ''; });
el('operation').addEventListener('submit', async event => {
  event.preventDefault();
  try { const fields = new FormData(event.target); const result = await api(fields.get('route'), { method: 'POST', data: JSON.parse(fields.get('payload')), key: crypto.randomUUID() }); el('result').textContent = JSON.stringify(result, null, 2); await refresh(); }
  catch (error) { el('result').textContent = error.message; }
});
el('private-list').addEventListener('click', async () => { try { el('result').textContent = JSON.stringify(await api('private/list'), null, 2); } catch (error) { el('result').textContent = error.message; } });
await refresh();
