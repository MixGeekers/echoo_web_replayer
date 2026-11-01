import type { FileHandle } from "node:fs/promises";
import type {
  ExportSignals,
  ExportCompression,
} from "../../shared/contracts/export";
import { errorOf } from "../storage/values";

// ZIP64 writer with a disk-spooled central directory. Memory use is bounded by
// the active input/compressor buffers, not the archive size or entry count.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { Writable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}
function crc32(previous: number, bytes: Buffer) {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++)
    value = CRC_TABLE[(value ^ bytes[i]!) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function checkAbort(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = errorOf(new Error("导出已取消"));
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}
function nameBytes(name: string) {
  if (
    typeof name !== "string" ||
    !name ||
    /[\\\0:]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("ZIP 条目必须是合法的包内相对文件路径");
  }
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length > 65535) throw new Error("ZIP 条目名称过长");
  return bytes;
}
function dosTime(date: Date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
const flags = 0x0800; // UTF-8 names; local sizes are patched on our seekable file.
function localHeader(
  name: Buffer,
  method: number,
  stamp: ReturnType<typeof dosTime>,
) {
  const header = Buffer.alloc(30 + name.length + 20);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(45, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(0xffffffff, 18);
  header.writeUInt32LE(0xffffffff, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(20, 28);
  name.copy(header, 30);
  const extra = 30 + name.length;
  header.writeUInt16LE(1, extra);
  header.writeUInt16LE(16, extra + 2);
  // Sizes are patched after streaming the entry; no data descriptor is needed.
  return header;
}
function centralHeader(
  name: Buffer,
  method: number,
  stamp: ReturnType<typeof dosTime>,
  crc: number,
  compressed: number,
  raw: number,
  offset: number,
) {
  const header = Buffer.alloc(46 + name.length + 28);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(45, 4);
  header.writeUInt16LE(45, 6);
  header.writeUInt16LE(flags, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(stamp.time, 12);
  header.writeUInt16LE(stamp.date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(0xffffffff, 20);
  header.writeUInt32LE(0xffffffff, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(28, 30);
  header.writeUInt32LE(0xffffffff, 42);
  name.copy(header, 46);
  const extra = 46 + name.length;
  header.writeUInt16LE(1, extra);
  header.writeUInt16LE(24, extra + 2);
  header.writeBigUInt64LE(BigInt(raw), extra + 4);
  header.writeBigUInt64LE(BigInt(compressed), extra + 12);
  header.writeBigUInt64LE(BigInt(offset), extra + 20);
  return header;
}
function endRecords(
  count: number,
  centralBytes: number,
  centralOffset: number,
  endOffset: number,
) {
  const buffer = Buffer.alloc(56 + 20 + 22);
  buffer.writeUInt32LE(0x06064b50, 0);
  buffer.writeBigUInt64LE(44n, 4);
  buffer.writeUInt16LE(45, 12);
  buffer.writeUInt16LE(45, 14);
  buffer.writeBigUInt64LE(BigInt(count), 24);
  buffer.writeBigUInt64LE(BigInt(count), 32);
  buffer.writeBigUInt64LE(BigInt(centralBytes), 40);
  buffer.writeBigUInt64LE(BigInt(centralOffset), 48);
  buffer.writeUInt32LE(0x07064b50, 56);
  buffer.writeBigUInt64LE(BigInt(endOffset), 64);
  buffer.writeUInt32LE(1, 72);
  buffer.writeUInt32LE(0x06054b50, 76);
  buffer.writeUInt16LE(0xffff, 84);
  buffer.writeUInt16LE(0xffff, 86);
  buffer.writeUInt32LE(0xffffffff, 88);
  buffer.writeUInt32LE(0xffffffff, 92);
  return buffer;
}

async function makeArchive({
  entries,
  destination,
  compression = "deflate",
  signal,
  onProgress,
}: ExportSignals & {
  entries:
    | AsyncIterable<{ name: string; path: string }>
    | Iterable<{ name: string; path: string }>;
  destination: string;
  compression?: ExportCompression;
}) {
  if (!["deflate", "store"].includes(compression))
    throw new Error("无效的 ZIP 压缩模式");
  checkAbort(signal);
  const centralPath = `${destination}.central`;
  let output: FileHandle | null = null,
    central: FileHandle | null = null,
    outputCreated = false,
    centralCreated = false,
    success = false;
  let position = 0,
    centralBytes = 0,
    entryCount = 0,
    bytesRead = 0,
    lastProgress = 0;
  async function write(
    handle: FileHandle | null,
    buffer: Buffer,
    position: number | null = null,
  ) {
    if (!handle) throw new Error("ZIP file is not open");
    checkAbort(signal);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(
        buffer,
        offset,
        buffer.length - offset,
        position === null ? null : position + offset,
      );
      if (!bytesWritten) throw new Error("ZIP 文件写入不完整");
      offset += bytesWritten;
    }
  }
  async function append(buffer: Buffer) {
    await write(output, buffer);
    position += buffer.length;
    if (!Number.isSafeInteger(position))
      throw new Error("ZIP 文件超出安全寻址范围");
  }
  const progress = (force: boolean) => {
    const now = Date.now();
    if (force || now - lastProgress >= 100) {
      lastProgress = now;
      onProgress?.({
        phase: "archive",
        bytesRead,
        completed: entryCount,
        bytesWritten: position,
      });
    }
  };
  try {
    output = await fsp.open(destination, "wx");
    outputCreated = true;
    central = await fsp.open(centralPath, "wx");
    centralCreated = true;
    const method = compression === "store" ? 0 : 8;
    for await (const entry of entries) {
      checkAbort(signal);
      const name = nameBytes(entry.name);
      const stat = await fsp.stat(entry.path);
      if (!stat.isFile()) throw new Error(`ZIP 条目不是文件：${entry.name}`);
      const stamp = dosTime(stat.mtime),
        localOffset = position;
      const header = localHeader(name, method, stamp);
      await append(header);
      const dataOffset = position;
      let rawBytes = 0,
        crc = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          crc = crc32(crc, chunk);
          rawBytes += chunk.length;
          bytesRead += chunk.length;
          callback(null, chunk);
        },
      });
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          append(chunk).then(() => {
            try {
              progress(false);
              callback();
            } catch (error) {
              callback(errorOf(error));
            }
          }, callback);
        },
      });
      const source = fs.createReadStream(entry.path, {
        highWaterMark: 64 * 1024,
      });
      if (method === 8)
        await pipeline(source, meter, createDeflateRaw({ level: 6 }), sink, {
          signal,
        });
      else await pipeline(source, meter, sink, { signal });
      if (rawBytes !== stat.size)
        throw new Error(`ZIP 输入在读取期间变化：${entry.name}`);
      const compressedBytes = position - dataOffset;
      header.writeUInt32LE(crc, 14);
      header.writeBigUInt64LE(BigInt(rawBytes), 30 + name.length + 4);
      header.writeBigUInt64LE(BigInt(compressedBytes), 30 + name.length + 12);
      await write(output, header, localOffset);
      const record = centralHeader(
        name,
        method,
        stamp,
        crc,
        compressedBytes,
        rawBytes,
        localOffset,
      );
      await write(central, record);
      centralBytes += record.length;
      entryCount++;
      progress(false);
    }
    await central.close();
    central = null;
    const centralOffset = position;
    for await (const chunk of fs.createReadStream(centralPath, {
      highWaterMark: 64 * 1024,
    }))
      await append(chunk);
    const endOffset = position;
    await append(
      endRecords(entryCount, centralBytes, centralOffset, endOffset),
    );
    checkAbort(signal);
    await output.sync();
    await output.close();
    output = null;
    progress(true);
    success = true;
    return { bytes: position, entries: entryCount };
  } finally {
    await output?.close().catch(() => {});
    await central?.close().catch(() => {});
    if (centralCreated)
      await fsp.rm(centralPath, { force: true }).catch(() => {});
    if (outputCreated && !success)
      await fsp.rm(destination, { force: true }).catch(() => {});
  }
}

export { makeArchive, crc32 };
