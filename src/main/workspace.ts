import { app, session as electronSession } from "electron";
import type { BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { SessionStore } from "./storage/session-store";
import { ProfileStore } from "./storage/profile-store";
import { SessionGroupStore } from "./storage/session-group-store";
import { BrowserEnvironment, closedBrowserState } from "./browser-environment";
import { ResourceCatalog } from "./resources/catalog";
import { ResourceProtocol } from "./resources/protocol";
import { createExportJobs } from "./export-jobs";
import type { AppState, BrowserBounds } from "../shared/contracts/ui";
import type { LibraryBatchInput } from "../shared/contracts/library";
import { planLibraryBatch } from "./library-batch";
import { errorMessage } from "../shared/runtime";
import type { MCPState } from "../shared/contracts/mcp";

interface MCPHooks {
  snapshot(): MCPState;
  beforeCommand(): void;
  environmentChanging(target: string | null): void;
  humanRecordingStarted(id: string): void;
  humanRecordingResumed(): void;
  beforeRecordingMutation(): void;
  controlled(): boolean;
}

export async function createWorkspace(win: BrowserWindow, demoURL: string) {
  // The hierarchy is a fresh baseline; no previous workspace is read or migrated.
  const root = path.join(app.getPath("userData"), "workspace-v3");
  const profiles = await new ProfileStore(root).init();
  const sessionGroups = await new SessionGroupStore(root).init();
  // Reclaim only orphaned partitions belonging to this baseline, before opening any views.
  const partitions = path.join(app.getPath("sessionData"), "Partitions");
  const livePartitions = new Set(profiles.list().map(p => `tracedock-profile-${p.id}`));
  for (const entry of await fs.readdir(partitions, {withFileTypes:true}).catch((error: NodeJS.ErrnoException) => {
    if(error.code === "ENOENT") return []; throw error;
  })) {
    if(entry.isDirectory() && /^tracedock-profile-profile-[a-f0-9-]+$/.test(entry.name) && !livePartitions.has(entry.name))
      await fs.rm(path.join(partitions,entry.name),{recursive:true,force:true});
  }
  for (const entry of await fs.readdir(root)) {
    if(entry.startsWith(".resource-cache-")) await fs.rm(path.join(root,entry),{recursive:true,force:true});
  }
  const store = await new SessionStore(path.join(root, "recordings")).init();
  for (const id of sessionGroups.pendingDeletions()) {
    await store.deleteGroupRecordings(id);
    await sessionGroups.finishDelete(id);
  }
  for (const record of store.list()) {
    const group = sessionGroups.get(record.sessionGroupId);
    if (group.profileId !== record.profileId) throw new Error("采集记录与 Session 的 Profile 不一致");
  }
  const catalog = new ResourceCatalog(store);
  const resourceProtocol = new ResourceProtocol(store, catalog);
  let runtime: BrowserEnvironment | null = null;
  let replaySessionId: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  let mcp: MCPHooks | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lazyTimer: ReturnType<typeof setTimeout> | undefined;
  let bounds: BrowserBounds = {x:250,y:190,width:800,height:650,visible:false};
  const reportError = (error: unknown) => {
    console.error("[TraceDock]", errorMessage(error));
    if (!win.isDestroyed()) win.webContents.send("collector:error", errorMessage(error));
  };
  function serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function command<T>(operation: () => T | Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error("软件正在关闭"));
    return serialize(() => {mcp?.beforeCommand();return operation();});
  }
  function requireRuntime(): BrowserEnvironment {
    if (!runtime) throw new Error("请先打开一个 Profile");
    if (!runtime.activePageId || runtime.contents.isDestroyed())
      throw new Error("浏览环境正在恢复，请稍后重试");
    return runtime;
  }
  // 录制中每个事件都会触发；完整状态最多每秒推送一次，计数随事件通知增量送达。
  const notifyLater = () => {
    if (lazyTimer) return;
    lazyTimer = setTimeout(() => { lazyTimer = undefined; notify(); }, 1000);
  };
  const notify = () => {
    clearTimeout(lazyTimer); lazyTimer = undefined;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send("collector:state", state());
    }, 60);
  };
  const jobs = createExportJobs(win, store, {
    serialize,
    currentSession: () => runtime?.recording.currentSession() ?? null,
    checkpoint: (cmd, reason) => requireRuntime().recording.checkpoint(cmd, reason),
  }, notify, progress => {
    if (!win.isDestroyed()) win.webContents.send("collector:exportProgress", progress);
  });
  function state(): AppState {
    const groups = sessionGroups.list(), ids = new Set(groups.map(group=>group.id));
    const current = runtime?.recording.currentSession() ?? null;
    return {...(mcp?{mcp:mcp.snapshot()}:{}),profiles:profiles.list(),sessionGroups:groups,activeProfileId:runtime?.profileId ?? null,
      browser:{...(runtime?.state ?? closedBrowserState())},pages:runtime?.list() ?? [],activePageId:runtime?.activePageId ?? null,session:current && ids.has(current.sessionGroupId) ? current : null,
      sessions:store.list().filter(record=>ids.has(record.sessionGroupId)),export:jobs.progress()};
  }
  function setBounds(value: BrowserBounds) {
    bounds = value;
    runtime?.setBounds(value);
  }
  async function closeEnvironment(reason: string, invalidate = true) {
    if (invalidate) mcp?.environmentChanging(null);
    if (runtime) await runtime.dispose(reason);
    runtime = null;
    await profiles.select(null);
    notify();
  }
  async function openEnvironment(id: string) {
    profiles.get(id);
    if (runtime?.profileId === id) return;
    mcp?.environmentChanging(id);
    await closeEnvironment("profile-switch", false);
    const current = new BrowserEnvironment(id, {
      win, root, store, demoURL, profile: () => profiles.get(id), notify, notifyLater, reportError,
      publish: event => { if (!win.isDestroyed()) win.webContents.send("collector:event", event); },
      controlled: () => mcp?.controlled() ?? false,
      targetChanged: () => mcp?.environmentChanging(null),
      empty: () => {
        if (closing || runtime !== current) return;
        mcp?.environmentChanging(null);
        void serialize(async () => {
          if (closing || runtime !== current || current.activePageId) return;
          await closeEnvironment("browser-closed", false);
          await openEnvironment(id);
          reportError(new Error("最后一个网页已关闭，已保存当前采集并重新打开此环境。"));
        }).catch(reportError);
      },
    });
    runtime = current;
    current.setBounds(bounds);
    const ses = electronSession.fromPartition(`persist:tracedock-profile-${id}`);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    try {
      await current.newPage("tab", false);
      await profiles.select(id);
    } catch (error) {
      await closeEnvironment("profile-open-failed");
      throw error;
    }
    notify();
  }
  async function clearData(id: string, kind: "cache" | "storage" | "all") {
    profiles.get(id);
    if (runtime?.profileId === id) await closeEnvironment("profile-clear");
    const ses = electronSession.fromPartition(`persist:tracedock-profile-${id}`);
    await ses.closeAllConnections();
    if (kind !== "storage") {await ses.clearCache();await ses.clearCodeCaches({});}
    if (kind === "all") await ses.clearData();
    if (kind !== "cache") {
      await ses.clearStorageData();
      await ses.clearAuthCache();
      await ses.cookies.flushStore();
      ses.flushStorageData();
    }
  }
  function readable(id: string) {
    const record = store.getSession(id);
    if (record.libraryState === "trashed") throw new Error("请先从回收站恢复会话");
    if (sessionGroups.get(record.sessionGroupId).libraryState === "trashed") throw new Error("请先从回收站恢复所属 Session");
    return record;
  }
  async function readRecording<T>(id: string, read: () => Promise<T>): Promise<T> {
    readable(id);
    return store.withReadLease(id, async () => {
      const result = await read();
      readable(id);
      return result;
    });
  }
  function unlocked(id: string) {
    if(jobs.progress()?.sessionId === id) throw new Error("请等待或取消此会话的导出任务");
    if(replaySessionId === id) throw new Error("请先关闭此会话的回放");
  }
  function mutable(id: string) {
    const record = store.getSession(id);
    if (sessionGroups.get(record.sessionGroupId).libraryState === "trashed") throw new Error("请先恢复所属 Session，再管理采集记录");
    unlocked(id);
  }
  function groupMutable(id: string) {
    sessionGroups.get(id);
    const records = store.list().filter(record => record.sessionGroupId === id);
    for (const record of records) {
      unlocked(record.id);
      if (record.status === "recording" || record.status === "paused")
        throw new Error("请先结束此 Session 中的采集");
    }
    return records;
  }
  async function mutate(operation: () => Promise<unknown>) {
    try {await operation(); return state();} finally {notify();}
  }
  const actions = {
    batchLibrary: (input: LibraryBatchInput) => command(()=>mutate(async()=>{
      const plan = planLibraryBatch(input, state());
      for (const id of plan.affectedSessionIds) {
        try { unlocked(id); }
        catch (error) { throw new Error(`采集记录“${store.getSession(id).name}”：${errorMessage(error)}；未执行任何批量操作`); }
      }
      await store.withLibraryMutation(plan.affectedSessionIds, async () => {
        let completedGroups = 0, completedRecords = 0;
        try {
          for (const id of plan.sessionGroupIds) {
            if (plan.action === "delete") {
              const children = store.list().filter(record => record.sessionGroupId === id);
              try { await store.deleteGroupRecordings(id, () => sessionGroups.beginDelete(id)); }
              finally { for (const record of children) catalog.invalidate(record.id); }
              await sessionGroups.finishDelete(id);
            } else {
              await sessionGroups[plan.action](id);
            }
            completedGroups++;
          }
          for (const id of plan.sessionIds) {
            if (plan.action === "delete") {
              try { await store.deletePermanently(id); }
              finally { catalog.invalidate(id); }
            } else {
              await store[plan.action](id);
            }
            completedRecords++;
          }
        } catch (error) {
          const recovery = plan.sessionGroupIds.some(id => sessionGroups.pendingDeletions().includes(id))
            ? "有 Session 删除尚未完成，请重启软件继续清理。" : "当前项可能已部分写入，请根据刷新后的列表继续。";
          throw new Error(`批量整理未全部完成：已完成 ${completedGroups} 个 Session、${completedRecords} 条独立记录。${recovery}${errorMessage(error)}`);
        }
      });
    })),
    createSessionGroup: (profileId: string, name: string) => command(()=>mutate(()=>sessionGroups.create(name,profiles.get(profileId)))),
    renameSessionGroup: (id: string, name: string) => command(()=>mutate(()=>sessionGroups.rename(id,name))),
    closeSessionGroup: (id: string) => command(()=>mutate(async()=>{
      const group = sessionGroups.get(id);
      if (group.libraryState !== "active") throw new Error("只能关闭常用 Session");
      if (runtime?.recording.currentSession()?.sessionGroupId === id) await runtime.recording.stopSession("session-close");
      await sessionGroups.close(id);
    })),
    reopenSessionGroup: (id: string) => command(()=>mutate(async()=>{
      profiles.get(sessionGroups.get(id).profileId);
      await sessionGroups.reopen(id);
    })),
    archiveSessionGroup: (id: string) => command(()=>mutate(async()=>{groupMutable(id);await sessionGroups.archive(id);})),
    unarchiveSessionGroup: (id: string) => command(()=>mutate(async()=>{groupMutable(id);await sessionGroups.unarchive(id);})),
    trashSessionGroup: (id: string) => command(()=>mutate(async()=>{groupMutable(id);await sessionGroups.trash(id);})),
    restoreSessionGroup: (id: string) => command(()=>mutate(async()=>{groupMutable(id);await sessionGroups.restore(id);})),
    deleteSessionGroup: (id: string) => command(()=>mutate(async()=>{
      const records = groupMutable(id);
      try {await store.deleteGroupRecordings(id,()=>sessionGroups.beginDelete(id));}
      finally {for (const record of records) catalog.invalidate(record.id);}
      await sessionGroups.finishDelete(id);
    })),
    startSession: (input: {sessionGroupId: string; name: string}) => command(async()=>{
      mcp?.beforeRecordingMutation();
      const group = sessionGroups.get(input.sessionGroupId), current = requireRuntime();
      profiles.get(group.profileId);
      if (group.profileId !== current.profileId) throw new Error("请先打开此 Session 所属的 Profile");
      if (group.status !== "open" || group.libraryState !== "active") throw new Error("请先恢复并打开此 Session，再开始采集");
      const record=await current.recording.startSession(input);
      mcp?.humanRecordingStarted(record.id);
      return record;
    }),
    pauseSession: () => command(()=>{mcp?.beforeRecordingMutation();return requireRuntime().recording.pauseSession();}),
    resumeSession: () => command(async()=>{mcp?.beforeRecordingMutation();const result=await requireRuntime().recording.resumeSession();mcp?.humanRecordingResumed();return result;}),
    stopSession: () => command(()=>{mcp?.beforeRecordingMutation();return requireRuntime().recording.stopSession();}),
    snapshot: () => command(()=>{mcp?.beforeRecordingMutation();return requireRuntime().recording.snapshot();}),
    navigate: (url:string) => command(()=>requireRuntime().navigation.navigate(url)),
    createProfileOnly: (name:string) => command(()=>mutate(()=>profiles.create(name))),
    createProfile: (name: string) => command(()=>mutate(async()=>{const p=await profiles.create(name);await openEnvironment(p.id);})),
    renameProfile: (id:string,name:string) => command(()=>mutate(async()=>{
      await profiles.rename(id,name);
      // Existing records retain the name recorded when they were created.
    })),
    switchProfile: (id:string) => command(()=>mutate(()=>openEnvironment(id))),
    closeProfile: () => command(()=>mutate(()=>closeEnvironment("profile-close"))),
    deleteProfile: (id:string) => command(()=>mutate(async()=>{
      await clearData(id,"all"); await profiles.delete(id);
    })),
    clearProfileData: (id:string,kind:"cache"|"storage") => command(()=>mutate(()=>clearData(id,kind))),
    renameSession: (id:string,name:string) => command(()=>mutate(async()=>{mutable(id); await store.rename(id,name);})),
    archiveSession: (id:string) => command(()=>mutate(async()=>{mutable(id);await store.archive(id);})),
    unarchiveSession: (id:string) => command(()=>mutate(async()=>{mutable(id);await store.unarchive(id);})),
    trashSession: (id:string) => command(()=>mutate(async()=>{mutable(id);await store.trash(id);})),
    restoreSession: (id:string) => command(()=>mutate(async()=>{mutable(id);await store.restore(id);})),
    deleteSession: (id:string) => command(()=>mutate(async()=>{
      mutable(id);
      try {await store.deletePermanently(id);} finally {catalog.invalidate(id);}
    })),
    setReplaySession: (id:string|null) => command(async()=>{if(id) readable(id);replaySessionId=id;}),
  };
  return {root,store,profiles,sessionGroups,jobs,state,notify,reportError,command,requireRuntime,readable,readRecording,actions,setBounds,
    setMCPHooks:(hooks:MCPHooks)=>{mcp=hooks;},
    runtime:()=>runtime,
    respond: async (request: {method:string;url:string})=>{
      try {
        const id = decodeURIComponent(new URL(request.url).pathname.slice(1));
        return await readRecording(id,()=>resourceProtocol.respond(request));
      }
      catch {return Promise.resolve(new Response(null,{status:404}));}
    },
    resourceSummary:(id:string,endSeq?:number)=>readRecording(id,()=>catalog.summary(id,endSeq,runtime?.captureError ?? null)),
    init:async()=>{const id=profiles.activeId;if(id)await openEnvironment(id);},
    close:async()=>{
      closing=true;
      const exportClosing=jobs.close();
      // Preserve the selected environment for the next launch; closing a Profile is separate.
      try {
      await serialize(async()=>{
        if (runtime) await runtime.dispose("window-close");
        runtime = null;
      });
      await exportClosing;
      await store.flush();clearTimeout(timer);clearTimeout(lazyTimer);
      } catch (error) {closing=false; notify(); throw error;}
    },
  };
}
export type Workspace = Awaited<ReturnType<typeof createWorkspace>>;
