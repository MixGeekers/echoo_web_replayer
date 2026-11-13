import { FrameArchive, visualTree } from "../shared/frame-visual";
import { resourceURL, cssText } from "../shared/resource-urls";
import type { SerializedNode, Point } from "../shared/contracts/recording";
import type {
  ReplayDocument,
  ReplayEvent,
  ReplayForm,
  ReplayPointer,
  ReplayView,
} from "./model";
const HTML_NS = "http://www.w3.org/1999/xhtml",
  SVG_NS = "http://www.w3.org/2000/svg";
const blockedTags = new Set([
  "script",
  "noscript",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
]);
function element(node: Node | undefined): node is Element {
  return node?.nodeType === 1;
}
function documentNode(node: Node): node is Document {
  return node.nodeType === 9;
}
type HTMLTags = HTMLElementTagNameMap & HTMLElementDeprecatedTagNameMap;
function html<K extends keyof HTMLTags>(
  node: Node | undefined,
  tag: K,
): node is HTMLTags[K] {
  return (
    element(node) && node.namespaceURI === HTML_NS && node.localName === tag
  );
}
function valueControl(
  node: Node,
): node is Element & { value: string | number } {
  return (
    element(node) &&
    "value" in node &&
    (typeof node.value === "string" || typeof node.value === "number")
  );
}
function checkedControl(node: Node): node is Element & { checked: boolean } {
  return (
    element(node) && "checked" in node && typeof node.checked === "boolean"
  );
}
function textOf(node: SerializedNode): string {
  return node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8
    ? (node.text ?? "")
    : "";
}
export class ReplayDOM {
  private frames = new FrameArchive();
  private mounted = new Map<string, Document>();
  private nodes = new Map<string, Node>();
  private bindings = new Map<Node, Map<string, string>>();
  private scrolls = new Map<Node, Point>();
  private bases = new WeakMap<Node, string>();
  private templateHosts = new WeakMap<Node, HTMLTemplateElement>();
  private ready: Promise<void>;
  private sessionId = "";
  private pageId: string | undefined;
  private at = 0;
  private endSeq = 0;
  private documentId: string | null = null;
  private gaps = 0;
  private url = "";
  constructor(
    private frame: HTMLIFrameElement,
    private onView: (view: ReplayView) => void,
    private onPointer: (point: ReplayPointer | null) => void,
  ) {
    this.ready = new Promise((resolve) => {
      if (
        frame.contentDocument?.readyState === "complete" &&
        frame.contentDocument.URL.endsWith("replay-frame.html")
      )
        resolve();
      else frame.addEventListener("load", () => resolve(), { once: true });
    });
  }
  private get doc(): Document {
    const doc = this.frame.contentDocument;
    if (!doc) throw new Error("回放文档不可访问");
    return doc;
  }
  async reset(sessionId: string, at = 0, endSeq = at): Promise<void> {
    await this.ready;
    this.sessionId = sessionId;
    this.at = at;
    this.endSeq = endSeq;
    this.documentId = null;
    this.pageId = undefined;
    this.gaps = 0;
    this.frames.clear();
    this.mounted.clear();
    this.nodes.clear();
    this.bindings.clear();
    this.scrolls.clear();
    this.doc.body?.replaceChildren();
    this.onPointer(null);
    this.onView({ message: "等待页面快照", gaps: 0, url: "" });
  }
  private base(node: Node): string {
    return this.bases.get(node.ownerDocument || node) || this.url;
  }
  private resource(value: string, base: string): string {
    return resourceURL(
      value,
      base || this.url,
      this.sessionId,
      this.at,
      this.endSeq,
      this.pageId,
    );
  }
  private css(value: string, base: string): string {
    return cssText(
      value,
      base || this.url,
      this.sessionId,
      this.at,
      this.endSeq,
      this.pageId,
    );
  }
  private binding(node: Node, name: string, value: string): void {
    let bindings = this.bindings.get(node);
    if (!bindings) {
      bindings = new Map();
      this.bindings.set(node, bindings);
    }
    bindings.set(name, value);
  }
  private attribute(
    node: Element,
    name: string,
    value: string | null | undefined,
  ): void {
    const lower = name.toLowerCase(),
      tag = node.localName.toLowerCase();
    if (
      /^on/i.test(name) ||
      [
        "srcdoc",
        "is",
        "nonce",
        "integrity",
        "autofocus",
        "autoplay",
        "formaction",
        "action",
        "target",
        "ping",
        "download",
      ].includes(lower)
    )
      return;
    if (tag === "iframe" && ["src", "sandbox", "allow"].includes(lower)) return;
    if (value === null || value === undefined) {
      node.removeAttribute(name);
      this.bindings.get(node)?.delete(name);
      return;
    }
    if (lower === "style") {
      this.binding(node, name, value);
      value = this.css(value, this.base(node));
    } else if (lower === "srcset") return;
    else if (
      ["src", "href", "xlink:href", "poster", "background"].includes(lower)
    ) {
      if (["a", "area", "form"].includes(tag)) return;
      this.binding(node, name, value);
      value = this.resource(value, this.base(node));
    }
    try {
      node.setAttribute(name, value);
    } catch {
      this.gaps++;
    }
  }
  private text(node: Node, value: string): void {
    if (node.parentElement?.localName === "style") {
      this.binding(node, "#text", value);
      node.nodeValue = this.css(value, this.base(node));
    } else node.nodeValue = value;
  }
  private build(
    data: SerializedNode,
    doc: Document,
    namespace = HTML_NS,
    reuse = false,
  ): Node {
    const existing = this.nodes.get(data.nodeId);
    if (reuse && existing) return existing;
    let node: Node;
    switch (data.nodeType) {
      case 9:
        node = doc;
        break;
      case 10:
        node = doc.implementation.createDocumentType(
          data.name || "html",
          data.publicId || "",
          data.systemId || "",
        );
        break;
      case 3:
      case 4:
        node = doc.createTextNode(data.text || "");
        break;
      case 8:
        node = doc.createComment(data.text || "");
        break;
      case 11:
        node = doc.createDocumentFragment();
        break;
      case 1: {
        const tag = String(data.nodeName || "div").toLowerCase(),
          ns = data.namespaceURI || (tag === "svg" ? SVG_NS : namespace);
        if (
          blockedTags.has(tag) ||
          (tag === "link" &&
            String(data.attributes.rel).toLowerCase() !== "stylesheet")
        ) {
          node = doc.createComment(`replay: ${tag}`);
          break;
        }
        let el: Element;
        try {
          el =
            ns === HTML_NS
              ? doc.createElement(tag)
              : doc.createElementNS(ns, data.nodeName);
        } catch {
          el = doc.createElement("span");
          this.gaps++;
        }
        for (const [name, value] of Object.entries(data.attributes))
          this.attribute(el, name, value);
        if (html(el, "iframe")) {
          el.setAttribute("sandbox", "allow-same-origin");
          el.src = "about:blank";
        }
        if (html(el, "img")) {
          el.loading = "eager";
          if (data.currentSrc) this.attribute(el, "src", data.currentSrc);
        }
        if (tag === "link" || tag === "img")
          el.addEventListener("load", () => this.restoreScroll());
        node = el;
        break;
      }
      default:
        node = doc.createComment("replay: unsupported node");
    }
    this.nodes.set(data.nodeId, node);
    if ([1, 9, 11].includes(node.nodeType)) {
      for (const child of data.children || []) {
        try {
          const nextNS = element(node)
            ? node.localName === "foreignObject"
              ? HTML_NS
              : node.namespaceURI || namespace
            : namespace;
          const built = this.build(child, doc, nextNS, reuse);
          node.appendChild(built);
          if (
            element(node) &&
            node.localName === "style" &&
            built.nodeType === 3
          )
            this.text(built, textOf(child));
        } catch {
          this.gaps++;
        }
      }
      if (data.nodeType === 1) {
        if (data.templateContent && html(node, "template")) {
          this.templateHosts.set(node.content, node);
          this.nodes.set(data.templateContent.nodeId, node.content);
          for (const child of data.templateContent.children || [])
            node.content.append(this.build(child, doc, namespace, reuse));
        }
        if (data.shadowRoot && element(node)) {
          try {
            const shadow = node.attachShadow({ mode: "open" });
            this.nodes.set(data.shadowRoot.nodeId, shadow);
            for (const child of data.shadowRoot.children || []) {
              const built = this.build(child, doc, HTML_NS, reuse);
              shadow.append(built);
              if (element(built) && built.localName === "style")
                for (const text of built.childNodes)
                  if (text.nodeType === 3)
                    this.text(
                      text,
                      this.bindings.get(text)?.get("#text") ||
                        text.nodeValue ||
                        "",
                    );
            }
          } catch {
            this.gaps++;
          }
        }
        if (data.state) this.form({ ...data.state, nodeId: data.nodeId });
      }
    }
    return node;
  }
  private rebuildDocument(doc: Document, payload: ReplayDocument): void {
    this.bases.set(doc, payload.baseUrl || payload.url || this.url);
    doc.replaceChildren();
    if (payload.tree.nodeType !== 9)
      throw new Error("此快照没有可回放的节点树，请重新录制");
    this.build(payload.tree, doc);
    if (!doc.documentElement) {
      const root = doc.createElement("html");
      root.append(doc.createElement("head"), doc.createElement("body"));
      doc.append(root);
    }
    const style = doc.createElement("style");
    style.textContent =
      "html{scroll-behavior:auto!important}*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}";
    (doc.head || doc.documentElement).append(style);
    for (const form of payload.forms || []) this.form(form);
    this.scrolls.set(doc, payload.scroll || { x: 0, y: 0 });
    for (const scroll of payload.scrolls || []) {
      const node = this.nodes.get(scroll.nodeId);
      if (node) this.scrolls.set(node, scroll);
    }
  }
  snapshot(
    event: Extract<ReplayEvent, { type: "dom.snapshot" }>,
    at = event.seq,
  ): void {
    this.frames.clear();
    this.mounted.clear();
    this.nodes.clear();
    this.bindings.clear();
    this.scrolls.clear();
    this.onPointer(null);
    this.documentId = event.documentId;
    this.pageId = event.pageId;
    this.at = at;
    const payload = event.payload;
    this.url = payload.url || event.url;
    this.onView({
      ...(payload.viewport ? { viewport: payload.viewport } : {}),
      url: this.url,
      message: "",
      gaps: this.gaps,
    });
    this.rebuildDocument(this.doc, payload);
    const frames = (payload.frames || [])
      .map((frame, i) => ({
        frame,
        host: payload.frameHosts?.[i] ?? null,
        depth: payload.frameDepths?.[i] ?? 0,
      }))
      .sort((a, b) => a.depth - b.depth);
    for (const { frame, host: id } of frames) {
      const host = id ? this.nodes.get(id) : undefined;
      if ((html(host, "iframe") || html(host, "frame")) && host.contentDocument)
        this.rebuildDocument(host.contentDocument, frame);
      else this.gaps++;
    }
    for (const frame of payload.frameDocuments || []) this.frames.set(frame);
    this.mountFrames();
    for (const shadow of payload.shadowRoots || [])
      for (const form of shadow.forms) this.form(form);
    this.restoreScroll();
  }
  private unmount(id: string) {
    const doc = this.mounted.get(id);
    if (!doc) return;
    doc.replaceChildren();
    this.mounted.delete(id);
    this.scrolls.delete(doc);
    for (const [key, node] of this.nodes) {
      if (node === doc || node.ownerDocument === doc) {
        this.nodes.delete(key);
        this.scrolls.delete(node);
        this.bindings.delete(node);
      }
    }
  }
  private mountFrames() {
    if (!this.documentId) return;
    const frames = this.frames.snapshots();
    for (const id of this.mounted.keys()) if (!this.frames.has(id)) this.unmount(id);
    // A child snapshot can arrive before its parent's snapshot or host insertion.
    const mount = (parent: string) => {
      for (const frame of frames) {
        if (frame.parentDocumentId !== parent) continue;
        const host = this.nodes.get(frame.hostNodeId);
        if (!(html(host, "iframe") || html(host, "frame")) || !host.isConnected || !host.contentDocument) continue;
        const doc = host.contentDocument;
        if (this.mounted.get(frame.documentId) !== doc) {
          this.unmount(frame.documentId);
          const tree = visualTree(frame);
          if (!tree) continue;
          const scrolls = frame.nodes.flatMap(node => node.scroll ? [{ nodeId: node.nodeId, ...node.scroll }] : []);
          this.rebuildDocument(doc, { tree, url: frame.url, baseUrl: frame.baseUrl || frame.url, scrolls });
          this.restoreScroll();
          this.mounted.set(frame.documentId, doc);
        }
        mount(frame.documentId);
      }
    };
    mount(this.documentId);
  }
  private form(state: ReplayForm): void {
    const node = this.nodes.get(state.nodeId);
    if (!node) return;
    try {
      if (
        state.value !== undefined &&
        valueControl(node) &&
        (!html(node, "input") || node.type !== "file")
      )
        node.value = state.value;
      if (state.checked !== undefined && checkedControl(node))
        node.checked = state.checked;
      if (html(node, "select")) {
        if (state.selectedValues)
          for (const option of node.options)
            option.selected = state.selectedValues.includes(option.value);
        else if (state.selectedIndex !== undefined)
          node.selectedIndex = state.selectedIndex;
      }
      if (
        state.text !== undefined &&
        element(node) &&
        "isContentEditable" in node &&
        node.isContentEditable &&
        node.textContent !== state.text
      )
        node.textContent = state.text;
    } catch {
      this.gaps++;
    }
  }
  restoreScroll(): void {
    for (const [node, value] of this.scrolls) {
      if (documentNode(node))
        node.defaultView?.scrollTo({
          left: value.x || 0,
          top: value.y || 0,
          behavior: "instant",
        });
      else if (element(node)) {
        node.scrollLeft = value.x || 0;
        node.scrollTop = value.y || 0;
      }
    }
  }
  private refreshResources(at: number): void {
    this.at = at;
    for (const [node, attrs] of this.bindings) {
      if (!node.isConnected) continue;
      for (const [name, value] of attrs) {
        if (name === "#text") this.text(node, value);
        else if (element(node)) this.attribute(node, name, value);
      }
    }
  }
  apply(event: ReplayEvent, seeking = false): void {
    if (event.type === "dom.snapshot") {
      this.snapshot(event, seeking ? this.at : event.seq);
      return;
    }
    if (event.type === "frame.snapshot" || event.type === "frame.mutation" || event.type === "frame.detach") {
      const { documentId } = event.payload;
      this.unmount(documentId);
      if (event.type === "frame.snapshot") this.frames.set(event.payload);
      else if (event.type === "frame.mutation") this.frames.patch(event.payload);
      else this.frames.forget(documentId);
      this.mountFrames();
      return;
    }
    if (event.type === "session.pause") {
      this.onView({ message: "采集已暂停 · 此区间没有页面记录" });
      return;
    }
    if (event.type === "session.resume") {
      this.onView({ message: "等待恢复后的页面快照" });
      return;
    }
    if (event.type === "page.resource") {
      if (!seeking) this.refreshResources(event.seq);
      return;
    }
    if (event.type === "page.navigation" && !event.payload.sameDocument) {
      this.doc.body?.replaceChildren();
      this.frames.clear();
      this.mounted.clear();
      this.nodes.clear();
      this.bindings.clear();
      this.scrolls.clear();
      this.documentId = null;
      this.onView({
        message: "页面跳转中 · 等待页面快照",
        url: event.payload.url || event.url,
      });
      return;
    }
    if (
      !this.documentId ||
      (event.documentId && event.documentId !== this.documentId)
    )
      return;
    if (event.type === "page.image" && event.payload.currentSrc) {
      const node = this.nodes.get(event.payload.nodeId);
      if (html(node, "img"))
        this.attribute(node, "src", event.payload.currentSrc);
    }
    if (event.type === "dom.mutation") {
      for (const record of event.payload.records) {
        const node = this.nodes.get(record.targetId);
        if (!node || ![1, 3, 4, 9, 11].includes(node.nodeType)) {
          this.gaps++;
          continue;
        }
        try {
          if (record.type === "attributes" && element(node))
            this.attribute(node, record.attributeName, record.newValue);
          else if (record.type === "characterData")
            this.text(node, record.newValue || "");
          else if (record.type === "childList") {
            for (const removed of record.removed) {
              const old = this.nodes.get(removed.nodeId);
              if (old?.parentNode === node) node.removeChild(old);
            }
            const next = record.nextSiblingId
              ? this.nodes.get(record.nextSiblingId)
              : undefined;
            let before: Node | null = next?.parentNode === node ? next : null;
            if (!before && record.previousSiblingId) {
              const previous = this.nodes.get(record.previousSiblingId);
              if (previous?.parentNode === node) before = previous.nextSibling;
            }
            const doc = documentNode(node) ? node : node.ownerDocument;
            if (!doc) throw new Error("节点缺少所属文档");
            for (const added of record.added) {
              const built = this.build(
                added,
                doc,
                element(node) ? node.namespaceURI || HTML_NS : HTML_NS,
                true,
              );
              node.insertBefore(built, before);
              if (
                element(node) &&
                node.localName === "style" &&
                built.nodeType === 3
              )
                this.text(built, textOf(added));
            }
          }
        } catch {
          this.gaps++;
        }
      }
      for (const [id, node] of this.nodes)
        if (
          !node.isConnected &&
          node.nodeType !== 9 &&
          !this.templateHosts.get(node.getRootNode())?.isConnected
        ) {
          this.nodes.delete(id);
          this.bindings.delete(node);
          this.scrolls.delete(node);
        }
    }
    if (event.type === "dom.mutation") this.mountFrames();
    if (
      (event.type === "action.input" || event.type === "action.change") &&
      event.payload.form
    )
      this.form(event.payload.form);
    if (event.type === "action.submit")
      for (const form of event.payload.fields) this.form(form);
    if (event.type === "action.scroll") {
      const node = event.payload.nodeId
        ? this.nodes.get(event.payload.nodeId)
        : undefined;
      if (node) this.scrolls.set(node, event.payload);
    }
    if (event.type === "action.focus") {
      const node = event.payload.nodeId
        ? this.nodes.get(event.payload.nodeId)
        : undefined;
      if (element(node) && "focus" in node && typeof node.focus === "function")
        node.focus({ preventScroll: true });
    }
    if (event.type === "action.click" || event.type === "action.dblclick") {
      let { x, y } = event.payload;
      const target = event.payload.nodeId
        ? this.nodes.get(event.payload.nodeId)
        : undefined;
      let doc = target?.ownerDocument;
      while (doc && doc !== this.doc) {
        const host = doc.defaultView?.frameElement;
        if (!host) break;
        const rect = host.getBoundingClientRect();
        x += rect.left;
        y += rect.top;
        doc = host.ownerDocument;
      }
      if (Number.isFinite(x) && Number.isFinite(y))
        this.onPointer({ x, y, seeking });
    }
    if (event.type === "page.resize")
      this.onView({ viewport: event.payload.viewport });
    this.restoreScroll();
    this.onView({ gaps: this.gaps });
  }
}
