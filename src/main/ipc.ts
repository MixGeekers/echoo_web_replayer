import { ipcMain, shell } from "electron";
import type {
  BrowserWindow,
  WebContentsView,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from "electron";
import type {
  InvokeChannel,
  InvokeResult,
  AppState,
} from "../shared/contracts/ipc";
import type { SessionStore } from "./storage/session-store";
import type { ResourceRecorder } from "./resources/index";
import type { RecordingController } from "./recording";
import type { createBrowserController } from "./browser";
import type { createExportJobs } from "./export-jobs";
import { object } from "../shared/runtime";
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
interface Options {
  win: BrowserWindow;
  browser: WebContentsView;
  store: SessionStore;
  resources: ResourceRecorder;
  recording: RecordingController;
  navigation: ReturnType<typeof createBrowserController>;
  exports: ReturnType<typeof createExportJobs>;
  state: () => AppState;
  reportError: (error: unknown) => void;
  demoURL: string;
}
export function installIPC({
  win,
  browser,
  store,
  resources,
  recording,
  navigation,
  exports: jobs,
  state,
  reportError,
  demoURL,
}: Options) {
  function shellCaller(event: IpcMainEvent | IpcMainInvokeEvent) {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame?.url !== win.webContents.getURL()
    )
      throw new Error("拒绝非应用界面的请求");
  }
  const recorderCaller = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === browser.webContents &&
    event.senderFrame === browser.webContents.mainFrame;
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
  handle("getTimeline", (input) => {
    const q = object(input);
    return store.timeline({
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
    });
  });
  handle("getEvent", (input) => {
    const q = object(input);
    return store.getEvent(string(q.sessionId), string(q.eventId), {
      preview: q.preview === true,
      maxBytes: number(q.maxBytes),
    });
  });
  handle("replaySeek", (input) => {
    const q = object(input);
    return store.replaySeek({
      sessionId: string(q.sessionId),
      timeMs: number(q.timeMs),
      targetSeq: number(q.targetSeq),
      endSeq: number(q.endSeq),
    });
  });
  handle("replayChunk", (input) => {
    const q = object(input);
    const endSeq = number(q.endSeq);
    if (endSeq === undefined) throw new Error("无效的回放范围");
    return store.replayChunk({
      sessionId: string(q.sessionId),
      afterSeq: number(q.afterSeq),
      endSeq,
      limit: number(q.limit),
      maxBytes: number(q.maxBytes),
    });
  });
  handle("replayResources", (input) => {
    const q = object(input);
    return resources.summary(string(q.sessionId), number(q.endSeq));
  });
  handle("navigate", (input) => navigation.navigate(string(input)));
  handle("home", () => navigation.navigate(demoURL));
  handle("back", () => {
    const h = browser.webContents.navigationHistory;
    if (h.canGoBack()) h.goBack();
  });
  handle("forward", () => {
    const h = browser.webContents.navigationHistory;
    if (h.canGoForward()) h.goForward();
  });
  handle("reload", () => browser.webContents.reload());
  handle("startSession", (input) =>
    recording.serialize(() => recording.startSession(input)),
  );
  handle("pauseSession", () => recording.serialize(recording.pauseSession));
  handle("resumeSession", () => recording.serialize(recording.resumeSession));
  handle("stopSession", () =>
    recording.serialize(() => recording.stopSession()),
  );
  handle("snapshot", () => recording.serialize(recording.snapshot));
  handle("exportSession", (input) => {
    const q = typeof input === "string" ? { sessionId: input } : object(input);
    const encoding = q.encoding ?? "delta",
      compression = q.compression ?? "deflate";
    if (
      (encoding !== "delta" && encoding !== "full") ||
      (compression !== "deflate" && compression !== "store")
    )
      throw new Error("无效的导出选项");
    return jobs.startExport({
      sessionId: string(q.sessionId),
      encoding,
      compression,
    });
  });
  handle("cancelExport", jobs.cancel);
  handle("revealExport", (input) => {
    const session = store.getSession(string(input));
    if (!session.lastExportPath) throw new Error("此会话尚未导出");
    shell.showItemInFolder(session.lastExportPath);
  });
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
    browser.setVisible(b.visible !== false && b.width > 0 && b.height > 0);
    browser.setBounds({
      x,
      y,
      width: Math.max(1, Math.min(w - x, Math.round(b.width))),
      height: Math.max(1, Math.min(h - y, Math.round(b.height))),
    });
  });
  ipcMain.handle("recorder:ready", (event) => {
    if (!recorderCaller(event)) throw new Error("无效的采集器");
    return recording.recordingState();
  });
  ipcMain.on("recorder:ack", (event, payload: unknown) => {
    if (recorderCaller(event)) recording.acknowledge(payload);
  });
  ipcMain.on("recorder:event", (event, payload: unknown) => {
    if (recorderCaller(event)) recording.accept(payload);
  });
}
