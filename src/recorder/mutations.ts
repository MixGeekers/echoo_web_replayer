import type { RecordedMutation } from "../shared/contracts/recording";
import type { RecorderContext } from "./context";
import { isElement } from "./guards";

export class MutationCapture {
  private queue: RecordedMutation[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  constructor(
    private readonly context: RecorderContext,
    private readonly observers: () => Iterable<MutationObserver>,
  ) {}
  collect(records: MutationRecord[]): void {
    if (!this.context.isRecording() || !records.length) return;
    this.context.nodes.withCache(() => this.collectRecords(records));
  }
  private collectRecords(records: MutationRecord[]): void {
    const observedAt = new Date().toISOString(),
      laterValues = new Map<string, string | null>();
    const output: RecordedMutation[] = [];
    const { nodes } = this.context;
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (!record) continue;
      const targetId = nodes.id(record.target);
      const base = {
        targetId,
        target: {
          nodeId: targetId,
          nodeName: record.target.nodeName,
          selector: nodes.selector(record.target),
        },
        scope: nodes.scope(record.target),
        observedAt,
      };
      let result: RecordedMutation;
      if (record.type === "attributes") {
        if (!isElement(record.target) || record.attributeName === null)
          throw new Error("Invalid attribute mutation target");
        const key = `${targetId}:attribute:${record.attributeNamespace || ""}:${record.attributeName}`;
        const next = laterValues.has(key)
          ? (laterValues.get(key) ?? null)
          : record.target.getAttributeNS(
              record.attributeNamespace,
              record.attributeName,
            );
        result = {
          ...base,
          type: "attributes",
          attributeName: record.attributeName,
          attributeNamespace: record.attributeNamespace,
          oldValue: record.oldValue,
          newValue: next,
        };
        laterValues.set(key, record.oldValue);
      } else if (record.type === "characterData") {
        const key = `${targetId}:text`;
        result = {
          ...base,
          type: "characterData",
          oldValue: record.oldValue,
          newValue: laterValues.has(key)
            ? (laterValues.get(key) ?? null)
            : record.target.nodeValue,
        };
        laterValues.set(key, record.oldValue);
      } else {
        result = {
          ...base,
          type: "childList",
          previousSiblingId: nodes.id(record.previousSibling),
          nextSiblingId: nodes.id(record.nextSibling),
          added: Array.from(record.addedNodes, (node) => nodes.serialize(node)),
          removed: Array.from(record.removedNodes, (node) =>
            nodes.serialize(node),
          ),
        };
      }
      output.push(result);
    }
    // Reverse traversal reconstructs intermediate values; delivery order stays unchanged.
    for (let index = output.length - 1; index >= 0; index--) {
      const record = output[index];
      if (record) this.queue.push(record);
    }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 150);
  }
  flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      this.clearTimer();
      for (const observer of this.observers())
        this.collect(observer.takeRecords());
      this.clearTimer();
      if (this.queue.length) {
        const records = this.queue;
        this.queue = [];
        this.context.send(
          "dom.mutation",
          { records, recordCount: records.length, batchIntervalMs: 150 },
          records[0]?.observedAt,
        );
      }
    } catch (error) {
      this.context.report("flush-mutations", error);
    } finally {
      this.flushing = false;
    }
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  reset(): void {
    this.clearTimer();
    this.queue = [];
  }
}
