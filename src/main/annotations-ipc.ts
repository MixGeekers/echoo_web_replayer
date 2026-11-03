import type { BrowserWindow } from "electron";
import type { InvokeChannel, InvokeResult } from "../shared/contracts/ipc";
import type { ExportRange } from "../shared/contracts/annotations";
import type { Workspace } from "./workspace";
import { createAnnotationService, onAnnotationsChanged } from "./annotations";
import { object } from "../shared/runtime";

type Handle = <K extends InvokeChannel>(
  name: K,
  handler: (input: unknown) => InvokeResult<K> | Promise<InvokeResult<K>>,
) => void;
const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${name} 必须为字符串`);
  return value;
};
const optionalText = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("标注内容必须为文本");
  return value;
};
const seq = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} 必须为正整数`);
  return value;
};
const optionalSeq = (value: unknown, name: string): number | null | undefined =>
  value === undefined ? undefined : value === null ? null : seq(value, name);
const revision = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("expectedRevision 必须为非负整数");
  return value;
};

/** Parse an optional export slice from untrusted renderer or agent input. */
export function parseExportRange(value: unknown): ExportRange | undefined {
  if (value === undefined || value === null) return undefined;
  const q = object(value);
  const bound = (key: "startSeq" | "endSeq" | "startMs" | "endMs") => {
    const v = q[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new Error("导出范围必须为非负整数");
    return v;
  };
  for (const key of Object.keys(q))
    if (!["startSeq", "endSeq", "startMs", "endMs"].includes(key)) throw new Error("未知的导出范围字段");
  const range: ExportRange = {};
  const startSeq = bound("startSeq"), endSeq = bound("endSeq"), startMs = bound("startMs"), endMs = bound("endMs");
  if (startSeq !== undefined) range.startSeq = startSeq;
  if (endSeq !== undefined) range.endSeq = endSeq;
  if (startMs !== undefined) range.startMs = startMs;
  if (endMs !== undefined) range.endMs = endMs;
  if (!Object.keys(range).length) return undefined;
  if (range.startSeq !== undefined && range.endSeq !== undefined && range.endSeq < range.startSeq)
    throw new Error("导出范围结束不能早于开始");
  if (range.startMs !== undefined && range.endMs !== undefined && range.endMs < range.startMs)
    throw new Error("导出范围结束不能早于开始");
  return range;
}

export function installAnnotationIPC(win: BrowserWindow, workspace: Workspace, handle: Handle) {
  const service = createAnnotationService(workspace);
  onAnnotationsChanged((change) => {
    if (!win.isDestroyed()) win.webContents.send("collector:annotations", change);
  });
  handle("listAnnotations", (input) => service.list(string(input, "sessionId")));
  handle("createAnnotation", (input) => {
    const q = object(input);
    return service.create({
      sessionId: string(q.sessionId, "sessionId"),
      seq: seq(q.seq, "seq"),
      endSeq: optionalSeq(q.endSeq, "endSeq"),
      text: optionalText(q.text),
      author: "user",
      expectedRevision: revision(q.expectedRevision),
    });
  });
  handle("updateAnnotation", (input) => {
    const q = object(input);
    return service.update({
      sessionId: string(q.sessionId, "sessionId"),
      annotationId: string(q.annotationId, "annotationId"),
      text: optionalText(q.text),
      endSeq: optionalSeq(q.endSeq, "endSeq"),
      expectedRevision: revision(q.expectedRevision),
    });
  });
  handle("deleteAnnotation", (input) => {
    const q = object(input);
    return service.remove({
      sessionId: string(q.sessionId, "sessionId"),
      annotationId: string(q.annotationId, "annotationId"),
      expectedRevision: revision(q.expectedRevision),
    });
  });
  handle("markAnnotation", (input) => {
    const q = input === undefined || input === null ? {} : object(input);
    return service.mark(optionalText(q.text));
  });
}
