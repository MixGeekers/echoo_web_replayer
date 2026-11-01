import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  CollectorAPI,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
} from "../shared/contracts/ipc";
// Electron's transport erases types. Channel signatures are checked against the shared API on both ends.
function invoke<K extends InvokeChannel>(
  name: K,
  ...args: InvokeArgs<K>
): Promise<InvokeResult<K>> {
  return ipcRenderer.invoke(`collector:${name}`, ...args) as Promise<
    InvokeResult<K>
  >;
}
function subscribe<T>(
  channel: string,
  callback: (payload: T) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}
const api: CollectorAPI = {
  getState: () => invoke("getState"),
  getTimeline: (input) => invoke("getTimeline", input),
  getEvent: (input) => invoke("getEvent", input),
  replaySeek: (input) => invoke("replaySeek", input),
  replayChunk: (input) => invoke("replayChunk", input),
  replayResources: (input) => invoke("replayResources", input),
  navigate: (input) => invoke("navigate", input),
  back: () => invoke("back"),
  forward: () => invoke("forward"),
  reload: () => invoke("reload"),
  home: () => invoke("home"),
  startSession: (input) => invoke("startSession", input),
  pauseSession: () => invoke("pauseSession"),
  resumeSession: () => invoke("resumeSession"),
  stopSession: () => invoke("stopSession"),
  snapshot: () => invoke("snapshot"),
  exportSession: (input) => invoke("exportSession", input),
  cancelExport: () => invoke("cancelExport"),
  revealExport: (input) => invoke("revealExport", input),
  setBrowserBounds: (bounds) =>
    ipcRenderer.send("collector:setBrowserBounds", bounds),
  onState: (callback) => subscribe("collector:state", callback),
  onEvent: (callback) => subscribe("collector:event", callback),
  onError: (callback) => subscribe("collector:error", callback),
  onExportProgress: (callback) =>
    subscribe("collector:exportProgress", callback),
};
contextBridge.exposeInMainWorld("collector", api);
