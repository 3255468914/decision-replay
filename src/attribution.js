/**
 * attribution.js —— 事实层与归因层
 *
 * 严格分开三类输出：
 *   facts       事实：可从原始字段直接计算/引用，带 source 与 derivedFrom
 *   attribution 归因：在事实之上做的可复核拆解，必须带 confidence 与 counterCheck
 *   uncertainty 不确定：已知的未知，不允许被省略
 *
 * 语言纪律：不使用因果断言，不出现涨跌预测与买卖建议。
 */

import { parseTime, formatDate, daysBetween } from './timeutil.js';
import { valueAtOrBefore, pctChange, maxDrawdown, windowPoints, percentileRank } from './market.js';
import { availableAt } from './market.js';

const pct = (v, digits = 2) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);

function fact(id, label, value, unit, source, extra = {}) {
  return { id, type: 'fact', label, value, unit, source, ...extra };
}

export function buildFacts(ctx) {
  const { decision, exit, pitEvidence, priceSeries } = ctx;
  const facts = [];

  const entryPrice = decision.price;
  const qty = decision.quantity;
  const notional = Number.isFinite(entryPrice) && Number.isFinite(qty) ? entryPrice * qty : null;

  facts.push(
    fact('F-ENTRY', '买入成交', entryPrice, 'CNY/股', `decisions[${decision.id}].price`, {
      asOf: decision.executedAt ?? decision.decidedAt,
      derivedFrom: ['decisions.price', 'decisions.executedAt'],
      raw: { price: entryPrice, quantity: qty, notional, action: decision.action },
    }),
  );

  facts.push(
    fact('F-NOTIONAL', '建仓金额（未计费用）', notional, 'CNY', `decisions[${decision.id}].price × quantity`, {
      asOf: decision.executedAt ?? decision.decidedAt,
      derivedFrom: ['decisions.price', 'decisions.quantity'],
    }),
  );

  if (exit) {
    const ret = Number.isFinite(exit.exitPrice) && Number.isFinite(entryPrice) && entryPrice !== 0
      ? (exit.exitPrice / entryPrice - 1) * 100
      : null;
    const hold = exit.holdingDays ?? daysBetween(decision.executedAt ?? decision.decidedAt, exit.exitedAt);
    facts.push(
      fact('F-EXIT', '卖出成交', exit.exitPrice, 'CNY/股', `exits[${exit.decisionId}].exitPrice`, {
        asOf: exit.exitedAt,
        derivedFrom: ['exits.exitPrice', 'exits.exitedAt'],
      }),
    );
    facts.push(
      fact('F-RET', '持有期毛收益（未计费用/税费/滑点）', pct(ret), '%', '派生：(exitPrice / entryPrice - 1)', {
        asOf: exit.exitedAt,
        derivedFrom: ['decisions.price', 'exits.exitPrice'],
        caliber: '简单收益率，不含交易成本与分红再投资',
      }),
    );
    facts.push(
      fact('F-HOLD', '持有天数', hold, '自然日', '派生：(exitedAt - executedAt)', {
        asOf: exit.exitedAt,
        derivedFrom: ['decisions.executedAt', 'exits.exitedAt'],
      }),
    );
  }

  // 基准同期表现与超额
  const benchSeries = ctx.benchmarkSeries;
  if (exit && benchSeries) {
    const from = decision.executedAt ?? decision.decidedAt;
    const to = exit.exitedAt;
    const b = pctChange(ctx.market, benchSeries, from, to);
    const stockRet = Number.isFinite(exit.exitPrice) && Number.isFinite(entryPrice) && entryPrice !== 0
      ? (exit.exitPrice / entryPrice - 1) * 100
      : null;
    if (b) {
      facts.push(
        fact('F-BENCH', '同期基准收益', pct(b.pct), '%', `${benchSeries} 区间首末收盘价`, {
          asOf: to,
          derivedFrom: [`market[series=${benchSeries}]`],
          caliber: `区间 ${formatDate(b.first.asOf)} ~ ${formatDate(b.last.asOf)}，样本 ${b.sampleSize} 个交易日`,
        }),
      );
      if (stockRet !== null) {
        facts.push(
          fact('F-EXCESS', '相对基准超额收益', pct(stockRet - b.pct), '%', '派生：(个股收益 - 基准收益)', {
            asOf: to,
            derivedFrom: ['F-RET', 'F-BENCH'],
            caliber: '算术差，非回归 alpha；未做行业中性化',
          }),
        );
      }
    }
  }

  // 持有期最大回撤
  if (exit && priceSeries) {
    const dd = maxDrawdown(ctx.market, priceSeries, decision.executedAt ?? decision.decidedAt, exit.exitedAt);
    if (dd) {
      facts.push(
        fact('F-DD', '持有期最大回撤', pct(dd.pct), '%', `${priceSeries} 持有区间序列`, {
          asOf: exit.exitedAt,
          derivedFrom: [`market[series=${priceSeries}]`],
          caliber: `${formatDate(dd.peak.asOf)} 高点 → ${formatDate(dd.trough.asOf)} 低点，样本 ${dd.sampleSize} 个交易日`,
        }),
      );
    }
  }

  // 决策时点估值分位（事前证据）
  const pePts = pitEvidence
    .filter((e) => e.series?.startsWith('peTtm:') && Number.isFinite(e.value))
    .sort((a, b) => (parseTime(availableAt(a)) ?? 0) - (parseTime(availableAt(b)) ?? 0));
  if (pePts.length > 0) {
    const p = pePts.at(-1);
    const rank = percentileRank(ctx.market, p.series, p.value, ctx.decision.decidedAt);
    facts.push(
      fact('F-VAL', '决策时点估值分位', rank ? pct(rank.percentile, 1) : p.value, rank ? '%' : p.unit, p.source, {
        asOf: p.asOf,
        publishedAt: p.publishedAt ?? p.asOf,
        derivedFrom: [`market[series=${p.series}]`],
        caliber: rank
          ? `以该序列在决策时点及之前全部可得点为样本（${rank.sampleSize} 个），计算当前值所处百分位`
          : '样本不足（<10 个可得点），直接给出原值而不计算分位',
      }),
    );
  }

  return facts;
}

/**
 * 归因：把"结果"拆成可复核的构成，但不宣称因果。
 */
export function buildAttribution(ctx, facts) {
  const { decision, exit, pitEvidence } = ctx;
  const out = [];
  const get = (id) => facts.find((f) => f.id === id)?.value ?? null;

  const ret = get('F-RET');
  const bench = get('F-BENCH');
  const excess = get('F-EXCESS');

  if (ret !== null && bench !== null && excess !== null) {
    const dominant = Math.abs(bench) >= Math.abs(excess) ? '基准（市场/风格）' : '个股特异性';
    out.push({
      id: 'A-1',
      type: 'attribution',
      title: '收益来源拆解',
      statement:
        `持有期个股毛收益 ${ret}%，同期基准 ${bench}%，两者算术差 ${excess}%（口径：简单相减，未做行业中性或风险因子回归）。` +
        `按绝对值比较，本次结果中占优的成分是「${dominant}」。该拆解只描述收益的构成，不构成对原因的判断。`,
      confidence: 'medium',
      confidenceReason: '口径为算术差，未剥离行业与风格因子，因此不能等同于选股能力。',
      evidenceRefs: ['F-RET', 'F-BENCH', 'F-EXCESS'],
      counterCheck:
        '反事实检验：若同期只持有基准指数，结果会如何？请用 F-BENCH 自行替换比较；单一区间的超额不具统计显著性，不能外推。',
    });
  } else if (ret !== null && bench === null) {
    out.push({
      id: 'A-1',
      type: 'attribution',
      title: '收益来源拆解（受限）',
      statement: `仅可计算个股毛收益 ${ret}%；基准序列缺失，无法做超额拆解。`,
      confidence: 'low',
      confidenceReason: '缺少基准数据，无法区分市场成分与个股成分。',
      evidenceRefs: ['F-RET'],
      counterCheck: '需补充基准指数序列后重算。',
    });
  }

  // 决策依据的事前可得性核查（注意：要用 ctx.reasoning 解析结果，而不是 decision.reasoning 原文）
  const claims = ctx.reasoning?.claims ?? [];
  const reasoningHits = (ctx.reasoning?.matchedTerms ?? []).map((t) => t.term);
  const unverifiable = (ctx.reasoning?.unmatchedTerms ?? []).map((t) => `${t.term}（${t.note}）`);
  if (reasoningHits.length > 0) {
    // 证据引用必须指向"实际被用来核对的那几条序列"，并去重。
    // 早先这里写成 pitEvidence.slice(0, 8)，在真实数据下正好取到同一序列的 8 个不同日期，
    // 渲染出来是 8 个重复的 index:000300.SH —— 看起来像引用，实际上什么都说明不了。
    const claimRefs = [...new Set(claims.map((c) => c.series).filter(Boolean))];
    out.push({
      id: 'A-2',
      type: 'attribution',
      title: '决策理由的可核验性',
      statement:
        `决策理由原文中可被事前数据核验的词项：${reasoningHits.join('、')}。` +
        `其中 ${claims.filter((c) => !c.degraded).length} 个在决策时点有可用的对应指标，可直接核对；` +
        (unverifiable.length
          ? `${unverifiable.length} 个在当前数据源中没有对应字段，属于不可核验：${unverifiable.join('、')}。`
          : '没有出现无对应字段的词项。'),
      confidence: (ctx.reasoning?.unmatchedTerms.length ?? 0) === 0 ? 'high' : 'low',
      confidenceReason:
        (ctx.reasoning?.unmatchedTerms.length ?? 0) === 0
          ? '理由中的可核验词项均有对应的事前数据字段，且都能回到原始取值。'
          : '存在在当前数据源中无对应字段的理由表述，这部分内容无法核验，不应在归因中当作已知事实使用。',
      evidenceRefs: claimRefs.length ? claimRefs : ['decisions.reasoning'],
      counterCheck: '对未能匹配的词项，不应在归因中当作已知事实使用。',
    });
  }

  // 计划与执行的偏离
  if (exit && decision.preCommit) {
    const target = decision.preCommit.targetReturnPct;
    const stop = decision.preCommit.stopLossPct;
    const lines = [];
    if (Number.isFinite(ret) && Number.isFinite(target)) {
      lines.push(`实际收益 ${ret}% vs 事前目标 +${target}%：${ret >= target ? '已达成' : '未达成'}`);
    }
    if (Number.isFinite(ret) && Number.isFinite(stop)) {
      lines.push(`事前止损线 ${stop}%：${ret <= stop ? '已触及' : '未触及'}`);
    }
    out.push({
      id: 'A-3',
      type: 'attribution',
      title: '计划 vs 执行',
      statement: `事前预设条件为：${lines.join('；')}。离场时点的实际理由为「${exit.exitReason ?? '未填写'}」。`,
      confidence: 'high',
      confidenceReason: '全部字段来自决策记录与平仓记录原文，可直接核对。',
      evidenceRefs: ['decisions.preCommit', 'exits.exitReason', 'F-RET'],
      counterCheck: '注意：未触及预设条件即离场，属于流程偏离；但流程偏离不必然导致坏结果，二者需分开评估。',
    });
  }

  return out;
}

export function buildUncertainty(ctx, quality) {
  const out = [];
  const { decision, exit } = ctx;

  if (!decision.preCommit?.invalidation) {
    out.push({
      id: 'U-1',
      title: '缺少事前证伪条件',
      statement: '本次决策未写下「什么情况下我承认判断错了」，因此无法在事后检验判断本身是否被证伪，只能检验收益结果。',
    });
  }
  if (!exit) {
    out.push({
      id: 'U-2',
      title: '尚未平仓',
      statement: '该决策仍在持有中，收益未实现，归因结论属于过程评估而非结果评估。',
    });
  }
  for (const issue of quality.issues) {
    out.push({
      id: `U-Q-${issue.code}-${issue.ref ?? 'global'}`,
      title: `数据限制：${issue.code}`,
      statement: issue.message,
    });
  }
  out.push({
    id: 'U-GEN',
    title: '通用不确定性',
    statement:
      '本复盘不包含：交易成本、税费、分红再投资、仓位与组合层面敞口、同期其他决策的机会成本。上述因素都可能显著改变"这次决策是否划算"的结论。',
  });
  return out;
}
