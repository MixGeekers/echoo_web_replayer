import type { FrameSelector } from "../../shared/contracts/application";
import { object } from "../../shared/runtime";
import type { CodegenEvent } from "./generator";

type Raw = Record<string, unknown>;
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown) => typeof v === "string" ? v : "";
interface NodeInfo {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: string[];
}
interface DocumentInfo {
  frame: string;
  parent: string;
  host: string;
  nodes: Map<string, NodeInfo>;
}

// Older visual recordings have document-local IDs but no action-time selectors.
// Keep just evidence needed to recover them, without retaining styles or HTML.
export class FrameHistory {
  private root = "";
  private hosts = new Map<string, FrameSelector[]>();
  private docs = new Map<string, DocumentInfo>();

  update(event: CodegenEvent) {
    const p = object(event.payload);
    switch (event.type) {
      case "session.start":
      case "session.pause":
      case "page.navigation":
      case "frame.historyGap":
      case "recorder.error":
        if (event.type === "page.navigation" && p.sameDocument) return;
        if (event.type === "recorder.error" && !p.possibleGap) return;
        this.root = "";
        this.hosts.clear();
        this.docs.clear();
        break;
      case "dom.snapshot":
        this.root = text(event.documentId);
        this.hosts.clear();
        this.docs.clear();
        for (const entry of list(p.inaccessibleFrames)) {
          const target = object(object(entry).target);
          const scope = object(target.scope);
          const path = [...list(scope.frameContexts), {selector: target.selector, shadowPath: scope.shadowPath}].map(object);
          if (path.every(hop => text(hop.selector) && Array.isArray(hop.shadowPath) && hop.shadowPath.every(x => typeof x === "string" && x)))
            this.hosts.set(text(target.nodeId), path.map(hop => ({selector: text(hop.selector), shadowPath: hop.shadowPath as string[]})));
        }
        for (const frame of list(p.frameDocuments)) this.baseline(object(frame));
        break;
      case "dom.mutation":
        for (const item of list(p.records)) {
          const record = object(item);
          if (record.type === "childList") {
            const removed = [...list(record.removed)];
            while (removed.length) {
              const node = object(removed.pop());
              this.hosts.delete(text(node.nodeId));
              for (const child of list(node.children)) removed.push(child);
            }
            // Positional selectors can silently change meaning when siblings move.
            for (const [id, path] of this.hosts)
              if (path.some(h => [h.selector, ...h.shadowPath].some(s => !s.startsWith("#") && !s.startsWith("[data-testid=")))) this.hosts.delete(id);
          } else if (record.type === "attributes" && ["id", "data-testid"].includes(text(record.attributeName))) {
            // An ancestor selector may change, or acquire a duplicate elsewhere.
            this.hosts.clear();
          }
        }
        break;
      case "frame.snapshot": this.baseline(p); break;
      case "frame.mutation": {
        const doc = this.docs.get(text(p.documentId));
        if (doc) {
          for (const id of list(p.removed)) doc.nodes.delete(text(id));
          this.upsert(doc, p.nodes);
        }
        break;
      }
      case "frame.detach": this.docs.delete(text(p.documentId)); break;
    }
  }

  private baseline(p: Raw) {
    for (const [id, doc] of this.docs) if (doc.frame === p.frameId) this.docs.delete(id);
    const doc: DocumentInfo = { frame: text(p.frameId), parent: text(p.parentDocumentId), host: text(p.hostNodeId), nodes: new Map() };
    this.upsert(doc, p.nodes);
    this.docs.set(text(p.documentId), doc);
  }
  private upsert(doc: DocumentInfo, values: unknown) {
    for (const item of list(values)) {
      const node = object(item), attrs = object(node.attributes);
      const saved: Record<string, string> = {};
      for (const key of ["id", "data-testid", "aria-label", "placeholder", "name", "type"])
        if (typeof attrs[key] === "string") saved[key] = attrs[key];
      doc.nodes.set(text(node.nodeId), { tag: text(node.nodeName).toLowerCase(), attrs: saved,
        text: text(node.text).slice(0, 100), children: list(node.children).map(text) });
    }
  }

  resolve(p: Raw, escape: (value: string) => string): Raw | undefined {
    let doc = this.docs.get(text(p.documentId));
    if (!doc || doc.frame !== p.frameId) return;
    let target = p.target;
    if (!target) {
      const local = doc.nodes.get(text(p.visualNodeId));
      if (!local || local.tag !== text(p.element).toLowerCase()) return;
      const selector = this.selector(doc, local, escape);
      if (!selector) return;
      target = { selector, shadowPath: [], inputType: local.attrs.type };
    }
    if (Array.isArray(p.framePath) && p.framePath.length) return { ...p, target };
    const path: FrameSelector[] = [], seen = new Set<DocumentInfo>();
    while (!seen.has(doc)) {
      seen.add(doc);
      if (doc.parent === this.root) {
        const prefix = this.hosts.get(doc.host);
        if (!prefix?.length) return;
        return { ...p, framePath: [...prefix, ...path], target };
      }
      const parent: DocumentInfo | undefined = this.docs.get(doc.parent);
      const host = parent?.nodes.get(doc.host);
      if (!parent || !host || !["iframe", "frame"].includes(host.tag)) return;
      const hop = this.selector(parent, host, escape);
      if (!hop) return;
      path.unshift({selector: hop, shadowPath: []});
      doc = parent;
    }
  }
  private selector(doc: DocumentInfo, target: NodeInfo, escape: (value: string) => string) {
    for (const key of ["id", "data-testid", "aria-label", "placeholder", "name"]) {
      const value = target.attrs[key];
      if (value && !Array.from(doc.nodes.values()).some(n => n !== target && n.attrs[key] === value))
        return key === "id" ? "#" + escape(value) : `${escape(target.tag)}[${key}=${escape(value)}]`;
    }
    if (target.tag === "button" && target.children.length === 1) {
      const label = doc.nodes.get(target.children[0]!);
      if (label?.tag === "#text" && label.text.trim() && label.text.length <= 80 &&
          !Array.from(doc.nodes.values()).some(node => node !== label && node.tag === "#text" && node.text.trim() === label.text.trim()))
        return "button:text-is(" + JSON.stringify(label.text.trim()) + ")";
    }
    return null;
  }
}
