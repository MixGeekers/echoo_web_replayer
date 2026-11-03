/** Network and console evidence captured through CDP while a recording is active. */
export type NetworkResourceType = "Document" | "XHR" | "Fetch";
export interface CapturedText {
  /** UTF-8 text, cut to the inline limit when `truncated` is true. */
  text: string;
  /** Size in UTF-8 bytes before truncation. */
  bytes: number;
  truncated: boolean;
}
interface NetworkBase {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  frameId?: string;
  documentURL?: string;
}
export interface NetworkRequestPayload extends NetworkBase {
  /** Wall-clock start of the request (UTC ISO). */
  startedAt: string;
  initiator?: string;
  redirectCount?: number;
  requestHeaders: Record<string, string>;
  headersTruncated?: boolean;
  postData?: CapturedText;
  postDataOmitted?: string;
}
export interface NetworkResponsePayload extends NetworkBase {
  status: number;
  statusText: string;
  mimeType: string;
  startedAt: string;
  durationMs: number | null;
  encodedDataLength?: number;
  protocol?: string;
  remoteAddress?: string;
  fromCache?: boolean;
  redirectTo?: string;
  timing?: Record<string, number>;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  headersTruncated?: boolean;
  body?: CapturedText;
  bodyOmitted?: string;
}
export interface NetworkFailedPayload extends NetworkBase {
  startedAt: string;
  durationMs: number | null;
  errorText: string;
  canceled: boolean;
  blockedReason?: string;
  status?: number;
}
export interface ConsoleFrame {
  functionName: string;
  url: string;
  line: number;
  column: number;
}
export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";
export interface ConsoleMessagePayload {
  level: ConsoleLevel;
  /** CDP console API name such as log, warning, error, assert, table. */
  method: string;
  text: string;
  textTruncated?: boolean;
  url?: string;
  line?: number;
  column?: number;
  stack?: ConsoleFrame[];
}
export interface ConsoleExceptionPayload {
  level: "error";
  text: string;
  textTruncated?: boolean;
  /** Short CDP prefix, e.g. "Uncaught" or "Uncaught (in promise)". */
  kind: string;
  url?: string;
  line?: number;
  column?: number;
  /** Error stack string reported by the page, size-capped. */
  stackText?: string;
  stack?: ConsoleFrame[];
}
export interface NetworkPayloadMap {
  "network.request": NetworkRequestPayload;
  "network.response": NetworkResponsePayload;
  "network.failed": NetworkFailedPayload;
  "console.message": ConsoleMessagePayload;
  "console.exception": ConsoleExceptionPayload;
}
export type NetworkEventType = keyof NetworkPayloadMap;
