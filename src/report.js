/**
 * report.js —— 复盘报告编排
 *
 * 输入一个决策 id + 数据集，输出一份完整报告对象。
 * 这是唯一把各层拼装起来的地方，也是 CLI / HTTP / 测试 共用的入口。
 */

import { parseTime, formatDateTime, formatDate, daysBetween } from './timeutil.js';
import { splitByDecisionTime, inHoldingWindow, PIT_BUCKET } from './pit.js';
import { analyzeReasoning } from './reasoning.js';
import { checkQuality, isUsable, filterUsablePoints, QUALITY_CODE } from './quality.js';
import { buildFacts, buildAttribution, buildUncertainty } from './attribution.js';
import { runBiasRules } from './bias.js';
import { sanitizeDeep, COMPLIANCE_DISCLAIMER } from './guardrails.js';
import { valueAtOrBefore, availableAt } from './market.js';

/* ------------------------------------------------------------------ */
/* 时间线                                                              */
/* ------------------------------------------------------------------ */

export function buildTimeline(ctx) {
  const { decision, exit, marketEvidence, exPostMarketEvidence = [], events } = ctx;
  const items = [];

  const push = (at, kind, bucket, title, detail, ref) => {
    if (parseTime(at) === null) return;
    items.push({ at, kind, bucket, title, detail, ref });
  };

  push(decision.decidedAt, 'decision', PIT_BUCKET.EX_ANTE, '做出决策', decision.reasoning, `decisions[${decision.id}].reasoning`);
  push(decision.executedAt, 'execution', PIT_BUCKET.EX_ANTE, `成交 ${decision.action} ${decision.quantity} 股 @ ${decision.price}`, decision.name ?? decision.symbol, `decisions[${decision.id}].executedAt`);

  const pushMarket = (e) => {
    push(
      e.publishedAt ?? e.asOf,
      'market',
      e._bucket,
      `行情/估值快照：${e.series}`,
      `所属时点 ${e.asOf}｜值 ${e.value} ${e.unit ?? ''}｜来源 ${e.source ?? '未标注'}`,
      `market[series=${e.series}]`,
    );
  };
  for (const e of marketEvidence) pushMarket(e);
  for (const e of exPostMarketEvidence) pushMarket(e);

  for (const ev of events) {
    push(ev.publishedAt, 'event', ev._bucket, `事件：${ev.title}`, `${ev.category ?? ''}｜影响：${ev.impact ?? '未评级'}｜来源 ${ev.source ?? '未标注'}${ev.summary ? '｜' + ev.summary : ''}`, `events[${ev.id}]`);
  }
  if (exit) {
    push(exit.exitedAt, 'exit', PIT_BUCKET.EX_POST, `平仓 @ ${exit.exitPrice}`, exit.exitReason ?? '', `exits[${exit.decisionId}].exitedAt`);
  }

  return items.sort((a, b) => parseTime(a.at) - parseTime(b.at));
}

/* ------------------------------------------------------------------ */
/* 学习沉淀                                                            */
/* ------------------------------------------------------------------ */

function buildLearnings(report) {
  const items = [];
  const triggered = report.biases.filter((b) => b.triggered === true);
  const undetermined = report.biases.filter((b) => b.triggered === null);

  for (const b of triggered) {
    items.push({ kind: 'checklist', from: b.id, text: `下一次决策前自问：${b.counterCheck.replace(/^反例检查：/, '')}` });
  }
  if (triggered.length === 0 && undetermined.length === 0) {
    items.push({ kind: 'checklist', from: 'GLOBAL', text: '本次未触发现有偏差规则，仍建议在下次决策前复述一遍事前证伪条件。' });
  }
  for (const u of report.uncertainty.filter((x) => x.id.startsWith('U-Q-'))) {
    items.push({ kind: 'data-gap', from: u.id, text: `补数据：${u.statement}` });
  }
  if (report.facts.find((f) => f.id === 'F-EXCESS') === undefined) {
    items.push({ kind: 'data-gap', from: 'F-EXCESS', text: '补数据：需要基准指数序列才能计算超额收益。' });
  }
  items.push({
    kind: 'method',
    from: 'GLOBAL',
    text: '复盘时先写结论三行：① 当时我能看到什么 ② 当时我做了什么 ③ 现在回看，这两者是否一致。写完再去看行情。',
  });
  return items;
}

function buildReminders(report) {
  const out = [];
  const gotcha = report.biases.filter((b) => b.triggered === true).map((b) => b.name);
  if (gotcha.length) out.push({ level: 'watch', text: `重复出现的模式：${gotcha.join('、')}。下次同类决策前先对照。` });
  if (report.quality.status !== 'ok') {
    out.push({ level: 'data', text: `本次复盘处于数据降级状态（${report.quality.status}），下列结论不可外推为"这是一次典型决策"。` });
  }
  if (!report.decision.preCommit?.invalidation) {
    out.push({ level: 'process', text: '下次买入前，先写下一句话的证伪条件，并确保它能被公开数据观测。' });
  }
  return out;
}

/** 下一次决策的上下文包：可直接复制到下次的决策记录里 */
function buildNextContext(report) {
  const d = report.decision;
  const last = report.attribution.find((a) => a.id === 'A-3');
  return {
    basedOnDecisionId: d.id,
    symbol: d.symbol,
    createdAt: new Date().toISOString(),
    carryOver: {
      previousInvalidation: d.preCommit?.invalidation ?? null,
      previousHorizon: d.horizon ?? null,
      previousStopLossPct: d.preCommit?.stopLossPct ?? null,
      previousTargetReturnPct: d.preCommit?.targetReturnPct ?? null,
    },
    mustFillBeforeNextDecision: [
      '一句话证伪条件（可被公开数据观测）',
      `退出底线（价格或基本面条件）——上一轮为 ${d.preCommit?.stopLossPct ?? '未设定'}`,
      `预设持有期限（上一轮为 ${d.horizon ?? '未填写'}）`,
      '至少 3 项可回到原始字段的决策依据',
    ],
    outstandingQuestions: report.uncertainty.map((u) => u.statement).slice(0, 6),
    planVsExecutionSummary: last?.statement ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 裁剪证据列表：每个序列只保留"可得时间"最后 n 个点（事件全量保留）。
 * 为什么要裁剪：前端只需要"决策时点附近最近几期"就能展示证据表，
 * 把上千个历史点塞进每个 API 响应会让载荷膨胀到 MB 级，且没有任何信息增量。
 * 注意：裁剪只作用于**输出**，参与计算的仍是全量数据；真实总数见 report.pit.exAnteCount。
 */
function trimEvidenceTail(list, n) {
  const groups = new Map();
  for (const it of list) {
    const key = it.kind === 'event' ? '__events__' : String(it.series);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const out = [];
  for (const [key, arr] of groups) {
    if (key === '__events__') {
      out.push(...arr);
      continue;
    }
    const sorted = [...arr].sort((a, b) => (parseTime(availableAt(a)) ?? 0) - (parseTime(availableAt(b)) ?? 0));
    out.push(...sorted.slice(-n));
  }
  return out;
}

export function buildReport(dataset, decisionId, options = {}) {
  const maxPointsPerSeries = options.maxPointsPerSeries ?? 40;
  const decision = dataset.decisions.find((d) => d.id === decisionId);
  if (!decision) {
    const err = new Error(`未找到决策记录：${decisionId}`);
    err.code = 'DECISION_NOT_FOUND';
    err.available = dataset.decisions.map((d) => d.id);
    throw err;
  }
  const exit = dataset.exits.find((e) => e.decisionId === decisionId) ?? null;

  // 让用户可以在 UI 上改"决策时点"，用于演示时点闸门的效果
  const decidedAt = options.asOfOverride ?? decision.decidedAt;
  const effectiveDecision = { ...decision, decidedAt };

  const symbol = decision.symbol;
  const priceSeries = `price:${symbol}`;
  const benchmarkSeries = dataset.meta?.benchmarkSeries ?? null;

  // ---- 时点闸门（用"可得时点"而非"所属时点"，才能正确处理财报披露时滞）----
  const marketSplit = splitByDecisionTime(dataset.market, (m) => availableAt(m), decidedAt);
  const eventSplit = splitByDecisionTime(dataset.events, (e) => e.publishedAt, decidedAt);

  // 只保留与该标的相关的序列，以及市场级序列（指数/宏观）
  const isRelevant = (series) =>
    String(series).includes(symbol) || /^(index:|pmi:|macro:)/.test(String(series));
  const pitRelevant = marketSplit.exAnte.filter((e) => isRelevant(e.series));

  // 事件同样按相关性过滤：relatedSymbols 为空视为市场级事件
  const eventRelevant = (ev) =>
    !ev.relatedSymbols || ev.relatedSymbols.length === 0 || ev.relatedSymbols.includes(symbol);
  const eventsExAnte = eventSplit.exAnte.filter(eventRelevant);
  const eventsExPost = eventSplit.exPost.filter(eventRelevant);

  // ---- 数据质量 ----
  const quality = checkQuality(pitRelevant, {
    asOfCutoff: decidedAt,
    staleDays: 7,
    staleness: {
      'price:': 7, // 日频行情：一周未更新即视为过期
      'index:': 7,
      'turnoverRate:': 7,
      'peTtm:': 400, // 估值：周频，允许较长间隔
      'pb:': 400,
      'dividendYield:': 400,
      'revenueYoy:': 400, // 财报：季频 + 披露时滞
      'netProfitYoy:': 400,
      'nplRatio:': 400,
      'pmi:': 40, // 月频宏观
    },
  });

  // 降级：只在本标的相关序列上剔除冲突/失败的数据点，并记录被剔除的点
  const relevantMarket = dataset.market.filter((p) => isRelevant(p.series));
  const { points: marketClean, removed } = filterUsablePoints(relevantMarket, quality.issues);
  quality.removedPoints = removed.map((p) => ({
    series: p.series, asOf: p.asOf, publishedAt: p.publishedAt ?? p.asOf,
    source: p.source ?? null, injected: p.injected ?? null, value: p.value,
  }));

  const pitEvidence = pitRelevant.filter(
    (e) => !removed.some((r) => r.series === e.series && r.asOf === e.asOf),
  );

  // 事后信息：决策之后才产生的行情点与事件，单独归集，打上"禁止用于归因"标签
  const exPostEvidence = [
    ...marketSplit.exPost.filter((m) => isRelevant(m.series)).map((m) => ({ ...m, kind: 'market' })),
    ...eventsExPost.map((e) => ({ ...e, kind: 'event' })),
  ];

  // ---- 理由解析（买入理由与卖出理由分开解析，锚定类措辞只在卖出理由里有意义）----
  const reasoning = analyzeReasoning(decision.reasoning, pitEvidence);
  const exitReasoning = analyzeReasoning(exit?.exitReason ?? '', pitEvidence);

  // ---- 上下文 ----
  const ctx = {
    decision: effectiveDecision,
    exit,
    market: marketClean,
    priceSeries,
    benchmarkSeries,
    pitEvidence,
    exPostEvidence,
    reasoning,
    exitReasoning,
    matchedClaimCount: reasoning.matchedTerms.length,
    unmatchedClaimCount: reasoning.unmatchedTerms.length,
  };

  // ---- 事实 / 归因 / 不确定 ----
  let facts = buildFacts(ctx);
  if (quality.status !== 'blocked') {
    facts = facts.filter((f) => {
      const ref = f.derivedFrom?.[0] ?? '';
      if (ref.startsWith('market[series=')) {
        const series = ref.slice('market[series='.length, -1);
        const ev = pitEvidence.find((e) => e.series === series);
        return isUsable(ev ?? {}, quality.issues);
      }
      return true;
    });
  }
  ctx.facts = facts;

  const attribution = quality.status === 'blocked' ? [] : buildAttribution(ctx, facts);
  const uncertainty = buildUncertainty(ctx, quality);
  const biases = quality.status === 'blocked'
    ? runBiasRules(ctx).map((b) => ({ ...b, triggered: null, explanation: '因事前证据缺失，本次复盘已阻断，偏差规则未判定。' }))
    : runBiasRules(ctx);

  const report = {
    generatedAt: new Date().toISOString(),
    asOfDecisionTime: decidedAt,
    decision: effectiveDecision,
    exit,
    symbol,
    priceSeries,
    benchmarkSeries,
    horizon: decision.horizon ?? null,
    quality,
    pit: {
      asOfDecisionTime: decidedAt,
      exAnteCount: pitRelevant.length,
      exPostCount: exPostEvidence.length,
      eventExAnteCount: eventsExAnte.length,
      eventExPostCount: eventsExPost.length,
      unknownCount: marketSplit.unknown.length + eventSplit.unknown.length,
      filteredOutBySymbol: marketSplit.exAnte.length - pitRelevant.length,
      issues: [...marketSplit.issues, ...eventSplit.issues],
    },
    timeline: buildTimeline({
      decision: effectiveDecision,
      exit,
      // 时间线只放"近期上下文"（每个序列最近 3 期）+ 全部事件，而不是逐日行情，
      // 否则时间线会变成 500 多个点，既不可读也没信息量。完整证据见 exAnteEvidence。
      marketEvidence: trimEvidenceTail(pitEvidence, 3),
      exPostMarketEvidence: trimEvidenceTail(exPostEvidence.filter((e) => e.kind === 'market'), 3),
      events: [...eventsExAnte, ...eventsExPost],
      priceSeries,
      benchmarkSeries,
    }),
    exAnteEvidence: trimEvidenceTail(pitEvidence, maxPointsPerSeries),
    exAnteEvidenceTruncated: pitEvidence.length > trimEvidenceTail(pitEvidence, maxPointsPerSeries).length,
    exPostEvidence: trimEvidenceTail(exPostEvidence, maxPointsPerSeries),
    evidenceTailPerSeries: maxPointsPerSeries,
    reasoning,
    facts,
    attribution,
    biases,
    uncertainty,
    compliance: { disclaimer: COMPLIANCE_DISCLAIMER, sanitizeHits: [] },
  };

  report.learnings = buildLearnings(report);
  report.reminders = buildReminders(report);
  report.nextContext = buildNextContext(report);
  report.summary = buildSummary(report);

  // ---- 合规清洗（最后一道闸门）----
  const sanitizeAcc = { hits: [] };
  const clean = sanitizeDeep(report, '$', sanitizeAcc);
  clean.compliance.sanitizeHits = sanitizeAcc.hits;
  return clean;
}

function buildSummary(report) {
  const ret = report.facts.find((f) => f.id === 'F-RET')?.value;
  const triggered = report.biases.filter((b) => b.triggered === true);
  const risk = triggered.length >= 3 ? '较高' : triggered.length >= 1 ? '中等' : '较低';
  return {
    headline:
      ret === null || ret === undefined
        ? `${report.decision.name ?? report.symbol}：持仓中，本次输出过程评估。`
        : `${report.decision.name ?? report.symbol}：持有期毛收益 ${ret}%（未计费用）。`,
    processRiskLevel: risk,
    processRiskReason: triggered.length
      ? `命中 ${triggered.length} 条行为规则：${triggered.map((b) => b.name).join('、')}。`
      : '未命中现有行为规则。',
    keyUncertainty: report.uncertainty.slice(0, 2).map((u) => u.title),
    dataStatus: report.quality.status,
  };
}

export { valueAtOrBefore, daysBetween, formatDateTime, formatDate, inHoldingWindow, QUALITY_CODE };
