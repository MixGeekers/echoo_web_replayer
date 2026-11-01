'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ProfileStore, PROFILE_ID_PATTERN } = require('../out/profile-store.cjs');

async function setup(t) {
  const parent = path.join(__dirname, '..', 'output', 'test-temp');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'profiles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: await new ProfileStore(root).init() };
}

test('profiles retain immutable identities, names and selection across restart', async t => {
  const { root, store } = await setup(t);
  const initial = store.list()[0];
  assert.equal(initial.name, '默认环境');
  assert.match(initial.id, PROFILE_ID_PATTERN);
  assert.equal(store.activeId, initial.id);
  const created = await store.create('  工作账号  ');
  assert.equal(created.name, '工作账号');
  assert.equal(store.activeId, initial.id, 'creation does not implicitly switch browsers');
  const selected = await store.select(created.id);
  assert.equal(selected.id, created.id);
  const renamed = await store.rename(created.id, '测试账号');
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.createdAt, created.createdAt);
  const reopened = await new ProfileStore(root).init();
  assert.equal(reopened.activeId, created.id);
  assert.equal(reopened.get(created.id).name, '测试账号');
  const snapshot = reopened.list();
  snapshot[0].name = 'mutated copy';
  assert.equal(reopened.get(initial.id).name, '默认环境');
  await reopened.select(null);
  assert.equal((await new ProfileStore(root).init()).activeId, null, 'closed state persists');
});

test('active profiles cannot be deleted and deleting the last profile survives restart', async t => {
  const { root, store } = await setup(t);
  const id = store.activeId;
  await assert.rejects(store.delete(id), /请先关闭/);
  assert.equal(store.list().length, 1);
  await store.select(null);
  await store.delete(id);
  assert.deepEqual(store.list(), []);
  const reopened = await new ProfileStore(root).init();
  assert.deepEqual(reopened.list(), []);
  assert.equal(reopened.activeId, null);
  const replacement = await reopened.create('新的环境');
  assert.notEqual(replacement.id, id);
  assert.equal(reopened.activeId, null);
  assert.equal((await reopened.select(replacement.id)).id, replacement.id);
});

test('serialized profile changes prevent duplicate names and reject invalid inputs without losing state', async t => {
  const { root, store } = await setup(t);
  const results = await Promise.allSettled([store.create('Work'), store.create('work')]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  const work = results[0].value;
  await assert.rejects(store.rename(store.activeId, 'WORK'), /已存在/);
  for (const name of ['', '   ', 'x'.repeat(81), null, 42]) {
    await assert.rejects(store.create(name), /名称/);
  }
  for (const operation of [() => store.select('../escape'), () => store.delete('../escape'), () => store.rename('../escape', 'safe')]) {
    await assert.rejects(operation(), /无效/);
  }
  await store.rename(work.id, 'work');
  const reopened = await new ProfileStore(root).init();
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.get(work.id).name, 'work');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), []);
});

test('invalid persisted profile documents fail without rewriting or migrating their bytes', async t => {
  const { root, store } = await setup(t);
  const file = path.join(root, 'profiles.json');
  const valid = JSON.parse(await fs.readFile(file, 'utf8'));
  const cases = [
    { ...valid, schemaVersion: 0 },
    { ...valid, activeId: 'profile-00000000-0000-0000-0000-000000000000' },
    { ...valid, profiles: [...valid.profiles, valid.profiles[0]] },
    { ...valid, profiles: [{ ...valid.profiles[0], name: '  invalid  ' }] },
    { ...valid, profiles: [{ ...valid.profiles[0], createdAt: 'not-a-date' }] },
    { ...valid, profiles: [{ ...valid.profiles[0], id: '../outside' }] },
  ];
  for (const data of cases) {
    const bytes = JSON.stringify(data);
    await fs.writeFile(file, bytes);
    await assert.rejects(new ProfileStore(root).init());
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
  await fs.writeFile(file, '{incomplete');
  await assert.rejects(new ProfileStore(root).init());
  assert.equal(await fs.readFile(file, 'utf8'), '{incomplete');
  assert.equal(store.list().length, 1);
});
