import type { CodegenOptions, CodegenResult } from "../../shared/contracts/codegen";
import type { SessionMetadata } from "../../shared/contracts/storage";
import { ScriptBuilder, renderScript } from "./generator";
import type { CodegenRecording } from "./generator";
import { readCodegenEvents } from "./source";
import type { CodegenReadStats } from "./source";

export {
  ScriptBuilder,
  renderScript,
  generateScript,
  chooseLocator,
  describeTarget,
  cssEscape,
  tsString,
  pyString,
  seqLabel,
  scriptFilename,
} from "./generator";
export { readCodegenEvents, leadingType } from "./source";

export interface CodegenCapture {
  metadata: Pick<SessionMetadata, "id" | "name" | "url" | "startedAt">;
  timelinePath: string;
  byteLength: number;
}
export interface CodegenStore {
  capture(sessionId: string): Promise<CodegenCapture>;
}

/** Stream one captured timeline boundary into a script. Older recordings may also need the current frame DOM index. */
export async function generateFromTimeline(
  capture: CodegenCapture,
  options: CodegenOptions & { signal?: AbortSignal | undefined } = {},
): Promise<CodegenResult> {
  const recording: CodegenRecording = {
    id: capture.metadata.id,
    name: capture.metadata.name,
    url: capture.metadata.url,
    startedAt: capture.metadata.startedAt,
  };
  let builder = new ScriptBuilder(recording, options);
  let stats: CodegenReadStats = { skippedLines: 0, oversizedLines: 0, invalidLines: 0 };
  for await (const event of readCodegenEvents(capture.timelinePath, capture.byteLength, { signal: options.signal, stats }))
    builder.add(event);
  if (builder.needsFrameHistory) {
    // Pay for parsing historical DOM only when an action actually needs it.
    builder = new ScriptBuilder(recording, options);
    stats = { skippedLines: 0, oversizedLines: 0, invalidLines: 0 };
    for await (const event of readCodegenEvents(capture.timelinePath, capture.byteLength, {signal: options.signal, stats, includeFrameHistory: true}))
      builder.add(event);
  }
  const result = renderScript(recording, builder, options);
  if (stats.oversizedLines)
    result.warnings.push(`${stats.oversizedLines} 条超大事件未参与生成，请在时间线中核对。`);
  if (stats.invalidLines) result.warnings.push(`${stats.invalidLines} 行时间线无法解析，已跳过。`);
  result.stats.events += stats.skippedLines;
  return result;
}

export async function generateRecordingScript(
  store: CodegenStore,
  sessionId: string,
  options: CodegenOptions & { signal?: AbortSignal | undefined } = {},
): Promise<CodegenResult> {
  return generateFromTimeline(await store.capture(sessionId), options);
}
