'use strict';

// NSIS is a launcher, not an Electron debugging process. Start it normally,
// then attach to Chromium CDP; do not use Playwright's _electron.launch here.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const AdmZip = require('adm-zip');

const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.env.TRACEDOCK_PORTABLE_EXECUTABLE || path.join(root, 'dist', `TraceDock-${require('../package.json').version}-Windows-x64.exe`));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = path.join(root, 'output', `portable-smoke-${stamp}`);
const output = path.join(root, 'output', 'playwright');
const children = new Set();
const logs = [];
const steps = [];
const uncaughtErrors = [];
let targets = [], guestAutomation = 'uninitialized';
let browser, ui, wrapper, sessionId, port;
let mainPort;

async function captureTargets() {
  if (!port) return;
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  assert.ok(response.ok, 'CDP target inventory is readable');
  targets = await response.json();
  await fs.writeFile(path.join(output, 'portable-targets.json'), JSON.stringify({
    contexts: browser?.contexts().map(context => context.pages().map(page => page.url())) || [], targets,
  }, null, 2));
}

async function configureExportDialog(filePath) {
  // Test-only loopback Node inspector targets the real portable main process.
  // Only the OS save dialog is stubbed; production capture/worker/export run intact.
  const response = await fetch(`http://127.0.0.1:${mainPort}/json/list`);
  const targets = await response.json();
  assert.equal(targets.length, 1, 'exactly one owned portable main inspector');
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Main inspector did not configure export dialog')), 10000);
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
        else resolve();
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `process.mainModule.require('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(filePath)} })` } }));
    });
  } finally { socket.close(); }
}

async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const value = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return value;
}

function startWrapper(args = []) {
  const env = { ...process.env, TRACEDOCK_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(`[${child.pid}] ${chunk}`));
  child.stderr?.on('data', chunk => logs.push(`[${child.pid}] ${chunk}`));
  child.once('error', error => { child.launchError = error; });
  return child;
}

async function exited(child, timeout = 20000) {
  await until(() => {
    if (child.launchError) throw child.launchError;
    return child.exitCode !== null || child.signalCode !== null;
  }, `portable wrapper ${child.pid} exits`, timeout);
  return child.exitCode;
}

async function step(label, task) {
  await task();
  steps.push(label);
  console.log(`PASS ${label}`);
}

async function state() { return ui.evaluate(() => window.collector.getState()); }

async function latestSnapshot() {
  const page = await ui.evaluate(id => window.collector.getTimeline({ sessionId: id, types: ['dom.snapshot'], limit: 1 }), sessionId);
  if (!page.events.length) return null;
  return ui.evaluate(input => window.collector.getEvent(input), { sessionId, eventId: page.events[0].id });
}

function assertDemoSnapshot(snapshot) {
  assert.ok(snapshot?.payload?.html?.includes('id="counter-increase"'), 'snapshot contains the embedded demo DOM');
  assert.ok(snapshot.payload.html.includes('id="demo-name"'));
  assert.ok(Array.isArray(snapshot.payload.forms) && snapshot.payload.forms.length > 0, 'snapshot includes live form state');
  assert.ok(snapshot.documentId, 'snapshot identifies the embedded document');
}

async function forceStopOwnedTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // Only a PID returned by this script's spawn is ever passed to taskkill.
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('exit', resolve);
    });
  } else child.kill('SIGTERM');
}

async function run() {
  await fs.access(executable);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  port = await availablePort();
  do { mainPort = await availablePort(); } while (mainPort === port);
  wrapper = startWrapper([`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${mainPort}`]);
  let guest;

  await step('NSIS launcher extracts and serves a functioning desktop UI', async () => {
    const version = await until(async () => {
      if (wrapper.launchError) throw wrapper.launchError;
      if (wrapper.exitCode !== null) throw new Error(`Wrapper exited before startup: ${wrapper.exitCode}`);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return false;
      const data = await response.json();
      return data.webSocketDebuggerUrl && data;
    }, 'portable CDP endpoint', 45000);
    // Plain CDP attach enables the Inspector domain. Electron exposes its
    // BrowserWindow before it has a renderer, which Playwright can misread as
    // a crashed target. Wait for the real app pages through the read-only HTTP
    // inventory before attaching; the app must finish startup by itself.
    await until(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return false;
      targets = await response.json();
      return targets.some(target => target.url.includes('/renderer/index.html'))
        && targets.some(target => target.url.includes('/demo/index.html'));
    }, 'portable pages finish startup before CDP attach', 45000);
    await captureTargets();
    browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 15000 });
    const observe = page => page.on('pageerror', error => uncaughtErrors.push(`${page.url()}: ${error.message}`));
    for (const context of browser.contexts()) { context.pages().forEach(observe); context.on('page', observe); }
    const pages = () => browser.contexts().flatMap(context => context.pages());
    ui = await until(() => pages().find(page => page.url().includes('/renderer/index.html')), 'portable UI page');
    await ui.locator('#start-button').waitFor({ state: 'visible' });
    await until(async () => {
      const initial = await state();
      return !initial.browser.loading && initial.browser.url.includes('/demo/index.html');
    }, 'embedded browser finishes loading');
    await captureTargets();
    guest = pages().find(page => page.url().includes('/demo/index.html')) || null;
    guestAutomation = guest ? 'playwright-page-real-input' : 'snapshot-proof-through-preload-and-ipc';
    console.log(`INFO embedded-browser validation: ${guestAutomation}`);
    if (guest) await guest.locator('#counter-increase').waitFor({ state: 'visible' });
    assert.ok(await ui.getByRole('complementary', { name: '采集会话' }).isVisible());
    const initial = await state();
    assert.equal(initial.session, null, 'portable app must have its own empty test profile');
    assert.equal(initial.browser.error, null);
    if (guest) assert.equal(await guest.evaluate(() => typeof window.collector), 'undefined');
  });

  await step('portable UI starts recording and captures the embedded DOM and form baseline', async () => {
    await ui.locator('#start-button').click();
    await ui.locator('#session-name-input').fill('便携版验证 · 临时目录与采集');
    await ui.locator('#confirm-session-button').click();
    const session = await until(async () => {
      const value = (await state()).session;
      return value?.status === 'recording' && value.snapshotCount > 0 && value;
    }, 'portable recording baseline');
    sessionId = session.id;
    if (guest) {
      await guest.locator('#demo-name').fill('Portable 原始输入');
      await guest.locator('#counter-increase').click();
    }
    await ui.evaluate(() => window.collector.snapshot());
    assertDemoSnapshot(await latestSnapshot());
    const events = await ui.evaluate(id => window.collector.getTimeline({ sessionId: id, limit: 500 }), sessionId);
    for (const type of guest ? ['action.click', 'action.input', 'dom.mutation', 'dom.snapshot'] : ['dom.snapshot']) assert.ok(events.events.some(event => event.type === type), type);
    if (guest) assert.ok(events.events.some(event => event.payload?.form?.value === 'Portable 原始输入'));
  });

  await step('a second portable launch exits without deleting the running app resources', async () => {
    const before = (await state()).session;
    const originalURL = ui.url();
    const second = startWrapper();
    assert.equal(await exited(second, 30000), 0, 'second wrapper exits after single-instance handoff');
    assert.equal((await state()).session.status, 'recording');
    assert.equal(ui.url(), originalURL);
    if (guest) {
      const oldCount = Number(await guest.locator('#counter-value').innerText());
      await guest.locator('#counter-increase').click();
      assert.equal(Number(await guest.locator('#counter-value').innerText()), oldCount + 1);
    }
    await ui.evaluate(() => window.collector.snapshot());
    assertDemoSnapshot(await latestSnapshot());
    assert.ok((await state()).session.eventCount > before.eventCount);
    // Reload from the original extraction path after the second wrapper cleanup.
    // This specifically catches wrappers deleting each other's runtime assets.
    const beforeDocument = (await latestSnapshot()).documentId;
    await ui.evaluate(() => window.collector.reload());
    await until(async () => {
      const fresh = await latestSnapshot();
      return fresh && fresh.documentId !== beforeDocument && fresh;
    }, 'reload establishes a new captured document from the original extraction directory');
    if (guest) {
      await guest.locator('#counter-increase').waitFor({ state: 'visible' });
      await guest.locator('#counter-increase').click();
    }
    await ui.evaluate(() => window.collector.snapshot());
    assertDemoSnapshot(await latestSnapshot());
  });

  await step('portable session stops cleanly with a complete persisted timeline', async () => {
    await ui.locator('#stop-button').click();
    const session = await until(async () => {
      const value = (await state()).session;
      return value?.status === 'stopped' && value;
    }, 'portable stop');
    const filename = path.join(dataDir, 'recordings', sessionId, 'timeline.jsonl');
    const events = (await fs.readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.length, session.eventCount);
    assert.deepEqual(events.map(event => event.seq), events.map((_event, index) => index + 1));
    assert.equal(events.at(-1).type, 'session.stop');
    assert.ok(events.every(event => !['recorder.error', 'session.interrupted'].includes(event.type)), 'no recording gaps or spurious recovery');
    assert.deepEqual(uncaughtErrors, []);
    if (guest) await guest.screenshot({ path: path.join(output, 'portable-browser.png') });
  });

  await step('portable ASAR worker exports a default delta ZIP with a functioning bundled restorer', async () => {
    const zipPath = path.join(dataDir, 'portable-delta.zip');
    await configureExportDialog(zipPath);
    const result = await ui.evaluate(id => window.collector.exportSession(id), sessionId);
    assert.equal(result.canceled, false);
    assert.equal(result.encoding, 'delta');
    assert.equal(result.compression, 'deflate');
    const zip = new AdmZip(zipPath);
    const script = path.join(dataDir, 'restore.py');
    await fs.writeFile(script, zip.readFile('restore.py'));
    const restored = path.join(dataDir, 'restored');
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.TRACEDOCK_PYTHON || 'python', [script, zipPath, '--output', restored], { windowsHide: true });
      let diagnostics = '';
      child.stdout.on('data', chunk => { diagnostics += chunk; });
      child.stderr.on('data', chunk => { diagnostics += chunk; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Portable restore failed (${code}): ${diagnostics}`)));
    });
    assert.deepEqual(await fs.readFile(path.join(restored, 'timeline.jsonl')), await fs.readFile(path.join(dataDir, 'recordings', sessionId, 'timeline.jsonl')));
  });

  await step('closing the desktop window exits the portable wrapper normally', async () => {
    await ui.close();
    assert.equal(await exited(wrapper, 20000), 0);
  });

  const result = { passed: true, executable, dataDir, port, sessionId, steps, uncaughtErrors, guestAutomation, targetInventory: path.join(output, 'portable-targets.json'), browserScreenshot: guest ? path.join(output, 'portable-browser.png') : null };
  await fs.writeFile(path.join(output, 'portable-summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

run().catch(async error => {
  console.error(error.stack || error);
  await fs.mkdir(output, { recursive: true });
  await captureTargets().catch(diagnostic => logs.push(`Target inventory failed: ${diagnostic.message}\n`));
  await fs.writeFile(path.join(output, 'portable-summary.json'), JSON.stringify({ passed: false, executable, dataDir, port, sessionId, steps, uncaughtErrors, guestAutomation, targets, message: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  if (ui && !ui.isClosed()) await ui.close().catch(() => {});
  for (const child of children) await forceStopOwnedTree(child);
  if (browser) await browser.close().catch(() => {});
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'portable-electron.log'), logs.join(''));
});
