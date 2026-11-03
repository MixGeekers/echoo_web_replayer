'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const { SessionStore } = require('../out/session-store.cjs');
const { exportSession } = require('../out/exporter.cjs');

async function setup(t) {
  // Keep test artifacts in the workspace; the Windows app sandbox can prohibit
  // atomic rename in its virtualized AC\Temp directory.
  const testRoot = path.join(__dirname, '..', 'output', 'test-temp');
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'tracedock-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new SessionStore(path.join(directory, 'sessions')).init();
  return { directory, store };
}

test('concurrent writes preserve sequence, raw values, filtered pagination and metadata', async t => {
  const { store } = await setup(t);
  const session = await store.create('完整记录', 'https://example.test', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' }, 'group-00000000-0000-4000-8000-000000000001');
  const records = await Promise.all([
    store.append(session.id, { type: 'action.input', payload: { value: '秘密密码', target: { selector: '#password' } } }),
    store.append(session.id, { type: 'dom.mutation', payload: { records: [{ type: 'attributes', oldValue: 'old', value: 'new' }] } }),
    store.append(session.id, { type: 'action.click', payload: { target: { selector: '#submit' } } }),
  ]);
  assert.deepEqual(records.map(record => record.seq), [1, 2, 3]);
  assert.equal(new Set(records.map(record => record.id)).size, 3);
  assert.equal(store.getSession(session.id).eventCount, 3);
  assert.equal(store.getSession(session.id).actionCount, 2);
  assert.equal(store.getSession(session.id).mutationCount, 1);
  const page = await store.timeline({ sessionId: session.id, types: ['action'], offset: 1, limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.events[0].seq, 1);
  assert.equal(page.events[0].payload.value, '秘密密码');
  assert.equal((await store.timeline({ sessionId: session.id, query: '秘密密码' })).total, 1);
  assert.equal((await store.getEvent(session.id, records[1].id)).payload.records[0].oldValue, 'old');
  await assert.rejects(store.getEvent(session.id, 'missing'), /找不到/);
  await assert.rejects(store.append('../escape', { type: 'action.click' }), /无效/);
  assert.throws(() => store.getSession('unknown'), /找不到/);
});

test('restart recovers durable counters and marks incomplete recordings interrupted', async t => {
  const { store } = await setup(t);
  const session = await store.create('恢复测试', '', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' }, 'group-00000000-0000-4000-8000-000000000001');
  await store.append(session.id, { type: 'action.click', payload: { target: { selector: '#ok' } } });
  const metadataPath = path.join(store.getSessionDirectory(session.id), 'session.json');
  const staleMetadata = store.getSession(session.id);
  staleMetadata.eventCount = 0;
  staleMetadata.lastSeq = 0;
  await fs.writeFile(metadataPath, JSON.stringify(staleMetadata));
  const restored = await new SessionStore(store.rootDir).init();
  const recovered = restored.getSession(session.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.eventCount, 2);
  assert.equal(recovered.actionCount, 1);
  assert.equal((await restored.timeline({ sessionId: session.id })).events[0].type, 'session.interrupted');
  const restartedAgain = await new SessionStore(store.rootDir).init();
  assert.equal(restartedAgain.getSession(session.id).eventCount, 2);
});

test('truncated tail is recovered with original bytes retained', async t => {
  const { store } = await setup(t);
  const session = await store.create('崩溃恢复', '', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' }, 'group-00000000-0000-4000-8000-000000000001');
  await store.append(session.id, { type: 'action.click', payload: {} });
  await fs.appendFile(path.join(store.getSessionDirectory(session.id), 'timeline.jsonl'), '{"seq":2,"type":');
  const recovered = await new SessionStore(store.rootDir).init();
  const metadata = recovered.getSession(session.id);
  assert.equal(metadata.eventCount, 2);
  assert.ok(metadata.recoveryFile);
  assert.match(await fs.readFile(path.join(store.getSessionDirectory(session.id), metadata.recoveryFile), 'utf8'), /\{"seq":2,"type":$/);
});

test('ZIP includes full timeline, raw snapshot state, guide and verifiable hashes at a fixed boundary', async t => {
  const { directory, store } = await setup(t);
  const session = await store.create('ZIP 检查', 'https://example.test', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' }, 'group-00000000-0000-4000-8000-000000000001');
  const html = '<html><body><input id="secret" type="password"><div>完整 DOM 内容</div></body></html>';
  const snapshot = await store.append(session.id, { type: 'dom.snapshot', documentId: 'doc-1', payload: { reason: 'start', html, tree: { id: 'n1' }, forms: [{ value: 'raw-password-123' }], frames: [], shadowRoots: [], coverage: { mainDocument: true } } });
  await store.append(session.id, { type: 'action.input', payload: { value: '原始值' } });
  const originalCapture = store.capture.bind(store);
  store.capture = async id => {
    const boundary = await originalCapture(id);
    await store.append(id, { type: 'action.click', payload: { target: { selector: '#after-export-boundary' } } });
    return boundary;
  };
  const destination = path.join(directory, '会话.zip');
  const result = await exportSession({ store, sessionId: session.id, destination, appVersion: 'test-version', encoding: 'full' });
  assert.equal(result.eventCount, 2);
  const archive = new AdmZip(destination);
  const manifest = JSON.parse(archive.readAsText('manifest.json'));
  assert.equal(manifest.redaction, false);
  assert.equal(manifest.eventCount, 2);
  assert.equal(manifest.lastSeq, 2);
  assert.equal(manifest.appVersion, 'test-version');
  const records = archive.readAsText('timeline.jsonl').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].payload.html, html);
  assert.equal(records[0].payload.forms[0].value, 'raw-password-123');
  assert.equal(archive.readAsText('snapshots/00000001.html'), html);
  const state = JSON.parse(archive.readAsText('snapshots/00000001.state.json'));
  assert.equal(state.eventId, snapshot.id);
  assert.equal(state.forms[0].value, 'raw-password-123');
  assert.match(archive.readAsText('AGENT_README.md'), /V1 不做数据脱敏/);
  for (const file of manifest.files) {
    const bytes = archive.readFile(file.path);
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  for (const file of archive.readAsText('files.jsonl').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) {
    const bytes = archive.readFile(file.path);
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  assert.equal((await fs.readdir(directory)).filter(name => name.startsWith('.tracedock-export-') || name.endsWith('.tmp')).length, 0);
});

test('failed export preserves an existing destination and cleans temporary data', async t => {
  const { directory, store } = await setup(t);
  const session = await store.create('失败测试', '', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' }, 'group-00000000-0000-4000-8000-000000000001');
  await store.append(session.id, { type: 'action.click', payload: {} });
  const destination = path.join(directory, 'existing.zip');
  await fs.writeFile(destination, 'original file');
  const originalCapture = store.capture.bind(store);
  store.capture = async id => {
    const boundary = await originalCapture(id);
    boundary.metadata.eventCount = 99;
    return boundary;
  };
  await assert.rejects(exportSession({ store, sessionId: session.id, destination }), /数量/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'original file');
  assert.equal((await fs.readdir(directory)).filter(name => name.startsWith('.tracedock-export-')).length, 0);
});

test('queued appends are written as one batch, stay ordered and flush metadata', async t => {
  const { store } = await setup(t);
  const session = await store.create('合并写入', 'https://example.test', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' }, 'group-00000000-0000-4000-8000-000000000001');
  const directory = store.getSessionDirectory(session.id);
  const original = fs.appendFile;
  const writes = [];
  fs.appendFile = async (file, ...rest) => { writes.push(path.basename(file)); return original(file, ...rest); };
  t.after(() => { fs.appendFile = original; });
  // 先占住队列，后续追加会合并成同一批。
  const blocker = store.update(session.id, { name: '合并写入' });
  const appends = Array.from({ length: 50 }, (_, index) => store.append(session.id, {
    type: index % 2 ? 'dom.mutation' : 'action.click',
    url: index === 49 ? 'https://example.test/last' : undefined,
    payload: { index },
  }));
  const invalid = assert.rejects(store.append(session.id, { type: '' }), /事件类型不能为空/);
  appends.push(store.append(session.id, { type: 'action.input', payload: { index: 50 } }));
  await blocker;
  const events = await Promise.all(appends);
  await invalid;
  fs.appendFile = original;
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: 51 }, (_, index) => index + 1));
  assert.deepEqual(events.map(event => event.payload.index), Array.from({ length: 51 }, (_, index) => index));
  assert.equal(events[50].url, 'https://example.test/last');
  assert.deepEqual(writes.sort(), ['timeline.idx', 'timeline.jsonl', 'timeline.summaries.jsonl']);
  const page = await store.timeline({ sessionId: session.id, limit: 100 });
  assert.equal(page.total, 51);
  assert.deepEqual(page.events.map(event => event.seq).sort((a, b) => a - b), events.map(event => event.seq));
  assert.equal(store.getSession(session.id).actionCount, 26);
  assert.equal(store.getSession(session.id).mutationCount, 25);
  await store.flush();
  const onDisk = JSON.parse(await fs.readFile(path.join(directory, 'session.json'), 'utf8'));
  assert.equal(onDisk.eventCount, 51);
  assert.equal(onDisk.lastSeq, 51);
  assert.equal(onDisk.url, 'https://example.test/last');
  const restarted = await new SessionStore(store.rootDir).init();
  assert.equal(restarted.getSession(session.id).eventCount, 52);
  const replayed = await restarted.timeline({ sessionId: session.id, limit: 100 });
  const restoredIndexes = replayed.events.filter(event => event.seq <= 51).sort((a, b) => a.seq - b.seq).map(event => event.type);
  assert.deepEqual(restoredIndexes, events.map(event => event.type));
  assert.equal((await restarted.getEvent(session.id, events[49].id)).payload.index, 49);
});
