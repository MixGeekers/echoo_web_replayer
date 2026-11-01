'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { SessionStore } = require('../out/session-store.cjs');
const { exportSession } = require('../out/exporter.cjs');

test('current event envelopes and unknown payloads remain readable and export byte-for-byte', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tracedock-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recordings = path.join(directory, 'recordings');
  const original = await new SessionStore(recordings).init();
  const session = await original.create('Current baseline', '', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' }, 'group-00000000-0000-4000-8000-000000000001');
  await original.update(session.id, {status:'stopped'});
  const filename = path.join(original.getSessionDirectory(session.id), 'timeline.jsonl');
  const facts = [
    {seq:1,type:'dom.snapshot',payload:{html:'<html><body>当前记录</body></html>',tree:{nodeType:9,nodeId:'n1',children:[]}}},
    {seq:2,type:'vendor.unknown',payload:['secret',null,42,{nested:{custom:'原样😀'}}],extension:{version:99}},
    {seq:3,type:'action.input',payload:null},
  ];
  for (const event of facts) Object.assign(event, {id:`${session.id}:${String(event.seq).padStart(8,'0')}`,sessionId:session.id,timestamp:session.startedAt,receivedAt:session.startedAt,elapsedMs:0,documentId:null,url:'',title:'',summary:''});
  const raw = Buffer.from(facts.map(value => JSON.stringify(value)).join('\r\n') + '\r\n');
  await fs.writeFile(filename, raw);
  const store = await new SessionStore(recordings).init();
  const page = await store.timeline({sessionId:session.id});
  assert.deepEqual(page.events.find(event => event.seq === 2).payload,facts[1].payload);
  const seek = await store.replaySeek({sessionId:session.id,targetSeq:3});
  assert.equal(seek.snapshot.seq,1);
  assert.equal(seek.snapshot.documentId,null);
  assert.equal(seek.snapshot.sessionId,session.id);
  assert.equal(seek.snapshot.url,'');
  const chunk = await store.replayChunk({sessionId:session.id,afterSeq:0,endSeq:3});
  assert.deepEqual(chunk.events.map(event => event.payload),facts.map(event => event.payload));
  assert.equal(chunk.events[1].extension.version,99);
  assert.equal(chunk.events[1].elapsedMs,0);
  assert.deepEqual(await fs.readFile(filename),raw);
  const capture = await store.capture(session.id);
  for (const encoding of ['full','delta']) {
    const destination = path.join(directory,`${encoding}.zip`);
    await exportSession({capture,sessionId:session.id,destination,encoding});
    const output = path.join(directory,`${encoding}-restored`);
    await promisify(execFile)(process.env.TRACEDOCK_PYTHON || 'python', [path.join(__dirname,'../out/restore.py'),destination,'--output',output]);
    assert.deepEqual(await fs.readFile(path.join(output,'timeline.jsonl')),raw);
  }
});
