import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { NetworkCapture, type NetworkSink } from "./network/capture";
import { ResourceRecorder } from "./resources/index";
import type { SessionStore } from "./storage/session-store";
import type { BrowserState } from "../shared/contracts/ui";
import { object } from "../shared/runtime";

/** Each top-level document has its own debugger, preload acknowledgements and resource queue. */
export class RecordingPage {
  readonly network: NetworkCapture;
  readonly resources: ResourceRecorder;
  readonly ready: Promise<unknown>;
  private resourceQueue: Promise<unknown>;
  private pending = new Map<string, (error?: Error) => void>();

  constructor(readonly id: string, readonly contents: WebContents, readonly state: BrowserState,
    store: SessionStore, root: string, notify: () => void, sink: NetworkSink, bodyBudget: Map<string, number>,
    source: () => { pageId: string; activePageId: string | undefined }, initializeBlank: boolean) {
    this.network = new NetworkCapture(contents, sink, bodyBudget);
    this.resources = new ResourceRecorder(store, contents, notify, source);
    const init = () => Promise.all([this.network.init(), this.resources.init(root)]);
    // A manually created view has no renderer until its first navigation.
    // A site-created child already owns a navigation that must run untouched.
    this.ready = initializeBlank ? contents.loadURL("about:blank").then(init) : init();
    this.resourceQueue = this.ready.catch(() => {});
    contents.once("destroyed", () => {
      for (const finish of this.pending.values()) finish(new Error("页面已关闭，采集命令未完成"));
    });
  }

  private enqueue(operation: () => Promise<void>) {
    const next = this.resourceQueue.then(operation);
    this.resourceQueue = next.catch(() => {});
    return next;
  }
  async start(id: string) {
    await Promise.all([this.network.start(), this.enqueue(() => this.resources.start(id))]);
  }
  async stop() {
    await Promise.all([this.network.stop(), this.enqueue(() => this.resources.stop())]);
  }
  async close() {
    await this.ready.catch(() => {});
    await Promise.all([this.network.close(), this.enqueue(() => this.resources.close())]);
  }
  async command(command: string, reason: string) {
    await this.network.flushFrameDocuments();
    if (this.contents.isDestroyed()) throw new Error("页面已关闭");
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        this.pending.delete(requestId);
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error("页面采集器未响应，页面可能正在跳转")), 4500);
      this.pending.set(requestId, finish);
      try { this.contents.send("recorder:command", { command, reason, requestId }); }
      catch (error) { finish(error as Error); }
    });
  }
  acknowledge(value: unknown) {
    const payload = object(value);
    if (typeof payload.requestId !== "string") return;
    this.pending.get(payload.requestId)?.(payload.ok === false
      ? new Error(typeof payload.error === "string" ? payload.error : "页面采集命令失败") : undefined);
  }
}
