import { applyChange, diffGraphs, validateGraph } from '../core/index.js';

/** Browser-only storage is explicitly a local draft over the shared static snapshot. */
export class StaticAdapter {
  constructor(url, storage) {
    this.url = url; this.kind = 'static'; this.warning = '';
    try { this.storage = storage ?? globalThis.localStorage; } catch { this.storage = null; this.warning = '浏览器限制了本地存储；仍可浏览公开快照。'; }
  }
  async load() {
    const response = await fetch(this.url, { cache: 'no-store' });
    if (!response.ok) throw new Error('无法载入社区快照');
    this.base = validateGraph(await response.json()); this.graph = structuredClone(this.base);
    this.key = `information-community:${this.base.id}:${new URL(this.url, globalThis.location?.href ?? 'http://localhost/').pathname}`;
    try {
      const stored = this.storage?.getItem(this.key) ?? null;
      this.cachedDraft = stored;
      if (stored) {
        const change = JSON.parse(stored);
        this.graph = applyChange(this.base, change);
      }
    } catch (error) {
      this.warning = `本地草稿未载入：${error.message}。原草稿仍保留，可下载备份后清除。`;
      this.blocked = true;
    }
    return structuredClone(this.graph);
  }
  async commit(change) {
    return this.guarded(() => this.save(change));
  }
  guarded(action) {
    return globalThis.navigator?.locks?.request ? navigator.locks.request(this.key, async () => action()) : Promise.resolve().then(action);
  }
  checkFresh() {
    if ((this.storage?.getItem(this.key) ?? null) !== (this.cachedDraft ?? null)) throw new Error('另一标签页修改了草稿，请刷新后再操作');
  }
  save(change) {
    this.checkFresh();
    if (this.blocked) throw new Error('请先下载并清除旧草稿，避免覆盖未合并的修改');
    const next = applyChange(this.graph, change);
    const proposal = diffGraphs(this.base, next);
    // Persist first so quota/privacy failures do not pretend a save succeeded.
    if (!this.storage) throw new Error('浏览器不支持本地存储，请启用后重试');
    const raw = JSON.stringify(proposal);
    this.storage.setItem(this.key, raw); this.cachedDraft = raw; this.graph = next;
    return structuredClone(next);
  }
  proposal() { return diffGraphs(this.base, this.graph); }
  rawDraft() { return this.storage?.getItem(this.key) ?? ''; }
  async reset() { return this.guarded(() => { this.checkFresh(); this.storage?.removeItem(this.key); this.cachedDraft = null; this.blocked = false; this.warning = ''; this.graph = structuredClone(this.base); return structuredClone(this.graph); }); }
}

export class HttpAdapter {
  constructor(baseUrl = './api') { this.url = baseUrl.replace(/\/$/, ''); this.kind = 'server'; this.token = ''; }
  async request(path, options = {}) {
    const response = await fetch(`${this.url}${path}`, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `请求失败 (${response.status})`);
    return data;
  }
  async load() { return validateGraph(await this.request('/graph')); }
  async commit(change) {
    return validateGraph(await this.request('/changes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, body: JSON.stringify(change) }));
  }
}
