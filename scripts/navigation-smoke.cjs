'use strict';

// Real address-bar controls and website-initiated close, with isolated user data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', `navigation-smoke-${Date.now()}`);
const dataDir = path.join(output, 'data');
const logs = [], errors = [], steps = [];
let desktop, ui, guest, origin;
const loginRequests = [];
const server = http.createServer((request, response) => {
  if (request.url === '/auth') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      loginRequests.push({ method: request.method, body, cookie: request.headers.cookie });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'result=approved; Path=/' });
      response.end(`<!doctype html><title>Approval window</title><h1>Approve sign-in</h1>
        <input id="code"><button id="approve" onclick="opener.postMessage('approved', location.origin); window.close()">Approve</button>`);
    });
    return;
  }
  if (request.url === '/redirect') {
    response.writeHead(302, { Location: '/one' }); response.end(); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><title>Navigation ${request.url}</title>
    <h1>Navigation ${request.url}</h1><a id="next" href="/two">Next page</a>
    <input id="draft" aria-label="Draft">
    <button id="close" onclick="window.open('', '_self'); window.close()">Close page</button>
    <a id="popup" href="/popup" target="_blank">Popup link</a>
    <form method="post" action="/auth" target="_blank">
      <input type="hidden" name="challenge" value="new-tab"><button id="post-tab">Open in new tab</button>
    </form>
    <form method="post" action="/auth" target="login">
      <input type="hidden" name="challenge" value="fixture">
      <button id="login" onclick="window.open('about:blank','login','popup,width=520,height=420')">Sign in</button>
    </form><output id="login-result"></output>
    <script>onmessage = e => { if (e.origin === location.origin) document.querySelector('output').textContent = e.data; };</script>`);
});
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
const state = () => ui.evaluate(() => window.collector.getState());
async function step(label, run) {
  await run(); steps.push(label); console.log(`PASS ${label}`);
}
async function currentGuest(suffix) {
  const page = await until(() => desktop.windows().find(p => p !== ui && !p.isClosed() && p.url().endsWith(suffix)), 'live embedded browser');
  page.setDefaultTimeout(10000);
  await page.waitForLoadState('load');
  await until(async () => !(await state()).browser.loading, 'navigation settles');
  return page;
}
async function navigate(route, submit = 'enter') {
  await ui.locator('#address-input').fill(origin + route);
  if (submit === 'enter') await ui.locator('#address-input').press('Enter');
  else await ui.locator('#address-form button[type="submit"]').click();
  guest = await currentGuest(route);
  assert.equal(await guest.locator('h1').textContent(), `Navigation ${route}`);
  await until(async () => await ui.locator('#address-input').inputValue() === origin + route, 'address reflects page');
}
async function startRecording(name) {
  await ui.locator('#start-button').click();
  await ui.locator('#session-name-input').fill(name);
  await ui.locator('#confirm-session-button').click();
  return until(async () => {
    const s = (await state()).session;
    return s?.name === name && s.status === 'recording' && s.snapshotCount > 0 && s;
  }, 'recording starts with baseline');
}
async function closeFromPage() {
  const old = guest, profileId = (await state()).activeProfileId;
  await old.locator('#close').click({ noWaitAfter: true });
  guest = await currentGuest('/demo/index.html');
  assert.ok(old.isClosed(), 'fixture must actually destroy the old WebContents');
  assert.notEqual(guest, old, 'workspace installs a fresh view');
  assert.equal((await state()).activeProfileId, profileId, 'recovery retains the Profile');
  assert.equal((await state()).browser.available, true);
}
async function run() {
  await fs.mkdir(dataDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, TRACEDOCK_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  desktop.process().stderr.on('data', chunk => logs.push(String(chunk)));
  ui = await until(() => desktop.windows().find(p => p.url().endsWith('/renderer/index.html')), 'shell');
  ui.setDefaultTimeout(10000);
  ui.on('pageerror', error => errors.push(error.message));
  guest = await currentGuest('/demo/index.html');

  await step('Enter, Go, back, forward, reload, home and popup navigation', async () => {
    await navigate('/one'); await navigate('/two', 'go');
    await ui.locator('#back-button').click(); await guest.waitForURL(origin + '/one');
    await ui.locator('#forward-button').click(); await guest.waitForURL(origin + '/two');
    await guest.locator('#draft').fill('reload clears this field');
    await ui.locator('#reload-button').click();
    await until(async () => await guest.locator('#draft').inputValue() === '', 'reload completes');
    const parent = guest, parentId = (await state()).activePageId;
    await guest.locator('#popup').click();
    const child = await currentGuest('/popup');
    assert.notEqual(child, parent);
    assert.equal(parent.url(), origin + '/two');
    const childId = (await state()).activePageId;
    assert.notEqual(childId, parentId);
    await ui.locator(`[data-action="close-${childId}"]`).click();
    await until(async () => child.isClosed() && (await state()).activePageId === parentId, 'opener selected');
    await ui.locator('#home-button').click(); guest = await currentGuest('/demo/index.html');
  });
  await step('invalid protocols and redirects leave the address bar usable', async () => {
    await ui.locator('#address-input').fill('ftp://invalid.test');
    await ui.locator('#address-input').press('Enter');
    await until(async () => (await ui.locator('#toast-message').textContent()).includes('支持 http'), 'invalid URL feedback');
    await ui.locator('#address-input').fill(origin + '/redirect');
    await ui.locator('#address-input').press('Enter');
    guest = await currentGuest('/one');
    await until(async () => await ui.locator('#address-input').inputValue() === origin + '/one', 'redirect updates URL');
  });
  await step('a page closing itself while idle restores navigation and Profile storage', async () => {
    await guest.evaluate(() => localStorage.setItem('navigation-test', 'retained'));
    await closeFromPage(); await navigate('/one');
    assert.equal(await guest.evaluate(() => localStorage.getItem('navigation-test')), 'retained');
  });
  await ui.locator('#new-session-button').click();
  await ui.locator('#management-name').fill('Navigation regression');
  await ui.locator('#management-confirm').click();
  await ui.locator('#management-dialog').waitFor({ state: 'hidden' });
  await step('a POST form opens a new tab and its first request is captured', async () => {
    const parentId = (await state()).activePageId;
    const recording = await startRecording('POST tab');
    await guest.locator('#post-tab').click();
    const child = await currentGuest('/auth'), childId = (await state()).activePageId;
    assert.notEqual(childId, parentId); assert.equal(guest.url(), origin + '/one');
    assert.equal(loginRequests.at(-1).body, 'challenge=new-tab');
    const list = await ui.evaluate(id => window.collector.getTimeline({ sessionId: id, types: ['network.request'] }), recording.id);
    assert.ok(list.events.some(e => e.pageId === childId && e.payload.url === origin + '/auth' && e.payload.method === 'POST'));
    await ui.locator(`[data-action="close-${childId}"]`).click();
    await until(async () => child.isClosed() && (await state()).activePageId === parentId, 'return from POST tab');
    await ui.locator('#stop-button').click();
    await until(async () => (await state()).session.status === 'stopped', 'POST recording stops');
  });
  await step('named login popup preserves POST, cookies, opener callback and a shared recording', async () => {
    const parent = guest, parentId = (await state()).activePageId;
    await parent.evaluate(() => { document.cookie = 'challenge=fixture;path=/'; });
    const recording = await startRecording('Multi-window sign-in');
    await parent.locator('#login').click();
    const popup = await currentGuest('/auth');
    const info = await state(), childId = info.activePageId;
    assert.equal(info.pages.length, 2);
    assert.equal(info.pages.find(p => p.id === childId).kind, 'window');
    assert.equal(info.pages.find(p => p.id === childId).openerId, parentId);
    const requests = loginRequests.filter(r => r.body === 'challenge=fixture');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST'); assert.match(requests[0].cookie, /challenge=fixture/);
    assert.equal(parent.url(), origin + '/one');
    await popup.locator('#code').fill('child input');
    await popup.evaluate(async () => (await fetch('/child-fetch')).text());
    await until(async () => {
      const timeline = await ui.evaluate(id => window.collector.getTimeline({ sessionId: id, types: ['network.response'] }), recording.id);
      return timeline.events.some(e => e.pageId === childId && e.payload.url.endsWith('/child-fetch'));
    }, 'child response recorded before pause');
    await ui.locator('#pause-button').click();
    await until(async () => (await state()).session.status === 'paused', 'all pages paused');
    await popup.locator('#code').fill('unrecorded edit');
    await parent.locator('#draft').fill('unrecorded parent edit');
    await ui.locator('#pause-button').click();
    await until(async () => (await state()).session.status === 'recording', 'all pages resumed');
    await popup.locator('#approve').click({ noWaitAfter: true });
    await until(async () => popup.isClosed() && (await state()).activePageId === parentId, 'popup closed and returned to opener');
    assert.equal(await parent.locator('#login-result').textContent(), 'approved');
    assert.match(await parent.evaluate(() => document.cookie), /result=approved/);
    await parent.locator('#draft').fill('back on parent');
    await ui.locator('#stop-button').click();
    await until(async () => (await state()).session?.status === 'stopped', 'recording stopped');
    const events = (await fs.readFile(path.join(dataDir, 'workspace-v3', 'recordings', recording.id, 'timeline.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    for (const [pageId, value] of [[parentId,'back on parent'], [childId,'child input']]) {
      assert.ok(events.some(e => e.pageId === pageId && e.type === 'action.input' && e.payload.form.value === value));
      assert.ok(events.some(e => e.pageId === pageId && e.type === 'dom.snapshot'));
    }
    assert.ok(events.some(e => e.pageId === childId && e.type === 'network.response' && e.payload.url.endsWith('/child-fetch')));
    const auth = events.find(e => e.pageId === childId && e.type === 'network.request' && e.payload.url.endsWith('/auth'));
    assert.equal(auth?.payload.method, 'POST');
    assert.ok(events.some(e => e.pageId === childId && e.type === 'page.close'));
    assert.equal(events.filter(e => e.type === 'session.stop').length, 1);
    assert.ok(!events.some(e => e.type === 'action.input' && e.payload.form.value.startsWith('unrecorded')));
    for (const [pageId, value] of [[childId,'child input'],[parentId,'back on parent']]) {
      const event = events.find(e => e.pageId === pageId && e.payload?.form?.value === value);
      const baseline = await ui.evaluate(q => window.collector.replaySeek(q), { sessionId: recording.id, targetSeq: event.seq });
      assert.equal(baseline.snapshot.pageId, pageId);
    }
  });
  await step('a close during recording saves events, marks the gap and ends capture', async () => {
    const recording = await startRecording('Close during recording');
    await guest.locator('#draft').fill('retained event');
    await closeFromPage();
    const saved = (await state()).sessions.find(s => s.id === recording.id);
    assert.equal(saved.status, 'stopped'); assert.ok(saved.endedAt);
    const events = (await fs.readFile(path.join(dataDir, 'workspace-v3', 'recordings', recording.id, 'timeline.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(e => e.type === 'action.input' && e.payload?.form?.value === 'retained event'));
    assert.ok(events.some(e => e.type === 'recorder.error' && e.payload.possibleGap));
    assert.equal(events.at(-1).type, 'session.stop');
    assert.equal(events.at(-1).payload.reason, 'browser-closed');
    await navigate('/one'); await navigate('/two', 'go');
    await ui.locator('#back-button').click(); await guest.waitForURL(origin + '/one');
    await ui.locator('#forward-button').click(); await guest.waitForURL(origin + '/two');
  });
  await step('paused capture is saved after a close, and new capture can start and stop', async () => {
    const paused = await startRecording('Close while paused');
    await ui.locator('#pause-button').click();
    await until(async () => (await state()).session.status === 'paused', 'capture pauses');
    await closeFromPage();
    assert.equal((await state()).sessions.find(s => s.id === paused.id).status, 'stopped');
    await navigate('/one'); const next = await startRecording('Capture after recovery');
    await ui.locator('#stop-button').click();
    await until(async () => (await state()).sessions.find(s => s.id === next.id).status === 'stopped', 'capture stops normally');
  });
  await step('manual tabs and windows record together and close with the Profile', async () => {
    const profileId = (await state()).activeProfileId;
    const parent = guest, parentId = (await state()).activePageId;
    await ui.locator('#new-tab-button').click();
    await until(async () => (await state()).pages.length === 2, 'new tab');
    await navigate('/tab');
    const tab = guest, tabId = (await state()).activePageId;
    assert.equal(parent.url(), origin + '/one');
    await ui.locator('#new-window-button').click();
    await until(async () => (await state()).pages.length === 3, 'new window');
    await navigate('/window');
    const popup = guest, windowId = (await state()).activePageId;
    const recording = await startRecording('Three existing pages');
    for (const [page,id] of [[parent,parentId],[tab,tabId],[popup,windowId]]) {
      await ui.locator(`[data-action="${id}"]`).click();
      await until(async () => (await state()).activePageId === id, 'manual select');
      await page.locator('#draft').fill('value-' + id);
    }
    await ui.locator('#close-profile-button').click();
    await ui.locator('#management-confirm').click();
    await ui.locator('#management-dialog').waitFor({ state: 'hidden' });
    await until(async () => (await state()).activeProfileId === null, 'Profile closes');
    assert.equal((await state()).browser.available, false);
    assert.deepEqual((await state()).pages, []);
    const archived = (await state()).sessions.find(s => s.id === recording.id);
    assert.equal(archived.status, 'stopped');
    const timeline = await ui.evaluate(id => window.collector.getTimeline({ sessionId: id, types: ['action.input'] }), recording.id);
    assert.deepEqual(new Set(timeline.events.map(e => e.pageId)), new Set([parentId,tabId,windowId]));
    assert.equal(desktop.windows().filter(p => p !== ui && !p.isClosed()).length, 0);
    await ui.locator(`#profile-tabs [data-profile-id="${profileId}"]`).click();
    guest = await currentGuest('/demo/index.html'); await navigate('/one');
  });
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs.join(''), /TypeError|Object has been destroyed/);
  assert.deepEqual(logs.join('').split('\n').filter(line => line.startsWith('Error occurred in handler')), [
    "Error occurred in handler for 'collector:navigate': Error: 支持 http:// 和 https:// 网址",
  ]);
  await step('application exits cleanly after recovery', async () => { await desktop.close(); desktop = null; });
}
run().then(async () => {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, steps }, null, 2));
  console.log(`Navigation smoke passed: ${output}`);
}).catch(async error => {
  console.error(error); process.exitCode = 1;
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: false, steps, error: error.stack }, null, 2));
}).finally(async () => {
  await fs.writeFile(path.join(output, 'electron.log'), logs.join(''));
  if (desktop) { const child = desktop.process(); child.kill('SIGKILL'); }
  server.closeAllConnections(); server.close();
});
