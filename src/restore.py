#!/usr/bin/env python3
"""Restore a TraceDock V2 package, offline, using only Python's standard library.

Usage: python restore.py recording.zip --output restored [--timeline-only]
The source may also be an unpacked directory. Existing outputs are never replaced.
"""
from __future__ import annotations

import argparse
import codecs
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import struct
import sys
import tempfile
import zlib

CHUNK = 65536
SAFE_INTEGER = 9007199254740991
HASH = re.compile(r"^[0-9a-f]{64}$")
SPECIAL = re.compile(br'["\\\x00-\x1f]')
SURROGATE = re.compile("[\ud800-\udfff]")
META_FIELDS = {"id", "seq", "type", "timestamp", "elapsedMs", "documentId", "url", "title", "summary"}


class InvalidPackage(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidPackage(message)


def integer(value, name, minimum=0, maximum=SAFE_INTEGER):
    require(type(value) is int and minimum <= value <= maximum, f"Invalid {name}")
    return value


def safe_path(value):
    require(isinstance(value, str) and value and len(value) <= 4096, "Invalid file path")
    require("\\" not in value and "\0" not in value and not value.startswith("/"), "Unsafe file path")
    for part in value.split("/"):
        require(part and part not in (".", "..") and not part.endswith((".", " ")), "Unsafe file component")
        require(not any(c in part for c in ':<>"|?*') and all(ord(c) >= 32 for c in part), "Unsafe file component")
        require(part.split(".")[0].upper() not in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}, "Reserved file component")
    return value


def file_spec(item):
    require(isinstance(item, dict), "Invalid file descriptor")
    name = safe_path(item.get("path"))
    size = integer(item.get("bytes"), f"{name} bytes")
    digest = item.get("sha256")
    require(isinstance(digest, str) and HASH.fullmatch(digest), f"Invalid SHA-256: {name}")
    return name, size, digest


def json_dump(value):
    # ASCII escaping preserves even isolated UTF-16 code units from saved JSON.
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False)


def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"Duplicate metadata key: {key}")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique, parse_constant=lambda x: (_ for _ in ()).throw(InvalidPackage(f"Invalid number: {x}")))


def read_exact(handle, count):
    data = handle.read(count)
    require(len(data) == count, "Truncated input")
    return data


class Package:
    """Disk-indexed ZIP/ZIP64 reader; no list proportional to archive entries."""
    def __init__(self, source, work):
        self.source = Path(source).resolve()
        self.work = work.resolve()
        self.directory = self.source.is_dir()
        self.db = sqlite3.connect(work / "input-index.sqlite")
        self.db.execute("PRAGMA cache_size=-2048")
        self.db.execute("PRAGMA temp_store=FILE")
        self.db.execute("CREATE TABLE entries(path TEXT PRIMARY KEY, folded TEXT UNIQUE, size INTEGER, packed INTEGER, offset INTEGER UNIQUE, method INTEGER, flags INTEGER, crc INTEGER, expected_size INTEGER, expected_hash TEXT)")
        self.cd_offset = 0
        try:
            if self.directory:
                self._directory_index()
            else:
                self._zip_index()
            self.db.commit()
        except BaseException:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def _add(self, name, size, packed, offset, method, flags, crc):
        safe_path(name)
        try:
            self.db.execute("INSERT INTO entries(path,folded,size,packed,offset,method,flags,crc) VALUES(?,?,?,?,?,?,?,?)", (name, name.casefold(), size, packed, offset, method, flags, crc))
        except sqlite3.IntegrityError as exc:
            raise InvalidPackage(f"Duplicate archive path or offset: {name}") from exc

    def _directory_index(self):
        for base, directories, files in os.walk(self.source, followlinks=False):
            directories[:] = [name for name in directories if (Path(base) / name).resolve() != self.work]
            for name in directories:
                require(not (Path(base) / name).is_symlink(), "Symlink directory is unsupported")
            for name in files:
                file = Path(base) / name
                require(not file.is_symlink() and file.is_file(), "Symlink/special file is unsupported")
                self._add(file.relative_to(self.source).as_posix(), file.stat().st_size, 0, None, -1, 0, 0)

    def _zip_index(self):
        with self.source.open("rb") as handle:
            size = handle.seek(0, 2)
            tail_start = max(0, size - 65557)
            handle.seek(tail_start)
            tail = handle.read()
            found = tail.rfind(b"PK\x05\x06")
            require(found >= 0 and found + 22 <= len(tail), "ZIP end record missing")
            values = struct.unpack_from("<4s4H2LH", tail, found)
            _, disk, cd_disk, disk_count, count, cd_size, cd_offset, comment = values
            require(found + 22 + comment == len(tail), "ZIP trailing bytes or truncated comment")
            require(disk == cd_disk == 0 and disk_count == count, "Multi-volume ZIP is unsupported")
            end_offset = tail_start + found
            if count == 65535 or cd_size == 0xffffffff or cd_offset == 0xffffffff:
                require(end_offset >= 20, "ZIP64 locator missing")
                handle.seek(end_offset - 20)
                sig, zip_disk, zip_offset, disks = struct.unpack("<4sLQL", read_exact(handle, 20))
                require(sig == b"PK\x06\x07" and zip_disk == 0 and disks == 1, "Invalid ZIP64 locator")
                handle.seek(zip_offset)
                fields = struct.unpack("<4sQ2H2L4Q", read_exact(handle, 56))
                sig, record_size, _, _, disk, cd_disk, disk_count, count, cd_size, cd_offset = fields
                require(sig == b"PK\x06\x06" and record_size >= 44 and disk == cd_disk == 0 and disk_count == count, "Invalid ZIP64 end record")
                require(zip_offset + 12 + record_size <= end_offset - 20, "ZIP64 end record overlaps locator")
            require(cd_offset + cd_size <= end_offset, "Invalid central directory range")
            self.cd_offset = cd_offset
            handle.seek(cd_offset)
            for _ in range(count):
                header = read_exact(handle, 46)
                fields = struct.unpack("<4s6H3L5H2L", header)
                sig, made, needed, flags, method, _, _, crc, packed, unpacked, nlen, xlen, clen, disk, _, attrs, offset = fields
                require(sig == b"PK\x01\x02", "Invalid central directory entry")
                require(not flags & 1 and method in (0, 8), "Encrypted or unsupported ZIP compression")
                name_bytes = read_exact(handle, nlen)
                extra = read_exact(handle, xlen)
                read_exact(handle, clen)
                name = name_bytes.decode("utf-8" if flags & 0x800 else "cp437")
                require(disk in (0, 65535), "Multi-volume ZIP is unsupported")
                at = 0
                while at < len(extra):
                    require(at + 4 <= len(extra), "Truncated ZIP extra field")
                    tag, n = struct.unpack_from("<HH", extra, at)
                    at += 4
                    require(at + n <= len(extra), "Truncated ZIP extra field")
                    if tag == 1:
                        part, cursor = extra[at:at+n], 0
                        vals = [unpacked, packed, offset]
                        for i in range(3):
                            if vals[i] == 0xffffffff:
                                require(cursor + 8 <= len(part), "Truncated ZIP64 size")
                                vals[i] = struct.unpack_from("<Q", part, cursor)[0]
                                cursor += 8
                        unpacked, packed, offset = vals
                        if disk == 65535:
                            require(cursor + 4 <= len(part), "Truncated ZIP64 disk")
                            disk = struct.unpack_from("<L", part, cursor)[0]
                    at += n
                require(disk == 0 and offset < cd_offset, "Invalid ZIP local entry offset")
                mode = attrs >> 16 if made >> 8 == 3 else 0
                require(not stat.S_ISLNK(mode), "ZIP symlink is unsupported")
                if name.endswith("/"):
                    safe_path(name[:-1])
                    require(unpacked == 0, "Nonempty ZIP directory")
                    continue
                self._add(name, unpacked, packed, offset, method, flags, crc)
            require(handle.tell() == cd_offset + cd_size, "Unexpected central directory bytes")

    def chunks(self, name):
        row = self.db.execute("SELECT size,packed,offset,method,flags,crc FROM entries WHERE path=?", (name,)).fetchone()
        require(row is not None, f"Missing file: {name}")
        size, packed, offset, method, flags, expected_crc = row
        if self.directory:
            with (self.source / name).open("rb") as handle:
                while True:
                    data = handle.read(CHUNK)
                    if not data:
                        break
                    yield data
            return
        with self.source.open("rb") as handle:
            handle.seek(offset)
            fields = struct.unpack("<4s5H3L2H", read_exact(handle, 30))
            sig, _, local_flags, local_method, _, _, _, _, _, nlen, xlen = fields
            require(sig == b"PK\x03\x04" and local_flags == flags and local_method == method, "ZIP local/central header mismatch")
            local_name = read_exact(handle, nlen).decode("utf-8" if flags & 0x800 else "cp437")
            require(local_name == name, "ZIP local filename mismatch")
            read_exact(handle, xlen)
            require(handle.tell() + packed <= self.cd_offset, "ZIP data overlaps central directory")
            decompressor = zlib.decompressobj(-15) if method == 8 else None
            remaining, produced, crc = packed, 0, 0
            while remaining:
                raw = read_exact(handle, min(CHUNK, remaining))
                remaining -= len(raw)
                while raw:
                    data = decompressor.decompress(raw, CHUNK) if decompressor else raw
                    raw = decompressor.unconsumed_tail if decompressor else b""
                    produced += len(data)
                    require(produced <= size, f"ZIP expanded size exceeds declaration: {name}")
                    crc = zlib.crc32(data, crc)
                    if data:
                        yield data
                if decompressor:
                    require(not decompressor.unused_data, "Extra compressed stream bytes")
            require(not decompressor or decompressor.eof, f"Truncated deflate stream: {name}")
            require(produced == size and crc & 0xffffffff == expected_crc, f"ZIP size/CRC mismatch: {name}")

    def small(self, name, limit):
        data = bytearray()
        for chunk in self.chunks(name):
            require(len(data) + len(chunk) <= limit, f"Oversized metadata file: {name}")
            data.extend(chunk)
        return bytes(data)

    def copy_verified(self, name, target, expected_size, expected_hash):
        target.parent.mkdir(parents=True, exist_ok=True)
        total, digest = 0, hashlib.sha256()
        with target.open("xb") as output:
            for chunk in self.chunks(name):
                total += len(chunk)
                require(total <= expected_size, f"File exceeds declared length: {name}")
                digest.update(chunk)
                output.write(chunk)
        require(total == expected_size and digest.hexdigest() == expected_hash, f"File SHA-256/length mismatch: {name}")


class JSONReader:
    """Incremental validating JSON scanner, including strings larger than RAM."""
    def __init__(self, handle, start=0, end=None):
        self.handle = handle
        handle.seek(start)
        self.offset = start
        self.end = end
        self.buffer = b""
        self.at = 0

    def fill(self):
        if self.at < len(self.buffer):
            return True
        n = CHUNK if self.end is None else min(CHUNK, self.end - self.offset)
        self.buffer = self.handle.read(max(0, n))
        self.at = 0
        return bool(self.buffer)

    def peek(self):
        return self.buffer[self.at] if self.fill() else None

    def take(self, n=1):
        require(self.fill() and self.at + n <= len(self.buffer), "Truncated JSON")
        data = self.buffer[self.at:self.at+n]
        self.at += n
        self.offset += n
        return data

    def byte(self):
        return self.take()[0]

    def whitespace(self):
        while self.fill():
            at = self.at
            while at < len(self.buffer) and self.buffer[at] in b" \r\n\t":
                at += 1
            n = at - self.at
            self.take(n)
            if self.at < len(self.buffer):
                return

    def expect(self, value):
        require(self.byte() == value, "Invalid JSON punctuation")

    def string(self, collect=0, emit=None):
        self.expect(34)
        decoder = codecs.getincrementaldecoder("utf-8")("strict")
        parts, length, overflow = [], 0, False
        def push(text):
            nonlocal length, overflow
            if emit is not None and text:
                emit(text)
            if collect and not overflow:
                length += len(text)
                if length <= collect:
                    parts.append(text)
                else:
                    parts.clear()
                    overflow = True
        while True:
            require(self.fill(), "Unterminated JSON string")
            found = SPECIAL.search(self.buffer, self.at)
            stop = found.start() if found else len(self.buffer)
            if stop > self.at:
                push(decoder.decode(self.take(stop - self.at)))
            if not found:
                continue
            char = self.byte()
            push(decoder.decode(b"", final=True))
            decoder.reset()
            if char == 34:
                return "".join(parts) if collect and not overflow else None
            require(char == 92, "Unescaped control character in JSON string")
            escape = self.byte()
            if escape == 117:
                digits = bytes(self.byte() for _ in range(4))
                require(all(c in b"0123456789abcdefABCDEF" for c in digits), "Invalid Unicode escape")
                push(chr(int(digits, 16)))
            else:
                values = {34:'"', 92:'\\', 47:'/', 98:'\b', 102:'\f', 110:'\n', 114:'\r', 116:'\t'}
                require(escape in values, "Invalid JSON escape")
                push(values[escape])

    def scalar(self):
        char = self.peek()
        if char == 34:
            self.string()
            return
        if char in (116, 102, 110):
            value = {116:b"true", 102:b"false", 110:b"null"}[char]
            require(bytes(self.byte() for _ in value) == value, "Invalid JSON literal")
            return
        require(char is not None and char in b"-0123456789", "Invalid JSON value")
        # Number lexemes are scanned by a finite-state machine, never accumulated.
        state = "start"
        while True:
            char = self.peek()
            if char is None or char in b" \r\n\t,]}":
                require(state in ("zero", "integer", "fraction", "exponent"), "Invalid JSON number")
                return
            if state == "start":
                state = "minus" if char == 45 else "zero" if char == 48 else "integer" if 49 <= char <= 57 else "bad"
            elif state == "minus":
                state = "zero" if char == 48 else "integer" if 49 <= char <= 57 else "bad"
            elif state in ("zero", "integer"):
                state = "integer" if state == "integer" and 48 <= char <= 57 else "dot" if char == 46 else "exp" if char in (69, 101) else "bad"
            elif state == "dot":
                state = "fraction" if 48 <= char <= 57 else "bad"
            elif state == "fraction":
                state = "fraction" if 48 <= char <= 57 else "exp" if char in (69, 101) else "bad"
            elif state == "exp":
                state = "sign" if char in (43, 45) else "exponent" if 48 <= char <= 57 else "bad"
            elif state == "sign":
                state = "exponent" if 48 <= char <= 57 else "bad"
            elif state == "exponent":
                state = "exponent" if 48 <= char <= 57 else "bad"
            require(state != "bad", "Invalid JSON number")
            self.byte()

    def value(self):
        self.whitespace()
        stack = []
        def start():
            char = self.peek()
            if char in (123, 91):
                self.byte()
                stack.append([char, "first"])
                require(len(stack) <= 10000, "JSON nesting exceeds supported 10000 levels")
            else:
                self.scalar()
        start()
        while stack:
            self.whitespace()
            kind, phase = stack[-1]
            close = 125 if kind == 123 else 93
            char = self.peek()
            if phase in ("first", "next"):
                if phase == "first" and char == close:
                    self.byte(); stack.pop(); continue
                if kind == 123:
                    require(char == 34, "JSON object key must be a string")
                    self.string()
                    self.whitespace(); self.expect(58); self.whitespace()
                stack[-1][1] = "comma"
                start()
            elif char == close:
                self.byte(); stack.pop()
            else:
                self.expect(44)
                stack[-1][1] = "next"


class UTF8Writer:
    """Convert JSON UTF-16 escapes to UTF-8 like Node's writeFile, incrementally."""
    def __init__(self, handle):
        self.handle, self.pending = handle, None

    def write(self, text):
        if not text:
            return
        if self.pending is not None:
            text = chr(self.pending) + text
            self.pending = None
        if 0xd800 <= ord(text[-1]) <= 0xdbff:
            self.pending = ord(text[-1]); text = text[:-1]
        if SURROGATE.search(text):
            text = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
        self.handle.write(text.encode("utf-8"))

    def finish(self):
        if self.pending is not None:
            self.handle.write(b"\xef\xbf\xbd")
            self.pending = None


def copy_range(source, target, start, end):
    source.seek(start)
    remaining = end - start
    while remaining:
        chunk = source.read(min(CHUNK, remaining))
        require(chunk, "Truncated JSON range")
        target.write(chunk)
        remaining -= len(chunk)


def hash_file(path):
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            digest.update(chunk); size += len(chunk)
    return size, digest.hexdigest()


def record_file(root, name, report):
    size, digest = hash_file(root / name)
    item = {"path":name, "bytes":size, "sha256":digest}
    report.write(json_dump(item) + "\n")
    return item


def md_cell(value):
    text = str(value if value is not None else "")
    return text.replace("|", "\\|").replace("\r", " ").replace("\n", " ").replace("<", "&lt;").replace(">", "&gt;")


def derive_snapshot(timeline, target, event, payload_range, report):
    seq = event["seq"]
    stem = f"snapshots/{seq:08d}"
    (target / "snapshots").mkdir(exist_ok=True)
    state_name, html_name = stem + ".state.json", stem + ".html"
    html_range, outer_range = None, None
    with timeline.open("rb") as handle, timeline.open("rb") as raw, (target / state_name).open("wb") as output:
        output.write(b"{")
        fields = {"eventId":"id", "seq":"seq", "timestamp":"timestamp", "documentId":"documentId", "url":"url", "title":"title"}
        for number, (key, source_key) in enumerate(fields.items()):
            if number: output.write(b",")
            output.write((json_dump(key) + ":").encode("ascii"))
            span = event.get("_raw_meta", {}).get(source_key)
            if span: copy_range(raw, output, *span)
            else: output.write(b"null")
        output.write((",\"htmlFile\":" + json_dump(f"{seq:08d}.html")).encode("ascii"))
        if payload_range:
            reader = JSONReader(handle, *payload_range)
            reader.whitespace()
            if reader.peek() == 123:
                reader.byte(); first = True
                while True:
                    reader.whitespace()
                    if reader.peek() == 125:
                        reader.byte(); break
                    if not first:
                        reader.expect(44); reader.whitespace()
                    first = False
                    key_start = reader.offset
                    key = reader.string(collect=4096)
                    key_end = reader.offset
                    reader.whitespace(); reader.expect(58); reader.whitespace()
                    start = reader.offset
                    kind = reader.peek()
                    reader.value()
                    end = reader.offset
                    if key in ("html", "outerHTML"):
                        require(kind not in (123, 91), "Snapshot html/outerHTML must be strings or simple values")
                        selected = (start, end, kind) if kind != 110 else None
                        if key == "html": html_range = selected
                        else: outer_range = selected
                        continue
                    output.write(b",")
                    copy_range(raw, output, key_start, key_end)
                    output.write(b":")
                    copy_range(raw, output, start, end)
        output.write(b"}\n")
    with (target / html_name).open("wb") as output:
        if html_range or outer_range:
            with timeline.open("rb") as handle:
                start, end, kind = html_range or outer_range
                if kind == 34:
                    reader = JSONReader(handle, start, end)
                    utf8 = UTF8Writer(output)
                    reader.string(emit=utf8.write)
                    utf8.finish()
                else:
                    copy_range(handle, output, start, end)
    record_file(target, html_name, report)
    record_file(target, state_name, report)
    return {"eventId":event.get("id"), "seq":seq, "documentId":event.get("documentId"), "html":html_name, "state":state_name}


def scan_timeline(timeline, manifest, target, report, derive):
    counts = {"events":0, "actions":0, "mutationBatches":0, "snapshots":0}
    last_seq = 0
    with contextlib.ExitStack() as stack:
        handle = stack.enter_context(timeline.open("rb"))
        raw = stack.enter_context(timeline.open("rb"))
        reader = JSONReader(handle)
        markdown = stack.enter_context((target / "timeline.md").open("w", encoding="utf-8", errors="backslashreplace", newline="\n")) if derive else None
        snapshot_index = stack.enter_context((target / "snapshots.jsonl").open("w", encoding="ascii", newline="\n")) if derive else None
        if markdown:
            markdown.write("# 完整事件索引\n\n原始事实见 timeline.jsonl；此文件仅为派生阅读索引。\n\n| 序号 | 相对时间 | UTC 时间 | 类型 | 摘要 | 快照 |\n| --- | --- | --- | --- | --- | --- |\n")
        while True:
            reader.whitespace()
            if reader.peek() is None:
                break
            reader.expect(123)
            event, payload, first = {"_raw_meta":{}}, None, True
            while True:
                reader.whitespace()
                if reader.peek() == 125:
                    reader.byte(); break
                if not first:
                    reader.expect(44); reader.whitespace()
                first = False
                key = reader.string(collect=128)
                reader.whitespace(); reader.expect(58); reader.whitespace()
                start = reader.offset
                reader.value()
                end = reader.offset
                if key in META_FIELDS:
                    event["_raw_meta"][key] = (start, end)
                    if end - start <= 262144:
                        raw.seek(start)
                        event[key] = json.loads(read_exact(raw, end - start))
                    else:
                        require(key not in ("seq", "type", "elapsedMs"), f"Invalid oversized structural field: {key}")
                        event[key] = "[详见原始时间线；字段超出阅读索引长度]"
                elif key == "payload":
                    payload = (start, end)
            seq = integer(event.get("seq"), "event seq", 1)
            require(seq > last_seq, "Timeline seq is not strictly increasing")
            require(isinstance(event.get("type"), str), "Invalid event type")
            last_seq = seq
            counts["events"] += 1
            counts["actions"] += int(event["type"].startswith("action."))
            counts["mutationBatches"] += int(event["type"] == "dom.mutation")
            counts["snapshots"] += int(event["type"] == "dom.snapshot")
            link = ""
            if derive and event["type"] == "dom.snapshot":
                snapshot = derive_snapshot(timeline, target, event, payload, report)
                snapshot_index.write(json_dump(snapshot) + "\n")
                link = f'[HTML]({snapshot["html"]}) · [状态]({snapshot["state"]})'
            if markdown:
                elapsed = event.get("elapsedMs", 0)
                require(isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool), "Invalid elapsedMs")
                markdown.write(f'| {seq} | {elapsed / 1000:.3f}s | {md_cell(event.get("timestamp"))} | {md_cell(event["type"])} | {md_cell(event.get("summary", event["type"]))} | {link} |\n')
            require(reader.peek() is None or reader.peek() in b" \t\r\n", "Missing timeline record separator")
    require(counts["events"] == manifest["eventCount"] and last_seq == manifest["lastSeq"], "Timeline event count/lastSeq mismatch")
    expected = manifest.get("counts", {})
    for key, value in counts.items():
        if key in expected:
            require(value == expected[key], f"Timeline {key} mismatch")
    if derive:
        record_file(target, "timeline.md", report)
        record_file(target, "snapshots.jsonl", report)
    return counts


def decode_delta(source, target, manifest):
    config = manifest.get("delta")
    require(isinstance(config, dict) and config.get("codec") == "copy-add-v1", "Unsupported delta codec")
    require(config.get("data") == "data.bin" and config.get("index") == "index.jsonl", "Unsupported delta paths")
    block_size = integer(config.get("blockBytes"), "blockBytes", 1, 4 * 1024 * 1024)
    window_limit = integer(config.get("windowBytes"), "windowBytes", 1, 16 * 1024 * 1024)
    checkpoint_blocks = integer(config.get("checkpointBlocks"), "checkpointBlocks", 1, 64)
    blocks = integer(config.get("blocks"), "blocks")
    require((block_size, window_limit, checkpoint_blocks) == (1048576, 4194304, 16), "Unsupported copy-add-v1 parameters")
    offset = data_offset = checkpoint_offset = index = 0
    digest = hashlib.sha256()
    with (source / "index.jsonl").open("rb") as indexes, (source / "data.bin").open("rb") as data, target.open("w+b") as output:
        while True:
            line = indexes.readline(16385)
            if not line:
                break
            require(len(line) <= 16384 and line.endswith(b"\n"), "Oversized or truncated delta index")
            item = strict_json(line)
            require(isinstance(item, dict), "Invalid delta index")
            checkpoint = index % checkpoint_blocks == 0
            if checkpoint: checkpoint_offset = offset
            window_start = max(checkpoint_offset, offset - window_limit)
            window_bytes = offset - window_start
            for field, expected in (("index", index), ("offset", offset), ("dataOffset", data_offset), ("windowStart", window_start), ("windowBytes", window_bytes)):
                require(integer(item.get(field), field) == expected, f"Invalid delta {field}")
            require(type(item.get("checkpoint")) is bool and item["checkpoint"] == checkpoint, "Invalid checkpoint")
            n = integer(item.get("bytes"), "block bytes", 1, block_size)
            require(index < blocks and (index == blocks - 1 or n == block_size), "Unexpected delta block size/count")
            encoded_size = integer(item.get("dataBytes"), "dataBytes", 1, block_size * 2)
            encoded = read_exact(data, encoded_size)
            require(isinstance(item.get("dataSha256"), str) and hashlib.sha256(encoded).hexdigest() == item["dataSha256"], f"Encoded block {index} hash mismatch")
            if item.get("mode") == "raw":
                require(encoded_size == n, "Raw block size mismatch")
                restored = encoded
            else:
                require(item.get("mode") == "delta" and not checkpoint, "Invalid delta mode at checkpoint")
                output.flush(); output.seek(window_start)
                window = read_exact(output, window_bytes)
                restored = bytearray()
                at = 0
                while at < len(encoded):
                    opcode = encoded[at]; at += 1
                    require(at + 4 <= len(encoded), "Truncated delta instruction")
                    first = struct.unpack_from("<L", encoded, at)[0]; at += 4
                    if opcode == 0:
                        length = first
                        require(length > 0 and at + length <= len(encoded) and len(restored) + length <= n, "Invalid ADD range")
                        restored.extend(encoded[at:at+length]); at += length
                    else:
                        require(opcode == 1 and at + 4 <= len(encoded), "Invalid COPY opcode/header")
                        length = struct.unpack_from("<L", encoded, at)[0]; at += 4
                        require(length > 0 and first + length <= len(window) and len(restored) + length <= n, "COPY outside verified window")
                        restored.extend(window[first:first+length])
                require(len(restored) == n, "Restored block length mismatch")
            require(isinstance(item.get("sha256"), str) and hashlib.sha256(restored).hexdigest() == item["sha256"], f"Restored block {index} hash mismatch")
            output.seek(offset); output.write(restored); digest.update(restored)
            offset += n; data_offset += encoded_size; index += 1
        require(index == blocks and data.read(1) == b"", "Missing blocks or trailing delta bytes")
    _, expected_size, expected_hash = file_spec(manifest["timeline"])
    require(offset == expected_size and digest.hexdigest() == expected_hash, "Restored timeline SHA-256/length mismatch")


def restore(source, destination, timeline_only=False):
    destination = Path(destination).absolute()
    require(not destination.exists(), "Output directory already exists; choose a new --output path")
    destination.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".tracedock-restore-", dir=destination.parent))
    package = None
    try:
        package = Package(source, work)
        manifest_bytes = package.small("manifest.json", 1024 * 1024)
        manifest = strict_json(manifest_bytes)
        require(isinstance(manifest, dict) and manifest.get("format") == "tracedock-session" and manifest.get("schemaVersion") == 2, "Unsupported TraceDock package version")
        encoding = manifest.get("encoding")
        require(encoding in ("delta", "full") and manifest.get("compression") in ("deflate", "store"), "Invalid export mode")
        integer(manifest.get("eventCount"), "eventCount")
        integer(manifest.get("lastSeq"), "lastSeq")
        timeline_name, timeline_size, timeline_hash = file_spec(manifest.get("timeline"))
        require(timeline_name == "timeline.jsonl" and manifest.get("timelineBytes") == timeline_size, "Invalid timeline descriptor")
        files = manifest.get("files")
        require(isinstance(files, list) and len(files) <= 64, "Invalid root file descriptors")
        root_files = {}
        for item in files:
            name, size, sha = file_spec(item)
            require(name not in root_files, "Duplicate root file descriptor")
            root_files[name] = (size, sha)
        require({"session.json", "AGENT_README.md", "restore.py", "files.jsonl"}.issubset(root_files), "Missing root file descriptors")
        source_dir = work / "source"
        source_dir.mkdir()
        package.copy_verified("files.jsonl", source_dir / "files.jsonl", *root_files["files.jsonl"])
        with (source_dir / "files.jsonl").open("rb") as listing:
            while True:
                line = listing.readline(16385)
                if not line: break
                require(len(line) <= 16384 and line.endswith(b"\n"), "Invalid files.jsonl line")
                name, size, sha = file_spec(strict_json(line))
                require(name not in ("manifest.json", "files.jsonl"), "Unexpected recursive file descriptor")
                row = package.db.execute("SELECT size,expected_hash FROM entries WHERE path=?", (name,)).fetchone()
                require(row and row[0] == size and row[1] is None, f"Missing/duplicate file descriptor: {name}")
                if name in root_files: require(root_files[name] == (size, sha), "Conflicting root/file-list descriptor")
                package.db.execute("UPDATE entries SET expected_size=?,expected_hash=? WHERE path=?", (size, sha, name))
        package.db.commit()
        for name in root_files:
            if name != "files.jsonl":
                require(package.db.execute("SELECT expected_hash FROM entries WHERE path=?", (name,)).fetchone() == (root_files[name][1],), f"Root file missing from list: {name}")
        unexpected = package.db.execute("SELECT path FROM entries WHERE expected_hash IS NULL AND path NOT IN ('manifest.json','files.jsonl') LIMIT 1").fetchone()
        require(unexpected is None, f"Unverified extra archive file: {unexpected[0] if unexpected else ''}")
        for name, size, sha in package.db.execute("SELECT path,expected_size,expected_hash FROM entries WHERE expected_hash IS NOT NULL ORDER BY path"):
            package.copy_verified(name, source_dir / name, size, sha)
        target = work / "result"
        target.mkdir()
        if encoding == "delta":
            for name, in package.db.execute("SELECT path FROM entries"):
                require(name in ("manifest.json", "files.jsonl", "session.json", "AGENT_README.md", "restore.py", "index.jsonl", "data.bin", "resources.jsonl") or re.fullmatch(r"assets/[a-f0-9]{64}", name), "Unexpected delta files")
            decode_delta(source_dir, target / "timeline.jsonl", manifest)
        else:
            require(hash_file(source_dir / "timeline.jsonl") == (timeline_size, timeline_hash), "Full timeline fact hash mismatch")
            (source_dir / "timeline.jsonl").replace(target / "timeline.jsonl")
        for name in ("session.json", "AGENT_README.md"):
            (source_dir / name).replace(target / name)
        (target / "source-manifest.json").write_bytes(manifest_bytes)
        derived_files = 0
        with (target / "restored-files.jsonl").open("w", encoding="ascii", newline="\n") as report:
            facts = [record_file(target, name, report) for name in ("timeline.jsonl", "session.json")]
            counts = scan_timeline(target / "timeline.jsonl", manifest, target, report, encoding == "delta" and not timeline_only)
            if encoding == "delta" and not timeline_only:
                derived_files = counts["snapshots"] * 2 + 2
            if encoding == "full" and not timeline_only:
                for name, in package.db.execute("SELECT path FROM entries WHERE expected_hash IS NOT NULL ORDER BY path"):
                    if name.startswith("snapshots/") or name in ("timeline.md", "snapshots.jsonl"):
                        output = target / name
                        output.parent.mkdir(parents=True, exist_ok=True)
                        (source_dir / name).replace(output)
                        record_file(target, name, report)
                        derived_files += 1
            for name, in package.db.execute("SELECT path FROM entries WHERE expected_hash IS NOT NULL ORDER BY path"):
                if name == "resources.jsonl" or (not timeline_only and re.fullmatch(r"assets/[a-f0-9]{64}", name)):
                    output = target / name
                    output.parent.mkdir(parents=True, exist_ok=True)
                    (source_dir / name).replace(output)
                    record_file(target, name, report)
            record_file(target, "AGENT_README.md", report)
            record_file(target, "source-manifest.json", report)
        summary = {"status":"ok", "schemaVersion":2, "encoding":encoding, "timelineOnly":timeline_only, "eventCount":counts["events"], "lastSeq":manifest["lastSeq"], "counts":counts, "timeline":facts[0], "facts":facts, "derivedFiles":derived_files, "checksums":"restored-files.jsonl"}
        (target / "restore-report.json").write_text(json.dumps(summary, ensure_ascii=True, indent=2) + "\n", encoding="ascii")
        package.close(); package = None
        require(not destination.exists(), "Output appeared during restore; refusing to overwrite")
        target.rename(destination)
        return summary
    finally:
        if package is not None: package.close()
        shutil.rmtree(work, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description="Verify and restore a TraceDock V2 recording without network access.")
    parser.add_argument("source", help="ZIP file or unpacked package directory")
    parser.add_argument("--output", required=True, help="New output directory; existing paths are never overwritten")
    parser.add_argument("--timeline-only", action="store_true", help="Restore facts and guide without derived snapshots/Markdown")
    args = parser.parse_args()
    try:
        result = restore(args.source, args.output, args.timeline_only)
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except (Exception, KeyboardInterrupt) as exc:
        print(f"Restore failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
