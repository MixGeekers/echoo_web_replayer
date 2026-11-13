import type { ApplicationPayloadMap } from "../shared/contracts/application";
import type { SessionStore } from "./storage/session-store";
import type { RecordingPage } from "./recording-page";
import type { EventInput } from "../shared/contracts/storage";
import { errorMessage, object } from "../shared/runtime";
import { pageLabel, type EventNotice } from "../shared/contracts/ui";
export type { BrowserState } from "../shared/contracts/ui";
interface Options {
  store: SessionStore;
  pages: () => RecordingPage[];
  selected: () => RecordingPage | undefined;
  drainPages: () => Promise<unknown>;
  appVersion: string;
  profile: () => {id: string; name: string};
  notify: () => void;
  /** 低频的完整状态推送；逐事件的计数通过 publish 的 counters 增量送达。 */
  notifyLater?: () => void;
  reportError: (error: unknown) => void;
  publish: (event: EventNotice) => void;
}
export function createRecordingController({
  store,
  pages,
  selected,
  drainPages,
  appVersion,
  profile,
  notify,
  notifyLater = notify,
  reportError,
  publish,
}: Options) {
  let activeId: string | null = null;
  let capturing = false;
  function requireActiveId(): string {
    if (!activeId) throw new Error("当前没有录制会话");
    return activeId;
  }
  function currentSession() {
    return activeId && store.sessions.has(activeId) ? store.getSession(activeId) : null;
  }
  function recordingState() {
    return { recording: capturing, sessionId: activeId };
  }
  async function persist(
    type: string,
    payload: unknown = {},
    extra: Omit<EventInput, "type" | "payload"> = {},
    page = selected(),
  ) {
    if (!activeId) return;
    const event = await store.append(activeId, {
      type,
      timestamp: new Date().toISOString(),
      url: page?.state.url,
      title: page?.state.title,
      pageId: page?.id,
      activePageId: selected()?.id,
      payload,
      ...extra,
    });
    const metadata = store.sessions.get(event.sessionId);
    publish({
      id: event.id,
      seq: event.seq,
      type: event.type,
      timestamp: event.timestamp,
      elapsedMs: event.elapsedMs,
      sessionId: event.sessionId,
      ...(metadata
        ? {
            counters: {
              eventCount: metadata.eventCount,
              actionCount: metadata.actionCount,
              mutationCount: metadata.mutationCount,
              snapshotCount: metadata.snapshotCount,
              lastSeq: metadata.lastSeq,
              lastElapsedMs: metadata.lastElapsedMs,
              updatedAt: metadata.updatedAt,
              url: metadata.url,
            },
          }
        : {}),
    });
    notifyLater();
    return event;
  }
  function append<K extends keyof ApplicationPayloadMap>(
    type: K,
    payload: ApplicationPayloadMap[K],
    extra: Omit<EventInput, "type" | "payload"> = {},
    page = selected(),
  ) {
    return persist(type, payload, extra, page);
  }
  function sendRecorderState() {
    for (const page of pages()) {
      if (!page.contents.isDestroyed()) page.contents.send("recorder:state", recordingState());
    }
  }
  async function checkpoint(command: string, reason: string, targets = pages()) {
    const results = await Promise.all(targets.map(async page => {
      try {
        await page.command(command, reason);
        return true;
      } catch (error) {
        const message = `${pageLabel(page.id)} · ${errorMessage(error)}`;
        await append("recorder.error", { message, command, reason, possibleGap: true }, {}, page);
        if (!page.contents.isDestroyed()) reportError(new Error(message));
        return false;
      }
    }));
    await store.flush();
    return results.length > 0 && results.every(Boolean);
  }
  async function startPages() {
    const id = requireActiveId();
    capturing = true;
    await Promise.all(pages().map(async page => {
      try { await page.start(id); }
      catch (error) {
        const message = `${pageLabel(page.id)}的资源采集启动失败，${errorMessage(error)}`;
        await append("recorder.error", { message, possibleGap: true }, {}, page);
        reportError(new Error(message));
      }
    }));
    sendRecorderState();
  }
  async function stopPages() {
    capturing = false;
    sendRecorderState();
    await Promise.all(pages().map(page => page.stop()));
    await drainPages();
  }
  async function startSession(input: {name: string; sessionGroupId: string}) {
    const current = currentSession();
    if (current && ["recording", "paused"].includes(current.status))
      throw new Error("请先结束当前会话");
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 160)
      throw new Error("采集名称须为 1–160 个字符");
    const label = input.name.trim();
    const page = selected();
    if (!page || page.contents.isDestroyed()) throw new Error("请先打开网页");
    const session = await store.create(label, page.state.url, profile(), input.sessionGroupId);
    activeId = session.id;
    await append("session.start", {
      name: label,
      appVersion: appVersion,
      redaction: false,
    });
    await startPages();
    await checkpoint("flush", "start");
    notify();
    return store.getSession(requireActiveId());
  }
  async function pauseSession() {
    if (currentSession()?.status !== "recording")
      throw new Error("当前没有正在录制的会话");
    await checkpoint("stop", "pause");
    await stopPages();
    await append("session.pause", { reason: "user" });
    await store.update(requireActiveId(), { status: "paused" });
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
    await startPages();
    await checkpoint("flush", "resume");
    notify();
    return store.getSession(requireActiveId());
  }
  async function stopSession(reason = "user") {
    const session = currentSession();
    if (!session || !["recording", "paused"].includes(session.status))
      return session;
    if (session.status === "recording") {
      if (!pages().length) {
        await append("recorder.error", {
          message: "浏览页面已关闭，无法获取结束快照；此前收到的事件已保留。",
          reason,
          possibleGap: true,
        });
      } else {
        await checkpoint("snapshot", "stop");
        await checkpoint("stop", "stop");
      }
    }
    await stopPages();
    await append("session.stop", { reason });
    await store.update(requireActiveId(), {
      status: "stopped",
      endedAt: new Date().toISOString(),
    });
    await store.flush();
    notify();
    return store.getSession(requireActiveId());
  }
  async function snapshot() {
    if (currentSession()?.status !== "recording")
      throw new Error("请在录制中抓取快照");
    const page = selected();
    if (!page || !(await checkpoint("snapshot", "manual", [page])))
      throw new Error("快照未完成，详情已记录在时间线");
    return store.getSession(requireActiveId());
  }

  function accept(value: unknown, page: RecordingPage) {
    const envelope = object(value);
    if (
      envelope.sessionId !== activeId ||
      !capturing
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
    let payload = envelope.payload;
    if (envelope.type === "dom.snapshot" && typeof envelope.documentId === "string") {
      const frames = page.network.archive.snapshots(envelope.documentId);
      if (frames.length) {
        const snapshot = object(payload);
        payload = {
          ...snapshot, frameDocuments: frames,
          coverage: { ...object(snapshot.coverage), crossOriginFrameVisuals: frames.length },
        };
      }
    }
    persist(envelope.type, payload, extra, page).catch(reportError);
  }
  return {
    currentSession,
    recordingState,
    append,
    checkpoint,
    startSession,
    pauseSession,
    resumeSession,
    stopSession,
    snapshot,
    accept,
  };
}
export type RecordingController = ReturnType<typeof createRecordingController>;
