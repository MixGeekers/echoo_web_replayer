'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const AdmZip = require('adm-zip');
const { SessionStore } = require('../out/session-store.cjs');
const { exportSession } = require('../out/exporter.cjs');

const run = promisify(execFile);
const python = process.env.TRACEDOCK_PYTHON || 'python';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function setup(t) {
  const root = path.resolve(__dirname, '../output/test-temp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'export-integration-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(root + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store: await new SessionStore(path.join(directory, 'sessions')).init() };
}

async function fixture(store) {
  const session = await store.create('差分一致性 · 原始数据', 'https://example.test/中文');
  const html = `<html><body>${'<div data-key="unchanged">中文 😀 é &amp; 字节边界</div>'.repeat(3200)}</body></html>`;
  const payload = {
    reason: 'manual', html, tree: { id: 'n1', children: [{ id: 'n2', text: '😀' }] },
    forms: [{ type: 'password', value: 'raw-secret-中文\u0000\ud800\r\n😀', checked: true }],
    frames: [{ url: 'about:srcdoc', html: '<input value="嵌套">' }],
    shadowRoots: [{ hostId: 'n2', html: '<b>开放 Shadow DOM</b>' }],
    coverage: { mainDocument: true }, empty: '', nil: null, bool: false,
  };
  const snapshots = [];
  for (let index = 0; index < 10; index++) {
    snapshots.push(await store.append(session.id, {
      type: 'dom.snapshot', documentId: 'same-document',
      payload: { ...payload, reason: `checkpoint-${index}`, html: html.replace('</body>', `<p>变更 ${index}</p></body>`) },
    }));
    await store.append(session.id, { type: 'action.input', payload: { value: payload.forms[0].value, target: { selector: '#password' } } });
  }
  await store.update(session.id, { status: 'stopped', endedAt: new Date().toISOString() });
  return { session, snapshots };
}

async function restoreBundled(directory, filename, outputName = 'restored', extra = []) {
  const archive = new AdmZip(filename);
  const script = path.join(directory, 'bundled-restore.py');
  const bytes = archive.readFile('restore.py');
  assert.ok(bytes && bytes.length > 0, 'the executable restore tool is part of the delivery ZIP');
  await fs.writeFile(script, bytes);
  const output = path.join(directory, outputName);
  await run(python, [script, filename, '--output', output, ...extra], { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  return { archive, output, script, report: JSON.parse(await fs.readFile(path.join(output, 'restore-report.json'), 'utf8')) };
}

for (const encoding of ['delta', 'full']) {
  for (const compression of ['deflate', 'store']) {
    test(`${encoding}/${compression}: bundled Python restores the exact timeline and raw values`, { timeout: 180000 }, async t => {
      const { directory, store } = await setup(t);
      const { session, snapshots } = await fixture(store);
      const capture = await store.capture(session.id);
      const source = await fs.readFile(capture.timelinePath);
      const filename = path.join(directory, `${encoding}-${compression}.zip`);
      const result = await exportSession({ store, sessionId: session.id, capture, destination: filename, encoding, compression, appVersion: 'integration-test' });
      assert.equal(result.eventCount, capture.metadata.eventCount);
      const { archive, output, report } = await restoreBundled(directory, filename);
      const manifest = JSON.parse(archive.readAsText('manifest.json'));
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.encoding, encoding);
      assert.equal(manifest.compression, compression);
      assert.equal(manifest.redaction, false);
      assert.equal(manifest.timeline.sha256, digest(source));
      assert.equal(manifest.timeline.bytes, source.length);
      assert.equal(report.status, 'ok');
      assert.equal(report.eventCount, capture.metadata.eventCount);
      assert.deepEqual(await fs.readFile(path.join(output, 'timeline.jsonl')), source);
      assert.deepEqual(await fs.readFile(path.join(output, 'session.json')), archive.readFile('session.json'));
      const restored = (await fs.readFile(path.join(output, 'timeline.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(restored[0].payload.forms[0].value, snapshots[0].payload.forms[0].value);
      for (const original of [snapshots[0], snapshots.at(-1)]) {
        const stem = String(original.seq).padStart(8, '0');
        assert.equal(await fs.readFile(path.join(output, 'snapshots', `${stem}.html`), 'utf8'), original.payload.html);
        const state = JSON.parse(await fs.readFile(path.join(output, 'snapshots', `${stem}.state.json`), 'utf8'));
        assert.equal(state.eventId, original.id);
        for (const key of ['forms', 'tree', 'frames', 'shadowRoots', 'coverage', 'empty', 'nil', 'bool']) assert.deepEqual(state[key], original.payload[key], key);
      }
      assert.ok((await fs.readFile(path.join(output, 'timeline.md'), 'utf8')).includes(String(snapshots.at(-1).seq)));
      assert.match(archive.readAsText('AGENT_README.md'), /restore\.py/);
      if (encoding === 'delta') {
        assert.equal(archive.getEntry('timeline.jsonl'), null, 'delta delivery does not hide a full duplicate timeline');
        const index = archive.readAsText('index.jsonl').trim().split('\n').map(JSON.parse);
        assert.ok(index.some(entry => entry.mode === 'delta'), 'repeated large snapshots exercise actual COPY/ADD blocks');
        assert.ok(index[0].checkpoint && index[0].mode === 'raw');
      } else {
        assert.deepEqual(archive.readFile('timeline.jsonl'), source);
        assert.ok(archive.getEntry('snapshots/00000001.html'));
      }
      if (compression === 'store') assert.ok(archive.getEntries().every(entry => entry.header.method === 0));
      else assert.ok(archive.getEntries().some(entry => entry.header.method === 8));
    });
  }
}

test('default delta export freezes its byte boundary while later recording continues', { timeout: 120000 }, async t => {
  const { directory, store } = await setup(t);
  const session = await store.create('一致截点');
  await store.append(session.id, { type: 'action.input', payload: { value: '截点之前' } });
  const capture = await store.capture(session.id);
  const source = await fs.readFile(capture.timelinePath);
  await store.append(session.id, { type: 'action.input', payload: { value: '截点之后，必须留在本地' } });
  const filename = path.join(directory, 'boundary.zip');
  await exportSession({ store, sessionId: session.id, capture, destination: filename });
  const { archive, output } = await restoreBundled(directory, filename, 'boundary-restored', ['--timeline-only']);
  const manifest = JSON.parse(archive.readAsText('manifest.json'));
  assert.equal(manifest.encoding, 'delta');
  assert.equal(manifest.compression, 'deflate');
  assert.equal(manifest.eventCount, 1);
  assert.deepEqual(await fs.readFile(path.join(output, 'timeline.jsonl')), source);
  assert.equal(store.getSession(session.id).eventCount, 2);
  assert.ok((await fs.stat(capture.timelinePath)).size > capture.byteLength);
});

test('canceled and inconsistent exports preserve the destination and remove staging files', { timeout: 120000 }, async t => {
  const { directory, store } = await setup(t);
  const { session } = await fixture(store);
  const destination = path.join(directory, 'existing.zip');
  const original = Buffer.from('existing archive must survive');
  await fs.writeFile(destination, original);
  const capture = await store.capture(session.id);
  const controller = new AbortController();
  let canceledDuringWork = false;
  await assert.rejects(exportSession({
    store, sessionId: session.id, capture, destination, signal: controller.signal,
    onProgress(progress) {
      if (!canceledDuringWork && (progress.bytesRead > 0 || progress.completed > 0)) {
        canceledDuringWork = true;
        controller.abort();
      }
    },
  }), /取消|abort|cancel/i);
  assert.ok(canceledDuringWork, 'cancel was requested after actual export work started');
  assert.deepEqual(await fs.readFile(destination), original);
  const corruptCapture = { ...capture, metadata: { ...capture.metadata, eventCount: capture.metadata.eventCount + 1 } };
  await assert.rejects(exportSession({ store, sessionId: session.id, capture: corruptCapture, destination }), /数量|count|事件/i);
  assert.deepEqual(await fs.readFile(destination), original);
  assert.equal((await fs.readdir(directory)).filter(name => name.startsWith('.tracedock-export-') || name.endsWith('.tmp')).length, 0);
});
