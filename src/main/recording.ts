import type { ApplicationPayloadMap } from "../shared/contracts/application";
import type { WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "./storage/session-store";
import type { ResourceRecorder } from "./resources/index";
import type { EventInput } from "../shared/contracts/storage";
import { errorMessage, object } from "../shared/runtime";
import type { BrowserState, EventNotice } from "../shared/contracts/ui";
export type { BrowserState } from "../shared/contracts/ui";
interface Options {
  store: SessionStore;
  resources: Pick<ResourceRecorder, "start" | "stop">;
  browser: WebContentsView;
  browserState: BrowserState;
  appVersion: string;
  profile: () => {id: string; name: string};
  notify: () => void;
  reportError: (error: unknown) => void;
  publish: (event: EventNotice) => void;
}
export function createRecordingController({
  store,
  resources,
  browser,
  browserState,
  appVersion,
  profile,
  notify,
  reportError,
  publish,
}: Options) {
  let activeId: string | null = null;
  let commandQueue: Promise<unknown> = Promise.resolve();
  const pendingCommands = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  function requireActiveId(): string {
    if (!activeId) throw new Error("当前没有录制会话");
    return activeId;
  }
  function currentSession() {
    return activeId && store.sessions.has(activeId) ? store.getSession(activeId) : null;
  }
  function recordingState() {
    const s = currentSession();
    return { recording: s?.status === "recording", sessionId: s?.id || null };
  }
  function serialize<T>(fn: () => T | Promise<T>): Promise<T> {
    const operation = commandQueue.then(fn);
    commandQueue = operation.catch(() => {});
    return operation;
  }
  async function persist(
    type: string,
    payload: unknown = {},
    extra: Omit<EventInput, "type" | "payload"> = {},
  ) {
    if (!activeId) return;
    const event = await store.append(activeId, {
      type,
      timestamp: new Date().toISOString(),
      url: browserState.url,
      title: browserState.title,
      payload,
      ...extra,
    });
    publish({
      id: event.id,
      seq: event.seq,
      type: event.type,
      timestamp: event.timestamp,
      elapsedMs: event.elapsedMs,
      sessionId: event.sessionId,
    });
    notify();
    return event;
  }
  function append<K extends keyof ApplicationPayloadMap>(
    type: K,
    payload: ApplicationPayloadMap[K],
    extra: Omit<EventInput, "type" | "payload"> = {},
  ) {
    return persist(type, payload, extra);
  }
  function sendRecorderState() {
    if (browser && !browser.webContents.isDestroyed())
      browser.webContents.send("recorder:state", recordingState());
  }
  async function recorderCommand(command: string, reason: string) {
    if (!browser || browser.webContents.isDestroyed())
      throw new Error("浏览器尚未就绪");
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCommands.delete(requestId);
        reject(new Error("页面采集器未响应；页面可能正在跳转或已崩溃"));
      }, 4500);
      pendingCommands.set(requestId, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      browser.webContents.send("recorder:command", {
        command,
        reason,
        requestId,
      });
    });
    await store.flush();
  }
  async function checkpoint(command: string, reason: string) {
    try {
      await recorderCommand(command, reason);
      return true;
    } catch (error) {
      await append("recorder.error", {
        message: errorMessage(error),
        command,
        reason,
        possibleGap: true,
      });
      reportError(error);
      return false;
    }
  }
  async function startSession(input: {name: string; sessionGroupId: string}) {
    const current = currentSession();
    if (current && ["recording", "paused"].includes(current.status))
      throw new Error("请先结束当前会话");
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 160)
      throw new Error("采集名称须为 1–160 个字符");
    const label = input.name.trim();
    const session = await store.create(label, browserState.url, profile(), input.sessionGroupId);
    activeId = session.id;
    await append("session.start", {
      name: label,
      appVersion: appVersion,
      redaction: false,
    });
    await resources.start(activeId);
    sendRecorderState();
    await checkpoint("flush", "start");
    notify();
    return store.getSession(requireActiveId());
  }
  async function pauseSession() {
    if (currentSession()?.status !== "recording")
      throw new Error("当前没有正在录制的会话");
    await checkpoint("stop", "pause");
    await resources.stop();
    await append("session.pause", { reason: "user" });
    await store.update(requireActiveId(), { status: "paused" });
    sendRecorderState();
    notify();
    return store.getSession(requireActiveId());
  }
  async function resumeSession() {
    if (currentSession()?.status !== "paused")
      throw new Error("当前会话未暂停");
    await store.update(requireActiveId(), { status: "recording" });
    await append("session.resume", {
      reason: "user",
      note: "暂停期间未采集；恢复时建立新的 DOM 基线。",
    });
    await resources.start(activeId);
    sendRecorderState();
    await checkpoint("flush", "resume");
    notify();
    return store.getSession(requireActiveId());
  }
  async function stopSession(reason = "user") {
    const session = currentSession();
    if (!session || !["recording", "paused"].includes(session.status))
      return session;
    if (session.status === "recording") {
      await checkpoint("snapshot", "stop");
      await checkpoint("stop", "stop");
    }
    await resources.stop();
    await append("session.stop", { reason });
    await store.update(requireActiveId(), {
      status: "stopped",
      endedAt: new Date().toISOString(),
    });
    sendRecorderState();
    await store.flush();
    notify();
    return store.getSession(requireActiveId());
  }
  async function snapshot() {
    if (currentSession()?.status !== "recording")
      throw new Error("请在录制中抓取快照");
    if (!(await checkpoint("snapshot", "manual")))
      throw new Error("快照未完成，详情已记录在时间线");
    return store.getSession(requireActiveId());
  }

  function acknowledge(value: unknown) {
    const payload = object(value);
    if (typeof payload.requestId !== "string") return;
    const pending = pendingCommands.get(payload.requestId);
    if (!pending) return;
    pendingCommands.delete(payload.requestId);
    if (payload.ok === false)
      pending.reject(
        new Error(
          typeof payload.error === "string"
            ? payload.error
            : "页面采集命令失败",
        ),
      );
    else pending.resolve();
  }
  function accept(value: unknown) {
    const envelope = object(value);
    if (
      envelope.sessionId !== activeId ||
      currentSession()?.status !== "recording"
    )
      return;
    if (
      typeof envelope.type !== "string" ||
      !/^(action|dom|page|recorder)\.[a-zA-Z0-9_.-]+$/.test(envelope.type)
    )
      return;
    const extra: Omit<EventInput, "type" | "payload"> = {};
    for (const key of ["timestamp", "documentId", "url", "title"] as const)
      if (typeof envelope[key] === "string") extra[key] = envelope[key];
    persist(envelope.type, envelope.payload, extra).catch(reportError);
  }
  return {
    currentSession,
    recordingState,
    serialize,
    append,
    checkpoint,
    startSession,
    pauseSession,
    resumeSession,
    stopSession,
    snapshot,
    acknowledge,
    accept,
  };
}
export type RecordingController = ReturnType<typeof createRecordingController>;
