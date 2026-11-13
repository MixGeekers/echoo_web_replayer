import { app, BrowserWindow, WebContentsView } from "electron";
import type { BrowserWindowConstructorOptions, WebContents, WebPreferences } from "electron";
import path from "node:path";
import { createBrowserController } from "./browser";
import { createRecordingController } from "./recording";
import { RecordingPage } from "./recording-page";
import { isAgentInputDispatch } from "./mcp/browser";
import type { SessionStore } from "./storage/session-store";
import type { BrowserBounds, BrowserPageInfo, BrowserPageKind, BrowserState, EventNotice } from "../shared/contracts/ui";
import type { ApplicationEventSink } from "../shared/contracts/application";

interface Page {
  capture: RecordingPage;
  kind: BrowserPageKind;
  openerId: string | null;
  view?: WebContentsView;
  window?: BrowserWindow;
  navigation: ReturnType<typeof createBrowserController>;
}
interface Options {
  win: BrowserWindow;
  root: string;
  store: SessionStore;
  demoURL: string;
  profile: () => { id: string; name: string };
  notify(): void;
  notifyLater(): void;
  reportError(error: unknown): void;
  publish(event: EventNotice): void;
  controlled(): boolean;
  targetChanged(): void;
  empty(): void;
}
export function closedBrowserState(): BrowserState {
  return { available: false, url: "", title: "浏览环境已关闭", loading: false, canGoBack: false, canGoForward: false, error: null };
}

export class BrowserEnvironment {
  readonly recording: ReturnType<typeof createRecordingController>;
  private readonly pages = new Map<string, Page>();
  private readonly closingPages = new Set<Promise<void>>();
  private readonly pendingSelections = new Set<Promise<unknown>>();
  private readonly bodyBudget = new Map<string, number>();
  private bounds: BrowserBounds = { x: 0, y: 0, width: 1, height: 1, visible: false };
  private nextPage = 1;
  private selectedId: string | null = null;
  private disposing = false;
  private readonly preferences: WebPreferences;

  constructor(readonly profileId: string, private options: Options) {
    this.preferences = {
      preload: path.join(__dirname, "browser-preload.cjs"), partition: `persist:tracedock-profile-${profileId}`,
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
    };
    this.recording = createRecordingController({
      ...options, appVersion: app.getVersion(), pages: () => [...this.pages.values()].map(p => p.capture),
      selected: () => this.selected?.capture,
      drainPages: () => Promise.all([...this.closingPages, ...this.pendingSelections]),
    });
  }
  get activePageId() { return this.selectedId; }
  private get selected() { return this.selectedId ? this.pages.get(this.selectedId) : undefined; }
  private get current(): Page {
    if (!this.selected) throw new Error("浏览环境正在恢复，请稍后重试");
    return this.selected;
  }
  get contents() { return this.current.capture.contents; }
  get navigation() { return this.current.navigation; }
  get state() { return this.selected?.capture.state ?? closedBrowserState(); }
  get captureError() { return this.selected?.capture.resources.captureError ?? null; }
  list(): BrowserPageInfo[] {
    return [...this.pages.values()].map(({ capture, kind, openerId }) => ({
      id: capture.id, kind, openerId, title: capture.state.title, url: capture.state.url,
    }));
  }
  recorderFor(contents: WebContents) {
    for (const page of this.pages.values()) if (page.capture.contents === contents) return page.capture;
    return undefined;
  }
  setBounds(bounds: BrowserBounds) {
    this.bounds = bounds;
    for (const page of this.pages.values()) {
      if (!page.view) continue;
      page.view.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
      page.view.setVisible(page === this.selected && bounds.visible);
    }
  }
  private select(page: Page, focus: boolean) {
    const previous = this.selectedId;
    if (previous !== page.capture.id) {
      this.selectedId = page.capture.id;
      this.setBounds(this.bounds);
      if (previous) this.options.targetChanged();
      if (this.recording.recordingState().recording) {
        void this.recording.append("page.select", { previousPageId: previous }, {}, page.capture).catch(this.options.reportError);
        // A fresh foreground baseline also makes a return from a login popup seekable in replay.
        if (!page.capture.contents.isLoadingMainFrame() && page.capture.contents.getURL()) {
          const task = this.recording.checkpoint("snapshot", "page-selected", [page.capture]).catch(this.options.reportError);
          this.pendingSelections.add(task);
          void task.finally(() => this.pendingSelections.delete(task));
        }
      }
      this.options.notify();
    }
    if (!focus) return;
    const host = page.window ?? this.options.win;
    if (host.isMinimized()) host.restore();
    host.show();
    host.focus();
    page.capture.contents.focus();
  }
  selectPage(id: string) {
    const page = this.pages.get(id);
    if (!page) throw new Error("页面已关闭");
    this.select(page, true);
  }
  closePage(id: string) {
    const page = this.pages.get(id);
    if (!page) return;
    if (page.window) page.window.close();
    else page.capture.contents.close({ waitForBeforeUnload: true });
  }

  async newPage(kind: BrowserPageKind, focus = true) {
    const page = this.add(kind, null, this.options.demoURL, {}, true, focus);
    // Attach the collectors before navigating to the initial site.
    await page.capture.ready;
    if (!page.capture.contents.isDestroyed()) await page.navigation.navigate(this.options.demoURL);
    return page;
  }
  private add(kind: BrowserPageKind, openerId: string | null, url: string,
    nativeOptions: BrowserWindowConstructorOptions, foreground: boolean, focus: boolean): Page {
    const { win, store, root, demoURL, notify, reportError } = this.options;
    const id = `${kind}-${this.nextPage++}`;
    // Electron supplies the child's existing WebContents in nativeOptions. Adopting it
    // preserves the navigation, POST body, opener, WindowProxy and named window semantics.
    const options = { ...nativeOptions, webPreferences: this.preferences };
    const view = kind === "tab" ? new WebContentsView(options) : undefined;
    const popup = view ? undefined : new BrowserWindow({ ...options, show: false, autoHideMenuBar: true });
    const contents = view ? view.webContents : popup!.webContents;
    const state: BrowserState = { ...closedBrowserState(), available: true, url, title: "" };
    const capture: RecordingPage = new RecordingPage(id, contents, state, store, root, notify, {
      recordingId: () => {
        const session = this.recording.currentSession();
        return session?.status === "recording" ? session.id : null;
      },
      record: (type, payload, extra) => this.recording.append(type, payload, extra, capture),
      error: message => { if (!contents.isDestroyed()) console.error("[TraceDock]", message); },
    }, this.bodyBudget, () => ({ pageId: id, activePageId: this.selectedId ?? undefined }), openerId === null);
    const record: ApplicationEventSink = (type, payload) => {
      if (this.recording.recordingState().recording)
        void this.recording.append(type, payload, {}, capture).catch(reportError);
    };
    const navigation = createBrowserController({ contents, browserState: state, demoURL, notify, reportError, record });
    const page: Page = { capture, kind, openerId, navigation, ...(view ? { view } : {}), ...(popup ? { window: popup } : {}) };
    this.pages.set(id, page);
    contents.once("destroyed", () => this.removed(page));
    if (view) {
      view.setBackgroundColor("#ffffff");
      view.setVisible(false);
      win.contentView.addChildView(view);
    }
    if (popup) {
      popup.setMenu(null);
      popup.on("focus", () => { if (this.pages.has(id) && !this.disposing) this.select(page, false); });
    }
    navigation.installEvents();
    contents.setWindowOpenHandler(details => {
      if (this.disposing) return { action: "deny" };
      if (!/^https?:\/\//i.test(details.url) && details.url !== "about:blank" && details.url !== "" && details.url !== demoURL) {
        reportError(new Error("已阻止此窗口使用不支持的页面协议"));
        return { action: "deny" };
      }
      const childKind = details.disposition === "new-window" ? "window" : "tab";
      return {
        action: "allow", outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences: this.preferences },
        createWindow: childOptions => {
          const foreground = details.disposition !== "background-tab";
          const child = this.add(childKind, id, details.url || "about:blank", childOptions, foreground, foreground);
          record("page.popup", { url: details.url, disposition: details.disposition, targetPageId: child.capture.id });
          return child.capture.contents;
        },
      };
    });
    const blockInput = (event: Electron.Event) => {
      if (this.options.controlled() && !isAgentInputDispatch(contents)) event.preventDefault();
    };
    contents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && (input.control || input.meta) && input.shift && !input.alt && input.code === "KeyF") {
        event.preventDefault();
        if (!win.isDestroyed()) win.webContents.send("shell:toggleFocusMode");
        return;
      }
      blockInput(event);
    });
    contents.on("before-mouse-event", blockInput);
    record("page.open", { url, kind, openerId });
    const session = this.recording.recordingState();
    void (session.recording && session.sessionId ? capture.start(session.sessionId) : capture.ready).catch(reportError);
    if (foreground) this.select(page, focus);
    if (popup && !popup.isVisible()) popup.showInactive();
    notify();
    return page;
  }

  private removed(page: Page) {
    const id = page.capture.id;
    if (!this.pages.has(id)) return;
    if (this.recording.recordingState().recording)
      void this.recording.append("page.close", { url: page.capture.state.url }, {}, page.capture).catch(this.options.reportError);
    this.pages.delete(id);
    if (page.view && !this.options.win.isDestroyed()) this.options.win.contentView.removeChildView(page.view);
    const cleanup = page.capture.close().catch(this.options.reportError);
    this.closingPages.add(cleanup);
    void cleanup.finally(() => this.closingPages.delete(cleanup));
    if (id === this.selectedId) {
      const next = (page.openerId && this.pages.get(page.openerId)) || [...this.pages.values()].at(-1);
      if (next && !this.disposing) this.select(next, false);
      else this.selectedId = null;
    }
    if (!this.pages.size && !this.disposing) this.options.empty();
    this.options.notify();
  }

  async dispose(reason: string) {
    this.disposing = true;
    try {
      await this.recording.stopSession(reason);
    } catch (error) {
      this.disposing = false;
      throw error;
    }
    // WebContents.close() may return before "destroyed". Finish the old environment's
    // teardown before opening the next one or clearing its browser partition.
    await Promise.all([...this.pages.values()].map(async page => {
      const destroyed = new Promise<void>(resolve => page.capture.contents.once("destroyed", resolve));
      if (page.window) page.window.destroy();
      else page.capture.contents.close();
      await destroyed;
    }));
    await Promise.all(this.closingPages);
    await this.options.store.flush();
  }
}
