import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  protocol,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessionStore } from "./storage/session-store";
import { ResourceRecorder } from "./resources/index";
import { createRecordingController } from "./recording";
import { createBrowserController } from "./browser";
import { createExportJobs } from "./export-jobs";
import { installIPC } from "./ipc";
import type { AppState, BrowserState } from "../shared/contracts/ui";
import { errorMessage } from "../shared/runtime";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "tracedock-resource",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
app.setName("TraceDock");
if (process.env.TRACEDOCK_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.TRACEDOCK_DATA_DIR));
const demoURL = pathToFileURL(path.join(__dirname, "demo", "index.html")).href;
let window: BrowserWindow | undefined;
async function createWindow() {
  const store = await new SessionStore(
    path.join(app.getPath("userData"), "recordings"),
  ).init();
  const win = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: "TraceDock · 浏览器采集工作台",
    backgroundColor: "#f6f8fb",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "shell-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window = win;
  win.setMenu(null);
  const browser = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "browser-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: "persist:tracedock-browser",
      backgroundThrottling: false,
    },
  });
  win.contentView.addChildView(browser);
  const browserState: BrowserState = {
    url: demoURL,
    title: "交互实验室",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  };
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send("collector:state", state());
    }, 60);
  };
  const reportError = (error: unknown) => {
    const message = errorMessage(error);
    console.error("[TraceDock]", message);
    if (!win.isDestroyed()) win.webContents.send("collector:error", message);
  };
  // Install recorder IPC before loading the guest preload; resources attach after about:blank.
  const resources = new ResourceRecorder(store, browser.webContents, notify);
  const recording = createRecordingController({
    store,
    resources,
    browser,
    browserState,
    appVersion: app.getVersion(),
    notify,
    reportError,
    publish: (event) => {
      if (!win.isDestroyed()) win.webContents.send("collector:event", event);
    },
  });
  const jobs = createExportJobs(win, store, recording, notify, (progress) => {
    if (!win.isDestroyed())
      win.webContents.send("collector:exportProgress", progress);
  });
  const state = (): AppState => ({
    browser: { ...browserState },
    session: recording.currentSession(),
    sessions: store.list(),
    export: jobs.progress(),
  });
  const navigation = createBrowserController({
    browser,
    browserState,
    demoURL,
    notify,
    reportError,
    record: (type, payload) => {
      if (recording.currentSession()?.status === "recording")
        recording.append(type, payload).catch(reportError);
    },
  });
  installIPC({
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
  });
  await browser.webContents.loadURL("about:blank");
  await resources.init(app.getPath("userData"));
  protocol.handle("tracedock-resource", (request) =>
    resources.respond(request),
  );
  browser.setBounds({ x: 250, y: 190, width: 800, height: 650 });
  browser.setBackgroundColor("#ffffff");
  browser.setVisible(false);
  navigation.installEvents();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("preload-error", (_event, _path, error) =>
    reportError(error),
  );
  let closing = false;
  win.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    const exporting = jobs.close();
    recording
      .serialize(() => recording.stopSession("window-close"))
      .catch(reportError)
      .finally(async () => {
        await exporting;
        await store.flush().catch(reportError);
        await resources.close().catch(reportError);
        clearTimeout(broadcastTimer);
        if (!browser.webContents.isDestroyed()) browser.webContents.close();
        win.destroy();
      })
      .catch(reportError);
  });
  await win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.show();
  await navigation.navigate(demoURL);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(createWindow)
    .catch((error: unknown) => {
      dialog.showErrorBox(
        "TraceDock 启动失败",
        error instanceof Error ? error.stack || error.message : String(error),
      );
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
