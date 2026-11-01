'use strict';

// Exercise real CDP traffic across stopped/restarted recordings and live navigation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');

function fixture() {
  const requests = [], delayed = new Map();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2563eb"/></svg>';
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.test').pathname;
    requests.push(pathname);
    if (pathname === '/late-old.svg' || pathname === '/late-old.css') {
      const entry = { response, closed: false, released: false, closedBeforeRelease: false };
      delayed.set(pathname, entry);
      response.on('close', () => { entry.closed = true; });
      // One response has already started; the other still awaits its headers.
      if (pathname.endsWith('.css')) {
        response.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' });
        response.write('body{');
      }
      return;
    }
    const page = /^\/(a|b|c)$/.exec(pathname)?.[1];
    if (page) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Resource ${page}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/${page}.css"></head><body data-page="${page}"><h1>Page ${page}</h1><img id="logo" src="/${page}.svg"></body></html>`);
    } else if (/^\/[abc]\.css$/.test(pathname)) {
      response.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' });
      response.end('body{color:rgb(37,99,235);font-family:sans-serif}');
    } else if (/^\/[abc]\.svg$/.test(pathname)) {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      response.end(svg);
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('missing');
    }
  });
  return {
    server, requests, delayed,
    release() {
      for (const [url, entry] of delayed) {
        entry.closedBeforeRelease = entry.closed;
        entry.released = true;
        if (entry.response.destroyed) continue;
        if (url.endsWith('.svg')) {
          entry.response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
          entry.response.end(svg);
        } else entry.response.end('background:white}');
      }
    },
  };
}

async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  const output = path.join(root, 'output', `resource-navigation-smoke-${Date.now()}`);
  const data = path.join(output, 'data');
  await fs.mkdir(output, { recursive: true });
  const oldOrigin = fixture(), newOrigin = fixture();
  const errors = [];
  let desktop, report = { status: 'failed', output };
  try {
    for (const { server } of [oldOrigin, newOrigin]) {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    }
    const originA = `http://127.0.0.1:${oldOrigin.server.address().port}`;
    const originB = `http://127.0.0.1:${newOrigin.server.address().port}`;
    const env = { ...process.env, TRACEDOCK_DATA_DIR: data };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({
      executablePath: process.env.TRACEDOCK_EXECUTABLE || require('electron'),
      args: process.env.TRACEDOCK_EXECUTABLE ? [] : [root], cwd: root, env,
    });
    const ui = desktop.context().pages().find(page => page.url().includes('/renderer/'))
      || await desktop.waitForEvent('window', { predicate: page => page.url().includes('/renderer/') });
    await ui.waitForLoadState('domcontentloaded');
    // Startup opens the demo after the shell is ready; it must not race the
    // test's first explicit navigation on slower Windows runners.
    await ui.waitForFunction(async () => {
      if (!window.collector) return false;
      const state = await window.collector.getState();
      return !state.browser.loading && state.browser.url.includes('/demo/index.html');
    });
    const guest = desktop.context().pages().find(page => page !== ui);
    assert.ok(guest, 'browser guest exists');
    ui.on('pageerror', error => errors.push(error.message));

    async function navigate(origin, page) {
      await ui.evaluate(url => window.collector.navigate(url), `${origin}/${page}`);
      await guest.waitForURL(`${origin}/${page}`);
      await guest.waitForFunction(expected => document.body.dataset.page === expected
        && document.querySelector('#logo')?.naturalWidth === 32
        && getComputedStyle(document.body).color === 'rgb(37, 99, 235)', page);
    }
    async function start(name) {
      const session = await ui.evaluate(async label => {
        const initial = await window.collector.getState();
        const created = await window.collector.createSessionGroup({ profileId: initial.activeProfileId, name: label });
        const group = created.sessionGroups.find(value => value.profileId === initial.activeProfileId && value.name === label);
        return window.collector.startSession({ sessionGroupId: group.id, name: label });
      }, name);
      await ui.waitForFunction(async id => {
        const state = await window.collector.getState();
        return state.session?.id === id && state.session.snapshotCount > 0;
      }, session.id);
      return session.id;
    }
    async function summary(id) {
      return ui.evaluate(sessionId => window.collector.replayResources({ sessionId }), id);
    }
    async function checkCatalog(id, expectedURLs) {
      await until(async () => (await summary(id)).saved >= expectedURLs.length, `resources for ${id}`);
      const status = await summary(id);
      const entries = (await fs.readFile(path.join(data, 'workspace-v3', 'recordings', id, 'resources.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line));
      assert.equal(status.saved, expectedURLs.length);
      assert.equal(status.missing, 0);
      assert.deepEqual(status.missingURLs, []);
      assert.equal(status.captureError, null);
      assert.equal(entries.length, expectedURLs.length, 'no stale entries or duplicate resource records');
      assert.deepEqual(entries.map(entry => entry.url).sort(), [...expectedURLs].sort());
      assert.ok(entries.every(entry => entry.status === 'saved' && /^[a-f0-9]{64}$/.test(entry.sha256)));
      for (const entry of entries) assert.equal((await fs.stat(path.join(data, 'workspace-v3', 'recordings', id, 'assets', entry.sha256))).size, entry.bytes);
      return { ...status, urls: entries.map(entry => entry.url).sort() };
    }

    await navigate(originA, 'a');
    const sessionA = await start('Resource ownership A');
    const expectedA = [`${originA}/a.css`, `${originA}/a.svg`];
    await checkCatalog(sessionA, expectedA);
    await guest.evaluate(() => {
      const image = document.createElement('img'); image.id = 'pending-image'; image.src = '/late-old.svg'; document.body.append(image);
      const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/late-old.css'; document.head.append(style);
    });
    await until(() => oldOrigin.delayed.size === 2, 'old image and stylesheet requests start');
    await ui.evaluate(() => window.collector.stopSession());

    // Both new-page assets finish before recording B starts: preserve this preroll.
    await navigate(originB, 'b');
    const sessionB = await start('Resource ownership B');
    const expectedB = [`${originB}/b.css`, `${originB}/b.svg`];
    // Chromium may cancel outgoing-document requests at navigation. Record that
    // outcome; deterministic capture tests separately force responses to arrive late.
    oldOrigin.release();
    await until(() => [...oldOrigin.delayed.values()].every(entry => entry.closed), 'old requests settle');
    const pageB = await checkCatalog(sessionB, expectedB);

    // A live recording legitimately spans pages; its prior resources must survive.
    await navigate(originB, 'c');
    await ui.evaluate(() => window.collector.snapshot());
    await ui.evaluate(() => window.collector.stopSession());
    const finalA = await checkCatalog(sessionA, expectedA);
    const finalB = await checkCatalog(sessionB, [...expectedB, `${originB}/c.css`, `${originB}/c.svg`]);
    assert.deepEqual(errors, []);
    report = {
      status: 'passed', output, sessionA, sessionB,
      stoppedSession: finalA, newSessionPreroll: pageB, recordingAcrossNavigation: finalB,
      delayedOldRequests: [...oldOrigin.delayed].map(([url, entry]) => ({
        url, released: entry.released, closed: entry.closed, closedBeforeRelease: entry.closedBeforeRelease,
      })),
      requests: { oldOrigin: oldOrigin.requests, newOrigin: newOrigin.requests }, rendererErrors: errors,
    };
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = error.stack || String(error);
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await desktop?.close();
    for (const { server } of [oldOrigin, newOrigin]) { server.closeAllConnections(); server.close(); }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
