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
  networkSummary,
  shapeConsole,
  shapeException,
  shapeFailed,
  shapeRequest,
  shapeResponse,
} from "../../shared/network-events";

export type NetworkHost = Partial<Pick<WebContents, "debugger">>;
export interface NetworkSink {
  /** Current recording ID when events should be stored, otherwise null (idle or paused). */
  recordingId(): string | null;
  record(
    type: keyof NetworkPayloadMap,
    payload: NetworkPayloadMap[keyof NetworkPayloadMap],
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
  request: NetworkRequestPayload;
  owner: CaptureOwner | null;
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
  private readonly isolatedContexts = new Set<number>();
  private queue: Promise<void> = Promise.resolve();
  private lease: BrowserDebuggerLease | undefined;
  private bodyBudget = new Map<string, number>();
  /** Opened by start() after session.start/resume, closed by stop() before session.pause/stop. */
  private capturing = false;
  private accepting = false;
  private generation = 0;
  error: string | null = null;
  constructor(
    private readonly host: NetworkHost,
    private readonly sink: NetworkSink,
  ) {}
  async init(): Promise<this> {
    try {
      const debug = (this.lease = acquireBrowserDebugger(this.host));
      debug.onMessage((method, params) => this.onMessage(method, params));
      debug.onDetach((reason) => this.fail(`网络与控制台采集已断开：${reason}`));
      // Same buffer sizes as resource capture; Network is shared on one CDP session.
      await debug.sendCommand("Network.enable", {
        maxTotalBufferSize: 64 * 1024 * 1024,
        maxResourceBufferSize: 16 * 1024 * 1024,
      });
      await debug.sendCommand("Runtime.enable");
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
  start(): void {
    this.generation++;
    this.capturing = true;
    this.accepting = true;
  }
  /** Drain already received events and their writes; later arrivals belong outside this interval. */
  async stop(): Promise<void> {
    const generation = this.generation;
    this.accepting = false;
    await this.flush();
    if (generation === this.generation) this.capturing = false;
  }
  private wall(tracked: Tracked, seconds: unknown): number {
    return typeof seconds === "number" ? (seconds + tracked.offset) * 1000 : Date.now();
  }
  private duration(tracked: Tracked, seconds: unknown): number | null {
    return typeof seconds === "number" ? Math.max(0, (seconds - tracked.start) * 1000) : null;
  }
  onMessage(method: string, value: unknown): void {
    const params = object(value);
    if (method.startsWith("Runtime.")) return this.onRuntime(method, params);
    if (!method.startsWith("Network.") || typeof params.requestId !== "string") return;
    const requestId = params.requestId;
    if (method === "Network.requestWillBeSent") {
      const previous = this.requests.get(requestId);
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
      if (!TRACKED_RESOURCE_TYPES.has(type)) {
        this.requests.delete(requestId);
        return;
      }
      const redirects = redirect ? (previous?.redirects ?? 0) + 1 : 0;
      const request = shapeRequest(params, redirects);
      if (!request) return;
      const timestamp = typeof params.timestamp === "number" ? params.timestamp : Date.now() / 1000,
        wallTime = typeof params.wallTime === "number" ? params.wallTime : Date.now() / 1000;
      if (this.requests.size >= MAX_TRACKED && !this.requests.has(requestId)) {
        const oldest = this.requests.keys().next().value;
        if (oldest !== undefined) this.requests.delete(oldest);
      }
      // An unobserved/idle first hop must never be adopted by a later redirect.
      const owner = redirect ? previous?.owner ?? null : this.owner();
      const tracked: Tracked = { request, owner, start: timestamp, offset: wallTime - timestamp, redirects };
      this.requests.set(requestId, tracked);
      const needsPostData = request.postDataOmitted !== undefined;
      this.schedule(owner, async owner => {
        if (needsPostData) {
          try {
            const result = object(await this.lease?.sendCommand("Network.getRequestPostData", { requestId }));
            if (typeof result.postData === "string") {
              request.postData = capText(result.postData, NETWORK_LIMITS.postDataBytes);
              delete request.postDataOmitted;
            }
          } catch (error) {
            request.postDataOmitted = `无法读取请求体：${errorMessage(error)}`;
          }
        }
        await this.emit(owner, "network.request", request, wallTime * 1000);
      });
      return;
    }
    const tracked = this.requests.get(requestId);
    if (!tracked) return;
    if (method === "Network.responseReceived") {
      tracked.response = params;
      return;
    }
    if (method === "Network.loadingFailed") {
      this.requests.delete(requestId);
      const status = typeof object(object(tracked.response).response).status === "number"
        ? Number(object(object(tracked.response).response).status)
        : undefined;
      const payload = shapeFailed(tracked.request, params, this.duration(tracked, params.timestamp), status);
      const at = this.wall(tracked, params.timestamp);
      this.schedule(tracked.owner, owner => this.emit(owner, "network.failed", payload, at));
      return;
    }
    if (method !== "Network.loadingFinished") return;
    this.requests.delete(requestId);
    const payload = shapeResponse(
      tracked.request,
      tracked.response ?? {},
      this.duration(tracked, params.timestamp),
      typeof params.encodedDataLength === "number" ? params.encodedDataLength : undefined,
    );
    const at = this.wall(tracked, params.timestamp);
    this.schedule(tracked.owner, async owner => {
      Object.assign(payload, await this.body(owner, requestId, payload));
      await this.emit(owner, "network.response", payload, at);
    });
  }
  private async body(
    owner: CaptureOwner,
    requestId: string,
    payload: { resourceType: string; mimeType: string; encodedDataLength?: number; status: number },
  ): Promise<object> {
    if (payload.resourceType === "Document")
      return { bodyOmitted: "文档正文见 DOM 快照，未重复保存" };
    if ((payload.encodedDataLength ?? 0) > NETWORK_LIMITS.readBodyBytes)
      return { bodyOmitted: `响应超过 ${NETWORK_LIMITS.readBodyBytes / 1024 / 1024} MiB，未读取正文` };
    if (payload.status === 204 || payload.status === 304) return { bodyOmitted: "该状态码没有响应正文" };
    const used = this.bodyBudget.get(owner.recordingId) ?? 0;
    if (used >= NETWORK_LIMITS.sessionBodyBytes)
      return { bodyOmitted: `本次采集的响应正文已达 ${NETWORK_LIMITS.sessionBodyBytes / 1024 / 1024} MiB 上限` };
    let response: unknown;
    try {
      response = await this.lease?.sendCommand("Network.getResponseBody", { requestId });
    } catch (error) {
      return { bodyOmitted: `无法读取响应正文：${errorMessage(error)}` };
    }
    if (!this.isCurrent(owner)) return {};
    const result = captureBody(response, payload.mimeType);
    if ("body" in result) this.bodyBudget.set(owner.recordingId, used + Math.min(result.body.bytes, NETWORK_LIMITS.bodyBytes));
    return result;
  }
  private onRuntime(method: string, params: Record<string, unknown>): void {
    if (method === "Runtime.executionContextCreated") {
      const context = object(params.context),
        aux = object(context.auxData);
      // TraceDock's own preload and Agent scripts run in isolated worlds.
      if (typeof context.id === "number" && (aux.isDefault === false || aux.type === "isolated"))
        this.isolatedContexts.add(context.id);
      return;
    }
    if (method === "Runtime.executionContextDestroyed") {
      if (typeof params.executionContextId === "number") this.isolatedContexts.delete(params.executionContextId);
      return;
    }
    if (method === "Runtime.executionContextsCleared") {
      this.isolatedContexts.clear();
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      if (typeof params.executionContextId === "number" && this.isolatedContexts.has(params.executionContextId)) return;
      if (params.type === "clear" || params.type === "endGroup") return;
      const payload = shapeConsole(params),
        at = typeof params.timestamp === "number" ? params.timestamp : Date.now();
      this.schedule(this.owner(), owner => this.emit(owner, "console.message", payload, at));
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const context = object(params.exceptionDetails).executionContextId;
      if (typeof context === "number" && this.isolatedContexts.has(context)) return;
      const payload = shapeException(params),
        at = typeof params.timestamp === "number" ? params.timestamp : Date.now();
      this.schedule(this.owner(), owner => this.emit(owner, "console.exception", payload, at));
    }
  }
  async close(): Promise<void> {
    await this.stop();
    this.lease?.release();
    this.lease = undefined;
    this.requests.clear();
    this.isolatedContexts.clear();
  }
}
