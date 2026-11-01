'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deriveFiles } = require('../out/export-derived.cjs');

async function setup(t, contents) {
  const parent = path.resolve(__dirname, '../output/test-temp');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'derived-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const timelinePath = path.join(directory, 'timeline.jsonl');
  await fs.writeFile(timelinePath, contents);
  return { directory, timelinePath, byteLength: Buffer.byteLength(contents), staging: path.join(directory, 'out'), metadata: { id: 'test', name: '派生输出' }, capturedAt: '2026-10-29T00:00:00Z' };
}

test('streamed derived snapshots preserve nested values, field order, duplicate metadata override and Unicode', async t => {
  const payload = {
    html: '<html>😀\u0000\r\n孤立\ud800</html>', outerHTML: 'ignored', reason: 'start',
    tree: { children: ['😀', '\ud800', '"\\\n', null, false, 2.5e-100], text: '完整' },
    frames: [{ html: '<p>iframe</p>' }], shadowRoots: [], forms: [{ value: 'secret' }],
    eventId: 'payload-overrides-event-id', title: 'payload-title',
  };
  const rows = [
    { payload, title: '原标题', url: 'https://test/', documentId: 'doc1', timestamp: '2026-10-29T00:00:00Z', id: 'event1', seq: 1, type: 'dom.snapshot', summary: '快照', elapsedMs: 25 },
    { payload: ['array payload on an ordinary event'], seq: 2, id: 'event2', type: 'action.click', summary: '点击' },
  ];
  const options = await setup(t, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  const files = [], snapshots = [];
  const result = await deriveFiles({ ...options, onFile: file => files.push(file), onSnapshot: value => snapshots.push(value) });
  assert.deepEqual(result, { eventCount: 2, lastSeq: 2, actionCount: 1, mutationCount: 0, snapshotCount: 1 });
  assert.deepEqual(await fs.readFile(path.join(options.staging, 'snapshots/00000001.html')), Buffer.from(payload.html));
  const state = JSON.parse(await fs.readFile(path.join(options.staging, 'snapshots/00000001.state.json'), 'utf8'));
  const { html, outerHTML, ...rest } = payload;
  assert.deepEqual(state, { eventId: 'event1', seq: 1, timestamp: rows[0].timestamp, documentId: 'doc1', url: rows[0].url, title: rows[0].title, htmlFile: '00000001.html', ...rest });
  assert.equal(snapshots[0].seq, 1);
  assert.match(await fs.readFile(path.join(options.staging, 'timeline.md'), 'utf8'), /\| 2 \|.*action.click/);
  for (const file of files) {
    const bytes = await fs.readFile(path.join(options.staging, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  assert.equal((await fs.readdir(options.staging)).some(name => name.startsWith('.derive-')), false);
});

test('large strings and giant property names spill without truncating HTML, payload or metadata', async t => {
  const html = '😀中文A'.repeat(220000);
  const longKey = 'k'.repeat(90000);
  const url = `https://example.test/${'url'.repeat(30000)}`;
  const payload = { html, [longKey]: '完整键', tree: { blob: 'B'.repeat(1800000), array: ['x', { y: 'z' }] }, forms: [] };
  const row = { payload, url, title: 'Title', type: 'dom.snapshot', id: 'event1', seq: 1, documentId: 'd', summary: 'large' };
  const options = await setup(t, JSON.stringify(row) + '\n');
  await deriveFiles(options);
  assert.deepEqual(await fs.readFile(path.join(options.staging, 'snapshots/00000001.html')), Buffer.from(html));
  const state = JSON.parse(await fs.readFile(path.join(options.staging, 'snapshots/00000001.state.json'), 'utf8'));
  assert.equal(state.url, url);
  assert.equal(state[longKey], '完整键');
  assert.deepEqual(state.tree, payload.tree);
});

test('null HTML falls back to outerHTML while empty HTML remains empty', async t => {
  const rows = [
    { payload: { html: null, outerHTML: '<p>fallback 😀</p>' }, seq: 1, type: 'dom.snapshot' },
    { payload: { html: '', outerHTML: 'must not use' }, seq: 2, type: 'dom.snapshot' },
    { payload: null, seq: 3, type: 'dom.snapshot' },
  ];
  const options = await setup(t, rows.map(JSON.stringify).join('\n'));
  await deriveFiles(options);
  assert.equal(await fs.readFile(path.join(options.staging, 'snapshots/00000001.html'), 'utf8'), rows[0].payload.outerHTML);
  assert.equal(await fs.readFile(path.join(options.staging, 'snapshots/00000002.html'), 'utf8'), '');
  assert.equal(await fs.readFile(path.join(options.staging, 'snapshots/00000003.html'), 'utf8'), '');
});

test('fixed byte boundary excludes later events, invalid input and cancellation reject cleanly', async t => {
  const first = `${JSON.stringify({ payload: {}, seq: 1, type: 'action.click' })}\n`;
  const options = await setup(t, first + `${JSON.stringify({ payload: {}, seq: 2, type: 'action.click' })}\n`);
  const result = await deriveFiles({ ...options, byteLength: Buffer.byteLength(first) });
  assert.equal(result.eventCount, 1);
  const bad = await setup(t, '{"payload":{"html":"unfinished');
  await assert.rejects(deriveFiles(bad), /Parser|incomplete|expected/i);
  const controller = new AbortController();
  const large = await setup(t, JSON.stringify({ payload: { html: 'x'.repeat(600000) }, seq: 1, type: 'dom.snapshot' }));
  await assert.rejects(deriveFiles({ ...large, signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.equal((await fs.readdir(large.staging)).some(name => name.startsWith('.derive-')), false);
});
