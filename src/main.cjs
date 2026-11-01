const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { SessionStore } = require('./session-store.cjs');
const { exportSession } = require('./exporter.cjs');
const { ResourceRecorder } = require('./resource-recorder.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'tracedock-resource', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

app.setName('TraceDock');
if (process.env.TRACEDOCK_DATA_DIR) app.setPath('userData', path.resolve(process.env.TRACEDOCK_DATA_DIR));
const demoURL = pathToFileURL(path.join(__dirname, 'demo', 'index.html')).href;
let win, browser, store, resources, activeId = null, closing = false;
let commandQueue = Promise.resolve();
let broadcastTimer;
let activeExport = null;
const pendingCommands = new Map();
const browserState = { url: demoURL, title: '交互实验室', loading: false, canGoBack: false, canGoForward: false, error: null };

function currentSession() { return activeId ? store.getSession(activeId) : null; }
function recordingState() { const s = currentSession(); return { recording: s?.status === 'recording', sessionId: s?.id || null }; }
function state() { return { browser: { ...browserState }, session: currentSession(), sessions: store.list(), export: activeExport ? { ...activeExport.progress } : null }; }
function notify() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.send('collector:state', state());
  }, 60);
}
function reportError(error) {
  const message = error?.message || String(error);
  console.error('[TraceDock]', message);
  if (win && !win.isDestroyed()) win.webContents.send('collector:error', message);
}
function serialize(fn) {
  const operation = commandQueue.then(fn);
  commandQueue = operation.catch(() => {});
  return operation;
}
async function append(type, payload = {}, extra = {}) {
  if (!activeId) return;
  const event = await store.append(activeId, {
    type, timestamp: new Date().toISOString(), url: browserState.url,
    title: browserState.title, payload, ...extra,
  });
  if (win && !win.isDestroyed()) {
    win.webContents.send('collector:event', { id: event.id, seq: event.seq, type: event.type, timestamp: event.timestamp, elapsedMs: event.elapsedMs, sessionId: activeId });
  }
  notify();
  return event;
}
function sendRecorderState() {
  if (browser && !browser.webContents.isDestroyed()) browser.webContents.send('recorder:state', recordingState());
}
async function recorderCommand(command, reason) {
  if (!browser || browser.webContents.isDestroyed()) throw new Error('浏览器尚未就绪');
  const requestId = randomUUID();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error('页面采集器未响应；页面可能正在跳转或已崩溃'));
    }, 4500);
    pendingCommands.set(requestId, {
      resolve: () => { clearTimeout(timeout); resolve(); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    browser.webContents.send('recorder:command', { command, reason, requestId });
  });
  await store.flush();
}
async function checkpoint(command, reason) {
  try { await recorderCommand(command, reason); return true; }
  catch (error) {
    await append('recorder.error', { message: error.message, command, reason, possibleGap: true });
    reportError(error);
    return false;
  }
}
function normalizeURL(input) {
  const raw = String(input || '').trim();
  if (raw === demoURL || raw === 'tracedock://demo' || raw === 'demo') return demoURL;
  if (!raw) throw new Error('请输入网址');
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]+:\d+(\/|$)/.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error('网址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('支持 http:// 和 https:// 网址');
  return url.href;
}
async function navigate(input) {
  const url = normalizeURL(input);
  browserState.error = null;
  browserState.url = url;
  notify();
  // Navigation resolves after the load. Return promptly so a slow site cannot lock the controls.
  browser.webContents.loadURL(url).catch(error => {
    if (error.code !== 'ERR_ABORTED') { browserState.error = error.message; notify(); }
  });
  return { url };
}
async function startSession(name) {
  const current = currentSession();
  if (current && ['recording', 'paused'].includes(current.status)) throw new Error('请先结束当前会话');
  const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 160) : `采集会话 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  const session = await store.create(label, browserState.url);
  activeId = session.id;
  await append('session.start', { name: label, appVersion: app.getVersion(), redaction: false });
  await resources.start(activeId);
  sendRecorderState();
  await checkpoint('flush', 'start');
  notify();
  return currentSession();
}
async function pauseSession() {
  if (currentSession()?.status !== 'recording') throw new Error('当前没有正在录制的会话');
  await checkpoint('stop', 'pause');
  await resources.stop();
  await append('session.pause', { reason: 'user' });
  await store.update(activeId, { status: 'paused' });
  sendRecorderState(); notify();
  return currentSession();
}
async function resumeSession() {
  if (currentSession()?.status !== 'paused') throw new Error('当前会话未暂停');
  await store.update(activeId, { status: 'recording' });
  await append('session.resume', { reason: 'user', note: '暂停期间未采集；恢复时建立新的 DOM 基线。' });
  await resources.start(activeId);
  sendRecorderState();
  await checkpoint('flush', 'resume');
  notify(); return currentSession();
}
async function stopSession(reason = 'user') {
  const session = currentSession();
  if (!session || !['recording', 'paused'].includes(session.status)) return session;
  if (session.status === 'recording') {
    await checkpoint('snapshot', 'stop');
    await checkpoint('stop', 'stop');
  }
  await resources.stop();
  await append('session.stop', { reason });
  await store.update(activeId, { status: 'stopped', endedAt: new Date().toISOString() });
  sendRecorderState();
  await store.flush(); notify();
  return currentSession();
}
async function snapshot() {
  if (currentSession()?.status !== 'recording') throw new Error('请在录制中抓取快照');
  if (!await checkpoint('snapshot', 'manual')) throw new Error('快照未完成，详情已记录在时间线');
  return currentSession();
}
function publishExport(job, progress) {
  job.progress = { ...job.progress, ...progress, sessionId: job.sessionId };
  if (win && !win.isDestroyed()) win.webContents.send('collector:exportProgress', job.progress);
}
function canceledExport() {
  const error = new Error('导出已取消');
  error.name = 'AbortError';
  return error;
}
async function exportRecording(input, job) {
  const { sessionId, encoding, compression } = input;
  const selected = store.getSession(sessionId);
  if (!selected) throw new Error('未找到会话');
  const result = await dialog.showSaveDialog(win, {
    title: '导出 Agent 分析包',
    defaultPath: path.join(app.getPath('downloads'), `TraceDock-${sessionId}.zip`),
    filters: [{ name: 'ZIP 分析包', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  if (job.controller.signal.aborted) throw canceledExport();
  publishExport(job, { phase: 'preparing', bytesRead: 0, totalBytes: 0 });
  // Only the checkpoint and capture share the recording command queue. Encoding
  // runs in a worker after this immutable boundary so pause/stop remain usable.
  const capture = await serialize(async () => {
    if (job.controller.signal.aborted) throw canceledExport();
    if (sessionId === activeId && currentSession()?.status === 'recording') await checkpoint('snapshot', 'export');
    return store.capture(sessionId);
  });
  if (job.controller.signal.aborted) throw canceledExport();
  let lastProgressAt = 0;
  const exported = await exportSession({
    capture, sessionId, destination: result.filePath, appVersion: app.getVersion(),
    encoding, compression, signal: job.controller.signal,
    onProgress: progress => {
      const now = Date.now();
      if (progress.phase !== job.progress.phase || now - lastProgressAt >= 100 || progress.bytesRead === progress.totalBytes) {
        lastProgressAt = now;
        publishExport(job, progress);
      }
    },
  });
  await store.update(sessionId, { lastExportPath: exported.path });
  notify();
  return { canceled: false, ...exported };
}
function startExport(input) {
  if (activeExport) throw new Error('已有导出任务正在运行');
  const options = typeof input === 'string' ? { sessionId: input } : { ...input };
  options.encoding ??= 'delta';
  options.compression ??= 'deflate';
  if (!['delta', 'full'].includes(options.encoding) || !['deflate', 'store'].includes(options.compression)) throw new Error('无效的导出选项');
  store.getSession(options.sessionId);
  const job = { sessionId: options.sessionId, controller: new AbortController(), progress: { phase: 'selecting', sessionId: options.sessionId, encoding: options.encoding, compression: options.compression } };
  activeExport = job;
  job.promise = exportRecording(options, job).then(result => {
    publishExport(job, { phase: result.canceled ? 'canceled' : 'done' });
    return result;
  }, error => {
    if (job.controller.signal.aborted || error.name === 'AbortError') {
      publishExport(job, { phase: 'canceled' });
      return { canceled: true };
    }
    publishExport(job, { phase: 'error', message: error.message });
    throw error;
  }).finally(() => { if (activeExport === job) activeExport = null; notify(); });
  return job.promise;
}
function shellCaller(event) {
  // Chromium canonicalizes Windows short paths in portable extraction folders.
  // Compare its committed URL, not a separately constructed filesystem URL.
  // This WebContents only loads the bundled UI; all later navigation is blocked.
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== win.webContents.getURL()) {
    throw new Error('拒绝非应用界面的请求');
  }
}
function recorderCaller(event) {
  return browser && event.sender === browser.webContents && event.senderFrame === browser.webContents.mainFrame;
}
function installIPC() {
  const handlers = {
    getState: () => state(),
    getTimeline: input => store.timeline(input || {}),
    getEvent: input => store.getEvent(input?.sessionId, input?.eventId, { preview: input?.preview, maxBytes: input?.maxBytes }),
    replaySeek: input => store.replaySeek(input || {}),
    replayChunk: input => store.replayChunk(input || {}),
    replayResources: input => resources.summary(input?.sessionId, input?.endSeq),
    navigate, back: () => { if (browser.webContents.navigationHistory.canGoBack()) browser.webContents.navigationHistory.goBack(); },
    forward: () => { if (browser.webContents.navigationHistory.canGoForward()) browser.webContents.navigationHistory.goForward(); },
    reload: () => browser.webContents.reload(), home: () => navigate(demoURL),
    startSession: name => serialize(() => startSession(name)),
    pauseSession: () => serialize(pauseSession), resumeSession: () => serialize(resumeSession),
    stopSession: () => serialize(() => stopSession()), snapshot: () => serialize(snapshot),
    exportSession: startExport,
    cancelExport: () => { activeExport?.controller.abort(); return { canceled: Boolean(activeExport) }; },
    revealExport: id => {
      const session = store.getSession(id);
      if (!session?.lastExportPath) throw new Error('此会话尚未导出');
      shell.showItemInFolder(session.lastExportPath);
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`collector:${name}`, async (event, input) => { shellCaller(event); return handler(input); });
  }
  ipcMain.on('collector:setBrowserBounds', (event, bounds) => {
    try { shellCaller(event); } catch (error) { reportError(error); return; }
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) return;
    const [w, h] = win.getContentSize();
    const x = Math.max(0, Math.min(w, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(h, Math.round(bounds.y)));
    browser.setVisible(bounds.visible !== false && bounds.width > 0 && bounds.height > 0);
    browser.setBounds({ x, y, width: Math.max(1, Math.min(w - x, Math.round(bounds.width))), height: Math.max(1, Math.min(h - y, Math.round(bounds.height))) });
  });
  ipcMain.handle('recorder:ready', event => { if (!recorderCaller(event)) throw new Error('无效的采集器'); return recordingState(); });
  ipcMain.on('recorder:ack', (event, payload) => {
    if (!recorderCaller(event)) return;
    const pending = pendingCommands.get(payload?.requestId);
    if (pending) {
      pendingCommands.delete(payload.requestId);
      if (payload.ok === false) pending.reject(new Error(payload.error || '页面采集命令失败'));
      else pending.resolve();
    }
  });
  ipcMain.on('recorder:event', (event, envelope) => {
    if (!recorderCaller(event) || !envelope || envelope.sessionId !== activeId || currentSession()?.status !== 'recording') return;
    if (typeof envelope.type !== 'string' || !/^(action|dom|page|recorder)\.[a-zA-Z0-9_.-]+$/.test(envelope.type)) return;
    append(envelope.type, envelope.payload, {
      timestamp: envelope.timestamp, documentId: envelope.documentId, url: envelope.url, title: envelope.title,
    }).catch(reportError);
  });
}
function browserEvents() {
  const wc = browser.webContents;
  const refresh = () => {
    browserState.canGoBack = wc.navigationHistory.canGoBack();
    browserState.canGoForward = wc.navigationHistory.canGoForward();
    notify();
  };
  const record = (type, payload) => { if (currentSession()?.status === 'recording') append(type, payload).catch(reportError); };
  wc.on('did-start-loading', () => { browserState.loading = true; browserState.error = null; refresh(); });
  wc.on('did-stop-loading', () => { browserState.loading = false; refresh(); });
  wc.on('page-title-updated', (_event, title) => { browserState.title = title; refresh(); });
  wc.on('did-navigate', (_event, url, httpResponseCode) => {
    browserState.url = url; refresh(); record('page.navigation', { url, httpResponseCode, sameDocument: false });
  });
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    browserState.url = url; refresh(); record('page.navigation', { url, sameDocument: true });
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    browserState.loading = false;
    browserState.error = `页面加载失败 (${errorCode})：${errorDescription}`;
    record('page.error', { errorCode, errorDescription, url: validatedURL }); refresh();
  });
  wc.on('render-process-gone', (_event, details) => {
    browserState.loading = false; browserState.error = '页面进程已退出，请刷新页面。';
    record('recorder.error', { message: 'Browser renderer exited', ...details, possibleGap: true }); refresh();
  });
  wc.on('preload-error', (_event, _preloadPath, error) => { reportError(error); record('recorder.error', { message: error.message, possibleGap: true }); });
  wc.on('will-navigate', (event, url) => {
    try { normalizeURL(url); } catch { event.preventDefault(); reportError(new Error('已阻止不支持的页面协议')); }
  });
  wc.setWindowOpenHandler(({ url }) => {
    record('page.popup', { url, disposition: 'opened-in-current-view' });
    navigate(url).catch(reportError);
    return { action: 'deny' };
  });
  wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  wc.session.setPermissionCheckHandler(() => false);
}
async function createWindow() {
  store = new SessionStore(path.join(app.getPath('userData'), 'recordings'));
  await store.init();
  win = new BrowserWindow({
    width: 1540, height: 960, minWidth: 1100, minHeight: 720,
    title: 'TraceDock · 浏览器采集工作台', backgroundColor: '#f6f8fb',
    autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'shell-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  browser = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, 'browser-preload.cjs'), contextIsolation: true,
    nodeIntegration: false, sandbox: true, webSecurity: true, partition: 'persist:tracedock-browser',
    backgroundThrottling: false,
  } });
  win.contentView.addChildView(browser);
  installIPC();
  await browser.webContents.loadURL('about:blank');
  resources = await new ResourceRecorder(store, browser.webContents, notify).init(app.getPath('userData'));
  protocol.handle('tracedock-resource', request => resources.respond(request));
  browser.setBounds({ x: 250, y: 190, width: 800, height: 650 });
  browser.setBackgroundColor('#ffffff');
  browser.setVisible(false);
  browserEvents();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('preload-error', (_event, _path, error) => reportError(error));
  win.on('close', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    const exporting = activeExport;
    exporting?.controller.abort();
    serialize(() => stopSession('window-close')).catch(reportError).finally(async () => {
      await exporting?.promise.catch(() => {});
      await store.flush().catch(reportError);
      await resources.close().catch(reportError);
      if (browser && !browser.webContents.isDestroyed()) browser.webContents.close();
      win.destroy();
    });
  });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.show();
  await navigate(demoURL);
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(createWindow).catch(error => { dialog.showErrorBox('TraceDock 启动失败', error.stack || error.message); app.quit(); });
}
app.on('window-all-closed', () => app.quit());

