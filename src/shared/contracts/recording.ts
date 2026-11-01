/** Wire values shared by capture, storage and replay. No browser or Electron types. */
export interface Point {
  x: number;
  y: number;
}
export interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}
export interface Scope {
  framePath: (string | null)[];
  frameContexts: {
    selector: string | null;
    nodeId: string;
    shadowPath: (string | null)[];
  }[];
  frameUrl: string;
  shadowPath: (string | null)[];
  rootId: string;
}
export interface Locator {
  strategy: "testId" | "id" | "label" | "placeholder" | "role" | "text" | "css";
  value: string;
  name?: string;
}
export interface NodeDescription {
  nodeId: string;
  nodeType: number;
  nodeName: string;
  selector: string | null;
  scope: Scope;
  tagName?: string;
  text?: string;
  attributes?: Record<string, string>;
  locators?: Locator[];
}
export interface ElementState {
  value?: string | number;
  checked?: boolean;
  selectedValues?: string[];
}
interface SerializedBase {
  nodeId: string;
  nodeName: string;
  children?: SerializedNode[];
}
export interface SerializedElement extends SerializedBase {
  nodeType: 1;
  attributes: Record<string, string>;
  namespaceURI: string | null;
  currentSrc?: string;
  state?: ElementState;
  templateContent?: SerializedNode;
  shadowRoot?: SerializedNode;
}
export interface SerializedText extends SerializedBase {
  nodeType: 3 | 4 | 8;
  text: string | null;
}
export interface SerializedDocument extends SerializedBase {
  nodeType: 9;
}
export interface SerializedDoctype extends SerializedBase {
  nodeType: 10;
  name: string;
  publicId: string;
  systemId: string;
}
export interface SerializedFragment extends SerializedBase {
  nodeType: 11;
}
export interface SerializedOther extends SerializedBase {
  nodeType: 2 | 5 | 6 | 7 | 12;
}
export type SerializedNode =
  | SerializedElement
  | SerializedText
  | SerializedDocument
  | SerializedDoctype
  | SerializedFragment
  | SerializedOther;
export interface FormState extends ElementState {
  nodeId: string;
  selector: string | null;
  scope: Scope;
  tagName: string;
  name: string | null;
  type: string | null;
  selectedIndex?: number;
  text?: string | null;
  files?: { name: string; size: number; type: string; lastModified: number }[];
}
export interface DocumentSnapshot {
  nodeId: string;
  url: string;
  baseUrl: string;
  title: string;
  scope: Scope;
  html: string;
  tree: SerializedNode;
  forms: FormState[];
  scroll: Point;
  viewport: Viewport;
  scrolls: (Point & { nodeId: string })[];
}
export interface Coverage {
  mainDocument: boolean;
  sameOriginFrames: boolean;
  openShadowRoots: boolean;
  shadowDiscoveryIntervalMs: number;
  crossOriginFrames: boolean;
  closedShadowRoots: boolean;
  canvasAndWebGLPixels: boolean;
  networkTraffic: boolean;
  javascriptHeap: boolean;
  dataRedaction: boolean;
  mutationSemantics: string;
}
export interface SnapshotPayload extends DocumentSnapshot {
  reason: string;
  frames: DocumentSnapshot[];
  shadowRoots: {
    nodeId: string;
    host: NodeDescription | null;
    html: string;
    forms: FormState[];
  }[];
  inaccessibleFrames: {
    target: NodeDescription | null;
    src: string | null;
    reason: string;
  }[];
  coverage: Coverage;
}
interface MutationBase {
  targetId: string;
  target: { nodeId: string; nodeName: string; selector: string | null };
  scope: Scope;
  observedAt: string;
}
export type RecordedMutation =
  | (MutationBase & {
      type: "attributes";
      attributeName: string;
      attributeNamespace: string | null;
      oldValue: string | null;
      newValue: string | null;
    })
  | (MutationBase & {
      type: "characterData";
      oldValue: string | null;
      newValue: string | null;
    })
  | (MutationBase & {
      type: "childList";
      previousSiblingId: string | null;
      nextSiblingId: string | null;
      added: SerializedNode[];
      removed: SerializedNode[];
    });
export interface MutationPayload {
  records: RecordedMutation[];
  recordCount: number;
  batchIntervalMs: number;
}
export interface ActionBase {
  target: NodeDescription | null;
  trusted: boolean;
  modifiers: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
}
export interface ClickPayload extends ActionBase {
  position: {
    clientX: number;
    clientY: number;
    pageX: number;
    pageY: number;
    screenX: number;
    screenY: number;
  };
  button: number;
  detail: number;
}
export interface InputPayload extends ActionBase {
  form: FormState;
  inputType?: string;
  data?: string | null;
  isComposing: boolean;
}
export interface ScrollPayload extends Point {
  target: NodeDescription | null;
  trusted: boolean;
  coalesced: boolean;
}
export interface KeyPayload extends ActionBase {
  key: string;
  code: string;
  repeat: boolean;
  isComposing: boolean;
}
export interface SubmitPayload extends ActionBase {
  submitter: NodeDescription | null;
  fields: FormState[];
  action: string;
  method: string;
}
export interface RecorderPayloadMap {
  "dom.snapshot": SnapshotPayload;
  "dom.mutation": MutationPayload;
  "action.click": ClickPayload;
  "action.dblclick": ClickPayload;
  "action.input": InputPayload;
  "action.change": InputPayload;
  "action.keydown": KeyPayload;
  "action.submit": SubmitPayload;
  "action.focus": ActionBase;
  "action.scroll": ScrollPayload;
  "page.image": { target: { nodeId: string }; currentSrc: string };
  "page.lifecycle": {
    event: string;
    readyState?: string;
    scope?: Scope;
    coverage?: Coverage;
    persisted?: boolean;
  };
  "page.resize": { viewport: Viewport };
  "recorder.error": { operation: string; message: string };
}
export type RecorderEventType = keyof RecorderPayloadMap;
export type RecorderEvent = {
  [K in RecorderEventType]: {
    type: K;
    payload: RecorderPayloadMap[K];
    sessionId: string;
    documentId: string;
    timestamp: string;
    url: string;
    title: string;
  };
}[RecorderEventType];
export type RecorderSend = <K extends RecorderEventType>(
  type: K,
  payload: RecorderPayloadMap[K],
  timestamp?: string,
) => void;
export interface RecorderState {
  recording: boolean;
  sessionId: string | null;
}
export type CommandResult = { ok: true } | { ok: false; error: string };
export function errorMessage(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : String(error);
}
