import type { WebContents } from "electron";

type Debugger = WebContents["debugger"];
type MessageListener = (method: string, params: unknown) => void;
type DetachListener = (reason: string) => void;
interface Entry {
  debug: Debugger;
  owners: Set<symbol>;
  ownedAttachment: boolean;
  detached: boolean;
}
const entries = new WeakMap<Debugger, Entry>();

/** One CDP transport, shared by resource capture and Agent operations. */
export function acquireBrowserDebugger(host: { debugger?: Debugger }) {
  const debug = host.debugger;
  if (!debug) throw new Error("浏览器调试接口不可用");
  let entry = entries.get(debug);
  if (!entry) {
    const ownedAttachment = !debug.isAttached();
    if (ownedAttachment) debug.attach("1.3");
    entry = { debug, owners: new Set(), ownedAttachment, detached: false };
    entries.set(debug, entry);
  }
  if (entry.detached || !debug.isAttached()) throw new Error("浏览器调试连接已断开，请重新打开环境");
  const current = entry, owner = Symbol("debugger-owner");
  current.owners.add(owner);
  let released = false;
  const cleanup: Array<() => void> = [];
  const onDetached = (_event: unknown, _reason: string) => { current.detached = true; };
  debug.on("detach", onDetached);
  cleanup.push(() => debug.removeListener("detach", onDetached));
  return {
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (released || current.detached || !debug.isAttached()) return Promise.reject(new Error("浏览器调试连接已断开"));
      return debug.sendCommand(method, params) as Promise<unknown>;
    },
    onMessage(listener: MessageListener) {
      const wrapped = (_event: unknown, method: string, params: unknown) => listener(method, params);
      debug.on("message", wrapped);
      cleanup.push(() => debug.removeListener("message", wrapped));
    },
    onDetach(listener: DetachListener) {
      const wrapped = (_event: unknown, reason: string) => listener(reason);
      debug.on("detach", wrapped);
      cleanup.push(() => debug.removeListener("detach", wrapped));
    },
    release() {
      if (released) return;
      released = true;
      cleanup.forEach(fn => fn());
      current.owners.delete(owner);
      if (!current.owners.size) {
        entries.delete(debug);
        if (current.ownedAttachment && debug.isAttached()) debug.detach();
      }
    },
  };
}
export type BrowserDebuggerLease = ReturnType<typeof acquireBrowserDebugger>;
