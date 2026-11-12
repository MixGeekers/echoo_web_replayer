const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  generateScript, generateFromTimeline, readCodegenEvents, chooseLocator, cssEscape, tsString, pyString, seqLabel, leadingType,
} = require('../out/codegen.cjs');

const START = 'https://shop.example/';
const scope = (extra = {}) => ({ framePath: [], frameContexts: [], frameUrl: START, shadowPath: [], rootId: 'n1', ...extra });
function el(nodeId, tag, locators = [], { attributes = {}, text = '', selector = `#${nodeId}`, scope: s = scope() } = {}) {
  return { nodeId, nodeType: 1, nodeName: tag.toUpperCase(), tagName: tag, selector, scope: s, attributes, text, locators };
}
function timeline() {
  let seq = 0;
  const events = [];
  const add = (type, payload = {}, extra = {}) => {
    seq++;
    events.push({ type, seq, url: START, title: 't', documentId: 'doc-1', timestamp: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), elapsedMs: seq * 1000, payload, ...extra });
    return seq;
  };
  return { events, add, start: () => add('session.start', { name: 'r' }) };
}
const mods = { alt: false, ctrl: false, meta: false, shift: false };
const click = (target, extra = {}) => ({ target, trusted: true, modifiers: mods, position: { clientX: 10, clientY: 20, pageX: 10, pageY: 20, screenX: 0, screenY: 0 }, button: 0, detail: 1, ...extra });
const input = (target, value, extra = {}) => ({ target, trusted: true, modifiers: mods, form: { nodeId: target.nodeId, selector: target.selector, scope: target.scope, tagName: target.tagName, name: null, type: target.attributes.type ?? null, value }, isComposing: false, ...extra });
const key = (target, k, extra = {}) => ({ target, trusted: true, modifiers: mods, key: k, code: '', repeat: false, isComposing: false, ...extra });
const recording = { id: 'rec-1', name: '下单流程', url: START, startedAt: '2026-01-01T00:00:00.000Z' };
const generate = (events, options = {}) => generateScript(recording, events, { generatedAt: '2026-01-02T03:04:05.000Z', ...options });
const body = (code) => code.split('\n').filter((line) => line.startsWith('  ') && !line.trim().startsWith('//')).map((line) => line.trim());

test('locator priority: testId > role/name > label > placeholder > #id > text > css', () => {
  const all = [
    { strategy: 'testId', value: 'save' }, { strategy: 'id', value: 'save-btn' }, { strategy: 'label', value: '保存' },
    { strategy: 'placeholder', value: 'p' }, { strategy: 'role', value: 'button', name: '保存' }, { strategy: 'text', value: '保存' },
    { strategy: 'css', value: 'main > button' },
  ];
  const drop = (...kinds) => all.filter((l) => !kinds.includes(l.strategy));
  const button = (locators) => chooseLocator(el('n2', 'button', locators));
  assert.deepEqual(button(all), { kind: 'testId', value: 'save' });
  assert.deepEqual(button(drop('testId')), { kind: 'role', role: 'button', name: '保存', exact: false });
  assert.deepEqual(button(drop('testId', 'role')), { kind: 'label', value: '保存' });
  assert.deepEqual(button(drop('testId', 'role', 'label')), { kind: 'placeholder', value: 'p' });
  assert.deepEqual(button(drop('testId', 'role', 'label', 'placeholder')), { kind: 'css', value: '#save-btn' });
  assert.deepEqual(button(drop('testId', 'role', 'label', 'placeholder', 'id')), { kind: 'text', value: '保存' });
  assert.deepEqual(button(drop('testId', 'role', 'label', 'placeholder', 'id', 'text')), { kind: 'css', value: 'main > button' });
  // aria-label names are exact; empty or very long role names fall through.
  assert.equal(chooseLocator(el('n3', 'button', [{ strategy: 'role', value: 'button', name: '增加计数' }], { attributes: { 'aria-label': '增加计数' } })).exact, true);
  assert.equal(chooseLocator(el('n3', 'div', [{ strategy: 'role', value: 'button', name: 'x'.repeat(200) }, { strategy: 'css', value: 'div' }])).kind, 'css');
  // Form controls do not use textContent-derived role names; a wrapping label's option text is stripped.
  assert.deepEqual(chooseLocator(el('n4', 'select', [{ strategy: 'id', value: 'cat' }, { strategy: 'label', value: '类型体验反馈功能建议' }, { strategy: 'role', value: 'combobox', name: '体验反馈功能建议' }], { text: '体验反馈功能建议' })), { kind: 'label', value: '类型' });
  // aria-label wins over <label> text because it is the accessible name getByLabel matches.
  assert.deepEqual(chooseLocator(el('n6', 'input', [{ strategy: 'label', value: '同源 iframe / 独立文档' }, { strategy: 'label', value: 'iframe 测试输入' }], { attributes: { 'aria-label': 'iframe 测试输入' } })), { kind: 'label', value: 'iframe 测试输入' });
  // Unusual ids are CSS-escaped.
  assert.deepEqual(chooseLocator(el('n5', 'div', [{ strategy: 'id', value: '1:a b' }])), { kind: 'css', value: '#\\31 \\:a\\ b' });
});

test('string escaping survives quotes, backslashes, newlines, separators and unicode', () => {
  const nasty = "it's \"q\" \\ path\nline\r\t\u2028end 中文 😀";
  assert.equal(tsString(nasty), "'it\\'s \"q\" \\\\ path\\nline\\r\\t\\u2028end 中文 😀'");
  assert.equal(pyString(nasty), '"it\'s \\"q\\" \\\\ path\\nline\\r\\t\\u2028end 中文 😀"');
  assert.equal(eval(tsString(nasty)), nasty);
  assert.equal(JSON.parse(pyString('a"b\\c\nd')), 'a"b\\c\nd');
  assert.equal(cssEscape('-1x'), '-\\31 x');
  assert.equal(seqLabel([7, 3, 4, 5, 9, 4]), '3-5, 7, 9');
  const t = timeline();
  t.start();
  const field = el('n2', 'input', [{ strategy: 'placeholder', value: "O'Neil \\ */" }]);
  t.add('action.input', input(field, "x'y\n// not code"));
  const { code } = generateScript({ ...recording, name: "名字 'quoted'\n*/ evil" }, t.events, { generatedAt: 'now' });
  assert.match(code, /test\('名字 \\'quoted\\'\\n\*\/ evil', async/);
  assert.match(code, /\/\/ 采集记录：名字 'quoted' \*\/ evil\n/);
  assert.ok(body(code).includes("await page.getByPlaceholder('O\\'Neil \\\\ */').fill('x\\'y\\n// not code');"));
});

test('header, initial goto, seq comments and consecutive input merging', () => {
  const t = timeline();
  t.start();
  const name = el('n2', 'input', [{ strategy: 'id', value: 'demo-name' }, { strategy: 'label', value: '称呼' }, { strategy: 'placeholder', value: '怎么称呼你？' }], { attributes: { id: 'demo-name' } });
  t.add('action.focus', { target: name, trusted: true, modifiers: mods });
  t.add('action.click', click(name));
  for (const [k, v] of [['A', 'A'], ['d', 'Ad'], ['Backspace', 'A'], ['d', 'Ad'], ['a', 'Ada']]) {
    t.add('action.keydown', key(name, k));
    t.add('action.input', input(name, v));
  }
  t.add('action.change', input(name, 'Ada'));
  const result = generate(t.events);
  const { code, stats } = result;
  assert.match(code, /^\/\/ TraceDock · Playwright 自动化脚本/);
  assert.match(code, /\/\/ 采集记录：下单流程/);
  assert.match(code, /\/\/ 起始地址：https:\/\/shop\.example\//);
  assert.match(code, /\/\/ 生成时间：2026-01-02T03:04:05\.000Z/);
  assert.match(code, /import \{ test, expect \} from '@playwright\/test';/);
  assert.deepEqual(body(code), ["await page.goto('https://shop.example/');", "await page.getByLabel('称呼').fill('Ada');"]);
  assert.match(code, /\/\/ seq 1\n  await page\.goto/);
  assert.match(code, /\/\/ seq 3-14\n  await page\.getByLabel\('称呼'\)\.fill\('Ada'\);/);
  assert.equal(stats.steps, 2);
  assert.equal(stats.omitted.focus, 1);
  assert.equal(stats.omitted.typing, 4);
  assert.equal(stats.omitted['editing-key'], 1);
  assert.equal(result.filename, 'script.spec.ts');
});

test('select, checkbox, radio, label forwarding, press and submit deduplication', () => {
  const t = timeline();
  t.start();
  const select = el('n3', 'select', [{ strategy: 'id', value: 'cat' }, { strategy: 'label', value: '类型' }], { text: 'AB' });
  t.add('action.click', click(select));
  t.add('action.input', { ...input(select, 'b'), form: { ...input(select, 'b').form, selectedValues: ['b'] } });
  t.add('action.change', { ...input(select, 'b'), form: { ...input(select, 'b').form, selectedValues: ['b'] } });
  const multi = el('n4', 'select', [{ strategy: 'testId', value: 'tags' }]);
  t.add('action.change', { ...input(multi, 'x'), form: { ...input(multi, 'x').form, selectedValues: ['x', 'y'] } });
  const box = el('n5', 'input', [{ strategy: 'label', value: '接收后续进展' }], { attributes: { type: 'checkbox' } });
  const caption = el('n6', 'span', [{ strategy: 'text', value: '接收后续进展' }]);
  t.add('action.click', click(caption));
  t.add('action.click', click(box, { trusted: false }));
  t.add('action.input', { ...input(box, 'on'), form: { ...input(box, 'on').form, checked: true } });
  t.add('action.change', { ...input(box, 'on'), form: { ...input(box, 'on').form, checked: true } });
  // Change timestamps are far apart from here on, so this is a real separate click + uncheck.
  t.add('action.click', click(box));
  t.add('action.change', { ...input(box, 'on'), form: { ...input(box, 'on').form, checked: false } });
  const radio = el('n7', 'input', [{ strategy: 'label', value: '快递' }], { attributes: { type: 'radio' } });
  t.add('action.change', { ...input(radio, 'ship'), form: { ...input(radio, 'ship').form, checked: true } });
  const search = el('n8', 'input', [{ strategy: 'placeholder', value: '搜索' }], { attributes: { type: 'search' } });
  t.add('action.input', input(search, 'shoes'));
  t.add('action.keydown', key(search, 'Enter'));
  t.add('action.submit', { target: el('n9', 'form', []), trusted: true, modifiers: mods, submitter: null, fields: [], action: '', method: 'get' });
  const submit = el('n10', 'button', [{ strategy: 'role', value: 'button', name: '提交' }]);
  t.add('action.click', click(submit));
  t.add('action.submit', { target: el('n9', 'form', []), trusted: true, modifiers: mods, submitter: submit, fields: [], action: '', method: 'post' });
  t.add('action.keydown', key(submit, 'Enter'));
  t.add('action.click', click(submit, { detail: 0 }));
  t.add('action.keydown', key(null, 'Escape'));
  t.add('action.keydown', key(search, 'a', { modifiers: { ...mods, ctrl: true } }));
  t.add('action.keydown', key(submit, 'k', { modifiers: { ...mods, ctrl: true, shift: true } }));
  t.add('action.keydown', key(search, 'Tab'));
  t.add('action.keydown', key(search, 'Tab', { repeat: true }));
  t.add('action.submit', { target: el('n11', 'form', [], { selector: '#login' }), trusted: true, modifiers: mods, submitter: null, fields: [], action: '', method: 'post' });
  const { code, stats } = generate(t.events);
  // Timestamps are 1s apart in this fixture; label forwarding needs a near-simultaneous click.
  t.events[5].timestamp = t.events[6].timestamp;
  const forwarded = generate(t.events).code;
  assert.deepEqual(body(code).slice(1), [
    "await page.getByLabel('类型').selectOption('b');",
    "await page.getByTestId('tags').selectOption(['x', 'y']);",
    "await page.getByText('接收后续进展').click();",
    "await page.getByLabel('接收后续进展').check();",
    "await page.getByLabel('接收后续进展').uncheck();",
    "await page.getByLabel('快递').check();",
    "await page.getByPlaceholder('搜索').fill('shoes');",
    "await page.getByPlaceholder('搜索').press('Enter');",
    "await page.getByRole('button', { name: '提交' }).click();",
    "await page.getByRole('button', { name: '提交' }).press('Enter');",
    "await page.keyboard.press('Escape');",
    "await page.getByRole('button', { name: '提交' }).press('Control+Shift+k');",
    "await page.getByPlaceholder('搜索').press('Tab');",
    "await page.locator('#login').evaluate((form) => (form as HTMLFormElement).requestSubmit());",
  ]);
  assert.ok(!body(forwarded).includes("await page.getByText('接收后续进展').click();"), 'label click forwarded to the checkbox is absorbed');
  assert.match(forwarded, /\/\/ seq 6-9\n  await page\.getByLabel\('接收后续进展'\)\.check\(\);/);
  assert.match(code, /\/\/ seq 14-15\n  await page\.getByPlaceholder\('搜索'\)\.press\('Enter'\);/, 'Enter-triggered submit shares the press step');
  assert.match(code, /\/\/ seq 16-17\n  await page\.getByRole\('button', \{ name: '提交' \}\)\.click\(\);/, 'click-triggered submit shares the click step');
  assert.match(code, /\/\/ seq 18-19\n.*press\('Enter'\)/, 'keyboard-activated click (detail 0) merges into the press');
  assert.match(code, /TODO: 表单提交不是由已记录的点击或回车触发/);
  assert.equal(stats.omitted['select-click'], 1);
  assert.equal(stats.omitted['editing-key'], 1);
  assert.equal(stats.omitted['key-repeat'], 1);
});

test('dblclick collapses its clicks; modifiers and buttons become options; coordinate fallback is a TODO', () => {
  const t = timeline();
  t.start();
  const row = el('n2', 'td', [{ strategy: 'text', value: 'Order 42' }]);
  t.add('action.click', click(row));
  t.add('action.click', click(row, { detail: 2 }));
  t.add('action.dblclick', click(row, { detail: 2 }));
  t.add('action.click', click(row, { button: 2, modifiers: { ...mods, shift: true } }));
  t.add('action.click', click({ nodeId: 'n9', nodeType: 1, nodeName: 'CANVAS', tagName: 'canvas', selector: null, scope: scope(), attributes: {}, text: '', locators: [] }, { position: { clientX: 33.4, clientY: 44.6 } }));
  t.add('action.click', click(null));
  const { code, stats } = generate(t.events);
  assert.deepEqual(body(code).slice(1), [
    "await page.getByText('Order 42').dblclick();",
    "await page.getByText('Order 42').click({ button: 'right', modifiers: ['Shift'] });",
    'await page.mouse.click(33, 45);',
  ]);
  assert.match(code, /\/\/ seq 2-4\n  await page\.getByText\('Order 42'\)\.dblclick\(\);/);
  assert.match(code, /TODO: 录制时没有可用的定位器，按录制时的视口坐标点击/);
  assert.match(code, /TODO: seq 7 action\.click 没有目标节点/);
  assert.equal(stats.todos, 2);
});

test('navigations: action-caused become URL assertions, address-bar loads become goto, reload and redirects', () => {
  const t = timeline();
  t.start();
  t.add('page.navigation', { url: START, sameDocument: false });
  const link = el('n2', 'a', [{ strategy: 'role', value: 'link', name: '商品' }], { attributes: { href: '/p' } });
  t.add('action.click', click(link));
  t.add('page.navigation', { url: 'https://shop.example/p', sameDocument: false });
  t.add('page.navigation', { url: 'https://shop.example/p/1', sameDocument: false }, { elapsedMs: 4500 });
  t.add('page.navigation', { url: 'https://other.example/', sameDocument: false }, { elapsedMs: 60000 });
  t.add('page.navigation', { url: 'https://other.example/', sameDocument: false }, { elapsedMs: 70000 });
  const tab = el('n3', 'button', [{ strategy: 'role', value: 'tab', name: '详情' }]);
  t.add('action.click', click(tab));
  t.add('page.navigation', { url: 'https://other.example/#details', sameDocument: true });
  t.add('page.navigation', { url: 'https://other.example/?x=1', sameDocument: true }, { elapsedMs: 900000 });
  t.add('page.navigation', { url: 'about:blank', sameDocument: false });
  const { code, stats } = generate(t.events);
  assert.deepEqual(body(code), [
    "await page.goto('https://shop.example/');",
    "await page.getByRole('link', { name: '商品' }).click();",
    "await expect(page).toHaveURL('https://shop.example/p/1');",
    "await page.goto('https://other.example/');",
    'await page.reload();',
    "await page.getByRole('tab', { name: '详情' }).click();",
    "await expect(page).toHaveURL('https://other.example/#details');",
  ]);
  assert.match(code, /\/\/ seq 1-2\n  await page\.goto/, 'the initial load is folded into goto');
  assert.match(code, /\/\/ seq 4-5\n  await expect\(page\)\.toHaveURL\('https:\/\/shop\.example\/p\/1'\);/, 'redirect chain keeps the final URL');
  assert.match(code, /\/\/ seq 10 页面脚本将地址改为 https:\/\/other\.example\/\?x=1/);
  assert.equal(stats.navigations, 7);
});

test('same-origin iframes use frameLocator; open shadow roots are scoped by host; unknown frames are TODOs', () => {
  const t = timeline();
  t.start();
  const frameScope = scope({ framePath: ['#demo-frame'], frameContexts: [{ selector: '#demo-frame', nodeId: 'n40', shadowPath: [] }], frameUrl: 'about:srcdoc', rootId: 'n41' });
  const frameInput = el('n42', 'input', [{ strategy: 'label', value: '框架内输入' }, { strategy: 'id', value: 'frame-input' }], { scope: frameScope });
  t.add('action.input', input(frameInput, 'hello'));
  t.add('action.input', input(frameInput, 'hello frame'));
  const nested = scope({ frameContexts: [{ selector: 'iframe.outer', nodeId: 'a', shadowPath: ['x-shell'] }, { selector: '#inner', nodeId: 'b', shadowPath: [] }], rootId: 'n50' });
  t.add('action.click', click(el('n51', 'button', [{ strategy: 'testId', value: 'ok' }], { scope: nested })));
  const shadowScope = scope({ shadowPath: ['#shadow-host'], rootId: 'n60' });
  t.add('action.click', click(el('n61', 'button', [{ strategy: 'id', value: 'shadow-button' }, { strategy: 'role', value: 'button', name: '点击组件按钮 ↗' }], { scope: shadowScope })));
  t.add('action.click', click(el('n62', 'span', [{ strategy: 'css', value: 'div > span' }], { scope: shadowScope })));
  const lost = scope({ frameContexts: [{ selector: null, nodeId: 'z', shadowPath: [] }], rootId: 'n70' });
  t.add('action.click', click(el('n71', 'button', [{ strategy: 'testId', value: 'gone' }], { scope: lost })));
  const ts = generate(t.events).code;
  assert.deepEqual(body(ts).slice(1), [
    "await page.frameLocator('#demo-frame').getByLabel('框架内输入').fill('hello frame');",
    "await page.locator('x-shell').frameLocator('iframe.outer').frameLocator('#inner').getByTestId('ok').click();",
    "await page.locator('#shadow-host').getByRole('button', { name: '点击组件按钮 ↗' }).click();",
    "await page.locator('#shadow-host').locator('div > span').click();",
  ]);
  assert.match(ts, /TODO: 目标位于无法用选择器定位的 iframe 中，已跳过 click 步骤/);
  const py = generate(t.events, { language: 'python' }).code;
  assert.match(py, /    page\.frame_locator\("#demo-frame"\)\.get_by_label\("框架内输入"\)\.fill\("hello frame"\)\n/);
  assert.match(py, /    page\.locator\("#shadow-host"\)\.get_by_role\("button", name="点击组件按钮 ↗"\)\.click\(\)\n/);
});

test('pause/resume, interruptions, errors, popups and file inputs are annotated', () => {
  const t = timeline();
  t.start();
  const btn = el('n2', 'button', [{ strategy: 'role', value: 'button', name: '下一步' }]);
  t.add('action.click', click(btn));
  t.add('session.pause', { reason: 'user' });
  t.add('session.resume', { reason: 'user' }, { url: 'https://shop.example/checkout' });
  t.add('action.click', click(btn));
  t.add('session.pause', { reason: 'user' });
  t.add('session.resume', { reason: 'user' }, { url: 'https://shop.example/checkout' });
  t.add('recorder.error', { message: 'collector timeout', possibleGap: true });
  t.add('page.popup', { url: 'https://pay.example/', disposition: 'new-window' });
  const file = el('n3', 'input', [{ strategy: 'label', value: '附件' }], { attributes: { type: 'file' } });
  t.add('action.change', { ...input(file, ''), form: { ...input(file, '').form, files: [{ name: 'a.pdf', size: 1, type: 'application/pdf', lastModified: 0 }] } });
  t.add('session.pause', { reason: 'user' });
  const { code, warnings } = generate(t.events);
  assert.match(code, /\/\/ seq 3 采集已暂停：暂停期间的操作没有记录/);
  assert.match(code, /TODO: 暂停期间页面从 https:\/\/shop\.example\/ 变为 https:\/\/shop\.example\/checkout/);
  assert.match(code, /\/\/ seq 4 · 恢复采集\n  await page\.goto\('https:\/\/shop\.example\/checkout'\);/);
  assert.match(code, /\/\/ seq 7 恢复采集/);
  assert.match(code, /TODO: seq 8 采集错误（可能存在采集空白）：collector timeout/);
  assert.match(code, /TODO: seq 9 网页请求打开新窗口/);
  assert.match(code, /TODO: 文件上传需要本地文件：a\.pdf\n  \/\/ await page\.getByLabel\('附件'\)\.setInputFiles\(\['a\.pdf'\]\);/);
  assert.deepEqual(warnings, ['记录在暂停状态结束，暂停之后的操作没有采集。']);
  assert.match(code, /\/\/ 注意：记录在暂停状态结束/);
});

test('scroll is omitted by default and emitted as scrollTo when requested; empty recordings still compile', () => {
  const t = timeline();
  t.start();
  const doc = { nodeId: 'n1', nodeType: 9, nodeName: '#document', selector: null, scope: scope() };
  t.add('action.scroll', { target: doc, trusted: true, x: 0, y: 120, coalesced: true });
  t.add('action.scroll', { target: doc, trusted: true, x: 0, y: 480.4, coalesced: true });
  t.add('action.scroll', { target: el('n5', 'div', [{ strategy: 'css', value: '#list' }]), trusted: true, x: 0, y: 64, coalesced: true });
  const plain = generate(t.events);
  assert.equal(plain.stats.omitted.scroll, 3);
  assert.match(plain.code, /记录中没有可转换的操作。/);
  const scrolled = generate(t.events, { includeScroll: true });
  assert.deepEqual(body(scrolled.code).slice(1), [
    'await page.evaluate(() => window.scrollTo(0, 480));',
    "await page.locator('#list').evaluate((el) => el.scrollTo(0, 64));",
  ]);
  assert.match(scrolled.code, /\/\/ seq 2-3\n  await page\.evaluate/);
  const py = generate(t.events, { includeScroll: true, language: 'python' });
  assert.match(py.code, /    page\.evaluate\("\(\) => window\.scrollTo\(0, 480\)"\)\n/);
  const empty = generateScript({ id: 'x', name: '', url: 'https://a.test/' }, []);
  assert.match(empty.code, /await page\.goto\('https:\/\/a\.test\/'\);/);
  assert.match(empty.code, /test\('x', async/);
});

test('python output uses pytest-playwright sync API', () => {
  const t = timeline();
  t.start();
  const name = el('n2', 'input', [{ strategy: 'label', value: '称呼' }]);
  t.add('action.input', input(name, 'Ada "the" \\ first'));
  const btn = el('n3', 'button', [{ strategy: 'role', value: 'button', name: '提交' }], { attributes: { 'aria-label': '提交' } });
  t.add('action.click', click(btn, { modifiers: { ...mods, ctrl: true } }));
  t.add('page.navigation', { url: 'https://shop.example/done', sameDocument: false });
  const select = el('n4', 'select', [{ strategy: 'testId', value: 'size' }]);
  t.add('action.change', { ...input(select, 'm'), form: { ...input(select, 'm').form, selectedValues: ['m'] } });
  const result = generate(t.events, { language: 'python' });
  assert.equal(result.filename, 'test_script.py');
  assert.match(result.code, /^# TraceDock · Playwright 自动化脚本/);
  assert.match(result.code, /\nfrom playwright\.sync_api import Page, expect\n\n\ndef test_tracedock_recording\(page: Page\) -> None:\n/);
  const lines = result.code.split('\n').filter((l) => l.startsWith('    ') && !l.trim().startsWith('#')).map((l) => l.trim());
  assert.deepEqual(lines, [
    '"TraceDock: 下单流程"',
    'page.goto("https://shop.example/")',
    'page.get_by_label("称呼").fill("Ada \\"the\\" \\\\ first")',
    'page.get_by_role("button", name="提交", exact=True).click(modifiers=["Control"])',
    'expect(page).to_have_url("https://shop.example/done")',
    'page.get_by_test_id("size").select_option("m")',
  ]);
});

test('a late blur-time change that only commits an earlier fill is folded into that fill', () => {
  const t = timeline();
  t.start();
  const email = el('n2', 'input', [{ strategy: 'label', value: '邮箱' }], { attributes: { type: 'email' } });
  const select = el('n3', 'select', [{ strategy: 'label', value: '类型' }]);
  t.add('action.input', input(email, 'a@b.c'));
  t.add('action.change', { ...input(select, 'bug'), form: { ...input(select, 'bug').form, selectedValues: ['bug'] } });
  t.add('action.change', input(email, 'a@b.c'));
  t.add('action.change', input(email, 'changed@b.c'));
  const { code } = generate(t.events);
  assert.deepEqual(body(code).slice(1), [
    "await page.getByLabel('邮箱').fill('a@b.c');",
    "await page.getByLabel('类型').selectOption('bug');",
    "await page.getByLabel('邮箱').fill('changed@b.c');",
  ]);
  assert.match(code, /\/\/ seq 2, 4\n  await page\.getByLabel\('邮箱'\)\.fill\('a@b\.c'\);/);
});

test('implicit submission (Enter in a field clicks the default button) yields only the press', () => {
  const t = timeline();
  t.start();
  const field = el('n2', 'input', [{ strategy: 'label', value: '新待办事项' }]);
  const add = el('n3', 'button', [{ strategy: 'role', value: 'button', name: '添加事项 +' }]);
  t.add('action.input', input(field, '写脚本'));
  t.add('action.keydown', key(field, 'Enter'));
  t.add('action.click', click(add, { detail: 0 }));
  t.add('action.submit', { target: el('n4', 'form', []), trusted: true, modifiers: mods, submitter: add, fields: [], action: '', method: 'get' });
  t.add('action.click', click(add, { detail: 1 }));
  const { code } = generate(t.events);
  assert.deepEqual(body(code).slice(1), [
    "await page.getByLabel('新待办事项').fill('写脚本');",
    "await page.getByLabel('新待办事项').press('Enter');",
    "await page.getByRole('button', { name: '添加事项 +' }).click();",
  ]);
  assert.match(code, /\/\/ seq 3-5\n  await page\.getByLabel\('新待办事项'\)\.press\('Enter'\);/);
});

test('password values are kept (no redaction) with a header note', () => {
  const t = timeline();
  t.start();
  t.add('action.input', input(el('n2', 'input', [{ strategy: 'id', value: 'pw' }], { attributes: { type: 'password' } }), 's3cr3t'));
  const { code } = generate(t.events);
  assert.match(code, /page\.locator\('#pw'\)\.fill\('s3cr3t'\);/);
  assert.match(code, /注意：脚本保留录制时的原始输入值（包括密码字段）/);
});

test('streaming reader skips DOM lines unparsed, honours the byte boundary and caps oversized lines', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracedock-codegen-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'timeline.jsonl');
  const tl = timeline();
  tl.start();
  const name = el('n2', 'input', [{ strategy: 'label', value: '称呼' }]);
  tl.add('dom.snapshot', { reason: 'start', html: '<p>' + 'x'.repeat(3 * 1024 * 1024) + '</p>' });
  tl.add('action.input', input(name, 'Ada'));
  tl.add('dom.mutation', { records: [] });
  tl.add('page.resource', { url: 'https://cdn/a.css' });
  tl.add('action.click', click(el('n3', 'button', [{ strategy: 'role', value: 'button', name: 'Big' }], { text: 'y'.repeat(4096) })));
  const lines = tl.events.map((e) => JSON.stringify(e) + '\n');
  // Not a valid JSON line, but skipped by its prefix: proves DOM lines are never parsed.
  lines.splice(2, 0, '{"type":"dom.mutation","payload":{broken\n');
  const boundary = Buffer.byteLength(lines.join(''));
  await fs.writeFile(file, lines.join('') + JSON.stringify({ seq: 99, type: 'action.click', payload: {} }) + '\n');
  assert.equal(leadingType('{"type":"dom.snapshot","payload"'), 'dom.snapshot');
  assert.equal(leadingType('{"seq":1,"type":"x"}'), null);
  const stats = { skippedLines: 0, oversizedLines: 0, invalidLines: 0 };
  const seen = [];
  for await (const event of readCodegenEvents(file, boundary, { stats })) seen.push(event.type);
  assert.deepEqual(seen, ['session.start', 'action.input', 'action.click']);
  assert.deepEqual(stats, { skippedLines: 4, oversizedLines: 0, invalidLines: 0 });
  const capped = { skippedLines: 0, oversizedLines: 0, invalidLines: 0 };
  const kept = [];
  for await (const event of readCodegenEvents(file, boundary, { stats: capped, maxLineBytes: 2048 })) kept.push(event.type);
  assert.deepEqual(kept, ['session.start', 'action.input']);
  assert.equal(capped.oversizedLines, 1);
  const metadata = { id: 'rec-1', name: '流式', url: START, startedAt: recording.startedAt };
  const result = await generateFromTimeline({ metadata, timelinePath: file, byteLength: boundary }, { generatedAt: 'x' });
  assert.deepEqual(body(result.code), ["await page.goto('https://shop.example/');", "await page.getByLabel('称呼').fill('Ada');", "await page.getByRole('button', { name: 'Big' }).click();"]);
  assert.equal(result.stats.lastSeq, 6);
  assert.equal(result.stats.events, 7);
  await assert.rejects(async () => { for await (const _ of readCodegenEvents(file, boundary + 10 ** 7)); }, /读取不完整/);
});

test('MCP tracedock_codegen is a strict, scoped, read-only tool with a byte budget', async (t) => {
  const { createMCPTools, MCP_TOOLS } = require('../out/mcp-tools.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracedock-codegen-mcp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const descriptor = MCP_TOOLS.find((tool) => tool.name === 'tracedock_codegen');
  assert.ok(descriptor);
  assert.equal(descriptor.annotations.readOnlyHint, true);
  assert.equal(descriptor.annotations.destructiveHint, false);
  assert.deepEqual(descriptor.inputSchema.required, ['recordingId']);
  assert.equal(descriptor.inputSchema.additionalProperties, false);
  const tl = timeline();
  tl.start();
  tl.add('action.input', input(el('n2', 'input', [{ strategy: 'label', value: '称呼' }]), 'Ada'));
  tl.add('action.input', input(el('n3', 'textarea', [{ strategy: 'label', value: '备注' }]), '长'.repeat(1500)));
  const file = path.join(dir, 'timeline.jsonl');
  const text = tl.events.map((e) => JSON.stringify(e) + '\n').join('');
  await fs.writeFile(file, text);
  const records = [
    { id: 'r1', sessionGroupId: 'g1', profileId: 'p1', name: 'Checkout', status: 'stopped', libraryState: 'active', startedAt: '2026-01-02T01:00:00Z', url: START, eventCount: 2, lastSeq: 2 },
    { id: 'r2', sessionGroupId: 'g2', profileId: 'p2', name: 'Private', status: 'stopped', libraryState: 'active', startedAt: '2026-01-02T01:00:00Z', url: START, eventCount: 2, lastSeq: 2 },
  ];
  const by = (id) => { const r = records.find((x) => x.id === id); if (!r) throw new Error('not found'); return r; };
  let reads = 0;
  const ws = {
    notify() {}, state: () => ({ profiles: [], sessionGroups: [], sessions: records, activeProfileId: 'p1', session: null, browser: {}, export: null }),
    profiles: { get: () => ({}), list: () => [] }, sessionGroups: { get: () => ({}), list: () => [] },
    store: { getSession: by, capture: async (id) => ({ metadata: by(id), timelinePath: file, byteLength: Buffer.byteLength(text) }) },
    readable() {}, readRecording: async (_id, read) => { reads++; return read(); }, jobs: { progress: () => null, cancel() {} }, actions: {},
  };
  const denied = () => { throw Object.assign(new Error('forbidden'), { code: 'PROFILE_FORBIDDEN', outcome: 'not_executed' }); };
  let permissions = new Set(['read']);
  const access = {
    authorize(_c, cap, profileId) { if (!permissions.has(cap)) denied(); if (profileId && profileId !== 'p1') denied(); },
    profileIds: () => ['p1'], principal: () => 'client-a', state: () => ({}), contextRevision: () => 1, control: async () => ({}), requireLease() {},
    profileOpened() {}, recordingStarted() {}, recordingResumed() {}, proposeDeletion() {}, approveDeletion() {}, registerGuard() {},
    revalidateAuthorization() {}, run: (_c, operation) => operation(),
  };
  const tools = await createMCPTools({ workspace: ws, access, browser: { call: async () => ({}) }, dataRoot: dir });
  t.after(() => tools.operations.close?.());
  const ok = await tools.call('c', 'tracedock_codegen', { recordingId: 'r1' });
  assert.equal(ok.isError, false);
  assert.equal(ok.structuredContent.outcome, 'read');
  const data = ok.structuredContent.data;
  assert.equal(data.recordingId, 'r1');
  assert.equal(data.language, 'typescript');
  assert.equal(data.filename, 'script.spec.ts');
  assert.match(data.code, /await page\.getByLabel\('称呼'\)\.fill\('Ada'\);/);
  assert.equal(reads, 1, 'reads go through the recording occupancy guard');
  const py = await tools.call('c', 'tracedock_codegen', { recordingId: 'r1', language: 'python' });
  assert.match(py.structuredContent.data.code, /page\.get_by_label\("称呼"\)\.fill\("Ada"\)/);
  const small = await tools.call('c', 'tracedock_codegen', { recordingId: 'r1', maxBytes: 1024 });
  assert.equal(small.structuredContent.error.code, 'RESULT_TOO_LARGE');
  assert.equal((await tools.call('c', 'tracedock_codegen', { recordingId: 'r2' })).structuredContent.error.code, 'PROFILE_FORBIDDEN');
  assert.equal((await tools.call('c', 'tracedock_codegen', { recordingId: 'r1', language: 'ruby' })).structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.equal((await tools.call('c', 'tracedock_codegen', { recordingId: 'r1', extra: true })).structuredContent.error.code, 'INVALID_ARGUMENT');
  permissions = new Set();
  assert.equal((await tools.call('c', 'tracedock_codegen', { recordingId: 'r1' })).isError, true);
});

test('legacy frame actions recover nested hosts at the action timestamp and discard stale or ambiguous targets', async (t) => {
  const tl = timeline();
  tl.start();
  const node = (nodeId, nodeName, id) => ({nodeId, nodeName, attributes: {id}, children: []});
  const snapshot = (frameId, documentId, parentDocumentId, hostNodeId, nodes) =>
    ({frameId, documentId, parentDocumentId, hostNodeId, nodes, url: 'https://frame.example/'});
  const outer = snapshot('outer', 'outer-doc', 'doc-1', 'h1', [node('h2', 'IFRAME', 'nested')]);
  const initial = snapshot('inner', 'first-doc', 'outer-doc', 'h2', [node('button', 'BUTTON', 'before')]);
  const action = (doc, visualNodeId = 'button') => tl.add('action.frame', {
    action: 'click', frameId: 'inner', documentId: doc, element: 'button', visualNodeId, node: 1,
  });
  tl.add('dom.snapshot', {inaccessibleFrames: [{target: el('h1', 'iframe', [], {selector: '#outer'})}], frameDocuments: [outer, initial]});
  action('first-doc');
  tl.add('frame.mutation', {documentId: 'first-doc', removed: [], nodes: [node('button', 'BUTTON', 'after')]});
  action('first-doc');
  tl.add('frame.snapshot', snapshot('inner', 'second-doc', 'outer-doc', 'h2', [
    node('button', 'BUTTON', 'fresh'), node('other', 'BUTTON', 'fresh'),
  ]));
  action('first-doc'); // Same frame, destroyed document.
  action('second-doc'); // Duplicate ID.
  tl.add('frame.mutation', {documentId: 'second-doc', removed: ['other'], nodes: []});
  action('second-doc');
  tl.add('frame.detach', {documentId: 'outer-doc'});
  action('second-doc'); // Surviving target ID without a parent chain.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracedock-frames-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'timeline.jsonl');
  const lines = tl.events.map(e => JSON.stringify(e) + '\n').join('');
  await fs.writeFile(file, lines);
  const { code, stats } = await generateFromTimeline({metadata: recording, timelinePath: file, byteLength: Buffer.byteLength(lines)});
  assert.equal(stats.todos, 3);
  assert.deepEqual(body(code).slice(1), ['before', 'after', 'fresh'].map(id =>
    "await page.frameLocator('#outer').frameLocator('#nested').locator('#" + id + "').click();"));
});

test('frame control keys and implicit clicks stay within their own document', () => {
  const tl = timeline();
  tl.start();
  const hop = selector => ({selector, shadowPath: []});
  const add = (doc, element, action, extra = {}) => tl.add('action.frame', {
    documentId: doc, frameId: doc, framePath: [hop('#' + doc)], target: hop(element),
    node: 1, visualNodeId: 'n1', element, action, ...extra,
  });
  add('left', 'body', 'keydown', {controlKey: 'Enter'});
  add('right', 'button', 'click', {detail: 0});
  add('right', 'form', 'submit');
  add('left', 'input', 'input');
  add('left', 'input', 'change');
  tl.add('action.frame', {action: 'click', documentId: 'left', frameId: 'left', element: 'button', node: 4});
  const {code, stats} = generate(tl.events);
  assert.equal(stats.todos, 1);
  assert.match(code, /frameLocator\('#left'\)\.locator\('body'\)\.press\('Enter'\)/);
  assert.match(code, /frameLocator\('#right'\)\.locator\('button'\)\.click\(\)/);
  assert.match(code, /frameLocator\('#left'\)\.locator\('input'\)\.fill\(frameInput\('TRACEDOCK_INPUT_5'\)\)/);
  assert.match(code, /TODO: seq 7/);
});
