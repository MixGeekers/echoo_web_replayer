'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SessionStore } = require('../out/session-store.cjs');
const { ResourceRecorder } = require('../out/resource-recorder.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// The debugger is the public transport boundary. ResourceCapture internals are
// deliberately not inspected: assertions cover persisted records and UI counts.
async function setup(t) {
  const root = path.join(__dirname, '../output/test-temp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'resource-capture-'));
  const store = await new SessionStore(path.join(directory, 'recordings')).init();
  const debug = new EventEmitter();
  const bodies = new Map();
  const bodyRequests = [];
  let attached = false;
  debug.attach = () => { attached = true; };
  debug.isAttached = () => attached;
  debug.detach = () => { attached = false; };
  debug.sendCommand = async (method, params) => {
    if (method === 'Page.getFrameTree') return { frameTree: {
      frame: { id: 'main-a', loaderId: 'loader-a', url: 'https://old.test/' },
      childFrames: [{ frame: { id: 'child-a', parentId: 'main-a', loaderId: 'child-loader-a', url: 'https://old.test/frame' } }],
    } };
    if (method === 'Page.enable' || method === 'Network.enable') return {};
    assert.equal(method, 'Network.getResponseBody');
    bodyRequests.push(params.requestId);
    const body = bodies.get(params.requestId) ?? 'body { color: blue }';
    if (body instanceof Error) throw body;
    if (typeof body === 'function') return body();
    return { body, base64Encoded: false };
  };
  const recorder = await new ResourceRecorder(store, { debugger: debug }).init(directory);
  t.after(async () => { await recorder.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const emit = (method, params) => debug.emit('message', {}, method, params);
  let frameId = 'main-a', loaderId = 'loader-a', navigation = 0;
  const request = (id, url, extra = {}) => emit('Network.requestWillBeSent', {
    requestId: id, type: 'Stylesheet', frameId, loaderId, documentURL: url,
    request: { url }, ...extra,
  });
  const response = (id, url, extra = {}) => emit('Network.responseReceived', {
    requestId: id, type: 'Stylesheet', frameId, loaderId,
    response: { url, mimeType: 'text/css', status: 200, headers: {} }, ...extra,
  });
  const finish = id => emit('Network.loadingFinished', { requestId: id, encodedDataLength: 24 });
  const fail = id => emit('Network.loadingFailed', { requestId: id, type: 'Stylesheet', errorText: 'net::ERR_ABORTED', canceled: true });
  const navigate = (url = 'https://new.test/', nextFrame = frameId) => {
    frameId = nextFrame; loaderId = `loader-${++navigation}`;
    request(`navigation-${navigation}`, url, { type: 'Document' });
    emit('Page.frameNavigated', { frame: { id: frameId, loaderId, url } });
  };
  const capture = async (id, url, body) => {
    if (body !== undefined) bodies.set(id, body);
    request(id, url); response(id, url); finish(id); await recorder.flush();
  };
  const start = async name => {
    const session = await store.create(name, 'https://new.test/', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' }, 'group-00000000-0000-4000-8000-000000000001');
    await recorder.start(session.id); return session.id;
  };
  const empty = async id => {
    const summary = await recorder.summary(id);
    assert.equal(summary.saved, 0); assert.equal(summary.missing, 0);
    assert.deepEqual(summary.missingURLs, []);
    assert.deepEqual(await recorder.catalog(id), []);
    const files = await fs.readdir(path.join(store.getSessionDirectory(id), 'assets')).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    assert.deepEqual(files, [], 'stale resource bodies must not be archived in the new session');
  };
  return { directory, store, recorder, emit, request, response, finish, fail, navigate, capture, start, empty, bodies, bodyRequests };
}

for (const outcome of ['saved', 'body-missing', 'loading-failed']) {
  test(`a late old-page ${outcome} response never contributes resources to a new session`, async t => {
    const h = await setup(t), old = 'https://old.test/theme.css';
    h.request('old', old);
    h.navigate();
    const id = await h.start('New page');
    if (outcome === 'body-missing') h.bodies.set('old', new Error('No resource with given identifier found'));
    h.response('old', old, { frameId: 'main-a', loaderId: 'loader-a' });
    if (outcome === 'loading-failed') h.fail('old'); else h.finish('old');
    await h.recorder.flush();
    await h.empty(id);
    await h.capture('new', 'https://new.test/site.css');
    assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://new.test/site.css']);
  });
}

test('cached current-page resources and genuine current-page failures are retained when recording starts', async t => {
  const h = await setup(t);
  await h.capture('old', 'https://old.test/previous.css');
  h.navigate();
  await h.capture('current', 'https://new.test/site.css', 'body { color: green }');
  await h.capture('missing', 'https://new.test/missing.css', new Error('current resource body unavailable'));
  const id = await h.start('Current cached resources');
  const status = await h.recorder.summary(id);
  assert.equal(status.saved, 1); assert.equal(status.missing, 1);
  assert.deepEqual(status.missingURLs, ['https://new.test/missing.css']);
  assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://new.test/site.css', 'https://new.test/missing.css']);
});

test('requests started in recording A cannot be reassigned to recording B when their response arrives late', async t => {
  const h = await setup(t), old = 'https://old.test/late.css';
  const first = await h.start('Recording A');
  h.request('old', old);
  await h.recorder.stop();
  await h.store.update(first, { status: 'stopped' });
  h.navigate();
  const second = await h.start('Recording B');
  h.response('old', old, { loaderId: 'loader-a' }); h.finish('old');
  await h.recorder.flush();
  await h.empty(second);
  await h.capture('new', 'https://new.test/current.css');
  assert.equal((await h.recorder.summary(second)).saved, 1);
});

test('a resource redirect keeps the original request owner across navigation', async t => {
  const h = await setup(t);
  h.request('redirected', 'https://old.test/logo');
  h.navigate();
  const id = await h.start('After redirect');
  h.request('redirected', 'https://cdn.test/logo.svg', {
    type: 'Image', frameId: 'main-a', loaderId: 'loader-a',
    redirectResponse: { url: 'https://old.test/logo', status: 302, headers: { location: 'https://cdn.test/logo.svg' } },
  });
  h.response('redirected', 'https://cdn.test/logo.svg', {
    type: 'Image', loaderId: 'loader-a',
    response: { url: 'https://cdn.test/logo.svg', mimeType: 'image/svg+xml', status: 200, headers: {} },
  });
  h.finish('redirected'); await h.recorder.flush();
  await h.empty(id);
});

test('one continuous recording still archives its earlier page resources after navigation', async t => {
  const h = await setup(t), id = await h.start('Both pages');
  h.request('old', 'https://old.test/late.css');
  h.navigate();
  h.response('old', 'https://old.test/late.css', { loaderId: 'loader-a' }); h.finish('old');
  await h.capture('new', 'https://new.test/current.css');
  assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://old.test/late.css', 'https://new.test/current.css']);
  assert.equal((await h.recorder.summary(id)).saved, 2);
});

test('a queued old-page body completing during navigation cannot seed the next recording cache', async t => {
  const h = await setup(t), started = deferred(), body = deferred();
  h.bodies.set('old', () => { started.resolve(); return body.promise; });
  h.request('old', 'https://old.test/slow.css'); h.response('old', 'https://old.test/slow.css'); h.finish('old');
  await started.promise;
  h.navigate();
  const next = h.start('New while body pending');
  body.resolve({ body: 'old body finally returned', base64Encoded: false });
  const id = await next;
  await h.empty(id);
  await h.capture('current', 'https://new.test/current.css');
  assert.equal((await h.recorder.summary(id)).saved, 1);
});

test('top-frame replacement updates resource ownership for the new document', async t => {
  const h = await setup(t);
  await h.capture('cached', 'https://old.test/cached.css');
  h.request('late', 'https://old.test/late.css');
  // A process/frame replacement may publish its new frame identity before later requests.
  h.emit('Page.frameNavigated', { frame: { id: 'main-b', loaderId: 'loader-b', url: 'https://new.test/' } });
  h.navigate('https://new.test/', 'main-b');
  const id = await h.start('Replacement frame');
  h.response('late', 'https://old.test/late.css', { frameId: 'main-a', loaderId: 'loader-a' }); h.finish('late');
  await h.recorder.flush(); await h.empty(id);
  await h.capture('new', 'https://new.test/current.css');
  assert.equal((await h.recorder.summary(id)).saved, 1);
});

test('subframe and same-document navigation do not discard the current top-page resource cache', async t => {
  const h = await setup(t);
  await h.capture('main', 'https://old.test/main.css');
  h.request('child-document', 'https://old.test/child-next', { type: 'Document', frameId: 'child-a', loaderId: 'child-loader-b' });
  h.emit('Page.frameNavigated', { frame: { id: 'child-a', parentId: 'main-a', loaderId: 'child-loader-b', url: 'https://old.test/child-next' } });
  h.emit('Page.navigatedWithinDocument', { frameId: 'main-a', url: 'https://old.test/#section' });
  const id = await h.start('Same page');
  assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://old.test/main.css']);
});

test('same-document session changes do not relabel an unfinished request from the earlier recording', async t => {
  const h = await setup(t), first = await h.start('First session');
  h.request('old', 'https://old.test/unfinished.css');
  await h.recorder.stop();
  await h.store.update(first, { status: 'stopped' });
  const second = await h.start('Second session on same page');
  h.response('old', 'https://old.test/unfinished.css'); h.finish('old');
  await h.recorder.flush();
  await h.empty(second);
  await h.capture('fresh', 'https://old.test/new-request.css');
  assert.deepEqual((await h.recorder.catalog(second)).map(entry => entry.url), ['https://old.test/new-request.css']);
});

test('an old-loader request issued during navigation cannot inherit the destination page generation', async t => {
  const h = await setup(t);
  h.request('navigation', 'https://new.test/', { type: 'Document', loaderId: 'loader-new' });
  // The old document can still issue work before the replacement commits.
  h.request('old-late-request', 'https://old.test/unload.css', { loaderId: 'loader-a' });
  h.emit('Page.frameNavigated', { frame: { id: 'main-a', loaderId: 'loader-new', url: 'https://new.test/' } });
  const id = await h.start('New document committed');
  h.response('old-late-request', 'https://old.test/unload.css', { loaderId: 'loader-a' }); h.finish('old-late-request');
  await h.recorder.flush(); await h.empty(id);
  h.request('new', 'https://new.test/current.css', { loaderId: 'loader-new' });
  h.response('new', 'https://new.test/current.css', { loaderId: 'loader-new' }); h.finish('new');
  await h.recorder.flush();
  assert.equal((await h.recorder.summary(id)).saved, 1);
});

test('a response without an observed request cannot be assigned to the active recording', async t => {
  const h = await setup(t), id = await h.start('No unowned responses');
  h.response('unowned', 'https://old.test/unobserved.css'); h.finish('unowned');
  h.request('unowned-redirect', 'https://cdn.test/unobserved.css', {
    redirectResponse: { url: 'https://old.test/unobserved.css', status: 302, headers: { location: 'https://cdn.test/unobserved.css' } },
  });
  h.response('unowned-redirect', 'https://cdn.test/unobserved.css'); h.finish('unowned-redirect');
  await h.recorder.flush(); await h.empty(id);
  assert.ok(!h.bodyRequests.includes('unowned'), 'unowned response bodies should not be retrieved');
  assert.ok(!h.bodyRequests.includes('unowned-redirect'), 'a redirect must not manufacture missing initial ownership');
});

test('a document request and its matching commit advance ownership only once', async t => {
  const h = await setup(t);
  await h.capture('old', 'https://old.test/cached.css');
  h.request('navigation', 'https://new.test/', { type: 'Document', loaderId: 'loader-new' });
  h.request('early', 'https://new.test/early.css', { loaderId: 'loader-new' });
  h.response('early', 'https://new.test/early.css', { loaderId: 'loader-new' }); h.finish('early');
  await h.recorder.flush();
  h.emit('Page.frameNavigated', { frame: { id: 'main-a', loaderId: 'loader-new', url: 'https://new.test/' } });
  const id = await h.start('Early destination resources');
  assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://new.test/early.css']);
  assert.equal((await h.recorder.summary(id)).saved, 1);
});

test('evicted request ownership is never reconstructed from a later response', async t => {
  const h = await setup(t), id = await h.start('Bounded ownership');
  // The capture budget holds at most 5,000 pending owners. Exceed it without
  // finishing requests to exercise the actual eviction boundary through CDP.
  for (let index = 0; index <= 5000; index++) h.request(`request-${index}`, `https://old.test/${index}.css`);
  h.response('request-0', 'https://old.test/0.css'); h.finish('request-0');
  await h.recorder.flush(); await h.empty(id);
  assert.ok(!h.bodyRequests.includes('request-0'));
  h.response('request-5000', 'https://old.test/5000.css'); h.finish('request-5000');
  await h.recorder.flush();
  assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://old.test/5000.css']);
});

test('old-loader requests arriving after the new recording starts cannot become that recording resources', async t => {
  const h = await setup(t);
  h.navigate();
  const id = await h.start('New page already recording');
  for (const suffix of ['saved', 'missing']) {
    const requestId = `late-old-${suffix}`, url = `https://old.test/${suffix}.css`;
    h.request(requestId, url, { frameId: 'main-a', loaderId: 'loader-a' });
    if (suffix === 'missing') h.bodies.set(requestId, new Error('old response no longer available'));
    h.response(requestId, url, { frameId: 'main-a', loaderId: 'loader-a' }); h.finish(requestId);
  }
  await h.recorder.flush(); await h.empty(id);
  await h.capture('current', 'https://new.test/current.css');
  assert.equal((await h.recorder.summary(id)).saved, 1);
});

test('a superseded document redirect cannot reactivate its old loader after a newer navigation', async t => {
  const h = await setup(t);
  h.request('old-navigation', 'https://old.test/redirect', { type: 'Document', loaderId: 'superseded-loader' });
  h.navigate('https://new.test/');
  const id = await h.start('Newest committed document');
  await h.capture('new', 'https://new.test/current.css');
  h.request('old-navigation', 'https://old.test/redirected', {
    type: 'Document', loaderId: 'superseded-loader',
    redirectResponse: { url: 'https://old.test/redirect', status: 302, headers: { location: 'https://old.test/redirected' } },
  });
  h.request('old-redirect-resource', 'https://old.test/redirected.css', { loaderId: 'superseded-loader' });
  h.response('old-redirect-resource', 'https://old.test/redirected.css', { loaderId: 'superseded-loader' }); h.finish('old-redirect-resource');
  await h.recorder.flush();
  assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://new.test/current.css']);
  await h.recorder.stop();
  await h.store.update(id, { status: 'stopped' });
  const next = await h.start('Same new page again');
  assert.deepEqual((await h.recorder.catalog(next)).map(entry => entry.url), ['https://new.test/current.css'], 'late redirects must not replace the current page cache');
});

test('a stale child-frame document cannot give its new loader to the current page recording', async t => {
  const h = await setup(t);
  h.navigate();
  const id = await h.start('New page without old child');
  h.request('old-child-document', 'https://old.test/late-child', {
    type: 'Document', frameId: 'child-a', loaderId: 'old-child-new-loader',
  });
  for (const suffix of ['saved', 'missing']) {
    const requestId = `old-child-${suffix}`, url = `https://old.test/child-${suffix}.css`;
    h.request(requestId, url, { frameId: 'child-a', loaderId: 'old-child-new-loader' });
    if (suffix === 'missing') h.bodies.set(requestId, new Error('old child body no longer available'));
    h.response(requestId, url, { frameId: 'child-a', loaderId: 'old-child-new-loader' }); h.finish(requestId);
  }
  await h.recorder.flush(); await h.empty(id);
  await h.capture('current', 'https://new.test/current.css');
  assert.equal((await h.recorder.summary(id)).saved, 1);
});

test('a committed top-frame replacement with the same loader keeps resources received before commit', async t => {
  const h = await setup(t);
  h.request('navigation', 'https://new.test/', { type: 'Document', loaderId: 'replacement-loader' });
  h.request('early', 'https://new.test/early.css', { loaderId: 'replacement-loader' });
  h.response('early', 'https://new.test/early.css', { loaderId: 'replacement-loader' }); h.finish('early');
  await h.recorder.flush();
  h.emit('Page.frameNavigated', { frame: { id: 'main-replaced', loaderId: 'replacement-loader', url: 'https://new.test/' } });
  const id = await h.start('Replacement frame same loader');
  assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://new.test/early.css']);
  assert.equal((await h.recorder.summary(id)).saved, 1);
});

for (const childNavigationTiming of ['before-commit', 'after-commit']) {
  test(`a stale srcdoc child navigation ${childNavigationTiming} cannot assign its resources to the destination recording`, async t => {
    const h = await setup(t);
    h.request('navigation', 'https://new.test/', { type: 'Document', loaderId: 'loader-new' });
    const oldChildNavigation = () => h.emit('Page.frameNavigated', { frame: {
      id: 'child-a', parentId: 'main-a', loaderId: 'stale-srcdoc-loader', url: 'about:srcdoc',
    } });
    if (childNavigationTiming === 'before-commit') oldChildNavigation();
    h.emit('Page.frameNavigated', { frame: { id: 'main-a', loaderId: 'loader-new', url: 'https://new.test/' } });
    if (childNavigationTiming === 'after-commit') oldChildNavigation();
    const id = await h.start('New page after old srcdoc');
    for (const suffix of ['saved', 'missing']) {
      const requestId = `stale-srcdoc-${suffix}`, url = `https://old.test/srcdoc-${suffix}.css`;
      h.request(requestId, url, { frameId: 'child-a', loaderId: 'stale-srcdoc-loader' });
      if (suffix === 'missing') h.bodies.set(requestId, new Error('old srcdoc body no longer available'));
      h.response(requestId, url, { frameId: 'child-a', loaderId: 'stale-srcdoc-loader' }); h.finish(requestId);
    }
    await h.recorder.flush(); await h.empty(id);
  });
}

test('a newly attached current-page iframe retains its resource cache and recording resources', async t => {
  const h = await setup(t);
  h.navigate();
  h.emit('Page.frameAttached', { frameId: 'child-current', parentFrameId: 'main-a' });
  h.emit('Page.frameNavigated', { frame: {
    id: 'child-current', parentId: 'main-a', loaderId: 'current-child-loader', url: 'about:srcdoc',
  } });
  h.request('child-cached', 'https://new.test/child.css', { frameId: 'child-current', loaderId: 'current-child-loader' });
  h.response('child-cached', 'https://new.test/child.css', { frameId: 'child-current', loaderId: 'current-child-loader' }); h.finish('child-cached');
  await h.recorder.flush();
  const id = await h.start('New page with its iframe');
  h.request('child-later', 'https://new.test/child-later.css', { frameId: 'child-current', loaderId: 'current-child-loader' });
  h.response('child-later', 'https://new.test/child-later.css', { frameId: 'child-current', loaderId: 'current-child-loader' }); h.finish('child-later');
  await h.recorder.flush();
  assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://new.test/child.css', 'https://new.test/child-later.css']);
  const summary = await h.recorder.summary(id);
  assert.equal(summary.saved, 2); assert.equal(summary.missing, 0);
});

test('requests with absent, empty, or unknown document loaders cannot inherit the current recording', async t => {
  const h = await setup(t);
  h.navigate();
  const id = await h.start('No inferred document owner');
  for (const frameId of ['main-a', 'child-a'])
    for (const [index, loaderId] of [undefined, '', 'never-observed-loader'].entries()) {
      const requestId = `unowned-loader-${frameId}-${index}`, url = `https://old.test/unowned-${frameId}-${index}.css`;
      h.request(requestId, url, { frameId, loaderId });
      h.response(requestId, url, { frameId, loaderId }); h.finish(requestId);
    }
  await h.recorder.flush(); await h.empty(id);
  await h.capture('known', 'https://new.test/known-loader.css');
  assert.deepEqual((await h.recorder.catalog(id)).map(entry => entry.url), ['https://new.test/known-loader.css']);
});
