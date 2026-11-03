'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const AdmZip = require('adm-zip');
const { SessionStore } = require('../out/session-store.cjs');
const { exportSession } = require('../out/exporter.cjs');
const { generateRecordingScript } = require('../out/codegen.cjs');

const run = promisify(execFile);
const python = process.env.TRACEDOCK_PYTHON || 'python';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function setup(t) {
  const root = path.resolve(__dirname, '../output/test-temp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'codegen-export-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new SessionStore(path.join(directory, 'sessions')).init();
  const session = await store.create('脚本导出 · 表单', 'https://example.test/form', { id: 'profile-00000000-0000-4000-8000-000000000001', name: '测试环境' }, 'group-00000000-0000-4000-8000-000000000001');
  const scope = { framePath: [], frameContexts: [], frameUrl: 'https://example.test/form', shadowPath: [], rootId: 'n1' };
  const target = { nodeId: 'n2', nodeType: 1, nodeName: 'INPUT', tagName: 'input', selector: '#q', scope, attributes: { id: 'q' }, text: '', locators: [{ strategy: 'id', value: 'q' }, { strategy: 'placeholder', value: '搜索' }] };
  const mods = { alt: false, ctrl: false, meta: false, shift: false };
  await store.append(session.id, { type: 'session.start', url: 'https://example.test/form', payload: { name: session.name, appVersion: 'test', redaction: false } });
  await store.append(session.id, { type: 'dom.snapshot', url: 'https://example.test/form', payload: { reason: 'recording-start', html: `<html><body>${'<p>x</p>'.repeat(2000)}<input id="q"></body></html>`, tree: { nodeId: 'n1', nodeName: '#document', nodeType: 9 }, forms: [] } });
  await store.append(session.id, { type: 'action.input', url: 'https://example.test/form', documentId: 'd1', payload: { target, trusted: true, modifiers: mods, form: { nodeId: 'n2', selector: '#q', scope, tagName: 'input', name: null, type: null, value: '耳机' }, isComposing: false } });
  await store.append(session.id, { type: 'action.keydown', url: 'https://example.test/form', documentId: 'd1', payload: { target, trusted: true, modifiers: mods, key: 'Enter', code: 'Enter', repeat: false, isComposing: false } });
  await store.append(session.id, { type: 'dom.mutation', url: 'https://example.test/form', payload: { records: [], recordCount: 0, batchIntervalMs: 150 } });
  await store.append(session.id, { type: 'page.navigation', url: 'https://example.test/results?q=1', payload: { url: 'https://example.test/results?q=1', sameDocument: false } });
  await store.update(session.id, { status: 'stopped', endedAt: new Date().toISOString() });
  return { directory, store, session };
}

for (const encoding of ['delta', 'full']) {
  test(`${encoding}: opt-in script.spec.ts is checksummed, documented and restored`, { timeout: 120000 }, async (t) => {
    const { directory, store, session } = await setup(t);
    const capture = await store.capture(session.id);
    const filename = path.join(directory, `${encoding}.zip`);
    await exportSession({ store, sessionId: session.id, capture, destination: filename, encoding, compression: 'deflate', appVersion: 'codegen-test', script: true });
    const archive = new AdmZip(filename);
    const script = archive.readFile('script.spec.ts');
    assert.ok(script, 'script.spec.ts is in the ZIP');
    const code = script.toString('utf8');
    assert.match(code, /import \{ test, expect \} from '@playwright\/test';/);
    assert.match(code, /await page\.goto\('https:\/\/example\.test\/form'\);/);
    assert.match(code, /await page\.getByPlaceholder\('搜索'\)\.fill\('耳机'\);/);
    assert.match(code, /await page\.getByPlaceholder\('搜索'\)\.press\('Enter'\);/);
    assert.match(code, /await expect\(page\)\.toHaveURL\('https:\/\/example\.test\/results\?q=1'\);/);
    assert.match(code, new RegExp(`生成时间：${capture.capturedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'deterministic: generation time is the export boundary');
    const entry = { path: 'script.spec.ts', bytes: script.length, sha256: digest(script) };
    const listed = archive.readAsText('files.jsonl').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(listed.find((item) => item.path === 'script.spec.ts'), entry);
    const manifest = JSON.parse(archive.readAsText('manifest.json'));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.playwrightScript, 'script.spec.ts');
    assert.deepEqual(manifest.files.find((item) => item.path === 'script.spec.ts'), entry);
    assert.match(archive.readAsText('AGENT_README.md'), /## 附带的 Playwright 脚本[\s\S]*script\.spec\.ts/);
    // Same boundary, same generator: the UI/MCP path produces the identical script.
    const direct = await generateRecordingScript(store, session.id, { generatedAt: capture.capturedAt });
    assert.equal(direct.code, code);

    const restoreScript = path.join(directory, 'restore.py');
    await fs.writeFile(restoreScript, archive.readFile('restore.py'));
    const output = path.join(directory, 'restored');
    await run(python, [restoreScript, filename, '--output', output], { windowsHide: true, timeout: 60000 });
    assert.deepEqual(await fs.readFile(path.join(output, 'script.spec.ts')), script);
    const restored = (await fs.readFile(path.join(output, 'restored-files.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(restored.some((item) => item.path === 'script.spec.ts' && item.sha256 === entry.sha256));
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'restore-report.json'), 'utf8')).status, 'ok');

    // A tampered script is rejected by checksum verification.
    const tampered = path.join(directory, 'tampered');
    await fs.mkdir(tampered);
    archive.extractAllTo(tampered, true);
    await fs.appendFile(path.join(tampered, 'script.spec.ts'), '// injected\n');
    await assert.rejects(run(python, [restoreScript, tampered, '--output', path.join(directory, 'bad')], { windowsHide: true, timeout: 60000 }), /length mismatch|Missing\/duplicate file descriptor/);
  });
}

test('script is off by default: package layout unchanged', { timeout: 60000 }, async (t) => {
  const { directory, store, session } = await setup(t);
  const filename = path.join(directory, 'plain.zip');
  await exportSession({ store, sessionId: session.id, destination: filename, appVersion: 'codegen-test' });
  const archive = new AdmZip(filename);
  assert.equal(archive.getEntry('script.spec.ts'), null);
  assert.ok(!archive.readAsText('files.jsonl').includes('script.spec.ts'));
  assert.equal(JSON.parse(archive.readAsText('manifest.json')).playwrightScript, undefined);
  assert.doesNotMatch(archive.readAsText('AGENT_README.md'), /附带的 Playwright 脚本/);
});
