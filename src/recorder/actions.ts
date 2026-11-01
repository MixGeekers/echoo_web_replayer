import type {
  ActionBase,
  InputPayload,
  ScrollPayload,
} from "../shared/contracts/recording";
import type { RecorderContext } from "./context";
import { isDocument, isElement, isForm, isImage, isNode } from "./guards";

export const actionTypes = [
  "click",
  "dblclick",
  "input",
  "change",
  "keydown",
  "submit",
  "focusin",
  "scroll",
] as const;
function property(event: Event, key: string): unknown {
  return key in event ? Reflect.get(event, key) : undefined;
}
function numeric(event: Event, key: string): number {
  const value = property(event, key);
  return typeof value === "number" ? value : 0;
}
function text(event: Event, key: string): string {
  const value = property(event, key);
  return typeof value === "string" ? value : "";
}
export class ActionCapture {
  private readonly seen = new WeakSet<Event>();
  private readonly scrolls = new Map<
    string,
    { payload: ScrollPayload; timestamp: string }
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly context: RecorderContext,
    private readonly flushMutations: () => void,
  ) {}
  readonly handle = (event: Event): void => {
    const { nodes, send } = this.context;
    if (!this.context.isRecording() || this.seen.has(event)) return;
    this.seen.add(event);
    try {
      const target = event.composedPath?.()[0] || event.target;
      if (!isNode(target)) return;
      const timestamp = new Date().toISOString();
      if (event.type === "scroll") {
        const doc = isDocument(target) ? target : target.ownerDocument,
          win = doc?.defaultView;
        const payload: ScrollPayload = {
          target: nodes.describe(target),
          trusted: !!event.isTrusted,
          x: isDocument(target)
            ? win?.scrollX || 0
            : isElement(target)
              ? target.scrollLeft || 0
              : 0,
          y: isDocument(target)
            ? win?.scrollY || 0
            : isElement(target)
              ? target.scrollTop || 0
              : 0,
          coalesced: true,
        };
        this.scrolls.set(nodes.id(target), { payload, timestamp });
        if (!this.timer) this.timer = setTimeout(() => this.flush(), 150);
        return;
      }
      this.flushMutations();
      this.flush();
      const payload: ActionBase = {
        target: nodes.describe(target),
        trusted: !!event.isTrusted,
        modifiers: {
          alt: !!property(event, "altKey"),
          ctrl: !!property(event, "ctrlKey"),
          meta: !!property(event, "metaKey"),
          shift: !!property(event, "shiftKey"),
        },
      };
      switch (event.type) {
        case "click":
        case "dblclick":
          send(
            `action.${event.type}`,
            {
              ...payload,
              position: {
                clientX: numeric(event, "clientX"),
                clientY: numeric(event, "clientY"),
                pageX: numeric(event, "pageX"),
                pageY: numeric(event, "pageY"),
                screenX: numeric(event, "screenX"),
                screenY: numeric(event, "screenY"),
              },
              button: numeric(event, "button"),
              detail: numeric(event, "detail"),
            },
            timestamp,
          );
          break;
        case "input":
        case "change": {
          if (!isElement(target)) return;
          const input: InputPayload = {
            ...payload,
            form: nodes.form(target),
            isComposing: !!property(event, "isComposing"),
          };
          const inputType = property(event, "inputType"),
            data = property(event, "data");
          if (typeof inputType === "string") input.inputType = inputType;
          if (typeof data === "string" || data === null) input.data = data;
          send(`action.${event.type}`, input, timestamp);
          break;
        }
        case "keydown":
          send(
            "action.keydown",
            {
              ...payload,
              key: text(event, "key"),
              code: text(event, "code"),
              repeat: !!property(event, "repeat"),
              isComposing: !!property(event, "isComposing"),
            },
            timestamp,
          );
          break;
        case "submit": {
          if (!isElement(target) || !isForm(target)) return;
          const submitter = property(event, "submitter");
          send(
            "action.submit",
            {
              ...payload,
              submitter: isNodeValue(submitter)
                ? nodes.describe(submitter)
                : null,
              fields: Array.from(target.elements, (element) =>
                nodes.form(element),
              ),
              action: target.action,
              method: target.method,
            },
            timestamp,
          );
          break;
        }
        case "focusin":
          send("action.focus", payload, timestamp);
          break;
      }
    } catch (error) {
      this.context.report(`action-${event.type}`, error);
    }
  };
  readonly imageLoaded = (event: Event): void => {
    const target = event.target;
    if (
      !this.context.isRecording() ||
      this.seen.has(event) ||
      !isNode(target) ||
      !isElement(target) ||
      !isImage(target) ||
      !target.currentSrc
    )
      return;
    this.seen.add(event);
    this.flushMutations();
    this.context.send("page.image", {
      target: { nodeId: this.context.nodes.id(target) },
      currentSrc: target.currentSrc,
    });
  };
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const entry of this.scrolls.values())
      this.context.send("action.scroll", entry.payload, entry.timestamp);
    this.scrolls.clear();
  }
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.scrolls.clear();
  }
}
function isNodeValue(value: unknown): value is Node {
  return (
    !!value &&
    typeof value === "object" &&
    "nodeType" in value &&
    typeof value.nodeType === "number"
  );
}
