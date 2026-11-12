import type { SerializedNode } from "./contracts/recording";

export type VisualNode = Omit<SerializedNode, "children"> & {
  children: string[];
  attributes?: Record<string, string>;
  namespaceURI?: string | null;
  text?: string;
  scroll?: { x: number; y: number };
};
export interface FrameVisual {
  frameId: string;
  documentId: string;
  parentDocumentId: string;
  hostNodeId: string;
  url: string;
  baseUrl?: string;
  nodes: VisualNode[];
}
export interface FramePatch {
  documentId: string;
  nodes: VisualNode[];
  removed: string[];
}

export class FrameArchive {
  private documents = new Map<string, { header: Omit<FrameVisual, "nodes">; nodes: Map<string, VisualNode> }>();
  has(id: string) { return this.documents.has(id); }
  clear() { this.documents.clear(); }
  forget(id: string) {
    this.documents.delete(id);
    for (const [child, value] of this.documents)
      if (value.header.parentDocumentId === id) this.forget(child);
  }
  set(frame: FrameVisual) {
    for (const [id, entry] of this.documents)
      if (entry.header.frameId === frame.frameId && id !== frame.documentId) this.forget(id);
    const { nodes, ...header } = frame;
    this.documents.set(frame.documentId, { header, nodes: new Map(nodes.map(node => [node.nodeId, node])) });
  }
  patch(patch: FramePatch) {
    const entry = this.documents.get(patch.documentId);
    if (!entry) return;
    for (const id of patch.removed) entry.nodes.delete(id);
    for (const node of patch.nodes) entry.nodes.set(node.nodeId, node);
  }
  snapshots(rootDocumentId?: string): FrameVisual[] {
    const result: FrameVisual[] = [];
    for (const { header, nodes } of this.documents.values()) {
      if (rootDocumentId) {
        let parent = header.parentDocumentId;
        const seen = new Set<string>();
        while (parent !== rootDocumentId && this.documents.has(parent) && !seen.has(parent)) {
          seen.add(parent);
          parent = this.documents.get(parent)!.header.parentDocumentId;
        }
        if (parent !== rootDocumentId) continue;
      }
      result.push({ ...header, nodes: [...nodes.values()] });
    }
    return result;
  }
}

export function visualTree(frame: FrameVisual): SerializedNode | undefined {
  const nodes = new Map(frame.nodes.map(node => [node.nodeId, node]));
  function build(id: string): SerializedNode | undefined {
    const node = nodes.get(id);
    if (!node) return;
    nodes.delete(id);
    const children = node.children.map(build).filter((child): child is SerializedNode => !!child);
    return { ...node, children } as SerializedNode;
  }
  return build(frame.documentId);
}
