import { randomUUID } from "node:crypto";
import type { WebContents, KeyboardInputEvent } from "electron";
import { acquireBrowserDebugger } from "../browser-debugger";
import type { BrowserDebuggerLease } from "../browser-debugger";

export type BrowserActionOutcome = "not_executed" | "unknown";
export class BrowserActionError extends Error {
  constructor(public code: string, message: string, public outcome: BrowserActionOutcome = "not_executed", public recovery = "observe_then_replan") {
    super(message); this.name = "BrowserActionError";
  }
}
const dispatching = new WeakSet<WebContents>();
export const isAgentInputDispatch = (contents: WebContents) => dispatching.has(contents);
function trustedInput<T>(contents: WebContents, dispatch: () => T): T {
  dispatching.add(contents);
  try { return dispatch(); } finally { dispatching.delete(contents); }
}
const WORLD_ID = 1701;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function bounded(value: unknown, fallback: number, max: number, min = 1) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new BrowserActionError("INVALID_ARGUMENT", `数值必须介于 ${min} 与 ${max}`);
  return value;
}
function string(value: unknown, name: string, max = 8192): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new BrowserActionError("INVALID_ARGUMENT", `${name} 无效`);
  return value;
}

// This code executes in an isolated world, not the page's JavaScript context.
// Element references never cross into the page world and are scoped to one document.
const WORLD = String.raw`
const root = globalThis;
let s = root.__tracedockAgent;
if (!s || s.document !== document) {
  s = root.__tracedockAgent = {document, documentId:q.seed, revision:0, next:0, nodes:new Map(), reverse:new WeakMap(), frames:new Map([['main',document]]), frameReverse:new WeakMap([[document,'main']])};
  new MutationObserver(() => s.revision++).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
}
const fail = (code,message) => ({error:{code,message}});
const clean = (v,max=240) => String(v||'').replace(/\s+/g,' ').trim().slice(0,max);
const frameFor = doc => {let ref=s.frameReverse.get(doc);if(!ref){ref='f'+(++s.next);s.frames.set(ref,doc);s.frameReverse.set(doc,ref);}return ref;};
const refFor = el => {let ref=s.reverse.get(el);if(!ref){ref='e'+(++s.next);s.nodes.set(ref,el);s.reverse.set(el,ref);}return ref;};
const attached = el => {
  if(!el || !el.isConnected) return false;
  let doc=el.ownerDocument;
  while(doc!==document){const frame=doc.defaultView?.frameElement;if(!frame||!frame.isConnected||frame.contentDocument!==doc)return false;doc=frame.ownerDocument;}
  return true;
};
const visible = el => {
  const win=el.ownerDocument.defaultView,st=win.getComputedStyle(el),r=el.getBoundingClientRect();
  return st.visibility!=='hidden'&&st.display!=='none'&&Number(st.opacity)!==0&&r.width>0&&r.height>0;
};
const disabled = el => Boolean(el.disabled)||el.getAttribute('aria-disabled')==='true'||Boolean(el.closest('[inert]'));
const semanticRole = el => el.getAttribute('role')||({A:el.hasAttribute('href')?'link':'',BUTTON:'button',INPUT:({checkbox:'checkbox',radio:'radio',range:'slider',button:'button',submit:'button',search:'searchbox'}[el.type]||'textbox'),TEXTAREA:'textbox',SELECT:'combobox',IMG:'img',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading',SUMMARY:'button',IFRAME:'iframe',TABLE:'table',LI:'listitem'}[el.tagName]||'');
const nameOf = el => {
  const labelled=el.getAttribute('aria-labelledby');
  return clean(el.getAttribute('aria-label')||(labelled?labelled.split(/\s+/).map(id=>el.ownerDocument.getElementById(id)?.textContent||'').join(' '):'')||(el.labels?.length?[...el.labels].map(x=>x.textContent).join(' '):'')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||(el.tagName==='INPUT'&&['button','submit'].includes(el.type)?el.value:'')||el.textContent);
};
const position = el => {
  const r=el.getBoundingClientRect();let x=r.x,y=r.y,doc=el.ownerDocument;
  while(doc!==document){const f=doc.defaultView.frameElement,fr=f.getBoundingClientRect();x+=fr.x+f.clientLeft;y+=fr.y+f.clientTop;doc=f.ownerDocument;}
  return {x,y,width:r.width,height:r.height};
};
const current = () => ({documentId:s.documentId,contextRevision:s.revision,url:location.href,frameRef:'main'});
if(q.documentId && q.documentId!==s.documentId)return fail('STALE_REFERENCE','页面已经导航，请重新 observe');
if(q.action==='observe') {
  if(s.nodes.size>20000){s.nodes.clear();s.reverse=new WeakMap();}
  const nodes=[],coverage={mainFrame:true,sameOriginFrames:true,openShadowRoots:true,crossOriginFrames:0,canvas:0,closedShadowRoots:'not_observable'};
  let count=0,bytes=0,truncated=false;
  let base=q.rootRef?s.nodes.get(q.rootRef):q.frameRef?s.frames.get(q.frameRef):document;
  if(!base || (base.nodeType===1&&!attached(base)) || (base.nodeType===9&&base!==document&&!attached(base.documentElement))) return fail('STALE_REFERENCE','观察目标已失效，请重新观察主页面');
  const visited=new Set();
  const walk=(el,parentRef,depth)=>{
    if(!el||visited.has(el)||truncated)return; visited.add(el);
    if(el.nodeType===9||el.nodeType===11){for(const child of el.children)walk(child,parentRef,depth);return;}
    if(el.nodeType!==1||['SCRIPT','STYLE','NOSCRIPT','HEAD','TEMPLATE'].includes(el.tagName))return;
    if(++count>20000){truncated=true;return;}
    const role=semanticRole(el),vis=visible(el);let nextParent=parentRef;
    if(vis && (role||el.hasAttribute('tabindex')||el.isContentEditable)) {
      const ref=refFor(el),entry={ref,frameRef:frameFor(el.ownerDocument),parentRef,role:role||'generic',name:nameOf(el),tag:el.tagName.toLowerCase(),visible:vis,enabled:!disabled(el),bounds:position(el)};
      if(el.matches('input,textarea,select'))entry.value=el.type==='password'?'[password]':clean(el.value,500);
      if(el.matches('input[type=checkbox],input[type=radio]'))entry.checked=el.checked;
      if(el.tagName==='SELECT')entry.options=[...el.options].slice(0,100).map(o=>({value:o.value,label:clean(o.label),selected:o.selected,disabled:o.disabled}));
      const size=JSON.stringify(entry).length*3;
      if(nodes.length>=q.maxNodes||bytes+size>q.maxBytes){truncated=true;return;}
      bytes+=size;nodes.push(entry);nextParent=ref;
    }
    if(el.tagName==='CANVAS')coverage.canvas++;
    if(el.tagName==='IFRAME'){
      try {const doc=el.contentDocument;if(doc&&doc.documentElement){frameFor(doc);walk(doc,nextParent,depth+1);}else coverage.crossOriginFrames++;}catch{coverage.crossOriginFrames++;}
    }
    if(el.shadowRoot)walk(el.shadowRoot,nextParent,depth+1);
    for(const child of el.children)walk(child,nextParent,depth+1);
  };
  walk(base,null,0);
  const textBudget=Math.max(0,Math.min(12000,Math.floor((q.maxBytes-bytes)/3)));
  return {...current(),observationId:q.seed,nodes,text:clean((base.nodeType===9?base.body:base)?.innerText,textBudget),coverage,truncated,limits:{maxNodes:q.maxNodes,maxBytes:q.maxBytes},capabilities:{upload:false,download:false,crossOriginFrames:false,multipleWindows:false}};
}
if(q.documentId && q.documentId!==s.documentId)return fail('STALE_REFERENCE','页面已经导航，请重新 observe');
if(q.action==='state')return {...current(),title:document.title,readyState:document.readyState,text:clean(document.body?.innerText,16000)};
const ref=q.ref||q.containerRef;
const el=ref?s.nodes.get(ref):null;
if(ref&&(!attached(el)||(q.frameRef&&frameFor(el.ownerDocument)!==q.frameRef)))return fail('STALE_REFERENCE','元素已替换或框架已导航，请重新 observe');
if(q.action==='condition'){
  const found=Boolean(el&&attached(el));
  return {...current(),matched:q.state==='detached'?!found:q.state==='hidden'?!found||!visible(el):q.state==='attached'?found:q.state==='visible'?found&&visible(el):q.state==='load'?document.readyState==='complete':q.text?String(document.body?.innerText||'').includes(q.text):q.url?location.href.includes(q.url):false};
}
if(q.action==='scroll'){
  const target=el||document.scrollingElement;
  if(!target)return fail('NOT_ACTIONABLE','没有可滚动容器');
  return {...current(),position:el?position(el):{x:0,y:0,width:innerWidth,height:innerHeight},scroll:{x:target.scrollLeft,y:target.scrollTop},viewport:{width:innerWidth,height:innerHeight}};
}
if(!el)return fail('INVALID_ARGUMENT','需要本次 observe 返回的 ref');
if(q.action==='inspect')return {...current(),ref,visible:visible(el),enabled:!disabled(el),value:el.type==='password'?'[password]':String(el.value??''),selected:el.tagName==='SELECT'?[...el.selectedOptions].map(o=>o.value):undefined};
if(!visible(el)||disabled(el))return fail('NOT_ACTIONABLE','目标不可见或不可用');
if(q.action==='prepare') {
  if(el.matches('input[type=file]'))return fail('UNSUPPORTED_CAPABILITY','首版不支持文件上传');
  if(el.matches('a[download]'))return fail('UNSUPPORTED_CAPABILITY','首版不支持下载文件');
  if(q.kind==='fill' && !(el.matches('input,textarea')||el.isContentEditable))return fail('NOT_EDITABLE','目标不可编辑');
  if(q.kind==='fill' && (el.readOnly || el.matches('input[type=checkbox],input[type=radio],input[type=range],input[type=button],input[type=submit],input[type=color],input[type=date]')))return fail('NOT_EDITABLE','该字段不支持文本填写');
  const p=position(el),local=el.getBoundingClientRect();
  const x=Math.max(0,Math.min(innerWidth-1,p.x+p.width/2)),y=Math.max(0,Math.min(innerHeight-1,p.y+p.height/2));
  if(p.x+p.width<=0||p.y+p.height<=0||p.x>=innerWidth||p.y>=innerHeight)return fail('NOT_ACTIONABLE','目标在视口之外，请先 scroll 后重新 observe');
  let hit=el.getRootNode().elementFromPoint(local.x+local.width/2,local.y+local.height/2);
  if(hit!==el&&!el.contains(hit))return fail('NOT_ACTIONABLE','目标被其他元素遮挡');
  let doc=el.ownerDocument,hx=local.x+local.width/2,hy=local.y+local.height/2;
  while(doc!==document){const frame=doc.defaultView.frameElement,fr=frame.getBoundingClientRect();if(frame.ownerDocument.defaultView.getComputedStyle(frame).transform!=='none'||Math.abs(fr.width-frame.offsetWidth)>1)return fail('UNSUPPORTED_CAPABILITY','暂不支持经缩放或变换的 iframe 内操作');hx+=fr.x+frame.clientLeft;hy+=fr.y+frame.clientTop;hit=frame.getRootNode().elementFromPoint(hx,hy);if(hit!==frame)return fail('NOT_ACTIONABLE','框架被其他元素遮挡');doc=frame.ownerDocument;}
  return {...current(),ref,x,y,bounds:p,editable:el.matches('input,textarea')||el.isContentEditable};
}
if(q.action==='focus'){
  el.focus({preventScroll:true});
  if(q.selectAll){if(typeof el.select==='function')el.select();else if(el.isContentEditable){const range=el.ownerDocument.createRange();range.selectNodeContents(el);const selection=el.ownerDocument.getSelection();selection.removeAllRanges();selection.addRange(range);}}
  return {...current(),focused:el.getRootNode().activeElement===el||el.ownerDocument.activeElement===el};
}
if(q.action==='select'){
  if(el.tagName!=='SELECT')return fail('NOT_SELECT','目标不是原生 select，请使用 observe + click');
  if(!el.multiple&&q.values.length!==1)return fail('INVALID_ARGUMENT','单选字段只允许一个值');
  const options=[...el.options];
  if(q.values.some(v=>!options.some(o=>o.value===v&&!o.disabled&&!o.parentElement.disabled)))return fail('OPTION_NOT_FOUND','选项不存在或不可用');
  for(const option of options)option.selected=q.values.includes(option.value);
  el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
  return {...current(),selected:[...el.selectedOptions].map(o=>o.value)};
}
return fail('INVALID_ARGUMENT','未知浏览器操作');
`;

export function createAgentBrowser({ getWebContents }: { getWebContents: () => WebContents }) {
  const leases = new Map<WebContents, BrowserDebuggerLease>();
  function contents(guard: () => void) {
    guard(); const wc = getWebContents();
    if (wc.isDestroyed()) throw new BrowserActionError("TARGET_CHANGED", "浏览环境已关闭");
    return wc;
  }
  function attached(wc: WebContents) {
    let lease = leases.get(wc);
    if (!lease) {
      lease = acquireBrowserDebugger(wc); leases.set(wc, lease);
      wc.once("destroyed", () => { lease?.release(); leases.delete(wc); });
    }
    return lease;
  }
  async function run(wc: WebContents, action: string, input: Record<string, unknown>, guard: () => void): Promise<Record<string, unknown>> {
    guard(); if (getWebContents() !== wc) throw new BrowserActionError("TARGET_CHANGED", "浏览环境已变化");
    const q = { ...input, action, seed: randomUUID() };
    let result: Record<string, unknown>;
    try {
      result = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: `(()=>{const q=${JSON.stringify(q)};${WORLD}})()` }]) as Record<string, unknown>;
    } catch (error) {
      throw new BrowserActionError("TARGET_CHANGED", error instanceof Error ? error.message : "页面已变化");
    }
    guard(); if (getWebContents() !== wc) throw new BrowserActionError("TARGET_CHANGED", "浏览环境已变化");
    if (result.error) { const e = result.error as Record<string, string>; throw new BrowserActionError(e.code || "BROWSER_ERROR", e.message || "页面操作失败"); }
    return result;
  }
  async function prepared(wc: WebContents, input: Record<string, unknown>, guard: () => void) {
    const deadline = Date.now() + bounded(input.timeoutMs, 3000, 10000);
    for (;;) {
      try {
        const first = await run(wc, "prepare", input, guard);
        await pause(70);
        const second = await run(wc, "prepare", input, guard);
        if (JSON.stringify(first.bounds) !== JSON.stringify(second.bounds)) throw new BrowserActionError("NOT_STABLE", "目标仍在移动，请等待稳定后重新观察");
        return second;
      } catch (error) {
        if (!(error instanceof BrowserActionError) || !["NOT_ACTIONABLE", "NOT_STABLE"].includes(error.code) || Date.now() >= deadline) throw error;
        await pause(Math.min(100, Math.max(0, deadline - Date.now())));
      }
    }
  }
  async function call(method: string, input: Record<string, unknown>, guard: () => void): Promise<Record<string, unknown>> {
    const wc = contents(guard);
    attached(wc);
    const timeout = bounded(input.timeoutMs, 3000, 10000);
    if (method === "observe") {
      const maxBytes = bounded(input.maxBytes, 65536, 262144, 1024);
      const result = await run(wc, "observe", { ...input, maxNodes: bounded(input.maxNodes, 200, 1000), maxBytes }, guard);
      const nodes = result.nodes as unknown[];
      while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && nodes.length) { nodes.pop(); result.truncated = true; }
      while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && typeof result.text === "string" && result.text.length) { result.text = result.text.slice(0, Math.floor(result.text.length * .7)); result.truncated = true; }
      return result;
    }
    if (method === "screenshot") {
      const state = await run(wc, "state", input, guard);
      let img = await wc.capturePage(); guard();
      const size = img.getSize();
      if (size.width > 1600) img = img.resize({ width: 1600 });
      return { ...state, text: undefined, image: { data: img.toJPEG(80).toString("base64"), mimeType: "image/jpeg" }, width: img.getSize().width, height: img.getSize().height };
    }
    if (method === "wait") {
      if (!input.text && !input.url && !input.ref && input.state !== "load") throw new BrowserActionError("INVALID_ARGUMENT", "wait 需要 text、url、ref 或 load 条件");
      const deadline = Date.now() + timeout;
      do {
        let result;
        try { result = await run(wc, "condition", input, guard); }
        catch (error) { if (error instanceof BrowserActionError && error.code === "STALE_REFERENCE" && ["hidden","detached"].includes(String(input.state))) return { matched: true, state: input.state }; throw error; }
        if (result.matched) return result;
        await pause(Math.min(100, Math.max(0, deadline - Date.now())));
      } while (Date.now() < deadline);
      throw new BrowserActionError("TIMEOUT", "等待条件未在限定时间内满足", "not_executed", "observe_then_replan");
    }
    string(input.documentId, "documentId");
    if (method !== "scroll") string(input.ref, "ref");
    let dispatched = false;
    try {
      if (method === "click") {
        const target = await prepared(wc, { ...input, kind: "click" }, guard);
        const button = input.button === undefined ? "left" : input.button;
        if (button !== "left" && button !== "right" && button !== "middle") throw new BrowserActionError("INVALID_ARGUMENT", "无效鼠标按钮");
        const clickCount = bounded(input.clickCount, 1, 2);
        guard(); dispatched = true;
        trustedInput(wc, () => {
          wc.sendInputEvent({ type: "mouseMove", x: Math.round(Number(target.x)), y: Math.round(Number(target.y)) });
          wc.sendInputEvent({ type: "mouseDown", x: Math.round(Number(target.x)), y: Math.round(Number(target.y)), button, clickCount });
          wc.sendInputEvent({ type: "mouseUp", x: Math.round(Number(target.x)), y: Math.round(Number(target.y)), button, clickCount });
        });
        return { ...target, outcome: "executed", verification: "observe_required" };
      }
      if (method === "fill") {
        if (typeof input.value !== "string" || input.value.length > 100000) throw new BrowserActionError("INVALID_ARGUMENT", "value 必须为不超过 100000 字符的文本");
        await prepared(wc, { ...input, kind: "fill" }, guard);
        await run(wc, "focus", { ...input, selectAll: true }, guard);
        guard(); dispatched = true;
        if (input.value) await trustedInput(wc, () => wc.insertText(input.value as string));
        else trustedInput(wc, () => { wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" }); wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" }); });
        const result = await run(wc, "inspect", input, guard);
        return { ...result, outcome: "executed", verification: result.value === input.value || result.value === "[password]" ? "value_matched" : "observe_required" };
      }
      if (method === "press") {
        const key = string(input.key, "key", 80);
        const parts = key.split("+"), keyCode = parts.pop()!;
        const aliases: Record<string, string> = { Control: "control", Ctrl: "control", Alt: "alt", Shift: "shift", Meta: "meta", Command: "meta", Cmd: "meta", ControlOrMeta: process.platform === "darwin" ? "meta" : "control" };
        const modifiers = parts.map(p => aliases[p]);
        if (modifiers.some(m => !m) || !/^(?:[A-Za-z0-9]|Enter|Return|Tab|Escape|Esc|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Up|Down|Left|Right|Home|End|PageUp|PageDown|Space|F(?:[1-9]|1[0-2]))$/.test(keyCode)) throw new BrowserActionError("INVALID_ARGUMENT", "不支持的按键组合");
        await prepared(wc, { ...input, kind: "press" }, guard);
        await run(wc, "focus", input, guard);
        const normalized = keyCode.replace(/^Arrow/, "").replace(/^Enter$/, "Return").replace(/^Space$/, " ");
        guard(); dispatched = true;
        trustedInput(wc, () => { wc.sendInputEvent({ type: "keyDown", keyCode: normalized, modifiers: modifiers as NonNullable<KeyboardInputEvent["modifiers"]> }); if ((normalized.length === 1 || normalized === "Return") && !parts.length) wc.sendInputEvent({ type: "char", keyCode: normalized === "Return" ? "\r" : normalized }); wc.sendInputEvent({ type: "keyUp", keyCode: normalized, modifiers: modifiers as NonNullable<KeyboardInputEvent["modifiers"]> }); });
        return { outcome: "executed", documentId: input.documentId, ref: input.ref, key, verification: "observe_required" };
      }
      if (method === "select") {
        if (!Array.isArray(input.values) || !input.values.length || input.values.length > 100 || input.values.some(v => typeof v !== "string" || v.length > 4096)) throw new BrowserActionError("INVALID_ARGUMENT", "values 必须为选项值列表");
        await prepared(wc, { ...input, kind: "select" }, guard);
        guard(); dispatched = true;
        return { ...await run(wc, "select", input, guard), outcome: "executed", verification: "selected_values" };
      }
      if (method === "scroll") {
        const target = await run(wc, "scroll", input, guard);
        const direction = input.direction || "down", amount = bounded(input.amount, 500, 5000);
        if (!["up", "down", "left", "right"].includes(String(direction))) throw new BrowserActionError("INVALID_ARGUMENT", "无效滚动方向");
        const rect = target.position as Record<string, number>, viewport = target.viewport as Record<string, number>;
        const x = Math.round(Math.max(0, Math.min((viewport.width ?? 1) - 1, (rect.x ?? 0) + (rect.width ?? 1) / 2))), y = Math.round(Math.max(0, Math.min((viewport.height ?? 1) - 1, (rect.y ?? 0) + (rect.height ?? 1) / 2)));
        guard(); dispatched = true;
        trustedInput(wc, () => wc.sendInputEvent({ type: "mouseWheel", x, y, deltaY: direction === "up" ? -amount : direction === "down" ? amount : 0, deltaX: direction === "left" ? -amount : direction === "right" ? amount : 0 }));
        await pause(100);
        return { ...await run(wc, "scroll", input, guard), outcome: "executed" };
      }
      throw new BrowserActionError("INVALID_ARGUMENT", "未知浏览器工具");
    } catch (error) {
      if (method === "select" && error instanceof BrowserActionError && ["NOT_SELECT", "OPTION_NOT_FOUND", "INVALID_ARGUMENT"].includes(error.code)) throw error;
      if (dispatched && !(error instanceof BrowserActionError && error.outcome === "unknown")) throw new BrowserActionError("OUTCOME_UNKNOWN", error instanceof Error ? error.message : "输入已发出，结果待核验", "unknown", "inspect_command_and_observe");
      throw error;
    }
  }
  return { call, execute: call, dispose() { for (const lease of leases.values()) lease.release(); leases.clear(); } };
}
