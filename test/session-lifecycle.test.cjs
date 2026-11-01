'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionStore } = require('../out/session-store.cjs');
const profile = { id: 'profile-00000000-0000-4000-8000-000000000001', name: '账号 A' };

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracedock-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new SessionStore(path.join(root, 'recordings')).init();
  const session = await store.create('一段录制', 'https://example.test/', profile, 'group-00000000-0000-4000-8000-000000000001');
  await store.append(session.id, { type: 'action.input', payload: { value: '原始内容' } });
  return { root, store, id: session.id };
}
async function stop(store, id) {
  await store.update(id, { status: 'stopped', endedAt: new Date().toISOString() });
}

test('archive, trash and restoration survive restart without changing recorded bytes or profile identity', async t => {
  let { store, id } = await setup(t);
  await stop(store, id);
  const timeline = path.join(store.getSessionDirectory(id), 'timeline.jsonl');
  const original = await fs.readFile(timeline);
  const archived = await store.archive(id);
  assert.equal(archived.libraryState, 'archived');
  assert.ok(archived.archivedAt);
  await store.rename(id, '重命名记录');
  const trashed = await store.trash(id);
  assert.equal(trashed.libraryState, 'trashed');
  assert.equal(trashed.trashOrigin, 'archived');
  assert.equal(trashed.archivedAt, archived.archivedAt);
  assert.ok(trashed.trashedAt);
  store = await new SessionStore(store.rootDir).init();
  const restored = await store.restore(id);
  assert.equal(restored.libraryState, 'archived');
  assert.equal(restored.name, '重命名记录');
  assert.equal(restored.profileId, profile.id);
  assert.equal(restored.profileName, profile.name);
  assert.equal(restored.trashedAt, null);
  assert.equal(restored.trashOrigin, null);
  await store.unarchive(id);
  assert.equal(store.getSession(id).archivedAt, null);
  await store.trash(id);
  assert.equal((await store.restore(id)).libraryState, 'active');
  assert.deepEqual(await fs.readFile(timeline), original);
});

test('active recordings and invalid lifecycle transitions are rejected without changing metadata', async t => {
  const { store, id } = await setup(t);
  for (const status of ['recording', 'paused']) {
    await store.update(id, { status });
    for (const action of [() => store.rename(id, '新名字'), () => store.archive(id), () => store.trash(id), () => store.deletePermanently(id)])
      await assert.rejects(action, /先结束/);
    assert.equal(store.getSession(id).libraryState, 'active');
  }
  await stop(store, id);
  await assert.rejects(store.deletePermanently(id), /回收站/);
  await assert.rejects(store.restore(id), /不在回收站/);
  await assert.rejects(store.unarchive(id), /未归档/);
  await assert.rejects(store.rename(id, ' '), /名称/);
  await store.trash(id);
  await assert.rejects(store.trash(id), /已在回收站/);
  await assert.rejects(store.archive(id), /只有常用/);
  await assert.rejects(store.rename(id, '重命名'), /先从回收站恢复/);
});

test('permanent deletion removes all local session data and search cache while preserving external exports', async t => {
  const { root, store, id } = await setup(t);
  await stop(store, id);
  const directory = store.getSessionDirectory(id);
  await fs.mkdir(path.join(directory, 'assets'));
  await fs.writeFile(path.join(directory, 'assets', 'test'), 'resource');
  const exported = path.join(root, 'exported.zip');
  await fs.writeFile(exported, 'independent export');
  await store.update(id, { lastExportPath: exported });
  await store.timeline({ sessionId: id, query: '原始内容' });
  assert.ok((await fs.readdir(directory)).some(name => name.startsWith('.search-')));
  await store.trash(id);
  await store.deletePermanently(id);
  assert.equal(store.list().length, 0);
  assert.equal(store.indexes.has(id), false);
  assert.throws(() => store.getSession(id), /找不到/);
  await assert.rejects(store.timeline({ sessionId: id }), /找不到/);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(exported, 'utf8'), 'independent export');
  assert.equal((await new SessionStore(store.rootDir).init()).list().length, 0);
});

test('an interrupted permanent deletion is cleaned on startup and cannot resurrect the record', async t => {
  const { store, id } = await setup(t);
  await stop(store, id);
  await store.trash(id);
  const staged = path.join(store.rootDir, `.deleting-${id}-abcd`);
  await fs.rename(store.getSessionDirectory(id), staged);
  await fs.rm(path.join(staged, 'timeline.jsonl'));
  const reopened = await new SessionStore(store.rootDir).init();
  assert.equal(reopened.list().length, 0);
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
});

test('permanent deletion cannot race an outstanding timeline read', async t => {
  const { store, id } = await setup(t);
  await stop(store, id);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const capture = store.capture.bind(store);
  store.capture = async sessionId => { entered(); await pending; return capture(sessionId); };
  const reading = store.timeline({ sessionId: id });
  await started;
  await store.trash(id);
  await assert.rejects(store.deletePermanently(id), /正在读取/);
  release();
  assert.equal((await reading).events.length, 1);
  await store.deletePermanently(id);
  assert.equal(store.list().length, 0);
});

test('new baseline requires profile ownership and complete metadata instead of migrating old records', async t => {
  const { store, id } = await setup(t);
  await assert.rejects(store.create('缺少环境', ''), /Profile/);
  await stop(store, id);
  const filename = path.join(store.getSessionDirectory(id), 'session.json');
  const original = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const change of [value => { value.schemaVersion = 2; }, value => { delete value.profileId; }, value => { delete value.sessionGroupId; }, value => { delete value.libraryState; }, value => { value.trashOrigin = 'archived'; }]) {
    const invalid = { ...original };
    change(invalid);
    const bytes = JSON.stringify(invalid);
    await fs.writeFile(filename, bytes);
    await assert.rejects(new SessionStore(store.rootDir).init(), /无法读取会话/);
    assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  }
});
