import type { TimelinePage, TimelineQuery, EventPreview } from "../../shared/contracts/storage";
import { MCPToolError } from "./operations";

/** Arguments accepted by tracedock_network (already schema-validated). */
export interface NetworkQueryInput {
  type?: string;
  statusMin?: number;
  statusMax?: number;
  url?: string;
  level?: string;
  afterSeq?: number;
  snapshotSeq?: number;
  limit?: number;
  maxBytes?: number;
}
export const NETWORK_QUERY_TYPES: Record<string, string[]> = {
  all: ["network", "console"],
  network: ["network"],
  request: ["network.request"],
  response: ["network.response"],
  failed: ["network.failed"],
  console: ["console"],
  message: ["console.message"],
  exception: ["console.exception"],
};
const PAGE = 500,
  MAX_SCANNED_PAGES = 20;
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Compact, Agent-oriented view of one network / console event. */
export function networkItem(event: EventPreview): Record<string, unknown> {
  const p = obj(event.payload),
    item: Record<string, unknown> = { seq: event.seq };
  for (const [key, value] of [["id", event.id], ["pageId", event.pageId], ["type", event.type], ["timestamp", event.timestamp], ["summary", event.summary]] as const)
    if (value !== undefined) item[key] = value;
  for (const key of ["requestId", "method", "url", "resourceType", "status", "statusText", "mimeType", "durationMs", "errorText", "canceled", "redirectTo", "level", "kind", "text", "line", "column", "bodyOmitted"])
    if (p[key] !== undefined && p[key] !== null) item[key] = p[key];
  const body = obj(p.body);
  if (typeof body.bytes === "number") item.bodyBytes = body.bytes;
  if (body.truncated === true) item.bodyTruncated = true;
  if (event.payloadTruncated) item.previewTruncated = true;
  return item;
}
export function matchesNetworkFilter(item: Record<string, unknown>, q: NetworkQueryInput): boolean {
  if (q.statusMin !== undefined || q.statusMax !== undefined) {
    if (typeof item.status !== "number") return false;
    if (q.statusMin !== undefined && item.status < q.statusMin) return false;
    if (q.statusMax !== undefined && item.status > q.statusMax) return false;
  }
  if (q.url && !String(item.url ?? "").toLowerCase().includes(q.url.toLowerCase())) return false;
  if (q.level && item.level !== q.level) return false;
  return true;
}

/**
 * Scan a recording's network / console events in seq order, filtering by status
 * range, URL substring, event kind and console level. Bounded per call; continue
 * with nextAfterSeq and the returned snapshotSeq.
 */
export async function queryNetworkEvents(
  read: (query: Omit<TimelineQuery, "sessionId">) => Promise<TimelinePage>,
  q: NetworkQueryInput,
) {
  const types = NETWORK_QUERY_TYPES[q.type ?? "all"] ?? NETWORK_QUERY_TYPES.all!,
    limit = Math.min(200, Math.max(1, q.limit ?? 50)),
    maxBytes = q.maxBytes ?? 65536;
  let afterSeq = q.afterSeq ?? 0,
    snapshotSeq = q.snapshotSeq,
    hasMore = true,
    pages = 0;
  const items: Record<string, unknown>[] = [];
  let lastSeq = afterSeq;
  while (hasMore && items.length < limit && pages++ < MAX_SCANNED_PAGES) {
    const page = await read({
      afterSeq,
      limit: PAGE,
      types,
      ...(snapshotSeq !== undefined ? { snapshotSeq } : {}),
      ...(q.url ? { query: q.url } : {}),
    });
    snapshotSeq ??= page.snapshotSeq;
    hasMore = page.hasMore;
    for (const event of page.events) {
      lastSeq = event.seq;
      const item = networkItem(event);
      if (matchesNetworkFilter(item, q)) items.push(item);
      if (items.length >= limit) {
        hasMore = hasMore || event !== page.events.at(-1);
        break;
      }
    }
    if (items.length < limit) lastSeq = Math.max(lastSeq, page.scannedThroughSeq ?? lastSeq);
    afterSeq = lastSeq;
    if (!page.events.length && !page.hasMore) break;
  }
  let truncated = false;
  while (items.length && Buffer.byteLength(JSON.stringify(items)) > maxBytes) {
    items.pop();
    truncated = true;
  }
  if (truncated && !items.length)
    throw new MCPToolError("RESULT_TOO_LARGE", "单条网络事件摘要超过字节预算，请增大 maxBytes");
  if (truncated) lastSeq = Number(items.at(-1)?.seq ?? q.afterSeq ?? 0);
  const more = hasMore || truncated;
  return {
    items,
    count: items.length,
    snapshotSeq: snapshotSeq ?? null,
    scannedThroughSeq: lastSeq,
    hasMore: more,
    truncated,
    nextAfterSeq: more ? lastSeq : null,
  };
}
