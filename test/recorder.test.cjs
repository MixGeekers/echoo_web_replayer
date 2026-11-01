'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'out', 'browser-preload.cjs'), 'utf8');

// A small host fixture exercises preload IPC lifecycle and lossless buffering.
// Actual browser event propagation is covered by the Electron smoke test.
function fixture() {
  const sent = [];
  const ipcListeners = new Map();
  const observers = [];
  const intervals = [];
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener({ type, ...event });
    }
  }
  const win = new Target();
  Object.assign(win, { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 });
  const doc = new Target();
  Object.assign(doc, { nodeType: 9, nodeName: '#document', readyState: 'complete', title: 'Fixture', location: { href: 'https://example.test/' }, defaultView: win, doctype: null, childNodes: [] });
  win.document = doc;
  function element(name, parent, attrs = {}) {
    const node = new Target();
    Object.assign(node, { nodeType: 1, localName: name, nodeName: name.toUpperCase(), ownerDocument: doc, parentNode: parent, parentElement: parent?.nodeType === 1 ? parent : null, childNodes: [], children: [], textContent: '', attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })), isConnected: true });
    node.id = attrs.id || '';
    node.getAttribute = key => node.attributes.find(a => a.name === key)?.value ?? null;
    node.getAttributeNS = (_namespace, key) => node.getAttribute(key);
    node.hasAttribute = key => node.getAttribute(key) !== null;
    node.getRootNode = () => parent?.getRootNode?.() || doc;
    node.querySelectorAll = selector => query(node, selector);
    node.outerHTML = `<${name}></${name}>`;
    if (parent) { parent.childNodes.push(node); parent.children?.push(node); }
    return node;
  }
  function descendants(root) { return root.childNodes.flatMap(child => [child, ...descendants(child)]); }
  function query(root, selector) {
    return descendants(root).filter(node => {
      if (selector === '*') return true;
      if (selector.startsWith('#')) return node.id === selector.slice(1);
      if (selector === 'input, textarea, select, [contenteditable]') return ['input', 'textarea', 'select'].includes(node.localName);
      if (selector === 'iframe, frame') return ['iframe', 'frame'].includes(node.localName);
      return false;
    });
  }
  doc.getRootNode = () => doc;
  doc.querySelectorAll = selector => query(doc, selector);
  function shadowRoot(host) {
    const root = new Target();
    Object.assign(root, { nodeType: 11, nodeName: '#document-fragment', ownerDocument: doc, host, childNodes: [], children: [], innerHTML: '' });
    root.getRootNode = () => root;
    root.querySelectorAll = selector => query(root, selector);
    host.shadowRoot = root;
    return root;
  }
  const html = element('html', doc);
  const body = element('body', html);
  const input = element('input', body, { id: 'password', type: 'password' });
  input.value = '原样-password-123';
  input.checked = false;
  doc.documentElement = html;
  class Observer {
    constructor(callback) { this.callback = callback; this.records = []; observers.push(this); }
    observe(root) { this.root = root; }
    disconnect() { this.disconnected = true; }
    takeRecords() { const result = this.records; this.records = []; return result; }
    deliver(records) { this.callback(records); }
  }
  let timerId = 0;
  const context = vm.createContext({
    require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer: {
        on: (channel, handler) => ipcListeners.set(channel, handler),
        invoke: channel => { assert.equal(channel, 'recorder:ready'); return ready; },
        send: (channel, data) => sent.push({ channel, data: JSON.parse(JSON.stringify(data)) }),
      } };
    },
    document: doc, window: win, MutationObserver: Observer,
    CSS: { escape: value => value },
    setTimeout: () => ++timerId, clearTimeout() {}, setInterval: callback => { intervals.push(callback); return ++timerId; }, clearInterval() {},
  });
  vm.runInContext(source, context, { filename: 'browser-preload.cjs' });
  return {
    sent, observers, doc, input, element, shadowRoot, tickDiscovery: () => intervals.forEach(callback => callback()),
    ready: async state => { resolveReady(state); await ready; await Promise.resolve(); },
    state: state => ipcListeners.get('recorder:state')({}, state),
    command: (command, requestId = 'request-1') => ipcListeners.get('recorder:command')({}, { command, requestId }),
    events: type => sent.filter(item => item.channel === 'recorder:event' && (!type || item.data.type === type)).map(item => item.data),
  };
}

test('preload state event wins over a stale ready response and does not expose a website API', async () => {
  const host = fixture();
  host.state({ recording: true, sessionId: 'current' });
  await host.ready({ recording: false, sessionId: null });
  host.command('snapshot');
  assert.equal(host.events('dom.snapshot').length, 2);
  assert.ok(host.events().every(event => event.sessionId === 'current'));
});

test('snapshot retains raw password values and correlatable node IDs', async () => {
  const host = fixture();
  await host.ready({ recording: true, sessionId: 'raw' });
  const snapshot = host.events('dom.snapshot')[0].payload;
  assert.equal(snapshot.forms[0].value, '原样-password-123');
  assert.equal(snapshot.forms[0].type, 'password');
  assert.equal(snapshot.forms[0].nodeId, snapshot.tree.children[0].children[0].children[0].nodeId);
  assert.equal(snapshot.coverage.dataRedaction, false);
  assert.equal(snapshot.coverage.crossOriginFrames, false);
});

test('stop drains pending MutationObserver records and trailing scroll before ack', async () => {
  const host = fixture();
  await host.ready({ recording: true, sessionId: 'stopping' });
  host.observers[0].records.push({ type: 'attributes', target: host.input, attributeName: 'class', attributeNamespace: null, oldValue: null });
  host.doc.defaultView.scrollY = 123;
  host.doc.dispatch('scroll', { target: host.doc, isTrusted: true });
  host.command('stop', 'stop-ack');
  const types = host.sent.map(item => item.channel === 'recorder:event' ? item.data.type : item.channel);
  assert.deepEqual(types.slice(-3), ['dom.mutation', 'action.scroll', 'recorder:ack']);
  assert.equal(host.events('dom.mutation')[0].payload.recordCount, 1);
  assert.equal(host.events('action.scroll')[0].payload.y, 123);
  assert.equal(host.sent.at(-1).data.requestId, 'stop-ack');
  assert.equal(host.sent.at(-1).data.ok, true);
  assert.equal(host.observers[0].disconnected, true);
  const eventCount = host.events().length;
  host.doc.dispatch('click', { target: host.input, isTrusted: true });
  host.command('snapshot');
  assert.equal(host.events().length, eventCount);
});

test('attribute mutations preserve intermediate values in a callback batch', async () => {
  const host = fixture();
  await host.ready({ recording: true, sessionId: 'mutations' });
  host.input.attributes.push({ name: 'class', value: 'third' });
  host.observers[0].deliver([
    { type: 'attributes', target: host.input, attributeName: 'class', attributeNamespace: null, oldValue: 'first' },
    { type: 'attributes', target: host.input, attributeName: 'class', attributeNamespace: null, oldValue: 'second' },
  ]);
  host.command('flush');
  const records = host.events('dom.mutation')[0].payload.records;
  assert.deepEqual(records.map(record => [record.oldValue, record.newValue]), [['first', 'second'], ['second', 'third']]);
  assert.equal(records[0].targetId, records[1].targetId);
});

test('selector identifies same-tag siblings directly inside an open shadow root', async () => {
  const host = fixture();
  await host.ready({ recording: true, sessionId: 'shadow' });
  const target = host.input;
  const shadowRoot = {
    nodeType: 11, nodeName: '#document-fragment', host: target.parentElement,
    ownerDocument: host.doc, children: [{ localName: 'button' }, target], querySelectorAll: () => [],
  };
  shadowRoot.getRootNode = () => shadowRoot;
  target.attributes = [];
  target.id = '';
  target.localName = 'button';
  target.nodeName = 'BUTTON';
  target.parentElement = null;
  target.parentNode = shadowRoot;
  target.getRootNode = () => shadowRoot;
  host.doc.dispatch('click', { target, isTrusted: true });
  assert.equal(host.events('action.click')[0].payload.target.selector, 'button:nth-of-type(2)');
});

test('discovery creates a baseline when a new shadow root is nested under an existing root', async () => {
  const host = fixture();
  const outer = host.shadowRoot(host.input.parentElement);
  const nestedHost = host.element('span', outer);
  await host.ready({ recording: true, sessionId: 'nested-shadow' });
  const before = host.events('dom.snapshot').length;
  const nested = host.shadowRoot(nestedHost);
  host.element('button', nested, { id: 'nested-button' });
  host.tickDiscovery();
  assert.equal(host.events('dom.snapshot').length, before + 1);
  assert.equal(host.events('dom.snapshot').at(-1).payload.reason, 'scope-discovered');
  assert.equal(host.events('dom.snapshot').at(-1).payload.shadowRoots.length, 2);
});

test('frame scope retains a shadow-host path for frames inside an open shadow root', async () => {
  const host = fixture();
  await host.ready({ recording: true, sessionId: 'shadow-frame' });
  const outer = host.shadowRoot(host.input.parentElement);
  const frame = host.element('iframe', outer, { id: 'shadow-frame' });
  const childDoc = { nodeType: 9, nodeName: '#document', location: { href: 'https://example.test/child' } };
  childDoc.defaultView = { frameElement: frame, parent: host.doc.defaultView };
  childDoc.getRootNode = () => childDoc;
  childDoc.querySelectorAll = () => [host.input];
  host.input.ownerDocument = childDoc;
  host.input.getRootNode = () => childDoc;
  host.doc.dispatch('click', { target: host.input, isTrusted: true });
  const scope = host.events('action.click')[0].payload.target.scope;
  assert.deepEqual(scope.framePath, ['#shadow-frame']);
  assert.deepEqual(scope.frameContexts[0].shadowPath, ['html > body']);
  assert.equal(scope.frameContexts[0].selector, '#shadow-frame');
  assert.equal(scope.frameUrl, 'https://example.test/child');
});

test('failed snapshots report failure in command acknowledgement without throwing in lifecycle handlers', async () => {
  const host = fixture();
  await host.ready({ recording: true, sessionId: 'snapshot-error' });
  const before = host.events('dom.snapshot').length;
  Object.defineProperty(host.doc.documentElement, 'outerHTML', { get() { throw new Error('Snapshot serialization failed'); } });
  assert.doesNotThrow(() => host.command('snapshot', 'failed-snapshot'));
  assert.deepEqual(host.sent.at(-1), {
    channel: 'recorder:ack',
    data: { requestId: 'failed-snapshot', ok: false, error: 'Snapshot serialization failed' },
  });
  assert.equal(host.events('dom.snapshot').length, before);
  assert.equal(host.events('recorder.error').at(-1).payload.operation, 'snapshot');
  assert.doesNotThrow(() => host.doc.dispatch('DOMContentLoaded'));
  assert.equal(host.events('recorder.error').length, 2);
  assert.equal(host.events('dom.snapshot').length, before);
});

test('pause and resume retain document node identity without duplicate action listeners', async () => {
  const host = fixture();
  await host.ready({ recording: true, sessionId: 'resume-identity' });
  const before = host.events('dom.snapshot').at(-1);
  host.command('stop');
  host.state({ recording: false, sessionId: 'resume-identity' });
  host.doc.dispatch('input', { target: host.input, isTrusted: true });
  assert.equal(host.events('action.input').length, 0);
  host.state({ recording: true, sessionId: 'resume-identity' });
  host.input.value = 'after resume';
  host.doc.dispatch('input', { target: host.input, isTrusted: true });
  const actions = host.events('action.input');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].documentId, before.documentId);
  assert.equal(actions[0].payload.form.nodeId, before.payload.forms[0].nodeId);
  assert.equal(actions[0].payload.form.value, 'after resume');
});

test('unsupported recorder commands acknowledge failure and leave recording usable', async () => {
  const host = fixture();
  await host.ready({ recording: true, sessionId: 'command-validation' });
  host.command('unsupported', 'invalid-command');
  const ack = host.sent.find(item => item.channel === 'recorder:ack' && item.data.requestId === 'invalid-command');
  assert.equal(ack.data.ok, false);
  assert.match(ack.data.error, /Unsupported recorder command/);
  const before = host.events('dom.snapshot').length;
  host.command('snapshot', 'next-command');
  assert.equal(host.events('dom.snapshot').length, before + 1);
  assert.equal(host.sent.find(item => item.channel === 'recorder:ack' && item.data.requestId === 'next-command').data.ok, true);
});
