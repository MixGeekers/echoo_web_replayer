'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ev = require('../out/network-events.cjs');
const { NetworkCapture } = require('../out/network-capture.cjs');
const { createIssueCollector } = require('../out/export-issues.cjs');
const { queryNetworkEvents, networkItem } = require('../out/mcp-network-query.cjs');
const { deriveFiles } = require('../out/export-derived.cjs');

test('capText cuts on UTF-8 code point boundaries and reports original size', () => {
  assert.deepEqual(ev.capText('abc', 10), { text: 'abc', bytes: 3, truncated: false });
  const cut = ev.capText('中文字', 7); // 3 bytes each
  assert.equal(cut.text, '中文');
  assert.equal(cut.bytes, 9);
  assert.equal(cut.truncated, true);
  assert.equal(ev.capText('😀x', 3).text, '');
});

test('header maps are capped per value and in total', () => {
  const big = 'v'.repeat(ev.NETWORK_LIMITS.headerValueBytes + 10);
  const one = ev.capHeaders({ 'content-type': 'application/json', 'x-big': big });
  assert.equal(one.headers['content-type'], 'application/json');
  assert.equal(one.headers['x-big'].length, ev.NETWORK_LIMITS.headerValueBytes);
  assert.equal(one.truncated, true);
  const many = {};
  for (let i = 0; i < 100; i++) many[`h${i}`] = 'x'.repeat(1000);
  const capped = ev.capHeaders(many);
  assert.ok(Object.keys(capped.headers).length < 100);
  assert.equal(capped.truncated, true);
  assert.equal(Object.getOwnPropertyDescriptor(ev.capHeaders(JSON.parse('{"__proto__":"x"}')).headers, '__proto__').value, 'x');
});

test('text-like MIME detection and body capture', () => {
  for (const mime of ['application/json', 'application/problem+json; charset=utf-8', 'text/plain', 'text/html', 'application/xml', 'application/javascript', 'image/svg+xml'])
    assert.equal(ev.isTextMime(mime), true, mime);
  for (const mime of ['image/png', 'application/octet-stream', 'font/woff2', ''])
    assert.equal(ev.isTextMime(mime), false, mime);
  assert.deepEqual(ev.captureBody({ body: '{"a":1}', base64Encoded: false }, 'application/json'), { body: { text: '{"a":1}', bytes: 7, truncated: false } });
  assert.equal(ev.captureBody({ body: Buffer.from('你好').toString('base64'), base64Encoded: true }, 'text/plain').body.text, '你好');
  assert.match(ev.captureBody({ body: 'AAAA', base64Encoded: true }, 'image/png').bodyOmitted, /非文本响应（image\/png）/);
  const large = ev.captureBody({ body: 'x'.repeat(2000) }, 'text/plain', 1000);
  assert.equal(large.body.text.length, 1000);
  assert.equal(large.body.bytes, 2000);
  assert.equal(large.body.truncated, true);
});

const requestParams = (extra = {}) => ({
  requestId: 'r1', type: 'Fetch', frameId: 'f', documentURL: 'http://127.0.0.1:9/page.html', timestamp: 100, wallTime: 1700000000,
  request: { url: 'http://127.0.0.1:9/api/x?q=1', method: 'POST', headers: { 'Content-Type': 'application/json' }, postData: '{"name":"a"}' },
  initiator: { type: 'script' }, ...extra,
});

test('request / response / failure shaping and one-line summaries', () => {
  const request = ev.shapeRequest(requestParams());
  assert.equal(request.method, 'POST');
  assert.equal(request.startedAt, new Date(1700000000000).toISOString());
  assert.deepEqual(request.postData, { text: '{"name":"a"}', bytes: 12, truncated: false });
  assert.equal(ev.networkSummary('network.request', request), 'POST /api/x?q=1');
  const response = ev.shapeResponse(request, { type: 'Fetch', response: { url: request.url, status: 200, statusText: 'OK', mimeType: 'application/json', headers: { a: 'b' }, timing: { sendStart: 1, bad: 'x' } } }, 132.04, 50);
  assert.equal(response.status, 200);
  assert.equal(response.durationMs, 132);
  assert.deepEqual(response.timing, { sendStart: 1 });
  assert.equal(ev.networkSummary('network.response', response), 'POST 200 /api/x?q=1 132ms');
  const other = ev.shapeResponse({ ...request, url: 'https://cdn.test/a.json' }, { response: { status: 500, mimeType: 'text/plain', headers: {} } }, 12000);
  assert.equal(ev.networkSummary('network.response', other), 'POST 500 cdn.test/a.json 12.0s');
  const failed = ev.shapeFailed(request, { errorText: 'net::ERR_CONNECTION_REFUSED', type: 'XHR' }, 5);
  assert.equal(failed.resourceType, 'XHR');
  assert.equal(ev.networkSummary('network.failed', failed), 'POST 失败 /api/x?q=1 · net::ERR_CONNECTION_REFUSED 5ms');
  assert.equal(ev.shapeRequest({ requestId: 1 }), null);
  assert.equal(ev.shapeRequest(requestParams({ request: { url: 'http://x/', hasPostData: true } })).postDataOmitted, '请求体未随事件提供');
});

test('issue classification works from type and summary only', () => {
  assert.equal(ev.isIssueEvent('network.response', 'GET 500 /x 3ms'), true);
  assert.equal(ev.isIssueEvent('network.response', 'GET 404 /x'), true);
  assert.equal(ev.isIssueEvent('network.response', 'GET 200 /500'), false);
  assert.equal(ev.isIssueEvent('network.failed', ''), true);
  assert.equal(ev.isIssueEvent('console.exception', ''), true);
  assert.equal(ev.isIssueEvent('console.message', '[error] boom'), false);
  assert.equal(ev.isErrorEvent('console.message', '[error] boom'), true);
  assert.equal(ev.isErrorEvent('console.message', '[log] ok'), false);
});

test('console arguments are formatted like DevTools with substitutions and previews', () => {
  const s = value => ({ type: 'string', value });
  assert.equal(ev.formatConsoleArgs([s('a %s b %d%%'), s('X'), { type: 'number', value: 4.7 }, s('tail')]), 'a X b 4% tail');
  assert.equal(ev.formatConsoleArgs([s('%cstyled'), s('color:red')]), 'styled');
  assert.equal(ev.formatConsoleArgs([{ type: 'object', subtype: 'null' }, { type: 'undefined' }, { type: 'number', unserializableValue: 'NaN' }]), 'null undefined NaN');
  assert.equal(ev.formatConsoleArgs([{ type: 'object', className: 'Object', preview: { properties: [{ name: 'a', type: 'number', value: '1' }, { name: 'b', type: 'string', value: 'x' }], overflow: false } }]), '{a: 1, b: "x"}');
  assert.equal(ev.formatConsoleArgs([{ type: 'object', subtype: 'array', preview: { subtype: 'array', properties: [{ name: '0', type: 'number', value: '1' }], overflow: true } }]), '[1, …]');
  const message = ev.shapeConsole({ type: 'warning', args: [s('slow')], stackTrace: { callFrames: [{ functionName: 'f', url: 'http://h/app.js', lineNumber: 9, columnNumber: 2 }] } });
  assert.deepEqual(message, { level: 'warn', method: 'warning', text: 'slow', url: 'http://h/app.js', line: 10, column: 3, stack: [{ functionName: 'f', url: 'http://h/app.js', line: 10, column: 3 }] });
  assert.equal(ev.networkSummary('console.message', message), '[warn] slow · h/app.js:10');
  const long = ev.shapeConsole({ type: 'error', args: [s('x'.repeat(ev.NETWORK_LIMITS.consoleTextBytes + 5))] });
  assert.equal(long.textTruncated, true);
  assert.equal(long.level, 'error');
  assert.equal(ev.shapeConsole({ type: 'assert', args: [] }).text, 'Assertion failed');
});

test('exceptions keep message, location and capped stack', () => {
  const payload = ev.shapeException({ timestamp: 1, exceptionDetails: {
    text: 'Uncaught', lineNumber: 4, columnNumber: 10, url: 'http://h/page.html',
    exception: { type: 'object', subtype: 'error', className: 'Error', description: 'Error: boom\n    at go (http://h/page.html:5:11)' },
    stackTrace: { callFrames: Array.from({ length: 40 }, (_, i) => ({ functionName: `f${i}`, url: 'http://h/page.html', lineNumber: i, columnNumber: 0 })) },
  } });
  assert.equal(payload.text, 'Error: boom');
  assert.equal(payload.kind, 'Uncaught');
  assert.equal(payload.line, 5);
  assert.equal(payload.column, 11);
  assert.match(payload.stackText, /at go/);
  assert.equal(payload.stack.length, ev.NETWORK_LIMITS.stackFrames);
  assert.equal(ev.networkSummary('console.exception', payload), 'Uncaught Error: boom · h/page.html:5');
  const rejection = ev.shapeException({ exceptionDetails: { text: 'Uncaught (in promise)', exception: { type: 'string', value: 'nope' } } });
  assert.equal(rejection.text, 'nope');
  assert.equal(rejection.kind, 'Uncaught (in promise)');
});

test('detail formatter shows headers and pretty JSON body', () => {
  const text = ev.formatNetworkDetail('network.response', {
    method: 'GET', status: 200, statusText: 'OK', url: 'http://h/api', resourceType: 'Fetch', mimeType: 'application/json', durationMs: 5,
    requestHeaders: { accept: '*/*' }, responseHeaders: { 'content-type': 'application/json' }, body: { text: '{"ok":true}', bytes: 11, truncated: false },
  });
  assert.match(text, /^GET 200 OK http:\/\/h\/api/);
  assert.match(text, /── 请求头（1）──\naccept: \*\/\*/);
  assert.match(text, /── 响应头（1）──\ncontent-type: application\/json/);
  assert.match(text, /── 响应体（11 字节）──\n\{\n {2}"ok": true\n\}/);
  assert.match(ev.formatNetworkDetail('network.response', { bodyOmitted: '非文本' }), /── 响应体 ──\n非文本/);
  assert.match(ev.formatNetworkDetail('console.exception', { kind: 'Uncaught', text: 'Error: x', stackText: 'Error: x\n at y' }), /错误堆栈/);
  assert.equal(ev.formatNetworkDetail('action.click', {}), null);
});

function fakeDebugger() {
  const debug = new EventEmitter();
  let attached = false;
  const commands = [];
  debug.attach = () => { attached = true; };
  debug.isAttached = () => attached;
  debug.detach = () => { attached = false; };
  debug.bodies = new Map();
  debug.sendCommand = async (method, params) => {
    commands.push(method);
    if (method === 'Network.getResponseBody') {
      const body = debug.bodies.get(params.requestId);
      if (body instanceof Error) throw body;
      return body ?? { body: '', base64Encoded: false };
    }
    if (method === 'Network.getRequestPostData') return { postData: 'late=1' };
    return {};
  };
  debug.commands = commands;
  return debug;
}

test('NetworkCapture records only while recording, correlates by requestId and skips isolated worlds', async t => {
  const debug = fakeDebugger(), events = [];
  let recordingId = null;
  const capture = await new NetworkCapture({ debugger: debug }, {
    recordingId: () => recordingId,
    record: (type, payload, extra) => { events.push({ type, payload, ...extra }); },
  }).init();
  t.after(() => capture.close());
  capture.start();
  assert.ok(debug.commands.includes('Network.enable'));
  assert.ok(debug.commands.includes('Runtime.enable'));
  const emit = (method, params) => debug.emit('message', {}, method, params);
  const fetch = (id, url, type = 'Fetch', extra = {}) => emit('Network.requestWillBeSent', { ...requestParams({ requestId: id, type }), request: { url, method: 'GET', headers: {} }, ...extra });
  // Not recording: nothing is stored.
  fetch('idle', 'http://127.0.0.1:9/idle');
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'idle' }], executionContextId: 1, timestamp: 1 });
  await capture.flush();
  assert.equal(events.length, 0);
  recordingId = 'rec';
  emit('Runtime.executionContextCreated', { context: { id: 7, auxData: { isDefault: false, type: 'isolated' } } });
  emit('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true, type: 'default' } } });
  fetch('r1', 'http://127.0.0.1:9/api/data');
  emit('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { url: 'http://127.0.0.1:9/api/data', status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'content-type': 'application/json' } } });
  debug.bodies.set('r1', { body: '{"items":[1,2]}', base64Encoded: false });
  emit('Network.loadingFinished', { requestId: 'r1', timestamp: 100.25, encodedDataLength: 15 });
  fetch('img', 'http://127.0.0.1:9/a.png', 'Image');
  emit('Network.loadingFinished', { requestId: 'img', timestamp: 101 });
  fetch('bin', 'http://127.0.0.1:9/file', 'XHR');
  emit('Network.responseReceived', { requestId: 'bin', type: 'XHR', response: { status: 200, mimeType: 'application/octet-stream', headers: {} } });
  emit('Network.loadingFinished', { requestId: 'bin', timestamp: 100.01 });
  fetch('bad', 'http://127.0.0.1:9/api/fail');
  emit('Network.responseReceived', { requestId: 'bad', type: 'Fetch', response: { status: 500, statusText: 'Internal Server Error', mimeType: 'text/plain', headers: {} } });
  debug.bodies.set('bad', { body: 'boom', base64Encoded: false });
  emit('Network.loadingFinished', { requestId: 'bad', timestamp: 100.002 });
  fetch('down', 'http://127.0.0.1:1/x');
  emit('Network.loadingFailed', { requestId: 'down', timestamp: 100.003, type: 'Fetch', errorText: 'net::ERR_CONNECTION_REFUSED', canceled: false });
  fetch('post', 'http://127.0.0.1:9/form', 'XHR', { request: { url: 'http://127.0.0.1:9/form', method: 'POST', headers: {}, hasPostData: true } });
  emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'main world' }], executionContextId: 1, timestamp: 1700000000500 });
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'tracedock internals' }], executionContextId: 7, timestamp: 1 });
  emit('Runtime.exceptionThrown', { timestamp: 1700000000600, exceptionDetails: { text: 'Uncaught', executionContextId: 1, exception: { type: 'object', subtype: 'error', description: 'TypeError: x is undefined' } } });
  emit('Runtime.exceptionThrown', { timestamp: 1, exceptionDetails: { text: 'Uncaught', executionContextId: 7, exception: { type: 'object', subtype: 'error', description: 'Error: internal' } } });
  await capture.flush();
  const types = events.map(e => `${e.type}:${e.payload.requestId ?? e.payload.text}`);
  assert.deepEqual(types, [
    'network.request:r1', 'network.response:r1', 'network.request:bin', 'network.response:bin',
    'network.request:bad', 'network.response:bad', 'network.request:down', 'network.failed:down',
    'network.request:post', 'console.message:main world', 'console.exception:TypeError: x is undefined',
  ]);
  const ok = events[1];
  assert.equal(ok.payload.body.text, '{"items":[1,2]}');
  assert.equal(ok.payload.durationMs, 250);
  assert.equal(ok.summary, 'GET 200 /api/data 250ms');
  assert.equal(ok.timestamp, new Date(Math.round((100.25 + 1700000000 - 100) * 1000)).toISOString());
  assert.match(events[3].payload.bodyOmitted, /非文本响应/);
  assert.equal(events[5].summary, 'GET 500 /api/fail 2ms');
  assert.equal(events[7].payload.errorText, 'net::ERR_CONNECTION_REFUSED');
  assert.deepEqual(events[8].payload.postData, { text: 'late=1', bytes: 6, truncated: false });
  assert.equal(events[9].timestamp, new Date(1700000000500).toISOString());
  assert.equal(events[9].summary, '[error] main world');
  // Pause: a response finishing while paused is dropped.
  fetch('late', 'http://127.0.0.1:9/late');
  await capture.flush();
  recordingId = null;
  emit('Network.loadingFinished', { requestId: 'late', timestamp: 101 });
  await capture.flush();
  assert.equal(events.at(-1).payload.requestId, 'late');
  assert.equal(events.at(-1).type, 'network.request');
});

test('redirects emit one 3xx response per hop and keep the requestId', async t => {
  const debug = fakeDebugger(), events = [];
  const capture = await new NetworkCapture({ debugger: debug }, { recordingId: () => 'rec', record: (type, payload) => { events.push({ type, payload }); } }).init();
  t.after(() => capture.close());
  capture.start();
  const emit = (method, params) => debug.emit('message', {}, method, params);
  emit('Network.requestWillBeSent', requestParams({ requestId: 'd', type: 'Document', request: { url: 'http://h/old', method: 'GET', headers: {} } }));
  emit('Network.requestWillBeSent', requestParams({ requestId: 'd', type: 'Document', timestamp: 100.1, request: { url: 'http://h/new', method: 'GET', headers: {} }, redirectResponse: { url: 'http://h/old', status: 302, statusText: 'Found', mimeType: 'text/html', headers: { location: '/new' } } }));
  emit('Network.responseReceived', { requestId: 'd', type: 'Document', response: { url: 'http://h/new', status: 200, mimeType: 'text/html', headers: {} } });
  emit('Network.loadingFinished', { requestId: 'd', timestamp: 100.2 });
  await capture.flush();
  assert.deepEqual(events.map(e => [e.type, e.payload.url, e.payload.status ?? null]), [
    ['network.request', 'http://h/old', null], ['network.response', 'http://h/old', 302], ['network.request', 'http://h/new', null], ['network.response', 'http://h/new', 200],
  ]);
  assert.equal(events[1].payload.redirectTo, 'http://h/new');
  assert.equal(events[2].payload.redirectCount, 1);
  assert.match(events[3].payload.bodyOmitted, /DOM 快照/);
  assert.ok(!debug.commands.includes('Network.getResponseBody'));
});

test('issue collector renders a bounded Markdown section', () => {
  const issues = createIssueCollector(2);
  issues.add({ seq: 1, type: 'network.response', summary: 'GET 200 /ok', elapsedMs: 1 });
  assert.equal(issues.markdown(), '');
  issues.add({ seq: 2, type: 'network.response', summary: 'GET 503 /a|b', elapsedMs: 1500 });
  issues.add({ seq: 3, type: 'network.failed', summary: 'GET 失败 /x' });
  issues.add({ seq: 4, type: 'console.exception', summary: 'Uncaught <Error>' });
  const md = issues.markdown();
  assert.match(md, /## 失败请求与页面错误/);
  assert.match(md, /共 3 条/);
  assert.match(md, /仅列前 2 条/);
  assert.match(md, /\| 2 \| 1\.500s \| network\.response \| GET 503 \/a\\\|b \|/);
  assert.ok(!md.includes('| 4 |'));
});

test('derived timeline.md appends failed requests and page errors', async t => {
  const parent = path.resolve(__dirname, '../output/test-temp');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'network-derived-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rows = [
    { id: 'a', seq: 1, type: 'network.response', summary: 'GET 200 /ok 3ms', elapsedMs: 10, payload: { status: 200 } },
    { id: 'b', seq: 2, type: 'network.response', summary: 'GET 500 /api/fail 4ms', elapsedMs: 20, payload: { status: 500 } },
    { id: 'c', seq: 3, type: 'console.exception', summary: 'Uncaught Error: boom', elapsedMs: 30, payload: {} },
  ];
  const timelinePath = path.join(directory, 'timeline.jsonl'), contents = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(timelinePath, contents);
  const staging = path.join(directory, 'out');
  await deriveFiles({ timelinePath, byteLength: Buffer.byteLength(contents), staging, metadata: { id: 't', name: 'n' }, capturedAt: 'now' });
  const md = await fs.readFile(path.join(staging, 'timeline.md'), 'utf8');
  const section = md.slice(md.indexOf('## 失败请求与页面错误'));
  assert.match(section, /共 2 条/);
  assert.match(section, /\| 2 \| 0\.020s \| network\.response \| GET 500 \/api\/fail 4ms \|/);
  assert.match(section, /\| 3 \| 0\.030s \| console\.exception \|/);
  assert.ok(!section.includes('/ok'));
});

test('MCP network query filters by status, url and level and paginates', async () => {
  const all = [];
  for (let seq = 1; seq <= 30; seq++) {
    if (seq % 3 === 0) all.push({ id: `e${seq}`, seq, type: 'console.message', summary: '[error] x', payload: { level: seq % 2 ? 'error' : 'log', text: `m${seq}` } });
    else all.push({ id: `e${seq}`, seq, type: 'network.response', summary: 's', payload: { requestId: `r${seq}`, url: seq % 2 ? `http://h/api/${seq}` : `http://h/static/${seq}`, method: 'GET', status: seq % 5 === 0 ? 500 : 200, body: { text: 'x', bytes: 1, truncated: false } } });
  }
  const read = async q => {
    const matches = all.filter(e => e.seq > q.afterSeq && q.types.some(t => e.type === t || e.type.startsWith(`${t}.`)));
    const events = matches.slice(0, 7);
    return { events, total: matches.length, hasMore: matches.length > 7, firstSeq: null, lastSeq: null, snapshotSeq: 30, scannedThroughSeq: events.at(-1)?.seq ?? 30 };
  };
  const failed = await queryNetworkEvents(read, { statusMin: 400 });
  assert.deepEqual(failed.items.map(i => i.seq), [5, 10, 20, 25]);
  assert.equal(failed.hasMore, false);
  assert.equal(failed.nextAfterSeq, null);
  assert.equal(failed.items[0].bodyBytes, 1);
  const api = await queryNetworkEvents(read, { type: 'response', url: '/API/', limit: 3 });
  assert.deepEqual(api.items.map(i => i.seq), [1, 5, 7]);
  assert.equal(api.hasMore, true);
  const next = await queryNetworkEvents(read, { type: 'response', url: '/api/', limit: 3, afterSeq: api.nextAfterSeq, snapshotSeq: api.snapshotSeq });
  assert.deepEqual(next.items.map(i => i.seq), [11, 13, 17]);
  const errors = await queryNetworkEvents(read, { type: 'console', level: 'error' });
  assert.deepEqual(errors.items.map(i => i.seq), [3, 9, 15, 21, 27]);
  const small = await queryNetworkEvents(read, { maxBytes: 1024 });
  assert.equal(small.truncated, true);
  assert.equal(small.nextAfterSeq, small.items.at(-1).seq);
  await assert.rejects(queryNetworkEvents(read, { maxBytes: 10 }), /字节预算/);
  assert.deepEqual(Object.keys(networkItem({ seq: 1, id: 'x', type: 'console.message', payload: { level: 'log', text: 't', nope: 1 } })).sort(), ['id', 'level', 'seq', 'text', 'type']);
});

test('stop() stores in-flight responses, then closes the capture window', async t => {
  const debug = fakeDebugger(), events = [];
  let release;
  const capture = await new NetworkCapture({ debugger: debug }, { recordingId: () => 'rec', record: (type, payload) => { events.push({ type, payload }); } }).init();
  t.after(() => capture.close());
  const emit = (method, params) => debug.emit('message', {}, method, params);
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'before start' }], timestamp: 1 });
  await capture.flush();
  assert.equal(events.length, 0, 'nothing is stored before start()');
  capture.start();
  debug.bodies.set('slow', new Promise(resolve => { release = resolve; }));
  emit('Network.requestWillBeSent', requestParams({ requestId: 'slow' }));
  emit('Network.responseReceived', { requestId: 'slow', response: { status: 200, mimeType: 'text/plain', headers: {} } });
  emit('Network.loadingFinished', { requestId: 'slow', timestamp: 101 });
  const stopping = capture.stop();
  release({ body: 'late body', base64Encoded: false });
  await stopping;
  assert.deepEqual(events.map(e => e.type), ['network.request', 'network.response']);
  assert.equal(events[1].payload.body.text, 'late body');
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'after stop' }], timestamp: 1 });
  await capture.flush();
  assert.equal(events.length, 2);
});
