import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../workspace";
import type { MCPActivity, MCPCapability, MCPCommand, MCPConnection, MCPControl, MCPDeletePlan, MCPOperation, MCPPermissions, MCPState } from "../../shared/contracts/mcp";
import { object } from "../../shared/runtime";

const none = (): MCPPermissions => ({read:false,capture:false,browser:false,organize:false,export:false});
const fail = (code: string, message: string): never => {throw Object.assign(new Error(message), {code,outcome:"not_executed",recovery:"read_state_then_request_authorization"});};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
interface Grant {clientId: string; name: string; tokenHash: string; profileIds: string[]; permissions: MCPPermissions; approved: boolean;}
interface Context {connectionId: string; guards: Array<()=>void>; authorizations: Array<()=>void>;}
export async function createMCPController(workspace: Workspace, dataRoot: string, instanceId: string) {
  const file = path.join(dataRoot,"mcp-grants.json");
  let enabled=false, browserEpoch=1, control: MCPControl|null=null;
  const connections=new Map<string,MCPConnection>(), grants=new Map<string,Grant>(), activity:MCPActivity[]=[], plans=new Map<string,MCPDeletePlan>();
  const context=new AsyncLocalStorage<Context|null>();
  let owner: MCPState["captureOwner"]=null, transportDisconnect: (id:string)=>void=()=>{};
  let operations: {listForUI:()=>MCPOperation[]; cancelForUI:(id:string)=>unknown;revealForUI?:(id:string)=>unknown}={listForUI:()=>[],cancelForUI:()=>{}};
  let writeQueue=Promise.resolve(), toolQueue:Promise<unknown>=Promise.resolve(), stopped=false;
  await fs.mkdir(dataRoot,{recursive:true,mode:0o700});
  try {
    const stored=JSON.parse(await fs.readFile(file,"utf8"));
    enabled=stored.enabled===true;
    for(const g of stored.grants??[]) if(typeof g.clientId==="string"&&typeof g.tokenHash==="string"&&Array.isArray(g.profileIds)) grants.set(g.clientId,g);
  } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  function persist() {
    const contents=JSON.stringify({enabled,grants:[...grants.values()]});
    writeQueue=writeQueue.catch(()=>{}).then(async()=>{await fs.writeFile(file+".tmp",contents,{mode:0o600});await fs.rename(file+".tmp",file);});
    return writeQueue;
  }
  function log(actor:string,message:string,detail?:string) {
    activity.unshift({id:randomUUID(),at:new Date().toISOString(),actor,message,...(detail?{detail}: {})});
    activity.splice(80);workspace.notify();
  }
  const current=()=>workspace.runtime()?.recording.currentSession()??null;
  function snapshot(): MCPState {
    const record=current();
    if(!record||!["recording","paused"].includes(record.status)) owner=null;
    else if(owner?.recordingId!==record.id) owner={recordingId:record.id,connectionId:null};
    return {enabled,instanceId,connections:[...connections.values()].map(c=>({...c,profileIds:[...c.profileIds],permissions:{...c.permissions}})),control:control?{...control}:null,captureOwner:owner?{...owner}:null,activity:[...activity],operations:operations.listForUI(),deletePlans:[...plans.values()].filter(p=>Date.parse(p.expiresAt)>Date.now())};
  }
  function connection(id:string) {const c=connections.get(id);if(!c) return fail("CONNECTION_UNKNOWN","连接已失效，请重新连接");return c;}
  function checkAuth(id:string,cap:MCPCapability,profileId?:string) {
    if(stopped)return fail("APP_CLOSING","应用正在退出");
    const c=connection(id);
    if(!enabled||c.status!=="connected")return fail("AUTH_REQUIRED","请在 Agent 连接面板确认连接授权");
    if(!c.permissions[cap])return fail("PERMISSION_DENIED",`尚未授权 ${cap} 能力`);
    if(profileId&&!c.profileIds.includes(profileId))return fail("PROFILE_FORBIDDEN","目标 Profile 不在授权范围内");
  }
  function authorize(id:string,cap:MCPCapability,profileId?:string) {
    checkAuth(id,cap,profileId);
    context.getStore()?.authorizations.push(()=>checkAuth(id,cap,profileId));
  }
  function checkLease(id:string,args:Record<string,unknown>) {
    const lease=control;
    checkAuth(id,"browser",typeof args.profileId==="string"?args.profileId:undefined);
    if(!lease||lease.connectionId!==id||Date.parse(lease.expiresAt)<=Date.now())return fail("CONTROL_REVOKED","网页控制权已释放，请重新申请");
    if(args.controlLeaseId!==lease.leaseId&&args.leaseId!==lease.leaseId)return fail("CONTROL_REVOKED","请使用最新的控制租约");
    if(args.profileId!==undefined&&args.profileId!==lease.profileId)return fail("TARGET_CHANGED","租约与目标 Profile 不一致");
    if(args.contextRevision!==undefined&&args.contextRevision!==browserEpoch)return fail("TARGET_CHANGED","浏览环境已变化，请重新读取状态");
    if(lease.browserEpoch!==browserEpoch)return fail("TARGET_CHANGED","浏览环境已变化");
  }
  function requireLease(id:string,args:Record<string,unknown>) {checkLease(id,args);context.getStore()?.guards.push(()=>checkLease(id,args));}
  function revokeLease(reason:string) {const old=control;control=null;if(old){browserEpoch++;log("系统",reason);}return old;}
  async function pauseOwned(id:string) {
    // Never pause a human recording, including one handed over before this disconnect.
    const captured=owner;
    if(captured?.connectionId!==id)return;
    await context.run(null,()=>workspace.command(async()=>{
      if(owner?.connectionId!==id||owner.recordingId!==captured.recordingId)return;
      const record=current();
      if(record?.id===captured.recordingId&&record.status==="recording") {
        await workspace.requireRuntime().recording.pauseSession();log("系统","Agent 采集已暂停","已保存记录保留；重连不会自动继续采集");
      }
    }));
  }
  async function disconnected(id:string) {
    const c=connections.get(id);if(!c)return;
    if(c.status!=="revoked")c.status="disconnected";
    delete c.requestedControl;
    if(control?.connectionId===id)revokeLease("连接中断，控制权已释放");
    log(c.name,"连接已断开","Session 保持打开，后台导出继续");
    await pauseOwned(id);
  }
  async function connect(hello:{connectionId:string;clientId:string;name:string;credential:string|null}) {
    if(!enabled)return fail("SERVICE_DISABLED","请先在 TraceDock 开启本地 MCP");
    if(stopped)return fail("APP_CLOSING","应用正在退出");
    if(connections.size>128)for(const [id,c]of connections)if(c.status==="disconnected"||c.status==="revoked")connections.delete(id);
    if([...connections.values()].filter(c=>c.status==="pending").length>=16)return fail("TOO_MANY_REQUESTS","待确认连接过多");
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(hello.clientId))return fail("INVALID_CLIENT","无效客户端标识");
    let g=grants.get(hello.clientId),credential=hello.credential??"";
    if(g){const actual=Buffer.from(digest(credential)),expected=Buffer.from(g.tokenHash);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return fail("INVALID_CREDENTIAL","客户端凭证不匹配；请使用新的客户端标识重新配对");}
    else {credential=randomBytes(32).toString("base64url");g={clientId:hello.clientId,name:hello.name.slice(0,100),tokenHash:digest(credential),profileIds:[],permissions:none(),approved:false};grants.set(hello.clientId,g);await persist();}
    const c:MCPConnection={id:hello.connectionId,clientId:g.clientId,name:hello.name.slice(0,100)||g.name,pairingCode:randomBytes(3).toString("hex").toUpperCase(),status:g.approved?"connected":"pending",profileIds:[...g.profileIds],permissions:{...g.permissions},lastSeenAt:new Date().toISOString()};
    connections.set(c.id,c);log(c.name,g.approved?"重新连接，控制权仍属于你":"请求首次连接",c.pairingCode);
    return {credential,pending:!g.approved,pairingCode:c.pairingCode};
  }
  function state(id:string) {
    const c=connection(id);checkAuth(id,"read");
    const visibleControl=control?.connectionId===id?{...control}:control?{status:"busy",profileId:c.profileIds.includes(control.profileId)?control.profileId:null}:null;
    const visibleCapture=current()&&c.profileIds.includes(current()!.profileId)?owner:null;
    return {instanceId,connection:{...c},contextRevision:browserEpoch,control:visibleControl,captureOwner:visibleCapture,capabilities:{multipleReaders:true,singleWriter:true,mainFrame:true,sameOriginFrames:true,openShadowDOM:true,crossOriginFrames:false,multiWindow:false,arbitraryJavaScript:false},recovery:"重连后先读取状态与任务；重新申请控制，明确继续采集"};
  }
  async function controlCall(id:string,args:Record<string,unknown>) {
    const action=args.action,profileId=String(args.profileId??"");
    authorize(id,"browser",profileId);
    if(action==="release"){if(control?.connectionId===id){revokeLease("Agent 已释放控制权");await pauseOwned(id);}return {released:true};}
    if(action==="renew"){requireLease(id,args);control!.expiresAt=new Date(Date.now()+120_000).toISOString();workspace.notify();return {...control,controlLeaseId:control!.leaseId,contextRevision:browserEpoch};}
    if(action!=="acquire")return fail("INVALID_ARGUMENT","无效的控制操作");
    workspace.profiles.get(profileId);
    if(control&&Date.parse(control.expiresAt)<=Date.now()){const old=revokeLease("控制权已到期");if(old)await pauseOwned(old.connectionId);}
    if(control?.connectionId===id&&control.profileId===profileId)return {...control,controlLeaseId:control.leaseId,contextRevision:browserEpoch};
    if(control)return fail("CONTROL_BUSY","另一 Agent 正在操作；可由用户在协作条接管");
    const c=connection(id);c.requestedControl={profileId,...(typeof args.sessionId==="string"?{sessionId:args.sessionId}:{})};log(c.name,"请求网页控制",workspace.profiles.get(profileId).name);
    return fail("CONTROL_APPROVAL_REQUIRED","请在 Agent 连接面板允许本次控制，再次调用 acquire 取得租约");
  }
  function profileOpened(id:string,profileId:string) {
    if(!control||control.connectionId!==id||control.profileId!==profileId)return fail("CONTROL_REVOKED","目标环境的预留控制权已撤销");
    control={...control,leaseId:randomUUID(),status:"active",browserEpoch,expiresAt:new Date(Date.now()+120_000).toISOString()};
    log(connection(id).name,"已打开授权环境",workspace.profiles.get(profileId).name);
    return {...control,controlLeaseId:control.leaseId,contextRevision:browserEpoch};
  }
  function recordingStarted(id:string,recordingId:string){
    owner={recordingId,connectionId:id};const c=connection(id);workspace.notify();
    if(!enabled||c.status!=="connected"||!c.permissions.capture||!c.profileIds.includes(current()?.profileId??""))void pauseOwned(id).catch(workspace.reportError);
  }
  function environmentChanging(target:string|null) {
    browserEpoch++;
    const actor=context.getStore()?.connectionId;
    if(control&&actor===control.connectionId&&target===control.profileId){control.status="reserved";control.browserEpoch=browserEpoch;}
    else if(control){control=null;log("系统","环境已切换，旧控制权失效");}
  }
  function beforeCommand(){const c=context.getStore();if(c){if(connection(c.connectionId).status!=="connected")fail("AUTH_REQUIRED","连接已断开");for(const guard of [...c.authorizations,...c.guards])guard();}}
  function humanTakeover(){revokeLease("人工已接管，采集继续");if(owner)owner.connectionId=null;workspace.notify();}
  function assertHumanControl(){if(control?.status==="active"&&Date.parse(control.expiresAt)>Date.now())fail("CONTROL_HELD","Agent 正在操作，请先点击“立即接管”");}
  function proposeDeletion(id:string,raw:unknown){
    authorize(id,"organize");const p=object(raw),planId=String(p.id??p.planId??"");if(!planId)return fail("INVALID_PLAN","删除计划缺少 ID");
    let plan=plans.get(planId);if(!plan){plan={id:planId,connectionId:id,summary:String(p.summary??"彻底删除选中的 Session 与采集记录"),items:Array.isArray(p.items)?p.items.map(value=>{if(typeof value==="string")return value;const item=object(value);return [item.kind??item.type,item.name,item.id].filter(Boolean).join(" · ");}):[],expiresAt:typeof p.expiresAt==="string"?p.expiresAt:new Date(Date.now()+300000).toISOString(),approved:false};plans.set(planId,plan);log(connection(id).name,"请求彻底删除确认",plan.summary);}return plan;
  }
  async function approveDeletion(id:string,raw:unknown){const plan=proposeDeletion(id,raw);if(plan.connectionId!==id||Date.parse(plan.expiresAt)<=Date.now()||!plan.approved)fail("DELETE_APPROVAL_REQUIRED","请在连接面板核对删除范围并确认；计划到期后需重新预览");}
  async function command(input:MCPCommand) {
    if(input.action==="enable"){enabled=input.enabled===true;await persist();if(!enabled){const ids=[...connections.keys()];for(const id of ids){transportDisconnect(id);await disconnected(id);}}log("你",enabled?"本地 MCP 已开启":"本地 MCP 已关闭");}
    else if(input.action==="takeover")humanTakeover();
    else if(input.action==="approveDelete"){const p=plans.get(input.planId);if(!p||Date.parse(p.expiresAt)<=Date.now())return fail("PLAN_EXPIRED","删除计划已过期");p.approved=true;log("你","已确认本次删除范围",p.summary);}
    else if(input.action==="cancelOperation")await operations.cancelForUI(input.operationId);
    else if(input.action==="revealOperation")await operations.revealForUI?.(input.operationId);
    else {
      const c=connection(input.connectionId),g=grants.get(c.clientId)!;
      if(input.action==="grant"){
        if(c.status!=="pending"&&c.status!=="connected")fail("CONNECTION_CLOSED","请等待客户端重新连接后授权");
        const ids=[...new Set(input.profileIds)];if(!ids.length)fail("PROFILE_REQUIRED","至少选择一个 Profile");ids.forEach(id=>workspace.profiles.get(id));
        const permissions=none();for(const key of Object.keys(permissions) as MCPCapability[])permissions[key]=input.permissions[key]===true;permissions.read=true;
        g.approved=true;g.profileIds=ids;g.permissions=permissions;c.status="connected";
        for(const entry of connections.values())if(entry.clientId===c.clientId){entry.profileIds=[...ids];entry.permissions={...permissions};}
        if(control&&connection(control.connectionId).clientId===c.clientId&&(!ids.includes(control.profileId)||!permissions.browser)){const old=revokeLease("授权范围已更新");if(old)await pauseOwned(old.connectionId);}
        if(owner?.connectionId&&connections.get(owner.connectionId)?.clientId===c.clientId&&(!permissions.capture||!ids.includes(current()?.profileId??"")))await pauseOwned(owner.connectionId);
        await persist();log("你","已授权连接",c.name);
      } else if(input.action==="controlApprove"){
        if(c.requestedControl?.profileId!==input.profileId)fail("REQUEST_CHANGED","控制申请已变化，请刷新后确认");
        checkAuth(c.id,"browser",input.profileId);if(control)fail("CONTROL_BUSY","已有 Agent 正在控制网页");
        workspace.profiles.get(input.profileId);control={connectionId:c.id,profileId:input.profileId,leaseId:randomUUID(),expiresAt:new Date(Date.now()+120000).toISOString(),status:workspace.runtime()?.profileId===input.profileId?"active":"reserved",browserEpoch};delete c.requestedControl;log("你","已允许本次网页控制",c.name);
      } else if(input.action==="controlDeny"){delete c.requestedControl;log("你","已拒绝网页控制",c.name);}
      else if(input.action==="disconnect"){transportDisconnect(c.id);await disconnected(c.id);}
      else if(input.action==="revoke"||input.action==="deny"){
        g.approved=false;g.permissions=none();await persist();for(const entry of connections.values())if(entry.clientId===c.clientId){entry.status="revoked";delete entry.requestedControl;transportDisconnect(entry.id);await disconnected(entry.id);}log("你","已撤销客户端授权",c.name);
      }
    }
    workspace.notify();return workspace.state();
  }
  const expiry=setInterval(()=>{if(control&&Date.parse(control.expiresAt)<=Date.now()){const old=revokeLease("控制权到期，网页已交还给你");if(old)void pauseOwned(old.connectionId).catch(workspace.reportError);}},1000);expiry.unref();
  function toolCompleted(id:string,result:{name:string;ok:boolean;code?:string;recordingId?:string;seqRange?:unknown}) {
    const labels:Record<string,string>={navigate:"访问页面",click:"点击网页元素",fill:"填写网页字段",press:"执行键盘操作",select:"选择网页选项",scroll:"滚动页面",recording_start:"创建采集记录",recording_control:"更新采集状态",recording_rename:"重命名采集记录",session_manage:"管理 Session",profile_manage:"管理 Profile",library_update:"整理记录库",library_delete_apply:"永久删除记录",export_start:"导出分析包",operation_cancel:"取消导出",timeline:"增量读取时间线"};
    const name=result.name.replace(/^tracedock_/,""),label=labels[name];if(!label)return;
    log(connections.get(id)?.name??"Agent",`${label}${result.ok?"":"未完成"}`,[result.code,result.recordingId,Array.isArray(result.seqRange)?`seq ${result.seqRange.join("–")}`:null].filter(Boolean).join(" · "));
  }
  return {snapshot,connect,disconnected,command,authorize,state,control:controlCall,requireLease,recordingStarted,approveDeletion,proposeDeletion,profileOpened,
    toolCompleted,
    registerGuard:(guard:()=>void)=>{context.getStore()?.guards.push(guard);},
    revalidateAuthorization:()=>{for(const guard of context.getStore()?.authorizations??[])guard();},
    recordingResumed:(id:string,recordingId:string)=>{if(owner?.recordingId===recordingId&&owner.connectionId&&connections.get(owner.connectionId)?.clientId===connection(id).clientId)owner.connectionId=id;},
    contextRevision:()=>browserEpoch,profileIds:(id:string)=>{checkAuth(id,"read");return [...connection(id).profileIds];},principal:(id:string)=>connection(id).clientId,
    run:<T>(id:string,operation:()=>Promise<T>,readOnly=false):Promise<T>=>{
      const execute=()=>context.run({connectionId:id,guards:[],authorizations:[]},async()=>{const c=connection(id);c.lastSeenAt=new Date().toISOString();const value=await operation();workspace.notify();return value;});
      if(readOnly)return execute();
      const result=toolQueue.then(execute);toolQueue=result.catch(()=>{});return result;
    },
    beforeCommand,environmentChanging,humanTakeover,assertHumanControl,
    beforeRecordingMutation:()=>{if(!context.getStore())assertHumanControl();},
    humanRecordingStarted:(id:string)=>{const actor=context.getStore()?.connectionId;if(actor)recordingStarted(actor,id);else owner={recordingId:id,connectionId:null};},
    humanRecordingResumed:()=>{if(!context.getStore()){const record=current();if(record)owner={recordingId:record.id,connectionId:null};}},
    controlled:()=>control?.status==="active"&&Date.parse(control.expiresAt)>Date.now(),
    setTransportDisconnect:(fn:(id:string)=>void)=>{transportDisconnect=fn;},setOperations:(value:typeof operations)=>{operations=value;},
    close:async()=>{stopped=true;clearInterval(expiry);revokeLease("应用退出，控制权已释放");await writeQueue;},
  };
}
export type MCPController=Awaited<ReturnType<typeof createMCPController>>;
