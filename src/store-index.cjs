'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { scanTimeline, compactEventBounded } = require('./store-parser.cjs');
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const STATUSES = new Set(['recording', 'paused', 'stopped', 'interrupted']);
const ROW_BYTES = 48, IO_BYTES = 65536, MAX_FULL_DETAIL = 8 * 1024 * 1024;
const trim = (value, length = 280) => String(value ?? '').slice(0, length);

function summarize(event) {
  const p = event.payload || {};
  if (event.summary) return trim(event.summary);
  if (event.type === 'dom.snapshot') return `DOM 快照 · ${trim(p.reason || 'checkpoint')}`;
  if (event.type === 'dom.mutation') return `${p.mutations?.length ?? p.records?.length ?? p.count ?? 0} 项 DOM 变化`;
  if (event.type?.startsWith('action.')) {
    const target = p.target || {};
    return [event.type.slice(7), target.selector || p.selector || target.tagName || target.tag, target.text || target.textContent].filter(Boolean).map(value => trim(value)).join(' · ').slice(0, 280);
  }
  return [event.type, p.reason || p.url || p.message || ''].filter(Boolean).map(value => trim(value)).join(' · ').slice(0, 280);
}
function compactEvent(event) { return { ...compactEventBounded(event), summary: summarize(event) }; }
function category(type) {
  if (type.startsWith('action.')) return 1;
  if (type === 'dom.mutation') return 2;
  if (type === 'dom.snapshot') return 3;
  if (type.startsWith('page.')) return 4;
  if (type.startsWith('session.')) return 5;
  if (type.startsWith('recorder.')) return 6;
  return 0;
}
function categoryFilter(prefixes) {
  if (!prefixes.length) return null;
  const known = { action: [1], 'dom.mutation': [2], 'dom.snapshot': [3], dom: [2, 3], page: [4], session: [5], recorder: [6] };
  if (prefixes.some(prefix => !Object.hasOwn(known, prefix))) return undefined;
  return new Set(prefixes.flatMap(prefix => known[prefix]));
}
function newIndex() { return { generation: randomUUID(), count: 0, bytes: 0, summaryBytes: 0, categories: Array(7).fill(0), lastSeq: 0, lastElapsedMs: 0, dirty: false }; }
function encodeRow(row) {
  const value = Buffer.alloc(ROW_BYTES);
  value.writeDoubleLE(row.seq, 0); value.writeDoubleLE(row.offset, 8); value.writeDoubleLE(row.length, 16);
  value.writeDoubleLE(row.summaryOffset, 24); value.writeUInt32LE(row.summaryLength, 32);
  value.writeUInt32LE(row.category, 36); value.writeDoubleLE(row.elapsedMs || 0, 40);
  return value;
}
function decodeRow(value, at, index) {
  return { index, seq: value.readDoubleLE(at), offset: value.readDoubleLE(at + 8), length: value.readDoubleLE(at + 16), summaryOffset: value.readDoubleLE(at + 24), summaryLength: value.readUInt32LE(at + 32), category: value.readUInt32LE(at + 36), elapsedMs: value.readDoubleLE(at + 40) };
}
async function readExactly(handle, length, position) {
  const value = Buffer.alloc(length);
  let at = 0;
  while (at < length) {
    const { bytesRead } = await handle.read(value, at, length - at, position + at);
    if (!bytesRead) throw new Error('时间线或索引读取不完整');
    at += bytesRead;
  }
  return value;
}
async function writeAll(handle, value, position) {
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await handle.write(value, offset, value.length - offset, position === undefined ? null : position + offset);
    if (!bytesWritten) throw new Error('索引写入不完整');
    offset += bytesWritten;
  }
}
async function* rows(handle, start, end, direction = 1) {
  if (direction > 0) {
    for (let at = start; at < end;) {
      const count = Math.min(256, end - at), buffer = await readExactly(handle, count * ROW_BYTES, at * ROW_BYTES);
      for (let n = 0; n < count; n++) yield decodeRow(buffer, n * ROW_BYTES, at + n);
      at += count;
    }
  } else {
    for (let at = end; at > start;) {
      const count = Math.min(256, at - start), first = at - count, buffer = await readExactly(handle, count * ROW_BYTES, first * ROW_BYTES);
      for (let n = count - 1; n >= 0; n--) yield decodeRow(buffer, n * ROW_BYTES, first + n);
      at = first;
    }
  }
}
async function sequenceBound(handle, count, seq, inclusive) {
  let low = 0, high = count;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2), value = (await readExactly(handle, 8, mid * ROW_BYTES)).readDoubleLE(0);
    if (value < seq || (inclusive && value === seq)) low = mid + 1; else high = mid;
  }
  return low;
}
async function summary(handle, row) {
  if (row.summaryLength > 128 * 1024) throw new Error('摘要索引损坏');
  return JSON.parse((await readExactly(handle, row.summaryLength, row.summaryOffset)).toString('utf8'));
}
async function includesRaw(handle, row, search) {
  const decoder = new StringDecoder('utf8');
  let tail = '', at = 0;
  while (at < row.length) {
    const chunk = await readExactly(handle, Math.min(IO_BYTES, row.length - at), row.offset + at); at += chunk.length;
    const text = tail + decoder.write(chunk).toLocaleLowerCase();
    if (text.includes(search)) return true;
    tail = search.length > 1 ? text.slice(-(search.length - 1)) : '';
  }
  return (tail + decoder.end().toLocaleLowerCase()).includes(search);
}
async function hasFollowingLine(filename, start, size) {
  const handle = await fs.open(filename, 'r'); let skippedBadLine = false;
  try {
    for (let at = start; at < size;) {
      const chunk = await readExactly(handle, Math.min(IO_BYTES, size - at), at); at += chunk.length;
      for (const byte of chunk) {
        if (!skippedBadLine) { if (byte === 10) skippedBadLine = true; continue; }
        if (![9, 10, 13, 32].includes(byte)) return true;
      }
    }
    return false;
  } finally { await handle.close(); }
}

class SessionStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir); this.sessions = new Map(); this.indexes = new Map(); this.searches = new Map();
    this.queue = Promise.resolve(); this.searchQueue = Promise.resolve();
  }
  _enqueue(operation) { const task = this.queue.then(operation); this.queue = task.catch(() => {}); return task; }
  _id(id) { if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('无效的会话 ID'); return id; }
  getSessionDirectory(id) { return path.join(this.rootDir, this._id(id)); }
  _known(id) { this._id(id); const value = this.sessions.get(id); if (!value) throw new Error('找不到指定会话'); return value; }
  _paths(id) {
    const directory = this.getSessionDirectory(id);
    return { directory, timeline: path.join(directory, 'timeline.jsonl'), index: path.join(directory, 'timeline.idx'), summaries: path.join(directory, 'timeline.summaries.jsonl') };
  }
  async _writeMetadata(metadata) {
    const filename = path.join(this.getSessionDirectory(metadata.id), 'session.json'), temporary = `${filename}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8'); await fs.rename(temporary, filename); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async _buildIndex(id, metadata) {
    const files = this._paths(id), suffix = `.${randomUUID()}.tmp`, indexPath = files.index + suffix, summariesPath = files.summaries + suffix;
    const index = newIndex(); let recoveredTail = false, normalizedNewline = false;
    await fs.appendFile(files.timeline, ''); const size = (await fs.stat(files.timeline)).size;
    let indexHandle, summaryHandle;
    try {
      indexHandle = await fs.open(indexPath, 'w'); summaryHandle = await fs.open(summariesPath, 'w');
      try {
        for await (const record of scanTimeline(files.timeline, { byteLength: size })) {
          const event = { ...record.event, summary: summarize(record.event) };
          if (!Number.isSafeInteger(event.seq) || event.seq <= index.lastSeq) { const error = new Error('事件序号必须严格递增'); error.offset = record.offset; throw error; }
          const body = Buffer.from(`${JSON.stringify(event)}\n`);
          const row = { seq: event.seq, offset: record.offset, length: record.length, summaryOffset: index.summaryBytes, summaryLength: body.length, category: category(event.type), elapsedMs: event.elapsedMs || 0 };
          await writeAll(summaryHandle, body); await writeAll(indexHandle, encodeRow(row));
          index.count++; index.categories[row.category]++; index.summaryBytes += body.length;
          index.lastSeq = event.seq; index.lastElapsedMs = Math.max(index.lastElapsedMs, event.elapsedMs || 0);
        }
      } catch (error) {
        if (!Number.isSafeInteger(error.offset) || error.offset < 0 || await hasFollowingLine(files.timeline, error.offset, size)) throw new Error(`会话 ${id} 的时间线损坏，原文件已保留：${error.message}`);
        const backup = `timeline.recovery-${Date.now()}-${randomUUID().slice(0, 8)}.jsonl`;
        await fs.copyFile(files.timeline, path.join(files.directory, backup)); await fs.truncate(files.timeline, error.offset);
        metadata.recoveryFile = backup; recoveredTail = true;
      }
      let currentSize = (await fs.stat(files.timeline)).size;
      if (currentSize) {
        const source = await fs.open(files.timeline, 'r'); let endsWithLF;
        try { endsWithLF = (await readExactly(source, 1, currentSize - 1))[0] === 10; } finally { await source.close(); }
        if (!endsWithLF) { await fs.appendFile(files.timeline, '\n'); normalizedNewline = true; currentSize++; }
      }
      index.bytes = currentSize;
      await indexHandle.close(); indexHandle = null; await summaryHandle.close(); summaryHandle = null;
      if (normalizedNewline && index.count) {
        const handle = await fs.open(indexPath, 'r+');
        try {
          const row = decodeRow(await readExactly(handle, ROW_BYTES, (index.count - 1) * ROW_BYTES), 0, index.count - 1);
          if (row.offset + row.length === index.bytes - 1) { row.length++; await writeAll(handle, encodeRow(row), row.index * ROW_BYTES); }
        } finally { await handle.close(); }
      }
      await fs.rename(summariesPath, files.summaries); await fs.rename(indexPath, files.index);
    } finally {
      await indexHandle?.close(); await summaryHandle?.close();
      await fs.rm(indexPath, { force: true }).catch(() => {}); await fs.rm(summariesPath, { force: true }).catch(() => {});
    }
    this.indexes.set(id, index);
    Object.assign(metadata, { eventCount: index.count, actionCount: index.categories[1], mutationCount: index.categories[2], snapshotCount: index.categories[3], lastSeq: index.lastSeq, lastElapsedMs: index.lastElapsedMs });
    return recoveredTail;
  }
  async init() {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      const directory = this.getSessionDirectory(entry.name); let metadata;
      try { metadata = JSON.parse(await fs.readFile(path.join(directory, 'session.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw new Error(`无法读取会话 ${entry.name} 的元数据：${error.message}`); }
      if (metadata.id !== entry.name) throw new Error(`会话目录与 ID 不一致：${entry.name}`);
      for (const name of await fs.readdir(directory)) if (/^\.search-[a-f0-9-]+\.idx$/.test(name)) await fs.rm(path.join(directory, name), { force: true });
      const recoveredTail = await this._buildIndex(metadata.id, metadata); this.sessions.set(metadata.id, metadata);
      if (metadata.status === 'recording' || metadata.status === 'paused' || recoveredTail) {
        metadata.status = 'interrupted'; metadata.endedAt = new Date().toISOString();
        await this._append(metadata.id, { type: 'session.interrupted', timestamp: metadata.endedAt, payload: { reason: '上次程序退出时录制未正常结束，已恢复已写入事件。', recoveredTail, recoveryFile: metadata.recoveryFile || null } });
      } else await this._writeMetadata(metadata);
    }
    return this;
  }
  list() { return [...this.sessions.values()].map(value => ({ ...value })).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  getSession(id) { return { ...this._known(id) }; }
  create(name, url = '') {
    return this._enqueue(async () => {
      const now = new Date().toISOString(), id = `session-${now.replace(/[^0-9]/g, '').slice(0, 17)}-${randomUUID().slice(0, 8)}`;
      const metadata = { id, name: String(name || `录制 ${now}`).trim().slice(0, 200), status: 'recording', startedAt: now, updatedAt: now, endedAt: null, url, eventCount: 0, actionCount: 0, mutationCount: 0, snapshotCount: 0, lastSeq: 0, lastElapsedMs: 0, schemaVersion: 1 };
      const files = this._paths(id); await fs.mkdir(files.directory, { recursive: false });
      await Promise.all([fs.writeFile(files.timeline, ''), fs.writeFile(files.index, ''), fs.writeFile(files.summaries, '')]);
      await this._writeMetadata(metadata); this.sessions.set(id, metadata); this.indexes.set(id, newIndex()); return { ...metadata };
    });
  }
  append(id, event) { return this._enqueue(() => this._append(id, event)); }
  async _ensureIndex(id) {
    if (!this.indexes.has(id) || this.indexes.get(id).dirty) { const metadata = this._known(id); await this._buildIndex(id, metadata); await this._writeMetadata(metadata); }
    return this.indexes.get(id);
  }
  async _append(sessionId, input) {
    await this._ensureIndex(sessionId);
    const metadata = this._known(sessionId), index = this.indexes.get(sessionId), files = this._paths(sessionId);
    if (!input || typeof input.type !== 'string' || !input.type) throw new Error('事件类型不能为空');
    const receivedAt = new Date().toISOString(), timestamp = Number.isFinite(Date.parse(input.timestamp)) ? new Date(input.timestamp).toISOString() : receivedAt, seq = metadata.lastSeq + 1;
    const event = { ...input, id: `${sessionId}:${String(seq).padStart(8, '0')}`, sessionId, seq, type: input.type, timestamp, receivedAt, elapsedMs: Math.max(metadata.lastElapsedMs || 0, Date.parse(receivedAt) - Date.parse(metadata.startedAt), 0), url: input.url || metadata.url || '', title: input.title || '', documentId: input.documentId || null, payload: input.payload ?? {} };
    event.summary = summarize(event);
    const raw = Buffer.from(`${JSON.stringify(event)}\n`), body = Buffer.from(`${JSON.stringify(compactEvent(event))}\n`);
    const row = { seq, offset: index.bytes, length: raw.length, summaryOffset: index.summaryBytes, summaryLength: body.length, category: category(event.type), elapsedMs: event.elapsedMs };
    await fs.appendFile(files.timeline, raw);
    const updated = { ...metadata, lastSeq: seq, lastElapsedMs: event.elapsedMs, eventCount: metadata.eventCount + 1, actionCount: metadata.actionCount + Number(row.category === 1), mutationCount: metadata.mutationCount + Number(row.category === 2), snapshotCount: metadata.snapshotCount + Number(row.category === 3), updatedAt: receivedAt, url: event.url || metadata.url };
    this.sessions.set(sessionId, updated);
    try {
      await fs.appendFile(files.summaries, body); await fs.appendFile(files.index, encodeRow(row));
      index.count++; index.bytes += raw.length; index.summaryBytes += body.length; index.categories[row.category]++; index.lastSeq = seq; index.lastElapsedMs = event.elapsedMs;
    } catch (error) { index.dirty = true; throw error; }
    await this._writeMetadata(updated); return event;
  }
  update(sessionId, patch) {
    return this._enqueue(async () => {
      const current = this._known(sessionId); if (patch.status && !STATUSES.has(patch.status)) throw new Error('无效的会话状态');
      const allowed = ['name', 'status', 'endedAt', 'lastExportPath', 'lastExportAt', 'url'];
      const updated = { ...current, ...Object.fromEntries(allowed.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]])), updatedAt: new Date().toISOString() };
      await this._writeMetadata(updated); this.sessions.set(sessionId, updated); return { ...updated };
    });
  }
  flush() { return this.queue; }
  capture(sessionId) {
    return this._enqueue(async () => {
      const index = await this._ensureIndex(sessionId), files = this._paths(sessionId);
      if ((await fs.stat(files.timeline)).size !== index.bytes) { index.dirty = true; await this._ensureIndex(sessionId); }
      const current = this.indexes.get(sessionId);
      return { metadata: this.getSession(sessionId), timelinePath: files.timeline, byteLength: current.bytes, capturedAt: new Date().toISOString(), indexCount: current.count, indexGeneration: current.generation, categoryCounts: [...current.categories] };
    });
  }
  async _typeMatches(row, prefixes, cats, summaries) {
    if (!prefixes.length) return true;
    if (cats && row.category !== 0) return cats.has(row.category);
    const event = await summary(summaries, row); return prefixes.some(prefix => event.type === prefix || event.type.startsWith(`${prefix}.`));
  }
  async _search(capture, prefixes, search, indexHandle, summaries, operation) {
    const run = this.searchQueue.then(async () => {
      const key = JSON.stringify([capture.metadata.id, capture.indexGeneration, prefixes, search]); let cache = this.searches.get(key);
      if (!cache) {
        while (this.searches.size >= 2) { const [oldKey, old] = this.searches.entries().next().value; this.searches.delete(oldKey); await fs.rm(old.path, { force: true }); }
        cache = { path: path.join(this.getSessionDirectory(capture.metadata.id), `.search-${randomUUID()}.idx`), count: 0, scanned: 0 };
        await fs.writeFile(cache.path, ''); this.searches.set(key, cache);
      } else { this.searches.delete(key); this.searches.set(key, cache); }
      const source = await fs.open(capture.timelinePath, 'r'), matches = await fs.open(cache.path, 'a+');
      try {
        const cats = categoryFilter(prefixes);
        for await (const row of rows(indexHandle, cache.scanned, capture.indexCount)) {
          if (await this._typeMatches(row, prefixes, cats, summaries) && await includesRaw(source, row, search)) {
            const value = Buffer.alloc(8); value.writeDoubleLE(row.index); await writeAll(matches, value); cache.count++;
          }
          cache.scanned = row.index + 1;
        }
        return await operation(cache, matches);
      } finally { await source.close(); await matches.close(); }
    });
    this.searchQueue = run.catch(() => {}); return run;
  }
  async timeline({ sessionId, offset = 0, limit = 100, types = [], query = '', beforeSeq, afterSeq, snapshotSeq } = {}) {
    const capture = await this.capture(sessionId), files = this._paths(sessionId);
    const prefixes = Array.isArray(types) ? [...new Set(types.filter(type => typeof type === 'string' && type.length < 200))].sort() : [];
    const search = String(query || '').toLocaleLowerCase(); if (search.length > 4096) throw new Error('搜索词过长');
    const skip = Math.max(0, Math.floor(Number(offset) || 0)), size = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const upperSeq = Number.isSafeInteger(snapshotSeq) ? Math.min(snapshotSeq, capture.metadata.lastSeq) : capture.metadata.lastSeq;
    const ascending = Number.isSafeInteger(afterSeq), cats = categoryFilter(prefixes);
    const indexHandle = await fs.open(files.index, 'r'), summaries = await fs.open(files.summaries, 'r');
    try {
      const count = await sequenceBound(indexHandle, capture.indexCount, upperSeq, true);
      const lower = ascending ? await sequenceBound(indexHandle, count, afterSeq, true) : 0;
      const upper = Number.isSafeInteger(beforeSeq) ? await sequenceBound(indexHandle, count, beforeSeq, false) : count;
      const selected = []; let total = 0, skipped = 0, hasMore = false, scannedThroughSeq = ascending ? afterSeq : null;
      const accept = async row => {
        if (skipped++ < skip) { scannedThroughSeq = row.seq; return true; }
        if (selected.length === size) { hasMore = true; return false; }
        selected.push(await summary(summaries, row)); scannedThroughSeq = row.seq; return true;
      };
      if (search) {
        await this._search(capture, prefixes, search, indexHandle, summaries, async (cache, matches) => {
          const bound = async rowIndex => {
            let low = 0, high = cache.count;
            while (low < high) { const mid = low + Math.floor((high - low) / 2), value = (await readExactly(matches, 8, mid * 8)).readDoubleLE(0); if (value < rowIndex) low = mid + 1; else high = mid; }
            return low;
          };
          total = await bound(count);
          const start = await bound(lower), end = await bound(upper);
          for (let at = ascending ? start : end - 1; ascending ? at < end : at >= start; at += ascending ? 1 : -1) {
            const rowIndex = (await readExactly(matches, 8, at * 8)).readDoubleLE(0), row = decodeRow(await readExactly(indexHandle, ROW_BYTES, rowIndex * ROW_BYTES), 0, rowIndex);
            if (!await accept(row)) break;
          }
        });
      } else {
        if (!prefixes.length) total = count;
        else if (cats && count === capture.indexCount) {
          total = [...cats].reduce((sum, key) => sum + capture.categoryCounts[key], 0);
          if (capture.categoryCounts[0]) for await (const row of rows(indexHandle, 0, count)) {
            if (row.category === 0 && await this._typeMatches(row, prefixes, cats, summaries)) total++;
          }
        }
        else for await (const row of rows(indexHandle, 0, count)) if (await this._typeMatches(row, prefixes, cats, summaries)) total++;
        for await (const row of rows(indexHandle, lower, upper, ascending ? 1 : -1)) if (await this._typeMatches(row, prefixes, cats, summaries) && !await accept(row)) break;
      }
      if (ascending && !hasMore) scannedThroughSeq = upperSeq;
      return { events: selected, total, hasMore, firstSeq: selected[0]?.seq ?? null, lastSeq: selected.at(-1)?.seq ?? null, snapshotSeq: upperSeq, scannedThroughSeq };
    } finally { await indexHandle.close(); await summaries.close(); }
  }
  async getEvent(sessionId, eventId, { preview = false, maxBytes = 100000 } = {}) {
    const capture = await this.capture(sessionId), files = this._paths(sessionId);
    const indexHandle = await fs.open(files.index, 'r'), summaries = await fs.open(files.summaries, 'r'); let row, event;
    try {
      const prefix = `${sessionId}:`, sequence = typeof eventId === 'string' && eventId.startsWith(prefix) ? Number(eventId.slice(prefix.length)) : NaN;
      if (Number.isSafeInteger(sequence)) {
        const at = await sequenceBound(indexHandle, capture.indexCount, sequence, false);
        if (at < capture.indexCount) { const candidate = decodeRow(await readExactly(indexHandle, ROW_BYTES, at * ROW_BYTES), 0, at), value = await summary(summaries, candidate); if (value.id === eventId) { row = candidate; event = value; } }
      }
      if (!row && !Number.isSafeInteger(sequence)) for await (const candidate of rows(indexHandle, 0, capture.indexCount)) {
        const value = await summary(summaries, candidate); if (value.id === eventId) { row = candidate; event = value; break; }
      }
      if (!row) throw new Error('找不到指定事件');
    } finally { await indexHandle.close(); await summaries.close(); }
    if (!preview && row.length > MAX_FULL_DETAIL) throw new Error('该事件超过完整详情读取上限，请使用预览或导出原始数据');
    const length = preview ? Math.min(row.length, Math.max(1, Math.min(1024 * 1024, Math.floor(Number(maxBytes) || 100000)))) : row.length;
    const handle = await fs.open(files.timeline, 'r');
    try {
      const value = await readExactly(handle, length, row.offset);
      if (!preview) return JSON.parse(value.toString('utf8'));
      const decoder = new StringDecoder('utf8'), truncated = length < row.length;
      return { preview: decoder.write(value) + (truncated ? '' : decoder.end()), truncated, bytes: row.length, event };
    } finally { await handle.close(); }
  }
}

module.exports = { SessionStore, summarize, compactEvent };
