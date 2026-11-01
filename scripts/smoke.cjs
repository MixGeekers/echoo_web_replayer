'use strict';

// Runs the actual desktop application; uses the Electron driver, not a browser mock.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { _electron: electron } = require('playwright-core');
const AdmZip = require('adm-zip');

const root = path.resolve(__dirname, '..');
const executablePath = process.env.TRACEDOCK_EXECUTABLE ? path.resolve(process.env.TRACEDOCK_EXECUTABLE) : require('electron');
const executableArgs = process.env.TRACEDOCK_EXECUTABLE ? [] : [root];
const output = path.join(root, 'output', 'playwright');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = path.join(root, 'output', `smoke-data-${runId}`);
const zipPath = path.join(output, 'smoke-session.zip');
const fullZipPath = path.join(output, 'smoke-full-session.zip');
const restoredPath = path.join(output, `restored-${runId}`);
const logs = [];
const errors = [];
const steps = [];
let desktop;
let server;

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
  steps.push(label);
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

async function appPage(instance, fragment) {
  return until(() => instance.context().pages().find(page => page.url().includes(fragment)), `page ${fragment}`);
}

async function state(ui) { return ui.evaluate(() => window.collector.getState()); }

async function allEvents(ui, sessionId) {
  const result = [];
  let offset = 0;
  while (true) {
    const page = await ui.evaluate(input => window.collector.getTimeline(input), { sessionId, offset, limit: 500 });
    result.push(...page.events);
    offset += page.events.length;
    if (offset >= page.total) return result;
    assert.ok(page.events.length, 'pagination must make progress');
  }
}

async function screenshot(instance, name) {
  const base64 = await instance.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().includes('/renderer/'));
    return (await window.capturePage()).toPNG().toString('base64');
  });
  await fs.writeFile(path.join(output, name), Buffer.from(base64, 'base64'));
}

async function run() {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  desktop = await launch();
  const ui = await appPage(desktop, '/renderer/index.html');
  const guest = await appPage(desktop, '/demo/index.html');
  await ui.waitForFunction(() => Boolean(window.collector));
  await guest.waitForLoadState('load');
  await ui.waitForFunction(async () => !(await window.collector.getState()).browser.loading);

  let sessionId;
  await step('desktop UI, isolated embedded browser and session start', async () => {
    assert.equal(await guest.evaluate(() => typeof window.collector), 'undefined', 'remote pages must not receive app APIs');
    assert.equal(await guest.evaluate(() => typeof require), 'undefined', 'remote pages must not receive Node');
    await ui.locator('#new-session-button').click();
    await ui.locator('#management-name').fill('自动验证 Session');
    await ui.locator('#management-confirm').click();
    await ui.locator('#management-dialog').waitFor({ state: 'hidden' });
    await ui.locator('#start-button').click();
    await ui.locator('#session-name-input').fill('自动验证 · 表单与 DOM');
    await ui.locator('#confirm-session-button').click();
    const session = await until(async () => {
      const current = (await state(ui)).session;
      return current?.status === 'recording' && current;
    }, 'start button begins recording');
    sessionId = session.id;
    assert.equal(session.status, 'recording');
    await until(async () => (await state(ui)).session.snapshotCount > 0, 'initial DOM baseline');
    const visibleView = await until(() => desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().includes('/renderer/'));
      const view = window.contentView.children.find(value => value.webContents?.getURL().includes('/demo/'));
      return view?.getVisible() && { bounds: view.getBounds(), contentSize: window.getContentSize() };
    }), 'native browser view becomes visible after session dialog closes');
    const placeholder = await ui.locator('#browser-surface').boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(visibleView.bounds[key] - placeholder[key]) <= 1, `native browser ${key} matches UI viewport`);
    assert.ok(visibleView.bounds.width > 300 && visibleView.bounds.height > 200, 'embedded browser has a usable viewport');
    assert.ok(visibleView.bounds.x + visibleView.bounds.width <= visibleView.contentSize[0]);
    assert.ok(visibleView.bounds.y + visibleView.bounds.height <= visibleView.contentSize[1]);
  });

  await step('a second process cannot open or rewrite the active recording store', async () => {
    const timelinePath = path.join(dataDir, 'workspace-v3', 'recordings', sessionId, 'timeline.jsonl');
    const before = await fs.readFile(timelinePath);
    const env = { ...process.env, TRACEDOCK_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    const code = await new Promise((resolve, reject) => {
      const child = spawn(executablePath, executableArgs, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => logs.push(`[second process] ${chunk}`));
      child.stderr.on('data', chunk => logs.push(`[second process] ${chunk}`));
      const timer = setTimeout(() => { child.kill(); reject(new Error('Second process did not exit within 10 seconds')); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(code, 0, 'second process should exit cleanly');
    assert.equal((await state(ui)).session.status, 'recording');
    const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'workspace-v3', 'recordings', sessionId, 'session.json'), 'utf8'));
    assert.equal(onDisk.status, 'recording', 'second process must not recover an active session as interrupted');
    const after = await fs.readFile(timelinePath);
    assert.ok(after.subarray(0, before.length).equals(before), 'previously written timeline bytes must be unchanged');
    const events = await allEvents(ui, sessionId);
    assert.ok(events.every(event => event.type !== 'session.interrupted'));
    assert.equal(new Set(events.map(event => event.seq)).size, events.length, 'sequence must remain unique');
  });

  await step('real clicks, input, checkbox and submit produce actions and DOM changes', async () => {
    await guest.locator('#demo-name').fill('TraceDock 验证');
    await guest.locator('#demo-email').fill('smoke@example.test');
    await guest.locator('#demo-password').fill('SMOKE-secret-7319');
    await guest.locator('#demo-followup').check();
    await guest.locator('#counter-increase').click();
    await guest.locator('#demo-submit').click();
    await guest.locator('#form-result[data-submitted="true"]').waitFor();
    await guest.locator('#shadow-button').click();
    await guest.frameLocator('#demo-frame').locator('#frame-input').fill('iframe 原始内容');
    await ui.evaluate(() => window.collector.snapshot());
    const events = await allEvents(ui, sessionId);
    for (const type of ['action.click', 'action.input', 'action.change', 'action.submit', 'dom.mutation', 'dom.snapshot']) {
      assert.ok(events.some(event => event.type === type), `${type} must be recorded`);
    }
    const input = events.find(event => event.type === 'action.input' && event.payload?.form?.value === 'SMOKE-secret-7319');
    assert.ok(input, 'V1 retains raw input including password values');
    assert.ok(events.some(event => event.type === 'action.click' && event.payload?.target?.selector === '#shadow-button'), 'open shadow root interaction must be captured');
    assert.ok(events.some(event => event.type === 'action.input' && event.payload?.form?.value === 'iframe 原始内容'), 'same-origin iframe interaction must be captured');
  });

  await step('pause excludes interaction; resume establishes a new baseline', async () => {
    await ui.locator('#pause-button').click();
    await until(async () => (await state(ui)).session.status === 'paused', 'pause button');
    const paused = (await state(ui)).session;
    assert.equal(paused.status, 'paused');
    await guest.locator('#counter-increase').click();
    await guest.locator('#demo-name').fill('暂停期间输入');
    // A bounded absence observation covers the recorder batching interval.
    const deadline = Date.now() + 600;
    while (Date.now() < deadline) {
      assert.equal((await state(ui)).session.eventCount, paused.eventCount, 'paused actions must not be recorded');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await ui.locator('#pause-button').click();
    await until(async () => (await state(ui)).session.status === 'recording', 'resume button');
    await until(async () => (await state(ui)).session.snapshotCount > paused.snapshotCount, 'resume DOM baseline');
    await guest.locator('#counter-increase').click();
    await ui.evaluate(() => window.collector.snapshot());
  });

  await step('real HTTP navigation, SPA transition and reload remain in one session', async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Navigation fixture</title></head><body><h1>Navigation fixture</h1><button id="route" onclick="history.pushState({}, \'\', \'#route\'); document.querySelector(\'h1\').textContent=\'Route changed\'">Change route</button></body></html>');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/`;
    await ui.evaluate(url => window.collector.navigate(url), url);
    await guest.waitForURL(url);
    await guest.locator('#route').click();
    await guest.waitForURL(`${url}#route`);
    await ui.evaluate(() => window.collector.snapshot());
    const beforeReload = await allEvents(ui, sessionId);
    const documents = new Set(beforeReload.filter(event => event.documentId).map(event => event.documentId));
    const navigation = guest.waitForEvent('domcontentloaded');
    await ui.evaluate(() => window.collector.reload());
    await navigation;
    await ui.evaluate(() => window.collector.snapshot());
    const events = await allEvents(ui, sessionId);
    assert.ok(events.some(event => event.type === 'page.navigation' && event.payload?.sameDocument), 'SPA navigation is recorded');
    assert.ok(new Set(events.filter(event => event.documentId).map(event => event.documentId)).size > documents.size, 'reload creates a new document identity');
    await ui.evaluate(() => window.collector.home());
    await guest.waitForURL(/\/demo\/index\.html$/);
    await guest.waitForLoadState('load');
  });

  await step('stop flushes final records and timeline filtering returns real data', async () => {
    await guest.locator('#counter-increase').click();
    // This synthetic burst exercises the real preload -> IPC -> disk path while
    // keeping the test fast. Earlier interactions above use actual browser input.
    await guest.evaluate(() => {
      for (let index = 0; index < 510; index++) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', bubbles: true, shiftKey: true }));
      }
    });
    await ui.locator('#stop-button').click();
    const stopped = await until(async () => {
      const current = (await state(ui)).session;
      return current.status === 'stopped' && current;
    }, 'stop button');
    assert.equal(stopped.status, 'stopped');
    const events = await allEvents(ui, sessionId);
    assert.equal(events[0].type, 'session.stop');
    assert.equal(events.length, stopped.eventCount);
    assert.equal(events.filter(event => event.type === 'recorder.error').length, 0, 'recorder must not report gaps');
    const filtered = await ui.evaluate(sessionId => window.collector.getTimeline({ sessionId, types: ['action'] }), sessionId);
    assert.ok(filtered.total > 0);
    assert.ok(filtered.events.every(event => event.type.startsWith('action.')));
    const full = await ui.evaluate(input => window.collector.getEvent(input), { sessionId, eventId: events.find(event => event.type === 'dom.snapshot').id });
    assert.ok(full.payload.html.includes('<html'));
  });

  await step('timeline UI loads past 500 events all the way to the first record', async () => {
    const total = (await state(ui)).session.eventCount;
    assert.ok(total > 500, 'pagination fixture contains over 500 events');
    await ui.locator('[data-filter="all"]').click();
    await until(async () => (await ui.locator('#timeline-list .timeline-event').count()) > 0, 'initial timeline page');
    let displayed = await ui.locator('#timeline-list .timeline-event').count();
    while (displayed < total) {
      await ui.locator('#load-more-button').click();
      displayed = await until(async () => {
        const count = await ui.locator('#timeline-list .timeline-event').count();
        return count > displayed && count;
      }, `timeline page after ${displayed} events`);
    }
    assert.equal(displayed, total, 'every persisted event can be reached through the UI');
    assert.match(await ui.locator('#timeline-list .event-seq').last().innerText(), /^#0001 · session\.start$/);
    assert.equal(await ui.locator('#load-more-button').isVisible(), false, 'load-more disappears only at the end');
  });

  await step('default export UI produces a delta ZIP whose bundled Python restores exact data', async () => {
    await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, zipPath);
    await ui.locator('#export-button').click();
    assert.equal(await ui.locator('#export-mode-delta').isChecked(), true);
    assert.equal(await ui.locator('#export-compression').isChecked(), true);
    await ui.locator('#export-confirm-button').click();
    await until(async () => {
      const current = await state(ui);
      return !current.export && current.sessions.find(s => s.id === sessionId)?.lastExportPath === zipPath;
    }, 'default delta export completes', 60000);
    const archive = new AdmZip(zipPath);
    const names = archive.getEntries().map(entry => entry.entryName);
    for (const name of ['manifest.json', 'session.json', 'data.bin', 'index.jsonl', 'files.jsonl', 'restore.py', 'AGENT_README.md']) assert.ok(names.includes(name), name);
    assert.ok(!names.includes('timeline.jsonl'), 'delta package omits a duplicate full timeline');
    const manifest = JSON.parse(archive.readAsText('manifest.json'));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.encoding, 'delta');
    assert.equal(manifest.compression, 'deflate');
    const restoreScript = path.join(output, `restore-${runId}.py`);
    await fs.writeFile(restoreScript, archive.readFile('restore.py'));
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.PYTHON || 'python', [restoreScript, zipPath, '--output', restoredPath], { windowsHide: true });
      let diagnostics = '';
      child.stdout.on('data', value => { diagnostics += value; });
      child.stderr.on('data', value => { diagnostics += value; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Restore failed (${code}): ${diagnostics}`)));
    });
    const original = await fs.readFile(path.join(dataDir, 'workspace-v3', 'recordings', sessionId, 'timeline.jsonl'));
    const restored = await fs.readFile(path.join(restoredPath, 'timeline.jsonl'));
    assert.deepEqual(restored, original, 'bundled script restores the exact persisted UTF-8 bytes');
    const events = restored.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(manifest.eventCount, events.length);
    assert.equal(manifest.eventCount, (await state(ui)).session.eventCount);
    assert.equal(manifest.redaction, false);
    assert.deepEqual(events.map(event => event.seq), events.map((_event, index) => index + 1));
    assert.ok(restored.toString('utf8').includes('SMOKE-secret-7319'));
    const snapshotFiles = await fs.readdir(path.join(restoredPath, 'snapshots'));
    assert.ok(snapshotFiles.some(name => name.endsWith('.html')));
    assert.ok(snapshotFiles.some(name => name.endsWith('.state.json')));
    assert.ok(archive.readAsText('AGENT_README.md').includes('timeline.jsonl'));
    for (const file of manifest.files) {
      const bytes = archive.readFile(file.path);
      assert.equal(bytes.length, file.bytes, `${file.path} byte count`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${file.path} checksum`);
    }
    await guest.evaluate(() => window.scrollTo(0, 0));
    await screenshot(desktop, 'smoke.png');
    await guest.screenshot({ path: path.join(output, 'smoke-browser.png') });
  });

  await step('full export and disabled ZIP compression work through the same UI', async () => {
    await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, fullZipPath);
    await ui.locator('#export-button').click();
    await ui.locator('#export-mode-full').check();
    await ui.locator('#export-compression').uncheck();
    await ui.locator('#export-confirm-button').click();
    await until(async () => {
      const current = await state(ui);
      return !current.export && current.sessions.find(s => s.id === sessionId)?.lastExportPath === fullZipPath;
    }, 'uncompressed full export completes', 60000);
    const archive = new AdmZip(fullZipPath);
    const manifest = JSON.parse(archive.readAsText('manifest.json'));
    assert.equal(manifest.encoding, 'full');
    assert.equal(manifest.compression, 'store');
    assert.ok(archive.getEntries().every(entry => entry.header.method === 0));
    assert.ok(archive.getEntry('timeline.md'));
    assert.ok(archive.getEntries().some(entry => /^snapshots\/.*\.html$/.test(entry.entryName)));
    assert.deepEqual(archive.readFile('timeline.jsonl'), await fs.readFile(path.join(restoredPath, 'timeline.jsonl')));
    await ui.locator('#export-button').click();
    assert.equal(await ui.locator('#export-mode-full').isChecked(), true, 'export preferences persist');
    assert.equal(await ui.locator('#export-compression').isChecked(), false);
    await ui.locator('#cancel-export-dialog-button').click();
  });

  await step('restart preserves completed session and original timeline', async () => {
    const count = (await state(ui)).session.eventCount;
    await desktop.close();
    desktop = await launch();
    const reopened = await appPage(desktop, '/renderer/index.html');
    await reopened.waitForFunction(() => Boolean(window.collector));
    const saved = (await state(reopened)).sessions.find(session => session.id === sessionId);
    assert.equal(saved.status, 'stopped');
    assert.equal(saved.eventCount, count);
    assert.equal((await allEvents(reopened, sessionId)).length, count);
  });

  assert.deepEqual(errors, [], 'renderer must have no uncaught JavaScript errors');
  const summary = { passed: true, executable: executablePath, steps, sessionId, dataDir, zipPath, screenshot: path.join(output, 'smoke.png'), screenshotScope: 'Shell layer only; native WebContentsView is captured separately in smoke-browser.png. Use a native window capture for a combined desktop image.', uncaughtErrors: errors };
  await fs.writeFile(path.join(output, 'smoke-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

run().catch(async error => {
  console.error(error.stack || error);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'smoke-failure.json'), JSON.stringify({ passed: false, executable: executablePath, steps, message: error.message, stack: error.stack, errors, dataDir }, null, 2));
  if (desktop) await screenshot(desktop, 'smoke-failure.png').catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  if (desktop) await desktop.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'smoke-electron.log'), logs.join(''));
});
