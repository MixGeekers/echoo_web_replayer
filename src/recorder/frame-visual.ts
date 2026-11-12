import { NodeRegistry } from "./nodes";
import { frameControlKeys, type FrameActionPayload } from "../shared/contracts/application";
import type { VisualNode } from "../shared/frame-visual";

// Runs only in the recorder's isolated world. Parent pages never receive the tree.
interface Bridge {
  frameRecording?: number;
  frameDocument?: string;
  __traceDockVisualNodeId?: (node: Node) => string;
  __traceDockVisual?: (value: string) => void;
  __traceDockOwner?: (host: Element) => unknown;
  __traceDockActionDetails?: (target: Node, event: Event) => Partial<FrameActionPayload>;
  __traceDockVisualState?: () => void;
  __traceDockFlushVisual?: () => void;
}
const bridge = globalThis as Bridge;
function coveredByMainRecorder() {
  let current: Window = window;
  try {
    while (current !== top && current.frameElement) current = current.parent;
  } catch {}
  return current === top;
}
if (!coveredByMainRecorder() && !bridge.__traceDockVisualState) install();

function install() {
  const ids = new WeakMap<Node, string>();
  let counter = 0, generation = 0;
  let shadowRoots = new WeakSet<ShadowRoot>();
  let previous = new Map<string, string>();
  const id = (node: Node) => {
    if (node === document) return bridge.frameDocument!;
    if (!ids.has(node)) ids.set(node, bridge.frameDocument + "/" + ++counter);
    return ids.get(node)!;
  };
  bridge.__traceDockVisualNodeId = id;
  const registry = new NodeRegistry();
  bridge.__traceDockOwner = host => {
    if (!bridge.frameDocument || host?.ownerDocument !== document) return null;
    const hop = registry.frameSelector(host);
    return { parentDocumentId: bridge.frameDocument, hostNodeId: id(host), hostPath: hop ? [hop] : null };
  };
  bridge.__traceDockActionDetails = (node, event) => {
    const element = node === document ? document.documentElement : node instanceof Element ? node : node.parentElement;
    if (!element) return {};
    const selector = registry.frameSelector(element);
    if (!selector) return {};
    const details: Partial<FrameActionPayload> = { target: {
      ...selector,
      ...(element instanceof HTMLInputElement ? { inputType: element.type } : {}),
      ...(element instanceof HTMLElement && element.isContentEditable ? { editable: true } : {}),
    } };
    if (event instanceof KeyboardEvent || event instanceof MouseEvent)
      details.modifiers = { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey };
    if (event instanceof MouseEvent) { details.detail = event.detail; details.button = event.button; }
    if (event instanceof KeyboardEvent && frameControlKeys.includes(event.key)) details.controlKey = event.key;
    if (event.type === "input" || event.type === "change") {
      if (element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type)) details.checked = element.checked;
      if (element instanceof HTMLSelectElement) details.selectedIndices = Array.from(element.selectedOptions, option => option.index);
    }
    if (event.type === "scroll") details.scroll = node === document
      ? { x: window.scrollX, y: window.scrollY } : { x: element.scrollLeft, y: element.scrollTop };
    return details;
  };
  // Keep presentation locally even when the original stylesheet is gone.
  const properties = ("display visibility opacity position top right bottom left box-sizing width height min-width min-height max-width max-height " +
    "margin padding border border-radius background-color background-image background-size background-position background-repeat color font-family font-size font-style font-weight line-height white-space " +
    "text-align text-decoration text-transform letter-spacing overflow flex flex-direction flex-wrap align-items align-self justify-content " +
    "grid-template-columns grid-template-rows grid-column grid-row gap vertical-align list-style-type transform").split(" ");
  const omit = new Set(["script", "noscript", "meta", "base", "template", "object", "embed"]);
  const attrs = ["id", "class", "type", "role", "placeholder", "alt", "colspan", "rowspan", "dir", "lang", "viewBox", "d", "fill", "stroke"];
  function capture(initial: boolean) {
    if (!generation || !document.documentElement || !bridge.frameDocument) return;
    const next = new Map<string, string>(), changed: VisualNode[] = [];
    function visit(node: Node): string | null {
      if (node.nodeType !== 1 && node.nodeType !== 3 && node !== document) return null;
      const entry: VisualNode = { nodeId: id(node), nodeName: node.nodeName, nodeType: node.nodeType as 1 | 3 | 9, children: [] };
      let descend = true;
      if (node instanceof Element) {
        if (omit.has(node.localName) || (node instanceof HTMLInputElement && node.type === "hidden")) return null;
        const style = getComputedStyle(node);
        const stylesheet = node instanceof HTMLLinkElement && node.relList.contains("stylesheet");
        if (node instanceof HTMLLinkElement && !stylesheet) return null;
        const styleNode = stylesheet || node instanceof HTMLStyleElement;
        if (styleNode && node.getRootNode() instanceof ShadowRoot) return null;
        if (style.display === "none" && !(node instanceof HTMLHeadElement) && !styleNode) return null;
        const values: Record<string, string> = {};
        for (const key of attrs) if (node.hasAttribute(key)) values[key] = node.getAttribute(key)!;
        values.style = properties.map(key => key + ":" + style.getPropertyValue(key)).join(";");
        if (node instanceof HTMLImageElement && node.currentSrc) values.src = node.currentSrc;
        if (node instanceof HTMLInputElement && node.checked) values.checked = "";
        if (node instanceof HTMLOptionElement && node.selected) values.selected = "";
        if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) {
          if (node.disabled) values.disabled = "";
          if (node instanceof HTMLInputElement && ["button", "submit", "reset"].includes(node.type)) values.value = node.value;
        }
        if (stylesheet) {
          values.rel = "stylesheet";
          values.href = node.href;
        }
        if (styleNode && node.hasAttribute("media")) values.media = node.getAttribute("media")!;
        entry.attributes = values;
        entry.namespaceURI = node.namespaceURI;
        descend = !(node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && node.isContentEditable));
      } else if (node.nodeType === 3) entry.text = node.nodeValue || "";
      let children: Iterable<Node> = node.childNodes;
      if (node instanceof Element && node.shadowRoot) {
        const root = node.shadowRoot;
        if (!shadowRoots.has(root)) {
          observer.observe(root, observeOptions);
          shadowRoots.add(root);
        }
        children = root.childNodes;
      } else if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) children = assigned;
      }
      if (descend) for (const child of children) {
        const key = visit(child);
        if (key) entry.children.push(key);
      }
      const scrollX = node === document ? window.scrollX : node instanceof Element ? node.scrollLeft : 0;
      const scrollY = node === document ? window.scrollY : node instanceof Element ? node.scrollTop : 0;
      if (scrollX || scrollY) entry.scroll = { x: scrollX, y: scrollY };
      const value = JSON.stringify(entry);
      next.set(entry.nodeId, value);
      if (initial || previous.get(entry.nodeId) !== value) changed.push(entry);
      return entry.nodeId;
    }
    visit(document);
    const removed = initial ? [] : [...previous.keys()].filter(key => !next.has(key));
    if (initial || changed.length || removed.length) {
      bridge.__traceDockVisual?.(JSON.stringify({ generation, initial, url: location.href, baseUrl: document.baseURI, nodes: changed, removed }));
      previous = next;
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  function update() {
    if (generation && !timer) timer = setTimeout(() => { timer = undefined; capture(!previous.size); }, 40);
  }
  const observeOptions = { subtree: true, childList: true, attributes: true, characterData: true };
  const observer = new MutationObserver(update);
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    capture(!previous.size);
  }
  bridge.__traceDockFlushVisual = flush;
  bridge.__traceDockVisualState = () => {
    const next = bridge.frameRecording || 0;
    if (generation === next) return;
    observer.disconnect();
    shadowRoots = new WeakSet();
    clearTimeout(timer);
    timer = undefined;
    previous.clear();
    generation = next;
    if (next) {
      observer.observe(document, observeOptions);
      capture(true);
    }
  };
  for (const event of ["load", "change", "resize", "scroll"]) window.addEventListener(event, update, true);
  window.addEventListener("pagehide", flush);
  document.addEventListener("submit", flush, true);
  bridge.__traceDockVisualState();
}
