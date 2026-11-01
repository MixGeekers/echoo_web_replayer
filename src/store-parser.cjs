'use strict';

// The raw timeline is the authority. This reader validates JSON incrementally
// and retains only bounded UI/index data, even for a single very large record.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Parser = require('stream-json/Parser');

const CHUNK_BYTES = 64 * 1024;
const PAYLOAD_BUDGET = 8192;
const VALUE_STRING_LIMIT = 2048;
const MAX_DEPTH = 6;
const MAX_ITEMS = 32;
const MAX_ARRAY = 16;
const META_LIMITS = Object.freeze({ id: 512, sessionId: 128, type: 128, timestamp: 64, receivedAt: 64, documentId: 512, url: 2048, title: 512, summary: 280 });
const META_NUMBERS = new Set(['seq', 'elapsedMs']);
const LARGE_PAYLOAD_KEYS = new Set(['html', 'outerHTML', 'tree', 'forms', 'frames', 'shadowRoots', 'mutations', 'records']);
const own = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

function boundedClone(value, budget, depth = 0) {
  if (budget.remaining <= 0 || depth > MAX_DEPTH) { budget.truncated = true; return undefined; }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') { budget.remaining -= 8; return value; }
  if (typeof value === 'string') {
    const length = Math.min(value.length, VALUE_STRING_LIMIT, Math.max(0, budget.remaining));
    budget.remaining -= length;
    if (length < value.length) budget.truncated = true;
    return value.slice(0, length);
  }
  if (!value || typeof value !== 'object') return undefined;
  budget.remaining -= 8;
  if (Array.isArray(value)) {
    const result = [];
    if (value.length > MAX_ARRAY) budget.truncated = true;
    for (let i = 0; i < Math.min(value.length, MAX_ARRAY) && budget.remaining > 0; i++) {
      const item = boundedClone(value[i], budget, depth + 1);
      if (item !== undefined) result.push(item);
    }
    return result;
  }
  const result = {};
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (depth === 0 && LARGE_PAYLOAD_KEYS.has(key)) continue;
    if (count++ >= MAX_ITEMS || budget.remaining <= 8) { budget.truncated = true; break; }
    if (key.length > 256 || budget.remaining < key.length + 8) { budget.truncated = true; continue; }
    budget.remaining -= key.length;
    const item = boundedClone(value[key], budget, depth + 1);
    if (item !== undefined) own(result, key, item);
  }
  return result;
}

function compactEventBounded(event) {
  const result = {};
  for (const [key, limit] of Object.entries(META_LIMITS)) {
    const value = event[key];
    if (typeof value === 'string') result[key] = value.slice(0, limit);
    else if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
  }
  for (const key of META_NUMBERS) if (typeof event[key] === 'number' && Number.isFinite(event[key])) result[key] = event[key];
  const payload = event.payload || {};
  if (event.type === 'dom.snapshot') {
    const suppliedBytes = Number.isSafeInteger(payload.htmlBytes) && payload.htmlBytes >= 0 ? payload.htmlBytes : 0;
    const htmlBytes = payload.html === undefined && payload.outerHTML === undefined ? suppliedBytes : Buffer.byteLength(String(payload.html ?? payload.outerHTML ?? ''), 'utf8');
    result.payload = { reason: String(payload.reason || 'checkpoint').slice(0, VALUE_STRING_LIMIT), htmlBytes };
    if (payload.url !== undefined) result.payload.url = String(payload.url).slice(0, VALUE_STRING_LIMIT);
    if (payload.viewport !== undefined) result.payload.viewport = boundedClone(payload.viewport, { remaining: 1024, truncated: false });
  } else if (event.type === 'dom.mutation') {
    const count = payload.mutations?.length ?? payload.records?.length ?? payload.count;
    result.payload = { count: Number.isFinite(count) && count >= 0 ? count : 0 };
  } else {
    const budget = { remaining: PAYLOAD_BUDGET, truncated: false };
    result.payload = boundedClone(payload, budget) ?? {};
    if (budget.truncated) result.payloadTruncated = true;
  }
  return result;
}

class SummaryCollector {
  constructor() {
    this.event = {};
    this.stack = [];
    this.scalar = null;
    this.budget = { remaining: PAYLOAD_BUDGET, truncated: false };
    this.rootSeen = false;
    this.rootDone = false;
    this.html = { html: null, outerHTML: null };
    this.mutationCounts = { mutations: null, records: null };
  }

  slot(kind) {
    const parent = this.stack[this.stack.length - 1];
    if (!parent) return { root: true, target: this.event, key: null, tag: 'root' };
    const key = parent.kind === 'array' ? parent.items++ : parent.key;
    const tag = parent.tag === 'root' && key === 'payload' ? 'payload' : '';
    const directPayload = parent.tag === 'payload';
    const special = directPayload && (key === 'html' || key === 'outerHTML' || key === 'mutations' || key === 'records') ? key : null;
    if (special === 'html' || special === 'outerHTML') this.html[special] = null;
    if (parent.tag === 'root') {
      const allowed = key === 'payload' || Object.hasOwn(META_LIMITS, key) || META_NUMBERS.has(key);
      return { target: allowed ? parent.target : null, key, tag, special, metadata: key !== 'payload' };
    }
    let allowed = Boolean(parent.target) && this.stack.length <= MAX_DEPTH + 2;
    if (parent.kind === 'array') allowed &&= key < MAX_ARRAY;
    else {
      parent.items++;
      allowed &&= parent.items <= MAX_ITEMS && typeof key === 'string' && key.length <= 256;
      if (directPayload && LARGE_PAYLOAD_KEYS.has(key)) allowed = false;
    }
    if (allowed && this.budget.remaining >= 8 + String(key).length) this.budget.remaining -= 8 + String(key).length;
    else { allowed = false; this.budget.truncated = true; }
    return { target: allowed ? parent.target : null, key, tag, special, metadata: false };
  }

  set(slot, value) {
    if (!slot.target || slot.root) return;
    if (Array.isArray(slot.target)) slot.target.push(value);
    else own(slot.target, slot.key, value);
  }

  token(token) {
    const { name, value } = token;
    if (name === 'startKey') { this.scalar = { kind: 'key', value: '', length: 0 }; return; }
    if (name === 'endKey') {
      const current = this.stack[this.stack.length - 1];
      current.key = this.scalar.length <= 256 ? this.scalar.value : null;
      this.scalar = null; return;
    }
    if (name === 'stringChunk' || name === 'numberChunk') {
      const current = this.scalar;
      if (!current) return;
      current.length += value.length;
      if (current.htmlCounter) {
        let text = current.carry + value;
        current.carry = /[\uD800-\uDBFF]$/.test(text) ? text.slice(-1) : '';
        if (current.carry) text = text.slice(0, -1);
        current.htmlCounter.bytes += Buffer.byteLength(text, 'utf8');
      }
      const limit = current.kind === 'key' ? 256 : current.kind === 'number' ? 64 : current.limit;
      if (current.value.length < limit) current.value += value.slice(0, limit - current.value.length);
      return;
    }
    if (name === 'startObject' || name === 'startArray') {
      const kind = name === 'startObject' ? 'object' : 'array';
      const slot = this.slot(kind);
      if (slot.root) {
        if (this.rootSeen || kind !== 'object') throw new Error('时间线事件必须是 JSON 对象');
        this.rootSeen = true;
      }
      // Metadata is scalar by contract. Do not retain malformed object values.
      const target = slot.root ? this.event : slot.target && !slot.metadata ? (kind === 'array' ? [] : {}) : null;
      if (!slot.root && target) this.set(slot, target);
      const frame = { kind, target, key: null, items: 0, tag: slot.tag, special: slot.special };
      this.stack.push(frame); return;
    }
    if (name === 'endObject' || name === 'endArray') {
      const frame = this.stack.pop();
      if (frame.kind === 'array' && (frame.special === 'mutations' || frame.special === 'records')) this.mutationCounts[frame.special] = frame.items;
      if (!this.stack.length) this.rootDone = true;
      return;
    }
    if (name === 'startString' || name === 'startNumber') {
      const slot = this.slot(name === 'startString' ? 'string' : 'number');
      const kind = name === 'startString' ? 'string' : 'number';
      const limit = slot.metadata ? META_LIMITS[slot.key] || 64 : Math.min(VALUE_STRING_LIMIT, Math.max(0, this.budget.remaining));
      this.scalar = { kind, slot, value: '', length: 0, limit: slot.target ? limit : 0 };
      if (kind === 'string' && (slot.special === 'html' || slot.special === 'outerHTML')) {
        this.scalar.htmlCounter = { bytes: 0 };
        this.scalar.carry = '';
      }
      return;
    }
    if (name === 'endString' || name === 'endNumber') {
      const current = this.scalar;
      if (current.htmlCounter) {
        current.htmlCounter.bytes += Buffer.byteLength(current.carry, 'utf8');
        this.html[current.slot.special] = current.htmlCounter.bytes;
      } else if (current.kind === 'number' && (current.slot.special === 'html' || current.slot.special === 'outerHTML')) {
        this.html[current.slot.special] = Buffer.byteLength(String(Number(current.value)), 'utf8');
      }
      if (current.slot.target) {
        if (!current.slot.metadata) {
          this.budget.remaining -= current.value.length;
          if (current.value.length < current.length) this.budget.truncated = true;
        }
        this.set(current.slot, current.kind === 'number' ? (current.length <= 64 ? Number(current.value) : null) : current.value);
      }
      this.scalar = null; return;
    }
    if (name === 'trueValue' || name === 'falseValue' || name === 'nullValue') {
      const slot = this.slot('literal');
      if ((slot.special === 'html' || slot.special === 'outerHTML') && value !== null) this.html[slot.special] = Buffer.byteLength(String(value), 'utf8');
      this.set(slot, value); return;
    }
  }

  finish() {
    const event = this.event;
    if (!this.rootSeen || !this.rootDone || !Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.type !== 'string' || !event.type) throw new Error('无效事件：需要正整数 seq 与字符串 type');
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (event.type === 'dom.snapshot') {
      event.payload = { reason: payload.reason || 'checkpoint', htmlBytes: this.html.html ?? this.html.outerHTML ?? 0 };
      if (payload.viewport !== undefined) event.payload.viewport = payload.viewport;
      if (payload.url !== undefined) event.payload.url = payload.url;
    } else if (event.type === 'dom.mutation') {
      const count = this.mutationCounts.mutations ?? this.mutationCounts.records ?? payload.count;
      event.payload = { count: Number.isFinite(count) && count >= 0 ? count : 0 };
    } else {
      event.payload = payload;
      if (this.budget.truncated) event.payloadTruncated = true;
    }
    return event;
  }
}

function createRecordParser() {
  const parser = new Parser({ packValues: false, packKeys: false, packStrings: false, packNumbers: false });
  const collector = new SummaryCollector();
  let error;
  parser.on('error', value => { error = value; });
  parser.on('data', token => { try { collector.token(token); } catch (value) { error = value; parser.destroy(value); } });
  return {
    async write(chunk) {
      if (error) throw error;
      await new Promise((resolve, reject) => parser.write(chunk, value => value ? reject(value) : resolve()));
      if (error) throw error;
    },
    async finish() {
      if (error) throw error;
      await new Promise((resolve, reject) => { parser.once('end', resolve); parser.once('error', reject); parser.end(); });
      if (error) throw error;
      return collector.finish();
    },
    destroy() { parser.destroy(); },
  };
}

function hasNonWhitespace(buffer) {
  for (const byte of buffer) if (byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32) return true;
  return false;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('时间线读取已取消'); error.name = 'AbortError'; throw error;
}

async function* scanTimeline(filename, { byteLength, startOffset = 0, signal, onProgress } = {}) {
  throwIfAborted(signal);
  const boundary = byteLength ?? (await fsp.stat(filename)).size;
  if (!Number.isSafeInteger(boundary) || !Number.isSafeInteger(startOffset) || startOffset < 0 || boundary < startOffset) throw new Error('无效时间线读取范围');
  if (boundary === startOffset) return;
  const input = fs.createReadStream(filename, { start: startOffset, end: boundary - 1, highWaterMark: CHUNK_BYTES, signal });
  let position = startOffset, lineStart = startOffset, lineNumber = 1, record = null;
  let parsing = false;
  try {
    for await (const chunk of input) {
      throwIfAborted(signal);
      let cursor = 0;
      while (cursor < chunk.length) {
        throwIfAborted(signal);
        const newline = chunk.indexOf(10, cursor);
        const end = newline < 0 ? chunk.length : newline + 1;
        const part = chunk.subarray(cursor, end);
        if (!record && hasNonWhitespace(part)) record = createRecordParser();
        if (record) { parsing = true; await record.write(part); parsing = false; }
        position += part.length;
        cursor = end;
        if (newline >= 0) {
          if (record) {
            parsing = true; const event = await record.finish(); parsing = false;
            record.destroy(); record = null;
            yield { offset: lineStart, length: position - lineStart, event };
          }
          lineStart = position; lineNumber++;
        }
      }
      if (onProgress) await onProgress({ bytesRead: position, totalBytes: boundary });
      throwIfAborted(signal);
    }
    if (position !== boundary) throw new Error('时间线读取不完整');
    if (record) {
      parsing = true; const event = await record.finish(); parsing = false; record.destroy(); record = null;
      yield { offset: lineStart, length: position - lineStart, event };
    }
  } catch (error) {
    // Cancellation, I/O errors and progress callback failures are not damaged
    // records. In particular, callers must never repair a tail after aborting.
    if (parsing && !signal?.aborted && error.name !== 'AbortError') {
      error.offset = lineStart;
      error.lineNumber = lineNumber;
    }
    throw error;
  } finally { record?.destroy(); input.destroy(); }
}

module.exports = { scanTimeline, compactEventBounded };
