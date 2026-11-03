import { ipcMain, shell } from "electron";
import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from "electron";
import type {
  InvokeChannel,
  InvokeResult,
} from "../shared/contracts/ipc";
import type { Workspace } from "./workspace";
import { object } from "../shared/runtime";
import { parseLibraryBatch } from "./library-batch";
import type { MCPController } from "./mcp/controller";
import type { MCPCommand, MCPConfig } from "../shared/contracts/mcp";
import { generateForUI, parseGenerateRequest, saveScriptFromUI } from "./codegen/ipc";
const string = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("参数必须为字符串");
  return value;
};
const number = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("参数必须为有限数字");
  return value;
};
interface Options {win: BrowserWindow; workspace: Workspace; demoURL: string; mcp: MCPController; mcpConfig: ()=>MCPConfig;}
export function installIPC({win,workspace,demoURL,mcp,mcpConfig}: Options) {
  const {store,state,reportError,jobs,command,readable,readRecording,actions} = workspace;
  const browser = () => workspace.requireRuntime().browser;
  const recording = () => workspace.requireRuntime().recording;
  const navigation = () => workspace.requireRuntime().navigation;
  function shellCaller(event: IpcMainEvent | IpcMainInvokeEvent) {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame?.url !== win.webContents.getURL()
    )
      throw new Error("拒绝非应用界面的请求");
  }
  const recorderCaller = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === workspace.runtime()?.browser.webContents &&
    event.senderFrame === workspace.runtime()?.browser.webContents.mainFrame;
  function handle<K extends InvokeChannel>(
    name: K,
    handler: (input: unknown) => InvokeResult<K> | Promise<InvokeResult<K>>,
  ) {
    ipcMain.handle(`collector:${name}`, (event, input: unknown) => {
      shellCaller(event);
      return handler(input);
    });
  }
  handle("getState", state);
  handle("mcpCommand", input => mcp.command(object(input) as unknown as MCPCommand));
  handle("mcpConfig", mcpConfig);
  handle("batchLibrary", input => actions.batchLibrary(parseLibraryBatch(input)));
  handle("createSessionGroup", input => {const q=object(input);return actions.createSessionGroup(string(q.profileId),string(q.name));});
  handle("renameSessionGroup", input => {const q=object(input);return actions.renameSessionGroup(string(q.sessionGroupId),string(q.name));});
  handle("closeSessionGroup", input => actions.closeSessionGroup(string(input)));
  handle("reopenSessionGroup", input => actions.reopenSessionGroup(string(input)));
  handle("archiveSessionGroup", input => actions.archiveSessionGroup(string(input)));
  handle("unarchiveSessionGroup", input => actions.unarchiveSessionGroup(string(input)));
  handle("trashSessionGroup", input => actions.trashSessionGroup(string(input)));
  handle("restoreSessionGroup", input => actions.restoreSessionGroup(string(input)));
  handle("deleteSessionGroup", input => actions.deleteSessionGroup(string(input)));
  handle("createProfile", input => actions.createProfile(string(input)));
  handle("renameProfile", input => { const q=object(input); return actions.renameProfile(string(q.profileId),string(q.name)); });
  handle("switchProfile", input => actions.switchProfile(string(input)));
  handle("closeProfile", actions.closeProfile);
  handle("deleteProfile", input => actions.deleteProfile(string(input)));
  handle("clearProfileData", input => {
    const q=object(input);
    if(q.kind !== "cache" && q.kind !== "storage") throw new Error("无效的数据清理类型");
    return actions.clearProfileData(string(q.profileId),q.kind);
  });
  handle("renameSession", input => {const q=object(input);return actions.renameSession(string(q.sessionId),string(q.name));});
  handle("archiveSession", input => actions.archiveSession(string(input)));
  handle("unarchiveSession", input => actions.unarchiveSession(string(input)));
  handle("trashSession", input => actions.trashSession(string(input)));
  handle("restoreSession", input => actions.restoreSession(string(input)));
  handle("deleteSession", input => actions.deleteSession(string(input)));
  handle("setReplaySession", input => actions.setReplaySession(input === null ? null : string(input)));

  handle("getTimeline", (input) => {
    const q = object(input);
    readable(string(q.sessionId));
    return readRecording(string(q.sessionId),()=>store.timeline({
      sessionId: string(q.sessionId),
      offset: number(q.offset),
      limit: number(q.limit),
      types: Array.isArray(q.types)
        ? q.types.filter((v): v is string => typeof v === "string")
        : [],
      query: q.query === undefined ? "" : string(q.query),
      beforeSeq: number(q.beforeSeq),
      afterSeq: number(q.afterSeq),
      snapshotSeq: number(q.snapshotSeq),
    }));
  });
  handle("getEvent", (input) => {
    const q = object(input);
    readable(string(q.sessionId));
    return readRecording(string(q.sessionId),()=>store.getEvent(string(q.sessionId), string(q.eventId), {
      preview: q.preview === true,
      maxBytes: number(q.maxBytes),
    }));
  });
  handle("replaySeek", (input) => {
    const q = object(input);
    readable(string(q.sessionId));
    return readRecording(string(q.sessionId),()=>store.replaySeek({
      sessionId: string(q.sessionId),
      timeMs: number(q.timeMs),
      targetSeq: number(q.targetSeq),
      endSeq: number(q.endSeq),
    }));
  });
  handle("replayChunk", (input) => {
    const q = object(input);
    readable(string(q.sessionId));
    const endSeq = number(q.endSeq);
    if (endSeq === undefined) throw new Error("无效的回放范围");
    return readRecording(string(q.sessionId),()=>store.replayChunk({
      sessionId: string(q.sessionId),
      afterSeq: number(q.afterSeq),
      endSeq,
      limit: number(q.limit),
      maxBytes: number(q.maxBytes),
    }));
  });
  handle("replayResources", (input) => {
    const q = object(input);
    readable(string(q.sessionId));
    return workspace.resourceSummary(string(q.sessionId), number(q.endSeq));
  });
  handle("navigate", (input) => command(() => {mcp.assertHumanControl();return navigation().navigate(string(input));}));
  handle("home", () => command(() => {mcp.assertHumanControl();return navigation().navigate(demoURL);}));
  handle("back", () => command(() => {
    mcp.assertHumanControl();
    const h = browser().webContents.navigationHistory;
    if (h.canGoBack()) h.goBack();
  }));
  handle("forward", () => command(() => {
    mcp.assertHumanControl();
    const h = browser().webContents.navigationHistory;
    if (h.canGoForward()) h.goForward();
  }));
  handle("reload", () => command(() => {mcp.assertHumanControl();browser().webContents.reload();}));
  handle("startSession", input => {
    mcp.assertHumanControl();
    const q=object(input);
    return actions.startSession({sessionGroupId:string(q.sessionGroupId),name:string(q.name)});
  });
  handle("pauseSession", () => {mcp.assertHumanControl();return actions.pauseSession();});
  handle("resumeSession", () => {mcp.assertHumanControl();return actions.resumeSession();});
  handle("stopSession", () =>
    {mcp.assertHumanControl();return actions.stopSession();},
  );
  handle("snapshot", () => {mcp.assertHumanControl();return actions.snapshot();});
  handle("exportSession", (input) => {
    const q = object(input);
    const encoding = q.encoding ?? "delta",
      compression = q.compression ?? "deflate";
    if (
      (encoding !== "delta" && encoding !== "full") ||
      (compression !== "deflate" && compression !== "store")
    )
      throw new Error("无效的导出选项");
    if (q.script !== undefined && typeof q.script !== "boolean")
      throw new Error("无效的导出选项");
    return command(() => {readable(string(q.sessionId));return {result: jobs.startExport({
      sessionId: string(q.sessionId),
      encoding,
      compression,
      script: q.script === true,
    })};}).then(value => value.result);
  });
  handle("cancelExport", jobs.cancel);
  handle("revealExport", (input) => {
    const session = store.getSession(string(input));
    if (!session.lastExportPath) throw new Error("此会话尚未导出");
    shell.showItemInFolder(session.lastExportPath);
  });
  handle("generateScript", (input) => {
    const { sessionId } = parseGenerateRequest(input);
    readable(sessionId);
    return readRecording(sessionId, () => generateForUI(store, input));
  });
  handle("saveScript", (input) =>
    saveScriptFromUI(win, input, (id) => store.getSession(id).name),
  );
  ipcMain.on("collector:setBrowserBounds", (event, value: unknown) => {
    try {
      shellCaller(event);
    } catch (error) {
      reportError(error);
      return;
    }
    const b = object(value);
    if (
      typeof b.x !== "number" ||
      typeof b.y !== "number" ||
      typeof b.width !== "number" ||
      typeof b.height !== "number" ||
      ![b.x, b.y, b.width, b.height].every(Number.isFinite)
    )
      return;
    const [w = 0, h = 0] = win.getContentSize();
    const x = Math.max(0, Math.min(w, Math.round(b.x))),
      y = Math.max(0, Math.min(h, Math.round(b.y)));
    workspace.setBounds({
      x, y,
      visible: b.visible !== false && b.width > 0 && b.height > 0,
      width: Math.max(1, Math.min(w-x, Math.round(b.width))),
      height: Math.max(1, Math.min(h-y, Math.round(b.height))),
    });
  });
  ipcMain.handle("recorder:ready", (event) => {
    if (!recorderCaller(event)) throw new Error("无效的采集器");
    return recording().recordingState();
  });
  ipcMain.on("recorder:ack", (event, payload: unknown) => {
    if (recorderCaller(event)) recording().acknowledge(payload);
  });
  ipcMain.on("recorder:event", (event, payload: unknown) => {
    if (recorderCaller(event)) recording().accept(payload);
  });
}
