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
  mcpCommand: (input) => invoke("mcpCommand", input),
  mcpConfig: () => invoke("mcpConfig"),
  getState: () => invoke("getState"),
  batchLibrary: (input) => invoke("batchLibrary", input),
  createSessionGroup: (input) => invoke("createSessionGroup", input),
  renameSessionGroup: (input) => invoke("renameSessionGroup", input),
  closeSessionGroup: (input) => invoke("closeSessionGroup", input),
  reopenSessionGroup: (input) => invoke("reopenSessionGroup", input),
  archiveSessionGroup: (input) => invoke("archiveSessionGroup", input),
  unarchiveSessionGroup: (input) => invoke("unarchiveSessionGroup", input),
  trashSessionGroup: (input) => invoke("trashSessionGroup", input),
  restoreSessionGroup: (input) => invoke("restoreSessionGroup", input),
  deleteSessionGroup: (input) => invoke("deleteSessionGroup", input),
  createProfile: (input) => invoke("createProfile", input),
  renameProfile: (input) => invoke("renameProfile", input),
  switchProfile: (input) => invoke("switchProfile", input),
  closeProfile: () => invoke("closeProfile"),
  deleteProfile: (input) => invoke("deleteProfile", input),
  clearProfileData: (input) => invoke("clearProfileData", input),
  renameSession: (input) => invoke("renameSession", input),
  archiveSession: (input) => invoke("archiveSession", input),
  unarchiveSession: (input) => invoke("unarchiveSession", input),
  trashSession: (input) => invoke("trashSession", input),
  restoreSession: (input) => invoke("restoreSession", input),
  deleteSession: (input) => invoke("deleteSession", input),
  setReplaySession: (input) => invoke("setReplaySession", input),
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
  listAnnotations: (input) => invoke("listAnnotations", input),
  createAnnotation: (input) => invoke("createAnnotation", input),
  updateAnnotation: (input) => invoke("updateAnnotation", input),
  deleteAnnotation: (input) => invoke("deleteAnnotation", input),
  markAnnotation: (input) => invoke("markAnnotation", input),
  onAnnotations: (callback) => subscribe("collector:annotations", callback),
  setBrowserBounds: (bounds) =>
    ipcRenderer.send("collector:setBrowserBounds", bounds),
  onState: (callback) => subscribe("collector:state", callback),
  onEvent: (callback) => subscribe("collector:event", callback),
  onError: (callback) => subscribe("collector:error", callback),
  onExportProgress: (callback) =>
    subscribe("collector:exportProgress", callback),
};
contextBridge.exposeInMainWorld("collector", api);
