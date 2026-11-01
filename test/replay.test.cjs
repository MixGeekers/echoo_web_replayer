'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { SessionStore } = require('../out/session-store.cjs');
const { ResourceRecorder } = require('../out/resource-recorder.cjs');
const { resourceURL, cssText } = require('../out/shared/replay-urls.js');
const { exportSession } = require('../out/exporter.cjs');

async function setup(t) {
  const root = path.join(__dirname, '../output/test-temp'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'replay-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new SessionStore(path.join(directory, 'recordings')).init();
  const session = await store.create('Replay test', 'https://site.test/');
  return { directory, store, id: session.id };
}

test('seek uses the preceding snapshot and chunks obey a frozen sequence boundary', async t => {
  const { store, id } = await setup(t);
  await assert.rejects(store.replaySeek({ sessionId: id }), /没有可回放/);
  const first = await store.append(id, { type: 'dom.snapshot', documentId: 'a', payload: { tree: { nodeType: 9, nodeId: 'n1' }, forms: [{ value: 'initial' }] } });
  const input = await store.append(id, { type: 'action.input', documentId: 'a', payload: { form: { value: 'edited' } } });
  const mutation = await store.append(id, { type: 'dom.mutation', documentId: 'a', payload: { records: [{ type: 'characterData', newValue: 'changed' }] } });
  const second = await store.append(id, { type: 'dom.snapshot', documentId: 'b', payload: { tree: { nodeType: 9, nodeId: 'n1' } } });
  const seek = await store.replaySeek({ sessionId: id, targetSeq: mutation.seq, endSeq: second.seq });
  assert.equal(seek.snapshot.seq, first.seq);
  assert.equal(seek.targetSeq, mutation.seq);
  assert.equal((await store.replaySeek({ sessionId: id, targetSeq: second.seq })).snapshot.documentId, 'b');
  assert.equal((await store.replaySeek({ sessionId: id, targetSeq: 0 })).snapshot, null);
  await store.append(id, { type: 'action.click', payload: { late: true } });
  const chunk1 = await store.replayChunk({ sessionId: id, afterSeq: first.seq, endSeq: seek.endSeq, limit: 1 });
  assert.equal(chunk1.events[0].payload.form.value, 'edited');
  assert.equal(chunk1.afterSeq, input.seq); assert.equal(chunk1.hasMore, true);
  const chunk2 = await store.replayChunk({ sessionId: id, afterSeq: chunk1.afterSeq, endSeq: seek.endSeq });
  assert.deepEqual(chunk2.events.map(event => event.seq), [mutation.seq, second.seq]);
  assert.equal(chunk2.hasMore, false);
  const byTime = await store.replaySeek({ sessionId: id, timeMs: Number.MAX_SAFE_INTEGER, endSeq: first.seq });
  assert.equal(byTime.targetSeq, first.seq);
  await assert.rejects(store.replayChunk({ sessionId: '../bad', afterSeq: 0, endSeq: 1 }), /无效/);
});

test('resource and CSS URLs preserve relative bases, imports, fragments and quoted strings', () => {
  const base = 'https://site.test/css/main.css';
  const rewritten = cssText('/* url(no) */ @import "./theme.css"; a{background:url(../img/logo.svg#icon);content:"url(unchanged)"} b{src:url("../fonts/a\\ b.woff2")}', base, 'session-a', 42);
  assert.match(rewritten, /\/\* url\(no\) \*\//);
  assert.match(rewritten, /content:"url\(unchanged\)"/);
  assert.ok(rewritten.includes(encodeURIComponent('https://site.test/css/theme.css')));
  assert.ok(rewritten.includes(`${encodeURIComponent('https://site.test/img/logo.svg')}&at=42&end=42#icon`));
  assert.ok(rewritten.includes(encodeURIComponent('https://site.test/fonts/a%20b.woff2')));
  assert.equal(resourceURL('javascript:alert(1)', base, 'session-a', 0), '');
  assert.equal(resourceURL('#filter', base, 'session-a', 0), '#filter');
});

test('resource serving uses captured versions and never fetches missing resources from the network', async t => {
  const { store, id, directory } = await setup(t);
  const recorder = new ResourceRecorder(store, {});
  const put = async text => {
    const body = Buffer.from(text), sha256 = createHash('sha256').update(body).digest('hex');
    const source = path.join(directory, sha256); await fs.writeFile(source, body);
    await store.saveResource(id, { url: 'https://site.test/app.css', mimeType: 'text/css', sha256, bytes: body.length, status: 'saved' }, source);
    return store.getSession(id).lastSeq;
  };
  const oldSeq = await put('body{color:red;background:url(bg.png)}');
  const newSeq = await put('body{color:blue}');
  const request = at => ({ method: 'GET', url: resourceURL('https://site.test/app.css', '', id, at) });
  assert.match(await (await recorder.respond(request(oldSeq))).text(), /color:red/);
  assert.match(await (await recorder.respond(request(newSeq))).text(), /color:blue/);
  assert.match(await (await recorder.respond(request(oldSeq))).text(), /tracedock-resource:/);
  assert.equal((await recorder.respond({ method: 'GET', url: resourceURL('https://offline.test/absent.png', '', id, 99) })).status, 404);
  assert.equal((await recorder.summary(id)).missing, 1);
  assert.equal((await recorder.respond({ method: 'GET', url: resourceURL('file:///etc/passwd', '', id, 99) })).status, 404);
  const frozen = await recorder.respond({ method: 'GET', url: resourceURL('https://site.test/app.css', '', id, 0, 0) });
  assert.equal(frozen.status, 404, 'a replay cutoff must not read assets captured later');
  const latest = (await recorder.catalog(id)).at(-1);
  await fs.writeFile(path.join(store.getSessionDirectory(id), 'assets', latest.sha256), 'corrupt');
  assert.equal((await recorder.respond(request(newSeq))).status, 404);
  assert.ok((await recorder.summary(id)).missingURLs.includes('https://site.test/app.css'));
});

for (const encoding of ['delta', 'full']) test(`${encoding} ZIP restores archived resources with hashes and excludes later resources`, async t => {
  const { store, id, directory } = await setup(t);
  const body = Buffer.from('body{color:#2463eb}'), sha256 = createHash('sha256').update(body).digest('hex');
  const source = path.join(directory, 'style.css'); await fs.writeFile(source, body);
  await store.saveResource(id, { url: 'https://site.test/style.css', sha256, bytes: body.length, mimeType: 'text/css', status: 'saved' }, source);
  const capture = await store.capture(id);
  await store.saveResource(id, { url: 'https://site.test/later.css', sha256, bytes: body.length, mimeType: 'text/css', status: 'saved' }, source);
  const zip = path.join(directory, `${encoding}.zip`);
  await exportSession({ store, sessionId: id, capture, destination: zip, encoding });
  const output = path.join(directory, 'restored');
  await promisify(execFile)(process.env.TRACEDOCK_PYTHON || 'python', [path.join(__dirname, '../out/restore.py'), zip, '--output', output]);
  assert.deepEqual(await fs.readFile(path.join(output, 'assets', sha256)), body);
  const manifest = await fs.readFile(path.join(output, 'resources.jsonl'), 'utf8');
  assert.ok(manifest.includes('style.css')); assert.ok(!manifest.includes('later.css'));
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'restore-report.json'), 'utf8')).status, 'ok');
});
