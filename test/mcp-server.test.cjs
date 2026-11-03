const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {once}=require('node:events');
const {createMCPServer}=require('../out/mcp-server.cjs');
async function socketTo(endpoint){const socket=net.createConnection(endpoint);socket.setEncoding('utf8');socket.on('error',()=>{});await once(socket,'connect');let buffer='',nextId=0;const pending=new Map();socket.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);const message=JSON.parse(line);pending.get(message.id)?.(message);pending.delete(message.id);}});return {socket,call:(method,params)=>new Promise(resolve=>{const id=++nextId;pending.set(id,resolve);socket.write(JSON.stringify({id,method,params})+'\n');})};}
test('local transport requires owner discovery secret and server-issued client credentials before calls',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tracedock-rpc-'));let connected=0,called=0,disconnected=0;
  const server=await createMCPServer({root,instanceId:'instance-a',onConnect:async h=>{connected++;assert.equal(h.credential,null);return {credential:'server-token',pending:true,pairingCode:'ABC123'};},onDisconnect:async()=>{disconnected++;},onCall:async(id,name,args)=>{called++;return {id,name,args};}});
  t.after(async()=>{await server.close();await fs.rm(root,{recursive:true,force:true});});
  const discovery=JSON.parse(await fs.readFile(server.discoveryPath,'utf8'));assert.equal(discovery.instanceId,'instance-a');if(process.platform!=='win32')assert.equal((await fs.stat(server.discoveryPath)).mode&0o777,0o600);
  const first=await socketTo(discovery.endpoint);const unauth=await first.call('call',{name:'tracedock_state',arguments:{}});assert.match(unauth.error.message,/Handshake/);assert.equal(called,0);
  const bad=await first.call('hello',{secret:'bad',clientId:'agent',name:'Agent',credential:null});assert.match(bad.error.message,/handshake/);assert.equal(connected,0);first.socket.destroy();
  const second=await socketTo(discovery.endpoint);const hello=await second.call('hello',{secret:discovery.secret,clientId:'agent',name:'Agent',credential:null});assert.equal(hello.result.credential,'server-token');assert.equal(hello.result.pairingCode,'ABC123');assert.equal(hello.result.pending,true);
  const result=await second.call('call',{name:'tracedock_state',arguments:{}});assert.equal(result.result.name,'tracedock_state');assert.equal(called,1);assert.equal(result.result.id,hello.result.connectionId);
  const closed=once(second.socket,'close');server.disconnect(hello.result.connectionId);await closed;for(let i=0;i<100&&disconnected===0;i++)await new Promise(r=>setTimeout(r,20));assert.equal(disconnected,1);
});

test('stdio initialization and concurrent first calls await the authenticated connection',async t=>{
  const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tracedock-stdio-'));let handshakes=0,calls=0;
  const server=await createMCPServer({root,instanceId:'stdio-instance',onConnect:async()=>{
    handshakes++;await new Promise(resolve=>setTimeout(resolve,80));return {credential:'test-issued-credential',pending:false};
  },onDisconnect:()=>{},onCall:async()=>{calls++;return {isError:false,content:[{type:'text',text:'connected'}],structuredContent:{ok:true,requestId:'test-request',outcome:'read',data:{ready:true}}};}});
  const client=new Client({name:'Immediate client',version:'1.0'},{capabilities:{}});
  t.after(async()=>{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(__dirname,'../out/mcp-stdio.cjs'),'--discovery',server.discoveryPath,'--client-id','immediate'],stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  await client.connect(transport);
  const results=await Promise.all(Array.from({length:6},()=>client.callTool({name:'tracedock_state',arguments:{}})));
  assert.equal(handshakes,1);assert.equal(calls,6);
  for(const result of results){assert.equal(result.isError,false);assert.equal(result.structuredContent.data.ready,true);}
});
