'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMCPController } = require('../out/mcp-controller.cjs');
const permissions = (overrides={}) => ({read:true,capture:true,browser:true,organize:true,export:true,...overrides});
const deferred = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function setup(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tracedock-mcp-controller-'));
  let control, record=null, pauses=0, serial=Promise.resolve();
  const profiles=new Map([['profile-a',{id:'profile-a',name:'A'}],['profile-b',{id:'profile-b',name:'B'}]]);
  const runtime={profileId:'profile-a',recording:{currentSession:()=>record,pauseSession:async()=>{pauses++;if(record)record.status='paused';}}};
  const workspace={profiles:{get:id=>{if(!profiles.has(id))throw new Error('Unknown profile');return profiles.get(id);}},runtime:()=>runtime,requireRuntime:()=>runtime,
    notify:()=>{},reportError:error=>{throw error;},state:()=>({activeProfileId:runtime.profileId}),
    command:operation=>{const result=serial.then(()=>{control?.beforeCommand();return operation();});serial=result.catch(()=>{});return result;}};
  control=await createMCPController(workspace,directory,'instance-test');
  t.after(async()=>{await control.close();await fs.rm(directory,{recursive:true,force:true});});
  await control.command({action:'enable',enabled:true});
  async function connect(id,clientId=id,credential=null){return control.connect({connectionId:id,clientId,name:`Client ${id}`,credential});}
  async function grant(id,p=permissions(),profileIds=['profile-a']){return control.command({action:'grant',connectionId:id,profileIds,permissions:p});}
  async function lease(id,profileId='profile-a'){
    await assert.rejects(control.control(id,{action:'acquire',profileId}),{code:'CONTROL_APPROVAL_REQUIRED'});
    await control.command({action:'controlApprove',connectionId:id,profileId});
    return control.control(id,{action:'acquire',profileId});
  }
  return {control,workspace,runtime,directory,connect,grant,lease,pauses:()=>pauses,setRecord:r=>record=r?{profileId:runtime.profileId,...r}:null,record:()=>record};
}
test('pending clients cannot read business data until UI grants a Profile; credentials are not persisted in plaintext',async t=>{
  const h=await setup(t),token=await h.connect('one');
  assert.equal(token.pending,true);
  assert.throws(()=>h.control.state('one'),{code:'AUTH_REQUIRED'});
  assert.throws(()=>h.control.authorize('one','read','profile-a'),{code:'AUTH_REQUIRED'});
  await h.grant('one',permissions({capture:false,browser:false,organize:false,export:false}));
  assert.equal(h.control.state('one').connection.status,'connected');
  assert.throws(()=>h.control.authorize('one','read','profile-b'),{code:'PROFILE_FORBIDDEN'});
  assert.throws(()=>h.control.authorize('one','capture','profile-a'),{code:'PERMISSION_DENIED'});
  const stored=await fs.readFile(path.join(h.directory,'mcp-grants.json'),'utf8');assert.ok(!stored.includes(token.credential));
});
test('multiple readers coexist but only one Agent can hold browser control',async t=>{
  const h=await setup(t);await h.connect('one');await h.connect('two');await h.grant('one');await h.grant('two');
  h.control.authorize('one','read','profile-a');h.control.authorize('two','read','profile-a');
  const lease=await h.lease('one');assert.equal(lease.status,'active');
  await assert.rejects(h.control.control('two',{action:'acquire',profileId:'profile-a'}),{code:'CONTROL_BUSY'});
  assert.throws(()=>h.control.requireLease('two',{profileId:'profile-a',controlLeaseId:lease.controlLeaseId}),{code:'CONTROL_REVOKED'});
  h.control.requireLease('one',{profileId:'profile-a',controlLeaseId:lease.controlLeaseId});
});
test('human takeover keeps recording running and a later old-Agent disconnect cannot pause it',async t=>{
  const h=await setup(t);await h.connect('one');await h.grant('one');const lease=await h.lease('one');
  h.setRecord({id:'record-a',status:'recording'});h.control.recordingStarted('one','record-a');
  h.control.humanTakeover();await h.control.disconnected('one');
  assert.equal(h.pauses(),0);assert.equal(h.record().status,'recording');assert.equal(h.control.snapshot().captureOwner.connectionId,null);
  assert.throws(()=>h.control.requireLease('one',{profileId:'profile-a',controlLeaseId:lease.controlLeaseId}),{code:'AUTH_REQUIRED'});
  assert.equal(h.control.snapshot().control,null);
});
test('Agent disconnect pauses only its owned capture, preserving the business Session',async t=>{
  const h=await setup(t);await h.connect('one');await h.grant('one');await h.lease('one');
  h.setRecord({id:'record-a',sessionGroupId:'session-a',status:'recording'});h.control.recordingStarted('one','record-a');
  await h.control.disconnected('one');
  assert.equal(h.pauses(),1);assert.equal(h.record().status,'paused');assert.equal(h.record().sessionGroupId,'session-a');
  await h.connect('human-reader');await h.grant('human-reader');h.setRecord({id:'human-record',status:'recording'});h.control.humanRecordingStarted('human-record');
  await h.control.disconnected('human-reader');assert.equal(h.pauses(),1);assert.equal(h.record().status,'recording');
});
test('reconnecting restores grant only; lease and paused recording require explicit reacquire/resume',async t=>{
  const h=await setup(t),token=await h.connect('old','principal');await h.grant('old');const oldLease=await h.lease('old');
  h.setRecord({id:'record-a',status:'recording'});h.control.recordingStarted('old','record-a');await h.control.disconnected('old');
  const reconnect=await h.connect('new','principal',token.credential);assert.equal(reconnect.pending,false);assert.equal(h.control.state('new').control,null);assert.equal(h.record().status,'paused');
  assert.throws(()=>h.control.requireLease('new',{profileId:'profile-a',controlLeaseId:oldLease.controlLeaseId}),{code:'CONTROL_REVOKED'});
  const newLease=await h.lease('new');assert.notEqual(newLease.controlLeaseId,oldLease.controlLeaseId);assert.equal(h.record().status,'paused');
  h.control.recordingResumed('new','record-a');h.record().status='recording';await h.control.disconnected('new');assert.equal(h.pauses(),2);
});
test('stored client identity cannot reconnect with a wrong or missing credential',async t=>{
  const h=await setup(t),token=await h.connect('one','principal');await h.grant('one');
  await assert.rejects(h.connect('wrong','principal','incorrect'),{code:'INVALID_CREDENTIAL'});
  await assert.rejects(h.connect('missing','principal'),{code:'INVALID_CREDENTIAL'});
  const second=await h.connect('two','principal',token.credential);assert.equal(second.pending,false);
});
test('scope reduction and principal revocation cover every active connection of that principal',async t=>{
  const h=await setup(t),token=await h.connect('one','principal');await h.grant('one',permissions(),['profile-a','profile-b']);await h.connect('two','principal',token.credential);
  const lease=await h.lease('two');h.setRecord({id:'record-a',status:'recording'});h.control.recordingStarted('two','record-a');
  await h.grant('one',permissions({browser:false}),['profile-b']);
  assert.throws(()=>h.control.authorize('two','read','profile-a'),{code:'PROFILE_FORBIDDEN'});
  assert.throws(()=>h.control.requireLease('two',{profileId:'profile-b',controlLeaseId:lease.controlLeaseId}),{code:'PERMISSION_DENIED'});
  assert.equal(h.pauses(),1);
  await h.control.command({action:'revoke',connectionId:'one'});
  for(const id of ['one','two'])assert.throws(()=>h.control.authorize(id,'read','profile-b'),{code:'AUTH_REQUIRED'});
});
test('an authorization guard is rechecked after a command waits in the workspace queue',async t=>{
  const h=await setup(t);await h.connect('one');await h.grant('one');
  const barrier=deferred(), entered=deferred();let mutated=false;
  const blocker=h.workspace.command(()=>barrier.promise);
  const operation=h.control.run('one',async()=>{h.control.authorize('one','organize','profile-a');entered.resolve();return h.workspace.command(()=>{mutated=true;});});
  await entered.promise;await h.grant('one',permissions({organize:false}));barrier.resolve();await blocker;
  await assert.rejects(operation,{code:'PERMISSION_DENIED'});assert.equal(mutated,false);
});
test('opening a reserved target replaces the lease; human switching invalidates it instead',async t=>{
  const h=await setup(t);await h.connect('one');await h.grant('one',permissions(),['profile-a','profile-b']);
  const reserved=await h.lease('one','profile-b');assert.equal(reserved.status,'reserved');
  const opened=await h.control.run('one',async()=>{h.control.requireLease('one',{profileId:'profile-b',controlLeaseId:reserved.controlLeaseId});h.control.environmentChanging('profile-b');h.runtime.profileId='profile-b';return h.control.profileOpened('one','profile-b');});
  assert.equal(opened.status,'active');assert.notEqual(opened.controlLeaseId,reserved.controlLeaseId);
  assert.throws(()=>h.control.requireLease('one',{profileId:'profile-b',controlLeaseId:reserved.controlLeaseId}),{code:'CONTROL_REVOKED'});
  h.control.environmentChanging('profile-a');assert.equal(h.control.snapshot().control,null);
});
test('capture permission withdrawal pauses an existing Agent-owned recording',async t=>{
  const h=await setup(t);await h.connect('one');await h.grant('one');
  h.setRecord({id:'record-a',status:'recording'});h.control.recordingStarted('one','record-a');
  await h.grant('one',permissions({capture:false}));assert.equal(h.record().status,'paused');
});
test('disconnect while start is finishing cannot leave a new Agent recording unattended',async t=>{
  const h=await setup(t);await h.connect('one');await h.grant('one');await h.control.disconnected('one');
  h.setRecord({id:'record-a',status:'recording'});await h.control.recordingStarted('one','record-a');await h.workspace.command(()=>{});
  assert.equal(h.record().status,'paused');
});
test('expired control is unusable and reacquire pauses the old Agent capture before asking again',async t=>{
  const h=await setup(t);await h.connect('one');await h.grant('one');const lease=await h.lease('one');
  h.setRecord({id:'record-a',status:'recording'});h.control.recordingStarted('one','record-a');
  const originalNow=Date.now,expired=originalNow()+121000;
  try {
    Date.now=()=>expired;
    assert.throws(()=>h.control.requireLease('one',{profileId:'profile-a',controlLeaseId:lease.controlLeaseId}),{code:'CONTROL_REVOKED'});
    await assert.rejects(h.control.control('one',{action:'acquire',profileId:'profile-a'}),{code:'CONTROL_APPROVAL_REQUIRED'});
    assert.equal(h.record().status,'paused');assert.equal(h.control.snapshot().control,null);
  } finally {Date.now=originalNow;}
});
test('read-only clients can read while a writer is waiting and never receive its lease secret',async t=>{
  const h=await setup(t);await h.connect('writer');await h.connect('reader');await h.grant('writer');await h.grant('reader');
  const lease=await h.lease('writer'),entered=deferred(),release=deferred();
  const writing=h.control.run('writer',async()=>{entered.resolve();await release.promise;return 'written';});
  await entered.promise;
  let timeout;
  try {
    const state=await Promise.race([
      h.control.run('reader',async()=>{h.control.authorize('reader','read','profile-a');return h.control.state('reader');},true),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Read was blocked by write queue')),1000);}),
    ]);
    assert.deepEqual(state.control,{status:'busy',profileId:'profile-a'});
    assert.ok(!JSON.stringify(state).includes(lease.controlLeaseId),'another connection must not receive the control lease ID');
  } finally {clearTimeout(timeout);release.resolve();await writing;}
});
test('a read finishing after Profile authorization is narrowed rejects instead of returning old-scope data',async t=>{
  const h=await setup(t);await h.connect('reader');await h.grant('reader',permissions(),['profile-a','profile-b']);
  const entered=deferred(),release=deferred();let disclosed=false;
  const reading=h.control.run('reader',async()=>{
    h.control.authorize('reader','read','profile-a');entered.resolve();await release.promise;
    h.control.revalidateAuthorization();disclosed=true;return {recording:'profile-a-content'};
  },true);
  await entered.promise;
  await h.grant('reader',permissions(),['profile-b']);
  const rejected=assert.rejects(reading,{code:'PROFILE_FORBIDDEN'});release.resolve();await rejected;
  assert.equal(disclosed,false);
});
