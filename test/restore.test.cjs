'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const { SessionStore } = require('../src/session-store.cjs');
const { exportSession } = require('../src/exporter.cjs');

const exec = promisify(execFile);
const python = process.env.TRACEDOCK_PYTHON || 'python';
const script = path.resolve(__dirname, '../src/restore.py');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');

async function setup(t) {
  const root = path.resolve(__dirname, '../output/test-temp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'restore-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(root + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function runRestore(source, output, extra = []) {
  return exec(python, [script, source, '--output', output, ...extra], {
    timeout: 120000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
}

async function recording(directory, { metadata = false } = {}) {
  const store = await new SessionStore(path.join(directory, 'sessions')).init();
  const session = await store.create('Python还原边界');
  const html = '<html>' + '中文😀é\u0000\\"'.repeat(150000) + '\ud800' + '</html>';
  const title = metadata ? '完整标题'.repeat(90000) : '原始标题';
  const snapshot = await store.append(session.id, {
    payload: { html, reason: 'checkpoint', tree: { id: 'a', children: [] }, forms: [{ value: '\ud800\u0000😀' }], empty: '', negativeZero: -0 },
    type: 'dom.snapshot', title, documentId: 'document-one',
  });
  await store.append(session.id, { type: 'action.click', payload: { target: { selector: '#after' } } });
  await store.update(session.id, { status: 'stopped' });
  const zip = path.join(directory, 'source.zip');
  await exportSession({ store, sessionId: session.id, destination: zip });
  const archive = new AdmZip(zip);
  const entries = new Map(archive.getEntries().filter(e => !e.isDirectory).map(e => [e.entryName, archive.readFile(e)]));
  const timeline = await fs.readFile(path.join(store.getSessionDirectory(session.id), 'timeline.jsonl'));
  return { entries, zip, timeline, snapshot, title };
}

function indexOf(entries) {
  return entries.get('index.jsonl').toString('utf8').trim().split('\n').map(JSON.parse);
}

function saveIndex(entries, index) {
  entries.set('index.jsonl', Buffer.concat(index.map(json)));
}

function rehash(entries) {
  const manifest = JSON.parse(entries.get('manifest.json'));
  const descriptor = name => ({ path: name, bytes: entries.get(name).length, sha256: sha(entries.get(name)) });
  entries.set('files.jsonl', Buffer.concat([...entries.keys()].filter(name => !['manifest.json', 'files.jsonl'].includes(name)).map(name => json(descriptor(name)))));
  manifest.files = manifest.files.map(item => descriptor(item.path));
  entries.set('manifest.json', json(manifest));
}

async function writePackage(directory, filename, entries) {
  const archive = new AdmZip();
  for (const [name, bytes] of entries) archive.addFile(name, bytes);
  const file = path.join(directory, filename);
  await fs.writeFile(file, archive.toBuffer());
  return file;
}

async function rejectsWithoutPartial(directory, source, name, pattern) {
  const output = path.join(directory, name);
  await assert.rejects(runRestore(source, output), error => {
    assert.match(error.stderr, pattern);
    return true;
  });
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  assert.equal((await fs.readdir(directory)).filter(name => name.startsWith('.tracedock-restore-')).length, 0);
}

test('offline restoration preserves huge metadata and handles surrogate/UTF-8 HTML without whole-event parsing', { timeout: 120000 }, async t => {
  const directory = await setup(t);
  const fixture = await recording(directory, { metadata: true });
  const output = path.join(directory, 'restored');
  await runRestore(fixture.zip, output);
  assert.deepEqual(await fs.readFile(path.join(output, 'timeline.jsonl')), fixture.timeline);
  const html = await fs.readFile(path.join(output, 'snapshots/00000001.html'));
  assert.deepEqual(html, Buffer.from(fixture.snapshot.payload.html, 'utf8'));
  const state = JSON.parse(await fs.readFile(path.join(output, 'snapshots/00000001.state.json'), 'utf8'));
  assert.equal(state.title, fixture.title);
  assert.deepEqual(state.forms, fixture.snapshot.payload.forms);
  const report = JSON.parse(await fs.readFile(path.join(output, 'restore-report.json'), 'utf8'));
  assert.equal(report.timeline.sha256, sha(fixture.timeline));
  await assert.rejects(runRestore(fixture.zip, output), /already exists/);
  assert.deepEqual(await fs.readFile(path.join(output, 'timeline.jsonl')), fixture.timeline);
});

test('unpacked input and timeline-only restore preserve facts without creating snapshot derivatives', { timeout: 120000 }, async t => {
  const directory = await setup(t);
  const fixture = await recording(directory);
  const source = path.join(directory, 'unpacked');
  await fs.mkdir(source);
  for (const [name, bytes] of fixture.entries) await fs.writeFile(path.join(source, name), bytes);
  const output = path.join(directory, 'facts');
  await runRestore(source, output, ['--timeline-only']);
  assert.deepEqual(await fs.readFile(path.join(output, 'timeline.jsonl')), fixture.timeline);
  await assert.rejects(fs.access(path.join(output, 'snapshots')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'restore-report.json'))).derivedFiles, 0);
});

test('restoration rejects corrupt checksums, cross-window COPY, checkpoint tampering and trailing data atomically', { timeout: 120000 }, async t => {
  const directory = await setup(t);
  const fixture = await recording(directory);
  const variants = [
    ['bad-physical-hash', entries => {
      const data = Buffer.from(entries.get('data.bin')); data[0] ^= 1; entries.set('data.bin', data);
    }, /SHA-256\/length mismatch/],
    ['bad-block-hash', entries => {
      const data = Buffer.from(entries.get('data.bin')); data[0] ^= 1; entries.set('data.bin', data); rehash(entries);
    }, /Encoded block 0 hash mismatch/],
    ['bad-copy-range', entries => {
      const index = indexOf(entries);
      const part = index.find(item => item.mode === 'delta');
      assert.ok(part, 'fixture contains a real delta block');
      const before = entries.get('data.bin').subarray(0, part.dataOffset);
      const after = entries.get('data.bin').subarray(part.dataOffset + part.dataBytes);
      const bad = Buffer.alloc(9); bad[0] = 1; bad.writeUInt32LE(part.windowBytes, 1); bad.writeUInt32LE(1, 5);
      const change = bad.length - part.dataBytes;
      part.dataBytes = bad.length; part.dataSha256 = sha(bad);
      for (const item of index) if (item.index > part.index) item.dataOffset += change;
      entries.set('data.bin', Buffer.concat([before, bad, after])); saveIndex(entries, index); rehash(entries);
    }, /COPY outside verified window/],
    ['bad-checkpoint', entries => {
      const index = indexOf(entries); index[0].checkpoint = false; saveIndex(entries, index); rehash(entries);
    }, /Invalid checkpoint/],
    ['unknown-opcode', entries => {
      const index = indexOf(entries), part = index.find(item => item.mode === 'delta');
      assert.ok(part);
      const data = Buffer.from(entries.get('data.bin')); data[part.dataOffset] = 255;
      part.dataSha256 = sha(data.subarray(part.dataOffset, part.dataOffset + part.dataBytes));
      entries.set('data.bin', data); saveIndex(entries, index); rehash(entries);
    }, /Invalid COPY opcode/],
    ['wrong-window', entries => {
      const index = indexOf(entries); index[1].windowBytes--;
      saveIndex(entries, index); rehash(entries);
    }, /Invalid delta windowBytes/],
    ['extra-data', entries => {
      entries.set('data.bin', Buffer.concat([entries.get('data.bin'), Buffer.from('extra')])); rehash(entries);
    }, /trailing delta bytes/],
    ['bad-count', entries => {
      const manifest = JSON.parse(entries.get('manifest.json')); manifest.eventCount++; entries.set('manifest.json', json(manifest));
    }, /event count\/lastSeq mismatch/],
  ];
  for (const [name, mutate, expected] of variants) {
    await t.test(name, async () => {
      const entries = new Map([...fixture.entries].map(([key, value]) => [key, Buffer.from(value)]));
      mutate(entries);
      const source = await writePackage(directory, name + '.zip', entries);
      await rejectsWithoutPartial(directory, source, name + '-output', expected);
    });
  }
});

test('restoration rejects malformed ZIPs and case-colliding archive paths', { timeout: 120000 }, async t => {
  const directory = await setup(t);
  const fixture = await recording(directory);
  const duplicate = new Map(fixture.entries);
  duplicate.set('SESSION.json', duplicate.get('session.json'));
  rehash(duplicate);
  await rejectsWithoutPartial(directory, await writePackage(directory, 'duplicate.zip', duplicate), 'duplicate-output', /Duplicate archive path/);
  const bytes = await fs.readFile(fixture.zip);
  const truncated = path.join(directory, 'truncated.zip');
  await fs.writeFile(truncated, bytes.subarray(0, bytes.length - 30));
  await rejectsWithoutPartial(directory, truncated, 'truncated-output', /ZIP end record missing|Truncated/);
  const unsafe = path.join(directory, 'unsafe.zip');
  const changed = Buffer.from(bytes);
  let at = 0;
  while ((at = changed.indexOf(Buffer.from('session.json'), at)) !== -1) {
    Buffer.from('../evil.json').copy(changed, at); at += 12;
  }
  await fs.writeFile(unsafe, changed);
  await rejectsWithoutPartial(directory, unsafe, 'unsafe-output', /Unsafe file/);
});
