import { FrameSessions } from "./frame-sessions";
import { FrameArchive, type VisualNode } from "../../shared/frame-visual";
import type { ApplicationPayloadMap } from "../../shared/contracts/application";
import type { WebContents } from "electron";
import type { NetworkPayloadMap, NetworkRequestPayload } from "../../shared/contracts/network";
import { object, errorMessage } from "../../shared/runtime";
import { acquireBrowserDebugger } from "../browser-debugger";
import type { BrowserDebuggerLease } from "../browser-debugger";
import {
  NETWORK_LIMITS,
  TRACKED_RESOURCE_TYPES,
  capText,
  captureBody,
  isTextMime,
  networkSummary,
  shapeConsole,
  shapeException,
  shapeFailed,
  shapeRequest,
  shapeResponse,
} from "../../shared/network-events";

export type NetworkHost = Partial<Pick<WebContents, "debugger">>;
type CaptureEvents = Pick<ApplicationPayloadMap, keyof NetworkPayloadMap | "action.frame" | "frame.snapshot" | "frame.mutation" | "frame.detach" | "recorder.error">;
export interface NetworkSink {
  /** Current recording ID when events should be stored, otherwise null (idle or paused). */
  recordingId(): string | null;
  record(
    type: keyof CaptureEvents,
    payload: CaptureEvents[keyof CaptureEvents],
    extra: { timestamp: string; summary: string },
  ): Promise<unknown> | void;
  error?(message: string): void;
}
interface CaptureOwner {
  recordingId: string;
  /** Each start/resume opens a distinct interval, even within the same recording. */
  generation: number;
}
interface Tracked {
  sessionId?: string;
  request: NetworkRequestPayload;
  owner: CaptureOwner;
  /** CDP monotonic seconds of requestWillBeSent and wall-clock offset. */
  start: number;
  offset: number;
  redirects: number;
  response?: unknown;
}
const MAX_TRACKED = 5000;

/**
 * Records XHR/Fetch/Document requests and page console output / uncaught errors
 * through the shared CDP transport. Request ownership is frozen at its first hop;
 * delayed work can only be saved into that same recording and capture interval.
 */
export class NetworkCapture {
  private readonly requests = new Map<string, Tracked>();
  private frames?: FrameSessions;
  private mainFrameId: string | undefined;
  readonly archive = new FrameArchive();
  private intervalStart = 0;
  private queue: Promise<void> = Promise.resolve();
  private lease: BrowserDebuggerLease | undefined;
  /** Opened by start() after session.start/resume, closed by stop() before session.pause/stop. */
  private capturing = false;
  private accepting = false;
  private generation = 0;
  error: string | null = null;
  constructor(
    private readonly host: NetworkHost,
    private readonly sink: NetworkSink,
    private readonly bodyBudget = new Map<string, number>(),
  ) {}
  async init(): Promise<this> {
    try {
      const debug = (this.lease = acquireBrowserDebugger(this.host));
      this.frames = new FrameSessions(debug, message => this.fail(message), documentId => {
        this.schedule(this.owner(), async () => {
          if (!this.archive.has(documentId)) return;
          this.archive.forget(documentId);
          await this.sink.record("frame.detach", { documentId }, { timestamp: new Date().toISOString(), summary: "iframe 文档已卸载" });
        });
      });
      debug.onMessage((method, params, sessionId) => this.onMessage(method, params, sessionId), true);
      debug.onDetach((reason) => this.fail(`网络与控制台采集已断开：${reason}`));
      await this.frames.enable();
      const tree = object(await debug.sendCommand("Page.getFrameTree"));
      const root = object(object(tree.frameTree).frame);
      if (typeof root.id === "string") this.mainFrameId = root.id;
    } catch (error) {
      this.fail(`网络与控制台采集不可用：${errorMessage(error)}`);
    }
    return this;
  }
  private fail(message: string) {
    this.error = message;
    this.sink.error?.(message);
  }
  private async emit<K extends keyof NetworkPayloadMap>(
    owner: CaptureOwner,
    type: K,
    payload: NetworkPayloadMap[K],
    timeMs: number,
  ): Promise<void> {
    if (!this.isCurrent(owner)) return;
    const timestamp = new Date(Number.isFinite(timeMs) ? timeMs : Date.now()).toISOString();
    try {
      await this.sink.record(type, payload, { timestamp, summary: networkSummary(type, payload) });
    } catch (error) {
      this.fail(`保存网络事件失败：${errorMessage(error)}`);
    }
  }
  private schedule(owner: CaptureOwner | null, task: (owner: CaptureOwner) => Promise<void>): void {
    if (!this.accepting || !owner || !this.isCurrent(owner)) return;
    this.queue = this.queue.then(() => {
      if (this.isCurrent(owner)) return task(owner);
    }).catch((error: unknown) => {
      this.fail(`网络事件处理失败：${errorMessage(error)}`);
    });
  }
  async flushFrameDocuments() {
    await this.frames?.flushVisuals();
    await this.flush();
  }
  flush(): Promise<void> {
    return this.queue;
  }
  private owner(): CaptureOwner | null {
    const recordingId = this.capturing && this.accepting ? this.sink.recordingId() : null;
    return recordingId ? { recordingId, generation: this.generation } : null;
  }
  private isCurrent(owner: CaptureOwner): boolean {
    return this.capturing && owner.generation === this.generation && owner.recordingId === this.sink.recordingId();
  }
  /** Begin storing events (call after the session.start / session.resume boundary). */
  async start(): Promise<void> {
    this.archive.clear();
    this.generation++;
    this.capturing = true;
    this.accepting = true;
    this.intervalStart = Date.now();
    await this.frames?.recording(this.generation);
    await this.flush();
  }
  /** Drain already received events and their writes; later arrivals belong outside this interval. */
  async stop(): Promise<void> {
    const generation = this.generation;
    this.accepting = false;
    await Promise.all([this.flush(), this.frames?.recording(0)]);
    if (generation === this.generation) {
      this.capturing = false;
      this.requests.clear();
    }
  }
  private wall(tracked: Tracked, seconds: unknown): number {
    return typeof seconds === "number" ? (seconds + tracked.offset) * 1000 : Date.now();
  }
  private duration(tracked: Tracked, seconds: unknown): number | null {
    return typeof seconds === "number" ? Math.max(0, (seconds - tracked.start) * 1000) : null;
  }
  onMessage(method: string, value: unknown, sessionId?: string): void {
    const params = object(value);
    if (sessionId && !this.frames?.has(sessionId)) return;
    if (!sessionId && method === "Page.frameNavigated") {
      const frame = object(params.frame);
      if (!frame.parentId && typeof frame.id === "string") this.mainFrameId = frame.id;
      return;
    }
    if (method === "Target.attachedToTarget") return this.frames?.attach(params, sessionId);
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") {
        this.frames?.detach(params.sessionId);
        for (const [key, tracked] of this.requests)
          if (tracked.sessionId === params.sessionId && !key.startsWith("navigation:")) this.requests.delete(key);
      }
      return;
    }
    if (method.startsWith("Runtime.")) return this.onRuntime(method, params, sessionId);
    if (!method.startsWith("Network.") || typeof params.requestId !== "string") return;
    const requestId = params.requestId;
    // A navigation's loader UUID survives process swaps: Chromium can report
    // its request/headers on the parent and its completion on the new child.
    const localKey = sessionId ? `${sessionId}:${requestId}` : requestId;
    const documentKey = `navigation:${requestId}`;
    const isNavigation = params.type === "Document" && params.loaderId === requestId;
    const continuingNavigation = method !== "Network.requestWillBeSent" &&
      !this.requests.has(localKey) && this.requests.has(documentKey);
    const key = isNavigation || continuingNavigation ? documentKey : localKey;
    if (method === "Network.requestWillBeSent") {
      const previous = this.requests.get(key);
      const redirect = params.redirectResponse !== undefined;
      if (previous && redirect) {
        // Redirects reuse requestId: close the previous hop as a 3xx response.
        const hop = shapeResponse(previous.request, { response: params.redirectResponse, type: params.type }, this.duration(previous, params.timestamp));
        hop.redirectTo = String(object(params.request).url ?? "");
        hop.bodyOmitted = "重定向响应没有正文";
        const at = this.wall(previous, params.timestamp);
        this.schedule(previous.owner, owner => this.emit(owner, "network.response", hop, at));
      }
      const type = typeof params.type === "string" ? params.type : "";
      // A redirect cannot adopt a request that started outside this interval.
      const owner = redirect ? previous?.owner : this.owner();
      if (!this.accepting || !owner || !this.isCurrent(owner) || !TRACKED_RESOURCE_TYPES.has(type)) {
        this.requests.delete(key);
        return;
      }
      const redirects = redirect ? (previous?.redirects ?? 0) + 1 : 0;
      const request = shapeRequest(params, redirects);
      if (!request) return;
      request.requestId = redirect && previous ? previous.request.requestId : localKey;
      const timestamp = typeof params.timestamp === "number" ? params.timestamp : Date.now() / 1000,
        wallTime = typeof params.wallTime === "number" ? params.wallTime : Date.now() / 1000;
      if (this.requests.size >= MAX_TRACKED && !this.requests.has(key)) {
        const oldest = this.requests.keys().next().value;
        if (oldest !== undefined) this.requests.delete(oldest);
      }
      const tracked: Tracked = { ...(sessionId ? { sessionId } : {}), request, owner, start: timestamp, offset: wallTime - timestamp, redirects };
      this.requests.set(key, tracked);
      // Redirects reuse the protocol request ID. Ask for this hop's upload
      // immediately, before waiting for earlier timeline writes.
      const postData = request.postDataOmitted ? this.readPostData(request, requestId, sessionId) : undefined;
      this.schedule(owner, async owner => {
        if (postData) await postData;
        await this.emit(owner, "network.request", request, wallTime * 1000);
      });
      return;
    }
    const tracked = this.requests.get(key);
    if (!tracked) return;
    if (method === "Network.responseReceived") {
      tracked.response = params;
      return;
    }
    if (method === "Network.loadingFailed") {
      this.requests.delete(key);
      const status = typeof object(object(tracked.response).response).status === "number"
        ? Number(object(object(tracked.response).response).status)
        : undefined;
      const payload = shapeFailed(tracked.request, params, this.duration(tracked, params.timestamp), status);
      const at = this.wall(tracked, params.timestamp);
      this.schedule(tracked.owner, owner => this.emit(owner, "network.failed", payload, at));
      return;
    }
    if (method !== "Network.loadingFinished") return;
    this.requests.delete(key);
    const payload = shapeResponse(
      tracked.request,
      tracked.response ?? {},
      this.duration(tracked, params.timestamp),
      typeof params.encodedDataLength === "number" ? params.encodedDataLength : undefined,
    );
    const at = this.wall(tracked, params.timestamp);
    // Resolve document ownership at completion, before another navigation.
    const subframe = !!(sessionId || tracked.sessionId ||
      (this.mainFrameId && payload.frameId && payload.frameId !== this.mainFrameId));
    this.schedule(tracked.owner, async owner => {
      // For a process-swapping navigation the completion target can differ
      // from the request target. CDP body reads use the completion session.
      Object.assign(payload, await this.body(owner, requestId, payload, sessionId, subframe));
      await this.emit(owner, "network.response", payload, at);
    });
  }
  private async readPostData(request: NetworkRequestPayload, requestId: string, sessionId?: string) {
    try {
      const result = object(await this.lease?.sendCommand("Network.getRequestPostData", { requestId }, sessionId));
      if (typeof result.postData === "string") {
        request.postData = capText(result.postData, NETWORK_LIMITS.postDataBytes);
        delete request.postDataOmitted;
      }
    } catch (error) {
      request.postDataOmitted = `无法读取请求体：${errorMessage(error)}`;
    }
  }
  private async body(
    owner: CaptureOwner,
    requestId: string,
    payload: { resourceType: string; mimeType: string; encodedDataLength?: number; status: number },
    sessionId: string | undefined,
    subframe: boolean,
  ): Promise<object> {
    if (!subframe && payload.resourceType === "Document")
      return { bodyOmitted: "文档正文见 DOM 快照，未重复保存" };
    if ((payload.encodedDataLength ?? 0) > NETWORK_LIMITS.readBodyBytes)
      return { bodyOmitted: `响应超过 ${NETWORK_LIMITS.readBodyBytes / 1024 / 1024} MiB，未读取正文` };
    if (payload.status === 204 || payload.status === 304) return { bodyOmitted: "该状态码没有响应正文" };
    if (!isTextMime(payload.mimeType)) return captureBody(undefined, payload.mimeType);
    const used = this.bodyBudget.get(owner.recordingId) ?? 0;
    if (used >= NETWORK_LIMITS.sessionBodyBytes)
      return { bodyOmitted: `本次采集的响应正文已达 ${NETWORK_LIMITS.sessionBodyBytes / 1024 / 1024} MiB 上限` };
    let response: unknown;
    try {
      response = await this.lease?.sendCommand("Network.getResponseBody", { requestId }, sessionId);
    } catch (error) {
      return { bodyOmitted: `无法读取响应正文：${errorMessage(error)}` };
    }
    if (!this.isCurrent(owner)) return {};
    // Other pages in this recording may have finished a body read while CDP was responding.
    const nowUsed = this.bodyBudget.get(owner.recordingId) ?? 0;
    const remaining = Math.min(NETWORK_LIMITS.bodyBytes, NETWORK_LIMITS.sessionBodyBytes - nowUsed);
    if (remaining <= 0) return { bodyOmitted: "本次采集的响应正文已达上限" };
    const result = captureBody(response, payload.mimeType, remaining);
    if ("body" in result) this.bodyBudget.set(owner.recordingId, nowUsed + Math.min(result.body.bytes, remaining));
    return result;
  }
  private onRuntime(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.frames?.runtime(method, params, sessionId);
    if (method === "Runtime.bindingCalled") {
      if (params.name === "__traceDockVisual") {
        const frames = this.frames;
        const context = frames?.context(params.executionContextId, sessionId);
        if (!frames || !context?.actionWorld || typeof params.payload !== "string") return;
        const data = object(JSON.parse(params.payload));
        if (data.generation !== this.generation || !Array.isArray(data.nodes) || !Array.isArray(data.removed)) return;
        const nodes = data.nodes as VisualNode[], documentId = context.documentId;
        const timestamp = new Date().toISOString();
        // Start resolving while the actual host is still alive. Writes retain arrival order.
        const owner = this.owner();
        if (!owner) return;
        const mapping = data.initial ? frames.owner(context, sessionId).catch(() => null) : undefined;
        this.schedule(owner, async () => {
          if (data.initial) {
            const host = await mapping;
            if (!host) {
              await this.sink.record("recorder.error", { message: "无法定位跨域 iframe 的宿主", possibleGap: true },
                { timestamp, summary: "iframe 快照缺少宿主映射" });
              return;
            }
            const frame = { ...host, documentId, frameId: context.frameId, url: String(data.url), baseUrl: String(data.baseUrl || data.url), nodes };
            this.archive.set(frame);
            await this.sink.record("frame.snapshot", frame, { timestamp, summary: "iframe 文档快照" });
          } else if (this.archive.has(documentId)) {
            const patch = { documentId, nodes, removed: data.removed as string[] };
            this.archive.patch(patch);
            await this.sink.record("frame.mutation", patch, { timestamp, summary: `${nodes.length} 个 iframe 节点更新 · ${patch.removed.length} 个移除` });
          }
        });
        return;
      }
      const action = this.frames?.action(params, sessionId);
      if (!action) return;
      const owner = this.owner();
      if (!owner) return;
      const path = this.frames?.actionPath(action.context, sessionId);
      this.schedule(owner, async () => {
        const hops = await path;
        if (hops?.length) action.payload.framePath = hops;
        await this.sink.record("action.frame", action.payload, {
          timestamp: new Date(action.time).toISOString(),
          summary: `${action.payload.origin} · ${action.payload.action} <${action.payload.element}>`,
        });
      });
      return;
    }
    // Enabling Runtime on a new child can replay earlier buffered console messages.
    if (sessionId && typeof params.timestamp === "number" && params.timestamp < this.intervalStart) return;
    if (method === "Runtime.consoleAPICalled") {
      const context = this.frames?.context(params.executionContextId, sessionId);
      if (context?.isolated) return;
      if (params.type === "clear" || params.type === "endGroup") return;
      const payload = shapeConsole(params),
        at = typeof params.timestamp === "number" ? params.timestamp : Date.now();
      if (context?.frameId) payload.frameId = context.frameId;
      this.schedule(this.owner(), owner => this.emit(owner, "console.message", payload, at));
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const context = this.frames?.context(object(params.exceptionDetails).executionContextId, sessionId);
      if (context?.isolated) return;
      const payload = shapeException(params),
        at = typeof params.timestamp === "number" ? params.timestamp : Date.now();
      if (context?.frameId) payload.frameId = context.frameId;
      this.schedule(this.owner(), owner => this.emit(owner, "console.exception", payload, at));
    }
  }
  async close(): Promise<void> {
    await this.stop();
    this.lease?.release();
    this.lease = undefined;
    this.requests.clear();
    delete this.frames;
  }
}
