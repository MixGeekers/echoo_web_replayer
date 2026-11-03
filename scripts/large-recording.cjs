'use strict';

// Reproducible synthetic acceptance workload. No browser-use compression claim is
// inferred from this deliberately mixed repetitive/random fixture.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'output');
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index === -1 ? fallback : argv[index + 1]; };
const flag = name => argv.includes(name);
const python = process.env.TRACEDOCK_PYTHON || 'python';
const phase = value('--phase', null);
const sessionId = 'large-recording-fixture';
const mark = 'TRACEDOCK_METRICS ';

function checkedDirectory(input) {
  const resolved = path.resolve(input);
  assert.ok(resolved.startsWith(outputRoot + path.sep), 'benchmark output must stay inside the workspace output directory');
  return resolved;
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filename)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

async function compareFileBytes(source, restored) {
  const left = await fsp.open(source, 'r');
  const right = await fsp.open(restored, 'r');
  const a = Buffer.allocUnsafe(MiB), b = Buffer.allocUnsafe(MiB);
  const hash = createHash('sha256');
  let position = 0;
  const read = async (handle, buffer) => {
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, position + filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    return filled;
  };
  try {
    while (true) {
      const [n, m] = await Promise.all([read(left, a), read(right, b)]);
      assert.equal(n, m, `file length differs at offset ${position}`);
      if (!n) break;
      assert.ok(a.subarray(0, n).equals(b.subarray(0, n)), `restored bytes differ at offset ${position}`);
      hash.update(b.subarray(0, n));
      position += n;
    }
    return { bytes: position, sha256: hash.digest('hex') };
  } finally { await Promise.allSettled([left.close(), right.close()]); }
}

async function write(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

async function close(stream) {
  const done = once(stream, 'finish');
  stream.end();
  await done;
}

async function measured(task) {
  const started = performance.now();
  let sampledPeakRss = process.memoryUsage().rss;
  let sampledPeakHeap = process.memoryUsage().heapUsed;
  const sample = () => {
    const memory = process.memoryUsage();
    sampledPeakRss = Math.max(sampledPeakRss, memory.rss);
    sampledPeakHeap = Math.max(sampledPeakHeap, memory.heapUsed);
  };
  const timer = setInterval(sample, 20);
  try {
    const result = await task();
    sample();
    const resourceMaxRss = (process.resourceUsage().maxRSS || 0) * 1024;
    return { ...result, elapsedMs: Math.round(performance.now() - started), peakRssBytes: Math.max(sampledPeakRss, resourceMaxRss), sampledPeakHeapBytes: sampledPeakHeap,
      memoryMethod: 'fresh Node process: OS maxRSS when available plus 20ms RSS sampling; RSS includes worker threads, heap sample is main-thread only' };
  } finally { clearInterval(timer); }
}

async function generate(directory, config) {
  const sessionsRoot = path.join(directory, 'sessions');
  const sessionDirectory = path.join(sessionsRoot, sessionId);
  await fsp.mkdir(sessionDirectory, { recursive: true });
  const timelinePath = path.join(sessionDirectory, 'timeline.jsonl');
  const stream = fs.createWriteStream(timelinePath);
  stream.on('error', () => {});
  const timelineHash = createHash('sha256');
  let totalBytes = 0;
  const emit = async data => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    timelineHash.update(bytes); totalBytes += bytes.length;
    await write(stream, bytes);
  };
  const snapshots = [];
  let seq = 0;
  const startedAt = '2026-10-29T00:00:00.000Z';
  const metadataFor = (type, summary) => ({
    id: `${sessionId}:${String(++seq).padStart(8, '0')}`, sessionId, seq, type,
    timestamp: startedAt, receivedAt: startedAt, elapsedMs: seq * 100,
    url: 'https://large-fixture.example.test/中文', title: '合成超大记录', documentId: 'large-document', summary,
  });
  const repeated = '<section data-node="stable"><label>中文 😀 é 流式记录</label><input value="unchanged"></section>';
  const common = repeated.repeat(Math.ceil(48 * 1024 / Buffer.byteLength(repeated)));
  const commonBytes = Buffer.byteLength(common);
  const commonEscaped = JSON.stringify(common).slice(1, -1);
  const snapshotTarget = config.eventMiB * MiB;
  const numberOfSnapshots = Math.max(2, Math.ceil(config.gib * GiB / snapshotTarget));
  for (let number = 0; number < numberOfSnapshots; number++) {
    const action = metadataFor('action.input', `input · #password · 测试 ${number}`);
    await emit(JSON.stringify({ ...action, payload: { value: `RAW-password-${number}-中文\u0000\ud800😀`, target: { selector: '#password' } } }) + '\n');
    const event = metadataFor('dom.snapshot', `DOM 快照 · synthetic-${number}`);
    await emit(JSON.stringify(event).slice(0, -1) + ',"payload":{"reason":"synthetic","html":"');
    const htmlHash = createHash('sha256');
    let htmlBytes = 0;
    const html = async (text, escaped) => {
      const bytes = Buffer.from(text);
      htmlHash.update(bytes); htmlBytes += bytes.length;
      await emit(escaped === undefined ? JSON.stringify(text).slice(1, -1) : escaped);
    };
    await html(`<html><body data-snapshot="${number}">`);
    let chunk = 0;
    while (htmlBytes < snapshotTarget) {
      // Every tenth ~48 KiB chunk is freshly random hexadecimal data (about
      // 10% low-repetition content); the other chunks repeat DOM content.
      if (++chunk % 10 === 0) await html(`<pre>${randomBytes(Math.floor(commonBytes / 2)).toString('hex')}</pre>`);
      else await html(common, commonEscaped);
    }
    await html(`<footer>UNIQUE-TAIL-SEARCH-${number}-😀</footer></body></html>`);
    await emit('","tree":{"id":"root"},"forms":[{"type":"password","value":"raw-password-中文\\u0000\\ud800😀"}],"frames":[],"shadowRoots":[],"coverage":{"mainDocument":true}}}\n');
    snapshots.push({ seq: event.seq, eventId: event.id, htmlBytes, htmlSha256: htmlHash.digest('hex') });
    console.log(`generated snapshot ${number + 1}/${numberOfSnapshots}, timeline ${(totalBytes / MiB).toFixed(1)} MiB`);
  }
  await close(stream);
  const metadata = { id: sessionId, name: '合成超大记录验收', status: 'stopped', startedAt, updatedAt: startedAt, endedAt: startedAt,
    url: 'https://large-fixture.example.test/中文', eventCount: seq, actionCount: numberOfSnapshots, mutationCount: 0,
    snapshotCount: numberOfSnapshots, lastSeq: seq, lastElapsedMs: seq * 100, schemaVersion: 3, sessionGroupId:'group-00000000-0000-4000-8000-000000000001', profileId:'profile-00000000-0000-4000-8000-000000000001', profileName:'测试环境', libraryState:'active', archivedAt:null, trashedAt:null, trashOrigin:null };
  await fsp.writeFile(path.join(sessionDirectory, 'session.json'), JSON.stringify(metadata, null, 2) + '\n');
  const fixture = { synthetic: true, composition: 'approximately 90% repeated DOM, 10% fresh random hex, UTF-8 and escaped raw form values',
    requestedGiB: config.gib, eventMiB: config.eventMiB, sessionsRoot, sessionId, timelinePath,
    timeline: { bytes: totalBytes, sha256: timelineHash.digest('hex') }, metadata, snapshots };
  assert.ok(totalBytes >= config.gib * GiB, 'the physical JSONL must reach the requested workload size');
  await fsp.writeFile(path.join(directory, 'fixture.json'), JSON.stringify(fixture, null, 2));
  return { timeline: fixture.timeline, eventCount: seq, snapshots: numberOfSnapshots, largestHtmlBytes: Math.max(...snapshots.map(item => item.htmlBytes)) };
}

async function indexFixture(directory) {
  const { SessionStore } = require('../out/session-store.cjs');
  const fixture = JSON.parse(await fsp.readFile(path.join(directory, 'fixture.json'), 'utf8'));
  const store = await new SessionStore(fixture.sessionsRoot).init();
  assert.equal(store.getSession(sessionId).eventCount, fixture.metadata.eventCount);
  const first = await store.timeline({ sessionId, limit: 3 });
  assert.equal(first.total, fixture.metadata.eventCount);
  assert.equal(first.events.length, 3);
  const preview = await store.getEvent(sessionId, fixture.snapshots[0].eventId, { preview: true, maxBytes: 65536 });
  assert.equal(preview.truncated, true);
  assert.ok(preview.bytes > fixture.eventMiB * MiB);
  assert.ok(Buffer.byteLength(preview.preview) <= 65536 + 4);
  const needle = `UNIQUE-TAIL-SEARCH-${fixture.snapshots.length - 1}-😀`;
  const found = await store.timeline({ sessionId, query: needle, limit: 2 });
  assert.equal(found.total, 1, 'search must include the end of a giant event');
  assert.equal(found.events[0].seq, fixture.snapshots.at(-1).seq);
  assert.deepEqual(await hashFile(fixture.timelinePath), fixture.timeline, 'indexing must not rewrite intact source bytes');
  return { indexedEvents: first.total, giantPreviewBytes: Buffer.byteLength(preview.preview), searchedGiantTail: true };
}

async function exportFixture(directory, config) {
  const { exportSession } = require('../out/exporter.cjs');
  const fixture = JSON.parse(await fsp.readFile(path.join(directory, 'fixture.json'), 'utf8'));
  const metadata = JSON.parse(await fsp.readFile(path.join(fixture.sessionsRoot, sessionId, 'session.json'), 'utf8'));
  // 合成记录没有静态资源；资源截点字段仍是导出工作线程契约的必填项。
  const capture = { metadata, timelinePath: fixture.timelinePath, byteLength: fixture.timeline.bytes, capturedAt: new Date().toISOString(), resourcePath: '', resourceBytes: 0 };
  const destination = path.join(directory, `${config.encoding}-${config.compression}.zip`);
  let lastProgress = 0;
  const result = await exportSession({ capture, sessionId, destination, encoding: config.encoding, compression: config.compression, appVersion: 'large-recording-acceptance',
    onProgress(progress) {
      if (Date.now() - lastProgress > 5000) { console.log(`export ${progress.phase}: ${progress.bytesRead ?? progress.completed ?? 0}/${progress.totalBytes ?? progress.total ?? '?'}`); lastProgress = Date.now(); }
    },
  });
  assert.equal(result.eventCount, fixture.metadata.eventCount);
  return { destination, encoding: config.encoding, compression: config.compression, zipBytes: (await fsp.stat(destination)).size, eventCount: result.eventCount };
}

async function verifyFixture(directory, config) {
  const fixture = JSON.parse(await fsp.readFile(path.join(directory, 'fixture.json'), 'utf8'));
  const restored = path.join(directory, `restored-${config.encoding}-${config.compression}`);
  const report = JSON.parse(await fsp.readFile(path.join(restored, 'restore-report.json'), 'utf8'));
  assert.equal(report.status, 'ok');
  assert.equal(report.eventCount, fixture.metadata.eventCount);
  assert.deepEqual(await compareFileBytes(fixture.timelinePath, path.join(restored, 'timeline.jsonl')), fixture.timeline);
  const expectedSession = await fsp.readFile(path.join(directory, 'bundled-session.json'));
  assert.deepEqual(await fsp.readFile(path.join(restored, 'session.json')), expectedSession);
  if (!config.timelineOnly) {
    for (const snapshot of fixture.snapshots) {
      const stem = String(snapshot.seq).padStart(8, '0');
      assert.deepEqual(await hashFile(path.join(restored, 'snapshots', `${stem}.html`)), { bytes: snapshot.htmlBytes, sha256: snapshot.htmlSha256 });
      const state = JSON.parse(await fsp.readFile(path.join(restored, 'snapshots', `${stem}.state.json`), 'utf8'));
      assert.equal(state.forms[0].value, 'raw-password-中文\u0000\ud800😀');
    }
  }
  return { timeline: fixture.timeline, factsByteExact: true, derivedHtmlHashVerified: config.timelineOnly ? 0 : fixture.snapshots.length };
}

const pythonWrapper = String.raw`import ctypes, json, os, runpy, sys, time
started = time.perf_counter()
code = 0
sys.argv = sys.argv[1:]
try:
    runpy.run_path(sys.argv[0], run_name="__main__")
except SystemExit as error:
    code = error.code if isinstance(error.code, int) else (1 if error.code else 0)
finally:
    peak = 0
    method = "unavailable"
    if os.name == "nt":
        class Counters(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        counter = Counters()
        counter.cb = ctypes.sizeof(counter)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
        if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counter), counter.cb):
            peak = counter.PeakWorkingSetSize
            method = "Windows PeakWorkingSetSize for the Python restore process"
    else:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if sys.platform != "darwin": peak *= 1024
        method = "OS ru_maxrss for the Python restore process"
    print("TRACEDOCK_PYTHON_METRICS " + json.dumps({"elapsedMs": round((time.perf_counter()-started)*1000), "peakRssBytes": peak, "memoryMethod": method}), file=sys.stderr)
sys.exit(code)
`;

async function child(command, args, marker = mark) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process.stdout.on('data', chunk => { const text = chunk.toString(); stdout += text; if (stdout.length > 2 * MiB) stdout = stdout.slice(-2 * MiB); for (const line of text.split('\n')) if (line.trim() && !line.startsWith(mark)) console.log(line.trim()); });
    process.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2 * MiB) stderr = stderr.slice(-2 * MiB); });
    process.once('error', reject);
    process.once('close', code => {
      if (code !== 0) return reject(new Error(`${command} exited ${code}\n${stderr}\n${stdout}`));
      const line = (stdout + '\n' + stderr).split(/\r?\n/).findLast(item => item.startsWith(marker));
      if (!line) return resolve({ stdout, stderr });
      try { resolve(JSON.parse(line.slice(marker.length))); } catch (error) { reject(error); }
    });
  });
}

async function runPhase(name, task, observe) {
  const started = performance.now();
  console.log(`[large] ${name} started`);
  let observation = Promise.resolve(), observing = false;
  const progress = () => {
    if (observing || !observe) return observation;
    observing = true;
    observation = observe().then(details => {
      console.log(`[large] ${name} after ${Math.round((performance.now() - started) / 1000)}s: ${details}`);
    }).catch(error => {
      // Diagnostics must not change the benchmark's result or its workload.
      console.log(`[large] ${name} progress unavailable: ${error.message}`);
    }).finally(() => { observing = false; });
    return observation;
  };
  const timer = observe ? setInterval(progress, 30000) : null;
  try {
    const result = await task();
    if (timer) clearInterval(timer);
    await observation;
    await progress();
    console.log(`[large] ${name} completed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
    return result;
  } catch (error) {
    console.log(`[large] ${name} failed after ${((performance.now() - started) / 1000).toFixed(1)}s`);
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    await observation;
  }
}

async function observeRestoration(directory, restored, fixture, timelineOnly) {
  const existing = new Set(await fsp.readdir(directory));
  const missingAs = (fallback) => error => {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  };
  return async () => {
    // restore.py writes into its own temporary result directory, then renames it
    // atomically. Inspect file metadata only; never read/parse the large payloads.
    const names = await fsp.readdir(directory);
    const candidates = [restored, ...names
      .filter(name => name.startsWith('.tracedock-restore-') && !existing.has(name))
      .map(name => path.join(directory, name, 'result'))];
    let timelineBytes = 0, htmlFiles = 0;
    for (const candidate of candidates) {
      const stat = await fsp.stat(path.join(candidate, 'timeline.jsonl')).catch(missingAs(null));
      const snapshots = await fsp.readdir(path.join(candidate, 'snapshots')).catch(missingAs([]));
      timelineBytes = Math.max(timelineBytes, stat?.size || 0);
      htmlFiles = Math.max(htmlFiles, snapshots.filter(name => /^\d+\.html$/.test(name)).length);
    }
    // A present file may still be growing. Byte equality and HTML hashes remain
    // checked by the separate verification phase; these are observed sizes only.
    return `timeline file ${timelineBytes}/${fixture.timeline.bytes} bytes; HTML files present ${htmlFiles}/${timelineOnly ? 0 : fixture.snapshots.length} (not yet verified)`;
  };
}

async function main() {
  if (flag('--help') || flag('-h')) {
    console.log('Usage: node scripts/large-recording.cjs [--gib 1] [--event-mib 64] [--encoding delta|full] [--compression deflate|store] [--timeline-only] [--reuse output/large-recording-...]');
    console.log('Creates a synthetic repeated-DOM/random-data JSONL workload, indexes it, exports it, runs the bundled Python tool and verifies every restored byte plus derived HTML hashes. Default workload is at least 1 GiB, with 64 MiB single events; reserve several GiB of disk space. --reuse keeps an existing fixture; successful restoration output is never overwritten.');
    return;
  }
  const config = { gib: Number(value('--gib', '1')), eventMiB: Number(value('--event-mib', '64')),
    encoding: value('--encoding', 'delta'), compression: value('--compression', 'deflate'), timelineOnly: flag('--timeline-only') };
  assert.ok(Number.isFinite(config.gib) && config.gib > 0 && config.gib <= 64);
  assert.ok(Number.isFinite(config.eventMiB) && config.eventMiB >= 1 && config.eventMiB <= 1024);
  assert.ok(['delta', 'full'].includes(config.encoding));
  assert.ok(['deflate', 'store'].includes(config.compression));
  const directory = checkedDirectory(value('--directory', value('--reuse', path.join(outputRoot, `large-recording-${new Date().toISOString().replace(/[:.]/g, '-')}`))));
  await fsp.mkdir(directory, { recursive: true });
  if (flag('--reuse')) {
    const existing = JSON.parse(await fsp.readFile(path.join(directory, 'fixture.json'), 'utf8'));
    config.gib = existing.requestedGiB;
    config.eventMiB = existing.eventMiB;
  }
  if (phase) {
    const operation = { generate: () => generate(directory, config), index: () => indexFixture(directory), export: () => exportFixture(directory, config), verify: () => verifyFixture(directory, config) }[phase];
    assert.ok(operation, 'unknown benchmark phase');
    console.log(mark + JSON.stringify(await measured(operation)));
    return;
  }
  const report = { synthetic: true, config, directory, generatedAt: new Date().toISOString(), passed: false, phases: {},
    scope: 'Measured fixture is synthetic. Source bytes, independent restoration hashes and giant derived HTML are checked. This does not assert a universal compression ratio.' };
  const save = () => fsp.writeFile(path.join(directory, `report-${config.encoding}-${config.compression}.json`), JSON.stringify(report, null, 2));
  const argsFor = name => [__filename, '--phase', name, '--directory', directory, '--gib', String(config.gib), '--event-mib', String(config.eventMiB), '--encoding', config.encoding, '--compression', config.compression, ...(config.timelineOnly ? ['--timeline-only'] : [])];
  try {
    console.log(`Synthetic recording benchmark: ${directory}`);
    if (!flag('--reuse')) report.phases.generate = await runPhase('generate', () => child(process.execPath, argsFor('generate')));
    if (!flag('--skip-store')) report.phases.index = await runPhase('index and search', () => child(process.execPath, argsFor('index')));
    await save();
    report.phases.export = await runPhase('export', () => child(process.execPath, argsFor('export')));
    await save();
    const filename = path.join(directory, `${config.encoding}-${config.compression}.zip`);
    const script = path.join(directory, 'bundled-restore.py');
    const wrapper = path.join(directory, 'measure-python.py');
    await fsp.writeFile(wrapper, pythonWrapper);
    await runPhase('extract bundled restorer', () => child(python, ['-c', 'import pathlib,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nfor name,out in [("restore.py",sys.argv[2]),("session.json",sys.argv[3])]:\n info=z.getinfo(name)\n assert info.file_size < 4*1024*1024\n pathlib.Path(out).write_bytes(z.read(info))', filename, script, path.join(directory, 'bundled-session.json')]));
    const restored = path.join(directory, `restored-${config.encoding}-${config.compression}`);
    const fixture = JSON.parse(await fsp.readFile(path.join(directory, 'fixture.json'), 'utf8'));
    const observe = await observeRestoration(directory, restored, fixture, config.timelineOnly);
    report.phases.restore = await runPhase('Python restore', () => child(python, [wrapper, script, filename, '--output', restored, ...(config.timelineOnly ? ['--timeline-only'] : [])], 'TRACEDOCK_PYTHON_METRICS '), observe);
    report.phases.verify = await runPhase('verify original bytes and HTML hashes', () => child(process.execPath, argsFor('verify')));
    report.timeline = fixture.timeline;
    report.dataZipRatio = report.phases.export.zipBytes / fixture.timeline.bytes;
    report.passed = true;
  } catch (error) {
    report.error = error.stack || error.message;
    throw error;
  } finally { await save(); }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
