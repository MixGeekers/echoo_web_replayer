import type {
  FormState,
  Point,
  Viewport,
  SerializedNode,
  RecordedMutation,
  DocumentSnapshot,
} from "../shared/contracts/recording";
import type { StoredEvent } from "../shared/contracts/storage";
export type ReplayForm = Pick<FormState, "nodeId"> &
  Partial<
    Pick<
      FormState,
      "value" | "checked" | "selectedValues" | "selectedIndex" | "text"
    >
  >;
export type ReplayDocument = Pick<DocumentSnapshot, "tree"> &
  Partial<
    Pick<DocumentSnapshot, "url" | "baseUrl" | "scroll" | "viewport" | "scope">
  > & { forms?: ReplayForm[]; scrolls?: (Point & { nodeId: string })[] };
export interface ReplaySnapshot extends ReplayDocument {
  frames?: ReplayDocument[];
  frameHosts?: (string | null)[];
  frameDepths?: number[];
  shadowRoots?: { forms: ReplayForm[] }[];
}
export type ReplayMutation = RecordedMutation extends infer M
  ? M extends RecordedMutation
    ? Pick<M, "type" | "targetId"> & Omit<M, "target" | "scope" | "observedAt">
    : never
  : never;
export interface ReplayView {
  viewport?: Pick<Viewport, "width" | "height">;
  url?: string;
  message?: string;
  gaps?: number;
}
export interface ReplayPointer {
  x: number;
  y: number;
  seeking?: boolean;
}
interface Payloads {
  "dom.snapshot": ReplaySnapshot;
  "dom.mutation": { records: ReplayMutation[] };
  "session.pause": null;
  "session.resume": null;
  "page.resource": null;
  "page.navigation": { sameDocument: boolean; url: string };
  "page.image": { nodeId: string; currentSrc: string };
  "action.input": { form: ReplayForm | null };
  "action.change": { form: ReplayForm | null };
  "action.submit": { fields: ReplayForm[] };
  "action.scroll": Point & { nodeId: string | null };
  "action.focus": { nodeId: string | null };
  "action.click": { nodeId: string | null; x: number; y: number };
  "action.dblclick": { nodeId: string | null; x: number; y: number };
  "page.resize": { viewport: Pick<Viewport, "width" | "height"> };
}
export type ReplayEvent = {
  [K in keyof Payloads]: {
    type: K;
    payload: Payloads[K];
    seq: number;
    documentId: string | null;
    url: string;
  };
}[keyof Payloads];
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
function point(value: unknown): Point {
  const v = object(value);
  return { x: number(v.x), y: number(v.y) };
}
function viewport(value: unknown): Viewport {
  const v = object(value);
  return {
    width: number(v.width, 1000),
    height: number(v.height, 760),
    devicePixelRatio: number(v.devicePixelRatio, 1),
  };
}
/** Validate the original tree in place: large snapshot strings/trees are not copied. */
function isNode(value: unknown): value is SerializedNode {
  const v = object(value);
  if (typeof v.nodeId !== "string" || typeof v.nodeName !== "string")
    return false;
  if (
    v.children !== undefined &&
    (!Array.isArray(v.children) || !v.children.every(isNode))
  )
    return false;
  switch (v.nodeType) {
    case 1: {
      if (
        !nullableString(v.namespaceURI) ||
        !v.attributes ||
        typeof v.attributes !== "object" ||
        Array.isArray(v.attributes) ||
        !Object.values(v.attributes).every((x) => typeof x === "string")
      )
        return false;
      if (v.currentSrc !== undefined && typeof v.currentSrc !== "string")
        return false;
      if (v.templateContent !== undefined && !isNode(v.templateContent))
        return false;
      if (v.shadowRoot !== undefined && !isNode(v.shadowRoot)) return false;
      if (v.state !== undefined) {
        if (
          v.state === null ||
          typeof v.state !== "object" ||
          Array.isArray(v.state)
        )
          return false;
        const s = object(v.state);
        if (
          s.value !== undefined &&
          typeof s.value !== "string" &&
          typeof s.value !== "number"
        )
          return false;
        if (s.checked !== undefined && typeof s.checked !== "boolean")
          return false;
        if (s.selectedValues !== undefined && !strings(s.selectedValues))
          return false;
      }
      return true;
    }
    case 3:
    case 4:
    case 8:
      return nullableString(v.text);
    case 10:
      return (
        typeof v.name === "string" &&
        typeof v.publicId === "string" &&
        typeof v.systemId === "string"
      );
    case 2:
    case 5:
    case 6:
    case 7:
    case 9:
    case 11:
    case 12:
      return true;
    default:
      return false;
  }
}
function form(value: unknown): ReplayForm | null {
  const v = object(value);
  if (typeof v.nodeId !== "string") return null;
  return {
    nodeId: v.nodeId,
    ...(typeof v.value === "string" || typeof v.value === "number"
      ? { value: v.value }
      : {}),
    ...(typeof v.checked === "boolean" ? { checked: v.checked } : {}),
    ...(typeof v.selectedIndex === "number"
      ? { selectedIndex: v.selectedIndex }
      : {}),
    ...(strings(v.selectedValues) ? { selectedValues: v.selectedValues } : {}),
    ...(nullableString(v.text) ? { text: v.text } : {}),
  };
}
function forms(value: unknown): ReplayForm[] {
  return array(value)
    .map(form)
    .filter((x): x is ReplayForm => x !== null);
}
export function decodeDocument(value: unknown): ReplayDocument {
  const v = object(value);
  if (!isNode(v.tree) || v.tree.nodeType !== 9)
    throw new Error("此快照没有可回放的有效节点树，请重新录制");
  // Only frameContexts.nodeId is needed by replay; other scope metadata stays in the raw event.
  return {
    tree: v.tree,
    url: string(v.url),
    baseUrl: string(v.baseUrl),
    forms: forms(v.forms),
    scroll: point(v.scroll),
    viewport: viewport(v.viewport),
    scrolls: array(v.scrolls).map((x) => ({
      ...point(x),
      nodeId: string(object(x).nodeId),
    })),
  };
}
export function decodeSnapshot(
  value: unknown,
): ReplaySnapshot & { frameHosts: (string | null)[] } {
  const v = object(value),
    frames = array(v.frames);
  return {
    ...decodeDocument(value),
    frames: frames.map(decodeDocument),
    frameDepths: frames.map(
      (x) => array(object(object(x).scope).frameContexts).length,
    ),
    frameHosts: frames.map((x) => {
      const contexts = array(object(object(x).scope).frameContexts);
      return typeof object(contexts.at(-1)).nodeId === "string"
        ? string(object(contexts.at(-1)).nodeId)
        : null;
    }),
    shadowRoots: array(v.shadowRoots).map((x) => ({
      forms: forms(object(x).forms),
    })),
  };
}
export function decodeReplayEvent(event: StoredEvent): ReplayEvent | null {
  const p = object(event.payload),
    meta = {
      seq: event.seq,
      documentId:
        typeof event.documentId === "string" ? event.documentId : null,
      url: string(event.url),
    };
  const nodeId =
    typeof object(p.target).nodeId === "string"
      ? string(object(p.target).nodeId)
      : null;
  switch (event.type) {
    case "dom.snapshot":
      return { ...meta, type: event.type, payload: decodeSnapshot(p) };
    case "session.pause":
    case "session.resume":
    case "page.resource":
      return { ...meta, type: event.type, payload: null };
    case "page.navigation":
      return {
        ...meta,
        type: event.type,
        payload: {
          sameDocument: p.sameDocument === true,
          url: string(p.url, meta.url),
        },
      };
    case "page.image":
      return {
        ...meta,
        type: event.type,
        payload: { nodeId: nodeId ?? "", currentSrc: string(p.currentSrc) },
      };
    case "action.input":
    case "action.change":
      return { ...meta, type: event.type, payload: { form: form(p.form) } };
    case "action.submit":
      return {
        ...meta,
        type: event.type,
        payload: { fields: forms(p.fields) },
      };
    case "action.scroll":
      return { ...meta, type: event.type, payload: { ...point(p), nodeId } };
    case "action.focus":
      return { ...meta, type: event.type, payload: { nodeId } };
    case "action.click":
    case "action.dblclick":
      return {
        ...meta,
        type: event.type,
        payload: {
          nodeId,
          x: number(object(p.position).clientX, NaN),
          y: number(object(p.position).clientY, NaN),
        },
      };
    case "page.resize":
      return {
        ...meta,
        type: event.type,
        payload: { viewport: viewport(p.viewport) },
      };
    case "dom.mutation": {
      const records: ReplayMutation[] = [];
      for (const raw of array(p.records)) {
        const r = object(raw),
          targetId = string(r.targetId);
        if (r.type === "attributes")
          records.push({
            type: r.type,
            targetId,
            attributeName: string(r.attributeName),
            attributeNamespace: nullableString(r.attributeNamespace)
              ? r.attributeNamespace
              : null,
            oldValue: nullableString(r.oldValue) ? r.oldValue : null,
            newValue: nullableString(r.newValue) ? r.newValue : null,
          });
        else if (r.type === "characterData")
          records.push({
            type: r.type,
            targetId,
            oldValue: nullableString(r.oldValue) ? r.oldValue : null,
            newValue: nullableString(r.newValue) ? r.newValue : null,
          });
        else if (r.type === "childList") {
          const added = array(r.added),
            removed = array(r.removed);
          if (!added.every(isNode) || !removed.every(isNode))
            throw new Error("DOM 变化包含无效节点");
          records.push({
            type: r.type,
            targetId,
            previousSiblingId: nullableString(r.previousSiblingId)
              ? r.previousSiblingId
              : null,
            nextSiblingId: nullableString(r.nextSiblingId)
              ? r.nextSiblingId
              : null,
            added,
            removed,
          });
        }
      }
      return { ...meta, type: event.type, payload: { records } };
    }
    default:
      return null;
  }
}
