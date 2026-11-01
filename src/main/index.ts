import {
  app,
  BrowserWindow,
  dialog,
  protocol,
  shell,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkspace } from "./workspace";
import { installIPC } from "./ipc";
import { randomUUID } from "node:crypto";
import { createMCPController } from "./mcp/controller";
import { createMCPServer } from "./mcp/server";
import { createMCPTools } from "./mcp/tools";
import { createAgentBrowser } from "./mcp/browser";
import fs from "node:fs/promises";
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
  const instanceId=randomUUID(),mcpRoot=path.join(workspace.root,"mcp");
  const mcp=await createMCPController(workspace,mcpRoot,instanceId);
  workspace.setMCPHooks(mcp);
  const agentBrowser=createAgentBrowser({getWebContents:()=>workspace.requireRuntime().browser.webContents});
  const mcpTools=await createMCPTools({workspace,access:mcp,browser:agentBrowser,dataRoot:mcpRoot});
  mcp.setOperations({...mcpTools.operations,revealForUI:async(id:string)=>{
    const op=mcpTools.operations.getForUI(id),result=op?.result as {path?:string}|undefined;
    if(op?.kind!=="export"||op.state!=="succeeded"||!result?.path||!result.path.startsWith(mcpTools.exportDirectory+path.sep))throw new Error("没有可打开的导出文件");
    await fs.access(result.path);shell.showItemInFolder(result.path);
  }});
  const mcpServer=await createMCPServer({root:mcpRoot,instanceId,onConnect:mcp.connect,onDisconnect:mcp.disconnected,onCall:mcpTools.call});
  mcp.setTransportDisconnect(id=>mcpServer.disconnect(id));
  installIPC({win, workspace, demoURL,mcp,mcpConfig:()=>({
    command:process.execPath,args:[path.join(__dirname,"mcp-stdio.cjs"),"--discovery",mcpServer.discoveryPath,"--client-id","local-agent"],
    env:{ELECTRON_RUN_AS_NODE:"1"},instanceId,
  })});
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
    (async()=>{
      if(workspace.jobs.progress()){
        const answer=await dialog.showMessageBox(win,{type:"question",title:"导出尚未完成",message:"有分析包正在导出",detail:"可以等待导出完成，或取消导出后退出。",buttons:["等待导出后退出","取消导出并退出","返回工作台"],defaultId:0,cancelId:2,noLink:true});
        if(answer.response===2){closing=false;return false;}
        if(answer.response===1)workspace.jobs.cancel();
        await workspace.jobs.waitForIdle();
      }
      await mcp.close();await mcpServer.close();agentBrowser.dispose();
      await workspace.close();await mcpTools.operations.close();
      return true;
    })().then(exit => {if(exit)win.destroy();}, error => {
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
