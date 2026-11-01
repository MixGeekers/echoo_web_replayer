'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { cssText } = require('./shared/replay-urls.js');

const RESOURCE_TYPES = new Set(['Stylesheet', 'Image', 'Font']);
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

class ResourceRecorder {
  constructor(store, webContents, onChange = () => {}) {
    this.store = store; this.webContents = webContents; this.onChange = onChange;
    this.current = new Map(); this.pending = new Map(); this.jobs = new Set();
    this.saved = new Map(); this.catalogs = new Map(); this.misses = new Map();
    this.sessionId = null; this.cacheBytes = 0; this.generation = 0;
    this.queue = Promise.resolve(); this.captureError = null;
  }
  async init(root) {
    this.cache = await fs.mkdtemp(path.join(root, '.resource-cache-'));
    const debug = this.webContents.debugger;
    try {
      debug.attach('1.3');
      const { frameTree } = await debug.sendCommand('Page.getFrameTree');
      this.mainFrameId = frameTree.frame.id;
      debug.on('message', (_event, method, params) => this.onMessage(method, params));
      debug.on('detach', (_event, reason) => { this.captureError = `静态资源采集已断开：${reason}`; this.onChange(); });
      await debug.sendCommand('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: MAX_RESOURCE_BYTES });
    } catch (error) { this.captureError = `静态资源采集不可用：${error.message}`; }
    return this;
  }
  onMessage(method, params) {
    if (method === 'Network.requestWillBeSent' && params.type === 'Document' && params.frameId === this.mainFrameId) {
      this.current.clear(); this.generation++;
    }
    if (method === 'Network.responseReceived' && RESOURCE_TYPES.has(params.type)) {
      if (this.pending.size >= 5000) return;
      this.pending.set(params.requestId, { url: params.response.url.split('#')[0], mimeType: params.response.mimeType, type: params.type,
        statusCode: params.response.status, capturedAt: new Date().toISOString(), generation: this.generation,
        sessionId: this.sessionId, expectedBytes: Number(params.response.headers?.['content-length'] || params.response.headers?.['Content-Length'] || 0) });
    }
    if (method === 'Network.loadingFailed') {
      const entry = this.pending.get(params.requestId); this.pending.delete(params.requestId);
      if (entry) this.schedule(async () => this.accept({ ...entry, error: params.errorText, status: 'missing' }));
    }
    if (method !== 'Network.loadingFinished') return;
    const entry = this.pending.get(params.requestId); this.pending.delete(params.requestId);
    if (!entry) return;
    this.schedule(async () => {
      try {
        if (entry.statusCode >= 400) throw new Error(`HTTP ${entry.statusCode}`);
        if (entry.expectedBytes > MAX_RESOURCE_BYTES || params.encodedDataLength > MAX_RESOURCE_BYTES) throw new Error('资源超过 16 MB 保存上限');
        if (this.cacheBytes >= MAX_CACHE_BYTES) throw new Error('本次运行的静态资源缓存达到 256 MB 上限');
        const response = await this.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const body = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
        if (body.length > MAX_RESOURCE_BYTES || body.length + this.cacheBytes > MAX_CACHE_BYTES) throw new Error('静态资源超过缓存容量上限');
        const sha256 = createHash('sha256').update(body).digest('hex');
        const filename = path.join(this.cache, sha256);
        try { await fs.writeFile(filename, body, { flag: 'wx' }); this.cacheBytes += body.length; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await this.accept({ ...entry, sha256, bytes: body.length, status: 'saved' }, filename);
      } catch (error) { await this.accept({ ...entry, status: 'missing', error: error.message }); }
    });
  }
  schedule(task) {
    const job = this.queue.then(task).catch(error => { this.captureError = `保存静态资源失败：${error.message}`; this.onChange(); });
    this.queue = job; this.jobs.add(job); job.finally(() => this.jobs.delete(job));
  }
  async accept(entry, filename) {
    if (entry.generation === this.generation && this.current.size < 5000) this.current.set(entry.url, { entry, filename });
    if (this.sessionId && (entry.sessionId === this.sessionId || (!entry.sessionId && entry.generation === this.generation))) await this.persist(entry, filename);
  }
  async persist(entry, filename) {
    const id = this.sessionId;
    if (!id || this.store.getSession(id).status !== 'recording') return;
    const key = `${id}:${entry.url}`, signature = entry.sha256 || entry.error;
    if (this.saved.get(key) === signature) return;
    const { generation, sessionId, expectedBytes, ...record } = entry;
    await this.store.saveResource(id, record, filename);
    this.saved.set(key, signature); this.catalogs.delete(id); this.onChange();
  }
  async start(id) {
    await this.flush(); this.sessionId = id;
    for (const { entry, filename } of this.current.values()) await this.persist(entry, filename);
  }
  async flush() { await this.queue; }
  async stop() { await this.flush(); this.sessionId = null; }
  async catalog(id) {
    const directory = this.store.getSessionDirectory(id);
    this.store.getSession(id);
    const filename = path.join(directory, 'resources.jsonl');
    const size = await fs.stat(filename).then(stat => stat.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
    if (this.catalogs.get(id)?.size === size) return this.catalogs.get(id).entries;
    if (size > 32 * 1024 * 1024) throw new Error('静态资源索引超过读取上限');
    const text = size ? await fs.readFile(filename, 'utf8') : '';
    const entries = text.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
    if (this.catalogs.size >= 3) this.catalogs.delete(this.catalogs.keys().next().value);
    this.catalogs.set(id, { size, entries }); return entries;
  }
  async summary(id, endSeq = Infinity) {
    const entries = (await this.catalog(id)).filter(entry => entry.seq <= endSeq);
    const latest = new Map(entries.map(entry => [entry.url, entry]));
    const missing = new Set([...latest.values()].filter(entry => entry.status !== 'saved').map(entry => entry.url));
    for (const url of this.misses.get(id) || []) missing.add(url);
    return { available: entries.length > 0, saved: [...latest.values()].filter(entry => entry.sha256).length,
      missing: missing.size, missingURLs: [...missing].slice(0, 30), bytes: [...new Map(entries.filter(entry => entry.sha256).map(entry => [entry.sha256, entry.bytes])).values()].reduce((a, b) => a + b, 0), captureError: this.captureError };
  }
  async respond(request) {
    let id, url;
    try {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      const requestURL = new URL(request.url);
      if (requestURL.hostname !== 'asset') return new Response(null, { status: 404 });
      id = decodeURIComponent(requestURL.pathname.slice(1)); url = requestURL.searchParams.get('url');
      const at = Math.max(0, Number(requestURL.searchParams.get('at')) || 0);
      const endSeq = Math.max(0, Number(requestURL.searchParams.get('end') ?? at) || 0);
      const entries = (await this.catalog(id)).filter(entry => entry.url === url && entry.sha256 && entry.seq <= endSeq);
      const entry = entries.filter(entry => entry.seq <= at).at(-1) || entries[0];
      if (!entry) {
        // Existing demo recordings can still use bundled assets; arbitrary file URLs never reach the filesystem.
        if (url?.startsWith('file:')) {
          const file = fileURLToPath(url);
          if (['demo', 'shared'].some(folder => file.startsWith(path.join(__dirname, folder) + path.sep)) && /\.(css|svg|png|jpg|woff2?)$/i.test(file)) {
            const data = await fs.readFile(file);
            const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
            return this.response(data, type, url, id, at, endSeq);
          }
        }
        if (!this.misses.has(id)) this.misses.set(id, new Set());
        if (this.misses.get(id).size < 5000) this.misses.get(id).add(url);
        return new Response(null, { status: 404 });
      }
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('无效的资源路径');
      const body = await fs.readFile(path.join(this.store.getSessionDirectory(id), 'assets', entry.sha256));
      if (createHash('sha256').update(body).digest('hex') !== entry.sha256) throw new Error('资源校验失败');
      this.misses.get(id)?.delete(url);
      return this.response(body, entry.mimeType, url, id, at, endSeq);
    } catch {
      if (id && url && this.catalogs.has(id)) {
        if (!this.misses.has(id)) this.misses.set(id, new Set());
        if (this.misses.get(id).size < 5000) this.misses.get(id).add(url);
      }
      return new Response(null, { status: 404 });
    }
  }
  response(body, mimeType, url, id, at, endSeq) {
    if (mimeType === 'text/css') body = Buffer.from(cssText(body.toString('utf8'), url, id, at, endSeq));
    return new Response(body, { headers: { 'Content-Type': mimeType || 'application/octet-stream', 'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' tracedock-resource:; img-src data: tracedock-resource:; font-src data: tracedock-resource:", 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  async close() {
    await this.stop();
    if (this.webContents.debugger.isAttached()) this.webContents.debugger.detach();
    if (this.cache) await fs.rm(this.cache, { recursive: true, force: true });
  }
}

module.exports = { ResourceRecorder };
