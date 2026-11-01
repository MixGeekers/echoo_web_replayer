'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionGroupStore, SESSION_GROUP_ID_PATTERN } = require('../out/session-group-store.cjs');
const { SessionStore } = require('../out/session-store.cjs');
const profileA = { id: 'profile-00000000-0000-4000-8000-000000000001', name: '工作环境' };
const profileB = { id: 'profile-00000000-0000-4000-8000-000000000002', name: '测试环境' };

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracedock-groups-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, groups: await new SessionGroupStore(root).init(), records: await new SessionStore(path.join(root, 'recordings')).init() };
}
async function capture(records, group, profile, name) {
  const record = await records.create(name, 'https://example.test/', profile, group.id);
  await records.append(record.id, { type: 'action.input', payload: { value: name } });
  await records.update(record.id, { status: 'stopped', endedAt: new Date().toISOString() });
  return record;
}

test('Session containers keep multiple captures and distinct profile ownership across restart', async t => {
  const { root, groups, records } = await setup(t);
  assert.deepEqual(groups.list(), []);
  const first = await groups.create('  登录流程  ', profileA);
  const second = await groups.create('另一 Session', profileA);
  const otherProfile = await groups.create('登录流程', profileB);
  assert.match(first.id, SESSION_GROUP_ID_PATTERN);
  assert.equal(first.name, '登录流程');
  const a1 = await capture(records, first, profileA, '首次采集');
  const a2 = await capture(records, first, profileA, '复验采集');
  const b1 = await capture(records, second, profileA, '另一流程');
  const c1 = await capture(records, otherProfile, profileB, '另一账号');
  assert.notEqual(a1.id, a2.id);
  const restartedGroups = await new SessionGroupStore(root).init();
  const restartedRecords = await new SessionStore(records.rootDir).init();
  assert.deepEqual(restartedRecords.list().filter(record => record.sessionGroupId === first.id).map(record => record.id).sort(), [a1.id, a2.id].sort());
  assert.equal(restartedRecords.getSession(b1.id).sessionGroupId, second.id);
  assert.equal(restartedRecords.getSession(c1.id).profileId, profileB.id);
  assert.equal(restartedGroups.get(first.id).profileId, profileA.id);
  assert.equal(restartedGroups.get(otherProfile.id).profileId, profileB.id);
  const snapshot = restartedGroups.list();
  snapshot[0].name = '外部修改';
  assert.equal(restartedGroups.get(first.id).name, first.name);
});

test('closing, archiving and restoring Session containers preserves independently managed capture records', async t => {
  const { root, groups, records } = await setup(t);
  const group = await groups.create('同一任务多次采集', profileA);
  const first = await capture(records, group, profileA, '保留的采集');
  const second = await capture(records, group, profileA, '已删除的采集');
  await records.archive(first.id);
  await records.trash(second.id);
  const before = records.list();
  await groups.close(group.id);
  assert.equal(groups.get(group.id).status, 'closed');
  await groups.reopen(group.id);
  assert.equal(groups.get(group.id).status, 'open');
  await groups.archive(group.id);
  assert.equal(groups.get(group.id).status, 'closed');
  await assert.rejects(groups.reopen(group.id), /取消归档/);
  await groups.trash(group.id);
  assert.equal(groups.get(group.id).trashOrigin, 'archived');
  const reopened = await new SessionGroupStore(root).init();
  assert.equal((await reopened.restore(group.id)).libraryState, 'archived');
  await reopened.unarchive(group.id);
  assert.equal(reopened.get(group.id).status, 'closed', 'unarchiving does not silently reopen a closed Session');
  await reopened.reopen(group.id);
  await reopened.trash(group.id);
  const restored = await reopened.restore(group.id);
  assert.equal(restored.status, 'open');
  assert.equal(restored.libraryState, 'active');
  assert.deepEqual(records.list(), before, 'container transitions never rewrite child lifecycle states or recording facts');
});

test('Session cascade deletion preflights all captures before committing deletion intent', async t => {
  const { groups, records } = await setup(t);
  const group = await groups.create('删除保护', profileA);
  const done = await capture(records, group, profileA, '已完成');
  const live = await records.create('进行中', '', profileA, group.id);
  await groups.trash(group.id);
  let marked = false;
  await assert.rejects(records.deleteGroupRecordings(group.id, async () => { marked = true; await groups.beginDelete(group.id); }), /结束|录制/);
  assert.equal(marked, false);
  assert.equal(records.list().length, 2);
  assert.deepEqual(groups.pendingDeletions(), []);
  await records.update(live.id, { status: 'stopped', endedAt: new Date().toISOString() });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const original = records.capture.bind(records);
  records.capture = async id => { entered(); await pending; return original(id); };
  const reading = records.timeline({ sessionId: done.id });
  await started;
  await assert.rejects(records.deleteGroupRecordings(group.id, () => groups.beginDelete(group.id)), /读取/);
  assert.deepEqual(groups.pendingDeletions(), []);
  release();
  await reading;
  await records.deleteGroupRecordings(group.id, () => groups.beginDelete(group.id));
  await groups.finishDelete(group.id);
  assert.deepEqual(records.list(), []);
  assert.deepEqual(groups.list(), []);
});

test('Session cascade deletion removes every child state and resource but keeps other Sessions and external exports', async t => {
  const { root, groups, records } = await setup(t);
  const removed = await groups.create('删除这组', profileA);
  const retained = await groups.create('保留这组', profileB);
  const children = await Promise.all(['常用', '归档', '回收站'].map(name => capture(records, removed, profileA, name)));
  const survivor = await capture(records, retained, profileB, '不相关记录');
  await records.archive(children[1].id);
  await records.trash(children[2].id);
  for (const child of children) {
    const assets = path.join(records.getSessionDirectory(child.id), 'assets');
    await fs.mkdir(assets);
    await fs.writeFile(path.join(assets, 'resource'), 'captured asset');
  }
  const exported = path.join(root, 'separate-export.zip');
  await fs.writeFile(exported, 'retained export');
  await groups.trash(removed.id);
  await records.deleteGroupRecordings(removed.id, () => groups.beginDelete(removed.id));
  await groups.finishDelete(removed.id);
  assert.deepEqual(records.list().map(record => record.id), [survivor.id]);
  for (const child of children) {
    assert.equal(records.indexes.has(child.id), false);
    await assert.rejects(fs.stat(records.getSessionDirectory(child.id)), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(exported, 'utf8'), 'retained export');
  assert.deepEqual((await new SessionGroupStore(root).init()).list().map(group => group.id), [retained.id]);
  assert.deepEqual((await new SessionStore(records.rootDir).init()).list().map(record => record.id), [survivor.id]);
});

test('interrupted group deletion remains hidden and resumes from durable intent after restart', async t => {
  const { root, groups, records } = await setup(t);
  const group = await groups.create('中断删除', profileA);
  const first = await capture(records, group, profileA, '已经清理');
  await capture(records, group, profileA, '仍待清理');
  await groups.trash(group.id);
  await groups.beginDelete(group.id);
  await records.trash(first.id);
  await records.deletePermanently(first.id);
  const resumedGroups = await new SessionGroupStore(root).init();
  const resumedRecords = await new SessionStore(records.rootDir).init();
  assert.deepEqual(resumedGroups.list(), []);
  assert.throws(() => resumedGroups.get(group.id), /正在删除/);
  assert.deepEqual(resumedGroups.pendingDeletions(), [group.id]);
  await resumedRecords.deleteGroupRecordings(group.id);
  await resumedGroups.finishDelete(group.id);
  assert.deepEqual(resumedGroups.pendingDeletions(), []);
  assert.deepEqual(resumedRecords.list(), []);
  assert.deepEqual((await new SessionGroupStore(root).init()).list(), []);
});

test('Session metadata requires explicit ownership and valid lifecycle state without migration', async t => {
  const { root, groups, records } = await setup(t);
  await assert.rejects(groups.create('无 Profile', null), /Profile/);
  await assert.rejects(groups.create('  ', profileA), /名称/);
  const group = await groups.create('严格基线', profileA);
  await assert.rejects(records.create('缺少 Session', '', profileA), /Session/);
  await assert.rejects(groups.beginDelete(group.id), /回收站/);
  await assert.rejects(groups.restore(group.id), /不在回收站/);
  await groups.rename(group.id, '重新命名');
  const filename = path.join(root, 'session-groups.json');
  const baseline = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const change of [
    value => { delete value.groups[0].profileId; },
    value => { value.groups[0].libraryState = 'archived'; },
    value => { value.groups[0].status = 'recording'; },
    value => { value.groups.push({ ...value.groups[0] }); },
    value => { value.schemaVersion = 0; },
  ]) {
    const invalid = structuredClone(baseline);
    change(invalid);
    const bytes = JSON.stringify(invalid);
    await fs.writeFile(filename, bytes);
    await assert.rejects(new SessionGroupStore(root).init(), /Session/);
    assert.equal(await fs.readFile(filename, 'utf8'), bytes);
  }
});
