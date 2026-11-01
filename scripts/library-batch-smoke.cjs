'use strict';

// Disk-backed lifecycle checks against the actual Electron IPC boundary.
// Every run freezes the built app and uses a separate data directory.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', `library-batch-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`);
const dataDir = path.join(output, 'data');
const runtimeDir = path.join(output, 'app');
const recordingsDir = path.join(dataDir, 'workspace-v3', 'recordings');
const errors = [], logs = [], steps = [];
let desktop, ui;

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
const batch = (action, sessionGroupIds = [], sessionIds = []) => call('batchLibrary', { action, sessionGroupIds, sessionIds });
const snapshot = async () => {
  const current = await state();
  return {
    groups: current.sessionGroups.map(g => [g.id, g.libraryState, g.status, g.trashOrigin]),
    records: current.sessions.map(r => [r.id, r.libraryState, r.status, r.trashOrigin]),
  };
};
async function launch() {
  const env = { ...process.env, TRACEDOCK_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({ executablePath: require('electron'), args: [runtimeDir], cwd: root, env, timeout: 30000 });
  desktop.process().stdout?.on('data', value => logs.push(value.toString()));
  desktop.process().stderr?.on('data', value => logs.push(value.toString()));
  ui = await until(() => desktop.context().pages().find(page => page.url().includes('/renderer/index.html')), 'desktop shell');
  ui.on('pageerror', error => errors.push(error.message));
  await ui.waitForFunction(() => Boolean(window.collector?.batchLibrary));
  await until(async () => !(await state()).browser.loading, 'browser ready');
}
async function group(profileId, name) {
  return (await call('createSessionGroup', { profileId, name })).sessionGroups.find(value => value.name === name);
}
async function capture(sessionGroupId, name, stop = true) {
  const started = await call('startSession', { sessionGroupId, name });
  await until(async () => (await state()).session?.snapshotCount > 0, `initial snapshot of ${name}`);
  if (stop) await call('stopSession');
  return (await state()).sessions.find(value => value.id === started.id);
}
async function unchangedAfterRejection(operation, pattern) {
  const before = await snapshot();
  await assert.rejects(operation, pattern);
  assert.deepEqual(await snapshot(), before, 'preflight rejects the whole batch before any member changes');
}
async function run() {
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.cp(path.join(root, 'out'), path.join(runtimeDir, 'out'), { recursive: true });
  await fs.copyFile(path.join(root, 'package.json'), path.join(runtimeDir, 'package.json'));
  await launch();
  const profileA = (await state()).activeProfileId;
  const a = await group(profileA, '批量任务 A');
  const a1 = await capture(a.id, 'A 常用采集');
  const a2 = await capture(a.id, 'A 原已删除采集');
  await call('trashSession', a2.id);
  const b = await group(profileA, '保留任务 B');
  const b1 = await capture(b.id, 'B 保留归档采集');
  await call('archiveSession', b1.id);
  const b2 = await capture(b.id, 'B 独立采集');
  const c = await group(profileA, '空 Session C');
  const second = await call('createProfile', '跨 Profile 批量');
  const profileB = second.activeProfileId;
  const d = await group(profileB, '任务 D');
  const d1 = await capture(d.id, 'D 独立采集');

  await step('mixed Session and recording archive deduplicates selected descendants across profiles', async () => {
    const next = await batch('archive', [a.id, c.id, a.id], [a1.id, b2.id, d1.id, b2.id]);
    for (const id of [a.id, c.id]) {
      assert.equal(next.sessionGroups.find(g => g.id === id).libraryState, 'archived');
      assert.equal(next.sessionGroups.find(g => g.id === id).status, 'closed');
    }
    assert.equal(next.sessions.find(r => r.id === a1.id).libraryState, 'active', 'parent archive preserves individual child state');
    assert.equal(next.sessions.find(r => r.id === a2.id).libraryState, 'trashed', 'hidden trashed descendant remains trashed');
    for (const id of [b2.id, d1.id]) assert.equal(next.sessions.find(r => r.id === id).libraryState, 'archived');
    assert.equal(next.activeProfileId, profileB, 'batch library actions do not switch browser environment');
    const active = await batch('unarchive', [a.id, c.id], [a1.id, b2.id, d1.id]);
    assert.equal(active.sessionGroups.find(g => g.id === a.id).status, 'closed');
    assert.equal(active.sessions.find(r => r.id === b2.id).libraryState, 'active');
  });

  await step('invalid IDs, empty selection and mixed lifecycle states do not mutate earlier valid members', async () => {
    await unchangedAfterRejection(() => batch('trash', [a.id], ['missing-recording']), /找不到|无效|不存在/);
    await unchangedAfterRejection(() => batch('archive', [], [b2.id, b1.id]), /归档|常用/);
    await unchangedAfterRejection(() => batch('delete', [], [b2.id, d1.id]), /回收站/);
    await unchangedAfterRejection(() => batch('trash'), /选择|至少|为空/);
  });

  await step('running and paused captures block the whole batch, including parent-level operations', async () => {
    const live = await capture(d.id, '占用中的采集', false);
    await unchangedAfterRejection(() => batch('archive', [c.id, d.id], [b2.id]), /结束|采集|录制/);
    await call('pauseSession');
    await unchangedAfterRejection(() => batch('trash', [c.id], [b2.id, live.id]), /结束|采集|录制/);
    await call('stopSession');
  });

  await step('replay reservation blocks all changes before a preceding unrelated selection mutates', async () => {
    await call('setReplaySession', d1.id);
    try {
      await unchangedAfterRejection(() => batch('trash', [c.id, d.id], [b2.id]), /回放|占用/);
      await unchangedAfterRejection(() => batch('archive', [], [b2.id, d1.id]), /回放|占用/);
    } finally { await call('setReplaySession', null); }
  });

  await step('save-dialog export reservation rejects bulk mutation until export is canceled', async () => {
    await desktop.evaluate(({ dialog }) => {
      globalThis.batchOriginalSaveDialog = dialog.showSaveDialog;
      dialog.showSaveDialog = () => new Promise(resolve => { globalThis.batchSaveDialogResolve = resolve; });
    });
    const pending = call('exportSession', { sessionId: d1.id, encoding: 'delta', compression: 'deflate' })
      .then(value => ({ value }), error => ({ error }));
    try {
      await until(async () => (await state()).export?.phase === 'selecting', 'pending export reservation');
      await unchangedAfterRejection(() => batch('archive', [c.id, d.id], [b2.id]), /导出/);
      await unchangedAfterRejection(() => batch('trash', [], [b2.id, d1.id]), /导出/);
      await call('cancelExport');
    } finally {
      await desktop.evaluate(({ dialog }) => {
        globalThis.batchSaveDialogResolve?.({ canceled: true });
        dialog.showSaveDialog = globalThis.batchOriginalSaveDialog;
        delete globalThis.batchSaveDialogResolve;
        delete globalThis.batchOriginalSaveDialog;
      });
    }
    const result = await pending;
    assert.equal(result.error, undefined);
    assert.equal(result.value.canceled, true);
    await until(async () => !(await state()).export, 'export releases reservation');
  });

  await step('bulk trash and restore retain original archive state and parent restrictions', async () => {
    await batch('archive', [a.id], [b2.id]);
    await batch('trash', [a.id, c.id], [a1.id, b2.id, d1.id]);
    await assert.rejects(call('getTimeline', { sessionId: a1.id }), /回收站|恢复/);
    await unchangedAfterRejection(() => batch('restore', [], [b2.id, a1.id]), /所属|Session|恢复/);
    const restored = await batch('restore', [a.id, c.id], [a1.id, b2.id, d1.id]);
    assert.equal(restored.sessionGroups.find(g => g.id === a.id).libraryState, 'archived');
    assert.equal(restored.sessionGroups.find(g => g.id === c.id).libraryState, 'active');
    assert.equal(restored.sessions.find(r => r.id === b2.id).libraryState, 'archived');
    assert.equal(restored.sessions.find(r => r.id === d1.id).libraryState, 'active');
    assert.equal(restored.sessions.find(r => r.id === a2.id).libraryState, 'trashed');
    await batch('unarchive', [a.id], [b2.id]);
  });

  await step('permanent batch deletion cascades every selected Session child and preserves other content', async () => {
    await batch('trash', [a.id, c.id], [b2.id, d1.id]);
    await unchangedAfterRejection(() => batch('delete', [c.id], [b2.id, b1.id]), /回收站/);
    const deleted = await batch('delete', [a.id, c.id], [a1.id, a2.id, b2.id, d1.id]);
    assert.ok(!deleted.sessionGroups.some(g => [a.id, c.id].includes(g.id)));
    assert.ok(deleted.sessionGroups.some(g => g.id === b.id));
    assert.equal(deleted.sessions.find(r => r.id === b1.id).libraryState, 'archived');
    for (const id of [a1.id, a2.id, b2.id, d1.id]) {
      assert.ok(!deleted.sessions.some(r => r.id === id));
      await assert.rejects(fs.stat(path.join(recordingsDir, id)), { code: 'ENOENT' });
    }
    assert.ok(deleted.sessions.some(r => r.sessionGroupId === d.id), 'unselected sibling survives individual deletion');
  });

  await step('restart preserves batch results without resurrecting deleted records', async () => {
    const before = await snapshot();
    await desktop.close();
    desktop = undefined;
    await launch();
    assert.deepEqual(await snapshot(), before);
    assert.ok((await call('getTimeline', { sessionId: b1.id })).total > 0);
  });
  assert.deepEqual(errors, []);
  const report = { status: 'passed', output, steps, rendererErrors: errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
run().catch(async error => {
  console.error(error);
  process.exitCode = 1;
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', steps, error: error.message, stack: error.stack, rendererErrors: errors }, null, 2)).catch(() => {});
}).finally(async () => {
  await desktop?.close().catch(() => {});
  await fs.writeFile(path.join(output, 'electron.log'), logs.join('')).catch(() => {});
});
