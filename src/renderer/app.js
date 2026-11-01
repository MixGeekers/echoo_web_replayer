(() => {
  'use strict';
  const icons = {
    layers:'<path d="m3 7 9-4 9 4-9 4-9-4Z"/><path d="m3 12 9 4 9-4M3 17l9 4 9-4"/>',
    help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .4c0 1.8-2.5 2-2.5 3.6M12 17h.01"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    spark:'<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z"/>',
    'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',
    'arrow-left':'<path d="M20 12H4m6-6-6 6 6 6"/>',
    database:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    record:'<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    pause:'<path d="M8 5v14M16 5v14" stroke-width="3"/>',
    play:'<path d="m8 4 12 8-12 8V4Z"/>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>',
    download:'<path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/>',
    route:'<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h9a3 3 0 0 1 0 6H7a3 3 0 0 0 0 6h9"/>',
    globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    reload:'<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>',
    external:'<path d="M14 4h6v6M20 4l-9 9M10 4H4v16h16v-6"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    camera:'<path d="M4 7h4l2-3h4l2 3h4v13H4V7Z"/><circle cx="12" cy="13" r="3"/>',
    pulse:'<path d="M2 12h5l3-7 4 14 3-7h5"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    'chevron-down':'<path d="m6 9 6 6 6-6"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    click:'<path d="m5 3 14 10-7 1-3 7L5 3Z"/><path d="m13 15 4 6"/>',
    input:'<path d="M8 4h8M12 4v16M8 20h8M5 8H3v8h2M19 8h2v8h-2"/>',
    code:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
    scroll:'<path d="M12 3v18m-4-4 4 4 4-4M8 7l4-4 4 4"/>',
    key:'<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 15h10"/>',
    document:'<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/>'
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.document}</svg>`;
  document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = svg(el.dataset.icon); });
  const $ = id => document.getElementById(id);
  const api = window.collector;
  let state = { browser: {}, session: null, sessions: [] };
  let selectedSessionId = null;
  let selectedEventId = null;
  let filter = 'all';
  let search = '';
  let events = [];
  let timelineTotal = 0;
  const timelineWindowLimit = 2000;
  let timelineInitialized = false;
  let timelineLoading = false;
  let pendingRefresh = false;
  let hasEarlierEvents = false;
  let liveCursor = 0;
  let timelineSnapshotSeq = 0;
  let follow = true;
  let refreshTimer;
  let searchTimer;
  let toastTimer;
  let requestVersion = 0;
  let sessionSignature = '';
  let busy = false;
  let exporting = false;
  let exportSessionId = null;
  let exportCancelRequested = false;
  let exportToastSessionId = null;
  let boundsFrame;
  let lastBounds = '';
  let exportOptions = { encoding: 'delta', compression: 'deflate' };
  try {
    const saved = JSON.parse(localStorage.getItem('tracedock.exportOptions') || 'null');
    if (saved && ['delta', 'full'].includes(saved.encoding) && ['deflate', 'store'].includes(saved.compression)) exportOptions = saved;
  } catch {}

  const timeFormatter = new Intl.DateTimeFormat('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
  const formatDate = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : dateFormatter.format(d); };
  const formatTime = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : timeFormatter.format(d); };
  const count = value => String(Number(value) || 0).padStart(2, '0');
  const active = () => state.session && ['recording','paused'].includes(state.session.status);
  const selectedSession = () => state.sessions.find(s => s.id === selectedSessionId) || (state.session?.id === selectedSessionId ? state.session : null);
  const statusName = value => ({ recording:'录制中', paused:'已暂停', stopped:'已结束', interrupted:'意外中断' }[value] || '就绪');
  const escapeText = (value, max = 120) => String(value ?? '').slice(0, max);

  function notify(title, message = '', error = false, sessionId = null) {
    clearTimeout(toastTimer);
    $('toast-title').textContent = title;
    $('toast-message').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast-icon').innerHTML = svg(error ? 'info' : 'check');
    $('toast-action').hidden = !sessionId;
    exportToastSessionId = sessionId;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 6500);
  }

  async function run(task) {
    try { return await task(); }
    catch (error) { notify('操作未完成', String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''), true); return undefined; }
  }

  function scheduleBounds() {
    cancelAnimationFrame(boundsFrame);
    boundsFrame = requestAnimationFrame(() => {
      const rect = $('browser-surface').getBoundingClientRect();
      const bounds = { x:Math.round(rect.x), y:Math.round(rect.y), width:Math.max(0, Math.round(rect.width)), height:Math.max(0, Math.round(rect.height)), visible:!document.querySelector('dialog[open]') && !document.hidden };
      const signature = JSON.stringify(bounds);
      if (signature === lastBounds) return;
      lastBounds = signature;
      $('viewport-size').textContent = `${bounds.width} × ${bounds.height}`;
      Promise.resolve(api?.setBrowserBounds(bounds)).catch(error => console.error('Browser layout:', error));
    });
  }

  function showDialog(dialog) {
    dialog.showModal();
    scheduleBounds();
  }

  function closeDialog(dialog) {
    dialog.close();
    scheduleBounds();
  }

  function newSession() {
    if (active() || busy) return;
    $('session-name-input').value = `浏览器采集 · ${new Intl.DateTimeFormat('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())}`;
    showDialog($('session-dialog'));
    $('session-name-input').select();
  }

  function renderSessions() {
    const sig = JSON.stringify([selectedSessionId, state.sessions.map(s => [s.id,s.name,s.status,s.startedAt])]);
    if (sig === sessionSignature) return;
    sessionSignature = sig;
    $('session-total').textContent = state.sessions.length;
    const fragment = document.createDocumentFragment();
    if (!state.sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = '暂无会话';
      fragment.append(empty);
    }
    [...state.sessions].sort((a,b) => new Date(b.startedAt)-new Date(a.startedAt)).forEach(session => {
      const button = document.createElement('button');
      button.className = `session-item${session.id === selectedSessionId ? ' selected' : ''}`;
      button.title = session.name;
      button.setAttribute('aria-pressed', String(session.id === selectedSessionId));
      const icon = document.createElement('span'); icon.className = 'session-item-icon'; icon.innerHTML = svg('document');
      const body = document.createElement('span'); body.className = 'session-item-body';
      const name = document.createElement('span'); name.className = 'session-name'; name.textContent = session.name || '未命名会话';
      const date = document.createElement('span'); date.className = 'session-date';
      const status = document.createElement('span');
      const dot = document.createElement('i'); dot.className = `session-state-dot ${session.status}`;
      status.append(dot, statusName(session.status));
      date.append(status, '·', formatDate(session.startedAt));
      body.append(name,date); button.append(icon,body);
      button.addEventListener('click', () => selectSession(session.id));
      fragment.append(button);
    });
    $('session-list').replaceChildren(fragment);
  }

  function renderDuration() {
    const session = selectedSession();
    let seconds = 0;
    if (session) seconds = Math.max(0, Math.floor(((session.endedAt ? new Date(session.endedAt).getTime() : Date.now()) - new Date(session.startedAt).getTime()) / 1000));
    if (!Number.isFinite(seconds)) seconds = 0;
    $('duration').textContent = seconds >= 3600 ? `${count(Math.floor(seconds/3600))}:${count(Math.floor(seconds/60)%60)}:${count(seconds%60)}` : `${count(Math.floor(seconds/60))}:${count(seconds%60)}`;
  }

  function renderState() {
    const session = selectedSession();
    const browser = state.browser || {};
    const currentActive = active();
    const historical = Boolean(currentActive && session && session.id !== state.session.id);
    const recording = currentActive && state.session.status === 'recording';
    const paused = currentActive && state.session.status === 'paused';
    $('recording-status').className = `recording-status${recording ? ' recording' : paused ? ' paused' : ''}`;
    $('recording-status').lastElementChild.textContent = recording ? '采集中' : paused ? '已暂停' : '就绪';
    $('recording-status').title = currentActive ? `当前录制：${state.session.name}` : '当前没有录制任务';
    $('start-button').hidden = Boolean(currentActive);
    $('start-button').disabled = busy;
    $('new-session-button').disabled = Boolean(currentActive) || busy;
    $('pause-button').hidden = !currentActive;
    $('stop-button').hidden = !currentActive;
    $('pause-button').disabled = busy;
    $('stop-button').disabled = busy;
    $('pause-button').firstElementChild.innerHTML = svg(paused ? 'play' : 'pause');
    $('pause-button').lastElementChild.textContent = paused ? '继续' : '暂停';
    $('pause-button').title = `${paused ? '继续' : '暂停'}：${state.session?.name || '当前会话'}`;
    $('stop-button').title = `结束：${state.session?.name || '当前会话'}`;
    $('export-button').disabled = !session || exporting || busy;
    $('export-button').title = session ? `导出所选会话：${session.name}` : '先选择一个会话';
    $('snapshot-button').disabled = !recording || busy || historical;
    $('snapshot-button').title = historical ? '请先选中正在录制的会话，再捕获快照' : recording ? `捕获当前页面快照 · ${state.session.name}` : '录制时可捕获当前页面快照';
    $('current-session-name').textContent = session?.name || '未开始采集';
    $('current-session-name').title = session?.name || '';
    $('current-session-subtitle').hidden = !session;
    $('current-session-subtitle').textContent = session ? (historical ? '查看历史会话 · 录制按钮控制当前采集' : `${statusName(session.status)} · ${formatDate(session.startedAt)}`) : '';
    $('current-session-subtitle').title = historical ? `当前录制：${state.session.name}；统计和导出对应所选历史会话。` : '';
    $('action-count').textContent = (session?.actionCount || 0).toLocaleString('zh-CN');
    $('mutation-count').textContent = (session?.mutationCount || 0).toLocaleString('zh-CN');
    $('snapshot-count').textContent = (session?.snapshotCount || 0).toLocaleString('zh-CN');
    $('address-input').title = [browser.title, browser.url].filter(Boolean).join('\n');
    document.querySelector('.browser-card').setAttribute('aria-label', browser.title ? `内嵌浏览器：${browser.title}` : '内嵌浏览器');
    if (document.activeElement !== $('address-input')) $('address-input').value = browser.url || '';
    $('back-button').disabled = !browser.canGoBack;
    $('forward-button').disabled = !browser.canGoForward;
    $('reload-button').classList.toggle('loading', Boolean(browser.loading));
    $('browser-error').hidden = !browser.error;
    $('browser-error-text').textContent = browser.error?.message || browser.error || '';
    $('page-status').textContent = browser.error ? '页面加载失败，可修改地址后重试' : browser.loading ? '页面加载中…' : '页面已就绪';
    $('page-status-dot').className = browser.error ? 'error' : browser.loading ? 'loading' : '';
    renderDuration();
    renderSessions();
    scheduleBounds();
  }

  function handleState(next) {
    const previousSelected = selectedSessionId;
    const previousSession = selectedSession();
    state = { browser:{}, session:null, sessions:[], ...next };
    if (!Array.isArray(state.sessions)) state.sessions = [];
    if (state.export) updateExportProgress(state.export);
    if (!selectedSessionId || !selectedSession()) selectedSessionId = state.session?.id || state.sessions[0]?.id || null;
    renderState();
    const current = selectedSession();
    if (previousSelected !== selectedSessionId) refreshTimeline(true);
    else if (follow && current?.eventCount !== previousSession?.eventCount) scheduleRefresh();
  }

  function selectSession(id) {
    if (id === selectedSessionId) return;
    selectedSessionId = id;
    selectedEventId = null;
    events = [];
    $('event-detail').hidden = true;
    renderState();
    refreshTimeline(true);
  }

  function eventPresentation(event) {
    const type = event.type || '';
    const specific = {
      'action.click':['点击元素','click','action'], 'action.dblclick':['双击元素','click','action'],
      'action.input':['输入内容','input','action'], 'action.change':['更改表单','input','action'],
      'action.keydown':['键盘操作','key','action'], 'action.submit':['提交表单','arrow-right','action'],
      'action.focus':['聚焦元素','click','action'], 'action.scroll':['滚动页面','scroll','action'],
      'dom.mutation':['DOM 变化','code','dom'], 'dom.snapshot':['页面快照','camera','snapshot'],
      'page.navigation':['页面导航','globe','page'], 'page.navigate':['页面导航','globe','page'],
      'page.lifecycle':['页面生命周期','globe','page'], 'page.error':['页面错误','info','page'],
      'session.start':['开始采集','record','session'], 'session.pause':['暂停采集','pause','session'],
      'session.resume':['继续采集','play','session'], 'session.stop':['结束采集','stop','session']
    }[type];
    if (specific) return specific;
    if (type.startsWith('page.')) return ['页面事件','globe','page'];
    if (type.startsWith('session.')) return ['会话事件','record','session'];
    if (type.startsWith('action.')) return ['用户操作','click','action'];
    return [type || '采集事件','document','session'];
  }

  function eventSummary(event) {
    if (typeof event.summary === 'string') return event.summary;
    const payload = event.payload || {};
    const target = payload.target || {};
    const selector = target.selector || payload.selector || target.tagName || target.tag || '';
    if (event.type === 'dom.mutation') return `${payload.mutations?.length ?? payload.records?.length ?? payload.count ?? '多项'} 项页面变化${payload.reason ? ` · ${payload.reason}` : ''}`;
    if (event.type === 'dom.snapshot') return `${payload.reason || '完整 DOM 快照'} · ${event.title || payload.title || event.url || ''}`;
    if (event.type?.startsWith('page.')) return payload.url || payload.name || payload.phase || payload.reason || event.url || '';
    if (event.type === 'action.keydown') return `${payload.key || payload.code || ''}${selector ? ` · ${selector}` : ''}`;
    if (event.type === 'action.input' || event.type === 'action.change') return `${selector || '表单元素'}${payload.value !== undefined ? ` → ${String(payload.value)}` : target.value !== undefined ? ` → ${String(target.value)}` : ''}`;
    return selector || payload.reason || payload.message || target.text || event.url || '';
  }

  function renderEmpty(kind) {
    const empty = document.createElement('div'); empty.className = 'timeline-empty';
    const title = document.createElement('strong'); title.textContent = kind === 'filter' ? '没有匹配的事件' : '暂无事件';
    const p = document.createElement('p'); p.textContent = kind === 'filter' ? '更换关键词或筛选条件。' : active() && selectedSessionId === state.session.id ? (state.session.status === 'paused' ? '继续采集后记录页面操作。' : '操作页面后，记录会显示在这里。') : selectedSessionId ? '此会话没有事件。' : '点击「开始采集」记录页面操作。';
    empty.append(title,p); return empty;
  }

  function renderTimeline() {
    const list = $('timeline-list');
    const previousScroll = list.scrollTop;
    const fragment = document.createDocumentFragment();
    if (!events.length) fragment.append(renderEmpty(search || filter !== 'all' ? 'filter' : 'empty'));
    events.forEach(event => {
      const [label,iconName,category] = eventPresentation(event);
      const button = document.createElement('button'); button.className = `timeline-event${event.id === selectedEventId ? ' selected' : ''}`;
      button.setAttribute('aria-label', `${label} ${formatTime(event.timestamp)} ${escapeText(eventSummary(event))}`);
      const icon = document.createElement('span'); icon.className = `event-icon ${category}`; icon.innerHTML = svg(iconName);
      const body = document.createElement('span'); body.className = 'event-body';
      const first = document.createElement('span'); first.className = 'event-first-line';
      const name = document.createElement('span'); name.className = 'event-name'; name.textContent = label;
      const time = document.createElement('span'); time.className = 'event-time'; time.textContent = formatTime(event.timestamp);
      first.append(name,time);
      const summary = document.createElement('span'); summary.className = 'event-summary'; summary.textContent = escapeText(eventSummary(event),500); summary.title = escapeText(eventSummary(event),500);
      const seq = document.createElement('span'); seq.className = 'event-seq'; seq.textContent = `#${String(event.seq ?? '').padStart(4,'0')} · ${event.type}`;
      body.append(first,summary,seq); button.append(icon,body);
      button.addEventListener('click', () => inspectEvent(event)); fragment.append(button);
    });
    list.replaceChildren(fragment);
    if (!follow || previousScroll > 10) list.scrollTop = previousScroll;
    $('timeline-count').textContent = selectedSession()?.eventCount || 0;
    $('timeline-display-count').textContent = events.length < timelineTotal ? `${events.length} / ${timelineTotal} 条` : `${timelineTotal} 条事件`;
    $('load-more-button').hidden = !hasEarlierEvents;
    $('load-more-button').disabled = timelineLoading;
    $('timeline-display-count').title = events.length >= timelineWindowLimit ? '当前保留最近查看的 2,000 条；加载更早事件会向前移动显示范围。' : '';
  }

  function timelineRequest() {
    return { sessionId:selectedSessionId, ...(filter !== 'all' ? {types:[filter]} : {}), ...(search ? {query:search} : {}) };
  }

  async function refreshTimeline(reset = false) {
    if (reset) {
      requestVersion++;
      timelineInitialized = false;
      events = [];
      timelineTotal = 0;
      liveCursor = 0;
      timelineSnapshotSeq = 0;
      hasEarlierEvents = false;
      renderTimeline();
    }
    if (timelineLoading) { pendingRefresh = true; return; }
    const version = requestVersion;
    if (!selectedSessionId) { events = []; timelineTotal = 0; renderTimeline(); return; }
    timelineLoading = true;
    const initial = !timelineInitialized;
    try {
      const result = await api.getTimeline({ ...timelineRequest(), limit: initial ? 100 : 500, ...(initial ? {} : {afterSeq:liveCursor}) });
      if (version !== requestVersion) return;
      const incoming = result.events || [];
      const merged = [...new Map([...(initial ? [] : events),...incoming].map(event => [event.id,event])).values()].sort((a,b) => b.seq-a.seq);
      events = merged.slice(0,timelineWindowLimit);
      timelineTotal = result.total || 0;
      timelineSnapshotSeq = result.snapshotSeq || timelineSnapshotSeq;
      liveCursor = initial ? result.snapshotSeq || incoming[0]?.seq || 0 : result.scannedThroughSeq ?? liveCursor;
      hasEarlierEvents = initial ? Boolean(result.hasMore) : hasEarlierEvents || merged.length > timelineWindowLimit;
      timelineInitialized = true;
      if (!initial && result.hasMore && follow) pendingRefresh = true;
      renderTimeline();
    } catch (error) { if (version === requestVersion) notify('时间线读取失败', error.message || String(error), true); }
    finally {
      timelineLoading = false;
      $('load-more-button').disabled = false;
      if (pendingRefresh) { pendingRefresh = false; scheduleRefresh(); }
    }
  }

  async function loadEarlier() {
    if (!selectedSessionId || !hasEarlierEvents || timelineLoading) return;
    const version = requestVersion;
    timelineLoading = true;
    setFollow(false);
    $('load-more-button').disabled = true;
    try {
      const page = await api.getTimeline({ ...timelineRequest(), beforeSeq:events.at(-1)?.seq, snapshotSeq:timelineSnapshotSeq, limit:100 });
      if (version !== requestVersion) return;
      const merged = [...new Map([...events,...(page.events || [])].map(event => [event.id,event])).values()].sort((a,b) => b.seq-a.seq);
      events = merged.slice(-timelineWindowLimit);
      timelineTotal = page.total || 0;
      hasEarlierEvents = Boolean(page.hasMore);
      renderTimeline();
    } catch (error) { if (version === requestVersion) notify('读取历史事件失败',error.message || String(error),true); }
    finally {
      timelineLoading = false;
      $('load-more-button').disabled = false;
      if (pendingRefresh) { pendingRefresh = false; scheduleRefresh(); }
    }
  }

  function scheduleRefresh() { if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = null; if (follow || !timelineInitialized) refreshTimeline(); }, 240); }

  function setFollow(value) {
    follow = value;
    $('follow-button').classList.toggle('selected',follow);
    $('follow-button').setAttribute('aria-pressed',String(follow));
    $('follow-button').lastChild.textContent = follow ? '实时' : '已固定';
    $('follow-button').title = follow ? '跟随最新事件' : '正在查看固定时间线，不影响录制；点击返回最新事件';
  }

  function updateExportProgress(progress) {
    if (!progress) return;
    const terminal = ['done','canceled','error'].includes(progress.phase);
    if (terminal) {
      exporting = false;
      $('export-progress').hidden = true;
      renderState();
      return;
    }
    exporting = true;
    exportSessionId = progress.sessionId || exportSessionId;
    $('export-progress').hidden = false;
    const label = {
      selecting: '选择保存位置…', preparing: '准备记录…', prepare: '准备记录…',
      encode: '整理数据', validate: '校验记录', derive: '生成阅读材料', archive: '生成 ZIP', complete: '完成校验…',
    }[progress.phase] || '正在导出…';
    const total = Number(progress.totalBytes || progress.total || 0);
    const completed = Number(progress.bytesRead ?? progress.completed ?? 0);
    const ratio = total > 0 ? Math.max(0,Math.min(1,completed/total)) : null;
    $('export-progress-label').textContent = exportCancelRequested ? '正在取消导出…' : `${label}${ratio === null ? '' : ` · ${Math.floor(ratio*100)}%`}`;
    $('export-progress-label').title = state.sessions.find(s => s.id === exportSessionId)?.name || '';
    const bar = $('export-progress-bar');
    if (ratio === null) bar.removeAttribute('value');
    else { bar.max = 1; bar.value = ratio; }
    $('cancel-export-button').disabled = exportCancelRequested || progress.phase === 'selecting' || progress.phase === 'complete';
    renderState();
  }

  async function inspectEvent(event) {
    const eventId = event.id;
    selectedEventId = eventId;
    $('event-detail').hidden = false;
    $('detail-kind').textContent = event.type;
    $('detail-title').textContent = '事件详情';
    $('detail-meta').textContent = `#${event.seq} · ${formatTime(event.timestamp)} · ${event.url || '本地会话'}`;
    $('detail-json').textContent = '正在读取事件…';
    renderTimeline();
    const full = await run(() => api.getEvent({sessionId:selectedSessionId,eventId,preview:true,maxBytes:100000}));
    if (selectedEventId !== eventId) return;
    if (full) {
      let preview = full.preview || '';
      if (!full.truncated) { try { preview = JSON.stringify(JSON.parse(preview),null,2); } catch {} }
      $('detail-json').textContent = full.truncated ? `${preview}\n\n… 仅预览前 100 KB（原事件 ${Number(full.bytes).toLocaleString()} 字节）。完整内容保留在导出包中。` : preview;
    } else $('detail-json').textContent = '无法读取该事件。';
  }

  $('start-button').addEventListener('click',newSession);
  $('new-session-button').addEventListener('click',newSession);
  $('session-form').addEventListener('submit',async event => {
    event.preventDefault();
    const name = $('session-name-input').value.trim();
    if (!name || busy) return;
    busy = true; $('confirm-session-button').disabled = true; renderState();
    const result = await run(() => api.startSession(name));
    busy = false; $('confirm-session-button').disabled = false;
    if (result !== undefined) {
      closeDialog($('session-dialog'));
      const next = await run(() => api.getState());
      if (next) { handleState(next); if (next.session?.id) selectSession(next.session.id); }
    }
    renderState();
  });
  $('cancel-session-button').addEventListener('click',() => closeDialog($('session-dialog')));
  $('pause-button').addEventListener('click',async () => {
    if (busy || !active()) return;
    busy = true; renderState();
    await run(() => state.session.status === 'paused' ? api.resumeSession() : api.pauseSession());
    busy = false; const next = await run(() => api.getState()); if (next) handleState(next); renderState(); scheduleRefresh();
  });
  $('stop-button').addEventListener('click',async () => {
    if (busy || !active()) return;
    busy = true; renderState();
    const result = await run(() => api.stopSession());
    busy = false; const next = await run(() => api.getState()); if (next) handleState(next); renderState(); scheduleRefresh();
    if (result !== undefined) notify('采集已结束','时间线已保存，可导出 ZIP 交给 Agent 分析。');
  });
  $('address-form').addEventListener('submit',event => { event.preventDefault(); const url = $('address-input').value.trim(); if (url) { $('address-input').blur(); run(() => api.navigate(url)); } });
  $('back-button').addEventListener('click',() => run(() => api.back()));
  $('forward-button').addEventListener('click',() => run(() => api.forward()));
  $('reload-button').addEventListener('click',() => run(() => api.reload()));
  $('home-button').addEventListener('click',() => run(() => api.home()));
  $('snapshot-button').addEventListener('click',async () => { const result = await run(() => api.snapshot()); if (result !== undefined) notify('已捕获页面快照','当前 DOM 与表单状态已加入时间线。'); });
  $('export-button').addEventListener('click',() => {
    if (!selectedSessionId || exporting) return;
    exportSessionId = selectedSessionId;
    $('export-session-name').textContent = selectedSession()?.name || '';
    $('export-mode-delta').checked = exportOptions.encoding === 'delta';
    $('export-mode-full').checked = exportOptions.encoding === 'full';
    $('export-compression').checked = exportOptions.compression === 'deflate';
    showDialog($('export-dialog'));
  });
  $('cancel-export-dialog-button').addEventListener('click',() => closeDialog($('export-dialog')));
  $('export-form').addEventListener('submit',async event => {
    event.preventDefault();
    if (!exportSessionId || exporting) return;
    const sessionId = exportSessionId;
    exportOptions = { encoding: $('export-mode-full').checked ? 'full' : 'delta', compression: $('export-compression').checked ? 'deflate' : 'store' };
    try { localStorage.setItem('tracedock.exportOptions', JSON.stringify(exportOptions)); } catch {}
    closeDialog($('export-dialog'));
    exportCancelRequested = false;
    updateExportProgress({sessionId,phase:'selecting'});
    const result = await run(() => api.exportSession({sessionId,...exportOptions}));
    exporting = false;
    $('export-progress').hidden = true;
    renderState();
    if (result?.canceled) notify('已取消导出', '已有文件未改变。');
    else if (result) notify('ZIP 导出成功', result.path || '数据、还原脚本和 Agent 说明已打包。', false, sessionId);
    exportCancelRequested = false;
  });
  $('cancel-export-button').addEventListener('click',async () => {
    if (!exporting || exportCancelRequested) return;
    exportCancelRequested = true;
    $('cancel-export-button').disabled = true;
    $('export-progress-label').textContent = '正在取消导出…';
    const result = await run(() => api.cancelExport());
    if (result === undefined) {
      exportCancelRequested = false;
      $('cancel-export-button').disabled = false;
    }
  });
  $('toast-action').addEventListener('click',() => { if (exportToastSessionId) run(() => api.revealExport(exportToastSessionId)); });
  $('toast-close').addEventListener('click',() => { $('toast').hidden = true; });
  $('follow-button').addEventListener('click',() => { setFollow(!follow); if (follow) { $('timeline-list').scrollTop = 0; refreshTimeline(true); } });
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click',() => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected',b === button)); $('timeline-list').scrollTop = 0; refreshTimeline(true); }));
  $('search-input').addEventListener('input',() => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { search = $('search-input').value.trim(); refreshTimeline(true); },200); });
  $('load-more-button').addEventListener('click',loadEarlier);
  $('close-detail-button').addEventListener('click',() => { selectedEventId = null; $('event-detail').hidden = true; renderTimeline(); });
  $('help-button').addEventListener('click',() => showDialog($('help-dialog')));
  for (const id of ['close-help-button','help-done-button']) $(id).addEventListener('click',() => closeDialog($('help-dialog')));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close',scheduleBounds));
  document.addEventListener('keydown',event => {
    if (event.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('search-input').focus(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l' && !document.querySelector('dialog[open]')) { event.preventDefault(); $('address-input').focus(); $('address-input').select(); }
  });
  new ResizeObserver(scheduleBounds).observe($('browser-surface'));
  window.addEventListener('resize',scheduleBounds);
  document.addEventListener('visibilitychange',scheduleBounds);
  setInterval(renderDuration,1000);
  renderState(); renderTimeline();
  if (!api) { notify('桌面环境尚未连接','请通过 TraceDock 桌面程序启动此工作台。',true); return; }
  api.onState(handleState);
  api.onEvent(event => { if (follow && (!event.sessionId || event.sessionId === selectedSessionId)) scheduleRefresh(); });
  api.onError?.(error => notify('采集器提示', error?.message || String(error), true));
  api.onExportProgress?.(updateExportProgress);
  run(async () => { handleState(await api.getState()); await refreshTimeline(); scheduleBounds(); });
})();
