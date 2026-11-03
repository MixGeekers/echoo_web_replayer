import type {
  ExportCompression, ExportEncoding, ExportProgress, ExportResult,
  ExportWorkerCommand, ExportWorkerData, WorkerMessage,
} from '../../shared/contracts/export';
import { sessionMetadata } from '../storage/values';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的导出工作线程消息');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('导出消息字段必须为字符串');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('导出消息计数必须为非负安全整数');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('导出消息字段必须为布尔值');
  return value;
}
const optionalString = (value: unknown) => value === undefined ? undefined : string(value);
const optionalNumber = (value: unknown) => value === undefined ? undefined : number(value);
function encoding(value: unknown): ExportEncoding {
  if (value !== 'delta' && value !== 'full') throw new Error('无效的数据导出格式');
  return value;
}
function compression(value: unknown): ExportCompression {
  if (value !== 'deflate' && value !== 'store') throw new Error('无效的 ZIP 压缩方式');
  return value;
}
/** Validate the small worker envelope; the timeline remains streamed from its immutable byte boundary. */
export function readWorkerData(value: unknown): ExportWorkerData {
  const raw = record(value), capture = record(raw.capture);
  const metadata = sessionMetadata(capture.metadata);
  const sessionId = string(raw.sessionId);
  if (metadata.id !== sessionId) throw new Error('导出截点与会话不一致');
  const resourcePath = string(capture.resourcePath), resourceBytes = number(capture.resourceBytes);
  if (resourceBytes && !resourcePath) throw new Error('资源截点缺少索引路径');
  return {
    capture: {
      metadata, timelinePath: string(capture.timelinePath), byteLength: number(capture.byteLength),
      capturedAt: string(capture.capturedAt),
      resourcePath, resourceBytes,
    },
    sessionId, destination: string(raw.destination), appVersion: optionalString(raw.appVersion),
    encoding: raw.encoding === undefined ? undefined : encoding(raw.encoding),
    compression: raw.compression === undefined ? undefined : compression(raw.compression),
    script: raw.script === undefined ? undefined : boolean(raw.script),
  };
}
export function readWorkerCommand(value: unknown): ExportWorkerCommand {
  if (record(value).type !== 'cancel') throw new Error('未知的导出工作线程命令');
  return {type:'cancel'};
}
function progress(value: unknown): ExportProgress {
  const raw = record(value);
  return {
    phase: string(raw.phase), sessionId: optionalString(raw.sessionId), message: optionalString(raw.message),
    encoding: raw.encoding === undefined ? undefined : encoding(raw.encoding),
    compression: raw.compression === undefined ? undefined : compression(raw.compression),
    bytesRead: optionalNumber(raw.bytesRead), totalBytes: optionalNumber(raw.totalBytes),
    completed: optionalNumber(raw.completed), total: optionalNumber(raw.total), bytesWritten: optionalNumber(raw.bytesWritten),
  };
}
function result(value: unknown): ExportResult {
  const raw = record(value);
  return {
    path: string(raw.path), eventCount: number(raw.eventCount), capturedAt: string(raw.capturedAt),
    encoding: encoding(raw.encoding), compression: compression(raw.compression),
    bytes: number(raw.bytes), timelineBytes: number(raw.timelineBytes), sha256: string(raw.sha256),
    fileCount: number(raw.fileCount), blocks: optionalNumber(raw.blocks), deltaBlocks: optionalNumber(raw.deltaBlocks),
  };
}
export function readWorkerMessage(value: unknown): WorkerMessage {
  const raw = record(value);
  switch (raw.type) {
    case 'progress': return {type:'progress', progress: progress(raw.progress)};
    case 'result': return {type:'result', result: result(raw.result)};
    case 'error': {
      const error = record(raw.error);
      return {type:'error', error:{name:string(error.name), message:string(error.message), stack:optionalString(error.stack)}};
    }
    default: throw new Error('未知的导出工作线程消息');
  }
}
