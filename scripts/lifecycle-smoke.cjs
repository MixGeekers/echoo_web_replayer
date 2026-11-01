'use strict';

// Actual Electron, persistent partitions and disk-backed recording lifecycle.
// Every run uses a dedicated profile; no user browser or recording data is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', `lifecycle-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`);
const dataDir = path.join(output, 'data');
const runtimeDir = path.join(output, 'app');
const recordingsDir = path.join(dataDir, 'workspace-v3', 'recordings');
const errors = [], logs = [], steps = [];
let desktop, ui, server, origin, profileA, profileB, sessionA, sessionB, guardedSession;
const profileGroups = new Map();

async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}
async function step(label, action) {
  await action();
  steps.push(label);
  console.log(`PASS ${label}`);
}
const call = (method, ...args) => ui.evaluate(({ method, args }) => window.collector[method](...args), { method, args });
const state = () => call('getState');
const session = async id => (await state()).sessions.find(value => value.id === id);

async function launch() {
  const env = { ...process.env, TRACEDOCK_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({
    executablePath: process.env.TRACEDOCK_EXECUTABLE || require('electron'),
    args: process.env.TRACEDOCK_EXECUTABLE ? [] : [runtimeDir], cwd: root, env, timeout: 30000,
  });
  desktop.process().stdout?.on('data', value => logs.push(value.toString()));
  desktop.process().stderr?.on('data', value => logs.push(value.toString()));
  ui = await until(() => desktop.context().pages().find(page => page.url().includes('/renderer/index.html')), 'desktop shell');
  ui.setDefaultTimeout(15000);
  ui.on('pageerror', error => errors.push(error.message));
  await ui.waitForFunction(() => Boolean(window.collector));
  await until(async () => !(await state()).browser.loading, 'startup settles');
}

async function navigateFixture() {
  await call('navigate', origin);
  const guest = await until(() => desktop.context().pages().find(page => !page.isClosed() && page.url() === `${origin}/`), 'current fixture guest');
  await guest.waitForFunction(() => document.querySelector('#logo')?.naturalWidth === 32 && Boolean(document.querySelector('#note')));
  await until(async () => !(await state()).browser.loading, 'fixture loads');
  return guest;
}
async function identity(guest) {
  return guest.evaluate(() => ({ storage: localStorage.getItem('identity'), cookie: document.cookie }));
}
async function setIdentity(guest, value) {
  await guest.evaluate(account => {
    localStorage.setItem('identity', account);
    document.cookie = `identity=${account}; Path=/; Max-Age=86400; SameSite=Lax`;
    document.querySelector('#note').value = account;
  }, value);
}
async function startRecording(name, throughUI = false, groupId) {
  const current = await state();
  if (!groupId) groupId = profileGroups.get(current.activeProfileId);
  if (!groupId) {
    if (throughUI) {
      await ui.locator('#new-session-button').click();
      await confirmManagement(`${name} Session`);
      groupId = (await state()).sessionGroups.find(group => group.profileId === current.activeProfileId).id;
    } else {
      const next = await call('createSessionGroup', { profileId: current.activeProfileId, name: `${name} Session` });
      groupId = next.sessionGroups.find(group => group.profileId === current.activeProfileId).id;
    }
    profileGroups.set(current.activeProfileId, groupId);
  }
  if (throughUI) {
    await ui.locator('#start-button').click();
    await ui.locator('#session-name-input').fill(name);
    await ui.locator('#confirm-session-button').click();
  } else await call('startSession', { sessionGroupId: groupId, name });
  return until(async () => {
    const value = (await state()).session;
    return value?.name === name && value.status === 'recording' && value.snapshotCount > 0 && value;
  }, `recording ${name}`);
}
async function pickRecord(name, scope = 'active') {
  const record = (await state()).sessions.find(value => value.name === name);
  await ui.locator(`#profile-tabs button[data-profile-id="${record.profileId}"]`).click();
  await ui.locator(`#scope-${scope}`).click();
  await ui.locator(`.session-group-select[data-session-group-id="${record.sessionGroupId}"]`).click();
  await ui.locator(`.session-item[data-recording-id="${record.id}"]`).click();
  await ui.waitForFunction(expected => document.querySelector('#current-session-name').textContent === expected, name);
}
async function confirmManagement(name) {
  await ui.locator('#management-dialog').waitFor({ state: 'visible' });
  if (name !== undefined) await ui.locator('#management-name').fill(name);
  await ui.locator('#management-confirm').click();
  await ui.locator('#management-dialog').waitFor({ state: 'hidden' });
}
async function screenshot(name) {
  const bytes = await desktop.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const [width, height] = win.getContentSize();
    return (await win.capturePage()).resize({ width, height }).toPNG();
  });
  await fs.writeFile(path.join(output, name), Buffer.from(bytes));
}

async function run() {
  await fs.mkdir(output, { recursive: true });
  // Profile switches create fresh WebContents and reload preloads. Freeze the
  // built app so an independent build cannot remove out/ during this run.
  if (!process.env.TRACEDOCK_EXECUTABLE) {
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.cp(path.join(root, 'out'), path.join(runtimeDir, 'out'), { recursive: true });
    await fs.copyFile(path.join(root, 'package.json'), path.join(runtimeDir, 'package.json'));
  }
  server = http.createServer((request, response) => {
    if (request.url === '/logo.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2563eb"/></svg>');
    } else if (request.url === '/style.css') {
      response.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' });
      response.end('body{font-family:sans-serif;color:rgb(37,99,235);padding:24px}input{padding:10px}');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><html><head><meta charset="utf-8"><title>Profile lifecycle fixture</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"></head><body><h1>独立浏览环境</h1><img id="logo" src="/logo.svg"><label>账号内容<input id="note"></label></body></html>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  await launch();

  await step('profile manager renames the default environment and recording starts through real UI', async () => {
    const initial = await state();
    assert.equal(initial.profiles.length, 1);
    profileA = initial.activeProfileId;
    assert.ok(profileA);
    await ui.locator('#manage-profiles-button').click();
    await ui.locator('#rename-profile-button').click();
    await confirmManagement('账户 A');
    await ui.locator('#profiles-done-button').click();
    assert.equal((await state()).profiles.find(p => p.id === profileA).name, '账户 A');
    const guest = await navigateFixture();
    await setIdentity(guest, 'account-a');
    sessionA = await startRecording('账户 A 原始录制', true);
    assert.equal(sessionA.profileId, profileA);
    assert.equal(sessionA.profileName, '账户 A');
    assert.equal(sessionA.sessionGroupId, profileGroups.get(profileA));
  });

  await step('creating a profile stops the current recording and isolates cookies and localStorage', async () => {
    const created = await call('createProfile', '账户 B');
    profileB = created.activeProfileId;
    assert.ok(profileB && profileB !== profileA);
    assert.equal((await session(sessionA.id)).status, 'stopped');
    const guest = await navigateFixture();
    assert.deepEqual(await identity(guest), { storage: null, cookie: '' });
    await setIdentity(guest, 'account-b');
    sessionB = await startRecording('账户 B 暂停后切换');
    await call('pauseSession');
    assert.equal((await state()).session.status, 'paused');
  });

  await step('switching profiles through UI saves a paused recording and restores the selected identity', async () => {
    // API calls return before the debounced renderer state notification arrives.
    await ui.waitForFunction(() => document.querySelector('#pause-button').textContent.includes('继续'));
    await ui.locator(`#profile-tabs button[data-profile-id="${profileA}"]`).click();
    await confirmManagement();
    assert.equal((await state()).activeProfileId, profileA);
    assert.equal((await session(sessionB.id)).status, 'stopped');
    const guest = await navigateFixture();
    assert.deepEqual(await identity(guest), { storage: 'account-a', cookie: 'identity=account-a' });
    assert.equal((await session(sessionB.id)).profileId, profileB);
    await assert.rejects(call('startSession', { sessionGroupId: profileGroups.get(profileB), name: '跨环境采集' }), /Profile|环境/);
  });

  await step('one Session contains repeated captures and closing it stops only its active capture', async () => {
    const groupId = profileGroups.get(profileA);
    const second = await startRecording('账户 A 第二次采集', false, groupId);
    assert.notEqual(second.id, sessionA.id);
    assert.equal(second.sessionGroupId, sessionA.sessionGroupId);
    await call('closeSessionGroup', groupId);
    assert.equal((await session(second.id)).status, 'stopped');
    assert.equal((await state()).sessionGroups.find(group => group.id === groupId).status, 'closed');
    assert.equal((await state()).sessions.filter(record => record.sessionGroupId === groupId).length, 2);
    await assert.rejects(call('startSession', { sessionGroupId: groupId, name: '关闭后尝试采集' }), /关闭|打开|开启/);
    await call('reopenSessionGroup', groupId);
    const third = await startRecording('账户 A 再次复验', false, groupId);
    await assert.rejects(call('archiveSessionGroup', groupId), /录制|结束|采集/);
    await assert.rejects(call('trashSessionGroup', groupId), /录制|结束|采集/);
    await call('stopSession');
    assert.equal((await session(third.id)).sessionGroupId, groupId);
    assert.equal((await session(sessionA.id)).name, sessionA.name);
  });

  await step('Session archive and trash preserve child states while parent trash blocks reading and export', async () => {
    const groupId = profileGroups.get(profileA);
    const before = (await state()).sessions.filter(record => record.sessionGroupId === groupId).map(record => [record.id, record.libraryState]);
    await call('archiveSessionGroup', groupId);
    assert.equal((await state()).sessionGroups.find(group => group.id === groupId).status, 'closed');
    assert.ok((await call('getTimeline', { sessionId: sessionA.id })).total > 0, 'archived Session keeps captures readable');
    await assert.rejects(call('startSession', { sessionGroupId: groupId, name: '归档后尝试采集' }), /归档|常用|打开/);
    await call('trashSessionGroup', groupId);
    await assert.rejects(call('getTimeline', { sessionId: sessionA.id }), /回收站|恢复/);
    await assert.rejects(call('replaySeek', { sessionId: sessionA.id }), /回收站|恢复/);
    await assert.rejects(call('exportSession', { sessionId: sessionA.id, encoding: 'delta', compression: 'deflate' }), /回收站|恢复/);
    await call('restoreSessionGroup', groupId);
    assert.equal((await state()).sessionGroups.find(group => group.id === groupId).libraryState, 'archived');
    await call('unarchiveSessionGroup', groupId);
    assert.equal((await state()).sessionGroups.find(group => group.id === groupId).status, 'closed');
    await call('reopenSessionGroup', groupId);
    assert.deepEqual((await state()).sessions.filter(record => record.sessionGroupId === groupId).map(record => [record.id, record.libraryState]), before);
  });

  await step('permanent Session deletion cascades all capture states without affecting another Session', async () => {
    const name = '待清理的整组 Session';
    const created = await call('createSessionGroup', { profileId: profileA, name });
    const group = created.sessionGroups.find(value => value.name === name);
    const first = await startRecording('整组中的归档记录', false, group.id);
    await call('stopSession');
    await call('archiveSession', first.id);
    const second = await startRecording('整组中的回收站记录', false, group.id);
    await call('stopSession');
    await call('trashSession', second.id);
    await assert.rejects(call('deleteSessionGroup', group.id), /回收站/);
    await call('trashSessionGroup', group.id);
    await call('deleteSessionGroup', group.id);
    assert.ok(!(await state()).sessionGroups.some(value => value.id === group.id));
    assert.ok(!(await state()).sessions.some(record => record.sessionGroupId === group.id));
    for (const record of [first, second]) await assert.rejects(fs.stat(path.join(recordingsDir, record.id)), { code: 'ENOENT' });
    assert.ok(await session(sessionA.id), 'other Session history survives');
    await assert.rejects(call('startSession', { sessionGroupId: group.id, name: '已删除容器' }), /找不到/);
  });

  await step('pending export locks archival and deletion until cancellation completes', async () => {
    await desktop.evaluate(({ dialog }) => {
      globalThis.lifecycleOriginalSaveDialog = dialog.showSaveDialog;
      dialog.showSaveDialog = () => new Promise(resolve => { globalThis.lifecycleSaveDialogResolve = resolve; });
    });
    const pending = call('exportSession', { sessionId: sessionB.id, encoding: 'delta', compression: 'deflate' })
      .then(value => ({ value }), error => ({ error }));
    try {
      await until(async () => (await state()).export?.phase === 'selecting', 'export owns record during save dialog');
      await assert.rejects(call('archiveSession', sessionB.id), /导出/);
      await assert.rejects(call('trashSession', sessionB.id), /导出/);
      await assert.rejects(call('deleteSession', sessionB.id), /导出/);
      await assert.rejects(call('archiveSessionGroup', profileGroups.get(profileB)), /导出/);
      await assert.rejects(call('trashSessionGroup', profileGroups.get(profileB)), /导出/);
      await call('cancelExport');
    } finally {
      await desktop.evaluate(({ dialog }) => {
        globalThis.lifecycleSaveDialogResolve?.({ canceled: true });
        dialog.showSaveDialog = globalThis.lifecycleOriginalSaveDialog;
        delete globalThis.lifecycleSaveDialogResolve;
        delete globalThis.lifecycleOriginalSaveDialog;
      });
    }
    const result = await pending;
    assert.equal(result.error, undefined);
    assert.equal(result.value.canceled, true);
    await until(async () => !(await state()).export, 'export releases record after cancellation');
  });

  await step('record rename, archive, trash and restore preserve archived membership through real UI', async () => {
    await pickRecord(sessionA.name);
    await ui.locator('#rename-session-button').click();
    await confirmManagement('账户 A 保留的录制');
    sessionA = await session(sessionA.id);
    await ui.locator('#archive-session-button').click();
    await until(async () => (await session(sessionA.id)).libraryState === 'archived', 'archive persists');
    await pickRecord(sessionA.name, 'archived');
    await ui.locator('#archive-session-button').click();
    await until(async () => (await session(sessionA.id)).libraryState === 'active', 'unarchive persists');
    await pickRecord(sessionA.name);
    await ui.locator('#archive-session-button').click();
    await pickRecord(sessionA.name, 'archived');
    await ui.locator('#trash-session-button').click();
    await confirmManagement();
    assert.equal((await session(sessionA.id)).libraryState, 'trashed');
    assert.equal((await session(sessionA.id)).trashOrigin, 'archived');
    await assert.rejects(call('getTimeline', { sessionId: sessionA.id }), /回收站|删除|trashed/);
    await assert.rejects(call('exportSession', { sessionId: sessionA.id, encoding: 'delta', compression: 'deflate' }), /回收站|删除|trashed/);
    await pickRecord(sessionA.name, 'trashed');
    await ui.locator('#restore-session-button').click();
    await until(async () => (await session(sessionA.id)).libraryState === 'archived', 'restore retains archived origin');
    await pickRecord(sessionA.name, 'archived');
    await screenshot('archived-records.png');
  });

  await step('active-origin trash restoration and permanent deletion remove the complete session directory', async () => {
    await call('trashSession', sessionB.id);
    assert.equal((await session(sessionB.id)).trashOrigin, 'active');
    await call('restoreSession', sessionB.id);
    assert.equal((await session(sessionB.id)).libraryState, 'active');
    await call('trashSession', sessionB.id);
    await pickRecord(sessionB.name, 'trashed');
    await ui.locator('#delete-session-button').click();
    await confirmManagement();
    assert.equal(await session(sessionB.id), undefined);
    await assert.rejects(fs.stat(path.join(recordingsDir, sessionB.id)), { code: 'ENOENT' });
    await assert.rejects(call('getTimeline', { sessionId: sessionB.id }), /找不到/);
  });

  await step('deleting the just-stopped current session does not leave a stale pointer or block a new recording', async () => {
    await call('switchProfile', profileB);
    await navigateFixture();
    const first = await startRecording('删除当前记录');
    await call('stopSession');
    await call('trashSession', first.id);
    await call('deleteSession', first.id);
    assert.equal(await session(first.id), undefined);
    const second = await startRecording('删除之后的新录制');
    assert.notEqual(second.id, first.id);
    assert.equal(second.profileId, profileB);
    await call('stopSession');
    await call('trashSession', second.id);
    await call('deleteSession', second.id);
  });

  await step('cache cleanup keeps login while storage cleanup removes cookies and localStorage', async () => {
    await call('switchProfile', profileB);
    let guest = await navigateFixture();
    assert.deepEqual(await identity(guest), { storage: 'account-b', cookie: 'identity=account-b' });
    await call('clearProfileData', { profileId: profileB, kind: 'cache' });
    assert.equal((await state()).activeProfileId, null);
    await call('switchProfile', profileB);
    guest = await navigateFixture();
    assert.deepEqual(await identity(guest), { storage: 'account-b', cookie: 'identity=account-b' });
    await call('clearProfileData', { profileId: profileB, kind: 'storage' });
    await call('switchProfile', profileB);
    guest = await navigateFixture();
    assert.deepEqual(await identity(guest), { storage: null, cookie: '' });
    await setIdentity(guest, 'account-b-after-clear');
  });

  await step('recording guards reject archival/deletion and deleting its profile finishes recording but retains history', async () => {
    await call('switchProfile', profileA);
    await navigateFixture();
    guardedSession = await startRecording('活动录制保护');
    await assert.rejects(call('archiveSession', guardedSession.id), /录制|结束/);
    await assert.rejects(call('trashSession', guardedSession.id), /录制|结束/);
    await assert.rejects(call('deleteSession', guardedSession.id), /录制|回收站|结束/);
    const deleted = await call('deleteProfile', profileA);
    assert.equal(deleted.activeProfileId, null);
    assert.equal(deleted.browser.available, false);
    assert.ok(!deleted.profiles.some(p => p.id === profileA));
    assert.equal((await session(guardedSession.id)).status, 'stopped');
    assert.equal((await session(sessionA.id)).libraryState, 'archived');
    assert.equal((await session(sessionA.id)).profileId, profileA);
    await assert.rejects(call('startSession', { sessionGroupId: profileGroups.get(profileA), name: 'no profile' }), /环境|Profile|浏览器/);
  });

  await step('restart preserves profile selection, archived records and browser identity', async () => {
    await desktop.close();
    await launch();
    const reopened = await state();
    assert.equal(reopened.activeProfileId, null);
    assert.equal(reopened.browser.available, false);
    assert.deepEqual(reopened.profiles.map(p => p.id), [profileB]);
    assert.equal((await session(sessionA.id)).libraryState, 'archived');
    assert.equal((await session(sessionA.id)).name, '账户 A 保留的录制');
    assert.ok(reopened.sessionGroups.some(group => group.id === profileGroups.get(profileA) && group.profileId === profileA));
    assert.ok(reopened.sessionGroups.some(group => group.id === profileGroups.get(profileB) && group.profileId === profileB));
    await call('switchProfile', profileB);
    const guest = await navigateFixture();
    assert.deepEqual(await identity(guest), { storage: 'account-b-after-clear', cookie: 'identity=account-b-after-clear' });
    await ui.locator('#close-profile-button').click();
    await confirmManagement();
    assert.equal((await state()).browser.available, false);
  });

  await step('deleting the last profile still allows offline replay and replay protects the record from deletion', async () => {
    await call('deleteProfile', profileB);
    assert.deepEqual((await state()).profiles, []);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server = undefined;
    await pickRecord(sessionA.name, 'archived');
    await ui.locator('#replay-button').click();
    await ui.waitForFunction(() => !document.querySelector('#replay-play').disabled && document.querySelector('#replay-frame').contentDocument.querySelector('#logo')?.naturalWidth === 32);
    await assert.rejects(call('trashSession', sessionA.id), /回放|占用/);
    await assert.rejects(call('trashSessionGroup', profileGroups.get(profileA)), /回放|占用/);
    await screenshot('offline-replay-with-no-profiles.png');
    await ui.locator('#replay-close').click();
    await until(async () => await ui.locator('#replay-panel').isHidden(), 'replay closes');
    await call('trashSession', sessionA.id);
    await call('restoreSession', sessionA.id);
  });

  await step('zero profiles persist on restart without recreating a default or losing retained recordings', async () => {
    await desktop.close();
    await launch();
    const reopened = await state();
    assert.deepEqual(reopened.profiles, []);
    assert.equal(reopened.activeProfileId, null);
    assert.equal(reopened.browser.available, false);
    assert.equal((await session(sessionA.id)).libraryState, 'archived');
    assert.equal((await session(guardedSession.id)).status, 'stopped');
    await pickRecord(sessionA.name, 'archived');
    assert.match(await ui.locator('#current-session-profile').textContent(), /已删除/);
    await screenshot('empty-profiles-retained-recordings.png');
  });
  assert.deepEqual(errors, [], 'no uncaught renderer errors');
  const report = { status: 'passed', output, dataDir, steps, profileA, profileB, sessionA: sessionA.id, deletedSession: sessionB.id, rendererErrors: errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

run().catch(async error => {
  console.error(error);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', steps, error: error.message, stack: error.stack, rendererErrors: errors }, null, 2)).catch(() => {});
  if (desktop) await screenshot('failure.png').catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await desktop?.close().catch(() => {});
  if (server) { server.closeAllConnections(); server.close(); }
  await fs.writeFile(path.join(output, 'electron.log'), logs.join('')).catch(() => {});
});
