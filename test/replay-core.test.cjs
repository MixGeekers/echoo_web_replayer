'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracedock-replay-core-'));
function bundle(name) {
  const output = path.join(temporary, `${name}.cjs`);
  buildSync({ entryPoints: [path.join(__dirname, '../src/replay', `${name}.ts`)], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  return require(output);
}
const { decodeReplayEvent } = bundle('model');
const { ReplayController } = bundle('controller');
const { ReplayDOM } = bundle('dom');
test.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
const tree = () => ({nodeId: 'doc', nodeType: 9, nodeName: '#document', children: []});
const event = (seq, type, payload) => ({id: `s:${seq}`, sessionId: 's', seq, elapsedMs: seq * 100, type, payload, documentId: 'd', timestamp: '', receivedAt: '', url: 'https://example.test/', title: '', summary: ''});
const snapshot = () => event(1, 'dom.snapshot', {tree: tree(), url: 'https://example.test/', forms: [], frames: [], shadowRoots: []});
const seekResult = (seq = 1) => ({session: {}, snapshot: snapshot(), afterSeq: seq, targetSeq: seq, endSeq: seq, durationMs: 1000, timeMs: seq * 100});
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }
function fixture(t, overrides = {}) {
  const frames = new Map(); let next = 1;
  const oldRequest = global.requestAnimationFrame, oldCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = callback => { const id = next++; frames.set(id, callback); return id; };
  global.cancelAnimationFrame = id => frames.delete(id);
  const calls = {reset: [], snapshots: [], applied: [], labels: [], views: []};
  const source = {replaySeek: async () => seekResult(), replayChunk: async () => ({events: [], afterSeq: 1, hasMore: false}), replayResources: async () => ({available: true, saved: 0, missing: 0, missingURLs: []}), ...overrides};
  const target = {reset: async (...args) => {calls.reset.push(args);}, snapshot: (...args) => calls.snapshots.push(args), apply: (...args) => calls.applied.push(args), restoreScroll() {}};
  const controller = new ReplayController(source, target, {render() {}, view: value => calls.views.push(value), event: (...args) => calls.labels.push(args), resources() {}, error: error => {throw error;}});
  t.after(() => { controller.close(); global.requestAnimationFrame = oldRequest; global.cancelAnimationFrame = oldCancel; });
  return {controller, calls, async tick(time) {const scheduled = [...frames.values()]; frames.clear(); for (const callback of scheduled) callback(time); await new Promise(resolve => setImmediate(resolve));}, frames};
}
test('replay validates serialized node variants without copying the snapshot tree', () => {
  const original = snapshot();
  original.payload.tree.children.push({nodeId: 'e', nodeType: 1, nodeName: 'INPUT', namespaceURI: 'http://www.w3.org/1999/xhtml', attributes: {type: 'text'}, state: {value: '保持原值'}});
  const parsed = decodeReplayEvent(original);
  assert.equal(parsed.type, 'dom.snapshot');
  assert.equal(parsed.payload.tree, original.payload.tree);
  assert.equal(parsed.payload.tree.children[0].state.value, '保持原值');
});
test('replay rejects malformed snapshot and mutation nodes before DOM reconstruction', () => {
  for (const invalid of [null, {nodeType: 9}, {...tree(), children: [{nodeId: 'bad', nodeName: 'DIV', nodeType: 1, namespaceURI: null, attributes: {onclick: 42}}]}]) {
    assert.throws(() => decodeReplayEvent(event(1, 'dom.snapshot', {tree: invalid})), /有效节点树/);
  }
  assert.throws(() => decodeReplayEvent(event(2, 'dom.mutation', {records: [{type: 'childList', targetId: 'doc', added: [{nodeType: 1}], removed: []}]})), /无效节点/);
});
test('future event payloads remain untouched and do not enter the typed replay renderer', () => {
  const future = event(7, 'future.unknown', {arbitrary: ['data', {keep: true}]});
  const before = JSON.stringify(future);
  assert.equal(decodeReplayEvent(future), null);
  assert.equal(JSON.stringify(future), before);
});
test('frame host identity and nesting depth survive snapshot boundary validation', () => {
  const original = snapshot();
  original.payload.frames = [{tree: tree(), scope: {frameContexts: [{nodeId: 'outer'}, {nodeId: 'inner'}]}}, {tree: tree(), scope: {frameContexts: [{nodeId: 'outer'}]}}];
  const decoded = decodeReplayEvent(original);
  assert.deepEqual(decoded.payload.frameHosts, ['inner', 'outer']);
  assert.deepEqual(decoded.payload.frameDepths, [2, 1]);
});
test('a delayed seek cannot overwrite a newer seek', async t => {
  const first = deferred(); let calls = 0;
  const {controller, calls: observed} = fixture(t, {replaySeek: () => ++calls === 1 ? first.promise : Promise.resolve(seekResult(2))});
  const old = controller.open('session'); await controller.seek(200);
  first.resolve(seekResult(1)); await old;
  assert.equal(controller.position, 200);
  assert.deepEqual(observed.reset, [['session', 2, 2]]);
  assert.equal(controller.loaded, true);
});
test('closing during a pending seek prevents reconstruction and state updates', async t => {
  const pending = deferred(); const {controller, calls} = fixture(t, {replaySeek: () => pending.promise});
  const opening = controller.open('session'); controller.close(); pending.resolve(seekResult()); await opening;
  assert.equal(controller.active, false); assert.equal(controller.loaded, false);
  assert.equal(calls.reset.length, 0); assert.equal(calls.snapshots.length, 0);
});
test('pausing while a playback chunk is pending prevents late events from applying', async t => {
  const pending = deferred(); const result = seekResult(1); result.endSeq = 2;
  const {controller, calls, tick} = fixture(t, {replaySeek: async () => result, replayChunk: () => pending.promise});
  await controller.open('session'); await controller.play();
  await tick(performance.now() + 150); controller.pause();
  pending.resolve({events: [event(2, 'action.input', {form: {nodeId: 'input', value: 'late'}})], afterSeq: 2, hasMore: false});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.playing, false); assert.equal(calls.applied.length, 0);
});

test('form restoration retains output/button/numeric controls and excludes file input values', () => {
  const dom = new ReplayDOM({contentDocument: {readyState: 'complete', URL: 'file:///replay-frame.html'}}, () => {}, () => {});
  const controls = [
    {localName: 'output', value: ''}, {localName: 'button', value: ''},
    {localName: 'progress', value: 0}, {localName: 'input', type: 'file', value: ''},
  ];
  for (const [index, control] of controls.entries()) {
    Object.assign(control, {nodeType: 1, namespaceURI: 'http://www.w3.org/1999/xhtml'});
    dom.nodes.set(String(index), control);
    dom.form({nodeId: String(index), value: index === 2 ? 0.5 : 'recorded'});
  }
  assert.equal(controls[0].value, 'recorded'); assert.equal(controls[1].value, 'recorded');
  assert.equal(controls[2].value, 0.5); assert.equal(controls[3].value, '');
});
