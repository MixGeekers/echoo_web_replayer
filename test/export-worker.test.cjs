'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracedock-worker-contract-'));
const output = path.join(temporary, 'messages.cjs');
buildSync({ entryPoints: [path.join(__dirname, '../src/main/export/messages.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { readWorkerData, readWorkerMessage, readWorkerCommand } = require(output);
test.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
function startup() {
  return {sessionId:'s', destination:'recording.zip', encoding:'delta', compression:'deflate', capture:{
    metadata:{id:'s',name:'test',status:'stopped',startedAt:'2026-11-01',eventCount:0,actionCount:0,mutationCount:0,snapshotCount:0,lastSeq:0},
    timelinePath:'timeline.jsonl',byteLength:0,capturedAt:'2026-11-01',
  }};
}
test('worker startup validates captured byte boundaries and accepts pre-resource captures', () => {
  assert.equal(readWorkerData(startup()).capture.byteLength,0);
  for (const byteLength of [-1,1.5,'0',Infinity]) {
    const input = startup(); input.capture.byteLength = byteLength;
    assert.throws(() => readWorkerData(input), /非负安全整数/);
  }
  const wrongSession = startup(); wrongSession.sessionId = 'another';
  assert.throws(() => readWorkerData(wrongSession), /会话不一致/);
  const missingResourcePath = startup(); missingResourcePath.capture.resourceBytes = 100;
  assert.throws(() => readWorkerData(missingResourcePath), /索引路径/);
});
test('worker transport rejects malformed reply variants before publishing progress or completing an export', () => {
  for (const message of [null,{}, {type:'other'}, {type:'progress',progress:{phase:'archive',bytesRead:'42'}}, {type:'result',result:{path:'recording.zip'}}, {type:'error',error:{name:'Error',message:42}}]) {
    assert.throws(() => readWorkerMessage(message));
  }
  const progress = readWorkerMessage({type:'progress',progress:{phase:'archive',bytesRead:42,totalBytes:100}});
  assert.equal(progress.type,'progress'); assert.equal(progress.progress.bytesRead,42);
  const failure = readWorkerMessage({type:'error',error:{name:'AbortError',message:'canceled',stack:'trace'}});
  assert.equal(failure.error.name,'AbortError'); assert.equal(failure.error.stack,'trace');
});
test('worker command channel admits only cancellation', () => {
  assert.deepEqual(readWorkerCommand({type:'cancel'}),{type:'cancel'});
  for (const command of [null,{}, {type:'progress'}, {type:'result'}, {type:42}]) assert.throws(() => readWorkerCommand(command));
});
