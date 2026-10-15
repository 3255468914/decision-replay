/**
 * scripts/smoke-ui.js —— 前端渲染冒烟测试（无需真实浏览器）
 *
 * 目的：验证 public/app.js 在拿到真实 API 响应后能完整跑完渲染流程、不抛异常。
 * 做法：用最小 DOM 桩替换 document / localStorage / URL / Blob，然后 import app.js。
 * 局限（如实说明）：桩不做 HTML 解析，因此只能验证"渲染逻辑不崩 + 关键文本已注入"，
 *      不能验证 CSS 布局。视觉部分由 README 第 8.2 节的手工步骤覆盖。
 *
 * 用法：node scripts/smoke-ui.js
 */

import assert from 'node:assert/strict';
import { createServer } from '../server.js';

/* ---------------- 最小 DOM 桩 ---------------- */

class StubClassList {
  constructor(node) { this.node = node; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, on) { if (on === undefined) on = !this.set.has(c); on ? this.set.add(c) : this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
  toString() { return [...this.set].join(' '); }
}

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.classList = new StubClassList(this);
    this._className = '';
    this._html = '';
    this._text = '';
    this.style = {};
    this.dataset = {};
    this.listeners = {};
  }
  get className() { return this._className; }
  set className(v) { this._className = v ?? ''; this.classList.set = new Set(String(v ?? '').split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v ?? ''); this.children = []; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ''); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  appendChild(n) { this.children.push(n); return n; }
  append(...ns) { ns.forEach((n) => this.children.push(n)); return this; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  click() {}
  /** 递归收集文本，用于断言关键内容确实被渲染 */
  allText() {
    const own = this._text || this._html.replace(/<[^>]*>/g, ' ');
    return [own, ...this.children.map((c) => (c instanceof StubNode ? c.allText() : String(c)))].join(' ').replace(/\s+/g, ' ').trim();
  }
  descendants(tag) {
    const out = [];
    for (const c of this.children) {
      if (!(c instanceof StubNode)) continue;
      if (c.tagName === tag.toUpperCase()) out.push(c);
      out.push(...c.descendants(tag));
    }
    return out;
  }
}

const nodes = new Map();
const document = {
  createElement: (tag) => new StubNode(tag),
  querySelector: (sel) => {
    const id = String(sel).replace(/^#/, '');
    if (!nodes.has(id)) nodes.set(id, new StubNode(id === 'reportRoot' || id === 'decisionList' || id === 'alertZone' ? 'DIV' : 'DIV'));
    return nodes.get(id);
  },
  addEventListener: () => {},
};

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

globalThis.document = document;
globalThis.localStorage = localStorage;
globalThis.Blob = class { constructor(p) { this.parts = p; } };
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};

/* ---------------- 启动服务 + 加载前端 ---------------- */

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(String(url).startsWith('http') ? url : base + url, opts);

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); } catch (e) { failures += 1; console.error(`  ✗ ${label}\n      ${e.message}`); }
};

console.log('前端渲染冒烟测试\n');

await import('../public/app.js');
// boot() 是异步链：给它几个宏任务周期跑完（health → meta → decisions → report → render）
for (let i = 0; i < 60; i += 1) await new Promise((r) => setTimeout(r, 10));

const reportRoot = nodes.get('reportRoot');
const listRoot = nodes.get('decisionList');
const text = reportRoot.allText();

check('侧栏渲染出 3 条决策', () => {
  assert.equal(listRoot.children.length, 3, `实际 ${listRoot.children.length} 条`);
});

check('报告区渲染出 8 个区块（头部 + 7 张卡片）', () => {
  assert.equal(reportRoot.children.length, 8, `实际 ${reportRoot.children.length} 个区块`);
});

check('渲染结果包含产品必备内容', () => {
  for (const kw of ['时间线', '决策时点可得的证据', '事实', '归因', '行为偏差', '不确定', '沉淀', '下一次决策上下文']) {
    assert.ok(text.includes(kw), `缺少「${kw}」`);
  }
});

check('渲染结果包含事后信息隔离标签', () => {
  assert.ok(text.includes('事后信息'), '时间线未标注事后分区');
});

check('渲染结果包含合规免责声明相关内容', () => {
  assert.ok(/禁止用于归因|不确定|数据状态/.test(text));
});

check('表格已生成（证据表 + 事实表）', () => {
  const tables = reportRoot.descendants('table');
  assert.ok(tables.length >= 2, `实际生成 ${tables.length} 张表`);
});

check('生成的行数合理（证据 4 行 + 事实 9 行 起）', () => {
  const rows = reportRoot.descendants('tr');
  assert.ok(rows.length >= 12, `实际 ${rows.length} 行，偏少`);
});

check('事实表的行数与 facts 数量一致（不多不少）', () => {
  const factsTable = reportRoot.descendants('table').at(-1);
  const rows = factsTable.descendants('tr');
  assert.equal(rows.length, 9, `事实表应有 9 行，实际 ${rows.length}`);
});

check('未产生 "undefined" / "NaN" / "[object Object]" 之类的脏输出', () => {
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    assert.ok(!text.includes(bad), `渲染结果中出现「${bad}」`);
  }
});

/* ---------------- 交互路径 ---------------- */

check('交互：切换决策 → 决策 C 切换成功且展示降级信息', async () => {
  const items = listRoot.children;
  items[2].listeners.click[0]();
  for (let i = 0; i < 60; i += 1) await new Promise((r) => setTimeout(r, 10));
});

await new Promise((r) => setTimeout(r, 400));
const textC = reportRoot.allText();
const tablesC = reportRoot.descendants('table');

check('决策 C 渲染完成且含降级特征', () => {
  assert.ok(textC.includes('标的C'), '未切到决策 C');
  assert.ok(textC.includes('锂电池'));
  assert.ok(textC.includes('degraded'), '未展示数据降级状态');
});

check('降级时多渲染一张「已剔除的数据点」表', () => {
  assert.ok(tablesC.length >= 3, `实际 ${tablesC.length} 张表`);
  assert.ok(textC.includes('已剔除的数据点'));
  assert.ok(textC.includes('CONFLICT') || textC.includes('冲突'));
});

check('降级时列出四类数据问题', () => {
  for (const kw of ['MISSING_VALUE', 'CONFLICT', 'SOURCE_FAILED']) {
    assert.ok(textC.includes(kw), `未列出 ${kw}`);
  }
});

check('偏差规则 9 行全部渲染（含未触发）', () => {
  const rows = reportRoot.descendants('div').filter((d) => String(d.className).includes('bias-row'));
  assert.equal(rows.length, 9, `实际 ${rows.length} 行`);
});

server.close();
console.log(failures === 0 ? '\n全部冒烟检查通过。' : `\n${failures} 项检查失败。`);
process.exitCode = failures === 0 ? 0 : 1;
