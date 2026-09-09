import { createServer } from 'node:http';
import { graphStats, neighborhood } from '@information-community/core';
import { RuntimeError } from './errors.mjs';
import { defaultRolePermissions, executeAuthorized, localIdentityProvider, login, readAuthorized, revokeSession } from './auth.mjs';
import { getEntity, hideContent, importContent, projectPublic, publicContentExport, publishContent, readPublicRevision, readRevision, setSourceDisposition } from './content.mjs';
import { lifecycleCommand, lifecycleDetail, lifecycleList, lifecyclePublicResults } from './lifecycle.mjs';

const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const fail = (code, message, status = 400) => { throw new RuntimeError(code, message, status); };
async function body(req) {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) fail('UNSUPPORTED_MEDIA_TYPE', '需要 application/json', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) fail('PAYLOAD_TOO_LARGE', '请求超过 2 MiB', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { fail('INVALID_JSON', '请求必须是 JSON 对象'); }
}
function scopeFilter(url) {
  const input = url.searchParams.get('scope');
  if (!input) return undefined;
  try { const scope = JSON.parse(input); if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.values(scope).some(values => !Array.isArray(values) || values.some(value => typeof value !== 'string'))) throw new Error(); return scope; }
  catch { fail('INVALID_SCOPE', 'scope 必须是维度到范围 ID 数组的 JSON 对象'); }
}

/**
 * Governed HTTP runtime. Only explicit in-memory UI assets are served: no path
 * can fall through to a database, backup, private draft or stale static graph.
 * A custom identity provider is trusted server code and must synchronously
 * validate its named MFA principal and revocation state inside each transaction.
 */
export function createRuntimeApp({ store, auth = {}, lifecycle = {}, assets = {}, clock = Date.now }) {
  const policy = auth.rolePermissions ?? defaultRolePermissions;
  const provider = auth.provider ?? localIdentityProvider;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://runtime.local'), path = url.pathname;
      const token = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(res, 405, { error: '方法不支持', code: 'METHOD_NOT_ALLOWED' });
      if (req.method === 'POST') {
        // Consume the entire untrusted body before opening the transaction or
        // verifying the session: a logout during upload must take effect.
        const input = await body(req), now = clock();
        if (path === '/api/auth/login') return send(res, 200, login(store, input, { mfaKey: auth.mfaKey, now }));
        if (path === '/api/auth/logout') return send(res, 200, revokeSession(store, token, { now, policy }));
        if (path === '/api/auth/revoke') return send(res, 200, revokeSession(store, token, { sessionId: input.sessionId, now, policy }));
        const key = req.headers['idempotency-key'];
        const protectedOperation = (permission, action, handler, replayable = true, audit = true) => {
          return executeAuthorized(store, token, { permission, action, key: replayable ? key : null, input, policy, provider, now, audit }, (state, principal) => {
            if (replayable && !key) fail('IDEMPOTENCY_KEY_REQUIRED', '写入需要 Idempotency-Key');
            return handler(state, principal);
          });
        };
        const commands = {
          '/api/content/import': ['content:edit', 'content.import', importContent],
          '/api/content/publish': ['content:publish', 'content.publish', publishContent],
          '/api/content/hide': ['content:visibility', 'content.hide', hideContent],
          '/api/content/source': ['content:visibility', 'content.source', setSourceDisposition],
        };
        if (Object.hasOwn(commands, path)) {
          const [permission, action, command] = commands[path];
          const result = protectedOperation(permission, action, (state, principal) => {
            // author/reviewer fields in the body are descriptive data only;
            // audit identity is supplied by executeAuthorized's verified session.
            state.modules.content = command(state.modules.content, action === 'content.import' ? input : { ...input, now: new Date(now).toISOString() });
            if (action === 'content.import') return { imported: true };
            const entity = getEntity(state.modules.content, input.entityId);
            return { entityId: entity.id, version: entity.version, publicRevisionId: entity.publicRevisionId ?? null };
          });
          return send(res, 200, result);
        }
        if (path === '/api/private/command') {
          if (!['create', 'transition', 'consent', 'withdraw', 'logout', 'retain', 'task', 'import'].includes(input.action)) fail('INVALID_ACTION', '无效私有生命周期操作');
          const permission = ['consent', 'create', 'withdraw', 'logout'].includes(input.action) ? ['lifecycle:self', 'lifecycle:manage'] : input.action === 'retain' || input.action === 'task' ? ['lifecycle:manage', 'operations:manage'] : 'lifecycle:manage';
          return send(res, 200, protectedOperation(permission, `private.${input.action}`, (state, principal) => lifecycleCommand(state, principal, input, { ...lifecycle, policy, now }), !['withdraw', 'logout'].includes(input.action), false));
        }
        return send(res, 404, { error: '接口不存在', code: 'NOT_FOUND' });
      }
      if (req.method === 'GET' && path.startsWith('/api/')) {
        const now = clock();
        if (path === '/api/health') return send(res, 200, { ok: true, mode: 'governed', staticExport: false });
        if (path === '/api/auth/me') return send(res, 200, store.transact(state => provider.authenticate(state, token, { now })));
        if (path === '/api/private/list') return send(res, 200, readAuthorized(store, token, { permission: 'lifecycle:manage', policy, provider, now }, state => lifecycleList(state)));
        if (path.startsWith('/api/private/')) return send(res, 200, readAuthorized(store, token, { permission: ['lifecycle:manage', 'lifecycle:self'], policy, provider, now }, (state, principal) => lifecycleDetail(state, principal, decodeURIComponent(path.slice('/api/private/'.length)), { ...lifecycle, policy, now })));
        if (path.startsWith('/api/editor/revisions/')) return send(res, 200, readAuthorized(store, token, { permission: 'content:read', policy, provider, now }, state => readRevision(state.modules.content, decodeURIComponent(path.slice('/api/editor/revisions/'.length)))));
        const state = store.read(), data = state.modules.content, contentNow = new Date(now).toISOString();
        if (path === '/api/public-results') {
          const visible = new Set(projectPublic(data, { now: contentNow }).nodes.map(value => value.id));
          return send(res, 200, lifecyclePublicResults(state, { now }).filter(value => visible.has(value.entityId) && (!value.revisionId || readPublicRevision(data, value.revisionId, { now: contentNow }))));
        }
        if (path.startsWith('/api/revisions/')) {
          const revision = readPublicRevision(data, decodeURIComponent(path.slice('/api/revisions/'.length)), { now: contentNow });
          return revision ? send(res, 200, revision) : send(res, 404, { error: '内容不可公开', code: 'NOT_FOUND' });
        }
        if (path.startsWith('/api/entities/')) {
          const parts = path.slice('/api/entities/'.length).split('/'), entityId = decodeURIComponent(parts[0]);
          const graph = projectPublic(data, { now: contentNow, communityId: state.communityId, revision: state.revision }), node = graph.nodes.find(value => value.id === entityId);
          if (!node) return send(res, 404, { error: '内容不可公开', code: 'NOT_FOUND' });
          if (parts.length === 1 || parts[1] === 'detail') return send(res, 200, node);
          if (parts[1] === 'history') return send(res, 200, data.revisions.filter(value => value.entityId === entityId).map(value => readPublicRevision(data, value.id, { now: contentNow })).filter(Boolean));
        }
        if (path === '/api/export') return send(res, 200, publicContentExport(data, { now: contentNow }));
        const graph = projectPublic(data, { now: contentNow, communityId: state.communityId, revision: state.revision, query: path === '/api/search' ? url.searchParams.get('q') ?? '' : undefined, scope: scopeFilter(url) });
        if (path === '/api/graph') return send(res, 200, graph);
        if (path === '/api/list') return send(res, 200, graph.nodes);
        if (path === '/api/search') return send(res, 200, graph.nodes);
        if (path === '/api/analysis') return send(res, 200, graphStats(graph));
        if (path === '/api/neighborhood') return send(res, 200, neighborhood(graph, url.searchParams.get('id'), Number(url.searchParams.get('depth') ?? 1)));
        return send(res, 404, { error: '接口不存在', code: 'NOT_FOUND' });
      }
      if (path === '/runtime-config.json') return send(res, 200, { mode: 'governed', apiUrl: './api', graphUrl: './api/graph', staticExport: false });
      // Compatibility data URL deliberately applies the same live public policy.
      if (path === '/data/graph.json' && req.method === 'GET') { const state = store.read(); return send(res, 200, projectPublic(state.modules.content, { now: new Date(clock()).toISOString(), communityId: state.communityId, revision: state.revision })); }
      if (Object.hasOwn(assets, path) && !path.startsWith('/api/') && !path.startsWith('/data/')) {
        const asset = assets[path]; res.writeHead(200, { 'Content-Type': asset.type ?? 'application/octet-stream' }); return res.end(req.method === 'HEAD' ? undefined : asset.body);
      }
      return send(res, 404, { error: '接口或文件不存在', code: 'NOT_FOUND' });
    } catch (error) {
      const status = error instanceof RuntimeError ? error.status : error.name === 'GraphError' ? 400 : 500;
      if (!res.headersSent) send(res, status, { error: status === 500 ? '服务器内部错误' : error.message, code: status === 500 ? 'INTERNAL_ERROR' : error.code }); else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
