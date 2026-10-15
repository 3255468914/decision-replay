/**
 * test/pipeline.test.js —— 主链路端到端 + 合规边界 + 可追溯性
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset, buildReport, sanitizeOutput, assertCompliant, COMPLIANCE_DISCLAIMER } from '../src/index.js';

const ds = loadDataset();

test('主链路：三条决策都能产出结构完整的报告', () => {
  for (const d of ds.decisions) {
    const r = buildReport(ds, d.id);
    assert.ok(r.timeline.length > 0, `${d.id} 时间线不应为空`);
    assert.ok(r.facts.length >= 5, `${d.id} 事实层过少`);
    assert.ok(r.attribution.length >= 2, `${d.id} 归因层过少`);
    assert.equal(r.biases.length, 9, `${d.id} 偏差规则数量应为 9（未触发也要列出）`);
    assert.ok(r.uncertainty.length >= 1, `${d.id} 必须至少有一项不确定说明`);
    assert.ok(r.learnings.length >= 1, `${d.id} 必须有沉淀清单`);
    assert.ok(r.nextContext.mustFillBeforeNextDecision.length >= 3);
  }
});

test('可追溯性：每条事实都带来源；每条归因都带证据引用', () => {
  const r = buildReport(ds, 'D-2024-0311-A');
  for (const f of r.facts) {
    assert.ok(f.source && f.source.length > 0, `事实 ${f.id} 缺少来源`);
  }
  for (const a of r.attribution) {
    assert.ok(a.evidenceRefs && a.evidenceRefs.length > 0, `归因 ${a.id} 缺少证据引用`);
    assert.ok(['high', 'medium', 'low'].includes(a.confidence), `归因 ${a.id} 置信度非法`);
    assert.ok(a.counterCheck && a.counterCheck.length > 0, `归因 ${a.id} 缺少反事实检验`);
  }
});

test('事实层与归因层在措辞上分离：事实不含解释性动词', () => {
  const r = buildReport(ds, 'D-2024-0311-A');
  const bannedWords = ['因为', '导致', '说明', '证明', '由于'];
  for (const f of r.facts) {
    for (const w of bannedWords) {
      assert.ok(!String(f.label).includes(w), `事实项标签不应含因果词「${w}」`);
    }
  }
});

test('报告不得含 undefined / null 字符串（防止字段拼接错位）', () => {
  for (const d of ds.decisions) {
    const r = buildReport(ds, d.id);
    const s = JSON.stringify(r);
    for (const bad of ['undefined', '[object Object]']) {
      const idx = s.indexOf(bad);
      assert.equal(idx, -1, `${d.id} 的报告中出现「${bad}」，上下文：…${s.slice(Math.max(0, idx - 120), idx + 40)}…`);
    }
    // 时间线的每一项都必须有标题与来源引用
    for (const t of r.timeline) {
      assert.ok(t.title && !String(t.title).includes('undefined'), `时间线条目缺少标题：${JSON.stringify(t).slice(0, 120)}`);
      assert.ok(t.ref && !String(t.ref).includes('undefined'), `时间线条目缺少来源引用：${JSON.stringify(t).slice(0, 120)}`);
    }
  }
});

test('偏差规则：三条决策的触发集合符合构造预期', () => {
  const a = buildReport(ds, 'D-2024-0311-A');
  const b = buildReport(ds, 'D-2024-0108-B');
  const c = buildReport(ds, 'D-2024-0520-C');
  const ids = (r) => r.biases.filter((x) => x.triggered).map((x) => x.id);

  // A：追涨 + 计划漂移 + 未设证伪条件 + 期限不符 + 依据不足
  assert.deepEqual(
    ids(a).sort(),
    ['B-CHASE', 'B-DISPOSITION', 'B-HINDSIGHT', 'B-HORIZON', 'B-INSUFFICIENT', 'B-NO-INVALIDATION'].sort(),
  );
  // B：流程完整（按止损离场、有证伪条件），不应命中纪律类规则
  assert.ok(!ids(b).includes('B-DISPOSITION'), '按计划止损离场不应被判为计划漂移');
  assert.ok(!ids(b).includes('B-CHASE'), '下跌途中建仓不应被判为追涨');
  assert.ok(!ids(b).includes('B-NO-INVALIDATION'));
  // C：锚定成本价（"回到成本价上方"）
  assert.ok(ids(c).includes('B-ANCHOR'), '卖出理由含"成本价"应触发锚定偏差');
  assert.ok(ids(c).includes('B-DISPOSITION'));
});

test('结果与过程分离：B 的收益最差，但过程纪律最好', () => {
  const a = buildReport(ds, 'D-2024-0311-A');
  const b = buildReport(ds, 'D-2024-0108-B');
  const ret = (r) => r.facts.find((f) => f.id === 'F-RET').value;
  const hits = (r) => r.biases.filter((x) => x.triggered).length;

  assert.ok(ret(b) < ret(a), 'B 的结果应比 A 差');
  assert.ok(hits(b) < hits(a), 'B 命中的问题应比 A 少 —— 这正是"结果导向"要警惕的反例');
});

test('时点闸门：事后事件被隔离，且不得出现在可归因证据里', () => {
  const r = buildReport(ds, 'D-2024-0311-A');
  const exPostIds = r.exPostEvidence.filter((e) => e.kind === 'event').map((e) => e.id);
  assert.ok(exPostIds.includes('E-D1-B'), '决策后发布的行业数据应被隔离');
  assert.ok(!r.exAnteEvidence.some((e) => e.id === 'E-D1-B'));
  const tl = r.timeline.find((t) => t.title.includes('E-D1-B') || t.detail.includes('3 月 11 日决策时尚未发布'));
  assert.ok(tl, '事后事件仍应在时间线上展示（但标注为禁止归因）');
  assert.equal(tl.bucket, 'exPost');
});

test('合规：输出中不得出现确定性预测 / 收益承诺 / 买卖建议 / 仓位建议', () => {
  for (const d of ds.decisions) {
    const r = buildReport(ds, d.id);
    assertCompliant(JSON.stringify(r.attribution));
    assertCompliant(JSON.stringify(r.biases));
    assertCompliant(JSON.stringify(r.learnings));
    assertCompliant(r.summary.headline);
  }
});

test('合规护栏：命中即被中和，并记录 hits 供审计', () => {
  const dirty = '该股必涨，建议买入，仓位建议 8 成，预计涨到 200 元，稳赚不赔。';
  const { clean, hits } = sanitizeOutput(dirty);
  assert.ok(hits.length >= 4);
  for (const ban of ['必涨', '建议买入', '仓位建议 8 成', '稳赚']) {
    assert.ok(!clean.includes(ban), `「${ban}」未被中和`);
  }
  for (const code of ['CERTAIN_DIRECTION', 'DIRECT_ADVICE', 'POSITION_ADVICE', 'PROFIT_PROMISE']) {
    assert.ok(hits.some((h) => h.code === code), `应命中规则 ${code}`);
  }
  assert.ok(COMPLIANCE_DISCLAIMER.includes('不构成任何投资建议'));
});

test('合规护栏：清洗发生在报告返回前的最后一步', () => {
  const r = buildReport(ds, 'D-2024-0311-A');
  assert.ok(Array.isArray(r.compliance.sanitizeHits));
  assert.equal(r.compliance.disclaimer, COMPLIANCE_DISCLAIMER);
});

test('错误处理：不存在的决策 id 抛结构化错误，并给出可用列表', () => {
  assert.throws(
    () => buildReport(ds, 'NOT-EXIST'),
    (err) => {
      assert.equal(err.code, 'DECISION_NOT_FOUND');
      assert.ok(Array.isArray(err.available) && err.available.length === 3);
      return true;
    },
  );
});

test('极端边界：数据点极少时不臆断，相关规则标记为「未判定」而非「未触发」', () => {
  const tiny = {
    meta: { source: 'test', benchmarkSeries: null },
    decisions: [
      {
        id: 'X1', symbol: '999999.SZ', name: '测试标的', action: 'buy',
        decidedAt: '2024-05-20T10:00:00+08:00', executedAt: '2024-05-20T10:00:00+08:00',
        price: 10, quantity: 100, horizon: '1M', reasoning: '感觉不错',
        preCommit: { targetReturnPct: null, stopLossPct: null, invalidation: '' },
      },
    ],
    exits: [],
    market: [{ series: 'price:999999.SZ', asOf: '2024-05-17T15:00:00+08:00', publishedAt: '2024-05-17T15:00:00+08:00', value: 10, unit: 'CNY', source: 'test' }],
    events: [],
  };
  const r = buildReport(tiny, 'X1');
  const chase = r.biases.find((b) => b.id === 'B-CHASE');
  assert.equal(chase.triggered, null, '样本不足时追涨规则必须为"未判定"，不能靠猜');

  // 未平仓时不得计算收益，也不得凭空生成"计划 vs 执行"
  assert.equal(r.facts.find((f) => f.id === 'F-RET'), undefined);
  assert.equal(r.attribution.find((a) => a.id === 'A-3'), undefined);
  assert.ok(r.uncertainty.some((u) => u.id === 'U-2'));
});

/**
 * 回归来源：界面上「决策时点闸门实验」的提示文案曾把方向写反
 * （声称"时点后移 → 事前证据被移入事后"，实际相反）。
 * 文案方向难以自动断言，但底层的**单调性**可以：时点越靠后，可得信息只增不减。
 * 这条断言把"方向"钉死在实现层面，任何反转都会立刻失败。
 */
test('时点闸门单调性：决策时点后移，事前证据只增不减、事后证据只减不增', () => {
  const d = ds.decisions.find((x) => x.id === 'D-2024-0311-A');
  const at = (off) =>
    new Date(Date.parse(d.decidedAt) + off * 86400000 + 8 * 3600000).toISOString().replace('Z', '+08:00');

  const seq = [0, 1, 7, 30, 90].map((off) => ({ off, r: buildReport(ds, d.id, { asOfOverride: at(off) }) }));

  for (let i = 1; i < seq.length; i += 1) {
    const prev = seq[i - 1];
    const cur = seq[i];
    assert.ok(
      cur.r.pit.exAnteCount >= prev.r.pit.exAnteCount,
      `时点后移后事前证据不应减少：+${prev.off} 天 ${prev.r.pit.exAnteCount} → +${cur.off} 天 ${cur.r.pit.exAnteCount}`,
    );
    assert.ok(
      cur.r.pit.exPostCount <= prev.r.pit.exPostCount,
      `时点后移后事后证据不应增加：+${prev.off} 天 ${prev.r.pit.exPostCount} → +${cur.off} 天 ${cur.r.pit.exPostCount}`,
    );
  }

  // 前两个分区不一定单调（财报披露有跳变），但端点必须体现"信息从后往前迁移"
  const first = seq[0].r.pit;
  const last = seq.at(-1).r.pit;
  assert.ok(last.exAnteCount > first.exAnteCount, '时点后移 90 天后事前证据应确有增加');
  assert.ok(last.exPostCount < first.exPostCount, '时点后移 90 天后事后证据应确有减少');
});
