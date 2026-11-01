import type { RecorderContext } from "./context";
import { ActionCapture, actionTypes } from "./actions";
import type { MutationCapture } from "./mutations";
import {
  isDocument,
  isElement,
  isFrame,
  isParentNode,
  isShadowRoot,
} from "./guards";
export type ObservedRoot = Document | ShadowRoot;
export class RootRegistry {
  readonly observed = new Map<ObservedRoot, MutationObserver>();
  private readonly documents = new Map<Document, () => void>();
  private readonly watchedFrames = new WeakSet<Element>();
  constructor(
    private readonly context: RecorderContext,
    private readonly mutations: MutationCapture,
    private readonly actions: ActionCapture,
    private readonly snapshot: (reason: string) => void,
  ) {}
  attached(root: ObservedRoot): boolean {
    if (root === document) return true;
    if (isShadowRoot(root))
      return root.host.isConnected && this.attached(root.host.ownerDocument);
    try {
      const frame = root.defaultView?.frameElement;
      return (
        !!frame?.isConnected && isFrame(frame) && frame.contentDocument === root
      );
    } catch {
      return false;
    }
  }
  register(root: ObservedRoot): boolean {
    if (this.observed.has(root)) return false;
    const observer = new MutationObserver((records) => {
      try {
        this.mutations.collect(records);
        for (const record of records)
          for (const added of record.addedNodes)
            if (isElement(added)) this.discover(added, true);
      } catch (error) {
        this.context.report("mutation-observer", error);
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
    for (const type of actionTypes)
      root.addEventListener(type, this.actions.handle, {
        capture: true,
        passive: type === "scroll",
      });
    root.addEventListener("load", this.actions.imageLoaded, true);
    this.observed.set(root, observer);
    this.context.nodes.id(root);
    if (isDocument(root) && root !== document && !this.documents.has(root)) {
      const onPageHide = (): void => {
        this.mutations.flush();
        this.actions.flush();
        this.context.send("page.lifecycle", {
          event: "frame-pagehide",
          scope: this.context.nodes.scope(root),
        });
      };
      root.defaultView?.addEventListener("pagehide", onPageHide);
      this.documents.set(root, onPageHide);
    }
    return true;
  }
  discover(root: Node, announce = false): boolean {
    if (!this.context.isRecording() || !isParentNode(root)) return false;
    let discovered =
      isDocument(root) || isShadowRoot(root) ? this.register(root) : false;
    const elements = isElement(root)
      ? [root, ...root.querySelectorAll("*")]
      : Array.from(root.querySelectorAll("*"));
    for (const element of elements) {
      if (element.shadowRoot) {
        const isNew = !this.observed.has(element.shadowRoot);
        this.register(element.shadowRoot);
        const nested = this.discover(element.shadowRoot, false);
        discovered = discovered || isNew || nested;
      }
      if (isFrame(element)) {
        if (!this.watchedFrames.has(element)) {
          element.addEventListener("load", () => {
            if (!this.context.isRecording()) return;
            this.discover(element, false);
            this.snapshot("frame-load");
          });
          this.watchedFrames.add(element);
        }
        try {
          const child = element.contentDocument;
          if (child) {
            const isNew = !this.observed.has(child);
            this.register(child);
            const nested = this.discover(child, false);
            discovered = discovered || isNew || nested;
          }
        } catch {
          /* Inaccessible frame coverage is recorded in snapshots. */
        }
      }
    }
    if (discovered && announce) this.snapshot("scope-discovered");
    return discovered;
  }
  private detach(root: ObservedRoot, observer: MutationObserver): void {
    observer.disconnect();
    for (const type of actionTypes)
      root.removeEventListener(type, this.actions.handle, true);
    root.removeEventListener("load", this.actions.imageLoaded, true);
    this.observed.delete(root);
    if (isDocument(root)) {
      const onPageHide = this.documents.get(root);
      if (onPageHide)
        root.defaultView?.removeEventListener("pagehide", onPageHide);
      this.documents.delete(root);
    }
  }
  cleanupDetached(): void {
    for (const [root, observer] of this.observed)
      if (!this.attached(root)) {
        this.mutations.collect(observer.takeRecords());
        this.detach(root, observer);
      }
  }
  clear(): void {
    for (const [root, observer] of this.observed) this.detach(root, observer);
  }
}
