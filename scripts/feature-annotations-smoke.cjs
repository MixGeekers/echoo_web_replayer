'use strict';

// Real desktop acceptance for timeline bookmarks, notes and range export.
// Run with `npm run test:annotations`; on Linux use `xvfb-run -a npm run test:annotations`.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { _electron: electron } = require('playwright-core');
const AdmZip = require('adm-zip');

const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const executablePath = process.env.TRACEDOCK_EXECUTABLE ? path.resolve(process.env.TRACEDOCK_EXECUTABLE) : require('electron');
const executableArgs = process.env.TRACEDOCK_EXECUTABLE ? [] : [root];
const python = process.env.TRACEDOCK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const screens = path.join(root, 'output', 'screens');
const work = path.join(root, 'output', `feature-annotations-${runId}`);
const dataDir = path.join(work, 'data');
const zipPath = path.join(work, 'annotations.zip');
const rangeZipPath = path.join(work, 'annotations-range.zip');
const sha = value => createHash('sha256').update(value).digest('hex');
const errors = [];
const logs = [];
let desktop;

async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}
async function step(label, task) {
  await task();
  console.log(`PASS ${label}`);
}
async function launch() {
  const env = { ...process.env, TRACEDOCK_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = await electron.launch({ executablePath, args: executableArgs, cwd: root, env, timeout: 30000 });
  instance.process().stdout?.on('data', data => logs.push(data.toString()));
  instance.process().stderr?.on('data', data => logs.push(data.toString()));
  const observe = page => page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`));
  instance.context().pages().forEach(observe);
  instance.context().on('page', observe);
  return instance;
}
const appPage = (instance, fragment) => until(() => instance.context().pages().find(page => page.url().includes(fragment)), `page ${fragment}`);
const state = ui => ui.evaluate(() => window.collector.getState());
const notes = (ui, id) => ui.evaluate(sessionId => window.collector.listAnnotations(sessionId), id);
async function screenshot(name) {
  const base64 = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().includes('/renderer/'));
    return (await window.capturePage()).toPNG().toString('base64');
  });
  await fs.writeFile(path.join(screens, name), Buffer.from(base64, 'base64'));
}
function zipEntries(file) {
  const archive = new AdmZip(file);
  return new Map(archive.getEntries().filter(e => !e.isDirectory).map(e => [e.entryName, archive.readFile(e)]));
}
async function exportThroughUI(ui, id, destination, configure) {
  await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
  await ui.locator('#export-button').click();
  await ui.locator('#export-dialog').waitFor({ state: 'visible' });
  await configure?.();
  await ui.locator('#export-confirm-button').click();
  await until(async () => {
    const current = await state(ui);
    return !current.export && current.sessions.find(s => s.id === id)?.lastExportPath === destination;
  }, `export ${path.basename(destination)} completes`, 60000);
}

async function run() {
  await fs.mkdir(screens, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  desktop = await launch();
  const ui = await appPage(desktop, '/renderer/index.html');
  const guest = await appPage(desktop, '/demo/index.html');
  await ui.waitForFunction(() => Boolean(window.collector));
  await guest.waitForLoadState('load');
  await ui.waitForFunction(async () => !(await window.collector.getState()).browser.loading);
  await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().includes('/renderer/'));
    window.setContentSize(1440, 1080);
  });

  let id, marked;
  await step('recording shows a 标记 button that bookmarks the latest seq', async () => {
    await ui.locator('#new-session-button').click();
    await ui.locator('#management-name').fill('书签验收 Session');
    await ui.locator('#management-confirm').click();
    await ui.locator('#management-dialog').waitFor({ state: 'hidden' });
    assert.equal(await ui.locator('#mark-button').isHidden(), true, 'mark is hidden while idle');
    await ui.locator('#start-button').click();
    await ui.locator('#session-name-input').fill('书签验收 · 表单提交');
    await ui.locator('#confirm-session-button').click();
    const session = await until(async () => { const s = (await state(ui)).session; return s?.status === 'recording' && s.snapshotCount > 0 && s; }, 'recording starts');
    id = session.id;
    await guest.locator('#demo-name').fill('书签验证');
    await guest.locator('#demo-email').fill('mark@example.test');
    await guest.locator('#counter-increase').click();
    await until(async () => (await state(ui)).session.actionCount >= 3, 'actions are saved');
    await ui.locator('#mark-button').waitFor({ state: 'visible' });
    const before = (await state(ui)).session.lastSeq;
    await ui.locator('#mark-button').click();
    const set = await until(async () => { const value = await notes(ui, id); return value.annotations.length === 1 && value; }, 'mark is saved');
    marked = set.annotations[0];
    assert.equal(marked.text, '这里有问题');
    assert.equal(marked.author, 'user');
    assert.ok(marked.seq >= before, 'mark anchors at the latest persisted seq');
    await ui.locator(`#timeline-list .timeline-event.annotated`).first().waitFor();
    // Keyboard shortcut in the shell creates another mark at the newest seq.
    await guest.locator('#counter-increase').click();
    await until(async () => (await state(ui)).session.lastSeq > marked.seq, 'new event after mark');
    await ui.locator('#timeline-count').click();
    await ui.keyboard.press('Control+Shift+M');
    const latest = await until(async () => { const value = await notes(ui, id); return value.annotations.length === 2 && value.annotations.at(-1); }, 'shortcut mark is saved');
    await ui.locator('#toast').waitFor({ state: 'visible' });
    await ui.locator('#toast-close').click();
    await ui.locator(`#timeline-list .timeline-event.annotated .event-seq`, { hasText: `#${String(latest.seq).padStart(4, '0')}` }).waitFor();
    await screenshot('feature-annotations-1-recording-mark.png');
    await guest.locator('#demo-submit').click();
    await guest.locator('#form-result[data-submitted="true"]').waitFor();
    await until(async () => (await state(ui)).session.actionCount >= 5, 'submit is saved');
    await ui.locator('#stop-button').click();
    await until(async () => (await state(ui)).sessions.find(s => s.id === id)?.status === 'stopped', 'recording stops');
    assert.equal(await ui.locator('#mark-button').isHidden(), true);
  });

  let noteSeq;
  await step('details panel adds, edits and deletes a note on another event', async () => {
    await until(async () => (await ui.locator('#timeline-list .timeline-event').count()) > 5, 'timeline rows render');
    // Remove the shortcut mark through the UI later; first annotate the form-submit click.
    const row = ui.locator('#timeline-list .timeline-event:not(.annotated)', { hasText: '#demo-submit' }).first();
    await row.click();
    await ui.locator('#annotation-editor').waitFor({ state: 'visible' });
    const label = await row.locator('.event-seq').textContent();
    noteSeq = Number(/#0*(\d+)/.exec(label)[1]);
    assert.notEqual(noteSeq, marked.seq);
    await ui.locator('#annotation-text').fill('提交后没有提示，怀疑校验失败');
    await ui.locator('#annotation-save').click();
    await until(async () => (await notes(ui, id)).annotations.some(a => a.seq === noteSeq), 'note is saved');
    await ui.locator('[data-annotation-edit]').first().click();
    await ui.locator('#annotation-text').fill('提交后没有成功提示，需要检查表单校验');
    await ui.locator('#annotation-save').click();
    await until(async () => (await notes(ui, id)).annotations.find(a => a.seq === noteSeq)?.text === '提交后没有成功提示，需要检查表单校验', 'note is edited');
    const set = await notes(ui, id);
    const extra = set.annotations.find(a => a.seq !== noteSeq && a.id !== marked.id);
    // Delete the keyboard mark from its own details panel.
    await ui.locator('#bookmark-filter').click();
    await ui.locator(`#annotation-list .annotation-row[data-seq="${extra.seq}"]`).click();
    await ui.locator(`[data-annotation-delete="${extra.id}"]`).click();
    await until(async () => (await notes(ui, id)).annotations.length === 2, 'shortcut mark deleted');
    await ui.locator('#bookmark-filter').click();
    await ui.locator('#timeline-list .timeline-event', { hasText: '#demo-submit' }).first().click();
    await ui.locator('#annotation-editor .annotation-note').first().waitFor();
    await ui.locator('#toast-close').click();
    await ui.locator('#toast').waitFor({ state: 'hidden' });
    await screenshot('feature-annotations-2-note-editor.png');
  });

  await step('「书签」list shows bookmarks and jumps to events; replay seeks there', async () => {
    await ui.locator('#bookmark-filter').click();
    await ui.locator('#annotation-list .annotation-row').nth(1).waitFor();
    assert.equal(await ui.locator('#annotation-list .annotation-row').count(), 2);
    assert.equal(await ui.locator('#timeline-list').isHidden(), true);
    assert.equal((await ui.locator('#bookmark-filter .bookmark-count').textContent()).trim(), '2');
    await ui.locator(`#annotation-list .annotation-row[data-seq="${marked.seq}"]`).click();
    await until(async () => (await ui.locator('#detail-meta').textContent()).startsWith(`#${marked.seq} `), 'jump opens the bookmarked event');
    await ui.locator('#toast').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => ui.locator('#toast-close').click());
    await screenshot('feature-annotations-3-bookmark-list.png');
    await ui.locator('#replay-button').click();
    await ui.locator('#replay-panel').waitFor({ state: 'visible' });
    await until(async () => !(await ui.locator('#replay-play').isDisabled()), 'replay loads');
    await ui.locator(`#annotation-list .annotation-row[data-seq="${noteSeq}"]`).click();
    await until(async () => /提交|submit/i.test(await ui.locator('#replay-event-label').textContent()) || (await ui.locator('#detail-meta').textContent()).startsWith(`#${noteSeq} `), 'replay seeks to bookmark');
    await until(async () => (await ui.locator('#detail-meta').textContent()).startsWith(`#${noteSeq} `), 'detail follows bookmark');
    await new Promise(resolve => setTimeout(resolve, 800));
    await screenshot('feature-annotations-4-replay-bookmark.png');
    await ui.locator('#replay-close').click();
    await ui.locator('#bookmark-filter').click();
  });

  await step('exported ZIP contains checksummed annotations.json and restore.py verifies it', async () => {
    await exportThroughUI(ui, id, zipPath);
    const entries = zipEntries(zipPath);
    const manifest = JSON.parse(entries.get('manifest.json'));
    assert.deepEqual(manifest.annotations, { path: 'annotations.json', count: 2 });
    const exported = JSON.parse(entries.get('annotations.json'));
    assert.deepEqual(exported.annotations.map(a => a.seq).sort((a, b) => a - b), [marked.seq, noteSeq].sort((a, b) => a - b));
    const listed = entries.get('files.jsonl').toString().trim().split('\n').map(JSON.parse).find(item => item.path === 'annotations.json');
    assert.equal(listed.sha256, sha(entries.get('annotations.json')));
    assert.match(entries.get('AGENT_README.md').toString(), /人工标注（优先阅读）[\s\S]*提交后没有成功提示/);
    const restored = path.join(work, 'restored');
    const { stdout } = await exec(python, [path.join(root, 'out', 'restore.py'), zipPath, '--output', restored], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(JSON.parse(stdout).annotations, 2);
    assert.deepEqual(await fs.readFile(path.join(restored, 'annotations.json')), entries.get('annotations.json'));
    assert.match(await fs.readFile(path.join(restored, 'timeline.md'), 'utf8'), /## 人工标注/);
    const original = await fs.readFile(path.join(dataDir, 'workspace-v3', 'recordings', id, 'timeline.jsonl'));
    assert.deepEqual(await fs.readFile(path.join(restored, 'timeline.jsonl')), original, 'timeline facts unchanged by notes');
  });

  await step('range export from one bookmark to another', async () => {
    const [first, second] = (await notes(ui, id)).annotations;
    await exportThroughUI(ui, id, rangeZipPath, async () => {
      await ui.locator('#export-range-slice').check();
      await ui.locator('#export-range-start-bookmark').selectOption(first.id);
      await ui.locator('#export-range-end-bookmark').selectOption(second.id);
      assert.equal(await ui.locator('#export-range-start').inputValue(), String(first.seq));
      assert.equal(await ui.locator('#export-range-end').inputValue(), String(second.seq));
      await screenshot('feature-annotations-5-export-range.png');
    });
    const entries = zipEntries(rangeZipPath);
    const manifest = JSON.parse(entries.get('manifest.json'));
    assert.equal(manifest.range.requestedStartSeq, first.seq);
    assert.equal(manifest.range.endSeq, second.seq);
    assert.ok(manifest.range.startSeq <= first.seq);
    assert.equal(manifest.lastSeq, second.seq);
    assert.equal(JSON.parse(entries.get('annotations.json')).annotations.length, 2);
    const { stdout } = await exec(python, [path.join(root, 'out', 'restore.py'), rangeZipPath, '--output', path.join(work, 'restored-range')], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(JSON.parse(stdout).range.endSeq, second.seq);
    // The next export dialog starts at the whole recording again.
    await ui.locator('#export-button').click();
    assert.equal(await ui.locator('#export-range-all').isChecked(), true);
    await ui.locator('#cancel-export-dialog-button').click();
  });

  assert.deepEqual(errors, [], 'renderer pages must not throw');
  await desktop.close();
  desktop = null;
  console.log(`Screenshots: ${screens}`);
}

run().catch(async error => {
  console.error(error);
  if (logs.length) console.error(logs.join('').slice(-4000));
  if (errors.length) console.error(errors.join('\n'));
  try { if (desktop) await screenshot('feature-annotations-failure.png'); } catch {}
  process.exitCode = 1;
}).finally(async () => {
  await desktop?.close().catch(() => {});
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, 'electron.log'), logs.join(''));
});
