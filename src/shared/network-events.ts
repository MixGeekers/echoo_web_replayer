/**
 * Pure shaping, size caps and summaries for network / console timeline events.
 * Shared by main-process capture, export Markdown and the renderer; no Node or
 * Electron APIs so it runs in every bundle.
 */
import type {
  CapturedText,
  ConsoleExceptionPayload,
  ConsoleFrame,
  ConsoleLevel,
  ConsoleMessagePayload,
  NetworkFailedPayload,
  NetworkRequestPayload,
  NetworkResponsePayload,
} from "./contracts/network";

export const NETWORK_LIMITS = Object.freeze({
  /** Inline response body kept in the event payload. */
  bodyBytes: 512 * 1024,
  /** Response bodies whose transfer size exceeds this are not read at all. */
  readBodyBytes: 8 * 1024 * 1024,
  /** Response body budget for one recording; later bodies are omitted with a reason. */
  sessionBodyBytes: 64 * 1024 * 1024,
  postDataBytes: 256 * 1024,
  headerValueBytes: 4096,
  headersBytes: 32 * 1024,
  consoleTextBytes: 16 * 1024,
  stackTextBytes: 16 * 1024,
  stackFrames: 20,
  consoleArgs: 50,
});
export const TRACKED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "Document",
  "XHR",
  "Fetch",
]);

type Raw = Record<string, unknown>;
const obj = (value: unknown): Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : {};
const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const encoder = new TextEncoder();
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}
/** Cut text to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function capText(text: string, maxBytes: number): CapturedText {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes)
    return { text, bytes: bytes.length, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    bytes: bytes.length,
    truncated: true,
  };
}
function capString(text: string, maxBytes: number): [string, boolean] {
  const captured = capText(text, maxBytes);
  return [captured.text, captured.truncated];
}

/** Normalize and size-cap a CDP header map. */
export function capHeaders(value: unknown): {
  headers: Record<string, string>;
  truncated: boolean;
} {
  const headers: Record<string, string> = {};
  let used = 0,
    truncated = false;
  for (const [name, raw] of Object.entries(obj(value))) {
    const [text, cut] = capString(
      Array.isArray(raw) ? raw.map(String).join(", ") : String(raw ?? ""),
      NETWORK_LIMITS.headerValueBytes,
    );
    const size = utf8Bytes(name) + utf8Bytes(text);
    if (used + size > NETWORK_LIMITS.headersBytes) {
      truncated = true;
      break;
    }
    used += size;
    truncated ||= cut;
    Object.defineProperty(headers, name, {
      value: text,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { headers, truncated };
}

/** JSON, text, XML, HTML, JavaScript and form bodies are stored; others are skipped. */
export function isTextMime(mimeType: string): boolean {
  const mime = mimeType.toLowerCase().split(";")[0]!.trim();
  if (!mime) return false;
  if (mime.startsWith("text/")) return true;
  if (/[+/](json|xml)$/.test(mime) || mime.endsWith("+json")) return true;
  return [
    "application/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "application/x-www-form-urlencoded",
    "application/graphql",
    "application/ld+json",
    "application/x-ndjson",
    "application/xhtml+xml",
  ].includes(mime);
}

function decodeBase64(value: string): string {
  const binary = atob(value),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
/** Turn a Network.getResponseBody result into a capped text body or an omission reason. */
export function captureBody(
  response: unknown,
  mimeType: string,
  maxBytes: number = NETWORK_LIMITS.bodyBytes,
): { body: CapturedText } | { bodyOmitted: string } {
  if (!isTextMime(mimeType))
    return { bodyOmitted: `非文本响应（${mimeType || "未知类型"}），未保存正文` };
  const raw = obj(response);
  if (typeof raw.body !== "string") return { bodyOmitted: "无效的响应正文" };
  let text: string;
  try {
    text = raw.base64Encoded === true ? decodeBase64(raw.body) : raw.body;
  } catch {
    return { bodyOmitted: "响应正文无法解码" };
  }
  return { body: capText(text, maxBytes) };
}

export function shortUrl(url: string, documentURL?: string): string {
  let text = url;
  try {
    const target = new URL(url);
    if (target.protocol === "http:" || target.protocol === "https:") {
      let sameOrigin = false;
      try {
        sameOrigin = !!documentURL && new URL(documentURL).origin === target.origin;
      } catch {}
      text = `${sameOrigin ? "" : target.host}${target.pathname}${target.search}`;
    } else if (target.protocol === "data:") text = "data:…";
  } catch {}
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const isoFromSeconds = (seconds: number | undefined) =>
  new Date(
    seconds !== undefined ? Math.round(seconds * 1000) : Date.now(),
  ).toISOString();

/** Request metadata from Network.requestWillBeSent. */
export function shapeRequest(
  params: unknown,
  redirectCount = 0,
): NetworkRequestPayload | null {
  const p = obj(params),
    request = obj(p.request);
  if (typeof p.requestId !== "string" || typeof request.url !== "string")
    return null;
  const { headers, truncated } = capHeaders(request.headers);
  const payload: NetworkRequestPayload = {
    requestId: p.requestId,
    url: request.url + str(request.urlFragment),
    method: str(request.method, "GET"),
    resourceType: str(p.type, "Other"),
    startedAt: isoFromSeconds(num(p.wallTime)),
    requestHeaders: headers,
  };
  if (typeof p.frameId === "string") payload.frameId = p.frameId;
  if (typeof p.documentURL === "string") payload.documentURL = p.documentURL;
  const initiator = obj(p.initiator);
  if (typeof initiator.type === "string") payload.initiator = initiator.type;
  if (redirectCount) payload.redirectCount = redirectCount;
  if (truncated) payload.headersTruncated = true;
  if (typeof request.postData === "string")
    payload.postData = capText(request.postData, NETWORK_LIMITS.postDataBytes);
  else if (request.hasPostData === true)
    payload.postDataOmitted = "请求体未随事件提供";
  return payload;
}

/** Response payload combining the request, Network.responseReceived and its body. */
export function shapeResponse(
  request: NetworkRequestPayload,
  responseParams: unknown,
  durationMs: number | null,
  encodedDataLength?: number,
): NetworkResponsePayload {
  const response = obj(obj(responseParams).response ?? responseParams);
  const { headers, truncated } = capHeaders(response.headers);
  const timing: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj(response.timing)))
    if (typeof value === "number" && Number.isFinite(value)) timing[key] = value;
  const payload: NetworkResponsePayload = {
    requestId: request.requestId,
    url: str(response.url, request.url),
    method: request.method,
    resourceType: str(obj(responseParams).type, request.resourceType),
    status: num(response.status) ?? 0,
    statusText: str(response.statusText),
    mimeType: str(response.mimeType),
    startedAt: request.startedAt,
    durationMs: durationMs === null ? null : Math.round(durationMs * 10) / 10,
    requestHeaders: request.requestHeaders,
    responseHeaders: headers,
  };
  if (request.frameId) payload.frameId = request.frameId;
  if (request.documentURL) payload.documentURL = request.documentURL;
  const encoded = encodedDataLength ?? num(response.encodedDataLength);
  if (encoded !== undefined) payload.encodedDataLength = encoded;
  if (typeof response.protocol === "string") payload.protocol = response.protocol;
  if (typeof response.remoteIPAddress === "string")
    payload.remoteAddress = `${response.remoteIPAddress}${typeof response.remotePort === "number" ? `:${response.remotePort}` : ""}`;
  if (response.fromDiskCache === true || response.fromServiceWorker === true || response.fromPrefetchCache === true)
    payload.fromCache = true;
  if (Object.keys(timing).length) payload.timing = timing;
  if (truncated || request.headersTruncated) payload.headersTruncated = true;
  return payload;
}

export function shapeFailed(
  request: NetworkRequestPayload,
  params: unknown,
  durationMs: number | null,
  status?: number,
): NetworkFailedPayload {
  const p = obj(params);
  const payload: NetworkFailedPayload = {
    requestId: request.requestId,
    url: request.url,
    method: request.method,
    resourceType: str(p.type, request.resourceType),
    startedAt: request.startedAt,
    durationMs: durationMs === null ? null : Math.round(durationMs * 10) / 10,
    errorText: str(p.errorText, "请求失败"),
    canceled: p.canceled === true,
  };
  if (request.frameId) payload.frameId = request.frameId;
  if (request.documentURL) payload.documentURL = request.documentURL;
  if (typeof p.blockedReason === "string") payload.blockedReason = p.blockedReason;
  if (status !== undefined) payload.status = status;
  return payload;
}

export function consoleLevel(type: string): ConsoleLevel {
  if (type === "error" || type === "assert") return "error";
  if (type === "warning" || type === "warn") return "warn";
  if (type === "info") return "info";
  if (type === "debug") return "debug";
  return "log";
}

/** Render one CDP RemoteObject the way DevTools prints it inline. */
export function formatRemoteObject(value: unknown): string {
  const o = obj(value);
  if (typeof o.unserializableValue === "string") return o.unserializableValue;
  if (o.type === "undefined") return "undefined";
  if (o.type === "string") return str(o.value);
  if (o.subtype === "null") return "null";
  if (o.type === "number" || o.type === "boolean" || o.type === "bigint")
    return o.value !== undefined ? String(o.value) : str(o.description);
  if (o.type === "symbol" || o.type === "function") return str(o.description, String(o.type));
  if (o.subtype === "error") return str(o.description, "Error");
  const preview = obj(o.preview);
  if (Array.isArray(preview.properties)) {
    const items = preview.properties.map((raw) => {
      const p = obj(raw),
        shown = p.type === "string" ? JSON.stringify(str(p.value)) : str(p.value, str(p.type));
      return preview.subtype === "array" || o.subtype === "array" ? shown : `${str(p.name)}: ${shown}`;
    });
    const more = preview.overflow === true ? ", …" : "";
    return o.subtype === "array"
      ? `[${items.join(", ")}${more}]`
      : `${o.className && o.className !== "Object" ? `${str(o.className)} ` : ""}{${items.join(", ")}${more}}`;
  }
  if (o.value !== undefined) {
    try {
      return JSON.stringify(o.value);
    } catch {}
  }
  return str(o.description, str(o.type, ""));
}

/** Join console arguments, applying %s/%d/%i/%f/%o/%O/%c substitution on a leading format string. */
export function formatConsoleArgs(args: unknown): string {
  const list = Array.isArray(args) ? args.slice(0, NETWORK_LIMITS.consoleArgs) : [];
  if (!list.length) return "";
  const first = obj(list[0]);
  let rest = list.slice(1),
    head = "";
  if (first.type === "string" && /%[sdifoOc%]/.test(str(first.value))) {
    head = str(first.value).replace(/%([sdifoOc%])/g, (match, code: string) => {
      if (code === "%") return "%";
      if (!rest.length) return match;
      const next = rest.shift();
      if (code === "c") return "";
      const text = formatRemoteObject(next);
      if (code === "d" || code === "i") {
        const n = Number(obj(next).value ?? text);
        return Number.isFinite(n) ? String(Math.trunc(n)) : "NaN";
      }
      if (code === "f") return String(Number(obj(next).value ?? text));
      return text;
    });
  } else {
    head = formatRemoteObject(first);
  }
  return [head, ...rest.map(formatRemoteObject)].join(" ");
}

export function stackFrames(stackTrace: unknown): ConsoleFrame[] {
  const frames = obj(stackTrace).callFrames;
  if (!Array.isArray(frames)) return [];
  return frames.slice(0, NETWORK_LIMITS.stackFrames).map((raw) => {
    const f = obj(raw);
    return {
      functionName: str(f.functionName).slice(0, 200),
      url: str(f.url).slice(0, 2048),
      line: (num(f.lineNumber) ?? -1) + 1,
      column: (num(f.columnNumber) ?? -1) + 1,
    };
  });
}

/** Runtime.consoleAPICalled → console.message payload. */
export function shapeConsole(params: unknown): ConsoleMessagePayload {
  const p = obj(params),
    method = str(p.type, "log");
  let [text, truncated] = capString(
    formatConsoleArgs(p.args),
    NETWORK_LIMITS.consoleTextBytes,
  );
  if (method === "assert" && !text) text = "Assertion failed";
  else if (method === "assert") text = `Assertion failed: ${text}`;
  const stack = stackFrames(p.stackTrace);
  const payload: ConsoleMessagePayload = { level: consoleLevel(method), method, text };
  if (truncated) payload.textTruncated = true;
  const top = stack[0];
  if (top) {
    if (top.url) payload.url = top.url;
    payload.line = top.line;
    payload.column = top.column;
    payload.stack = stack;
  }
  return payload;
}

/** Runtime.exceptionThrown → console.exception payload. */
export function shapeException(params: unknown): ConsoleExceptionPayload {
  const details = obj(obj(params).exceptionDetails),
    exception = obj(details.exception);
  const description =
    exception.subtype === "error" || typeof exception.description === "string"
      ? str(exception.description)
      : "";
  const base = description || formatRemoteObject(exception) || str(details.text, "Uncaught");
  const firstLine = base.split("\n")[0] ?? base;
  const kind = str(details.text, "Uncaught").replace(/\s+$/, "");
  const [text, truncated] = capString(
    exception.subtype === "error" || !description ? firstLine : base,
    NETWORK_LIMITS.consoleTextBytes,
  );
  const payload: ConsoleExceptionPayload = { level: "error", kind, text };
  if (truncated) payload.textTruncated = true;
  const stack = stackFrames(details.stackTrace);
  const url = str(details.url) || stack[0]?.url || "";
  if (url) payload.url = url;
  if (typeof details.lineNumber === "number") {
    payload.line = details.lineNumber + 1;
    payload.column = (num(details.columnNumber) ?? -1) + 1;
  } else if (stack[0]) {
    payload.line = stack[0].line;
    payload.column = stack[0].column;
  }
  if (description.includes("\n"))
    payload.stackText = capString(description, NETWORK_LIMITS.stackTextBytes)[0];
  if (stack.length) payload.stack = stack;
  return payload;
}

const location = (p: { url?: string | undefined; line?: number | undefined }) =>
  p.url ? ` · ${shortUrl(p.url)}${p.line ? `:${p.line}` : ""}` : "";
const oneLine = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One-line summaries stored with the event (UI list, timeline.md, MCP). */
export function networkSummary(type: string, payload: unknown): string {
  const p = obj(payload);
  const url = shortUrl(str(p.url), str(p.documentURL) || undefined);
  if (type === "network.request") return `${str(p.method, "GET")} ${url}`;
  if (type === "network.response") {
    const duration = formatDuration(num(p.durationMs));
    return `${str(p.method, "GET")} ${num(p.status) ?? 0} ${url}${duration ? ` ${duration}` : ""}`;
  }
  if (type === "network.failed") {
    const duration = formatDuration(num(p.durationMs));
    return `${str(p.method, "GET")} 失败 ${url} · ${str(p.errorText)}${duration ? ` ${duration}` : ""}`;
  }
  if (type === "console.message")
    return `[${str(p.level, "log")}] ${oneLine(str(p.text))}${location(p as { url?: string; line?: number })}`;
  if (type === "console.exception")
    return `${str(p.kind, "Uncaught")} ${oneLine(str(p.text))}${location(p as { url?: string; line?: number })}`;
  return type;
}

/**
 * Whether a stored event is a failed request (HTTP >= 400 or network failure) or
 * an uncaught page error. Works from type + summary only so streaming export can
 * classify events without parsing payloads.
 */
export function isIssueEvent(type: unknown, summary: unknown): boolean {
  if (type === "network.failed" || type === "console.exception") return true;
  if (type !== "network.response") return false;
  const match = /^\S+ (\d{3})\b/.exec(String(summary ?? ""));
  return !!match && Number(match[1]) >= 400;
}
/** Console errors are highlighted in the UI but are not listed as failures in exports. */
export function isErrorEvent(type: unknown, summary: unknown): boolean {
  return (
    isIssueEvent(type, summary) ||
    (type === "console.message" && String(summary ?? "").startsWith("[error]"))
  );
}

function headerBlock(title: string, headers: unknown): string {
  const entries = Object.entries(obj(headers));
  return `── ${title}（${entries.length}）──\n${entries.length ? entries.map(([k, v]) => `${k}: ${String(v)}`).join("\n") : "（无）"}`;
}
function bodyBlock(title: string, body: unknown, omitted: unknown): string {
  const b = obj(body);
  if (typeof b.text !== "string")
    return `── ${title} ──\n${typeof omitted === "string" ? omitted : "（无）"}`;
  let text = b.text;
  if (!b.truncated) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
  }
  const size = typeof b.bytes === "number" ? `${b.bytes.toLocaleString()} 字节` : "";
  return `── ${title}（${size}${b.truncated ? "，已截断" : ""}）──\n${text || "（空）"}`;
}
function frameBlock(stack: unknown): string {
  if (!Array.isArray(stack) || !stack.length) return "";
  return `\n\n── 调用栈 ──\n${stack
    .map((raw) => {
      const f = obj(raw);
      return `  at ${str(f.functionName) || "(anonymous)"} (${str(f.url) || "?"}:${String(f.line ?? "?")}:${String(f.column ?? "?")})`;
    })
    .join("\n")}`;
}

/** Human-readable detail text for the event panel; null for other event types. */
export function formatNetworkDetail(type: string, payload: unknown): string | null {
  const p = obj(payload);
  if (type === "network.request" || type === "network.response" || type === "network.failed") {
    const lines = [
      `${str(p.method, "GET")} ${type === "network.response" ? `${num(p.status) ?? ""} ${str(p.statusText)}`.trim() + " " : type === "network.failed" ? "失败 " : ""}${str(p.url)}`,
      [
        str(p.resourceType),
        str(p.mimeType),
        num(p.durationMs) !== undefined ? `耗时 ${formatDuration(num(p.durationMs))}` : "",
        num(p.encodedDataLength) !== undefined ? `传输 ${num(p.encodedDataLength)!.toLocaleString()} 字节` : "",
        str(p.protocol),
        p.fromCache === true ? "缓存" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      `请求 ID：${str(p.requestId)} · 开始：${str(p.startedAt)}`,
    ];
    if (type === "network.failed")
      lines.push(`错误：${str(p.errorText)}${p.canceled === true ? "（已取消）" : ""}${p.blockedReason ? ` · ${str(p.blockedReason)}` : ""}`);
    const blocks = [lines.filter(Boolean).join("\n")];
    if (p.requestHeaders !== undefined) blocks.push(headerBlock("请求头", p.requestHeaders));
    if (type === "network.request")
      blocks.push(bodyBlock("请求体", p.postData, p.postDataOmitted));
    if (type === "network.response") {
      blocks.push(headerBlock("响应头", p.responseHeaders));
      blocks.push(bodyBlock("响应体", p.body, p.bodyOmitted));
    }
    if (p.headersTruncated === true) blocks.push("部分请求头或响应头超过保存上限，已截断。");
    return blocks.join("\n\n");
  }
  if (type === "console.message" || type === "console.exception") {
    const head = type === "console.exception"
      ? `${str(p.kind, "Uncaught")} · ${str(p.level, "error")}`
      : `console.${str(p.method, "log")} · ${str(p.level, "log")}`;
    const where = p.url ? `\n来源：${str(p.url)}${p.line ? `:${String(p.line)}:${String(p.column ?? "")}` : ""}` : "";
    const stackText = typeof p.stackText === "string" ? `\n\n── 错误堆栈 ──\n${p.stackText}` : "";
    return `${head}${where}\n\n${str(p.text)}${p.textTruncated === true ? "\n…（消息已截断）" : ""}${stackText}${stackText ? "" : frameBlock(p.stack)}`;
  }
  return null;
}
