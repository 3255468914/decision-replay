/**
 * app.js —— 前端渲染层
 *
 * 设计原则：
 *  1. 页面不做任何金融计算，"事实—归因—偏差"全部由服务端返回，前端只负责呈现与可追溯跳转。
 *  2. 三类信息在视觉上必须可分：事前（蓝）/ 事后（橙，标注"禁止用于归因"）/ 不确定（黄）。
 *  3. 任何降级都必须显式可见 —— 不允许出现"数据正常"式的默认文案。
 */

const state = {
  decisions: [],
  current: null,
  report: null,
  meta: null,
  asOfOffsetDays: 0,
  fault: '',
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : String(v ?? '—'));
const retClass = (v) => (typeof v !== 'number' ? 'ret-flat' : v > 0 ? 'ret-up' : v < 0 ? 'ret-down' : 'ret-flat');
const retText = (v) => (typeof v !== 'number' ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);

/**
 * localStorage 在 file:// 协议或隐私模式下可能抛异常。
 * 清单勾选只是便利功能，不能因为它导致整页崩掉，因此统一走安全封装。
 */
const safeStore = {
  get(key) {
    try {
      return JSON.parse(window.localStorage.getItem(key) ?? '[]');
    } catch {
      return [];
    }
  },
  set(key, arr) {
    try {
      window.localStorage.setItem(key, JSON.stringify(arr));
    } catch {
      /* 忽略：存储不可用时仅丢失勾选状态 */
    }
  },
};

/* ------------------------------------------------------------------ */
/* 数据获取                                                            */
/* ------------------------------------------------------------------ */

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  let body = null;
  try {
    body = await res.json();
  } catch {
    throw { code: 'BAD_RESPONSE', message: `服务返回了非 JSON 响应（HTTP ${res.status}）` };
  }
  if (!res.ok || body?.ok === false) {
    throw { ...(body?.error ?? {}), status: res.status };
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* 侧栏                                                                */
/* ------------------------------------------------------------------ */

function renderDecisionList() {
  const ul = $('#decisionList');
  ul.innerHTML = '';
  for (const d of state.decisions) {
    const li = el('li', 'decision-item' + (state.current === d.id ? ' active' : ''));
    li.innerHTML = `
      <div class="row1">
        <span class="name">${esc(d.name)}</span>
        <span class="code">${esc(d.symbol)}</span>
      </div>
      <div class="row2">
        <span>${esc((d.decidedAt ?? '').slice(0, 10))} 建仓</span>
        <span class="${retClass(d.returnPct)}">${d.closed ? retText(d.returnPct) : '持仓中'}</span>
      </div>`;
    li.addEventListener('click', () => selectDecision(d.id));
    ul.appendChild(li);
  }
}

async function selectDecision(id) {
  state.current = id;
  renderDecisionList();
  await loadReport();
}

/* ------------------------------------------------------------------ */
/* 报告渲染                                                            */
/* ------------------------------------------------------------------ */

function renderAlerts() {
  const zone = $('#alertZone');
  zone.innerHTML = '';
  if (!state.report) return;
  const q = state.report.quality;
  if (q?.banner) {
    const cls = q.status === 'blocked' ? 'alert-error' : 'alert-warn';
    const box = el('div', `alert ${cls}`, `<strong>数据状态：${esc(q.status)}</strong><br>${esc(q.banner)}`);
    const ul = el('ul');
    for (const i of q.issues.slice(0, 6)) {
      ul.appendChild(el('li', '', `[${esc(i.severity)}] ${esc(i.code)}${i.ref ? ` · <span class="mono">${esc(i.ref)}</span>` : ''}：${esc(i.message)}`));
    }
    if (q.issues.length > 6) ul.appendChild(el('li', '', `……另有 ${q.issues.length - 6} 项同类问题，完整清单见导出 JSON。`));
    box.appendChild(ul);
    zone.appendChild(box);
  }
  if (state.report.compliance?.sanitizeHits?.length) {
    zone.appendChild(
      el('div', 'alert alert-warn', `<strong>合规护栏命中 ${state.report.compliance.sanitizeHits.length} 处</strong>，输出文本已被中性化（详见导出 JSON 的 compliance.sanitizeHits）。`),
    );
  }
}

function renderHead() {
  const r = state.report;
  const box = el('section', 'card report-head');
  const statusCls = { ok: 'pill-ok', degraded: 'pill-warn', blocked: 'pill-error' }[r.quality.status] ?? 'pill-neutral';
  box.innerHTML = `
    <div class="kv" style="margin-bottom:6px">
      <div><span>标的</span>${esc(r.decision.name)} · <span class="mono">${esc(r.symbol)}</span></div>
      <div><span>决策时点</span><span class="mono">${esc(r.asOfDecisionTime)}</span></div>
      <div><span>平仓时点</span><span class="mono">${esc(r.exit?.exitedAt ?? '持仓中')}</span></div>
      <div><span>数据状态</span><span class="pill ${statusCls}">${esc(r.quality.status)}</span></div>
    </div>
    <div class="headline">${esc(r.summary.headline)}</div>
    <div class="kv">
      <div><span>过程风险</span>${esc(r.summary.processRiskLevel)}</div>
      <div><span>判定依据</span>${esc(r.summary.processRiskReason)}</div>
      <div><span>主要不确定项</span>${esc(r.summary.keyUncertainty.join('；') || '—')}</div>
      <div><span>时点闸门</span>事前 ${r.pit.exAnteCount} 点 / 事后 ${r.pit.exPostCount} 点 · 事件 事前${r.pit.eventExAnteCount}/事后${r.pit.eventExPostCount}</div>
    </div>`;
  return box;
}

function renderTimeline() {
  const r = state.report;
  const box = el('section', 'card');
  box.appendChild(el('h3', '', '<span class="idx">1</span>时间线：把交易、理由、数据、事件对齐到同一根轴'));
  box.appendChild(el('p', 'card-sub', '蓝色 = 决策时点之前已可得（可用于归因）；橙色 = 决策之后才出现（列示但禁止用于归因），用于对抗后见之明。'));
  const tl = el('div', 'timeline');
  for (const it of r.timeline) {
    const isPost = it.bucket === 'exPost';
    const node = el('div', `tl-item ${isPost ? 'exPost' : ''} ${it.kind === 'exit' ? 'exit' : ''}`);
    node.innerHTML = `
      <div class="tl-head">
        <span class="tl-time">${esc(it.at)}</span>
        <span class="tl-title">${esc(it.title)}</span>
        ${isPost ? '<span class="pill pill-post">事后信息 · 禁止用于归因</span>' : ''}
      </div>
      <div class="tl-detail">${esc(it.detail ?? '')}</div>
      <div class="tl-ref">来源：${esc(it.ref)}</div>`;
    tl.appendChild(node);
  }
  box.appendChild(tl);
  return box;
}

function renderEvidence() {
  const r = state.report;
  const box = el('section', 'card');
  box.appendChild(el('h3', '', '<span class="idx">2</span>决策时点可得的证据（每行都能回到原始字段）'));
  box.appendChild(el('p', 'card-sub', '按序列取"决策时点可获得的最新一期"，并同时列出 asOf（所属时点）与 publishedAt（可得时点）——两者不同正是披露时滞。'));

  // 每个序列取该时点可得的最新一期
  const latest = new Map();
  for (const e of r.exAnteEvidence) {
    const t = Date.parse(e.publishedAt ?? e.asOf);
    const cur = latest.get(e.series);
    if (!cur || t > cur._t) latest.set(e.series, { ...e, _t: t });
  }
  const rows = [...latest.values()].sort((a, b) => String(a.series).localeCompare(String(b.series)));

  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>指标序列</th><th class="num">取值</th><th>单位</th><th>所属时点 asOf</th><th>可得时点 publishedAt</th><th>来源</th>
  </tr></thead>`;
  const tb = el('tbody');
  for (const e of rows) {
    const missing = e.value === null || e.value === undefined;
    tb.appendChild(
      el(
        'tr',
        '',
        `<td class="mono">${esc(e.series)}</td>
         <td class="num" style="${missing ? 'color:#c0392b' : ''}">${missing ? '缺失' : esc(fmt(e.value))}</td>
         <td>${esc(e.unit ?? '')}</td>
         <td class="mono">${esc((e.asOf ?? '').replace('T', ' '))}</td>
         <td class="mono">${esc((e.publishedAt ?? e.asOf ?? '').replace('T', ' '))}</td>
         <td class="mono">${esc(e.source ?? '未标注')}</td>`,
      ),
    );
  }
  table.appendChild(tb);
  box.appendChild(table);

  if (r.quality.removedPoints?.length) {
    box.appendChild(el('p', 'card-sub', '<br><strong>已剔除的数据点（冲突 / 接口失败）：</strong>'));
    const t2 = el('table');
    t2.innerHTML = '<thead><tr><th>序列</th><th class="num">值</th><th>所属时点</th><th>来源</th><th>异常类型</th></tr></thead>';
    const b2 = el('tbody');
    for (const p of r.quality.removedPoints) {
      b2.appendChild(
        el('tr', '', `<td class="mono">${esc(p.series)}</td><td class="num">${esc(fmt(p.value))}</td>
          <td class="mono">${esc((p.asOf ?? '').replace('T', ' '))}</td><td class="mono">${esc(p.source ?? '')}</td>
          <td>${esc(p.injected ?? '接口失败')}</td>`),
      );
    }
    t2.appendChild(b2);
    box.appendChild(t2);
  }
  return box;
}

function renderFacts() {
  const r = state.report;
  const box = el('section', 'card');
  box.appendChild(el('h3', '', '<span class="idx">3</span>事实：可回到原始字段的计算结果'));
  box.appendChild(el('p', 'card-sub', '事实层不含任何解释，只做拆解。每条都带来源、口径与派生关系。'));
  const table = el('table');
  table.innerHTML = '<thead><tr><th>事实项</th><th class="num">值</th><th>单位</th><th>来源 / 派生</th><th>统计口径</th></tr></thead>';
  const tb = el('tbody');
  for (const f of r.facts) {
    tb.appendChild(
      el('tr', '', `<td>${esc(f.label)}</td><td class="num">${esc(fmt(f.value))}</td><td>${esc(f.unit ?? '')}</td>
        <td class="mono">${esc(f.source)}</td><td class="mono">${esc(f.caliber ?? '—')}</td>`),
    );
  }
  table.appendChild(tb);
  box.appendChild(table);
  return box;
}

function renderAttribution() {
  const r = state.report;
  const box = el('section', 'card');
  box.appendChild(el('h3', '', '<span class="idx">4</span>归因：带置信度与反事实检验'));
  box.appendChild(el('p', 'card-sub', '每条归因都必须回答：依据是什么、置信度为何不是 high、以及"如果换一种情形会怎样"。'));
  if (r.attribution.length === 0) {
    box.appendChild(el('div', 'alert alert-error', '未产出归因结论（事前证据不足，已阻断）。这不是"没有问题"，而是"无法判断"。'));
    return box;
  }
  for (const a of r.attribution) {
    const c = el('div', 'attr-item');
    c.innerHTML = `
      <h4>${esc(a.title)}<span class="badge badge-${esc(a.confidence)}">置信度 ${esc(a.confidence)}</span></h4>
      <p>${esc(a.statement)}</p>
      <div class="attr-meta">
        <div><b>置信度理由：</b>${esc(a.confidenceReason)}</div>
        <div><b>反事实检验：</b>${esc(a.counterCheck)}</div>
        <div><b>证据引用：</b><span class="mono">${esc(a.evidenceRefs.join(' · '))}</span></div>
      </div>`;
    box.appendChild(c);
  }
  return box;
}

function renderBiases() {
  const r = state.report;
  const box = el('section', 'card');
  const hit = r.biases.filter((b) => b.triggered === true).length;
  const na = r.biases.filter((b) => b.triggered === null).length;
  box.appendChild(el('h3', '', `<span class="idx">5</span>行为偏差：触发 ${hit} 条 / 未触发 ${r.biases.length - hit - na} 条 / 未判定 ${na} 条`));
  box.appendChild(el('p', 'card-sub', '未触发的规则同样列出——只报坏消息本身也是一种偏差（选择性呈现）。"未判定"代表数据不足，不等于"没问题"。'));
  for (const b of r.biases) {
    const badge = b.triggered === true ? '<span class="badge badge-hit">已触发</span>' : b.triggered === false ? '<span class="badge badge-miss">未触发</span>' : '<span class="badge badge-unknown">未判定</span>';
    const row = el('div', 'bias-row');
    row.innerHTML = `
      <div>
        <div class="bias-name">${esc(b.name)}</div>
        <div style="margin-top:4px">${badge}</div>
        ${b.metrics ? `<div class="bias-metrics">${esc(JSON.stringify(b.metrics))}</div>` : ''}
      </div>
      <div>
        <div class="bias-explain">${esc(b.explanation)}</div>
        <div class="bias-counter">${esc(b.counterCheck)}</div>
        <div class="bias-counter mono">证据：${esc((b.evidenceRefs ?? []).join(' · ') || '—')}</div>
      </div>`;
    box.appendChild(row);
  }
  return box;
}

function renderUncertainty() {
  const r = state.report;
  const box = el('section', 'card');
  box.appendChild(el('h3', '', '<span class="idx">6</span>不确定与数据限制'));
  box.appendChild(el('p', 'card-sub', '已知的未知必须写出来，否则"没有提到"会被误读成"不存在"。'));
  const ul = el('ul');
  for (const u of r.uncertainty) {
    ul.appendChild(el('li', '', `<strong>${esc(u.title)}</strong>：${esc(u.statement)}`));
  }
  box.appendChild(ul);
  return box;
}

function renderLearnings() {
  const r = state.report;
  const box = el('section', 'card');
  box.appendChild(el('h3', '', '<span class="idx">7</span>沉淀：清单 / 提醒 / 下一次决策上下文'));
  box.appendChild(el('p', 'card-sub', '复盘的产出不是"我当时应该怎样"，而是"下次决策前我要先做什么"。勾选状态保存在浏览器本地。'));

  const key = `replay-checklist:${r.decision.id}`;
  const saved = new Set(safeStore.get(key));
  const ul = el('ul', 'checklist');
  r.learnings.forEach((l, i) => {
    const id = `${key}:${i}`;
    const li = el('li', saved.has(id) ? 'done' : '');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = saved.has(id);
    cb.id = id;
    cb.addEventListener('change', () => {
      const s = new Set(safeStore.get(key));
      if (cb.checked) s.add(id);
      else s.delete(id);
      safeStore.set(key, [...s]);
      li.classList.toggle('done', cb.checked);
    });
    const label = el('label', '', `${esc(l.text)}<span class="tag">${esc(l.kind)}</span>`);
    label.setAttribute('for', id);
    li.append(cb, label);
    ul.appendChild(li);
  });
  box.appendChild(ul);

  if (r.reminders.length) {
    box.appendChild(el('p', 'card-sub', '<br><strong>提醒</strong>'));
    const ul2 = el('ul');
    for (const rm of r.reminders) ul2.appendChild(el('li', '', `⚑ ${esc(rm.text)}`));
    box.appendChild(ul2);
  }

  box.appendChild(el('p', 'card-sub', '<br><strong>下一次决策上下文（可直接带入下次决策记录）</strong>'));
  const pre = el('pre', 'json');
  pre.textContent = JSON.stringify(r.nextContext, null, 2);
  box.appendChild(pre);
  return box;
}

function renderReport() {
  const root = $('#reportRoot');
  root.innerHTML = '';
  root.append(
    renderHead(),
    renderTimeline(),
    renderEvidence(),
    renderFacts(),
    renderAttribution(),
    renderBiases(),
    renderUncertainty(),
    renderLearnings(),
  );
}

/* ------------------------------------------------------------------ */
/* 加载与交互                                                          */
/* ------------------------------------------------------------------ */

function computeAsOf() {
  const d = state.decisions.find((x) => x.id === state.current);
  if (!d || !state.asOfOffsetDays) return null;
  const t = Date.parse(d.decidedAt) + state.asOfOffsetDays * 86400000;
  if (Number.isNaN(t)) return null;
  // 转成 +08:00 的 ISO 字符串，保持与数据同一时区口径
  const shifted = new Date(t + 8 * 3600000);
  return shifted.toISOString().replace('Z', '+08:00');
}

async function loadReport() {
  if (!state.current) return;
  const root = $('#reportRoot');
  root.innerHTML = '<p class="spinner">正在按"决策时点"筛取证据并计算…</p>';
  $('#alertZone').innerHTML = '';

  const qs = new URLSearchParams();
  const asOf = computeAsOf();
  if (asOf) qs.set('asOf', asOf);
  if (state.fault) qs.set('fault', state.fault);

  try {
    const body = await fetchJson(`/api/report/${encodeURIComponent(state.current)}${qs.toString() ? '?' + qs : ''}`);
    state.report = body.report;
    renderAlerts();
    renderReport();
    $('#footerMeta').textContent = `报告生成于 ${body.report.generatedAt} · 决策时点 ${body.report.asOfDecisionTime}`;
  } catch (err) {
    state.report = null;
    renderAlerts();
    const box = el('div', 'alert alert-error');
    box.innerHTML = `
      <strong>未能生成复盘报告：${esc(err.code ?? 'UNKNOWN')}</strong><br>
      ${esc(err.message ?? '未知错误')}
      ${err.remediation ? `<br><br><b>建议：</b>${esc(err.remediation)}` : ''}
      ${err.status ? `<br><span class="mono">HTTP ${esc(err.status)}</span>` : ''}
      <br><br><b>产品行为说明：</b>此时不产出任何结论，也不会给出"看起来正常"的默认报告 ——
      缺少数据时的正确输出是"无法判断"，而不是"没有问题"。`;
    root.innerHTML = '';
    root.appendChild(box);
    $('#footerMeta').textContent = '报告未生成（上游异常）';
  }
}

function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function reportToMarkdown(r) {
  const L = [];
  L.push(`# 复盘报告｜${r.decision.name}（${r.symbol}）`, '');
  L.push(`- 决策时点：${r.asOfDecisionTime}`);
  L.push(`- 时点闸门：事前 ${r.pit.exAnteCount} / 事后 ${r.pit.exPostCount}；事件 事前 ${r.pit.eventExAnteCount} / 事后 ${r.pit.eventExPostCount}；时点缺失 ${r.pit.unknownCount}`);
  L.push(`- 数据状态：**${r.quality.status}**${r.quality.banner ? ' —— ' + r.quality.banner : ''}`, '');
  L.push(`> ${r.summary.headline}`, '');
  L.push('## 事实', '', '| 项 | 值 | 单位 | 来源 | 口径 |', '| --- | --- | --- | --- | --- |');
  for (const f of r.facts) L.push(`| ${f.label} | ${f.value} | ${f.unit ?? ''} | ${f.source} | ${f.caliber ?? '—'} |`);
  L.push('', '## 归因', '');
  for (const a of r.attribution) {
    L.push(`### ${a.title}（置信度 ${a.confidence}）`, '', a.statement, '');
    L.push(`- 置信度理由：${a.confidenceReason}`);
    L.push(`- 反事实检验：${a.counterCheck}`);
    L.push(`- 证据引用：${a.evidenceRefs.join(' · ')}`, '');
  }
  L.push('## 行为偏差', '', '| 规则 | 状态 | 说明 |', '| --- | --- | --- |');
  for (const b of r.biases) L.push(`| ${b.name} | ${b.triggered === true ? '触发' : b.triggered === false ? '未触发' : '未判定'} | ${String(b.explanation).replace(/\|/g, '\\|')} |`);
  L.push('', '## 不确定与数据限制', '');
  for (const u of r.uncertainty) L.push(`- **${u.title}**：${u.statement}`);
  L.push('', '## 沉淀清单', '');
  for (const l of r.learnings) L.push(`- [ ] ${l.text}`);
  L.push('', '## 下一次决策上下文', '', '```json', JSON.stringify(r.nextContext, null, 2), '```', '');
  L.push('---', '', r.compliance.disclaimer);
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  try {
    const health = await fetchJson('/api/health');
    $('#healthDot').textContent = `服务正常 · uptime ${health.uptimeSec}s`;
    $('#healthDot').className = 'pill pill-ok';
  } catch {
    $('#healthDot').textContent = '服务不可达';
    $('#healthDot').className = 'pill pill-error';
  }

  try {
    const meta = await fetchJson('/api/meta');
    state.meta = meta.meta;
    $('#dataSource').textContent = `数据源：${meta.meta.source} · ${meta.counts.marketPoints} 个数据点`;
    $('#dataSource').className = 'pill pill-warn';
  } catch (err) {
    $('#dataSource').textContent = `数据集不可用：${err.code ?? 'ERROR'}`;
    $('#dataSource').className = 'pill pill-error';
  }

  try {
    const body = await fetchJson('/api/decisions');
    state.decisions = body.decisions;
    renderDecisionList();
    if (state.decisions.length) await selectDecision(state.decisions[0].id);
  } catch (err) {
    $('#alertZone').innerHTML = `<div class="alert alert-error"><strong>无法加载决策列表：${esc(err.code ?? 'ERROR')}</strong><br>${esc(err.message ?? '')}</div>`;
  }

  $('#asOfPreset').addEventListener('change', (e) => {
    state.asOfOffsetDays = Number(e.target.value);
    loadReport();
  });
  $('#faultInject').addEventListener('change', (e) => {
    state.fault = e.target.value;
    loadReport();
  });
  $('#btnExportJson').addEventListener('click', () => {
    if (!state.report) return;
    download(`${state.report.decision.id}-review.json`, JSON.stringify(state.report, null, 2));
  });
  $('#btnExportMd').addEventListener('click', () => {
    if (!state.report) return;
    download(`${state.report.decision.id}-review.md`, reportToMarkdown(state.report), 'text/markdown');
  });
}

boot();
