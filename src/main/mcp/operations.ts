import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class MCPToolError extends Error {
  constructor(public code: string, message: string, public outcome: "not_executed" | "executed" | "unknown" = "not_executed", public recovery = "read_state_then_replan") { super(message); }
}
export interface MCPOperation {
  id: string;
  principal: string;
  commandId: string;
  kind: "command" | "export";
  name: string;
  profileIds?: string[];
  payloadHash: string;
  state: "running" | "succeeded" | "failed" | "canceled" | "unknown";
  startedAt: string;
  updatedAt: string;
  recordingId?: string;
  result?: unknown;
  error?: {code: string; message: string; outcome: string; recovery: string};
}
function canonical(value: unknown): string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if(value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>`${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function payloadHash(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function toolError(error: unknown, fallbackOutcome: "not_executed" | "unknown" = "not_executed") {
  const e = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {code:typeof e.code === "string" ? e.code : "OPERATION_FAILED",message:error instanceof Error ? error.message : String(error),outcome:typeof e.outcome === "string" ? e.outcome : fallbackOutcome,recovery:typeof e.recovery === "string" ? e.recovery : "read_state_then_replan"};
}
export async function createMCPOperations(root: string, notify:()=>void=()=>{}) {
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const filename = path.join(root,"operations.json"), operations = new Map<string,MCPOperation>();
  let queue = Promise.resolve();
  const inFlight = new Map<string,Promise<unknown>>();
  try {
    const records: unknown = JSON.parse(await fs.readFile(filename,"utf8"));
    if(!Array.isArray(records)) throw new Error("Invalid MCP operation journal");
    for(const raw of records) {
      if(!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.principal !== "string" || typeof raw.commandId !== "string") throw new Error("Invalid MCP operation journal entry");
      const op = raw as MCPOperation;
      if(op.state === "running") {op.state="unknown";op.error={code:"OUTCOME_UNKNOWN",message:"应用在操作完成前退出；请核验已有结果，不要自动重试。",outcome:"unknown",recovery:"inspect_command_and_observe"};op.updatedAt=new Date().toISOString();}
      operations.set(op.id,op);
    }
  } catch(error) { if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const persist = () => {
    const task = queue.then(async()=>{
      const values=[...operations.values()];
      const cutoff=Date.now()-30*24*60*60*1000;
      for(const op of values) if(op.state!=="running"&&Date.parse(op.updatedAt)<cutoff) operations.delete(op.id);
      const temporary=`${filename}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary,JSON.stringify([...operations.values()]),{mode:0o600});
      await fs.rename(temporary,filename);notify();
    }); queue=task.catch(()=>{});return task;
  };
  await persist();
  const find = (principal:string, query:{operationId?:string;commandId?:string}) => {
    const op=query.operationId ? operations.get(query.operationId) : [...operations.values()].find(o=>o.principal===principal&&o.commandId===query.commandId&&o.kind==="command");
    if(!op || op.principal!==principal) throw new MCPToolError("NOT_FOUND","找不到此授权范围内的操作");
    return structuredClone(op);
  };
  async function execute<T>(principal:string,commandId:string,name:string,args:unknown,run:()=>Promise<T>,profileIds:string[]=[]):Promise<T> {
    const hash=payloadHash({name,args}), existing=[...operations.values()].find(o=>o.principal===principal&&o.commandId===commandId&&o.kind==="command");
    if(existing) {
      if(existing.payloadHash!==hash) throw new MCPToolError("COMMAND_CONFLICT","同一 commandId 不能用于不同请求");
      if(inFlight.has(existing.id)) return await inFlight.get(existing.id) as T;
      if(existing.state==="succeeded") return structuredClone(existing.result) as T;
      const error=existing.error ?? {code:"OUTCOME_UNKNOWN",message:"请求结果待核验",outcome:"unknown",recovery:"inspect_command_and_observe"};
      throw new MCPToolError(error.code,error.message,error.outcome as "not_executed"|"unknown",error.recovery);
    }
    const now=new Date().toISOString(), op:MCPOperation={id:`operation-${randomUUID()}`,principal,commandId,kind:"command",name,profileIds,payloadHash:hash,state:"running",startedAt:now,updatedAt:now};
    operations.set(op.id,op);
    const task=(async()=>{
      try {
        try {await persist();}
        catch(error) {operations.delete(op.id);throw new MCPToolError("JOURNAL_UNAVAILABLE",`无法保存命令回执，未执行操作：${error instanceof Error?error.message:String(error)}`);}
        try {
          const result=await run();op.state="succeeded";op.result=result;op.updatedAt=new Date().toISOString();
          try {await persist();}
          catch(error) {throw new MCPToolError("OUTCOME_UNKNOWN",`操作已返回，但结果保存失败；请先核验：${error instanceof Error?error.message:String(error)}`,"unknown","inspect_command_and_observe");}
          return result;
        } catch(error) {
          op.error=toolError(error,"unknown");op.state=op.error.outcome==="unknown"?"unknown":"failed";op.updatedAt=new Date().toISOString();
          await persist().catch(()=>{});
          throw new MCPToolError(op.error.code,op.error.message,op.error.outcome as "not_executed"|"unknown",op.error.recovery);
        }
      } finally {inFlight.delete(op.id);}
    })();
    inFlight.set(op.id,task); return task;
  }
  async function startExport(principal:string,commandId:string,recordingId:string,run:()=>Promise<unknown>,profileId?:string) {
    const now=new Date().toISOString(), op:MCPOperation={id:`operation-${randomUUID()}`,principal,commandId,kind:"export",name:"export_start",profileIds:profileId?[profileId]:[],payloadHash:"",state:"running",startedAt:now,updatedAt:now,recordingId};
    operations.set(op.id,op);try{await persist();}catch(error){operations.delete(op.id);throw new MCPToolError("JOURNAL_UNAVAILABLE",`无法保存导出任务，未执行：${error instanceof Error?error.message:String(error)}`);}
    const task=Promise.resolve().then(run).then(async result=>{
      op.result=result;op.state=result&&typeof result==="object"&&(result as {canceled?:boolean}).canceled?"canceled":"succeeded";op.updatedAt=new Date().toISOString();await persist();return result;
    },async error=>{op.error=toolError(error,"unknown");op.state="failed";op.updatedAt=new Date().toISOString();await persist();}).finally(()=>inFlight.delete(op.id));
    inFlight.set(op.id,task);void task.catch(()=>{});return {operationId:op.id,state:op.state,recordingId};
  }
  async function previous(principal:string,commandId:string,name:string,args:unknown,authorize:(profileId:string)=>void) {
    const op=[...operations.values()].find(o=>o.principal===principal&&o.commandId===commandId&&o.kind==="command");
    if(!op)return {found:false as const};
    for(const profileId of op.profileIds??[])authorize(profileId);
    if(op.payloadHash!==payloadHash({name,args}))throw new MCPToolError("COMMAND_CONFLICT","同一 commandId 不能用于不同请求");
    return {found:true as const,value:await execute(principal,commandId,name,args,async()=>undefined)};
  }
  return {execute,startExport,find,previous,getForUI:(id:string)=>operations.get(id),listForUI:()=>[...operations.values()].filter(o=>o.kind==="export").slice(-20).reverse().map(({principal,payloadHash,...op})=>structuredClone(op)),close:async()=>{await Promise.allSettled([...inFlight.values()]);await queue;}};
}
export type MCPOperations = Awaited<ReturnType<typeof createMCPOperations>>;
