(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let count = 0;
  $('counter-increase').addEventListener('click', () => { $('counter-value').textContent = String(++count); });
  $('counter-decrease').addEventListener('click', () => { $('counter-value').textContent = String(--count); });
  $('toggle-attribute').addEventListener('click', () => {
    const panel = $('attribute-panel');
    const active = panel.dataset.mode !== 'active';
    panel.dataset.mode = active ? 'active' : 'calm';
    $('attribute-label').textContent = active ? '状态：活跃' : '状态：平静';
  });
  $('feedback-form').addEventListener('submit', event => {
    event.preventDefault();
    const result = $('form-result');
    result.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = `已收到，${$('demo-name').value}！`;
    const message = document.createElement('span');
    message.textContent = `${$('demo-category').selectedOptions[0].textContent}：${$('demo-note').value || '期待你的下一次探索。'}${$('demo-followup').checked ? ' 已订阅后续进展。' : ''}`;
    result.append(title, message);
    result.hidden = false;
    result.dataset.submitted = 'true';
  });
  let nextTaskId = 3;
  function updateTasks() {
    const items = [...$('task-list').children];
    const pending = items.filter(item => !item.querySelector('input').checked).length;
    $('task-count').textContent = `${pending} 项待办${items.length !== pending ? ` · ${items.length - pending} 项完成` : ''}`;
  }
  $('task-form').addEventListener('submit', event => {
    event.preventDefault();
    const value = $('task-input').value.trim();
    if (!value) { $('task-input').focus(); return; }
    const item = document.createElement('li');
    item.className = 'task-item';
    item.dataset.taskId = String(nextTaskId++);
    const label = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'task-check';
    const text = document.createElement('span'); text.textContent = value;
    label.append(check, text);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'task-delete';
    remove.setAttribute('aria-label', `删除待办：${value}`); remove.textContent = '×';
    item.append(label, remove); $('task-list').append(item);
    $('task-input').value = ''; updateTasks();
  });
  $('task-list').addEventListener('click', event => {
    if (event.target.closest('.task-delete')) {
      event.target.closest('.task-item').remove(); updateTasks();
    }
  });
  $('task-list').addEventListener('change', event => {
    if (event.target.matches('.task-check')) {
      event.target.closest('.task-item').dataset.complete = String(event.target.checked); updateTasks();
    }
  });
  const shadow = $('shadow-host').attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>:host{display:block;font-family:inherit}.row{display:flex;align-items:center;justify-content:space-between;padding:13px;border:1px dashed var(--echo-border-selected);background:var(--echo-surface-canvas);border-radius:var(--echo-radius-sm);gap:8px}button{font:inherit;font-size:10px;color:var(--echo-semantic-brand-text);background:var(--echo-surface-panel);border:1px solid var(--echo-border-default);border-radius:5px;padding:7px 10px;cursor:pointer}output{font-size:10px;color:var(--echo-text-secondary)}button:hover{background:var(--echo-surface-hover)}button:focus-visible{outline:2px solid var(--echo-semantic-focus);outline-offset:2px}</style><div class="row"><button id="shadow-button" type="button">点击组件按钮 ↗</button><output id="shadow-value">已点击 0 次</output></div>`;
  let shadowCount = 0;
  shadow.getElementById('shadow-button').addEventListener('click', () => { shadow.getElementById('shadow-value').textContent = `已点击 ${++shadowCount} 次`; });
  // srcdoc inherits this document's origin and base URL; tokens load from the local bundle.
  $('demo-frame').srcdoc = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="../shared/echoo-theme-tokens.css"><style>body{margin:0;padding:12px;font-family:var(--echo-system-font-family);background:var(--echo-surface-muted);color:var(--echo-text-secondary)}label{font-size:9px;display:block;margin-bottom:7px}input{box-sizing:border-box;width:100%;font:inherit;font-size:10px;border:1px solid var(--echo-field-border);border-radius:5px;padding:8px;color:var(--echo-text-primary);outline:none;background:var(--echo-field-background)}input:focus{border-color:var(--echo-semantic-focus)}input::placeholder{color:var(--echo-text-disabled)}</style></head><body><label for="frame-input">同源 iframe / 独立文档</label><input id="frame-input" aria-label="iframe 测试输入" placeholder="在内嵌文档中输入文字" autocomplete="off"></body></html>`;
})();
