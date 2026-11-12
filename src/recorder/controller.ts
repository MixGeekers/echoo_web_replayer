import type {
  CommandResult,
  RecorderPayloadMap,
  RecorderEventType,
} from "../shared/contracts/recording";
import { errorMessage } from "../shared/contracts/recording";
import type { RecorderContext } from "./context";
import { NodeRegistry } from "./nodes";
import { MutationCapture } from "./mutations";
import { ActionCapture } from "./actions";
import { RootRegistry } from "./roots";
import { SnapshotCapture, coverage, viewportFor } from "./snapshot";

export interface RecorderTransport {
  event<K extends RecorderEventType>(envelope: {
    type: K;
    payload: RecorderPayloadMap[K];
    sessionId: string;
    timestamp: string;
    documentId: string;
    url: string;
    title: string;
  }): void;
  acknowledge(requestId: string | undefined, result: CommandResult): void;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
/** Owns capture lifecycle. Capability modules only communicate through this context. */
export class RecorderController {
  private readonly documentId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly nodes = new NodeRegistry();
  private readonly mutations: MutationCapture;
  private readonly actions: ActionCapture;
  private readonly roots: RootRegistry;
  private readonly snapshots: SnapshotCapture;
  private readonly context: RecorderContext;
  private recording = false;
  private sessionId: string | null = null;
  private stateVersion = 0;
  private initialSnapshotPending = false;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  frameOwner(host: Element) {
    if (host.localName !== "iframe" && host.localName !== "frame") return null;
    let doc = host.ownerDocument;
    while (doc !== document) {
      const parent = doc.defaultView?.frameElement;
      if (!parent) return null;
      doc = parent.ownerDocument;
    }
    const local = this.nodes.frameSelector(host);
    const path = this.nodes.scope(host).frameContexts.map(({selector, shadowPath}) => ({ selector, shadowPath }));
    return { parentDocumentId: this.documentId, hostNodeId: this.nodes.id(host), hostPath: local ? [...path, local] : null };
  }
  get version(): number {
    return this.stateVersion;
  }
  constructor(private readonly transport: RecorderTransport) {
    this.context = {
      nodes: this.nodes,
      isRecording: () => this.recording,
      send: (type, payload, timestamp = new Date().toISOString()) => {
        if (!this.recording || !this.sessionId) return;
        transport.event({
          sessionId: this.sessionId,
          type,
          payload,
          timestamp,
          documentId: this.documentId,
          url: this.nodes.safeUrl(),
          title: document.title || "",
        });
      },
      report: (operation, error) => this.report(operation, error),
    };
    this.mutations = new MutationCapture(this.context, () =>
      this.roots.observed.values(),
    );
    this.actions = new ActionCapture(this.context, () =>
      this.mutations.flush(),
    );
    this.roots = new RootRegistry(
      this.context,
      this.mutations,
      this.actions,
      (reason) => this.snapshots.capture(reason),
    );
    this.snapshots = new SnapshotCapture(this.context, this.roots, () =>
      this.flush(),
    );
    this.installLifecycle();
  }
  report(operation: string, error: unknown): void {
    try {
      this.context.send("recorder.error", {
        operation,
        message: errorMessage(error),
      });
    } catch {
      /* The frame may be going away. */
    }
  }
  private flush(): void {
    this.mutations.flush();
    this.actions.flush();
  }
  private deactivate(): void {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    this.mutations.reset();
    this.actions.reset();
    this.roots.clear();
    this.initialSnapshotPending = false;
    this.recording = false;
  }
  private activate(sessionId: string): void {
    this.sessionId = sessionId;
    this.recording = true;
    this.roots.register(document);
    this.roots.discover(document, false);
    this.context.send("page.lifecycle", {
      event: "recording-start",
      readyState: document.readyState,
      coverage,
    });
    if (document.documentElement) this.snapshots.capture("recording-start");
    else this.initialSnapshotPending = true;
    this.discoveryTimer = setInterval(() => {
      try {
        this.roots.cleanupDetached();
        this.roots.discover(document, true);
      } catch (error) {
        this.report("scope-discovery", error);
      }
    }, 1000);
  }
  private applyState(value: unknown): void {
    const nextId =
      object(value) && typeof value.sessionId === "string"
        ? value.sessionId
        : null;
    const shouldRecord =
      object(value) && value.recording === true && nextId !== null;
    if (this.recording && (!shouldRecord || nextId !== this.sessionId)) {
      this.flush();
      this.deactivate();
    }
    if (shouldRecord && !this.recording) this.activate(nextId);
    else if (!shouldRecord) this.sessionId = nextId;
  }
  state(value: unknown): void {
    this.stateVersion++;
    try {
      this.applyState(value);
    } catch (error) {
      this.report("apply-state", error);
    }
  }
  ready(value: unknown, version: number): void {
    if (version === this.stateVersion) this.applyState(value);
  }
  command(message: unknown): void {
    let result: CommandResult = { ok: true };
    const requestId =
      object(message) && typeof message.requestId === "string"
        ? message.requestId
        : undefined;
    try {
      if (object(message) && message.command === "snapshot")
        result = this.snapshots.capture(
          typeof message.reason === "string" && message.reason
            ? message.reason
            : "manual",
        );
      else if (
        object(message) &&
        (message.command === "flush" || message.command === "stop")
      ) {
        this.flush();
        if (message.command === "stop") this.deactivate();
      } else result = { ok: false, error: "Unsupported recorder command" };
    } catch (error) {
      this.report("command", error);
      result = { ok: false, error: errorMessage(error) };
    } finally {
      this.transport.acknowledge(requestId, result);
    }
  }
  private installLifecycle(): void {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        if (!this.recording) return;
        this.roots.discover(document, false);
        this.context.send("page.lifecycle", {
          event: "dom-content-loaded",
          readyState: document.readyState,
        });
        this.snapshots.capture(
          this.initialSnapshotPending
            ? "initial-document"
            : "dom-content-loaded",
        );
        this.initialSnapshotPending = false;
      },
      { once: true },
    );
    window.addEventListener(
      "load",
      () => {
        if (!this.recording) return;
        this.roots.discover(document, false);
        this.context.send("page.lifecycle", {
          event: "load",
          readyState: document.readyState,
        });
        this.snapshots.capture("page-load");
      },
      { once: true },
    );
    window.addEventListener("pagehide", (event) => {
      this.flush();
      this.context.send("page.lifecycle", {
        event: "pagehide",
        persisted: event.persisted,
      });
    });
    window.addEventListener("pageshow", (event) => {
      if (this.recording && event.persisted)
        this.snapshots.capture("bfcache-restore");
    });
    window.addEventListener("resize", () => {
      if (this.recording)
        this.context.send("page.resize", { viewport: viewportFor(document) });
    });
  }
}
