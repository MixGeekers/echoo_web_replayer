import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { WebContents } from "electron";
import type { SessionStore } from "../storage/session-store";
import type { ResourceEntry } from "../../shared/contracts/resources";
import { object, errorMessage, errorCode } from "../../shared/runtime";
import { acquireBrowserDebugger } from "../browser-debugger";
import type { BrowserDebuggerLease } from "../browser-debugger";

const RESOURCE_TYPES = new Set(["Stylesheet", "Image", "Font"]);
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024,
  MAX_CACHE_BYTES = 256 * 1024 * 1024;
export type ResourceHost = Partial<Pick<WebContents, "debugger">>;
const MAX_TRACKED_REQUESTS = 5000;
interface RequestOwner {
  generation: number;
  sessionId: string | null;
}
interface PendingEntry extends RequestOwner {
  url: string;
  mimeType: string;
  type: string;
  statusCode: number;
  capturedAt: string;
  expectedBytes: number;
}
type CapturedEntry = PendingEntry & ResourceEntry;
export class ResourceCapture {
  private readonly current = new Map<
    string,
    { entry: CapturedEntry; filename: string | undefined }
  >();
  private readonly requests = new Map<string, RequestOwner>();
  private readonly loaderGenerations = new Map<string, number>();
  private readonly frameGenerations = new Map<string, number>();
  private childSessions = new Set<string>();
  private mainLoaderId: string | undefined;
  private sessionStartGeneration = 0;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly saved = new Map<string, string | undefined>();
  private queue: Promise<void> = Promise.resolve();
  private sessionId: string | null = null;
  private cache: string | undefined;
  private cacheBytes = 0;
  private generation = 0;
  private mainFrameId: string | undefined;
  private debugLease: BrowserDebuggerLease | undefined;
  error: string | null = null;
  constructor(
    private readonly store: SessionStore,
    private readonly host: ResourceHost,
    private readonly changed: (id?: string) => void,
  ) {}
  async init(root: string): Promise<void> {
    this.cache = await fs.mkdtemp(path.join(root, ".resource-cache-"));
    try {
      const debug = this.debugLease = acquireBrowserDebugger(this.host);
      debug.onMessage((method, params, session) => this.onMessage(method, params, session), true);
      debug.onDetach((reason) => {
        this.error = `静态资源采集已断开：${reason}`;
        this.changed();
      });
      await debug.sendCommand("Page.enable");
      const frameTree = object(
        object(await debug.sendCommand("Page.getFrameTree")).frameTree,
      );
      const frame = object(frameTree.frame);
      if (typeof frame.id !== "string") throw new Error("无效的主框架标识");
      this.mainFrameId = frame.id;
      this.mainLoaderId =
        typeof frame.loaderId === "string" ? frame.loaderId : undefined;
      this.seedFrameTree(frameTree);
      await debug.sendCommand("Network.enable", {
        maxTotalBufferSize: 64 * 1024 * 1024,
        maxResourceBufferSize: MAX_RESOURCE_BYTES,
      });
    } catch (error) {
      this.error = `静态资源采集不可用：${errorMessage(error)}`;
    }
  }
  private rememberLoader(loader: unknown, generation: number): void {
    if (
      typeof loader !== "string" ||
      !loader ||
      this.loaderGenerations.has(loader)
    ) return;
    if (this.loaderGenerations.size >= MAX_TRACKED_REQUESTS) {
      const oldest = this.loaderGenerations.keys().next().value;
      if (oldest !== undefined) this.loaderGenerations.delete(oldest);
    }
    this.loaderGenerations.set(loader, generation);
  }
  private rememberFrame(frameId: string, generation: number): void {
    if (
      !this.frameGenerations.has(frameId) &&
      this.frameGenerations.size >= MAX_TRACKED_REQUESTS
    ) {
      const oldest = this.frameGenerations.keys().next().value;
      if (oldest !== undefined) this.frameGenerations.delete(oldest);
    }
    this.frameGenerations.set(frameId, generation);
  }
  private seedFrameTree(tree: Record<string, unknown>): void {
    const frame = object(tree.frame);
    if (typeof frame.id === "string")
      this.rememberFrame(frame.id, this.generation);
    this.rememberLoader(frame.loaderId, this.generation);
    if (Array.isArray(tree.childFrames))
      for (const child of tree.childFrames) this.seedFrameTree(object(child));
  }
  private navigate(frameId: string, loader: unknown): void {
    const loaderId = typeof loader === "string" && loader ? loader : undefined;
    // requestWillBeSent starts the boundary; frameNavigated confirms it, and may
    // replace the top-frame ID. A matching loader must not discard new assets twice.
    if (loaderId === undefined || loaderId !== this.mainLoaderId) {
      this.current.clear();
      this.generation++;
    }
    this.mainFrameId = frameId;
    this.mainLoaderId = loaderId;
    if (loaderId !== undefined) {
      this.loaderGenerations.delete(loaderId);
      this.rememberLoader(loaderId, this.generation);
    }
  }
  onMessage(method: string, value: unknown, session?: string): void {
    const params = object(value);
    if (session && !this.childSessions.has(session)) return;
    if (method === "Target.attachedToTarget" && object(params.targetInfo).type === "iframe" && typeof params.sessionId === "string") {
      this.childSessions.add(params.sessionId);
      return;
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      this.childSessions.delete(params.sessionId);
      const prefix = params.sessionId + ":";
      for (const key of this.requests.keys()) if (key.startsWith(prefix)) {
        this.requests.delete(key);
        this.pending.delete(key);
      }
      return;
    }
    if (method === "Page.frameAttached") {
      if (
        typeof params.frameId === "string" &&
        typeof params.parentFrameId === "string"
      ) {
        this.rememberFrame(
          params.frameId,
          this.frameGenerations.get(params.parentFrameId) ?? -1,
        );
      }
      return;
    }
    if (method === "Page.frameNavigated") {
      const frame = object(params.frame);
      if (typeof frame.id !== "string") return;
      if (!session && !frame.parentId) {
        this.navigate(frame.id, frame.loaderId);
        // A new top document owns its frame only after commit. Until then the
        // outgoing page can still create/navigate child frames (including srcdoc).
        this.rememberFrame(frame.id, this.generation);
      } else {
        // Keep old child-frame ownership even after its parent frame is reused.
        // Unknown frames cannot safely be assigned to the current document.
        const generation = this.frameGenerations.get(frame.id) ?? -1;
        this.rememberLoader(frame.loaderId, generation);
      }
      return;
    }
    if (typeof params.requestId !== "string") return;
    const rawId = params.requestId;
    const requestId = session ? session + ":" + rawId : rawId;
    if (method === "Network.requestWillBeSent") {
      // Redirects reuse requestId. Keep its initial ownership, including when
      // the redirect arrives after navigation or a recording-session change.
      if (params.redirectResponse !== undefined) {
        this.pending.delete(requestId);
        return;
      }
      if (params.type === "Document") {
        if (
          params.frameId === this.mainFrameId &&
          typeof params.frameId === "string"
        ) this.navigate(params.frameId, params.loaderId);
        else this.rememberLoader(
          params.loaderId,
          typeof params.frameId === "string"
            ? this.frameGenerations.get(params.frameId) ?? -1
            : -1,
        );
      }
      if (this.requests.size >= MAX_TRACKED_REQUESTS) {
        const oldest = this.requests.keys().next().value;
        if (oldest !== undefined) {
          this.requests.delete(oldest);
          this.pending.delete(oldest);
        }
      }
      const generation =
        typeof params.loaderId === "string" && params.loaderId
          ? this.loaderGenerations.get(params.loaderId) ?? -1
          : -1;
      this.requests.set(requestId, {
        generation,
        // Old documents may keep issuing requests after a newer recording starts.
        sessionId:
          generation >= this.sessionStartGeneration ? this.sessionId : null,
      });
      return;
    }
    if (
      method === "Network.responseReceived" &&
      typeof params.type === "string" &&
      RESOURCE_TYPES.has(params.type)
    ) {
      const owner = this.requests.get(requestId);
      // Missing/evicted request metadata must never be inferred from the page
      // currently shown when a late response happens to arrive.
      if (!owner) return;
      const response = object(params.response),
        headers = object(response.headers);
      if (
        typeof response.url !== "string" ||
        typeof response.mimeType !== "string" ||
        typeof response.status !== "number"
      )
        return;
      this.pending.set(requestId, {
        url: response.url.split("#")[0] || "",
        mimeType: response.mimeType,
        type: params.type,
        statusCode: response.status,
        capturedAt: new Date().toISOString(),
        ...owner,
        expectedBytes: Number(
          headers["content-length"] || headers["Content-Length"] || 0,
        ),
      });
    }
    if (method === "Network.loadingFailed") {
      const entry = this.pending.get(requestId);
      this.pending.delete(requestId);
      this.requests.delete(requestId);
      if (entry)
        this.schedule(() =>
          this.accept({
            ...entry,
            error:
              typeof params.errorText === "string"
                ? params.errorText
                : "Resource load failed",
            status: "missing",
          }),
        );
    }
    if (method !== "Network.loadingFinished") return;
    const entry = this.pending.get(requestId);
    this.pending.delete(requestId);
    this.requests.delete(requestId);
    if (!entry) return;
    this.schedule(async () => {
      try {
        if (entry.statusCode >= 400)
          throw new Error(`HTTP ${entry.statusCode}`);
        if (
          entry.expectedBytes > MAX_RESOURCE_BYTES ||
          (typeof params.encodedDataLength === "number" &&
            params.encodedDataLength > MAX_RESOURCE_BYTES)
        )
          throw new Error("资源超过 16 MB 保存上限");
        if (this.cacheBytes >= MAX_CACHE_BYTES)
          throw new Error("本次运行的静态资源缓存达到 256 MB 上限");
        const debug = this.debugLease;
        if (!debug || !this.cache) throw new Error("静态资源采集尚未初始化");
        const response = object(
          await debug.sendCommand("Network.getResponseBody", { requestId: rawId }, session),
        );
        if (typeof response.body !== "string")
          throw new Error("无效的资源响应");
        const body = Buffer.from(
          response.body,
          response.base64Encoded ? "base64" : "utf8",
        );
        if (
          body.length > MAX_RESOURCE_BYTES ||
          body.length + this.cacheBytes > MAX_CACHE_BYTES
        )
          throw new Error("静态资源超过缓存容量上限");
        const sha256 = createHash("sha256").update(body).digest("hex"),
          filename = path.join(this.cache, sha256);
        try {
          await fs.writeFile(filename, body, { flag: "wx" });
          this.cacheBytes += body.length;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        await this.accept(
          { ...entry, sha256, bytes: body.length, status: "saved" },
          filename,
        );
      } catch (error) {
        await this.accept({
          ...entry,
          status: "missing",
          error: errorMessage(error),
        });
      }
    });
  }
  private schedule(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.error = `保存静态资源失败：${errorMessage(error)}`;
      this.changed();
    });
  }
  private async accept(entry: CapturedEntry, filename?: string): Promise<void> {
    if (entry.generation === this.generation && this.current.size < 5000)
      this.current.set(entry.url, { entry, filename });
    if (
      this.sessionId &&
      (entry.sessionId === this.sessionId ||
        (!entry.sessionId && entry.generation === this.generation))
    )
      await this.persist(entry, filename);
  }
  private async persist(
    entry: CapturedEntry,
    filename?: string,
  ): Promise<void> {
    const id = this.sessionId;
    if (!id || this.store.getSession(id).status !== "recording") return;
    const key = `${id}:${entry.url}`,
      signature = entry.sha256 || entry.error;
    if (this.saved.get(key) === signature) return;
    const {
      generation: _generation,
      sessionId: _sessionId,
      expectedBytes: _expectedBytes,
      ...record
    } = entry;
    await this.store.saveResource(id, record, filename);
    this.saved.set(key, signature);
    this.changed(id);
  }
  async start(id: string | null): Promise<void> {
    await this.flush();
    this.sessionId = id;
    this.sessionStartGeneration = this.generation;
    for (const { entry, filename } of this.current.values())
      await this.persist(entry, filename);
  }
  async flush(): Promise<void> {
    await this.queue;
  }
  async stop(): Promise<void> {
    await this.flush();
    this.sessionId = null;
  }
  async close(): Promise<void> {
    await this.stop();
    this.debugLease?.release();
    this.debugLease = undefined;
    if (this.cache) await fs.rm(this.cache, { recursive: true, force: true });
    this.requests.clear();
    this.pending.clear();
    this.loaderGenerations.clear();
    this.frameGenerations.clear();
    this.current.clear();
  }
}
