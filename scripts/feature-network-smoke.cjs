'use strict';

// Real desktop acceptance for network / console capture: launches Electron,
// records a local page that issues fetches, logs and throws, then drives the
// timeline filters and details panel and saves window screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { _electron: electron } = require('playwright-core');
const AdmZip = require('adm-zip');

const root = path.resolve(__dirname, '..');
const executablePath = process.env.TRACEDOCK_EXECUTABLE ? path.resolve(process.env.TRACEDOCK_EXECUTABLE) : require('electron');
const executableArgs = process.env.TRACEDOCK_EXECUTABLE ? [] : [root];
const screens = path.join(root, 'output', 'screens');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = path.join(root, 'output', `feature-network-data-${runId}`);
const zipPath = path.join(root, 'output', 'playwright', `feature-network-${runId}.zip`);
const logs = [], errors = [], steps = [];
const pendingResponses = new Map();
let desktop, server, sameSiteServer;

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>网络采集验证</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#1e293b}button{margin:4px 6px 4px 0;padding:6px 12px}pre{background:#f1f5f9;padding:8px;min-height:40px}</style></head>
<body><h1>网络与控制台采集</h1>
<button id="do-fetch">获取 JSON</button><button id="do-post">提交 JSON</button><button id="do-fail">请求 500</button><button id="do-console">console.error</button><button id="do-throw">抛出异常</button>
<pre id="out"></pre>
<script>
const out = document.getElementById('out');
document.getElementById('do-fetch').onclick = async () => { const r = await fetch('/api/data?page=1'); out.textContent = JSON.stringify(await r.json()); };
document.getElementById('do-post').onclick = async () => { const r = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trace': 'feature-smoke' }, body: JSON.stringify({ sku: 'A-1', qty: 2 }) }); out.textContent = await r.text(); };
document.getElementById('do-fail').onclick = async () => { const r = await fetch('/api/fail'); out.textContent = r.status + ' ' + await r.text(); };
document.getElementById('do-console').onclick = () => { console.error('feature smoke console error', { code: 42 }); console.log('plain log %s', 'value'); };
document.getElementById('do-throw').onclick = () => { setTimeout(() => { throw new Error('feature smoke thrown error'); }); };
</script></body></html>`;

function handler(request, response) {
  if (request.url.startsWith('/api/deferred/')) {
    const key = request.url.slice('/api/deferred/'.length);
    pendingResponses.set(key, response);
    response.once('close', () => pendingResponses.delete(key));
    return;
  }
  if (request.url.startsWith('/frame-fixture')) {
    response.writeHead(200, { 'content-type': 'text/html' });
    return response.end(`<input><button>Run</button>
      <script>console.info('frame-loaded');document.querySelector('button').onclick=()=>{
        console.warn('frame-click');
        const source = location.search || 'outer';
        fetch('/api/frame?frame=1',{method:'POST',headers:{'content-type':'application/json','x-frame-source':source},
          body:JSON.stringify({source})});
      }</script>`);
  }
  if (request.url === '/api/frame?frame=1') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(201, { 'content-type': 'application/json', 'x-frame-reply': request.headers['x-frame-source'] });
      response.end(JSON.stringify({ received: JSON.parse(body).source }));
    });
    return;
  }
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return response.end(PAGE);
  }
  if (request.url.startsWith('/api/data')) {
    response.writeHead(200, { 'content-type': 'application/json', 'x-server': 'feature-smoke' });
    return response.end(JSON.stringify({ items: [{ id: 1, name: '苹果' }, { id: 2, name: '香蕉' }], total: 2 }));
  }
  if (request.url === '/api/orders') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ created: true, echo: JSON.parse(body) }));
    });
    return;
  }
  if (request.url === '/api/fail') {
    response.writeHead(500, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ error: 'database unavailable', code: 'E_DB' }));
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
}

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
  const observe = page => { if (page.url().includes('/renderer/')) page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`)); };
  instance.context().pages().forEach(observe);
  instance.context().on('page', observe);
  return instance;
}
const appPage = (instance, fragment) => until(() => instance.context().pages().find(page => page.url().includes(fragment)), `page ${fragment}`);
const state = ui => ui.evaluate(() => window.collector.getState());
async function beginDeferred(guest, key) {
  await guest.evaluate(key => {
    window.pendingFetches ??= {};
    window.pendingFetches[key] = fetch(`/api/deferred/${key}`).then(response => response.text());
  }, key);
  await until(() => pendingResponses.has(key), `server receives ${key}`);
}
async function releaseDeferred(guest, key, redirect = false) {
  const response = pendingResponses.get(key);
  assert.ok(response, `pending response for ${key}`);
  response.writeHead(redirect ? 302 : 200, redirect
    ? { location: `/api/data?from=${key}` }
    : { 'content-type': 'text/plain' });
  response.end(key);
  await guest.evaluate(key => window.pendingFetches[key], key);
}
async function sentinel(ui, guest, sessionId, key) {
  await guest.evaluate(key => fetch(`/api/data?sentinel=${key}`).then(response => response.text()), key);
  await until(async () => (await allEvents(ui, sessionId, ['network.response']))
    .some(event => event.payload?.url.endsWith(`?sentinel=${key}`)), `capture ${key} sentinel`);
}
async function allEvents(ui, sessionId, types) {
  const result = [];
  let offset = 0;
  for (;;) {
    const page = await ui.evaluate(input => window.collector.getTimeline(input), { sessionId, offset, limit: 500, ...(types ? { types } : {}) });
    result.push(...page.events);
    offset += page.events.length;
    if (offset >= page.total || !page.events.length) return result;
  }
}
async function screenshot(instance, name) {
  const base64 = await instance.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().includes('/renderer/'));
    return (await window.capturePage()).toPNG().toString('base64');
  });
  const file = path.join(screens, name);
  await fs.writeFile(file, Buffer.from(base64, 'base64'));
  return file;
}

// Scroll the details panel so the given section heading is at the top.
const revealDetail = (ui, heading) => ui.evaluate(text => {
  const pre = document.getElementById('detail-json'), node = pre.firstChild, at = node?.textContent?.indexOf(text) ?? -1;
  if (at < 0) return false;
  const range = document.createRange();
  range.setStart(node, at); range.setEnd(node, at + 1);
  pre.scrollTop += range.getBoundingClientRect().top - pre.getBoundingClientRect().top - 6;
  return true;
}, heading);

async function run() {
  await fs.mkdir(screens, { recursive: true });
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  sameSiteServer = http.createServer(handler);
  await new Promise((resolve, reject) => { sameSiteServer.once('error', reject); sameSiteServer.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  desktop = await launch();
  const ui = await appPage(desktop, '/renderer/index.html');
  const guest = await appPage(desktop, '/demo/index.html');
  await ui.waitForFunction(() => Boolean(window.collector));
  await guest.waitForLoadState('load');
  await ui.waitForFunction(async () => !(await window.collector.getState()).browser.loading);
  let sessionId;
  let nestedRequestId, nestedResponseId;

  await step('start recording and open the local fixture page', async () => {
    await ui.locator('#new-session-button').click();
    await ui.locator('#management-name').fill('网络采集验证');
    await ui.locator('#management-confirm').click();
    await ui.locator('#management-dialog').waitFor({ state: 'hidden' });
    // Requests before recording must not be stored.
    await ui.evaluate(target => window.collector.navigate(target), url);
    await guest.waitForURL(url);
    await guest.waitForLoadState('load');
    await guest.locator('#do-fetch').click();
    await guest.locator('#out').filter({ hasText: '苹果' }).waitFor();
    await ui.locator('#start-button').click();
    await ui.locator('#session-name-input').fill('网络 · 控制台 · 异常');
    await ui.locator('#confirm-session-button').click();
    const session = await until(async () => { const s = (await state(ui)).session; return s?.status === 'recording' && s; }, 'recording starts');
    sessionId = session.id;
    await until(async () => (await state(ui)).session.snapshotCount > 0, 'initial snapshot');
    const early = await allEvents(ui, sessionId, ['network', 'console']);
    assert.equal(early.length, 0, 'nothing captured before recording');
    // Reload so the main Document request is part of the recording.
    await ui.evaluate(() => window.collector.reload());
    await guest.waitForLoadState('load');
    await until(async () => (await allEvents(ui, sessionId, ['network.response'])).some(e => e.payload?.resourceType === 'Document'), 'document response recorded');
  });

  await step('fetch, POST, 500, console.error and thrown error are recorded', async () => {
    await guest.locator('#do-fetch').click();
    await guest.locator('#out').filter({ hasText: '苹果' }).waitFor();
    await guest.locator('#do-post').click();
    await guest.locator('#out').filter({ hasText: 'created' }).waitFor();
    await guest.locator('#do-fail').click();
    await guest.locator('#out').filter({ hasText: '500' }).waitFor();
    await guest.locator('#do-console').click();
    await guest.locator('#do-throw').click();
    const events = await until(async () => {
      const list = await allEvents(ui, sessionId, ['network', 'console']);
      return list.some(e => e.type === 'console.exception') && list.some(e => e.type === 'network.response' && e.payload?.status === 500) && list;
    }, 'network and console events');
    const byType = type => events.filter(e => e.type === type);
    const ok = byType('network.response').find(e => e.payload.url.includes('/api/data'));
    assert.ok(ok, 'JSON fetch response');
    assert.equal(ok.payload.status, 200);
    assert.equal(ok.payload.method, 'GET');
    assert.equal(ok.payload.resourceType, 'Fetch');
    assert.match(ok.summary, /^GET 200 \/api\/data\?page=1 \d+ms$/);
    const full = await ui.evaluate(input => window.collector.getEvent(input), { sessionId, eventId: ok.id });
    assert.ok(full.payload.body, full.payload.bodyOmitted);
    assert.equal(JSON.parse(full.payload.body.text).items[0].name, '苹果');
    assert.equal(full.payload.responseHeaders['x-server'], 'feature-smoke');
    const post = await ui.evaluate(input => window.collector.getEvent(input), { sessionId, eventId: byType('network.request').find(e => e.payload.url.endsWith('/api/orders')).id });
    assert.equal(post.payload.method, 'POST');
    assert.deepEqual(JSON.parse(post.payload.postData.text), { sku: 'A-1', qty: 2 });
    assert.equal(post.payload.requestHeaders['x-trace'], 'feature-smoke');
    const failed = byType('network.response').find(e => e.payload.status === 500);
    assert.match(failed.summary, /^GET 500 \/api\/fail/);
    assert.ok(byType('network.request').some(e => e.payload.requestId === failed.payload.requestId), 'request and response correlate by requestId');
    const error = byType('console.message').find(e => e.payload.level === 'error');
    assert.match(error.payload.text, /feature smoke console error \{code: 42\}/);
    assert.ok(byType('console.message').some(e => e.payload.text === 'plain log value'));
    const exception = byType('console.exception')[0];
    assert.match(exception.payload.text, /Error: feature smoke thrown error/);
    assert.ok(exception.payload.line > 0);
    assert.ok(!events.some(e => /tracedock|__tracedock/i.test(String(e.payload?.text ?? ''))), 'no TraceDock internal logs');
  });

  await step('cross-site iframe actions, network and console survive navigation and pause', async () => {
    const frameUrl = url.replace('127.0.0.1', 'localhost') + 'frame-fixture';
    await guest.evaluate(src => {
      const frame = document.createElement('iframe');
      frame.id = 'cross-site';
      frame.src = src;
      document.body.append(frame);
    }, frameUrl);
    const frame = guest.frameLocator('#cross-site');
    async function interact() {
      await frame.locator('input').fill('fixture');
      await frame.locator('button').click();
    }
    const frameEvents = async () => (await allEvents(ui, sessionId)).sort((a, b) => a.seq - b.seq).filter(event =>
      event.type === 'action.frame' || event.payload?.text === 'frame-click' ||
      event.payload?.text === 'frame-loaded' || event.payload?.url?.endsWith('?frame=1'));
    async function checkClicks(expected, source) {
      return until(async () => {
        const events = await frameEvents();
        const actions = events.filter(e => e.type === 'action.frame' && e.payload.action === 'click');
        const responses = events.filter(e => e.type === 'network.response');
        const logs = events.filter(e => e.payload.text === 'frame-click');
        if ([actions, responses, logs].some(list => list.length < expected)) return false;
        for (const list of [actions, responses, logs]) assert.equal(list.length, expected);
        const id = actions.at(-1).payload.frameId;
        assert.ok(id);
        assert.equal(responses.at(-1).payload.frameId, id);
        assert.equal(logs.at(-1).payload.frameId, id);
        const response = responses.at(-1);
        const request = events.find(e => e.type === 'network.request' && e.payload.requestId === response.payload.requestId);
        assert.equal(request.payload.frameId, id);
        const get = e => ui.evaluate(input => window.collector.getEvent(input), { sessionId, eventId: e.id });
        const sent = (await get(request)).payload, received = (await get(response)).payload;
        assert.equal(sent.requestHeaders['x-frame-source'], source);
        assert.deepEqual(JSON.parse(sent.postData.text), {source});
        assert.equal(received.responseHeaders['x-frame-reply'], source);
        assert.deepEqual(JSON.parse(received.body.text), {received: source});
        if (source === '?nested') {
          nestedRequestId = request.id;
          nestedResponseId = response.id;
        }
        assert.ok(events.some(e => e.type === 'action.frame' && e.payload.action === 'input'));
        assert.ok(events.some(e => e.payload.text === 'frame-loaded'));
        return true;
      }, `cross-site click, response and console x${expected}`);
    }
    await interact();
    await checkClicks(1, 'outer');
    const documentEvents = (await allEvents(ui, sessionId)).filter(e => e.payload?.url === frameUrl);
    const initialRequest = documentEvents.find(e => e.type === 'network.request');
    const initialResponse = documentEvents.find(e => e.type === 'network.response');
    assert.ok(initialRequest && initialResponse, 'initial document navigation completed across process swap');
    assert.equal(initialResponse.payload.requestId, initialRequest.payload.requestId);
    const doc = await ui.evaluate(input => window.collector.getEvent(input), { sessionId, eventId: initialResponse.id });
    assert.match(doc.payload.body?.text ?? doc.payload.bodyOmitted, /<button>Run<\/button>/);
    await ui.evaluate(() => window.collector.pauseSession());
    await interact();
    await ui.evaluate(() => window.collector.resumeSession());
    await guest.locator('#cross-site').evaluate((el, src) => { el.src = src; }, frameUrl + '?navigation');
    await until(() => guest.frames().some(f => f.url().endsWith('?navigation')), 'iframe navigates');
    await interact();
    await checkClicks(2, '?navigation');
    // A -> B -> A requires recursively attaching a new nested target.
    await frame.locator('body').evaluate((el, src) => {
      const nested = document.createElement('iframe');
      nested.id = 'nested';
      nested.src = src;
      el.append(nested);
    }, url + 'frame-fixture?nested');
    const nested = frame.frameLocator('#nested');
    await nested.locator('input').fill('nested fixture');
    await nested.locator('button').click();
    await checkClicks(3, '?nested');
    const clicks = (await frameEvents()).filter(e => e.type === 'action.frame' && e.payload.action === 'click');
    assert.notEqual(clicks[0].payload.frameId, clicks[2].payload.frameId);
    await guest.locator('#cross-site').evaluate(el => el.remove());
  });

  await step('same-site cross-origin iframe is captured and same-origin clicks stay single', async () => {
    for (const [port, crossOrigin] of [[sameSiteServer.address().port, true], [server.address().port, false]]) {
      const before = Math.max(...(await allEvents(ui, sessionId)).map(e => e.seq));
      await guest.evaluate(port => {
        const frame = document.createElement('iframe');
        frame.id = 'port-frame';
        frame.src = `http://127.0.0.1:${port}/frame-fixture`;
        document.body.append(frame);
      }, port);
      await guest.frameLocator('#port-frame').locator('button').click();
      await until(async () => {
        const added = (await allEvents(ui, sessionId)).filter(e => e.seq > before);
        const actions = added.filter(e => e.type === 'action.click' || (e.type === 'action.frame' && e.payload.action === 'click'));
        if (!added.some(e => e.payload?.text === 'frame-click') || !actions.length) return false;
        assert.deepEqual(actions.map(e => e.type), [crossOrigin ? 'action.frame' : 'action.click']);
        return true;
      }, `one click per frame, crossOrigin=${crossOrigin}`);
      await guest.locator('#port-frame').evaluate(el => el.remove());
    }
  });

  await step('pause excludes network and console events', async () => {
    await beginDeferred(guest, 'before-pause');
    await until(async () => (await allEvents(ui, sessionId, ['network.request']))
      .some(event => event.payload?.url.endsWith('/before-pause')), 'request stored before pause');
    await ui.locator('#pause-button').click();
    await until(async () => (await state(ui)).session.status === 'paused', 'paused');
    const before = (await allEvents(ui, sessionId, ['network', 'console'])).length;
    await guest.locator('#do-fetch').click();
    await guest.locator('#do-console').click();
    await beginDeferred(guest, 'during-pause');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal((await allEvents(ui, sessionId, ['network', 'console'])).length, before);
    await ui.locator('#pause-button').click();
    await until(async () => (await state(ui)).session.status === 'recording', 'resumed');
    await releaseDeferred(guest, 'before-pause', true);
    await releaseDeferred(guest, 'during-pause');
    await sentinel(ui, guest, sessionId, 'after-resume');
    const after = await allEvents(ui, sessionId, ['network', 'console']);
    assert.equal(after.filter(event => event.payload?.url?.includes('before-pause')).length, 1, 'only the original pre-pause request remains');
    assert.ok(!after.some(event => event.payload?.url?.includes('during-pause')), 'paused requests cannot finish into the resumed interval');
  });

  await step('「网络」filter, highlighted failure and detail panel', async () => {
    await ui.locator('[data-filter="network"]').click();
    await until(async () => {
      const seqs = await ui.locator('#timeline-list .event-seq').allInnerTexts();
      return seqs.length > 0 && seqs.every(text => / · network\./.test(text));
    }, 'network-only timeline');
    const failedRow = ui.locator('#timeline-list .timeline-event.issue', { hasText: 'GET 500' }).first();
    await failedRow.waitFor();
    assert.match(await failedRow.locator('.event-name').innerText(), /网络响应/);
    await screenshot(desktop, 'feature-network-timeline.png');
    await ui.locator(`#timeline-list [data-event-id="${nestedRequestId}"]`).click();
    await until(async () => {
      const text = await ui.locator('#detail-json').innerText();
      return text.includes('x-frame-source: ?nested') && text.includes('── 请求体') && text.includes('"source"');
    }, 'iframe request headers and upload in detail panel');
    await ui.locator(`#timeline-list [data-event-id="${nestedResponseId}"]`).click();
    await until(async () => {
      const text = await ui.locator('#detail-json').innerText();
      return text.includes('x-frame-reply: ?nested') && text.includes('── 响应体') && text.includes('"received"');
    }, 'iframe response headers and body in detail panel');
    await ui.locator('#timeline-list .timeline-event', { hasText: 'GET 200 /api/data' }).first().click();
    await until(async () => /── 响应体/.test(await ui.locator('#detail-json').innerText()), 'response detail');
    const detail = await ui.locator('#detail-json').innerText();
    assert.match(detail, /── 请求头/);
    assert.match(detail, /x-server: feature-smoke/);
    assert.match(detail, /"name": "苹果"/);
    await screenshot(desktop, 'feature-network-detail.png');
    assert.ok(await revealDetail(ui, '── 响应头'));
    await screenshot(desktop, 'feature-network-body.png');
    await failedRow.click();
    await until(async () => /database unavailable/.test(await ui.locator('#detail-json').innerText()), '500 detail');
    assert.ok(await revealDetail(ui, '── 响应头'));
    await screenshot(desktop, 'feature-network-failed.png');
  });

  await step('「控制台」filter shows console errors and the uncaught exception', async () => {
    await ui.locator('[data-filter="console"]').click();
    await until(async () => {
      const seqs = await ui.locator('#timeline-list .event-seq').allInnerTexts();
      return seqs.length > 0 && seqs.every(text => / · console\./.test(text));
    }, 'console-only timeline');
    const exception = ui.locator('#timeline-list .timeline-event.issue', { hasText: 'feature smoke thrown error' }).first();
    await exception.click();
    await until(async () => /错误堆栈|调用栈/.test(await ui.locator('#detail-json').innerText()), 'exception detail');
    await screenshot(desktop, 'feature-network-console.png');
  });

  await step('stop, full export lists failures in timeline.md and README mentions new types', async () => {
    await beginDeferred(guest, 'previous-recording');
    await until(async () => (await allEvents(ui, sessionId, ['network.request']))
      .some(event => event.payload?.url.endsWith('/previous-recording')), 'slow request stored before stop');
    await ui.locator('#stop-button').click();
    await until(async () => (await state(ui)).session.status === 'stopped', 'stopped');
    const all = await allEvents(ui, sessionId);
    assert.equal(new Set(all.map(e => e.seq)).size, all.length);
    await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, zipPath);
    await ui.locator('[data-filter="all"]').click();
    await ui.locator('#export-button').click();
    await ui.locator('#export-mode-full').check();
    await ui.locator('#export-confirm-button').click();
    await until(async () => { const s = await state(ui); return !s.export && s.sessions.find(x => x.id === sessionId)?.lastExportPath === zipPath; }, 'export completes', 60000);
    const archive = new AdmZip(zipPath);
    const md = archive.readAsText('timeline.md');
    const section = md.slice(md.indexOf('## 失败请求与页面错误'));
    assert.ok(md.includes('## 失败请求与页面错误'));
    assert.match(section, /network\.response \| GET 500 \/api\/fail/);
    assert.match(section, /console\.exception \| Uncaught Error: feature smoke thrown error/);
    assert.ok(!section.includes('GET 200'));
    const facts = archive.readAsText('timeline.jsonl').trim().split('\n').map(line => JSON.parse(line));
    const nestedRequest = facts.find(e => e.id === nestedRequestId).payload;
    const nestedResponse = facts.find(e => e.id === nestedResponseId).payload;
    assert.equal(nestedRequest.requestId, nestedResponse.requestId);
    assert.equal(nestedRequest.requestHeaders['x-frame-source'], '?nested');
    assert.equal(nestedResponse.responseHeaders['x-frame-reply'], '?nested');
    assert.deepEqual(JSON.parse(nestedRequest.postData.text), {source:'?nested'});
    assert.deepEqual(JSON.parse(nestedResponse.body.text), {received:'?nested'});
    const frameClick = facts.find(e => e.type === 'action.frame' && e.payload.action === 'click');
    assert.ok(frameClick?.payload.documentId);
    assert.ok(facts.some(e => e.type === 'network.response' && e.payload.frameId === frameClick.payload.frameId));
    assert.ok(facts.some(e => e.type === 'console.message' && e.payload.frameId === frameClick.payload.frameId));
    assert.match(archive.readAsText('AGENT_README.md'), /network\.request \/ network\.response \/ network\.failed/);
  });

  await step('late responses and redirects cannot move into the next recording', async () => {
    const original = await allEvents(ui, sessionId, ['network', 'console']);
    const sessionGroupId = (await state(ui)).session.sessionGroupId;
    await beginDeferred(guest, 'between-recordings');
    const next = await ui.evaluate(sessionGroupId => window.collector.startSession({ sessionGroupId, name: '网络归属 · 第二条记录' }), sessionGroupId);
    assert.notEqual(next.id, sessionId);
    await releaseDeferred(guest, 'previous-recording', true);
    await releaseDeferred(guest, 'between-recordings');
    await sentinel(ui, guest, next.id, 'next-recording');
    const events = await allEvents(ui, next.id, ['network', 'console']);
    assert.ok(!events.some(event => /previous-recording|between-recordings/.test(event.payload?.url ?? '')), 'new recording must not adopt old requests or redirect hops');
    assert.deepEqual(await allEvents(ui, sessionId, ['network', 'console']), original, 'stopped recording stays unchanged');
    await ui.evaluate(() => window.collector.stopSession());
  });

  assert.deepEqual(errors, [], 'renderer must have no uncaught JavaScript errors');
  console.log(JSON.stringify({ passed: true, steps, sessionId, screenshots: (await fs.readdir(screens)).filter(n => n.startsWith('feature-network-')).map(n => path.join(screens, n)) }, null, 2));
}

run().catch(async error => {
  console.error(error.stack || error);
  if (desktop) await screenshot(desktop, 'feature-network-failure.png').catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  if (desktop) await desktop.close().catch(() => {});
  for (const fixture of [server, sameSiteServer]) {
    if (!fixture) continue;
    fixture.closeAllConnections?.();
    await new Promise(resolve => fixture.close(resolve));
  }
  await fs.mkdir(path.join(root, 'output'), { recursive: true });
  await fs.writeFile(path.join(root, 'output', 'feature-network-electron.log'), logs.join(''));
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});
