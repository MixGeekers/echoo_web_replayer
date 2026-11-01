'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { scanTimeline, compactEventBounded } = require('../src/store-parser.cjs');

async function fixture(t) {
  const root = path.join(__dirname, '..', 'output', 'test-temp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'stream-parser-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'timeline.jsonl');
}

test('streaming parser keeps exact record ranges and Unicode across input chunks', async t => {
  const filename = await fixture(t);
  const huge = '中文😀'.repeat(400000);
  const snapshot = { payload: { html: huge, tree: { value: huge }, forms: [{ value: huge }], viewport: { width: 1200, height: 700 }, reason: '恢复' }, seq: 1, type: 'dom.snapshot', id: 's:1', summary: '快照' };
  const action = { type: 'action.input', seq: 2, payload: { value: '秘密密码', target: { selector: '#password' } }, summary: '输入' };
  const first = Buffer.from(JSON.stringify(snapshot) + '\r\n');
  const second = Buffer.from(JSON.stringify(action));
  await fs.writeFile(filename, Buffer.concat([Buffer.from('\n \r\n'), first, second]));
  const rows = [];
  for await (const row of scanTimeline(filename)) rows.push(row);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].offset, 4);
  assert.equal(rows[0].length, first.length);
  assert.equal(rows[1].offset, 4 + first.length);
  assert.equal(rows[1].length, second.length);
  assert.equal(rows[0].event.payload.htmlBytes, Buffer.byteLength(huge));
  assert.equal(rows[0].event.payload.reason, '恢复');
  assert.deepEqual(rows[0].event.payload.viewport, snapshot.payload.viewport);
  assert.equal(rows[0].event.payload.html, undefined);
  assert.equal(rows[0].event.payload.forms, undefined);
  assert.ok(JSON.stringify(rows[0].event).length < 500);
  assert.equal(rows[1].event.payload.value, '秘密密码');
  const slice = [];
  for await (const row of scanTimeline(filename, { startOffset: rows[1].offset })) slice.push(row);
  assert.deepEqual(slice, [rows[1]]);
});

test('large mutation arrays count all records without retaining their payloads', async t => {
  const filename = await fixture(t);
  const source = { seq: 1, type: 'dom.mutation', payload: { mutations: Array.from({ length: 10000 }, (_, i) => ({ id: i, text: '数据' })) } };
  await fs.writeFile(filename, JSON.stringify(source) + '\n');
  const result = [];
  for await (const row of scanTimeline(filename)) result.push(row.event);
  assert.deepEqual(result[0].payload, { count: 10000 });
});

test('bounded action summaries preserve small values and cap giant payload fields', async t => {
  const filename = await fixture(t);
  const source = { seq: 1, type: 'action.input', payload: { value: 'a'.repeat(1000000), target: { selector: '#value' }, items: Array.from({ length: 10000 }, () => ({ value: 'b'.repeat(500) })) } };
  await fs.writeFile(filename, JSON.stringify(source) + '\n');
  let event;
  for await (const row of scanTimeline(filename)) event = row.event;
  assert.equal(event.payload.value.length, 2048);
  assert.equal(event.payload.target.selector, '#value');
  assert.equal(event.payloadTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 12000);
  const appended = compactEventBounded(source);
  assert.equal(appended.payload.value.length, 2048);
  assert.equal(appended.payload.target.selector, '#value');
  assert.ok(Buffer.byteLength(JSON.stringify(appended)) < 12000);
});

test('damaged records identify the original byte offset without changing the file', async t => {
  const filename = await fixture(t);
  const valid = '{"seq":1,"type":"action.click","payload":{}}\r\n';
  const content = Buffer.from(valid + '{"seq":2,"type":\n{"seq":3,"type":"action.click"}\n');
  await fs.writeFile(filename, content);
  let found = 0;
  await assert.rejects(async () => {
    for await (const row of scanTimeline(filename)) { assert.equal(row.event.seq, 1); found++; }
  }, error => error.offset === Buffer.byteLength(valid) && error.lineNumber === 2);
  assert.equal(found, 1);
  assert.deepEqual(await fs.readFile(filename), content);
});

test('invalid structure and arbitrary field ordering are checked by streaming JSON parser', async t => {
  const filename = await fixture(t);
  for (const input of ['[]\n', '{"seq":"1","type":"x"}\n', '{"seq":1,"type":{}}\n', '{"seq":1,"type":"x",}\n']) {
    await fs.writeFile(filename, input);
    await assert.rejects(async () => { for await (const _row of scanTimeline(filename)) {} });
  }
  await fs.writeFile(filename, '{"payload":{"value":"x"},"seq":4,"type":"action.input"}');
  const rows = [];
  for await (const row of scanTimeline(filename)) rows.push(row);
  assert.equal(rows[0].event.seq, 4);
  assert.equal(rows[0].event.payload.value, 'x');
});

test('HTML byte count combines Unicode surrogate chunks exactly', async t => {
  const filename = await fixture(t);
  const html = 'x'.repeat(255) + '😀' + '\ud800' + '末';
  const source = `{"seq":1,"type":"dom.snapshot","payload":{"html":${JSON.stringify(html).replace('😀', '\\ud83d\\ude00')}}}\n`;
  await fs.writeFile(filename, source);
  for await (const row of scanTimeline(filename)) assert.equal(row.event.payload.htmlBytes, Buffer.byteLength(html));
});

test('abort during a giant event stops within input chunks without a repairable tail error', async t => {
  const filename = await fixture(t);
  const handle = await fs.open(filename, 'w');
  try {
    await handle.write('{"seq":1,"type":"dom.snapshot","payload":{"html":"');
    const block = 'a'.repeat(64 * 1024);
    for (let i = 0; i < 256; i++) await handle.write(block);
    await handle.write('"}}\n');
  } finally { await handle.close(); }
  const originalSize = (await fs.stat(filename)).size;
  const controller = new AbortController();
  const progress = [];
  let records = 0;
  await assert.rejects(async () => {
    for await (const _row of scanTimeline(filename, {
      signal: controller.signal,
      onProgress(value) { progress.push(value); if (value.bytesRead >= 128 * 1024) controller.abort(); },
    })) records++;
  }, error => error.name === 'AbortError' && !Object.hasOwn(error, 'offset'));
  assert.equal(records, 0, 'the giant event was not completed before cancellation');
  assert.equal(progress.length, 2);
  assert.equal(progress[1].bytesRead, 128 * 1024);
  assert.equal(progress[1].totalBytes, originalSize);
  assert.equal((await fs.stat(filename)).size, originalSize);
});

test('bounded metadata ignores object values and preserves existing snapshot byte counts', () => {
  const huge = { data: 'a'.repeat(1000000) };
  const result = compactEventBounded({ seq: 1, type: 'dom.snapshot', id: huge, title: huge, elapsedMs: Infinity, payload: { reason: 'start', htmlBytes: 1234567 } });
  assert.equal(result.id, undefined);
  assert.equal(result.title, undefined);
  assert.equal(result.elapsedMs, undefined);
  assert.equal(result.payload.htmlBytes, 1234567);
  assert.ok(JSON.stringify(result).length < 200);
});
