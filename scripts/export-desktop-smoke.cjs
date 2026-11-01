'use strict';
// An isolated Electron acceptance check: long exports must not serialize controls.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', `export-desktop-${Date.now()}`);
const profile = path.join(output, 'profile');
const historyId = 'large-history';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(30); }
  throw new Error(`Timed out: ${description}`);
}
async function fixture() {
  const workspace = path.join(profile, 'workspace-v3');
  const { SessionGroupStore } = require('../out/session-group-store.cjs');
  const groups = await new SessionGroupStore(workspace).init();
  const group = await groups.create('后台导出验收 Session', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' });
  const directory = path.join(workspace, 'recordings', historyId);
  await fs.mkdir(directory, { recursive: true });
  const date = new Date().toISOString();
  const html = '<html><body>' + '<div>中文😀恢复一致性</div>'.repeat(90000) + '</body></html>';
  const metadata = { id: historyId, name: '后台导出验收 · 合成大记录', status: 'stopped', startedAt: date, updatedAt: date, endedAt: date, url: 'https://example.test/', eventCount: 128, actionCount: 0, mutationCount: 0, snapshotCount: 128, lastSeq: 128, lastElapsedMs: 127, schemaVersion: 3, sessionGroupId:group.id, profileId:'profile-00000000-0000-4000-8000-000000000001', profileName:'测试环境', libraryState:'active', archivedAt:null, trashedAt:null, trashOrigin:null };
  const handle = await fs.open(path.join(directory, 'timeline.jsonl'), 'w');
  try {
    for (let i = 1; i <= 128; i++) {
      await handle.write(`${JSON.stringify({ id: `${historyId}:${String(i).padStart(8, '0')}`, sessionId: historyId, seq: i, type: 'dom.snapshot', timestamp: date, receivedAt: date, title: '导出验收', elapsedMs: i - 1, documentId: 'document', url: metadata.url, summary: 'DOM 快照 · test', payload: { reason: 'test', html, forms: [{ value: `原值-${i}` }], tree: {}, frames: [], shadowRoots: [], coverage: { mainDocument: true } } })}\n`);
    }
  } finally { await handle.close(); }
  await fs.writeFile(path.join(directory, 'session.json'), JSON.stringify(metadata));
}
(async () => {
  await fixture();
  const env = { ...process.env, TRACEDOCK_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.TRACEDOCK_EXECUTABLE || require('electron');
  const app = await _electron.launch({ executablePath, args: process.env.TRACEDOCK_EXECUTABLE ? [] : [root], env, timeout: 120000 });
  try {
    const ui = await until(() => app.context().pages().find(p => p.url().includes('/renderer/index.html')), 'shell', 120000);
    await ui.waitForFunction(() => Boolean(window.collector));
    await ui.waitForFunction(async () => { const state = await window.collector.getState(); return !state.browser.loading && state.browser.url.includes('/demo/index.html'); });
    await ui.evaluate(async () => {
      const initial = await window.collector.getState();
      const created = await window.collector.createSessionGroup({ profileId: initial.activeProfileId, name: '导出期间继续录制 Session' });
      const group = created.sessionGroups.find(value => value.profileId === initial.activeProfileId);
      return window.collector.startSession({ sessionGroupId: group.id, name: '导出期间继续录制' });
    });
    const destination = path.join(output, 'preserved.zip');
    await fs.writeFile(destination, 'existing destination');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    // Attach a handler immediately; no unhandled rejection if cancellation wins.
    const pending = ui.evaluate(sessionId => window.collector.exportSession({ sessionId, encoding: 'full', compression: 'deflate' }), historyId).then(value => ({ value }), error => ({ error }));
    await until(async () => ['encode', 'archive'].includes((await ui.evaluate(() => window.collector.getState())).export?.phase), 'worker processes large recording');
    const start = Date.now();
    const paused = await ui.evaluate(() => window.collector.pauseSession());
    const pauseMs = Date.now() - start;
    assert.equal(paused.status, 'paused');
    assert.ok((await ui.evaluate(() => window.collector.getState())).export, 'pause completes before long export does');
    assert.ok(pauseMs < 4000, `recording pause stays responsive (${pauseMs}ms)`);
    await ui.evaluate(() => window.collector.cancelExport());
    const canceled = await pending;
    if (canceled.error) throw canceled.error;
    assert.equal(canceled.value.canceled, true);
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing destination');
    const artifacts = await fs.readdir(output);
    assert.ok(!artifacts.some(name => name.startsWith('.tracedock-export-') || name.endsWith('.tmp')));
    const resumed = await ui.evaluate(() => window.collector.resumeSession());
    assert.equal(resumed.status, 'recording');
    await ui.evaluate(() => window.collector.stopSession());
    const summary = { passed: true, pauseMs, sourceBytes: (await fs.stat(path.join(profile, 'workspace-v3', 'recordings', historyId, 'timeline.jsonl'))).size, profile, checks: ['pause during worker export', 'cancel preserves existing destination', 'temporary files removed', 'recording resumes after cancel'] };
    await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
