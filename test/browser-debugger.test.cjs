'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { acquireBrowserDebugger } = require('../out/browser-debugger.cjs');
function fixture(initial = false) {
  const debugger_ = new EventEmitter();
  let attached = initial, attaches = 0, detaches = 0;
  debugger_.isAttached = () => attached;
  debugger_.attach = () => { assert.equal(attached, false); attached = true; attaches++; };
  debugger_.detach = () => { attached = false; detaches++; debugger_.emit('detach', {}, 'released'); };
  debugger_.sendCommand = async method => ({ method });
  return { host: { debugger: debugger_ }, debug: debugger_, stats: () => ({ attached, attaches, detaches }) };
}
test('resource capture and Agent share one debugger; closing one owner leaves the other usable', async () => {
  const f = fixture(), capture = acquireBrowserDebugger(f.host), agent = acquireBrowserDebugger(f.host);
  assert.equal(f.stats().attaches, 1);
  let resourceEvents = 0, agentEvents = 0;
  capture.onMessage(() => resourceEvents++); agent.onMessage(() => agentEvents++);
  f.debug.emit('message', {}, 'Network.loadingFinished', {});
  capture.release();
  assert.deepEqual(await agent.sendCommand('Page.getFrameTree'), { method: 'Page.getFrameTree' });
  f.debug.emit('message', {}, 'Page.frameNavigated', {});
  assert.equal(resourceEvents, 1); assert.equal(agentEvents, 2);
  assert.equal(f.stats().detaches, 0);
  agent.release(); agent.release();
  assert.deepEqual(f.stats(), { attached: false, attaches: 1, detaches: 1 });
  assert.equal(f.debug.listenerCount('message'), 0); assert.equal(f.debug.listenerCount('detach'), 0);
});
test('external debugger detach invalidates all owners without silently reconnecting', async () => {
  const f = fixture(), capture = acquireBrowserDebugger(f.host), agent = acquireBrowserDebugger(f.host);
  f.debug.detach();
  await assert.rejects(agent.sendCommand('Input.insertText'), /断开/);
  assert.throws(() => acquireBrowserDebugger(f.host), /断开/);
  capture.release(); agent.release();
  const reopened = acquireBrowserDebugger(f.host);
  assert.equal(f.stats().attaches, 2); reopened.release();
});
test('a debugger attachment owned externally is not detached on last release', () => {
  const f = fixture(true), owner = acquireBrowserDebugger(f.host);
  owner.release(); assert.deepEqual(f.stats(), { attached: true, attaches: 0, detaches: 0 });
});
