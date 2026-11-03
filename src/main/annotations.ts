import type { SessionStore } from "./storage/session-store";
import { AnnotationStore } from "./storage/annotation-store";
import type {
  AnnotationAuthor,
  AnnotationChange,
  AnnotationResult,
  AnnotationSet,
} from "../shared/contracts/annotations";
import { DEFAULT_MARK_TEXT } from "../shared/contracts/annotations";
import type { SessionMetadata } from "../shared/contracts/storage";

/** The subset of the workspace the annotation service relies on. */
export interface AnnotationHost {
  store: SessionStore;
  readable(id: string): unknown;
  readRecording<T>(id: string, read: () => Promise<T>): Promise<T>;
  state(): { session: SessionMetadata | null };
}

const listeners = new Set<(change: AnnotationChange) => void>();
/** Desktop windows subscribe so agent-written notes appear without polling. */
export function onAnnotationsChanged(listener: (change: AnnotationChange) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function changed(result: AnnotationSet) {
  for (const listener of listeners) {
    try {
      listener({ sessionId: result.recordingId, revision: result.revision });
    } catch {
      /* A closed window cannot block a saved note. */
    }
  }
}

const services = new WeakMap<object, ReturnType<typeof build>>();
export function createAnnotationService(host: AnnotationHost) {
  let service = services.get(host.store);
  if (!service) {
    service = build(host);
    services.set(host.store, service);
  }
  return service;
}

function build(host: AnnotationHost) {
  const annotations = new AnnotationStore(host.store);
  async function anchor(id: string, seq: number) {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("seq 必须为正整数事件序号");
    const page = await host.readRecording(id, () =>
      host.store.timeline({ sessionId: id, afterSeq: seq - 1, limit: 1 }),
    );
    const event = page.events[0];
    if (!event || event.seq !== seq) throw Object.assign(new Error(`找不到事件 #${seq}`), { code: "NOT_FOUND" });
    return { elapsedMs: event.elapsedMs ?? 0, timestamp: event.timestamp ?? "", eventType: event.type };
  }
  async function finish(id: string, run: () => Promise<AnnotationResult>) {
    host.readable(id);
    const result = await run();
    changed(result);
    return result;
  }
  const api = {
    list(id: string): Promise<AnnotationSet> {
      host.readable(id);
      return annotations.read(id);
    },
    async create(input: {
      sessionId: string;
      seq: number;
      endSeq?: number | null | undefined;
      text?: string | undefined;
      author: AnnotationAuthor;
      expectedRevision?: number | undefined;
    }) {
      host.readable(input.sessionId);
      const event = await anchor(input.sessionId, input.seq);
      if (input.endSeq !== undefined && input.endSeq !== null && input.endSeq !== input.seq)
        await anchor(input.sessionId, input.endSeq);
      return finish(input.sessionId, () =>
        annotations.create(
          input.sessionId,
          { ...event, seq: input.seq, endSeq: input.endSeq ?? null, text: input.text ?? DEFAULT_MARK_TEXT, author: input.author },
          input.expectedRevision,
        ),
      );
    },
    async update(input: {
      sessionId: string;
      annotationId: string;
      text?: string | undefined;
      endSeq?: number | null | undefined;
      expectedRevision?: number | undefined;
    }) {
      if (input.endSeq !== undefined && input.endSeq !== null) {
        host.readable(input.sessionId);
        await anchor(input.sessionId, input.endSeq);
      }
      return finish(input.sessionId, () =>
        annotations.update(input.sessionId, input.annotationId, { text: input.text, endSeq: input.endSeq }, input.expectedRevision),
      );
    },
    remove(input: { sessionId: string; annotationId: string; expectedRevision?: number | undefined }) {
      return finish(input.sessionId, () =>
        annotations.remove(input.sessionId, input.annotationId, input.expectedRevision),
      );
    },
    /** Quick mark while recording: anchors at the latest persisted seq. */
    async mark(text = DEFAULT_MARK_TEXT, author: AnnotationAuthor = "user"): Promise<AnnotationResult> {
      const current = host.state().session;
      if (!current || !["recording", "paused"].includes(current.status))
        throw new Error("当前没有进行中的采集");
      const record = host.store.getSession(current.id);
      if (!record.lastSeq) throw new Error("采集尚未保存事件，请稍后再标记");
      return api.create({ sessionId: record.id, seq: record.lastSeq, text, author });
    },
  };
  return api;
}
export type AnnotationService = ReturnType<typeof createAnnotationService>;
