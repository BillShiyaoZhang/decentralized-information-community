import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { GraphError, graphStats, neighborhood, searchGraph } from '../packages/core/index.js';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
function authorized(header, token) {
  if (!token || typeof header !== 'string') return false;
  const actual = Buffer.from(header), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new GraphError('提案超过 2 MB'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GraphError('无效 JSON'); }
}
export function createApp({ root, store = null, writeToken = '', api = !!store }) {
  const directory = resolve(root);
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/runtime-config.json' && req.method === 'GET') return send(res, 200, { mode: api ? 'server' : 'static', graphUrl: './data/graph.json', apiUrl: './api' });
      if (api && url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
        if (req.method === 'GET' && url.pathname === '/api/graph') return send(res, 200, store.load());
        if (req.method === 'GET' && url.pathname === '/api/search') return send(res, 200, searchGraph(store.load(), { query: url.searchParams.get('q') ?? '', type: url.searchParams.get('type') ?? '' }));
        if (req.method === 'GET' && url.pathname === '/api/analysis') return send(res, 200, graphStats(store.load()));
        if (req.method === 'GET' && url.pathname === '/api/neighborhood') return send(res, 200, neighborhood(store.load(), url.searchParams.get('id'), Number(url.searchParams.get('depth') ?? 1)));
        if (req.method === 'POST' && url.pathname === '/api/changes') {
          if (!authorized(req.headers.authorization, writeToken)) return send(res, 401, { error: '需要有效的写入令牌' });
          if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: '需要 application/json' });
          return send(res, 200, store.commit(await body(req)));
        }
        return send(res, 404, { error: '接口不存在' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: '方法不支持' });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: '无效路径' }); }
      const path = resolve(directory, '.' + (pathname.endsWith('/') ? `${pathname}index.html` : pathname));
      if (!path.startsWith(directory + sep) || pathname.includes('\\') || pathname.includes('\0')) return send(res, 403, { error: '路径不可访问' });
      let file; try { file = await readFile(path); } catch { return send(res, 404, { error: '文件不存在' }); }
      res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      const status = error.code === 'CONFLICT' ? 409 : error instanceof GraphError ? 400 : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) send(res, status, { error: status === 500 ? '服务器内部错误' : error.message });
      else res.end();
    }
  });
}
