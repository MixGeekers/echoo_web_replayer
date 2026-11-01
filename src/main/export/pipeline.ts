import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import * as readline from "node:readline";
import type {
  PreparedExport,
  ExportResult,
  FileEntry,
  FileDigest,
} from "../../shared/contracts/export";
import { parseObject } from "../storage/values";
import { encodeTimeline, checkAbort, writeAll } from "./delta-codec";
import { validateOptions } from "./options";
import { agentReadme } from "./readme";
import { deriveFiles } from "./derived";
import { scanTimeline } from "../storage/parser";
import { makeArchive } from "./zip";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function hashFile(filename: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filename)) {
    checkAbort(signal);
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function runPreparedExport({
  capture,
  sessionId,
  destination,
  appVersion = "0.2.0",
  encoding = "delta",
  compression = "deflate",
  signal,
  onProgress,
}: PreparedExport): Promise<ExportResult> {
  validateOptions({ encoding, compression });
  checkAbort(signal);
  const { metadata } = capture;
  if (!Number.isSafeInteger(capture.byteLength) || capture.byteLength < 0)
    throw new Error("无效的导出截点");
  const outputPath = path.resolve(
    /\.zip$/i.test(destination) ? destination : `${destination}.zip`,
  );
  const parent = path.dirname(outputPath);
  await fsp.mkdir(parent, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(parent, ".tracedock-export-"));
  const temporaryZip = path.join(
    parent,
    `.${path.basename(outputPath)}.${randomUUID()}.tmp`,
  );
  let fileIndex: FileHandle | null = null,
    snapshotIndex: FileHandle | null = null;
  let fileCount = 0,
    physicalBytes = 0;
  const entrypoints: FileEntry[] = [];
  try {
    onProgress?.({
      phase: "prepare",
      bytesRead: 0,
      totalBytes: capture.byteLength,
    });
    fileIndex = await fsp.open(path.join(staging, "files.jsonl"), "wx");
    const recordFile = async (name: string, known?: FileDigest) => {
      checkAbort(signal);
      const digest =
        known ||
        (await hashFile(path.join(staging, ...name.split("/")), signal));
      const item = { path: name, bytes: digest.bytes, sha256: digest.sha256 };
      await writeAll(fileIndex!, Buffer.from(`${JSON.stringify(item)}\n`));
      fileCount++;
      physicalBytes += item.bytes;
      if (!name.startsWith("snapshots/") && !name.startsWith("assets/"))
        entrypoints.push(item);
      return item;
    };
    const writeText = async (name: string, value: string) => {
      await fsp.writeFile(path.join(staging, name), value, "utf8");
      return recordFile(name);
    };
    await writeText("session.json", json(metadata));
    await writeText(
      "AGENT_README.md",
      agentReadme(metadata, capture.capturedAt, appVersion, {
        encoding,
        compression,
      }),
    );
    await fsp.copyFile(
      path.join(__dirname, "restore.py"),
      path.join(staging, "restore.py"),
    );
    await recordFile("restore.py");
    if (capture.resourceBytes) {
      if (!capture.resourcePath) throw new Error("资源截点缺少索引路径");
      await pipeline(
        fs.createReadStream(capture.resourcePath, {
          start: 0,
          end: capture.resourceBytes - 1,
        }),
        fs.createWriteStream(path.join(staging, "resources.jsonl"), {
          flags: "wx",
        }),
        { signal },
      );
      await recordFile("resources.jsonl");
      await fsp.mkdir(path.join(staging, "assets"));
      const seen = new Set();
      const lines = readline.createInterface({
        input: fs.createReadStream(path.join(staging, "resources.jsonl")),
        crlfDelay: Infinity,
      });
      try {
        for await (const line of lines) {
          checkAbort(signal);
          if (!line) continue;
          const entry = parseObject(line);
          if (
            typeof entry.seq !== "number" ||
            !Number.isSafeInteger(entry.seq) ||
            entry.seq > metadata.lastSeq
          )
            throw new Error("资源记录超出导出截点");
          if (!entry.sha256 || seen.has(entry.sha256)) continue;
          if (
            typeof entry.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(entry.sha256)
          )
            throw new Error("无效的资源路径");
          seen.add(entry.sha256);
          const name = `assets/${entry.sha256}`;
          await fsp.copyFile(
            path.join(path.dirname(capture.timelinePath), name),
            path.join(staging, name),
          );
          const digest = await recordFile(name);
          if (digest.sha256 !== entry.sha256 || digest.bytes !== entry.bytes)
            throw new Error("静态资源校验失败");
        }
      } finally {
        lines.close();
      }
    }
    let timeline: FileEntry,
      eventCount: number,
      delta:
        | Awaited<ReturnType<typeof encodeTimeline>>["parameters"]
        | undefined,
      deltaBlocks: number | undefined;
    if (encoding === "delta") {
      const result = await encodeTimeline({
        timelinePath: capture.timelinePath,
        byteLength: capture.byteLength,
        dataPath: path.join(staging, "data.bin"),
        indexPath: path.join(staging, "index.jsonl"),
        compression,
        signal,
        onProgress,
      });
      eventCount = result.eventCount;
      delta = result.parameters;
      deltaBlocks = result.deltaBlocks;
      timeline = {
        path: "timeline.jsonl",
        bytes: result.bytes,
        sha256: result.sha256,
      };
      await recordFile("data.bin", result.data);
      await recordFile("index.jsonl", result.index);
      const actual = {
        eventCount: 0,
        actionCount: 0,
        mutationCount: 0,
        snapshotCount: 0,
        lastSeq: 0,
      };
      onProgress?.({
        phase: "validate",
        bytesRead: 0,
        totalBytes: capture.byteLength,
      });
      for await (const { event } of scanTimeline(capture.timelinePath, {
        byteLength: capture.byteLength,
        signal,
        onProgress: (progress) =>
          onProgress?.({ phase: "validate", ...progress }),
      })) {
        checkAbort(signal);
        if (
          !Number.isSafeInteger(event.seq) ||
          event.seq <= actual.lastSeq ||
          typeof event.type !== "string"
        )
          throw new Error("时间线事件序号或类型无效");
        actual.eventCount++;
        actual.lastSeq = event.seq;
        actual.actionCount += Number(event.type.startsWith("action."));
        actual.mutationCount += Number(event.type === "dom.mutation");
        actual.snapshotCount += Number(event.type === "dom.snapshot");
      }
      for (const key of Object.keys(actual) as (keyof typeof actual)[])
        if (actual[key] !== metadata[key])
          throw new Error(
            `时间线${key === "eventCount" ? "事件数量" : key}与导出截点不一致`,
          );
    } else {
      const timelinePath = path.join(staging, "timeline.jsonl");
      const digest = createHash("sha256");
      let bytes = 0;
      if (!capture.byteLength) await fsp.writeFile(timelinePath, "");
      else
        await pipeline(
          fs.createReadStream(capture.timelinePath, {
            start: 0,
            end: capture.byteLength - 1,
          }),
          async function* (chunks) {
            for await (const chunk of chunks) {
              checkAbort(signal);
              digest.update(chunk);
              bytes += chunk.length;
              onProgress?.({
                phase: "encode",
                bytesRead: bytes,
                totalBytes: capture.byteLength,
              });
              yield chunk;
            }
          },
          fs.createWriteStream(timelinePath, { flags: "wx" }),
          { signal },
        );
      if (bytes !== capture.byteLength)
        throw new Error("时间线在导出截点之前被截断");
      timeline = {
        path: "timeline.jsonl",
        bytes,
        sha256: digest.digest("hex"),
      };
      await recordFile("timeline.jsonl", timeline);
      snapshotIndex = await fsp.open(
        path.join(staging, "snapshots.jsonl"),
        "wx",
      );
      const result = await deriveFiles({
        timelinePath,
        byteLength: bytes,
        staging,
        metadata,
        capturedAt: capture.capturedAt,
        signal,
        onFile: (item) =>
          recordFile(item.path, item.bytes !== undefined ? item : undefined),
        onSnapshot: (item) =>
          writeAll(snapshotIndex!, Buffer.from(`${JSON.stringify(item)}\n`)),
        onProgress,
      });
      eventCount = result.eventCount;
      for (const key of [
        "lastSeq",
        "actionCount",
        "mutationCount",
        "snapshotCount",
      ] as const) {
        if (result[key] !== metadata[key])
          throw new Error(`时间线${key}与导出截点不一致`);
      }
      await snapshotIndex.close();
      snapshotIndex = null;
      await recordFile("snapshots.jsonl");
    }
    if (eventCount !== metadata.eventCount)
      throw new Error("时间线事件数量与导出截点不一致，未生成导出包");
    await fileIndex.close();
    fileIndex = null;
    const indexDigest = await hashFile(
      path.join(staging, "files.jsonl"),
      signal,
    );
    entrypoints.push({ path: "files.jsonl", ...indexDigest });
    physicalBytes += indexDigest.bytes;
    fileCount++;
    const manifest = {
      format: "tracedock-session",
      schemaVersion: 2,
      appVersion,
      encoding,
      compression,
      sessionId,
      exportedAt: capture.capturedAt,
      startedAt: metadata.startedAt,
      status: metadata.status,
      eventCount,
      actionCount: metadata.actionCount,
      mutationCount: metadata.mutationCount,
      snapshotCount: metadata.snapshotCount,
      lastSeq: metadata.lastSeq,
      timelineBytes: capture.byteLength,
      timeline,
      ordering: "seq (main-process persistence order)",
      redaction: false,
      counts: {
        events: eventCount,
        actions: metadata.actionCount,
        mutationBatches: metadata.mutationCount,
        snapshots: metadata.snapshotCount,
      },
      files: entrypoints,
      fileIndex: "files.jsonl",
      checksumAlgorithm: "sha256",
      checksumExcludes: ["manifest.json"],
      ...(encoding === "delta"
        ? { delta, derived: ["timeline.md", "snapshots/", "snapshots.jsonl"] }
        : { snapshotIndex: "snapshots.jsonl" }),
    };
    const manifestText = json(manifest);
    await fsp.writeFile(
      path.join(staging, "manifest.json"),
      manifestText,
      "utf8",
    );
    physicalBytes += Buffer.byteLength(manifestText);
    fileCount++;
    async function* entries() {
      const lines = readline.createInterface({
        input: fs.createReadStream(path.join(staging, "files.jsonl")),
        crlfDelay: Infinity,
      });
      try {
        for await (const line of lines) {
          checkAbort(signal);
          const item = parseObject(line);
          if (typeof item.path !== "string") throw new Error("无效文件清单");
          yield {
            name: item.path,
            path: path.join(staging, ...item.path.split("/")),
          };
        }
        yield { name: "files.jsonl", path: path.join(staging, "files.jsonl") };
        yield {
          name: "manifest.json",
          path: path.join(staging, "manifest.json"),
        };
      } finally {
        lines.close();
      }
    }
    const archive = await makeArchive({
      entries: entries(),
      destination: temporaryZip,
      compression,
      signal,
      onProgress: (progress) =>
        onProgress?.({
          ...progress,
          totalBytes: physicalBytes,
          total: fileCount,
        }),
    });
    checkAbort(signal);
    await fsp.rename(temporaryZip, outputPath);
    onProgress?.({
      phase: "complete",
      bytesRead: capture.byteLength,
      totalBytes: capture.byteLength,
      completed: fileCount,
      total: fileCount,
    });
    return {
      path: outputPath,
      eventCount,
      capturedAt: capture.capturedAt,
      encoding,
      compression,
      bytes: archive.bytes,
      timelineBytes: capture.byteLength,
      sha256: timeline.sha256,
      fileCount,
      ...(delta ? { blocks: delta.blocks, deltaBlocks } : {}),
    };
  } finally {
    await Promise.allSettled(
      [fileIndex?.close(), snapshotIndex?.close()].filter(Boolean),
    );
    await fsp.rm(temporaryZip, { force: true }).catch(() => {});
    // Both targets were created under the explicitly chosen export parent.
    if (
      path.dirname(staging) === parent &&
      path.basename(staging).startsWith(".tracedock-export-")
    ) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}
