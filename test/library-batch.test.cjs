'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseLibraryBatch, planLibraryBatch } = require('../out/library-batch.cjs');
const { SessionStore } = require('../out/session-store.cjs');
const group = (id, libraryState = 'active') => ({ id, name: id, libraryState });
const record = (id, sessionGroupId, libraryState = 'active', status = 'stopped') => ({ id, name: id, sessionGroupId, libraryState, status });
const input = (action, sessionGroupIds = [], sessionIds = []) => ({ action, sessionGroupIds, sessionIds });
const fixture = () => ({
  sessionGroups: [group('a'), group('b'), group('empty')],
  sessions: [record('a1', 'a'), record('a2-hidden-trash', 'a', 'trashed'), record('b1', 'b')],
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function setupStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tracedock-batch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new SessionStore(directory).init();
  const profile = { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' };
  const groupId = 'group-00000000-0000-4000-8000-000000000001';
  const ids = [];
  for (const name of ['前项', '后项']) {
    const value = await store.create(name, 'https://example.test/', profile, groupId);
    await store.append(value.id, { type: 'action.click', payload: { label: name } });
    await store.update(value.id, { status: 'stopped', endedAt: new Date().toISOString() });
    ids.push(value.id);
  }
  return { store, ids };
}

test('batch parser rejects malformed operations and ID lists at the IPC boundary', () => {
  for (const bad of [null, [], {}, input('purge'), input(['archive']), input({ toString: () => 'archive' }), { action: 'archive', sessionGroupIds: 'a', sessionIds: [] }, input('trash', [], [null]), input('trash', [''])])
    assert.throws(() => parseLibraryBatch(bad), /无效|ID/);
  assert.deepEqual(parseLibraryBatch(input('trash', ['a', 'a'], ['b', 'b'])), input('trash', ['a'], ['b']));
});

test('batch plan deduplicates descendants while counting every hidden child and empty Session', () => {
  const state = fixture(), before = structuredClone(state);
  const plan = planLibraryBatch(input('archive', ['a', 'empty', 'a'], ['a1', 'a2-hidden-trash', 'b1', 'b1']), state);
  assert.deepEqual(plan.sessionGroupIds, ['a', 'empty']);
  assert.deepEqual(plan.sessionIds, ['b1']);
  assert.deepEqual(plan.affectedSessionIds, ['a1', 'a2-hidden-trash', 'b1']);
  assert.deepEqual(state, before, 'preflight is read-only');
});

test('a valid prefix cannot conceal missing selections or an invalid transition', () => {
  const state = fixture();
  assert.throws(() => planLibraryBatch(input('trash', ['a'], ['stale-id']), state), /不存在/);
  assert.throws(() => planLibraryBatch(input('trash', ['a', 'missing'], ['a1']), state), /不存在/);
  assert.throws(() => planLibraryBatch(input('delete', ['empty'], ['b1']), state), /回收站/);
  assert.throws(() => planLibraryBatch(input('restore', [], ['b1']), state), /回收站/);
  assert.throws(() => planLibraryBatch(input('unarchive', [], ['b1']), state), /归档/);
  assert.throws(() => planLibraryBatch(input('archive', [], ['b1', 'a2-hidden-trash']), state), /常用/);
  assert.throws(() => planLibraryBatch(input('trash'), state), /选择/);
});

test('running and paused hidden children block whole-Session mutation', () => {
  for (const status of ['recording', 'paused']) {
    const state = fixture();
    state.sessions.push(record('hidden-live', 'a', 'active', status));
    assert.throws(() => planLibraryBatch(input('archive', ['empty', 'a']), state), /结束采集/);
    assert.throws(() => planLibraryBatch(input('trash', [], ['b1', 'hidden-live']), state), /结束采集/);
  }
});

test('trashed parents require whole-Session restore/delete instead of isolated child changes', () => {
  const state = fixture();
  state.sessionGroups[0].libraryState = 'trashed';
  for (const action of ['archive', 'trash', 'restore', 'delete'])
    assert.throws(() => planLibraryBatch(input(action, [], ['a1']), state), /所属 Session/);
  for (const action of ['restore', 'delete']) {
    const plan = planLibraryBatch(input(action, ['a'], ['a1', 'a2-hidden-trash']), state);
    assert.deepEqual(plan.sessionIds, []);
    assert.deepEqual(plan.affectedSessionIds, ['a1', 'a2-hidden-trash']);
  }
});

test('archived parent does not prevent a separately trashed child from being restored', () => {
  const state = fixture();
  state.sessionGroups[0].libraryState = 'archived';
  const plan = planLibraryBatch(input('restore', [], ['a2-hidden-trash']), state);
  assert.deepEqual(plan.sessionIds, ['a2-hidden-trash']);
  assert.deepEqual(plan.affectedSessionIds, ['a2-hidden-trash']);
  assert.deepEqual(planLibraryBatch(input('unarchive', ['a']), state).sessionGroupIds, ['a']);
});

test('all batch read reservations are preflighted before any storage mutation', async t => {
  const { store, ids } = await setupStore(t);
  const entered = deferred(), release = deferred();
  const reading = store.withReadLease(ids[1], async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let executed = false;
  try {
    await assert.rejects(store.withLibraryMutation(ids, async () => {
      executed = true;
      await store.archive(ids[0]);
    }), /正在读取/);
    assert.equal(executed, false);
    assert.equal(store.getSession(ids[0]).libraryState, 'active');
    assert.equal(await store.withReadLease(ids[0], async () => 'first remains available'), 'first remains available');
  } finally { release.resolve(); await reading; }
  await store.withLibraryMutation(ids, async () => { for (const id of ids) await store.archive(id); });
  assert.deepEqual(ids.map(id => store.getSession(id).libraryState), ['archived', 'archived']);
});

test('batch reservations reject new readers and overlapping batches until all writes finish', async t => {
  const { store, ids } = await setupStore(t);
  const entered = deferred(), release = deferred();
  const writing = store.withLibraryMutation([...ids, ids[0]], async () => {
    entered.resolve();
    await release.promise;
    for (const id of ids) await store.trash(id);
  });
  await entered.promise;
  try {
    for (const id of ids) await assert.rejects(store.withReadLease(id, async () => 'unexpected read'), /整理/);
    await assert.rejects(store.withLibraryMutation([ids[1]], async () => assert.fail('overlapping mutation must not enter')), /整理/);
  } finally { release.resolve(); await writing; }
  assert.equal(await store.withReadLease(ids[0], async () => 'released'), 'released');
  assert.deepEqual(ids.map(id => store.getSession(id).libraryState), ['trashed', 'trashed']);
});

test('failed batch storage work always releases reservations for future reads and retry', async t => {
  const { store, ids } = await setupStore(t);
  await assert.rejects(store.withLibraryMutation(ids, async () => { throw new Error('simulated disk write failure'); }), /disk write failure/);
  for (const id of ids) assert.equal(await store.withReadLease(id, async () => id), id);
  await store.withLibraryMutation(ids, async () => { for (const id of ids) await store.archive(id); });
  assert.deepEqual(ids.map(id => store.getSession(id).libraryState), ['archived', 'archived']);
});
