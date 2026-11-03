import type {
  CommandResult,
  Coverage,
  DocumentSnapshot,
  SnapshotPayload,
  Viewport,
} from "../shared/contracts/recording";
import { errorMessage } from "../shared/contracts/recording";
import type { RecorderContext } from "./context";
import type { RootRegistry } from "./roots";
import { isDocument, isFrame, isShadowRoot } from "./guards";
export const coverage: Coverage = {
  mainDocument: true,
  sameOriginFrames: true,
  openShadowRoots: true,
  shadowDiscoveryIntervalMs: 1000,
  crossOriginFrames: false,
  closedShadowRoots: false,
  canvasAndWebGLPixels: false,
  networkTraffic: false,
  javascriptHeap: false,
  dataRedaction: false,
  mutationSemantics:
    "Mutation records preserve observer delivery order. Added/removed subtree state is sampled at observer delivery; this is evidence for analysis, not a guaranteed pixel-perfect replay.",
};
export function viewportFor(doc: Document): Viewport {
  const win = doc.defaultView;
  return {
    width: win?.innerWidth || 0,
    height: win?.innerHeight || 0,
    devicePixelRatio: win?.devicePixelRatio || 1,
  };
}
export class SnapshotCapture {
  constructor(
    private readonly context: RecorderContext,
    private readonly roots: RootRegistry,
    private readonly flush: () => void,
  ) {}
  document(doc: Document): DocumentSnapshot {
    const { nodes } = this.context,
      win = doc.defaultView,
      value = doc.doctype;
    const publicPart = value?.publicId ? ` PUBLIC "${value.publicId}"` : "";
    const systemPart = value?.systemId
      ? `${value.publicId ? "" : " SYSTEM"} "${value.systemId}"`
      : "";
    const doctype = value
      ? `<!DOCTYPE ${value.name}${publicPart}${systemPart}>`
      : "";
    return {
      nodeId: nodes.id(doc),
      url: nodes.safeUrl(doc),
      baseUrl: doc.baseURI || nodes.safeUrl(doc),
      title: doc.title || "",
      scope: nodes.scope(doc),
      html: `${doctype}${doctype ? "\n" : ""}${doc.documentElement?.outerHTML || ""}`,
      tree: nodes.serialize(doc),
      forms: nodes.forms(doc),
      scroll: { x: win?.scrollX || 0, y: win?.scrollY || 0 },
      viewport: viewportFor(doc),
      scrolls: Array.from(doc.querySelectorAll("*"))
        .filter((node) => node.scrollLeft || node.scrollTop)
        .map((node) => ({
          nodeId: nodes.id(node),
          x: node.scrollLeft || 0,
          y: node.scrollTop || 0,
        })),
    };
  }
  capture(reason = "manual"): CommandResult {
    if (!this.context.isRecording())
      return { ok: false, error: "Recorder is not recording" };
    try {
      this.roots.discover(document, false);
      this.flush();
      const payload = this.context.nodes.withCache(() => this.build(reason));
      this.context.send("dom.snapshot", payload);
      return { ok: true };
    } catch (error) {
      this.context.report("snapshot", error);
      return { ok: false, error: errorMessage(error) };
    }
  }
  private build(reason: string) {
    const main = this.document(document),
      frames: DocumentSnapshot[] = [],
      shadowRoots: SnapshotPayload["shadowRoots"] = [],
      inaccessibleFrames: SnapshotPayload["inaccessibleFrames"] = [];
    const { nodes } = this.context;
    for (const root of this.roots.observed.keys()) {
      if (!this.roots.attached(root)) continue;
      if (isDocument(root) && root !== document)
        frames.push(this.document(root));
      if (isShadowRoot(root))
        shadowRoots.push({
          nodeId: nodes.id(root),
          host: nodes.describe(root.host),
          html: root.innerHTML,
          forms: nodes.forms(root),
        });
    }
    for (const root of this.roots.observed.keys()) {
      if (!this.roots.attached(root)) continue;
      for (const frame of root.querySelectorAll("iframe, frame")) {
        try {
          if (!isFrame(frame) || !frame.contentDocument?.documentElement)
            inaccessibleFrames.push({
              target: nodes.describe(frame),
              src: frame.getAttribute("src"),
              reason: "cross-origin, sandboxed, or not yet loaded",
            });
        } catch {
          inaccessibleFrames.push({
            target: nodes.describe(frame),
            src: frame.getAttribute("src"),
            reason: "cross-origin or sandboxed",
          });
        }
      }
    }
    return {
      reason,
      ...main,
      frames,
      shadowRoots,
      inaccessibleFrames,
      coverage,
    };
  }
}
