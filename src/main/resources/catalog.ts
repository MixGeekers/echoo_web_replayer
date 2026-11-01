import fs from "node:fs/promises";
import path from "node:path";
import type { SessionStore } from "../storage/session-store";
import type {
  ResourceRecord,
  ResourceSummary,
} from "../../shared/contracts/resources";
import { errorCode, object } from "../../shared/runtime";

/** Bounded disk catalog; independent of browser capture and its lifetime. */
export class ResourceCatalog {
  private readonly catalogs = new Map<
    string,
    { size: number; entries: ResourceRecord[] }
  >();
  private readonly misses = new Map<string, Set<string>>();
  constructor(private readonly store: SessionStore) {}
  invalidate(id: string): void {
    this.catalogs.delete(id);
    this.misses.delete(id);
  }
  has(id: string): boolean {
    return this.catalogs.has(id);
  }
  missing(id: string, url: string): void {
    let misses = this.misses.get(id);
    if (!misses) {
      misses = new Set();
      this.misses.set(id, misses);
    }
    if (misses.size < 5000) misses.add(url);
  }
  found(id: string, url: string): void {
    this.misses.get(id)?.delete(url);
  }
  async read(id: string): Promise<ResourceRecord[]> {
    const directory = this.store.getSessionDirectory(id);
    this.store.getSession(id);
    const filename = path.join(directory, "resources.jsonl");
    const size = await fs.stat(filename).then(
      (stat) => stat.size,
      (error: unknown) => {
        if (errorCode(error) === "ENOENT") return 0;
        throw error;
      },
    );
    this.store.getSession(id);
    const cached = this.catalogs.get(id);
    if (cached?.size === size) return cached.entries;
    if (size > 32 * 1024 * 1024) throw new Error("静态资源索引超过读取上限");
    const text = size ? await fs.readFile(filename, "utf8") : "";
    const entries = text
      .split("\n")
      .slice(0, -1)
      .filter(Boolean)
      .map((line) => readRecord(JSON.parse(line)));
    // A deletion can complete while filesystem reads are in flight. Never
    // repopulate a catalog invalidated by that deletion.
    this.store.getSession(id);
    if (this.catalogs.size >= 3) {
      const oldest = this.catalogs.keys().next().value;
      if (oldest !== undefined) this.catalogs.delete(oldest);
    }
    this.catalogs.set(id, { size, entries });
    return entries;
  }
  async summary(
    id: string,
    endSeq = Infinity,
    captureError: string | null = null,
  ): Promise<ResourceSummary> {
    const entries = (await this.read(id)).filter(
        (entry) => entry.seq <= endSeq,
      ),
      latest = new Map(entries.map((entry) => [entry.url, entry]));
    const missing = new Set(
      [...latest.values()]
        .filter((entry) => entry.status !== "saved")
        .map((entry) => entry.url),
    );
    for (const url of this.misses.get(id) || []) missing.add(url);
    const bytes = [
      ...new Map(
        entries
          .filter((entry) => entry.sha256)
          .map((entry) => [entry.sha256, entry.bytes || 0]),
      ).values(),
    ].reduce((sum, value) => sum + value, 0);
    return {
      available: entries.length > 0,
      saved: [...latest.values()].filter((entry) => entry.sha256).length,
      missing: missing.size,
      missingURLs: [...missing].slice(0, 30),
      bytes,
      captureError,
    };
  }
}
function readRecord(value: unknown): ResourceRecord {
  const data = object(value);
  if (
    typeof data.url !== "string" ||
    typeof data.seq !== "number" ||
    !Number.isSafeInteger(data.seq) ||
    (data.status !== "saved" && data.status !== "missing")
  )
    throw new Error("无效的静态资源索引");
  const result: ResourceRecord = {
    url: data.url,
    seq: data.seq,
    elapsedMs: typeof data.elapsedMs === "number" ? data.elapsedMs : 0,
    status: data.status,
  };
  for (const key of [
    "mimeType",
    "type",
    "capturedAt",
    "sha256",
    "error",
  ] as const)
    if (typeof data[key] === "string") result[key] = data[key];
  for (const key of ["statusCode", "bytes"] as const)
    if (typeof data[key] === "number") result[key] = data[key];
  return result;
}
