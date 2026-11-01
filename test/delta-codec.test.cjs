'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { makePatch, applyPatch, encodeTimeline, BLOCK_BYTES, WINDOW_BYTES, CHECKPOINT_BLOCKS } = require('../src/delta-codec.cjs');

test('COPY/ADD preserves arbitrary bytes and shifted multiple edits, rejects malformed instructions', () => {
  const base = Buffer.concat([randomBytes(4096), Buffer.from('中文🙂\0\r\n'.repeat(1000)), randomBytes(2048)]);
  const next = Buffer.concat([base.subarray(0, 222), Buffer.from('增加\ud800'), base.subarray(222, 4000), randomBytes(71), base.subarray(4100)]);
  const patch = makePatch(base, next);
  assert.ok(patch && patch.length < next.length);
  assert.deepEqual(applyPatch(base, patch, next.length), next);
  assert.equal(makePatch(Buffer.alloc(0), Buffer.from('a')), null);
  for (const bad of [Buffer.from([2, 0, 0, 0, 0]), Buffer.from([0, 5]), Buffer.from([0, 1, 0, 0, 0]), Buffer.from([1, 255, 255, 255, 127, 1, 0, 0, 0])]) {
    assert.throws(() => applyPatch(base, bad, 1));
  }
});

test('fixed byte blocks restore exactly across UTF-8/event boundaries and independent checkpoints', async t => {
  const parent = path.join(__dirname, '..', 'output', 'test-temp'); await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'delta-codec-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const timelinePath = path.join(dir, 'timeline.jsonl');
  const handle = await fs.open(timelinePath, 'w');
  const hash = createHash('sha256'); let bytes = 0;
  for (let i = 0; bytes < BLOCK_BYTES * 17 + 31; i++) {
    const line = Buffer.from(`${JSON.stringify({ seq: i + 1, type: 'dom.snapshot', payload: { html: '<p>中文🙂</p>'.repeat(8000), input: `变更${i}`, nil: '\0', surrogate: '\ud800' } })}\n`);
    await handle.write(line); hash.update(line); bytes += line.length;
  }
  await handle.close();
  const result = await encodeTimeline({ timelinePath, byteLength: bytes, dataPath: path.join(dir, 'data.bin'), indexPath: path.join(dir, 'index.jsonl'), compression: 'store' });
  assert.equal(result.sha256, hash.digest('hex')); assert.ok(result.deltaBlocks > 0);
  const entries = (await fs.readFile(path.join(dir, 'index.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const data = await fs.open(path.join(dir, 'data.bin'), 'r');
  let window = Buffer.alloc(0), offset = 0, checkpointOffset = 0;
  const restored = createHash('sha256');
  try {
    for (const entry of entries) {
      const isCheckpoint = entry.index % CHECKPOINT_BLOCKS === 0;
      assert.equal(entry.checkpoint, isCheckpoint);
      if (isCheckpoint) { window = Buffer.alloc(0); checkpointOffset = offset; assert.equal(entry.mode, 'raw'); }
      assert.equal(entry.windowStart, Math.max(checkpointOffset, offset - WINDOW_BYTES));
      assert.equal(entry.windowBytes, window.length);
      const encoded = Buffer.alloc(entry.dataBytes); await data.read(encoded, 0, encoded.length, entry.dataOffset);
      assert.equal(createHash('sha256').update(encoded).digest('hex'), entry.dataSha256);
      const raw = entry.mode === 'raw' ? encoded : applyPatch(window, encoded, entry.bytes);
      assert.equal(createHash('sha256').update(raw).digest('hex'), entry.sha256);
      restored.update(raw); offset += raw.length;
      window = Buffer.concat([window, raw]); if (window.length > WINDOW_BYTES) window = window.subarray(window.length - WINDOW_BYTES);
    }
  } finally { await data.close(); }
  assert.equal(offset, bytes); assert.equal(restored.digest('hex'), result.sha256);
});

test('empty input, truncated source and cancellation are explicit', async t => {
  const parent = path.join(__dirname, '..', 'output', 'test-temp'); await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'delta-empty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const timelinePath = path.join(dir, 'source'); await fs.writeFile(timelinePath, '');
  const result = await encodeTimeline({ timelinePath, byteLength: 0, dataPath: path.join(dir, 'data'), indexPath: path.join(dir, 'index') });
  assert.equal(result.blocks, 0); assert.equal(result.eventCount, 0);
  await assert.rejects(encodeTimeline({ timelinePath, byteLength: 1, dataPath: path.join(dir, 'data2'), indexPath: path.join(dir, 'index2') }), /截断/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(encodeTimeline({ timelinePath, byteLength: 0, dataPath: path.join(dir, 'data3'), indexPath: path.join(dir, 'index3'), signal: controller.signal }), { name: 'AbortError' });
});
