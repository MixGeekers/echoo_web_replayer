'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');

const BLOCK_BYTES = 1024 * 1024;
const WINDOW_BYTES = 4 * BLOCK_BYTES;
const CHECKPOINT_BLOCKS = 16;
const MATCH_BYTES = 64;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('导出已取消'); error.name = 'AbortError'; throw error;
  }
}

function fingerprint(buffer, offset) {
  let result = 0;
  for (let i = 0; i < MATCH_BYTES; i++) result = (Math.imul(result, 257) + buffer[offset + i]) >>> 0;
  return result;
}

function makePatch(base, next) {
  if (base.length < MATCH_BYTES || next.length < MATCH_BYTES) return null;
  const entries = Math.floor(base.length / MATCH_BYTES);
  let capacity = 2;
  while (capacity < entries * 2) capacity *= 2;
  const keys = new Uint32Array(capacity);
  const positions = new Int32Array(capacity); positions.fill(-1);
  const mask = capacity - 1;
  for (let at = 0; at + MATCH_BYTES <= base.length; at += MATCH_BYTES) {
    const hash = fingerprint(base, at);
    let slot = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) & mask;
    while (positions[slot] !== -1 && keys[slot] !== hash) slot = (slot + 1) & mask;
    if (positions[slot] === -1) { keys[slot] = hash; positions[slot] = at; }
  }
  let power = 1;
  for (let i = 1; i < MATCH_BYTES; i++) power = Math.imul(power, 257) >>> 0;
  const parts = [];
  let at = 0, literalStart = 0, patchBytes = 0, hash = fingerprint(next, 0), matches = 0;
  const add = (start, end) => {
    if (end <= start) return;
    const header = Buffer.allocUnsafe(5); header[0] = 0; header.writeUInt32LE(end - start, 1);
    parts.push(header, next.subarray(start, end)); patchBytes += 5 + end - start;
  };
  while (at + MATCH_BYTES <= next.length) {
    let slot = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) & mask;
    while (positions[slot] !== -1 && keys[slot] !== hash) slot = (slot + 1) & mask;
    const candidate = positions[slot];
    if (candidate !== -1 && base.subarray(candidate, candidate + MATCH_BYTES).equals(next.subarray(at, at + MATCH_BYTES))) {
      let length = MATCH_BYTES;
      const max = Math.min(base.length - candidate, next.length - at);
      while (length + 4096 <= max && base.subarray(candidate + length, candidate + length + 4096).equals(next.subarray(at + length, at + length + 4096))) length += 4096;
      while (length < max && base[candidate + length] === next[at + length]) length++;
      add(literalStart, at);
      const command = Buffer.allocUnsafe(9); command[0] = 1;
      command.writeUInt32LE(candidate, 1); command.writeUInt32LE(length, 5);
      parts.push(command); patchBytes += 9; matches++;
      at += length; literalStart = at;
      if (at + MATCH_BYTES <= next.length) hash = fingerprint(next, at);
    } else {
      if (at + MATCH_BYTES < next.length) hash = (Math.imul((hash - Math.imul(next[at], power)) >>> 0, 257) + next[at + MATCH_BYTES]) >>> 0;
      at++;
    }
    // A candidate cannot grow unbounded in commands, even with pathological input.
    if (patchBytes >= next.length * 0.95) return null;
  }
  if (!matches) return null;
  add(literalStart, next.length);
  return patchBytes < next.length * 0.95 ? Buffer.concat(parts, patchBytes) : null;
}

function applyPatch(base, patch, outputBytes) {
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 0 || outputBytes > BLOCK_BYTES) throw new Error('非法差分块长度');
  const output = Buffer.allocUnsafe(outputBytes);
  let at = 0, written = 0;
  while (at < patch.length) {
    const op = patch[at++];
    if (at + 4 > patch.length) throw new Error('差分指令截断');
    const first = patch.readUInt32LE(at); at += 4;
    if (op === 0) {
      if (!first || at + first > patch.length || written + first > output.length) throw new Error('非法 ADD 长度');
      patch.copy(output, written, at, at + first); at += first; written += first;
    } else if (op === 1) {
      if (at + 4 > patch.length) throw new Error('COPY 指令截断');
      const length = patch.readUInt32LE(at); at += 4;
      if (!length || first + length > base.length || written + length > output.length) throw new Error('COPY 超出窗口');
      base.copy(output, written, first, first + length); written += length;
    } else throw new Error('未知差分操作码');
  }
  if (written !== output.length) throw new Error('差分恢复长度不一致');
  return output;
}

async function writeAll(handle, data) {
  let at = 0;
  while (at < data.length) {
    const { bytesWritten } = await handle.write(data, at, data.length - at);
    if (!bytesWritten) throw new Error('文件写入未完成');
    at += bytesWritten;
  }
}

async function encodeTimeline({ timelinePath, byteLength, dataPath, indexPath, compression = 'deflate', signal, onProgress }) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error('无效的导出截点');
  const input = await fs.open(timelinePath, 'r');
  let data, index;
  const timelineHash = createHash('sha256'), dataHash = createHash('sha256'), indexHash = createHash('sha256');
  let offset = 0, dataOffset = 0, block = 0, deltaBlocks = 0, events = 0, nonWhitespace = false;
  let window = Buffer.alloc(0);
  try {
    data = await fs.open(dataPath, 'wx'); index = await fs.open(indexPath, 'wx');
    while (offset < byteLength) {
      checkAbort(signal);
      const raw = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, byteLength - offset));
      let read = 0;
      while (read < raw.length) {
        const { bytesRead } = await input.read(raw, read, raw.length - read, offset + read);
        if (!bytesRead) throw new Error('时间线在导出截点之前被截断');
        read += bytesRead;
      }
      const checkpoint = block % CHECKPOINT_BLOCKS === 0;
      if (checkpoint) window = Buffer.alloc(0);
      let encoded = checkpoint ? null : makePatch(window, raw);
      if (encoded && compression === 'deflate' && deflateRawSync(encoded).length >= deflateRawSync(raw).length) encoded = null;
      const mode = encoded ? 'delta' : 'raw';
      if (!encoded) encoded = raw;
      else {
        // Verify every generated patch before persisting it, independently of matching.
        if (!applyPatch(window, encoded, raw.length).equals(raw)) throw new Error('差分编码自检失败');
        deltaBlocks++;
      }
      for (const byte of raw) {
        if (byte === 10) { if (nonWhitespace) events++; nonWhitespace = false; }
        else if (byte !== 13 && byte !== 32 && byte !== 9) nonWhitespace = true;
      }
      const entry = { index: block, offset, bytes: raw.length, sha256: sha256(raw), mode,
        dataOffset, dataBytes: encoded.length, dataSha256: sha256(encoded),
        windowStart: offset - window.length, windowBytes: window.length, checkpoint };
      const line = Buffer.from(`${JSON.stringify(entry)}\n`);
      await writeAll(data, encoded); await writeAll(index, line);
      timelineHash.update(raw); dataHash.update(encoded); indexHash.update(line);
      dataOffset += encoded.length; offset += raw.length; block++;
      window = Buffer.concat([window, raw]);
      if (window.length > WINDOW_BYTES) window = Buffer.from(window.subarray(window.length - WINDOW_BYTES));
      onProgress?.({ phase: 'encode', bytesRead: offset, totalBytes: byteLength, completed: block, total: Math.ceil(byteLength / BLOCK_BYTES) });
    }
    if (nonWhitespace) events++;
    checkAbort(signal);
    return { bytes: offset, sha256: timelineHash.digest('hex'), eventCount: events, blocks: block, deltaBlocks,
      data: { path: 'data.bin', bytes: dataOffset, sha256: dataHash.digest('hex') },
      index: { path: 'index.jsonl', bytes: (await index.stat()).size, sha256: indexHash.digest('hex') },
      parameters: { codec: 'copy-add-v1', data: 'data.bin', index: 'index.jsonl', blockBytes: BLOCK_BYTES, windowBytes: WINDOW_BYTES, checkpointBlocks: CHECKPOINT_BLOCKS, blocks: block } };
  } finally { await Promise.allSettled([input.close(), data?.close(), index?.close()].filter(Boolean)); }
}

module.exports = { BLOCK_BYTES, WINDOW_BYTES, CHECKPOINT_BLOCKS, makePatch, applyPatch, encodeTimeline, checkAbort, writeAll, sha256 };
