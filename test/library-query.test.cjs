'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { libraryDateError, libraryMatches, queryLibrary } = require('../out/library-query.cjs');
const query = overrides => ({ profileId: 'profile-a', scope: 'active', name: '', from: '', to: '', ...overrides });
const group = (id, name, changes = {}) => ({ id, name, profileId: 'profile-a', libraryState: 'active', createdAt: new Date(2026, 10, 1, 12).toISOString(), ...changes });
const record = (id, sessionGroupId, name, changes = {}) => ({ id, sessionGroupId, name, profileId: 'profile-a', libraryState: 'active', startedAt: new Date(2026, 10, 1, 12).toISOString(), ...changes });

test('name filtering trims the query, ignores letter case and combines name with creation dates', () => {
  const date = new Date(2026, 10, 1, 12).toISOString();
  assert.equal(libraryMatches('支付 Checkout 复验', date, query({ name: '  CHECKout  ' })), true);
  assert.equal(libraryMatches('支付 Checkout 复验', date, query({ name: '支付' })), true);
  assert.equal(libraryMatches('支付 Checkout 复验', date, query({ name: 'checkout', from: '2026-11-02' })), false);
  assert.equal(libraryMatches('其他流程', date, query({ name: 'checkout', to: '2026-11-01' })), false);
});

test('date range includes both complete local days and excludes adjacent days', () => {
  const dates = query({ from: '2026-11-01', to: '2026-11-02' });
  for (const date of [new Date(2026, 10, 1, 0, 0, 0), new Date(2026, 10, 2, 23, 59, 59, 999)])
    assert.equal(libraryMatches('采集', date.toISOString(), dates), true);
  for (const date of [new Date(2026, 9, 31, 23, 59, 59, 999), new Date(2026, 10, 3, 0, 0, 0)])
    assert.equal(libraryMatches('采集', date.toISOString(), dates), false);
  assert.equal(libraryMatches('采集', new Date(2026, 10, 2).toISOString(), query({ from: '2026-11-02' })), true);
  assert.equal(libraryMatches('采集', new Date(2026, 10, 2).toISOString(), query({ to: '2026-11-02' })), true);
  assert.equal(libraryMatches('采集', 'invalid date', dates), false);
  assert.ok(libraryDateError('2026-11-02', '2026-11-01'));
  assert.equal(libraryDateError('2026-11-01', '2026-11-01'), '');
});

test('matching records retain contextual parents without making those parents select-all matches', () => {
  const groups = [group('a', '登录'), group('b', '支付'), group('c', '空任务')];
  const records = [record('a1', 'a', '支付校验'), record('a2', 'a', '其他采集'), record('b1', 'b', '支付流程')];
  const found = queryLibrary(groups, records, query({ name: '支付' }));
  assert.deepEqual(found.groups.map(g => g.id), ['a', 'b']);
  assert.deepEqual(found.records.map(r => r.id), ['a1', 'b1']);
  assert.deepEqual([...found.directGroupIds], ['b']);
  assert.ok(!found.directGroupIds.has('a'), 'context parents are not implicit whole-Session targets');
});

test('matching Session names and dates do not make nonmatching child records into results', () => {
  const groups = [group('a', '同名 Session', { createdAt: new Date(2026, 10, 1).toISOString() })];
  const records = [record('a1', 'a', '无关记录'), record('a2', 'a', '同名记录', { startedAt: new Date(2026, 10, 2).toISOString() })];
  const found = queryLibrary(groups, records, query({ name: '同名', from: '2026-11-01', to: '2026-11-01' }));
  assert.deepEqual(found.groups.map(g => g.id), ['a']);
  assert.deepEqual(found.records, []);
  assert.deepEqual([...found.directGroupIds], ['a']);
});

test('Profile selection can search all retained histories and excludes orphan records', () => {
  const groups = [group('a', '任务'), group('b', '任务', { profileId: 'deleted-profile' })];
  const records = [record('a1', 'a', '记录'), record('b1', 'b', '记录', { profileId: 'deleted-profile' }), record('orphan', 'missing', '记录')];
  assert.deepEqual(queryLibrary(groups, records, query()).records.map(r => r.id), ['a1']);
  const all = queryLibrary(groups, records, query({ profileId: null }));
  assert.deepEqual(all.groups.map(g => g.id), ['a', 'b']);
  assert.deepEqual(all.records.map(r => r.id), ['a1', 'b1']);
});

test('scope inheritance respects parent trash, child trash, and parent archive independently', () => {
  const groups = [group('a', '常用'), group('b', '归档', { libraryState: 'archived' }), group('c', '回收站', { libraryState: 'trashed' })];
  const records = [record('a-active', 'a', '记录'), record('a-archive', 'a', '记录', { libraryState: 'archived' }), record('a-trash', 'a', '记录', { libraryState: 'trashed' }), record('b-active', 'b', '记录'), record('b-trash', 'b', '记录', { libraryState: 'trashed' }), record('c-active', 'c', '记录'), record('c-archive', 'c', '记录', { libraryState: 'archived' })];
  assert.deepEqual(queryLibrary(groups, records, query()).records.map(r => r.id), ['a-active']);
  assert.deepEqual(queryLibrary(groups, records, query({ scope: 'archived' })).records.map(r => r.id), ['a-archive', 'b-active']);
  const trash = queryLibrary(groups, records, query({ scope: 'trashed' }));
  assert.deepEqual(trash.records.map(r => r.id), ['a-trash', 'b-trash', 'c-active', 'c-archive']);
  assert.deepEqual([...trash.directGroupIds], ['c']);
});

test('reversed date ranges return no groups or records even if names match', () => {
  const result = queryLibrary([group('a', '匹配')], [record('a1', 'a', '匹配')], query({ name: '匹配', from: '2026-11-02', to: '2026-11-01' }));
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.records, []);
  assert.equal(result.directGroupIds.size, 0);
});
