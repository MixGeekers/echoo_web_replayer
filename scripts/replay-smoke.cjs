'use strict';

// End-to-end regression: the origin server is closed before any replay assertions.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');

async function run() {
  const output = path.join(root, 'output', `replay-smoke-${Date.now()}`);
  await fs.mkdir(output, { recursive: true });
  let font;
  for (const filename of ['/System/Library/Fonts/SFNSRounded.ttf', 'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']) {
    try { font = await fs.readFile(filename); break; } catch {}
  }
  let requestCount = 0, desktop;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Offline Replay</title><link rel="stylesheet" href="/css/main.css"></head><body>
    <header><img id="logo" src="/img/logo.svg"><small>ECHOO / REPLAY</small><h1>A website, remembered.</h1><p id="subtitle">样式、图像和字体，随会话一起保存。</p></header>
    <main><label>记录一条想法 <input id="note"></label><button id="add">添加</button><output id="count">0</output><ul id="items"></ul><section id="end">滚动也被记录。</section></main>
    <img hidden src="/missing.png"><script>window.executions=1;let count=0;document.querySelector('#add').onclick=()=>{document.querySelector('#count').textContent=++count;const li=document.createElement('li');li.textContent=document.querySelector('#note').value;document.querySelector('#items').append(li);if(count===1){const image=document.createElement('img');image.id='thumbnail';image.srcset='/img/logo.svg 1x';document.querySelector('main').append(image)}};</script></body></html>`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" rx="15" fill="#2563eb"/><path d="m22 16 22 14-22 14z" fill="white"/></svg>';
  const routes = {
    '/': ['text/html; charset=utf-8', html],
    '/css/main.css': ['text/css', `@import './theme.css';${font ? '@font-face{font-family:ReplayTest;src:url(../font.ttf)}' : ''} body{margin:0;background:#f4f7fc;color:#15253b;font-family:ReplayTest,sans-serif}header{padding:36px;background:#e4edff url(../img/background.svg) right center/220px no-repeat}h1{font-size:40px}small{display:block;margin-top:12px}main{padding:36px}input,button{padding:12px;border:1px solid #b3c5e0;border-radius:6px;font:inherit}button{background:#2563eb;color:white;margin:0 12px}output{font-size:28px}#end{margin-top:650px;padding:24px;background:#e4edff}`],
    '/css/theme.css': ['text/css', '#subtitle{color:rgb(37,99,235)}li{padding:12px;border-bottom:1px solid #c7d5eb}'],
    '/img/logo.svg': ['image/svg+xml', svg],
    '/img/background.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><circle cx="120" cy="110" r="75" fill="none" stroke="#aec6ff" stroke-width="18"/></svg>'],
    ...(font ? { '/font.ttf': ['font/ttf', font] } : {}),
  };
  const server = http.createServer((request, response) => {
    requestCount++; const route = routes[request.url];
    response.writeHead(route ? 200 : 404, { 'Content-Type': route?.[0] || 'text/plain' }); response.end(route?.[1] || 'missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const env = { ...process.env, TRACEDOCK_DATA_DIR: path.join(output, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: process.env.TRACEDOCK_EXECUTABLE || require('electron'), args: process.env.TRACEDOCK_EXECUTABLE ? [] : [root], cwd: root, env });
    const ui = desktop.context().pages().find(page => page.url().includes('/renderer/')) || await desktop.waitForEvent('window', { predicate: page => page.url().includes('/renderer/') });
    assert.ok(ui, 'desktop shell exists');
    await ui.waitForLoadState('domcontentloaded');
    // The main process opens the demo after the shell loads. Let that startup
    // navigation finish before the test asks it to open the fixture website.
    await ui.waitForFunction(async () => {
      if (!window.collector) return false;
      const state = await window.collector.getState();
      return !state.browser.loading && state.browser.url.includes('/demo/index.html');
    });
    const guest = desktop.context().pages().find(page => page !== ui);
    assert.ok(guest, 'browser guest exists');
    const errors = []; ui.on('pageerror', error => errors.push(error.message));
    await ui.locator('#address-input').fill(origin); await ui.locator('#address-form').press('Enter');
    await guest.waitForURL(`${origin}/`);
    await guest.waitForFunction(() => document.querySelector('#logo')?.naturalWidth === 60);
    if (font) await guest.evaluate(() => document.fonts.load('16px ReplayTest'));
    await ui.locator('#new-session-button').click();
    await ui.locator('#management-name').fill('离线回放 Session');
    await ui.locator('#management-confirm').click();
    await ui.locator('#management-dialog').waitFor({ state: 'hidden' });
    await ui.locator('#start-button').click(); await ui.locator('#session-name-input').fill('离线回放验收'); await ui.locator('#confirm-session-button').click();
    await ui.waitForFunction(async () => (await window.collector.getState()).session?.snapshotCount > 0);
    await guest.locator('#note').fill('资源已经保存'); await guest.locator('#add').click();
    // A real recorded idle interval makes play/pause and speed behavior observable.
    await guest.waitForTimeout(1000);
    await guest.locator('#note').fill('原网站关闭后继续回放'); await guest.locator('#add').click();
    await guest.locator('#end').scrollIntoViewIfNeeded(); await guest.waitForTimeout(180);
    await ui.locator('#stop-button').click();
    await ui.waitForFunction(async () => (await window.collector.getState()).session.status === 'stopped');
    const state = await ui.evaluate(() => window.collector.getState());
    const events = (await ui.evaluate(sessionId => window.collector.getTimeline({ sessionId, limit: 200 }), state.session.id)).events;
    const resourceStatus = await ui.evaluate(sessionId => window.collector.replayResources({ sessionId }), state.session.id);
    assert.equal(resourceStatus.saved, font ? 5 : 4); assert.equal(resourceStatus.missing, 1); assert.deepEqual(resourceStatus.missingURLs, [`${origin}/missing.png`]);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); const beforeReplay = requestCount;
    await ui.locator('#replay-button').click();
    await ui.waitForFunction(() => !document.querySelector('#replay-play').disabled && document.querySelector('#replay-frame').contentDocument.querySelector('#logo')?.naturalWidth === 60);
    const style = await ui.evaluate(async hasFont => {
      const doc = document.querySelector('#replay-frame').contentDocument;
      if (hasFont) await doc.fonts.load('16px ReplayTest');
      return { color: doc.defaultView.getComputedStyle(doc.querySelector('#subtitle')).color,
        background: doc.defaultView.getComputedStyle(doc.querySelector('header')).backgroundImage,
        font: !hasFont || doc.fonts.check('16px ReplayTest'), scripts: doc.querySelectorAll('script').length,
        executed: doc.defaultView.executions, count: doc.querySelector('#count').textContent };
    }, Boolean(font));
    assert.equal(style.color, 'rgb(37, 99, 235)'); assert.match(style.background, /tracedock-resource:/);
    assert.equal(style.font, true); assert.equal(style.scripts, 0); assert.equal(style.executed, undefined); assert.equal(style.count, '0');
    await ui.locator('#replay-play').click();
    await ui.waitForFunction(() => Number(document.querySelector('#replay-progress').value) > 100);
    await ui.locator('#replay-play').click(); await ui.waitForFunction(() => document.querySelector('#replay-play').textContent === '播放');
    const paused = await ui.locator('#replay-progress').inputValue(); await ui.waitForTimeout(120);
    assert.equal(await ui.locator('#replay-progress').inputValue(), paused);
    const mutation = events.find(event => event.type === 'dom.mutation');
    await ui.locator('.timeline-event').filter({ hasText: `#${String(mutation.seq).padStart(4, '0')}` }).click();
    await ui.waitForFunction(() => !document.querySelector('#replay-play').disabled && document.querySelector('#replay-frame').contentDocument.querySelector('#count')?.textContent === '2');
    assert.equal(await ui.evaluate(() => document.querySelector('#replay-frame').contentDocument.querySelector('#items').children.length), 2);
    await ui.waitForFunction(() => document.querySelector('#replay-frame').contentDocument.querySelector('#thumbnail')?.naturalWidth === 60);
    await ui.locator('#replay-progress').focus(); await ui.locator('#replay-progress').press('End');
    await ui.waitForFunction(() => document.querySelector('#replay-play').textContent === '重新播放');
    await ui.waitForFunction(() => document.querySelector('#replay-frame').contentDocument.defaultView.scrollY > 0);
    await ui.locator('#replay-progress').press('Home'); await ui.locator('#replay-restart').click(); await ui.waitForTimeout(150);
    await ui.waitForFunction(() => !document.querySelector('#replay-play').disabled && document.querySelector('#replay-message').hidden);
    assert.equal(await ui.evaluate(() => document.querySelector('#replay-frame').contentDocument.querySelector('#count').textContent), '0');
    for (const speed of ['0.5', '1', '2', '4', '8']) await ui.locator('#replay-speed').selectOption(speed);
    await ui.locator('#replay-play').click(); await ui.waitForFunction(() => document.querySelector('#replay-play').textContent === '重新播放');
    await ui.locator('#replay-restart').click(); await ui.waitForFunction(() => !document.querySelector('#replay-play').disabled && document.querySelector('#replay-message').hidden);
    await ui.locator('#close-detail-button').click(); if (await ui.locator('#toast-close').isVisible()) await ui.locator('#toast-close').click();
    const screenshot = await desktop.evaluate(async ({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; const [width, height] = win.getContentSize(); return (await win.capturePage()).resize({ width, height }).toPNG(); });
    await fs.writeFile(path.join(output, 'offline-replay.png'), Buffer.from(screenshot));
    assert.equal(requestCount, beforeReplay); assert.deepEqual(errors, []);
    await ui.locator('#replay-close').click(); assert.equal(await ui.locator('#replay-panel').isHidden(), true);
    const report = { status: 'passed', originClosed: true, extraOriginRequests: requestCount - beforeReplay, resources: resourceStatus, fontTested: Boolean(font), rendererErrors: errors, output };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await desktop?.close(); server.closeAllConnections(); server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
