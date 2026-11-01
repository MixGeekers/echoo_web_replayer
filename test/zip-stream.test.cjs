'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const { makeArchive, crc32 } = require('../src/delta-zip.cjs');
const run = promisify(execFile);

async function workspace(t) {
  const parent = path.resolve(__dirname, '../output/test-temp');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'zip-stream-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
test('CRC32 supports incremental chunks', () => {
  assert.equal(crc32(0, Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(crc32(0, Buffer.from('1234')), Buffer.from('56789')), 0xcbf43926);
});
for (const compression of ['store', 'deflate']) {
  test(`ZIP64 ${compression} is readable with CRC and hashes through Python and AdmZip`, async t => {
    const directory = await workspace(t);
    const contents = [Buffer.alloc(0), Buffer.from('中文 😀 \u0000\r\n'.repeat(20000)), Buffer.from(Array.from({ length: 300000 }, (_, n) => n % 251))];
    const names = ['empty.txt', '快照/页面.json', 'binary.dat'];
    for (let i = 0; i < contents.length; i++) await fs.writeFile(path.join(directory, String(i)), contents[i]);
    const destination = path.join(directory, 'result.zip');
    const result = await makeArchive({ compression, destination, entries: (async function* () {
      for (let i = 0; i < contents.length; i++) yield { name: names[i], path: path.join(directory, String(i)) };
    })() });
    assert.equal(result.entries, contents.length);
    assert.equal(result.bytes, (await fs.stat(destination)).size);
    const archive = new AdmZip(destination);
    for (let i = 0; i < contents.length; i++) assert.deepEqual(archive.readFile(names[i]), contents[i]);
    const script = 'import zipfile,sys,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps([{\"name\":i.filename,\"method\":i.compress_type,\"bytes\":i.file_size,\"hash\":hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]))';
    const { stdout } = await run(process.env.TRACEDOCK_PYTHON || 'python', ['-c', script, destination]);
    const entries = JSON.parse(stdout);
    for (let i = 0; i < contents.length; i++) {
      assert.equal(entries[i].name, names[i]);
      assert.equal(entries[i].method, compression === 'store' ? 0 : 8);
      assert.equal(entries[i].bytes, contents[i].length);
      assert.equal(entries[i].hash, createHash('sha256').update(contents[i]).digest('hex'));
    }
    assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.central')), false);
  });
}
test('empty ZIP64 archive and disk-spooled large entry count are valid', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'empty'); await fs.writeFile(source, '');
  for (const count of [0, 65536]) {
    const destination = path.join(directory, `${count}.zip`);
    await makeArchive({ destination, compression: 'store', entries: (async function* () {
      for (let i = 0; i < count; i++) yield { name: `${i}.txt`, path: source };
    })() });
    const { stdout } = await run(process.env.TRACEDOCK_PYTHON || 'python', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.infolist()))', destination]);
    assert.equal(Number(stdout.trim()), count);
  }
});
test('cancellation and invalid paths clean only newly created ZIP files', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'input'); await fs.writeFile(source, Buffer.alloc(1024 * 1024, 97));
  const destination = path.join(directory, 'cancel.zip');
  const controller = new AbortController();
  await assert.rejects(makeArchive({ destination, compression: 'store', signal: controller.signal,
    onProgress: () => controller.abort(), entries: [{ name: 'input', path: source }] }), /取消|abort/i);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${destination}.central`), { code: 'ENOENT' });
  const existing = path.join(directory, 'existing.zip'); await fs.writeFile(existing, 'keep');
  await assert.rejects(makeArchive({ destination: existing, entries: [] }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep');
  await assert.rejects(makeArchive({ destination, entries: [{ name: '../escape', path: source }] }), /相对/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});
