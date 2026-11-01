import {
  app,
  BrowserWindow,
  dialog,
  protocol,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkspace } from "./workspace";
import { installIPC } from "./ipc";
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
  const workspace = await createWorkspace(win, demoURL);
  installIPC({win, workspace, demoURL});
  protocol.handle("tracedock-resource", request => workspace.respond(request));
  await workspace.init();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("preload-error", (_event, _path, error) =>
    workspace.reportError(error),
  );
  let closing = false;
  win.on("close", (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    workspace.close().then(() => win.destroy(), error => {
      closing = false;
      workspace.reportError(error);
    });
  });
  await win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.show();

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
