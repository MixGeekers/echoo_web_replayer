import { readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserDebuggerLease } from "../browser-debugger";
import { object, errorMessage } from "../../shared/runtime";
import { NETWORK_LIMITS } from "../../shared/network-events";
import { frameControlKeys, type FrameActionPayload, type FrameSelector } from "../../shared/contracts/application";

const world = "TraceDock frame actions";
const binding = "__traceDockFrameAction";
const actionNames = ["click", "dblclick", "input", "change", "keydown", "submit", "focusin", "scroll"];
// Installed in a private world in each document. Accessible frame chains are
// already observed by the normal recorder, including nested same-origin frames.
const source = `(() => {
  if (self === top || globalThis.frameActionsInstalled) return;
  try {
    let current = self;
    while (current !== top && current.frameElement) current = current.parent;
    if (current === top) return;
  } catch {}
  globalThis.frameActionsInstalled = true;
  const nodes = new WeakMap();
  let nextId = 0, lastScroll = -Infinity;
  for (const action of ${JSON.stringify(actionNames)}) {
    document.addEventListener(action, event => {
      if (!globalThis.frameRecording || !event.isTrusted) return;
      if (action === "scroll") {
        if (performance.now() - lastScroll < 150) return;
        lastScroll = performance.now();
      }
      const target = event.composedPath()[0] || event.target;
      if (!target) return;
      if (!nodes.has(target)) nodes.set(target, ++nextId);
      const actionEvent = {
        generation: globalThis.frameRecording, action, element: (target.localName || "#document").slice(0, 64),
        node: nodes.get(target), visualNodeId: globalThis.__traceDockVisualNodeId?.(target), time: Date.now(), origin: location.origin
      };
      let message = JSON.stringify(actionEvent);
      try {
        const details = JSON.stringify({...actionEvent, ...globalThis.__traceDockActionDetails?.(target, event)});
        if (details.length <= 65536) message = details;
      } catch {}
      globalThis.${binding}(message);
    }, {capture: true, passive: true});
  }
})();`;

interface Context {
  documentId: string;
  frameId: string;
  isolated: boolean;
  actionWorld: boolean;
  preload: boolean;
}

/** A target may contain several frames. Runtime context IDs are local to that target. */
export class FrameSessions {
  private readonly sessions = new Map<string, Map<number, Context>>([["", new Map()]]);
  private interval = 0;
  private ownerPaths = new WeakMap<Context, { hops: FrameSelector[]; parent?: Context }>();
  private pendingPaths = new WeakMap<Context, Promise<unknown>>();
  private parents = new Map<string, {session: string; frameId: string}>();
  private visualSource = readFileSync(path.join(__dirname, "frame-visual.js"), "utf8");
  constructor(private debug: BrowserDebuggerLease, private report: (message: string) => void,
    private onDocumentEnd: (doc: string) => void) {}



  private async setIntervalInContext(id: number, sessionId: string, generation: number): Promise<void> {
    try {
      await this.debug.sendCommand("Runtime.evaluate", {
        expression: `globalThis.frameDocument = ${JSON.stringify(this.context(id, sessionId)?.documentId)};
          globalThis.frameRecording = ${generation}; globalThis.__traceDockVisualState?.()`, contextId: id,
      }, sessionId || undefined);
    } catch (error) {
      // Navigation can destroy the context while the command is in flight.
      if (generation && this.context(id, sessionId)?.actionWorld && this.interval === generation &&
          !/context.*(destroyed|not found)|cannot find context/i.test(errorMessage(error)))
        this.report(`iframe 录制状态更新失败：${errorMessage(error)}`);
    }
  }
  async recording(generation: number): Promise<void> {
    this.interval = generation;
    const updates = [];
    for (const [session, contexts] of this.sessions)
      for (const [id, context] of contexts)
        if (context.actionWorld) updates.push(this.setIntervalInContext(id, session, generation));
    await Promise.all(updates);
  }

  async flushVisuals() {
    const flushes = [];
    for (const [session, contexts] of this.sessions) {
      for (const context of contexts.values()) {
        if (context.actionWorld && this.interval)
          flushes.push(this.debug.sendCommand("Runtime.evaluate", {
            expression: "globalThis.__traceDockFlushVisual?.()", uniqueContextId: context.documentId,
          }, session || undefined).catch(() => {})); // Navigation destroys the world.
      }
    }
    await Promise.all(flushes);
  }
  async enable(sessionId?: string): Promise<void> {
    const send = (method: string, params?: Record<string, unknown>) =>
      this.debug.sendCommand(method, params, sessionId);
    await send("Network.enable", { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024,
      maxPostDataSize: NETWORK_LIMITS.postDataBytes });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Runtime.addBinding", { name: binding, executionContextName: world });
    await send("Runtime.addBinding", { name: "__traceDockVisual", executionContextName: world });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: source + "\n" + this.visualSource, worldName: world, runImmediately: true });
    await send("Target.setAutoAttach", {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    });
  }

  attach(params: Record<string, unknown>, parent = ""): void {
    const id = params.sessionId;
    if (typeof id !== "string" || object(params.targetInfo).type !== "iframe" || this.sessions.has(id)) return;
    this.sessions.set(id, new Map());
    this.parents.set(id, { session: parent, frameId: String(object(params.targetInfo).targetId) });
    void (async () => {
      try {
        await this.enable(id);
      } finally {
        if (params.waitingForDebugger && this.sessions.has(id))
          await this.debug.sendCommand("Runtime.runIfWaitingForDebugger", {}, id);
      }
    })().catch(error => {
      if (this.sessions.has(id)) this.report(`iframe 采集连接失败：${errorMessage(error)}`);
    });
  }

  detach(id: string): void {
    for (const [childId, parent] of this.parents) if (parent.session === id) this.detach(childId);
    for (const context of this.sessions.get(id)?.values() ?? [])
      if (context.actionWorld) this.onDocumentEnd(context.documentId);
    this.sessions.delete(id);
    this.parents.delete(id);
  }

  /** Ask Chromium which actual element owns this frame. Identical URLs, names,
   * sibling reordering and nested frames therefore keep distinct host IDs. */
  async owner(frame: Context, session = "") {
    const target = this.parents.get(session);
    const parent = target?.frameId === frame.frameId ? target.session : session;
    const send = (method: string, params: Record<string, unknown>) =>
      this.debug.sendCommand(method, params, parent || undefined);
    const { backendNodeId } = object(await send("DOM.getFrameOwner", { frameId: frame.frameId }));
    for (const [id, context] of this.sessions.get(parent) ?? []) {
      if (!context.actionWorld && !context.preload) continue;
      // Each private recorder recognizes just the host elements in its own documents.
      let objectId;
      try {
        const result = object(await send("DOM.resolveNode", { backendNodeId, executionContextId: id }));
        objectId = object(result.object).objectId;
        if (!objectId) continue;
        const call = object(await send("Runtime.callFunctionOn", {
          executionContextId: id, arguments: [{objectId}], returnByValue: true,
          functionDeclaration: "function(el){return globalThis.__traceDockOwner?.(el)}",
        }));
        const value = object(call.result).value;

        const owner = object(value);
        if (typeof owner.hostNodeId === "string" && typeof owner.parentDocumentId === "string") {
          if (Array.isArray(owner.hostPath) && owner.hostPath.length && owner.hostPath.every(validSelector))
            this.ownerPaths.set(frame, { hops: owner.hostPath, ...(context.actionWorld ? { parent: context } : {}) });
          else this.ownerPaths.delete(frame);
          return { parentDocumentId: owner.parentDocumentId, hostNodeId: owner.hostNodeId };
        }
      } catch {
        // A host may be inaccessible in this world or disappear during navigation.
      } finally {
        if (objectId) await send("Runtime.releaseObject", {objectId}).catch(() => {});
      }
    }
    throw new Error("未能关联父文档中的 iframe 元素");
  }
  async actionPath(frame: Context, session?: string): Promise<FrameSelector[] | undefined> {
    const path: FrameSelector[] = [], seen = new Set<Context>();
    let current: Context | undefined = frame;
    while (current && !seen.has(current)) {
      seen.add(current);
      // Refresh the actual host selector, which may have changed or moved since
      // the baseline. Concurrent actions in the same frame share the lookup.
      let pending = this.pendingPaths.get(current);
      if (!pending) {
        const key = current;
        pending = this.owner(current, session).catch(() => undefined).finally(() => this.pendingPaths.delete(key));
        this.pendingPaths.set(current, pending);
      }
      await pending;
      const owner = this.ownerPaths.get(current);
      if (!owner) return;
      path.unshift(...owner.hops);
      if (!owner.parent) return path;
      const target = this.parents.get(session || "");
      if (target?.frameId === current.frameId) session = target.session;
      current = owner.parent;
    }
  }

  has(id: string): boolean { return this.sessions.has(id); }
  context(id: unknown, sessionId = ""): Context | undefined {
    return typeof id === "number" ? this.sessions.get(sessionId)?.get(id) : undefined;
  }
  runtime(method: string, params: Record<string, unknown>, sessionId = ""): void {
    const contexts = this.sessions.get(sessionId);
    if (!contexts) return;
    if (method === "Runtime.executionContextsCleared") {
      for (const context of contexts.values()) if (context.actionWorld) this.onDocumentEnd(context.documentId);
      contexts.clear();
    }
    if (method === "Runtime.executionContextDestroyed" && typeof params.executionContextId === "number") {
      const context = contexts.get(params.executionContextId);
      if (context?.actionWorld) this.onDocumentEnd(context.documentId);
      contexts.delete(params.executionContextId);
    }
    if (method === "Runtime.executionContextCreated") {
      const context = object(params.context), aux = object(context.auxData);
      if (typeof context.id === "number")
        contexts.set(context.id, {
          documentId: typeof context.uniqueId === "string" ? context.uniqueId : "",
          frameId: typeof aux.frameId === "string" ? aux.frameId : "",
          isolated: aux.isDefault === false || aux.type === "isolated",
          preload: aux.type === "isolated" && context.name === "Electron Isolated Context",
          actionWorld: context.name === world && aux.type === "isolated",
        });
      if (typeof context.id === "number" && this.interval && contexts.get(context.id)?.actionWorld)
        void this.setIntervalInContext(context.id, sessionId, this.interval);
    }
  }

  action(params: Record<string, unknown>, sessionId = "") {
    const context = this.context(params.executionContextId, sessionId);
    if (params.name !== binding || !context?.actionWorld || !context.frameId ||
        typeof params.payload !== "string" || params.payload.length > 65536) return;
    try {
      const data = object(JSON.parse(params.payload));
      if (!this.interval || data.generation !== this.interval || typeof data.action !== "string" || !actionNames.includes(data.action) ||
          typeof data.time !== "number" || !Number.isFinite(data.time) ||
          typeof data.element !== "string" || typeof data.node !== "number" || typeof data.origin !== "string") return;
      const payload: FrameActionPayload = {
        action: data.action, element: data.element, node: data.node, origin: data.origin,
        frameId: context.frameId, documentId: context.documentId,
        ...(typeof data.visualNodeId === "string" ? { visualNodeId: data.visualNodeId } : {}),
      };
      if (validSelector(data.target)) {
        const target = object(data.target);
        payload.target = { selector: data.target.selector, shadowPath: data.target.shadowPath,
          ...(typeof target.inputType === "string" ? {inputType: target.inputType} : {}),
          ...(target.editable === true ? {editable: true} : {}) };
      }
      if (typeof data.checked === "boolean") payload.checked = data.checked;
      if (Array.isArray(data.selectedIndices) && data.selectedIndices.every(n => Number.isSafeInteger(n) && n >= 0)) payload.selectedIndices = data.selectedIndices;
      if (typeof data.controlKey === "string" && frameControlKeys.includes(data.controlKey)) payload.controlKey = data.controlKey;
      if (typeof data.detail === "number") payload.detail = data.detail;
      if (typeof data.button === "number") payload.button = data.button;
      const m = object(data.modifiers);
      payload.modifiers = { alt: m.alt === true, ctrl: m.ctrl === true, meta: m.meta === true, shift: m.shift === true };
      const point = object(data.scroll);
      if (typeof point.x === "number" && typeof point.y === "number") payload.scroll = { x: point.x, y: point.y };
      return { time: data.time, payload, context };
    } catch { return; }
  }
}

function validSelector(value: unknown): value is FrameSelector {
  const v = object(value);
  return typeof v.selector === "string" && !!v.selector && Array.isArray(v.shadowPath) && v.shadowPath.every(s => typeof s === "string" && !!s);
}
