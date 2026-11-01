'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
(async () => {
  const directory = path.join(root, 'output', `mcp-browser-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const html = `<!doctype html><html><body style="font:16px sans-serif;padding:20px">
    <label>Name <input id="name" value="before"></label><button id="check">Check order</button><output id="result">Waiting</output>
    <select aria-label="Delivery"><option value="standard">Standard</option><option value="express">Express</option></select>
    <button id="replace">Replace field</button><div id="shadow"></div><iframe src="/child" style="width:400px;height:150px"></iframe>
    <div style="height:1200px"></div><button id="last">Last button</button>
    <script>let clicks=0;document.querySelector('#check').onclick=()=>document.querySelector('#result').textContent='Checked '+(++clicks);
    document.querySelector('#replace').onclick=()=>document.querySelector('#name').outerHTML='<input id="name" aria-label="Replacement" value="new">';
    const sr=document.querySelector('#shadow').attachShadow({mode:'open'});sr.innerHTML='<button>Shadow action</button><output></output>';sr.querySelector('button').onclick=()=>sr.querySelector('output').textContent='Shadow done';</script></body></html>`;
  const server = http.createServer((req, res) => {res.setHeader('Content-Type', 'text/html');res.end(req.url === '/child' ? '<button onclick="this.textContent=\'Frame done\'">Frame action</button>' : html);});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const main = path.join(directory, 'main.cjs');
  await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const win=new BrowserWindow({width:1000,height:700,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});await win.loadURL(${JSON.stringify(url)});const adapter=require(${JSON.stringify(path.join(root,'out/mcp-browser.cjs'))});globalThis.agentBrowser=adapter.createAgentBrowser({getWebContents:()=>win.webContents});win.webContents.on('before-input-event',(e)=>{if(!adapter.isAgentInputDispatch(win.webContents))e.preventDefault();});win.webContents.on('before-mouse-event',(e)=>{if(!adapter.isAgentInputDispatch(win.webContents))e.preventDefault();});});app.on('window-all-closed',()=>app.quit());`);
  let app;
  const checks = [];
  try {
    app = await _electron.launch({args:[main], env: {...process.env, ELECTRON_RUN_AS_NODE: ''}});
    await app.firstWindow();
    await (await app.firstWindow()).waitForLoadState();
    await app.evaluate(async()=>{for(let i=0;i<100&&!globalThis.agentBrowser;i++)await new Promise(r=>setTimeout(r,20));});
    const call = async (action, input = {}) => app.evaluate(async (_electron,{action,input}) => {
      try {return {data:await globalThis.agentBrowser.call(action,input,()=>{})};}catch(e){return {error:{code:e.code,message:e.message,outcome:e.outcome}};}
    }, {action,input});
    const observe = async () => {const r=await call('observe');assert.ok(r.data,JSON.stringify(r));return r.data;};
    let state = await observe();
    const node = name => {const n=state.nodes.find(n=>n.name===name);assert.ok(n,`Missing ${name}: ${state.nodes.map(n=>n.name)}`);return {documentId:state.documentId,ref:n.ref,frameRef:n.frameRef};};
    const nameRef = node('Name');
    assert.equal((await call('fill',{...nameRef,value:'Agent filled'})).data.verification,'value_matched');checks.push('trusted text fill');
    assert.ok((await call('click',node('Check order'))).data);assert.ok((await call('wait',{documentId:state.documentId,text:'Checked 1'})).data.matched);checks.push('click and wait verification');
    assert.deepEqual((await call('select',{...node('Delivery'),values:['express']})).data.selected,['express']);checks.push('native select');
    assert.ok((await call('click',node('Shadow action'))).data);checks.push('open Shadow DOM click');
    assert.ok((await call('click',node('Frame action'))).data);checks.push('same-origin iframe click');
    assert.ok((await call('press',{...node('Check order'),key:'Enter'})).data);assert.ok((await call('wait',{documentId:state.documentId,text:'Checked 2'})).data.matched);checks.push('keyboard activation');
    assert.ok((await call('click',node('Replace field'))).data);assert.equal((await call('fill',{...nameRef,value:'stale'})).error.code,'STALE_REFERENCE');checks.push('stale element rejected');
    assert.equal((await call('click',node('Last button'))).error.code,'NOT_ACTIONABLE');checks.push('offscreen target rejected');
    assert.ok((await call('scroll',{documentId:state.documentId,direction:'down',amount:1500})).data);checks.push('trusted scroll');
    const screenshot=await call('screenshot',{documentId:state.documentId});assert.equal(screenshot.data.image.mimeType,'image/jpeg');assert.ok(screenshot.data.image.data.length>1000);checks.push('screenshot image');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.reload());await new Promise(r=>setTimeout(r,200));
    assert.equal((await call('click',node('Check order'))).error.code,'STALE_REFERENCE');checks.push('navigation invalidates document');
    state=await observe();
    const guarded = await app.evaluate(async (_electron,input)=>{let valid=true;setTimeout(()=>valid=false,20);try{await globalThis.agentBrowser.call('click',input,()=>{if(!valid)throw Object.assign(new Error('revoked'),{code:'CONTROL_REVOKED'});});return 'unexpected';}catch(e){return e.code;}},node('Check order'));
    assert.equal(guarded,'CONTROL_REVOKED');assert.ok((await call('wait',{documentId:state.documentId,text:'Waiting'})).data.matched);checks.push('takeover during actionability wait prevents dispatch');
    await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({checks},null,2));console.log(JSON.stringify({passed:checks.length,checks,directory},null,2));
  } finally {
    if(app){await app.evaluate(()=>globalThis.agentBrowser?.dispose()).catch(()=>{});await app.close();}
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
