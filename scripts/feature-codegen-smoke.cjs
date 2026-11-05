'use strict';

// Real desktop acceptance for 「生成脚本」: record on the built-in demo page, generate
// the Playwright script in the UI, copy/save/export it, then execute the generated
// TypeScript against the same local demo page with playwright-core's Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron, chromium } = require('playwright-core');
const esbuild = require('esbuild');
const AdmZip = require('adm-zip');

const root = path.resolve(__dirname, '..');
const executablePath = require('electron');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = path.join(root, 'output', `codegen-data-${runId}`);
const screens = path.join(root, 'output', 'screens');
const artifacts = path.join(root, 'output', 'playwright', `codegen-${runId}`);
const python = process.env.TRACEDOCK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const logs = [];
const errors = [];
let desktop;
let browser;

async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}
async function step(label, task) {
  await task();
  console.log(`PASS ${label}`);
}
async function screenshot(name) {
  const base64 = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((value) => value.webContents.getURL().includes('/renderer/'));
    return (await window.capturePage()).toPNG().toString('base64');
  });
  const file = path.join(screens, name);
  await fs.writeFile(file, Buffer.from(base64, 'base64'));
  return file;
}
const state = (ui) => ui.evaluate(() => window.collector.getState());
const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal @playwright/test stand-in so the generated spec runs on playwright-core. */
function shimmedRunner(code) {
  const js = esbuild.transformSync(code, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const tests = [];
  const expect = (page) => ({
    toHaveURL: (url) => page.waitForURL(url, { timeout: 5000 }),
  });
  const test = (name, body) => tests.push({ name, body });
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', js)((id) => {
    if (id === '@playwright/test') return { test, expect };
    throw new Error(`unexpected import ${id}`);
  }, { exports: {} }, {});
  return tests;
}

async function run() {
  await fs.mkdir(screens, { recursive: true });
  await fs.mkdir(artifacts, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const env = { ...process.env, TRACEDOCK_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath, args: [root], cwd: root, env, timeout: 30000 });
  desktop.process().stdout?.on('data', (data) => logs.push(data.toString()));
  desktop.process().stderr?.on('data', (data) => logs.push(data.toString()));
  desktop.context().on('page', (page) => page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`)));
  const ui = await until(() => desktop.context().pages().find((page) => page.url().includes('/renderer/index.html')), 'workbench');
  const guest = await until(() => desktop.context().pages().find((page) => page.url().includes('/demo/index.html')), 'demo page');
  ui.on('pageerror', (error) => errors.push(`ui: ${error.message}`));
  await ui.waitForFunction(() => Boolean(window.collector));
  await guest.waitForLoadState('load');
  await ui.waitForFunction(async () => !(await window.collector.getState()).browser.loading);
  const demoURL = guest.url();

  let recordingId;
  await step('record a realistic session on the 交互实验室 demo page', async () => {
    await ui.locator('#new-session-button').click();
    await ui.locator('#management-name').fill('脚本生成验收');
    await ui.locator('#management-confirm').click();
    await ui.locator('#management-dialog').waitFor({ state: 'hidden' });
    await ui.locator('#start-button').click();
    await ui.locator('#session-name-input').fill('反馈表单 · 生成脚本');
    await ui.locator('#confirm-session-button').click();
    const session = await until(async () => { const s = (await state(ui)).session; return s?.status === 'recording' && s; }, 'recording starts');
    recordingId = session.id;
    await until(async () => (await state(ui)).session.snapshotCount > 0, 'baseline snapshot');
    // Real keyboard typing produces keydown + input per character; the generator merges them.
    await guest.locator('#demo-name').click();
    await guest.locator('#demo-name').pressSequentially('TraceDock', { delay: 15 });
    await guest.locator('#demo-email').fill('codegen@example.test');
    await guest.locator('#demo-category').selectOption('bug');
    await guest.locator('#demo-password').fill('P@ss "quoted" \\ 中文');
    await guest.locator('#demo-note').fill("第一行\n第二行 it's");
    await guest.locator('label.checkbox span').click();
    await guest.locator('#counter-increase').click();
    await guest.locator('#counter-increase').click();
    await guest.locator('#toggle-attribute').click();
    await guest.locator('#demo-submit').click();
    await guest.locator('#form-result[data-submitted="true"]').waitFor();
    await guest.locator('#task-input').fill('写自动化脚本');
    await guest.locator('#task-input').press('Enter');
    await guest.locator('#task-list li', { hasText: '写自动化脚本' }).waitFor();
    await guest.locator('#shadow-button').click();
    await guest.frameLocator('#demo-frame').locator('#frame-input').fill('iframe 里的输入');
    await guest.locator('#demo-route').click();
    await guest.waitForURL(/#notes$/);
    await settle(400);
    await ui.locator('#stop-button').click();
    await until(async () => (await state(ui)).sessions.find((s) => s.id === recordingId)?.status === 'stopped', 'recording stops');
  });

  let tsCode;
  await step('「生成脚本」 opens a monospace TypeScript view with the expected statements', async () => {
    await until(() => ui.locator('#codegen-button').isEnabled(), 'generate button enabled for the selected recording');
    await screenshot('feature-codegen-entry.png');
    await ui.locator('#codegen-button').click();
    await ui.locator('#codegen-dialog[open]').waitFor();
    await until(async () => (await ui.locator('#codegen-code').textContent()).includes('page.goto('), 'script rendered');
    tsCode = await ui.locator('#codegen-code').textContent();
    await fs.writeFile(path.join(artifacts, 'generated.spec.ts'), tsCode);
    const expected = [
      "import { test, expect } from '@playwright/test';",
      `await page.goto('${demoURL}');`,
      "await page.getByLabel('称呼').fill('TraceDock');",
      "await page.getByLabel('邮箱').fill('codegen@example.test');",
      "await page.getByLabel('反馈类型').selectOption('bug');",
      "await page.getByLabel('测试密码').fill('P@ss \"quoted\" \\\\ 中文');",
      "await page.getByLabel('想法').fill('第一行\\n第二行 it\\'s');",
      "await page.getByLabel('接收后续进展').check();",
      "await page.getByRole('button', { name: '增加计数', exact: true }).click();",
      "await page.getByRole('button', { name: '切换状态 ↗' }).click();",
      "await page.getByRole('button', { name: '提交反馈 ↗' }).click();",
      "await page.getByLabel('新待办事项').fill('写自动化脚本');",
      "await page.getByLabel('新待办事项').press('Enter');",
      "await page.locator('#shadow-host').getByRole('button', { name: '点击组件按钮 ↗' }).click();",
      "await page.frameLocator('#demo-frame').getByLabel('iframe 测试输入').fill('iframe 里的输入');",
      "await page.getByRole('link', { name: '试试页面内跳转 ↓' }).click();",
      `await expect(page).toHaveURL('${demoURL}#notes');`,
    ];
    for (const line of expected) assert.ok(tsCode.includes(line), `script contains: ${line}\n---\n${tsCode}`);
    assert.equal(tsCode.split("getByRole('button', { name: '增加计数', exact: true }).click();").length - 1, 2, 'two counter clicks stay two clicks');
    assert.doesNotMatch(tsCode, /keyboard\.press\('T'\)|press\('r'\)/, 'typed characters are covered by fill');
    assert.doesNotMatch(tsCode, /getByText\('接收后续进展'\)\.click/, 'label activation click is folded into check()');
    assert.doesNotMatch(tsCode, /requestSubmit/, 'click/Enter-triggered submits are not duplicated');
    assert.doesNotMatch(tsCode, /添加事项/, 'implicit-submission click on the default button is folded into the Enter press');
    assert.match(tsCode, /\/\/ seq \d+(-\d+)?\n\s+await page\.getByLabel\('称呼'\)\.fill\('TraceDock'\);/);
    assert.match(tsCode, /\/\/ 采集记录：反馈表单 · 生成脚本/);
    assert.match(await ui.locator('#codegen-stats').textContent(), /\d+ 个步骤 · \d+ 个 TODO/);
    const font = await ui.locator('#codegen-code').evaluate((node) => getComputedStyle(node).fontFamily);
    assert.match(font, /mono|Consolas|Menlo/i, 'code uses the monospace token');
    await ui.locator('#codegen-code').evaluate((node) => { node.scrollTop = 0; });
    await settle(200);
    await screenshot('feature-codegen-typescript.png');
  });

  await step('复制 puts the exact script on the clipboard; 保存为文件 writes it through the main-process dialog', async () => {
    await desktop.evaluate(({ clipboard }) => clipboard.writeText(''));
    await ui.locator('#codegen-copy').click();
    await until(async () => (await ui.locator('#toast-title').textContent()) === '脚本已复制', 'copy toast');
    const copied = await until(() => desktop.evaluate(({ clipboard }) => clipboard.readText()), 'clipboard has the script');
    // Clipboard API text is converted to native CRLF line endings on Windows.
    assert.equal(process.platform === 'win32' ? copied.replace(/\r\n/g, '\n') : copied, tsCode);
    const target = path.join(artifacts, 'saved.spec.ts');
    await desktop.evaluate(({ dialog }, filePath) => {
      globalThis.codegenSaveOptions = null;
      dialog.showSaveDialog = async (_win, options) => { globalThis.codegenSaveOptions = options; return { canceled: false, filePath }; };
    }, target);
    await ui.locator('#codegen-save').click();
    await until(() => fss.existsSync(target), 'saved file');
    assert.equal(await fs.readFile(target, 'utf8'), tsCode);
    const options = await desktop.evaluate(() => globalThis.codegenSaveOptions);
    assert.match(options.defaultPath, /反馈表单 · 生成脚本\.spec\.ts$/);
    assert.deepEqual(options.filters[0].extensions, ['ts']);
    await until(async () => (await ui.locator('#toast-title').textContent()) === '脚本已保存', 'save toast');
  });

  await step('Python switch renders pytest-playwright sync code', async () => {
    await ui.locator('#codegen-dialog [data-language="python"]').click();
    await until(async () => (await ui.locator('#codegen-code').textContent()).includes('def test_tracedock_recording'), 'python script');
    const py = await ui.locator('#codegen-code').textContent();
    await fs.writeFile(path.join(artifacts, 'test_generated.py'), py);
    assert.ok(py.includes('page.get_by_label("称呼").fill("TraceDock")'));
    assert.ok(py.includes('page.frame_locator("#demo-frame").get_by_label("iframe 测试输入").fill("iframe 里的输入")'));
    assert.ok(py.includes(`expect(page).to_have_url("${demoURL}#notes")`));
    await promisify(execFile)(python, ['-m', 'py_compile', path.join(artifacts, 'test_generated.py')]);
    assert.equal(await ui.locator('#codegen-dialog [data-language="python"]').getAttribute('aria-pressed'), 'true');
    await settle(200);
    await screenshot('feature-codegen-python.png');
    await ui.locator('#codegen-dialog [data-language="typescript"]').click();
    // Only the 生成时间 header differs between two generations of the same stopped recording.
    const stable = (code) => code.replace(/^\/\/ 生成时间：.*$/m, '');
    await until(async () => stable(await ui.locator('#codegen-code').textContent()) === stable(tsCode), 'back to TypeScript');
    await ui.locator('#codegen-done').click();
    await ui.locator('#codegen-dialog').waitFor({ state: 'hidden' });
  });

  await step('export option 「附带 Playwright 脚本」 adds a verified script.spec.ts to the ZIP', async () => {
    await ui.locator('#export-button').click();
    await ui.locator('#export-dialog[open]').waitFor();
    assert.equal(await ui.locator('#export-script').isChecked(), false, 'opt-in by default');
    await ui.locator('#export-script').check();
    await settle(300);
    await screenshot('feature-codegen-export-option.png');
    const zip = path.join(artifacts, 'with-script.zip');
    await desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, zip);
    await ui.locator('#export-confirm-button').click();
    await until(async () => (await ui.locator('#toast-title').textContent()) === 'ZIP 导出成功', 'export finishes', 60000);
    const archive = new AdmZip(zip);
    const script = archive.readAsText('script.spec.ts');
    assert.match(script, /getByLabel\('称呼'\)\.fill\('TraceDock'\)/);
    assert.ok(archive.readAsText('files.jsonl').includes('"path":"script.spec.ts"'));
    assert.equal(JSON.parse(archive.readAsText('manifest.json')).playwrightScript, 'script.spec.ts');
    const restoreDir = path.join(artifacts, 'restored');
    await fs.writeFile(path.join(artifacts, 'restore.py'), archive.readFile('restore.py'));
    await promisify(execFile)(python, [path.join(artifacts, 'restore.py'), zip, '--output', restoreDir]);
    assert.equal(await fs.readFile(path.join(restoreDir, 'script.spec.ts'), 'utf8'), script);
  });

  await step('the generated TypeScript runs against the same local demo page in Chromium', async () => {
    const executable = ['/opt/pw-browsers/chromium'].find((file) => { try { return fss.statSync(file).isFile(); } catch { return false; } });
    browser = await chromium.launch(executable ? { executablePath: executable } : {});
    const tests = shimmedRunner(tsCode);
    assert.equal(tests.length, 1);
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(5000);
    await tests[0].body({ page });
    assert.equal(await page.locator('#counter-value').textContent(), '2');
    assert.equal(await page.locator('#attribute-panel').getAttribute('data-mode'), 'active');
    assert.equal(await page.locator('#form-result strong').textContent(), '已收到，TraceDock！');
    assert.match(await page.locator('#form-result span').textContent(), /^问题报告：第一行\n第二行 it's 已订阅后续进展。$/);
    assert.equal(await page.locator('#demo-password').inputValue(), 'P@ss "quoted" \\ 中文');
    assert.equal(await page.locator('#task-list li').count(), 3, 'exactly one task added');
    assert.ok(await page.locator('#task-list li', { hasText: '写自动化脚本' }).count());
    assert.equal(await page.locator('#shadow-value').textContent(), '已点击 1 次');
    assert.equal(await page.frameLocator('#demo-frame').locator('#frame-input').inputValue(), 'iframe 里的输入');
    assert.match(page.url(), /#notes$/);
    await page.screenshot({ path: path.join(screens, 'feature-codegen-replayed-in-chromium.png'), fullPage: false });
  });

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
}

run()
  .then(async () => {
    console.log(`Screens: ${screens}`);
    console.log(`Artifacts: ${artifacts}`);
  })
  .catch(async (error) => {
    console.error(error);
    console.error(logs.join('').slice(-4000));
    try { if (desktop) await screenshot('feature-codegen-failure.png'); } catch {}
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close().catch(() => {});
    await desktop?.close().catch(() => {});
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, 'electron.log'), logs.join(''));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
