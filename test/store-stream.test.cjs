'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SessionStore } = require('../out/session-store.cjs');
const execute = promisify(execFile);

async function setup(t) {
  const parent = path.resolve(__dirname, '../output/test-temp');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'stream-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new SessionStore(path.join(directory, 'sessions')).init();
  const session = await store.create('流式记录');
  return { directory, store, session, timeline: path.join(store.getSessionDirectory(session.id), 'timeline.jsonl') };
}

test('cursor pagination and incremental updates do not skip events while recording', async t => {
  const { store, session } = await setup(t);
  for (let i = 1; i <= 25; i++) await store.append(session.id, { type: i % 2 ? 'action.click' : 'page.navigation', payload: { value: i } });
  const first = await store.timeline({ sessionId: session.id, limit: 5 });
  assert.deepEqual(first.events.map(event => event.seq), [25, 24, 23, 22, 21]);
  assert.equal(first.total, 25); assert.equal(first.hasMore, true); assert.equal(first.snapshotSeq, 25);
  await store.append(session.id, { type: 'action.input', payload: { value: 'new' } });
  const earlier = await store.timeline({ sessionId: session.id, limit: 5, beforeSeq: 21, snapshotSeq: first.snapshotSeq });
  assert.deepEqual(earlier.events.map(event => event.seq), [20, 19, 18, 17, 16]);
  assert.equal(earlier.total, 25);
  const all = []; let cursor = 0;
  while (true) {
    const delta = await store.timeline({ sessionId: session.id, afterSeq: cursor, limit: 3, types: ['action'] });
    assert.equal(delta.total, 14);
    all.push(...delta.events.map(event => event.seq));
    assert.ok(delta.scannedThroughSeq > cursor); cursor = delta.scannedThroughSeq;
    if (!delta.hasMore) break;
  }
  assert.deepEqual(all, [...Array.from({ length: 13 }, (_, i) => i * 2 + 1), 26]);
  const empty = await store.timeline({ sessionId: session.id, afterSeq: cursor, types: ['dom.snapshot'] });
  assert.equal(empty.total, 0); assert.equal(empty.scannedThroughSeq, 26); assert.deepEqual(empty.events, []);
});

test('search scans complete payloads across chunk boundaries and extends as new events arrive', async t => {
  const { store, session } = await setup(t);
  const query = '跨块😀Search';
  const value = 'a'.repeat(65510) + query + 'b'.repeat(200000);
  const original = await store.append(session.id, { type: 'action.input', payload: { value } });
  await store.append(session.id, { type: 'page.navigation', payload: { value: query } });
  const first = await store.timeline({ sessionId: session.id, query: query.toLocaleLowerCase(), types: ['action'], limit: 1 });
  assert.equal(first.total, 1); assert.equal(first.events[0].id, original.id);
  assert.ok(first.events[0].payload.value.length <= 2048); assert.equal(first.events[0].payloadTruncated, true);
  await store.append(session.id, { type: 'action.input', payload: { value: query } });
  const next = await store.timeline({ sessionId: session.id, query, types: ['action'], afterSeq: first.snapshotSeq });
  assert.equal(next.total, 2); assert.deepEqual(next.events.map(event => event.seq), [3]);
  const historical = await store.timeline({ sessionId: session.id, query, types: ['action'], snapshotSeq: first.snapshotSeq });
  assert.equal(historical.total, 1); assert.deepEqual(historical.events.map(event => event.seq), [1]);
});

test('tail recovery preserves exact complete bytes including whitespace and CRLF', async t => {
  const { store, session, timeline } = await setup(t);
  const first = ` { "payload" : {"html":"中文😀","reason":"start"}, "seq":1, "type":"dom.snapshot", "id":"${session.id}:00000001" }\r\n\n`;
  const damaged = first + '{"seq":2,"type":';
  await fs.writeFile(timeline, damaged);
  await store.update(session.id, { status: 'stopped' });
  const restored = await new SessionStore(store.rootDir).init();
  const metadata = restored.getSession(session.id);
  const recovered = await fs.readFile(timeline);
  assert.ok(recovered.subarray(0, Buffer.byteLength(first)).equals(Buffer.from(first)));
  assert.equal(await fs.readFile(path.join(restored.getSessionDirectory(session.id), metadata.recoveryFile), 'utf8'), damaged);
  assert.equal(metadata.eventCount, 2); assert.equal(metadata.snapshotCount, 1); assert.equal(metadata.status, 'interrupted');
  const page = await restored.timeline({ sessionId: session.id, types: ['dom.snapshot'] });
  assert.equal(page.events[0].payload.htmlBytes, Buffer.byteLength('中文😀'));
});

test('middle corruption fails without touching source bytes or leaving staging indexes', async t => {
  const { store, session, timeline } = await setup(t);
  const damaged = '{"seq":1,"type":"action.click"}\n{bad}\n{"seq":3,"type":"action.click"}\n';
  await fs.writeFile(timeline, damaged);
  await assert.rejects(new SessionStore(store.rootDir).init(), /原文件已保留/);
  assert.equal(await fs.readFile(timeline, 'utf8'), damaged);
  assert.equal((await fs.readdir(store.getSessionDirectory(session.id))).filter(name => name.endsWith('.tmp')).length, 0);
});

test('a valid final record without LF is indexed and safely separated from later append', async t => {
  const { store, session, timeline } = await setup(t);
  const raw = `{"payload":{"value":"exact"},"seq":1,"type":"action.input","id":"${session.id}:00000001"}`;
  await fs.writeFile(timeline, raw); await store.update(session.id, { status: 'stopped' });
  const restored = await new SessionStore(store.rootDir).init();
  assert.equal(await fs.readFile(timeline, 'utf8'), raw + '\n');
  const preview = await restored.getEvent(session.id, `${session.id}:00000001`, { preview: true });
  assert.equal(preview.preview, raw + '\n'); assert.equal(preview.bytes, Buffer.byteLength(raw) + 1);
  await restored.append(session.id, { type: 'action.click', payload: {} });
  assert.equal((await restored.timeline({ sessionId: session.id })).total, 2);
});

test('64 MiB single event is indexed, searched and previewed under a 48 MiB JS heap', { timeout: 60000 }, async t => {
  const { store, session, timeline, directory } = await setup(t);
  await store.update(session.id, { status: 'stopped' });
  const handle = await fs.open(timeline, 'w');
  try {
    await handle.write('{"payload":{"html":"');
    const block = Buffer.alloc(65536, 120);
    for (let n = 0; n < 1024; n++) await handle.write(block);
    await handle.write(`巨型尾部","reason":"large"},"seq":1,"type":"dom.snapshot","id":"${session.id}:00000001"}\n`);
  } finally { await handle.close(); }
  const script = path.join(directory, 'bounded-memory.cjs');
  await fs.writeFile(script, `
const assert = require('node:assert/strict');
const { SessionStore } = require(${JSON.stringify(path.resolve(__dirname, '../out/session-store.cjs'))});
(async () => {
  const store = await new SessionStore(${JSON.stringify(store.rootDir)}).init();
  const id = ${JSON.stringify(session.id)};
  const page = await store.timeline({sessionId:id});
  assert.equal(page.total, 1); assert.equal(page.events[0].payload.htmlBytes, 67108864 + Buffer.byteLength('巨型尾部'));
  const found = await store.timeline({sessionId:id,query:'巨型尾部'}); assert.equal(found.total, 1);
  const preview = await store.getEvent(id, id + ':00000001', {preview:true,maxBytes:100000});
  assert.ok(preview.truncated); assert.ok(preview.preview.length <= 100000); assert.ok(preview.bytes > 67108864);
  await assert.rejects(store.getEvent(id, id + ':00000001'), /预览或导出/);
  console.log(JSON.stringify({passed:true,heapUsed:process.memoryUsage().heapUsed,maxRSS:process.resourceUsage().maxRSS}));
})().catch(error => { console.error(error); process.exit(1); });
`);
  const result = await execute(process.execPath, ['--max-old-space-size=48', script], { windowsHide: true, timeout: 50000 });
  assert.equal(JSON.parse(result.stdout).passed, true);
});

test('short filesystem writes do not corrupt rebuilt indexes or streamed search caches', async t => {
  const { store, session } = await setup(t);
  await store.append(session.id, { type: 'action.input', payload: { value: '索引检索' } });
  await store.append(session.id, { type: 'action.input', payload: { value: '索引检索' } });
  await store.update(session.id, { status: 'stopped' });
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (/timeline\.(idx|summaries)|\.search-/.test(String(args[0]))) {
      const originalWrite = handle.write.bind(handle);
      handle.write = (buffer, offset = 0, length = buffer.length - offset, position = null) => originalWrite(buffer, offset, Math.min(length, 7), position);
    }
    return handle;
  };
  try {
    const restored = await new SessionStore(store.rootDir).init();
    const result = await restored.timeline({ sessionId: session.id, query: '索引检索' });
    assert.equal(result.total, 2); assert.deepEqual(result.events.map(event => event.seq), [2, 1]);
    assert.equal((await restored.getEvent(session.id, result.events[0].id)).payload.value, '索引检索');
  } finally { fs.open = originalOpen; }
});

test('indexed category fast path preserves exact and dotted-prefix type filtering', async t => {
  const { store, session } = await setup(t);
  for (const type of ['action', 'action.click', 'dom.snapshot', 'dom.snapshot.extra', 'dom.other']) await store.append(session.id, { type, payload: {} });
  const actions = await store.timeline({ sessionId: session.id, types: ['action'] });
  assert.equal(actions.total, 2); assert.deepEqual(actions.events.map(event => event.type), ['action.click', 'action']);
  const snapshots = await store.timeline({ sessionId: session.id, types: ['dom.snapshot'] });
  assert.equal(snapshots.total, 2); assert.deepEqual(snapshots.events.map(event => event.type), ['dom.snapshot.extra', 'dom.snapshot']);
  assert.equal((await store.timeline({ sessionId: session.id, types: ['dom'] })).total, 3);
});
