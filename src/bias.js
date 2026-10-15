/**
 * bias.js —— 行为偏差规则引擎
 *
 * 设计取向：
 *   1. 每条规则都是「可解释的启发式」，不是黑箱打分。触发时必须给出证据引用。
 *   2. 每条规则都配对一条 counterCheck（反例检查），专门对抗后见之明：
 *      结果差 ≠ 决策错，结果好 ≠ 决策对。要审的是当时的流程与信息。
 *   3. 未触发也要输出（triggered:false），避免"只报坏消息"的选择性呈现。
 */

import { daysBetween, parseTime } from './timeutil.js';
import { pctChange, distanceFromHigh, lookback } from './market.js';

const CHASE_WINDOW_DAYS = 20;
const CHASE_HIGH_WINDOW_DAYS = 60;
const CHASE_MOMENTUM_PCT = 10; // 前 20 日涨幅阈值
const CHASE_NEAR_HIGH_PCT = -3; // 距 60 日高点在 3% 以内视为"接近高位"

/**
 * @param {object} ctx {
 *   decision, exit, reasoning, facts, market, priceSeries, pitEvidence, exPostEvidence, horizon
 * }
 * @returns {Array<RuleResult>}
 */
export function runBiasRules(ctx) {
  const rules = [
    ruleChasing, ruleDispositionDrift, ruleAnchoring, ruleInsufficientEvidence,
    ruleMissingInvalidation, ruleHorizonDrift, ruleOverconfidence, ruleMissingStop,
    ruleHindsightContamination,
  ];
  return rules.map((r) => {
    try {
      return r(ctx);
    } catch (err) {
      return {
        id: r.ruleId ?? r.name,
        name: r.ruleName ?? r.name,
        category: 'engine',
        triggered: null,
        error: String(err?.message ?? err),
        explanation: '规则执行异常，本项结论标记为「未判定」，不得视为正常。',
        counterCheck: '请检查输入数据完整性后重跑。',
        evidenceRefs: [],
      };
    }
  });
}

function R(id, name, category) {
  return { id, name, category };
}

/* ---------------- 1. 追涨 ---------------- */
function ruleChasing(ctx) {
  const base = R('B-CHASE', '追涨（买在高位且前期涨幅已大）', 'entry-timing');
  const d = ctx.decision;
  const from = d.executedAt ?? d.decidedAt;
  if (d.action !== 'buy' || !ctx.priceSeries) {
    return { ...base, triggered: false, explanation: '非买入决策或无价格序列，未判定。', counterCheck: '—', evidenceRefs: [] };
  }
  const w = lookback(from, CHASE_WINDOW_DAYS);
  const mom = pctChange(ctx.market, ctx.priceSeries, w.from, w.to);
  const w2 = lookback(from, CHASE_HIGH_WINDOW_DAYS);
  const dist = distanceFromHigh(ctx.market, ctx.priceSeries, w2.from, w2.to);

  if (!mom || !dist) {
    return {
      ...base, triggered: null,
      explanation: '价格序列样本不足，无法计算动量与高位距离，本项未判定。',
      counterCheck: '样本不足时不臆断"没有追涨"。', evidenceRefs: [],
    };
  }

  const hit = mom.pct >= CHASE_MOMENTUM_PCT && dist.pct >= CHASE_NEAR_HIGH_PCT;
  return {
    ...base,
    triggered: hit,
    metrics: {
      momentum20dPct: Number(mom.pct.toFixed(2)),
      distanceFrom60dHighPct: Number(dist.pct.toFixed(2)),
      thresholdMomentumPct: CHASE_MOMENTUM_PCT,
      thresholdNearHighPct: CHASE_NEAR_HIGH_PCT,
    },
    explanation: hit
      ? `买入时点前 ${CHASE_WINDOW_DAYS} 个自然日价格已上涨 ${mom.pct.toFixed(2)}%（阈值 ≥${CHASE_MOMENTUM_PCT}%），且买点距前 ${CHASE_HIGH_WINDOW_DAYS} 个自然日高点仅 ${Math.abs(dist.pct).toFixed(2)}%。这是"在已经涨完一段的位置建仓"的典型形态。`
      : `买入前 ${CHASE_WINDOW_DAYS} 日涨幅 ${mom.pct.toFixed(2)}%、距 ${CHASE_HIGH_WINDOW_DAYS} 日高点 ${dist.pct.toFixed(2)}%，未同时满足追涨阈值，本项未触发。`,
    counterCheck:
      '反例检查：动量买入在趋势延续期同样可以取得好结果，本规则只指出"入场位置偏右侧"这一形态事实，不判定该决策对错。',
    evidenceRefs: [`market[series=${ctx.priceSeries}]`, 'decisions.executedAt', 'decisions.price'],
  };
}

/* ---------------- 2. 计划漂移 / 处置效应 ---------------- */
function ruleDispositionDrift(ctx) {
  const base = R('B-DISPOSITION', '未触及预设条件即离场（计划漂移）', 'exit-discipline');
  const { exit, decision, facts } = ctx;
  if (!exit) {
    return { ...base, triggered: false, explanation: '尚未平仓，无离场行为可评估。', counterCheck: '—', evidenceRefs: [] };
  }
  const ret = facts.find((f) => f.id === 'F-RET')?.value ?? null;
  const stop = decision.preCommit?.stopLossPct;
  const target = decision.preCommit?.targetReturnPct;
  if (!Number.isFinite(ret)) {
    return { ...base, triggered: null, explanation: '收益无法计算，本项未判定。', counterCheck: '—', evidenceRefs: [] };
  }
  const hitStop = Number.isFinite(stop) && ret <= stop;
  const hitTarget = Number.isFinite(target) && ret >= target;
  const triggered = !hitStop && !hitTarget;

  return {
    ...base,
    triggered,
    metrics: { returnPct: ret, stopLossPct: stop ?? null, targetReturnPct: target ?? null, hitStop, hitTarget },
    explanation: triggered
      ? `离场时收益 ${ret.toFixed(2)}%，既未触及事前止损线（${stop}%），也未达成事前目标（+${target}%）。离场理由为「${exit.exitReason ?? '未填写'}」，属于在计划外提前结束仓位。`
      : `离场时收益 ${ret.toFixed(2)}%，${hitStop ? '已触及事前止损线' : '已达成事前目标'}，离场动作与预设条件一致。`,
    counterCheck:
      '反例检查：未触及条件就离场也可能是新信息出现后的合理更新（例如基本面证伪）。判断依据应是"离场理由能否回到事前或当期可核验的数据"，而不是结果好坏。',
    evidenceRefs: ['decisions.preCommit', 'exits.exitReason', 'exits.exitPrice', 'F-RET'],
  };
}

/* ---------------- 3. 锚定成本价 ---------------- */
function ruleAnchoring(ctx) {
  const base = R('B-ANCHOR', '锚定成本价（用买入价而非价值做卖出依据）', 'cognitive');
  // 关键：锚定措辞出现在"卖出理由"里才有意义，买入理由里出现成本价不构成该偏差
  const hits = ctx.exitReasoning?.anchorHits ?? [];
  if (!ctx.exit) {
    return { ...base, triggered: false, explanation: '尚未平仓，无卖出理由文本可分析。', counterCheck: '—', evidenceRefs: [] };
  }
  const triggered = hits.length > 0;
  return {
    ...base,
    triggered,
    metrics: { hits, analyzedText: ctx.exitReasoning?.text ?? '' },
    explanation: triggered
      ? `离场理由中出现「${hits.join('、')}」等以买入成本为参照的表述。成本价是个人记账口径，不是市场信息；以它为决策依据意味着卖出判断取决于"我买在哪"，而不是"它现在值多少"。`
      : '离场理由中未出现以成本价为参照的表述。',
    counterCheck:
      '反例检查：有时"回本即卖"恰好与估值回到合理区间重合，结果不差。但需要注意区分：赚钱的原因是估值修复，还是因为锚定了成本？',
    evidenceRefs: ['exits.exitReason'],
  };
}

/* ---------------- 4. 信息不足 ---------------- */
function ruleInsufficientEvidence(ctx) {
  const base = R('B-INSUFFICIENT', '决策依据不足（可核验指标少 / 理由中存在不可核验主张）', 'information');
  const { reasoning, pitEvidence } = ctx;

  // 计数口径：决策时点可得的"标的层面非价格类"指标种类数。
  // 只看价格类序列不算信息量——那本质上是把"它涨了"当作理由；
  // 指数/宏观也不计入，因为它们是市场级背景，不是这笔决策的个性化依据。
  const EXCLUDED = ['price', 'index', 'turnoverRate', 'pmi', 'macro'];
  const indicatorSeries = new Set(
    pitEvidence
      .filter((e) => Number.isFinite(e.value))
      .map((e) => String(e.series).split(':')[0])
      .filter((k) => !EXCLUDED.includes(k)),
  );
  const unmatchedHeavier = reasoning.unmatchedTerms.length > reasoning.matchedTerms.length;
  const triggered = indicatorSeries.size < 2 || unmatchedHeavier;

  return {
    ...base,
    triggered,
    metrics: {
      indicatorSeries: [...indicatorSeries],
      indicatorCount: indicatorSeries.size,
      thresholdIndicatorCount: 2,
      matchedTermCount: reasoning.matchedTerms.length,
      unmatchedTermCount: reasoning.unmatchedTerms.length,
      reasoningLength: reasoning.length,
    },
    explanation: triggered
      ? `决策时可核验的指标种类仅 ${indicatorSeries.size} 类（阈值 2 类，口径：决策时点可得的非价格类指标）；理由中可核验主张 ${reasoning.matchedTerms.length} 项、不可核验主张 ${reasoning.unmatchedTerms.length} 项。` +
        `存在"凭印象决策"的特征：把价格自身的涨跌或无法回源的说法当成了依据。`
      : `决策时可核验指标 ${indicatorSeries.size} 类（${[...indicatorSeries].join('、')}），可核验主张 ${reasoning.matchedTerms.length} 项，达到最低信息量要求。`,
    counterCheck:
      '反例检查：老练的投资者可能用少量高信息量指标做判断（例如只看估值分位 + 股息率）。因此本项只提示"依据的指标种类偏少或存在不可核验主张"，需要补充说明，不判定为错误。',
    evidenceRefs: ['decisions.reasoning', ...[...indicatorSeries].map((k) => `market[series=${k}:*]`)],
  };
}

/* ---------------- 5. 未定义证伪条件 ---------------- */
function ruleMissingInvalidation(ctx) {
  const base = R('B-NO-INVALIDATION', '未设定事前证伪条件', 'process');
  const d = ctx.decision;
  const inv = d.preCommit?.invalidation;
  const triggered = !inv || String(inv).trim().length === 0;
  return {
    ...base,
    triggered,
    explanation: triggered
      ? '决策时没有写下"出现什么情况就承认判断错误"。缺少这一条，事后只能拿收益结果反推对错，这正是后见之明的入口。'
      : `已设定事前证伪条件：「${inv}」。`,
    counterCheck: '反例检查：写下证伪条件仍需可观测、可判定，笼统表述（如"基本面变差"）等同于没写。',
    evidenceRefs: ['decisions.preCommit.invalidation'],
  };
}

/* ---------------- 6. 期限漂移 ---------------- */
function ruleHorizonDrift(ctx) {
  const base = R('B-HORIZON', '持有期限与预设期限不符', 'process');
  const { decision, exit } = ctx;
  if (!exit) {
    return { ...base, triggered: false, explanation: '尚未平仓，无实际持有期可比较。', counterCheck: '—', evidenceRefs: [] };
  }
  const hold = exit.holdingDays ?? daysBetween(decision.executedAt ?? decision.decidedAt, exit.exitedAt);
  const map = { '1M': 30, '3M': 90, '3-6M': 135, '6M': 180, '6-12M': 270, '1Y': 365, '1Y+': 730 };
  const expected = map[decision.horizon];
  if (!Number.isFinite(expected) || !Number.isFinite(hold)) {
    return { ...base, triggered: null, explanation: `未识别的预设期限「${decision.horizon}」，本项未判定。`, counterCheck: '—', evidenceRefs: ['decisions.horizon'] };
  }
  const ratio = hold / expected;
  const triggered = ratio < 0.5 || ratio > 1.5;
  return {
    ...base,
    triggered,
    metrics: { holdingDays: hold, expectedDays: expected, ratio: Number(ratio.toFixed(2)) },
    explanation: triggered
      ? `预设持有期限 ${decision.horizon}（约 ${expected} 天），实际持有 ${hold} 天，为预期的 ${(ratio * 100).toFixed(0)}%。持有期与预设严重不一致，说明决策的"时间维度"要么被临时改写，要么一开始就不真实。`
      : `预设 ${expected} 天 / 实际 ${hold} 天，期限基本一致。`,
    counterCheck: '反例检查：基本面提前兑现时缩短持有期是合理的。关键仍是离场理由能否被数据支撑。',
    evidenceRefs: ['decisions.horizon', 'F-HOLD'],
  };
}

/* ---------------- 7. 过度自信 ---------------- */
function ruleOverconfidence(ctx) {
  const base = R('B-OVERCONFIDENCE', '理由中存在绝对化措辞', 'cognitive');
  const hits = ctx.reasoning.absoluteHits ?? [];
  const triggered = hits.length > 0;
  return {
    ...base,
    triggered,
    metrics: { hits },
    explanation: triggered
      ? `决策理由中出现绝对化措辞「${hits.join('、')}」。绝对化表达通常对应被压缩掉的不确定性，会使后续无法根据新信息修正判断。`
      : '决策理由中未出现绝对化措辞。',
    counterCheck: '反例检查：口语化的强调不等于过度自信，需要结合是否写出了具体条件来判断。',
    evidenceRefs: ['decisions.reasoning'],
  };
}

/* ---------------- 8. 未设止损 ---------------- */
function ruleMissingStop(ctx) {
  const base = R('B-NO-STOP', '未设定止损/退出底线', 'risk');
  const stop = ctx.decision.preCommit?.stopLossPct;
  const triggered = !Number.isFinite(stop);
  return {
    ...base,
    triggered,
    explanation: triggered
      ? '决策时未设定止损线（或以定投/长持为由省略）。缺少可执行的退出底线时，"什么时候卖"会被短期价格波动和情绪接管。'
      : `已设定止损线 ${stop}%。`,
    counterCheck: '反例检查：长期持有型策略可以用"估值/基本面条件"替代价格止损，但必须写清楚，否则等同于没有。',
    evidenceRefs: ['decisions.preCommit.stopLossPct'],
  };
}

/* ---------------- 9. 后见之明污染 ---------------- */
function ruleHindsightContamination(ctx) {
  const base = R('B-HINDSIGHT', '存在被事后信息解释的风险', 'hindsight');
  const exPost = ctx.exPostEvidence ?? [];
  const highImpact = exPost.filter((e) => e.impact === 'high' || e.impact === 'medium');
  const triggered = highImpact.length > 0;
  return {
    ...base,
    triggered,
    metrics: {
      exPostCount: exPost.length,
      notableExPost: highImpact.map((e) => ({ id: e.id, title: e.title, publishedAt: e.publishedAt, impact: e.impact })),
    },
    explanation: triggered
      ? `持有期内有 ${highImpact.length} 条中高影响事件发生在决策之后（最早 ${highImpact[0].publishedAt}）。这些信息在决策当时不可得，若用来解释当初的买入，就是后见之明。`
      : '持有期内未发现决策后才出现的中高影响事件。',
    counterCheck:
      '反例检查：事件发生在决策之后，不代表"理应提前知道"。判断标准只有一个——决策时点能否从公开数据看到它。',
    evidenceRefs: highImpact.map((e) => `events[${e.id}]`),
  };
}
