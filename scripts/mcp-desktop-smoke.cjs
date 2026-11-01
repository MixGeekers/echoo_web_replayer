'use strict';

// Actual Electron UI + official MCP SDK client + spawned stdio sidecars.
// Isolated app/data snapshot: no mocks, test hooks, or existing user data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { _electron } = require('playwright-core');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', `mcp-desktop-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`);
const dataDir = path.join(output, 'data'), runtimeDir = path.join(output, 'app');
const steps = [], errors = [], logs = [], clients = new Set();
let desktop, ui, guest, server, origin, profileA, profileB, group, alpha, beta, humanRecord, agentRecord, recoveryRecord, config;
const cid = label => `${label}-${randomUUID()}`;
const api = (method, ...args) => ui.evaluate(({method,args}) => window.collector[method](...args), {method,args});
const state = () => api('getState');
const record = async id => (await state()).sessions.find(item => item.id === id);
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function step(label, action) { await action(); steps.push(label); console.log(`PASS ${label}`); }
async function raw(client, name, args = {}) { return client.callTool({name:`tracedock_${name}`,arguments:args}, undefined, {timeout:45000}); }
async function tool(client, name, args = {}) {
  const result = await raw(client,name,args);
  assert.equal(result.isError,false,`${name}: ${JSON.stringify(result.structuredContent || result.content)}`);
  assert.equal(result.structuredContent?.ok,true,`${name} returns structured success`);
  return result.structuredContent.data;
}
async function denied(client, name, args, code) {
  const result = await raw(client,name,args);
  assert.equal(result.isError,true,`${name} must fail`);
  assert.equal(result.structuredContent?.error?.code,code,JSON.stringify(result.structuredContent));
  return result.structuredContent;
}
async function launch() {
  const env = {...process.env,TRACEDOCK_DATA_DIR:dataDir}; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({executablePath:require('electron'),args:[runtimeDir],cwd:root,env,timeout:30000});
  desktop.process().stdout?.on('data',value=>logs.push(value.toString()));
  desktop.process().stderr?.on('data',value=>logs.push(value.toString()));
  ui = await until(()=>desktop.context().pages().find(page=>page.url().includes('/renderer/index.html')),'desktop shell');
  ui.setDefaultTimeout(10000); ui.on('pageerror',error=>errors.push(error.message));
  await ui.waitForFunction(()=>Boolean(window.collector?.mcpConfig));
  await until(async()=>!(await state()).browser.loading,'initial browser loads');
}
async function connect(id, name) {
  config = await api('mcpConfig');
  const args = [...config.args], index = args.indexOf('--client-id');
  if(index>=0)args[index+1]=id;else args.push('--client-id',id);
  const transport = new StdioClientTransport({command:config.command,args,env:{...process.env,...config.env},cwd:root,stderr:'pipe'});
  transport.stderr?.on('data',value=>logs.push(`[${id}] ${value}`));
  const client = new Client({name,version:'1.0.0'},{capabilities:{}});
  client.onerror = error => logs.push(`[client ${id}] ${error.message}\n`);
  await client.connect(transport); clients.add(client);
  await until(async()=>(await state()).mcp.connections.findLast(connection=>connection.clientId===id&&['pending','connected'].includes(connection.status)),`connection ${id}`);
  return client;
}
async function openPanel() {
  if(await ui.locator('#mcp-panel').isHidden())await ui.locator('#mcp-open-button').click();
}
async function closePanel() {
  if(await ui.locator('#mcp-panel').isVisible())await ui.locator('#mcp-close-button').click();
}
async function chooseClient(id) {
  await openPanel();
  const connection = await until(async()=>(await state()).mcp.connections.findLast(value=>value.clientId===id&&['pending','connected'].includes(value.status)),`select ${id}`);
  await ui.locator('#mcp-client-select').selectOption(connection.id); return connection;
}
async function grant(id, caps = []) {
  const connection = await chooseClient(id);
  if(!await ui.locator('#mcp-scope-details').getAttribute('open')) {
    if(!await ui.locator('#mcp-grant-form').isVisible())await ui.locator('#mcp-scope-details > summary').click();
  }
  const checkboxes = ui.locator('#mcp-profile-list input');
  for(let i=0;i<await checkboxes.count();i++)await checkboxes.nth(i).setChecked(await checkboxes.nth(i).getAttribute('value')===profileA);
  for(const cap of ['capture','browser','organize','export'])await ui.locator(`#mcp-permission-${cap}`).setChecked(caps.includes(cap));
  await ui.locator('#mcp-grant-button').click();
  await until(async()=>(await state()).mcp.connections.find(value=>value.id===connection.id)?.status==='connected',`grant ${id}`);
}
async function requestControl(client,id,target = profileA) {
  await denied(client,'control',{action:'acquire',profileId:target},'CONTROL_APPROVAL_REQUIRED');
  await chooseClient(id);
  await ui.locator('#mcp-control-approve').click();
  await until(async()=>(await state()).mcp.control?.profileId===target,'UI control approval');
  return tool(client,'control',{action:'acquire',profileId:target});
}
async function metadata(client,id) { return (await tool(client,'recording_inspect',{recordingId:id})).recording; }
async function controlRecording(client,id,action) {
  const current = await metadata(client,id);
  return tool(client,'recording_control',{action,recordingId:id,expectedRevision:current.revision,commandId:cid(action)});
}
async function observe(client=beta) { return tool(client,'observe',{profileId:profileA}); }
function element(observation,name) {
  const found=observation.nodes.find(node=>node.name===name); assert.ok(found,`observed ${name}: ${JSON.stringify(observation.nodes.map(n=>[n.role,n.name]))}`); return found;
}
function actionArgs(lease,observation,target) {
  return {profileId:profileA,controlLeaseId:lease.controlLeaseId,documentId:observation.documentId,frameRef:target.frameRef,ref:target.ref,commandId:cid('action')};
}
async function fixture() {
  await closePanel();
  await ui.locator('#address-input').fill(origin);
  await ui.locator('#address-input').press('Enter');
  guest=await until(()=>desktop.context().pages().find(page=>!page.isClosed()&&page.url()===`${origin}/`),'fixture guest');
  await guest.locator('#note').waitFor();
  await until(async()=>!(await state()).browser.loading,'fixture ready');
}
async function management(name) {
  await ui.locator('#management-dialog').waitFor({state:'visible'});
  if(name!==undefined)await ui.locator('#management-name').fill(name);
  await ui.locator('#management-confirm').click();
  await ui.locator('#management-dialog').waitFor({state:'hidden'});
}
async function nativeInputBlocked() {
  const bounds=await guest.locator('#verify').boundingBox(),before=await guest.locator('#count').textContent();
  await desktop.evaluate(({webContents},{url,bounds})=>{
    const wc=webContents.getAllWebContents().find(value=>value.getURL()===`${url}/`);
    if(!wc)throw new Error('missing live guest');
    const point={x:Math.round(bounds.x+bounds.width/2),y:Math.round(bounds.y+bounds.height/2),button:'left',clickCount:1};
    wc.sendInputEvent({type:'mouseDown',...point});wc.sendInputEvent({type:'mouseUp',...point});
  },{url:origin,bounds});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(await guest.locator('#count').textContent(),before,'physical input is blocked while Agent controls browser');
}
async function run() {
  await fs.mkdir(runtimeDir,{recursive:true});
  await fs.cp(path.join(root,'out'),path.join(runtimeDir,'out'),{recursive:true});
  await fs.copyFile(path.join(root,'package.json'),path.join(runtimeDir,'package.json'));
  const inventory={
    claims:['human browsing with incremental Agent evidence','Agent observe/action/capture loop','multiple readers with one writer','explicit profile authorization','takeover retains recording','disconnect pauses only Agent-owned capture','reconnect never regains control or resumes capture','export results survive disconnect/restart','destructive plan approval uses actual objects'],
    controls:['service enable/disable','config disclosure','client selector','profile scope/permission toggles','grant/deny','control approve/deny','takeover','disconnect/revoke','delete-plan approve','normal capture start/pause/resume/stop'],
    offHappyPaths:['ungranted scope and capability denied','stale refs and revoked leases rejected','duplicate commands do not duplicate records/actions','late export cancellation preserves completed ZIP'],
    visualStates:['off','pending grant','connected reader','control request','Agent working','human takeover','disconnected capture paused','minimum1100x720'],
    evidence:'Actual Electron UI plus official SDK over spawned stdio. State reads and fixture DOM assertions are inspection only; writes use human UI or public MCP tools. Native screenshots are captured separately in final visual QA.'
  };
  await fs.writeFile(path.join(output,'qa-inventory.json'),JSON.stringify(inventory,null,2));
  server=http.createServer((_request,response)=>{
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    response.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>人机协作验证</title><style>body{font:15px system-ui;padding:38px;color:#26364c;background:#f8faff}h1{font-size:24px}label{display:block;margin:20px 0}input,select{display:block;padding:10px;margin-top:6px;width:260px}button{padding:10px 20px;color:white;background:#2b5fff;border:0;border-radius:4px}output{display:block;margin-top:20px}</style></head><body><h1>订单协作验证</h1><label>核对备注<input id="note" aria-label="核对备注" value="等待填写"></label><label>配送方式<select id="shipping" aria-label="配送方式"><option value="standard">标准配送</option><option value="express">加急配送</option></select></label><button id="verify">检查订单信息</button><output id="result">尚未核对</output><span id="count">0</span><script>document.querySelector('#verify').onclick=()=>{document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1;document.querySelector('#result').textContent='核对完成：'+document.querySelector('#note').value};</script></body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); origin=`http://127.0.0.1:${server.address().port}`;
  await launch();
  await step('real UI opens local MCP and creates an explicit Session',async()=>{
    profileA=(await state()).activeProfileId;assert.ok(profileA);
    await ui.locator('#new-session-button').click();await management('人机协作验证');
    group=(await state()).sessionGroups.find(item=>item.name==='人机协作验证');assert.ok(group);
    await openPanel();await ui.locator('#mcp-service-button').click();
    await until(async()=>(await state()).mcp.enabled,'MCP enabled');
    await ui.locator('#mcp-setup > summary').click();
    assert.match(await ui.locator('#mcp-config').inputValue(),/mcpServers/);
    await ui.locator('#mcp-setup > summary').click();
  });
  await step('MCP handshake exposes 28 tools but no business data before real UI grants scope',async()=>{
    alpha=await connect('analysis-alpha','分析 Agent');
    assert.equal((await alpha.listTools()).tools.length,28);
    await denied(alpha,'state',{},'AUTH_REQUIRED');
    await grant('analysis-alpha');
    const current=await tool(alpha,'state');assert.equal(current.activeProfileId,profileA);
    await denied(alpha,'observe',{profileId:profileA},'PERMISSION_DENIED');
    beta=await connect('operator-beta','操作 Agent');await grant('operator-beta',['capture','browser','organize','export']);
    assert.equal((await state()).mcp.connections.filter(c=>c.status==='connected').length,2);
  });
  await step('human captures and operates while the read-only Agent incrementally reads evidence',async()=>{
    await fixture();await ui.locator('#start-button').click();await ui.locator('#session-name-input').fill('人工操作与 Agent 分析');await ui.locator('#confirm-session-button').click();
    humanRecord=await until(async()=>{const s=(await state()).session;return s?.status==='recording'&&s.snapshotCount>0&&s;},'human capture');
    const first=await tool(alpha,'timeline',{recordingId:humanRecord.id});
    await guest.locator('#note').fill('人工核验');await guest.locator('#verify').click();
    await until(async()=>{const result=await tool(alpha,'timeline',{recordingId:humanRecord.id,afterSeq:first.endSeq});return result.events.some(event=>event.type.startsWith('action'))&&result;},'incremental human events');
    const latest=await tool(alpha,'timeline',{recordingId:humanRecord.id});
    const event=latest.events.find(event=>event.type.startsWith('action'));assert.ok(event);
    assert.ok(await tool(alpha,'event',{recordingId:humanRecord.id,eventId:event.id}));
    assert.equal((await state()).mcp.control,null);
    assert.equal((await state()).mcp.captureOwner.connectionId,null);
    await denied(alpha,'recording_start',{sessionId:group.id,name:'Unauthorized capture',commandId:cid('denied')},'PERMISSION_DENIED');
  });
  await step('reader disconnect and credential reconnect preserve the human capture',async()=>{
    await chooseClient('analysis-alpha');await ui.locator('#mcp-disconnect-button').click();
    await until(async()=>(await state()).mcp.connections.findLast(c=>c.clientId==='analysis-alpha')?.status==='disconnected','reader disconnected');
    assert.equal((await record(humanRecord.id)).status,'recording');
    await tool(alpha,'state');
    assert.equal((await state()).mcp.control,null);assert.equal((await record(humanRecord.id)).status,'recording');
    await closePanel();await ui.locator('#stop-button').click();await until(async()=>(await record(humanRecord.id)).status==='stopped','human recording saved');
  });
  let lease, observation, clickArgs;
  await step('Agent control requires UI approval while other clients keep read access',async()=>{
    lease=await requestControl(beta,'operator-beta');
    assert.equal(lease.status,'active');assert.equal(await ui.locator('#mcp-takeover-button').isVisible(),true);
    assert.ok(await tool(alpha,'library_query',{profileId:profileA}));
    await grant('analysis-alpha',['browser']);
    await denied(alpha,'control',{action:'acquire',profileId:profileA},'CONTROL_BUSY');
    await grant('analysis-alpha');
    await denied(alpha,'control',{action:'acquire',profileId:profileA},'PERMISSION_DENIED');
    const current=await state();assert.notEqual(current.session?.status,'recording','control approval does not silently start capture');
    const commandId=cid('capture');const args={sessionId:group.id,name:'Agent 操作与同步采集',commandId};
    const first=await tool(beta,'recording_start',args),second=await tool(beta,'recording_start',args);assert.equal(first.recording.id,second.recording.id);agentRecord=first.recording;
    await until(async()=>(await record(agentRecord.id)).snapshotCount>0,'Agent initial snapshot');
    assert.ok((await state()).mcp.captureOwner.connectionId);
  });
  await step('Agent observes, fills, selects, clicks, verifies and records actual native actions',async()=>{
    observation=await observe();
    await tool(beta,'fill',{...actionArgs(lease,observation,element(observation,'核对备注')),value:'Agent 核验'});
    await tool(beta,'select',{...actionArgs(lease,observation,element(observation,'配送方式')),values:['express']});
    clickArgs=actionArgs(lease,observation,element(observation,'检查订单信息'));
    await tool(beta,'click',clickArgs);await tool(beta,'click',clickArgs);
    await tool(beta,'wait',{profileId:profileA,documentId:observation.documentId,text:'核对完成：Agent 核验'});
    assert.equal(await guest.locator('#count').textContent(),'2','one human and one Agent click; duplicate command does not click twice');
    assert.equal(await guest.locator('#shipping').inputValue(),'express');
    await nativeInputBlocked();
    const image=await raw(beta,'screenshot',{profileId:profileA,documentId:observation.documentId});assert.ok(image.content.some(item=>item.type==='image'));
    await until(async()=>(await tool(alpha,'timeline',{recordingId:agentRecord.id})).events.some(event=>event.type.startsWith('action')),'parallel reader sees Agent evidence');
  });
  await step('navigation invalidates old references without dispatching the old action',async()=>{
    await tool(beta,'navigate',{profileId:profileA,controlLeaseId:lease.controlLeaseId,action:'reload',commandId:cid('reload')});
    await guest.waitForFunction(()=>document.querySelector('#count')?.textContent==='0');
    await denied(beta,'click',{...clickArgs,commandId:cid('stale')},'STALE_REFERENCE');
    assert.equal(await guest.locator('#count').textContent(),'0');
    observation=await observe();
  });
  await step('human takeover immediately revokes the lease and keeps capture running through Agent disconnect',async()=>{
    await ui.locator('#mcp-takeover-button').click();
    await until(async()=>(await state()).mcp.control===null,'takeover releases lease');
    assert.equal((await state()).mcp.captureOwner.connectionId,null);assert.equal((await record(agentRecord.id)).status,'recording');
    await denied(beta,'click',actionArgs(lease,observation,element(observation,'检查订单信息')),'CONTROL_REVOKED');
    await closePanel();await guest.locator('#note').fill('人工修正');await guest.locator('#verify').click();
    assert.equal(await guest.locator('#count').textContent(),'1');
    await beta.close();clients.delete(beta);beta=null;
    await until(async()=>(await state()).mcp.connections.findLast(c=>c.clientId==='operator-beta')?.status==='disconnected','operator disconnect');
    assert.equal((await record(agentRecord.id)).status,'recording','takeover-owned human capture never pauses on old Agent loss');
    await ui.locator('#stop-button').click();await until(async()=>(await record(agentRecord.id)).status==='stopped','handover capture saved');
  });
  await step('reconnect retains action receipts but restores neither control nor capture',async()=>{
    beta=await connect('operator-beta','操作 Agent');
    const current=await tool(beta,'state');assert.equal(current.connection.control,null);
    const receipt=await tool(beta,'operation_get',{commandId:clickArgs.commandId});assert.equal(receipt.state,'succeeded');
    lease=await requestControl(beta,'operator-beta');
    recoveryRecord=(await tool(beta,'recording_start',{sessionId:group.id,name:'断线恢复采集',commandId:cid('recovery')})).recording;
    await until(async()=>(await record(recoveryRecord.id)).snapshotCount>0,'recovery initial snapshot');
    await controlRecording(beta,recoveryRecord.id,'pause');assert.equal((await record(recoveryRecord.id)).status,'paused');
    await controlRecording(beta,recoveryRecord.id,'resume');await controlRecording(beta,recoveryRecord.id,'snapshot');
    await beta.close();clients.delete(beta);beta=null;
    await until(async()=>(await record(recoveryRecord.id)).status==='paused','Agent-owned capture pauses on disconnect');
    assert.equal((await state()).mcp.control,null);
    beta=await connect('operator-beta','操作 Agent');await tool(beta,'state');
    assert.equal((await record(recoveryRecord.id)).status,'paused');assert.equal((await state()).mcp.control,null);
    await controlRecording(beta,recoveryRecord.id,'resume');assert.equal((await record(recoveryRecord.id)).status,'recording');
    await controlRecording(beta,recoveryRecord.id,'stop');assert.equal((await record(recoveryRecord.id)).status,'stopped');
    assert.equal((await state()).sessionGroups.find(item=>item.id===group.id).status,'open');
  });
  let exportId, exportPath;
  await step('background export result survives disconnect and late cancel preserves the committed ZIP',async()=>{
    const started=await tool(beta,'export_start',{recordingId:recoveryRecord.id,filename:'mcp-recovery.zip',encoding:'delta',compression:'deflate',commandId:cid('export')});exportId=started.operationId;assert.ok(exportId);
    await beta.close();clients.delete(beta);beta=null;
    beta=await connect('operator-beta','操作 Agent');
    const op=await until(async()=>{const result=await tool(beta,'operation_get',{operationId:exportId});if(result.state==='failed')throw new Error(JSON.stringify(result));return result.state==='succeeded'&&result;},'background export complete',30000);
    exportPath=op.result.path;assert.ok(exportPath);const zip=await fs.readFile(exportPath);assert.ok(zip.length>0);assert.equal(createHash('sha256').update(zip).digest('hex'),op.result.sha256);
    const late=await tool(beta,'operation_cancel',{operationId:exportId,commandId:cid('late-cancel')});assert.equal(late.state,'succeeded');assert.ok((await fs.stat(exportPath)).size>0);
    await denied(beta,'export_start',{recordingId:recoveryRecord.id,filename:'../escape.zip',commandId:cid('bad-path')},'INVALID_ARGUMENT');
  });
  await step('explicit profile scope blocks another environment and reserved control opens only the authorized target',async()=>{
    await closePanel();await ui.locator('#manage-profiles-button').click();await ui.locator('#create-profile-button').click();await management('未授权环境');await ui.locator('#profiles-done-button').click();
    profileB=(await state()).activeProfileId;assert.notEqual(profileB,profileA);
    await denied(beta,'library_query',{profileId:profileB},'PROFILE_FORBIDDEN');
    assert.equal((await tool(beta,'state')).activeProfileId,null);
    lease=await requestControl(beta,'operator-beta');assert.equal(lease.status,'reserved');
    const opened=await tool(beta,'profile_manage',{action:'open',profileId:profileA,controlLeaseId:lease.controlLeaseId,commandId:cid('open')});
    assert.equal(opened.control.status,'active');assert.notEqual(opened.control.controlLeaseId,lease.controlLeaseId);lease=opened.control;
    assert.equal((await state()).activeProfileId,profileA);
    await ui.locator('#mcp-takeover-button').click();
  });
  await step('Agent lifecycle commands and reviewed permanent deletion share the existing record protections',async()=>{
    const id=recoveryRecord.id;
    const mutate=async action=>{const current=(await tool(beta,'library_query',{profileId:profileA,state:'all'})).items.find(item=>item.id===id);assert.ok(current);return tool(beta,'library_update',{action,recordingIds:[id],expectedRevisions:{[id]:current.revision},commandId:cid(action)});};
    await mutate('archive');assert.equal((await record(id)).libraryState,'archived');
    await mutate('trash');await mutate('restore');assert.equal((await record(id)).libraryState,'archived');
    await mutate('unarchive');await mutate('trash');
    const current=await tool(beta,'library_query',{profileId:profileA,state:'trashed'});const target=current.items.find(item=>item.id===id);assert.ok(target);
    const plan=await tool(beta,'library_delete_plan',{recordingIds:[id],expectedRevisions:{[id]:target.revision}});
    const apply={planId:plan.planId,commandId:cid('delete')};
    await denied(beta,'library_delete_apply',apply,'DELETE_APPROVAL_REQUIRED');assert.ok(await record(id));
    await openPanel();await ui.locator('#mcp-delete-section').waitFor({state:'visible'});
    assert.ok(!(await ui.locator('#mcp-delete-list').textContent()).includes('[object Object]'));
    await ui.locator('#mcp-delete-list button').last().click();
    await tool(beta,'library_delete_apply',apply);assert.equal(await record(id),undefined);
    assert.ok(await record(humanRecord.id));assert.ok(await record(agentRecord.id));
  });
  await step('revocation requires fresh approval while closing local MCP releases every connection',async()=>{
    await chooseClient('analysis-alpha');await ui.locator('#mcp-revoke-button').click();
    await denied(alpha,'state',{},'AUTH_REQUIRED');
    await chooseClient('analysis-alpha');await ui.locator('#mcp-deny-button').click();
    await ui.locator('#mcp-service-button').click();
    await until(async()=>!(await state()).mcp.enabled,'service disabled');assert.equal((await state()).mcp.control,null);
    assert.equal((await state()).mcp.connections.some(connection=>connection.status==='connected'),false);
    await ui.locator('#mcp-service-button').click();await until(async()=>(await state()).mcp.enabled,'service reenabled');
  });
  await step('restart keeps approved grants and completed export results, with no inherited lease',async()=>{
    await Promise.all([...clients].map(client=>client.close().catch(()=>{})));clients.clear();alpha=beta=null;
    await desktop.close();desktop=null;await launch();
    assert.equal((await state()).mcp.control,null);assert.equal((await state()).mcp.enabled,true);
    beta=await connect('operator-beta','操作 Agent');
    const current=await tool(beta,'state');assert.equal(current.connection.control,null);
    const result=await tool(beta,'operation_get',{operationId:exportId});assert.equal(result.state,'succeeded');assert.equal(result.result.path,exportPath);
    assert.equal((await state()).sessions.filter(item=>item.sessionGroupId===group.id).length,2);
  });
  assert.deepEqual(errors,[]);
  const report={status:'passed',output,steps,rendererErrors:errors};await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
run().catch(async error=>{
  console.error(error);process.exitCode=1;
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:'failed',steps,error:error.message,stack:error.stack,rendererErrors:errors},null,2)).catch(()=>{});
}).finally(async()=>{
  await Promise.all([...clients].map(client=>client.close().catch(()=>{})));
  await desktop?.close().catch(()=>{});
  if(server)await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(output,'electron.log'),logs.join('')).catch(()=>{});
});
