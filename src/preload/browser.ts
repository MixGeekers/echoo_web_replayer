import { ipcRenderer } from "electron";
import { RecorderController } from "../recorder/controller";

// Bundled into one sandbox-compatible preload; no API is exposed to the website.
const recorder = new RecorderController({
  event: (envelope) => ipcRenderer.send("recorder:event", envelope),
  acknowledge: (requestId, result) =>
    ipcRenderer.send("recorder:ack", { requestId, ...result }),
});
Object.defineProperty(globalThis, "__traceDockOwner", { value: (host: Element) => recorder.frameOwner(host) });
ipcRenderer.on("recorder:state", (_event, state: unknown) =>
  recorder.state(state),
);
ipcRenderer.on("recorder:command", (_event, command: unknown) =>
  recorder.command(command),
);
const readyVersion = recorder.version;
ipcRenderer
  .invoke("recorder:ready")
  .then((state: unknown) => recorder.ready(state, readyVersion))
  .catch((error: unknown) => recorder.report("recorder-ready", error));
