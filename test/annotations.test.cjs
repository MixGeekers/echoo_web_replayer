'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const { SessionStore } = require('../out/session-store.cjs');
const { AnnotationStore, parseAnnotationSet, readAnnotationFile } = require('../out/annotation-store.cjs');
const { createAnnotationService } = require('../out/annotations.cjs');
const { exportSession } = require('../out/exporter.cjs');

const exec = promisify(execFile);
const python = process.env.TRACEDOCK_PYTHON || 'python';
const script = path.resolve(__dirname, '../out/restore.py');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const PROFILE = { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' };
const GROUP = 'group-00000000-0000-4000-8000-000000000001';

async function setup(t) {
  const root = path.resolve(__dirname, '../output/test-temp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'annotations-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** seq 1 snapshot, 2-3 actions, 4 snapshot, 5-7 actions/mutation, 8 snapshot, 9 click. */
async function recording(directory, { resources = false } = {}) {
  const store = await new SessionStore(path.join(directory, 'sessions')).init();
  const session = await store.create('标注测试', 'https://site.test/', PROFILE, GROUP);
  const snapshot = (n) => ({ type: 'dom.snapshot', documentId: 'doc', payload: { html: `<html><body>快照 ${n}</body></html>`, reason: 'checkpoint', tree: { id: 'n1' } } });
  const click = (n) => ({ type: 'action.click', payload: { target: { selector: `#b${n}` } } });
  const events = [snapshot(1), click(2), { type: 'dom.mutation', payload: { records: [{ type: 'attributes' }] } }, snapshot(4), click(5), { type: 'action.input', payload: { value: '中文😀' } }, click(7), snapshot(8), click(9)];
  for (const [index, event] of events.entries()) {
    await store.append(session.id, event);
    if (resources && (index === 1 || index === 7)) {
      const body = Buffer.from(`body { color: red; } /* ${index} */`);
      const source = path.join(directory, `res-${index}.css`);
      await fs.writeFile(source, body);
      await store.saveResource(session.id, { url: `https://site.test/${index}.css`, mimeType: 'text/css', sha256: sha(body), bytes: body.length, status: 'saved' }, source);
    }
  }
  await store.update(session.id, { status: 'stopped' });
  return { store, id: session.id };
}

function host(store, current = null) {
  return {
    store,
    readable(id) { const r = store.getSession(id); if (r.libraryState === 'trashed') throw new Error('请先从回收站恢复会话'); return r; },
    readRecording: (id, read) => store.withReadLease(id, read),
    state: () => ({ session: current ? store.getSession(current) : null }),
  };
}

function entriesOf(zip) {
  const archive = new AdmZip(zip);
  return new Map(archive.getEntries().filter(e => !e.isDirectory).map(e => [e.entryName, archive.readFile(e)]));
}
async function restore(source, output, extra = []) {
  return exec(python, [script, source, '--output', output, ...extra], { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}
async function writePackage(directory, filename, entries) {
  const archive = new AdmZip();
  for (const [name, bytes] of entries) archive.addFile(name, bytes);
  const file = path.join(directory, filename);
  await fs.writeFile(file, archive.toBuffer());
  return file;
}
function rehash(entries) {
  const manifest = JSON.parse(entries.get('manifest.json'));
  const descriptor = name => ({ path: name, bytes: entries.get(name).length, sha256: sha(entries.get(name)) });
  entries.set('files.jsonl', Buffer.concat([...entries.keys()].filter(name => !['manifest.json', 'files.jsonl'].includes(name)).map(name => json(descriptor(name)))));
  manifest.files = manifest.files.map(item => descriptor(item.path));
  entries.set('manifest.json', json(manifest));
}

test('annotation store creates, edits and deletes notes atomically with revisions', async t => {
  const directory = await setup(t);
  const { store, id } = await recording(directory);
  const annotations = new AnnotationStore(store);
  assert.deepEqual((await annotations.read(id)).annotations, []);
  const timelineBefore = await fs.readFile(path.join(store.getSessionDirectory(id), 'timeline.jsonl'));

  const first = await annotations.create(id, { seq: 5, elapsedMs: 12, timestamp: '2026-01-01T00:00:00.000Z', eventType: 'action.click', text: '  这里有问题  ', author: 'user' });
  assert.equal(first.revision, 1);
  assert.equal(first.annotation.text, '这里有问题');
  assert.equal(first.annotation.endSeq, null);
  const second = await annotations.create(id, { seq: 2, endSeq: 3, elapsedMs: 5, timestamp: '', eventType: 'action.click', text: '范围', author: 'agent' }, 1);
  assert.deepEqual(second.annotations.map(a => a.seq), [2, 5], 'annotations are sorted by seq');
  await assert.rejects(annotations.create(id, { seq: 7, elapsedMs: 0, timestamp: '', eventType: 'x', text: '旧版本', author: 'user' }, 1), { code: 'REVISION_CONFLICT' });
  await assert.rejects(annotations.create(id, { seq: 99, elapsedMs: 0, timestamp: '', eventType: 'x', text: '越界', author: 'user' }), /超出/);
  await assert.rejects(annotations.create(id, { seq: 5, endSeq: 4, elapsedMs: 0, timestamp: '', eventType: 'x', text: '倒序', author: 'user' }), /结束/);
  await assert.rejects(annotations.create(id, { seq: 5, elapsedMs: 0, timestamp: '', eventType: 'x', text: '   ', author: 'user' }), /不能为空/);

  const edited = await annotations.update(id, first.annotation.id, { text: '提交按钮无响应', endSeq: 7 }, 2);
  assert.equal(edited.revision, 3);
  assert.equal(edited.annotation.text, '提交按钮无响应');
  assert.equal(edited.annotation.endSeq, 7);
  assert.equal(edited.annotation.createdAt, first.annotation.createdAt);
  const removed = await annotations.remove(id, second.annotation.id);
  assert.equal(removed.revision, 4);
  assert.deepEqual(removed.annotations.map(a => a.id), [first.annotation.id]);
  await assert.rejects(annotations.remove(id, second.annotation.id), { code: 'NOT_FOUND' });

  const saved = await readAnnotationFile(store.getSessionDirectory(id), id);
  assert.equal(saved.revision, 4);
  assert.deepEqual(parseAnnotationSet(JSON.parse(await fs.readFile(path.join(store.getSessionDirectory(id), 'annotations.json'), 'utf8'))), saved);
  assert.deepEqual((await fs.readdir(store.getSessionDirectory(id))).filter(name => name.endsWith('.tmp')), []);
  assert.deepEqual(await fs.readFile(path.join(store.getSessionDirectory(id), 'timeline.jsonl')), timelineBefore, 'timeline facts are never modified');
  assert.equal(store.getSession(id).eventCount, 9);
});

test('trashed recordings cannot be annotated and permanent deletion removes annotations', async t => {
  const directory = await setup(t);
  const { store, id } = await recording(directory);
  const annotations = new AnnotationStore(store);
  const created = await annotations.create(id, { seq: 2, elapsedMs: 0, timestamp: '', eventType: 'action.click', text: '删除前', author: 'user' });
  await store.trash(id);
  await assert.rejects(annotations.create(id, { seq: 3, elapsedMs: 0, timestamp: '', eventType: 'x', text: '回收站', author: 'user' }), /回收站/);
  await assert.rejects(annotations.update(id, created.annotation.id, { text: '改' }), /回收站/);
  await assert.rejects(annotations.remove(id, created.annotation.id), /回收站/);
  await store.restore(id);
  await annotations.update(id, created.annotation.id, { text: '恢复后可编辑' });
  await store.trash(id);
  const file = path.join(store.getSessionDirectory(id), 'annotations.json');
  await fs.access(file);
  await store.deletePermanently(id);
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  await assert.rejects(annotations.read(id), /找不到/);
  // A restarted store does not resurrect anything.
  const reopened = await new SessionStore(path.join(directory, 'sessions')).init();
  assert.equal(reopened.list().length, 0);
});

test('corrupt annotation files fail loudly instead of being replaced', async t => {
  const directory = await setup(t);
  const { store, id } = await recording(directory);
  const file = path.join(store.getSessionDirectory(id), 'annotations.json');
  await fs.writeFile(file, '{"format":"tracedock-annotations"');
  const annotations = new AnnotationStore(store);
  await assert.rejects(annotations.read(id), /损坏/);
  await assert.rejects(annotations.create(id, { seq: 2, elapsedMs: 0, timestamp: '', eventType: 'x', text: 'x', author: 'user' }), /损坏/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"format":"tracedock-annotations"');
});

test('annotation service anchors notes on stored events and quick-marks the latest seq', async t => {
  const directory = await setup(t);
  const store = await new SessionStore(path.join(directory, 'sessions')).init();
  const session = await store.create('进行中', '', PROFILE, GROUP);
  const service = createAnnotationService(host(store, session.id));
  await assert.rejects(service.mark(), /尚未保存事件/);
  await store.append(session.id, { type: 'dom.snapshot', payload: { html: '<html></html>' } });
  await store.append(session.id, { type: 'action.click', payload: { target: { selector: '#go' } } });
  const marked = await service.mark();
  assert.equal(marked.annotation.seq, 2);
  assert.equal(marked.annotation.text, '这里有问题');
  assert.equal(marked.annotation.author, 'user');
  assert.equal(marked.annotation.eventType, 'action.click');
  assert.equal(typeof marked.annotation.elapsedMs, 'number');
  const note = await service.create({ sessionId: session.id, seq: 1, text: 'Agent 认为页面空白', author: 'agent' });
  assert.equal(note.annotation.eventType, 'dom.snapshot');
  await assert.rejects(service.create({ sessionId: session.id, seq: 3, author: 'user' }), /找不到事件|超出/);
  assert.equal((await service.list(session.id)).annotations.length, 2);
  await store.update(session.id, { status: 'stopped' });
  await assert.rejects(createAnnotationService(host(store, null)).mark(), /没有进行中的采集/);
});

for (const encoding of ['delta', 'full']) {
  test(`${encoding} export includes annotations, checksums them and restore.py verifies them`, async t => {
    const directory = await setup(t);
    const { store, id } = await recording(directory);
    const annotations = new AnnotationStore(store);
    await annotations.create(id, { seq: 5, elapsedMs: 1234, timestamp: '2026-01-01T00:00:01.234Z', eventType: 'action.click', text: '这里 | 有问题', author: 'user' });
    await annotations.create(id, { seq: 7, elapsedMs: 2000, timestamp: '', eventType: 'action.click', text: 'Agent 笔记', author: 'agent' });
    const zip = path.join(directory, `${encoding}.zip`);
    const result = await exportSession({ store, sessionId: id, destination: zip, encoding });
    assert.equal(result.annotationCount, 2);
    const entries = entriesOf(zip);
    const manifest = JSON.parse(entries.get('manifest.json'));
    assert.deepEqual(manifest.annotations, { path: 'annotations.json', count: 2 });
    const exported = JSON.parse(entries.get('annotations.json'));
    assert.deepEqual(exported.annotations.map(a => [a.seq, a.author]), [[5, 'user'], [7, 'agent']]);
    const listed = entries.get('files.jsonl').toString().trim().split('\n').map(JSON.parse).find(item => item.path === 'annotations.json');
    assert.deepEqual(listed, { path: 'annotations.json', bytes: entries.get('annotations.json').length, sha256: sha(entries.get('annotations.json')) });
    assert.ok(manifest.files.some(item => item.path === 'annotations.json'));
    const readme = entries.get('AGENT_README.md').toString();
    assert.ok(readme.indexOf('人工标注') > 0 && readme.indexOf('人工标注') < readme.indexOf('先恢复并验证'));
    assert.match(readme, /\| 5 \|  \| 1\.234s \| 2026-01-01T00:00:01\.234Z \| action\.click \| 人工 \| 这里 \\\| 有问题 \|/);
    if (encoding === 'full') assert.match(entries.get('timeline.md').toString(), /## 人工标注[\s\S]*\| 7 \|[\s\S]*## 事件\n\n\| 序号/);
    // Facts stay byte-identical.
    const original = await fs.readFile(path.join(store.getSessionDirectory(id), 'timeline.jsonl'));
    assert.equal(manifest.timeline.sha256, sha(original));

    const output = path.join(directory, `${encoding}-restored`);
    const { stdout } = await restore(zip, output);
    const report = JSON.parse(stdout);
    assert.equal(report.annotations, 2);
    assert.deepEqual(await fs.readFile(path.join(output, 'annotations.json')), entries.get('annotations.json'));
    assert.deepEqual(await fs.readFile(path.join(output, 'timeline.jsonl')), original);
    const markdown = await fs.readFile(path.join(output, 'timeline.md'), 'utf8');
    assert.match(markdown, /## 人工标注[\s\S]*Agent 笔记[\s\S]*\| 序号/);
    const restoredList = (await fs.readFile(path.join(output, 'restored-files.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(restoredList.some(item => item.path === 'annotations.json'));
    const timelineOnly = path.join(directory, `${encoding}-timeline-only`);
    await restore(zip, timelineOnly, ['--timeline-only']);
    await fs.access(path.join(timelineOnly, 'annotations.json'));

    // Annotation pointing outside the exported timeline is rejected even with valid checksums.
    const tampered = new Map(entries);
    const bad = JSON.parse(entries.get('annotations.json'));
    bad.annotations[0].seq = 999;
    tampered.set('annotations.json', json(bad));
    rehash(tampered);
    const badZip = await writePackage(directory, `${encoding}-bad.zip`, tampered);
    await assert.rejects(restore(badZip, path.join(directory, `${encoding}-bad`)), /Annotation seq outside/);
    await assert.rejects(fs.access(path.join(directory, `${encoding}-bad`)), { code: 'ENOENT' });
    // Declared but missing annotations fail.
    const missing = new Map(entries);
    missing.delete('annotations.json');
    const missingManifest = JSON.parse(missing.get('manifest.json'));
    missingManifest.files = missingManifest.files.filter(item => item.path !== 'annotations.json');
    missing.set('manifest.json', json(missingManifest));
    rehash(missing);
    await assert.rejects(restore(await writePackage(directory, `${encoding}-missing.zip`, missing), path.join(directory, `${encoding}-missing`)), /Declared annotations.json is missing/);
  });
}

test('recordings without annotations keep the previous package layout', async t => {
  const directory = await setup(t);
  const { store, id } = await recording(directory);
  const zip = path.join(directory, 'plain.zip');
  const result = await exportSession({ store, sessionId: id, destination: zip });
  assert.equal(result.annotationCount, 0);
  const entries = entriesOf(zip);
  assert.equal(entries.has('annotations.json'), false);
  assert.equal(JSON.parse(entries.get('manifest.json')).annotations, undefined);
  assert.doesNotMatch(entries.get('AGENT_README.md').toString(), /人工标注/);
});

for (const encoding of ['delta', 'full']) {
  test(`${encoding} range export starts at the nearest snapshot and stays byte-identical`, async t => {
    const directory = await setup(t);
    const { store, id } = await recording(directory, { resources: true });
    const annotations = new AnnotationStore(store);
    await annotations.create(id, { seq: 2, elapsedMs: 0, timestamp: '', eventType: 'action.click', text: '片段之前', author: 'user' });
    await annotations.create(id, { seq: 6, endSeq: 11, elapsedMs: 0, timestamp: '', eventType: 'action.input', text: '片段内', author: 'user' });
    const original = await fs.readFile(path.join(store.getSessionDirectory(id), 'timeline.jsonl'));
    const lines = original.toString('utf8').split('\n').filter(Boolean);
    const events = lines.map(JSON.parse);
    const seqOf = type => events.filter(e => e.type === type).map(e => e.seq);
    const snapshots = seqOf('dom.snapshot');
    const resourceSeqs = seqOf('page.resource');
    assert.equal(resourceSeqs.length, 2);
    // Request starts just after the 2nd snapshot and ends before the 3rd one.
    const startSeq = snapshots[1] + 2, endSeq = snapshots[2] - 1;
    const zip = path.join(directory, `range-${encoding}.zip`);
    const result = await exportSession({ store, sessionId: id, destination: zip, encoding, range: { startSeq, endSeq } });
    assert.equal(result.range.requestedStartSeq, startSeq);
    assert.equal(result.range.startSeq, snapshots[1]);
    assert.equal(result.range.baselineSnapshotSeq, snapshots[1]);
    assert.equal(result.range.endSeq, endSeq);
    const expectedLines = events.map((e, i) => [e, lines[i]]).filter(([e]) => e.seq >= snapshots[1] && e.seq <= endSeq).map(([, line]) => line);
    const expected = Buffer.from(expectedLines.join('\n') + '\n');
    assert.equal(result.eventCount, expectedLines.length);
    assert.equal(original.indexOf(expected), result.range.startByte, 'slice is an exact byte range of the original');
    const entries = entriesOf(zip);
    const manifest = JSON.parse(entries.get('manifest.json'));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.lastSeq, endSeq);
    assert.equal(manifest.eventCount, expectedLines.length);
    assert.equal(manifest.timelineBytes, expected.length);
    assert.equal(manifest.timeline.sha256, sha(expected));
    assert.equal(manifest.range.sourceLastSeq, store.getSession(id).lastSeq);
    assert.equal(JSON.parse(entries.get('session.json')).lastSeq, store.getSession(id).lastSeq, 'session.json remains the recording metadata');
    const exportedNotes = JSON.parse(entries.get('annotations.json')).annotations;
    assert.deepEqual(exportedNotes.map(a => [a.text, a.endSeq]), [['片段内', endSeq]], 'notes outside the slice are dropped and ranges clipped');
    const resources = entries.get('resources.jsonl').toString().trim().split('\n').map(JSON.parse);
    assert.deepEqual(resources.map(r => r.seq), [resourceSeqs[0]], 'resources captured after the range end are excluded');
    assert.equal([...entries.keys()].filter(name => name.startsWith('assets/')).length, 1);
    assert.match(entries.get('AGENT_README.md').toString(), /片段导出/);
    if (encoding === 'full') assert.deepEqual(entries.get('timeline.jsonl'), expected);

    const output = path.join(directory, `range-${encoding}-restored`);
    const { stdout } = await restore(zip, output);
    const report = JSON.parse(stdout);
    assert.equal(report.range.startSeq, snapshots[1]);
    assert.equal(report.counts.snapshots, 1);
    assert.deepEqual(await fs.readFile(path.join(output, 'timeline.jsonl')), expected);
    assert.match(await fs.readFile(path.join(output, 'timeline.md'), 'utf8'), /## 片段范围/);
    await fs.access(path.join(output, `snapshots/${String(snapshots[1]).padStart(8, '0')}.html`));

    // A manifest range that disagrees with the restored facts is rejected.
    const tampered = new Map(entries);
    const changed = JSON.parse(entries.get('manifest.json'));
    changed.range.startSeq += 1;
    tampered.set('manifest.json', json(changed));
    await assert.rejects(restore(await writePackage(directory, `range-${encoding}-bad.zip`, tampered), path.join(directory, `range-${encoding}-bad`)), /range mismatch/);
  });
}

test('range bounds resolve by time, fall back to the first event, and reject empty slices', async t => {
  const directory = await setup(t);
  const store = await new SessionStore(path.join(directory, 'sessions')).init();
  const session = await store.create('无快照', '', PROFILE, GROUP);
  for (let n = 1; n <= 4; n++) await store.append(session.id, { type: 'action.click', payload: { n } });
  await store.update(session.id, { status: 'stopped' });
  const noBaseline = await exportSession({ store, sessionId: session.id, destination: path.join(directory, 'a.zip'), range: { startSeq: 3, endSeq: 3 } });
  assert.equal(noBaseline.range.startSeq, 1);
  assert.equal(noBaseline.range.baselineSnapshotSeq, null);
  assert.equal(noBaseline.eventCount, 3);
  const byTime = await exportSession({ store, sessionId: session.id, destination: path.join(directory, 'b.zip'), encoding: 'full', range: { startMs: 0, endMs: 10 ** 9 } });
  assert.equal(byTime.eventCount, 4);
  assert.equal(byTime.range.endSeq, 4);
  await assert.rejects(exportSession({ store, sessionId: session.id, destination: path.join(directory, 'c.zip'), range: { startSeq: 50 } }), /没有已保存的事件/);
  await assert.rejects(fs.access(path.join(directory, 'c.zip')), { code: 'ENOENT' });
});

test('MCP agents read annotations and add agent notes with scope, receipts and revisions', async t => {
  const { createMCPTools } = require('../out/mcp-tools.cjs');
  const directory = await setup(t);
  const { store, id } = await recording(directory);
  await new AnnotationStore(store).create(id, { seq: 5, elapsedMs: 0, timestamp: '', eventType: 'action.click', text: '这里有问题', author: 'user' });
  let permissions = new Set(['read']), allowed = [PROFILE.id];
  const denied = () => { throw Object.assign(new Error('forbidden'), { code: 'PROFILE_FORBIDDEN', outcome: 'not_executed' }); };
  const ws = { ...host(store), notify() {}, jobs: { progress: () => null } };
  const access = { authorize(_c, cap, p) { if (!permissions.has(cap)) denied(); if (p && !allowed.includes(p)) denied(); }, profileIds: () => allowed, principal: () => 'agent-a', registerGuard() {}, run: async (_c, f) => f() };
  const tools = await createMCPTools({ workspace: ws, access, browser: { call: async () => ({}) }, dataRoot: path.join(directory, 'mcp') });
  t.after(() => tools.operations.close());
  const call = async (name, args) => (await tools.call('c', `tracedock_${name}`, args)).structuredContent;

  const listed = await call('annotations', { recordingId: id });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.revision, 1);
  assert.deepEqual(listed.data.annotations.map(a => [a.seq, a.author, a.text]), [[5, 'user', '这里有问题']]);
  const args = { recordingId: id, seq: 6, endSeq: 7, text: '输入后未触发校验', expectedAnnotationsRevision: 1, commandId: 'note-1' };
  assert.equal((await call('annotation_add', args)).error.code, 'PROFILE_FORBIDDEN', 'writing notes needs the organize grant');
  permissions = new Set(['read', 'organize']);
  const added = await call('annotation_add', args);
  assert.equal(added.ok, true);
  assert.equal(added.data.annotation.author, 'agent');
  assert.equal(added.data.revision, 2);
  const retried = await call('annotation_add', args);
  assert.deepEqual(retried.data, added.data, 'same commandId returns the retained receipt');
  assert.equal((await call('annotation_add', { ...args, commandId: 'note-2' })).error.code, 'REVISION_CONFLICT');
  const { expectedAnnotationsRevision: _, ...unversioned } = args;
  assert.equal((await call('annotation_add', { ...unversioned, seq: 999, endSeq: 999, commandId: 'note-3' })).ok, false);
  assert.equal((await call('annotation_add', { ...args, author: 'user', commandId: 'note-4' })).error.code, 'INVALID_ARGUMENT', 'authors cannot be forged');
  assert.equal((await call('annotations', { recordingId: id })).data.annotations.length, 2);
  allowed = [];
  assert.equal((await call('annotations', { recordingId: id })).error.code, 'PROFILE_FORBIDDEN');
});
