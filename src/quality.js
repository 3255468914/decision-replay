/**
 * quality.js —— 数据质量与降级判定
 *
 * 硬性要求：数据缺失 / 冲突 / 过期 / 调用失败时，不得静默生成"正常"结论。
 * 因此本模块对每一条证据做四类体检，产出结构化 issues，并把整体状态标为
 * ok | degraded | blocked，由 report 与 UI 显式呈现。
 */

import { parseTime, DAY_MS, formatDate } from './timeutil.js';
import { availableAt } from './market.js';

export const SEVERITY = { ERROR: 'error', WARN: 'warn', INFO: 'info' };

export const QUALITY_CODE = {
  MISSING_VALUE: 'MISSING_VALUE',
  CONFLICT: 'CONFLICT',
  STALE: 'STALE',
  SOURCE_FAILED: 'SOURCE_FAILED',
  SOURCE_UNKNOWN: 'SOURCE_UNKNOWN',
  INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE',
  NO_EVIDENCE: 'NO_EVIDENCE',
};

/**
 * 过期阈值解析：staleness 的 key 用"序列前缀"匹配（如 'peTtm:' 匹配 'peTtm:600519.SH'），
 * 取最长匹配的前缀，找不到则回落到 staleDays。
 * 之所以要按序列区分：日频行情 7 天就过期，月频 PMI 40 天仍属正常，用同一阈值会产生大量假告警。
 */
function resolveLimit(series, staleness, fallback) {
  let best = null;
  for (const key of Object.keys(staleness ?? {})) {
    if (series.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return best === null ? fallback : staleness[best];
}

/**
 * @param {Array} evidence 事前证据集（已通过时点闸门）
 * @param {object} opts
 * @param {string} opts.asOfCutoff 以"决策时点"为新鲜度基准
 * @param {number} opts.staleDays  默认过期阈值（天）
 * @param {object} opts.staleness  按序列前缀覆盖的过期阈值
 */
export function checkQuality(evidence, opts = {}) {
  const { asOfCutoff, staleDays = 7, staleness = {} } = opts;
  const cutoff = parseTime(asOfCutoff);
  const issues = [];

  // 1) 缺失值
  for (const e of evidence) {
    if (e.value === null || e.value === undefined || Number.isNaN(e.value)) {
      issues.push({
        code: QUALITY_CODE.MISSING_VALUE,
        severity: SEVERITY.WARN,
        ref: e.series,
        asOf: e.asOf ?? null,
        message: `指标「${e.series}」取值缺失，相关结论不可计算。`,
      });
    }
  }

  // 2) 冲突：同一 series + 同一 asOf 出现多个不一致的值
  const conflictMap = new Map();
  for (const e of evidence) {
    if (!Number.isFinite(e.value)) continue;
    const t = parseTime(e.asOf);
    if (t === null) continue;
    const key = `${e.series}@${t}`;
    if (!conflictMap.has(key)) conflictMap.set(key, []);
    conflictMap.get(key).push(e);
  }
  for (const [key, group] of conflictMap) {
    const distinct = new Set(group.map((g) => g.value));
    if (distinct.size > 1) {
      issues.push({
        code: QUALITY_CODE.CONFLICT,
        severity: SEVERITY.ERROR,
        ref: group[0].series,
        asOf: group[0].asOf,
        message: `同一指标同一时点存在 ${distinct.size} 个不一致取值（${[...distinct].join(' / ')}），来源：${[
          ...new Set(group.map((g) => g.source ?? '未知来源')),
        ].join('、')}；已按「冲突待人工裁定」处理，不使用该点做归因。`,
        detail: key,
      });
    }
  }

  // 3) 过期：只对"每个序列在决策时点最新可获得的那一个点"做新鲜度判定。
  //    历史点本来就旧（如 2023-06 的收盘价），逐个点报过期会造成大量噪音；
  //    真正影响决策的是"决策时你看到的最新一个值"有多旧。
  const latestBySeries = new Map();
  for (const e of evidence) {
    const t = parseTime(availableAt(e));
    if (t === null) continue;
    const cur = latestBySeries.get(e.series);
    if (!cur || t > cur.t) latestBySeries.set(e.series, { t, item: e });
  }
  for (const [series, { t, item }] of latestBySeries) {
    if (cutoff === null) continue;
    const limit = resolveLimit(series, staleness, staleDays);
    const ageDays = Math.round((cutoff - t) / DAY_MS);
    if (ageDays > limit) {
      issues.push({
        code: QUALITY_CODE.STALE,
        severity: SEVERITY.WARN,
        ref: series,
        asOf: item.asOf,
        availableAt: availableAt(item),
        message: `指标「${series}」在决策时点可获得的最新一期数据已距决策 ${ageDays} 天（阈值 ${limit} 天），视为过期，不作为决策依据的强证据。`,
      });
    }
  }

  // 4) 数据源调用失败
  for (const e of evidence) {
    if (e.sourceError) {
      issues.push({
        code: QUALITY_CODE.SOURCE_FAILED,
        severity: SEVERITY.ERROR,
        ref: e.series,
        asOf: e.asOf ?? null,
        message: `数据源调用失败（${e.source ?? '未知来源'}）：${e.sourceError}；该证据不参与归因。`,
      });
    }
  }

  // 5) 来源缺失
  for (const e of evidence) {
    if (!e.source) {
      issues.push({
        code: QUALITY_CODE.SOURCE_UNKNOWN,
        severity: SEVERITY.INFO,
        ref: e.series,
        message: `指标「${e.series}」未标注来源，可追溯性降低。`,
      });
    }
  }

  // 6) 无证据
  if (evidence.length === 0) {
    issues.push({
      code: QUALITY_CODE.NO_EVIDENCE,
      severity: SEVERITY.ERROR,
      message: '未匹配到任何事前证据，无法执行归因；请补齐取数计划或调整决策时点。',
    });
  }

  const errorCount = issues.filter((i) => i.severity === SEVERITY.ERROR).length;
  const warnCount = issues.filter((i) => i.severity === SEVERITY.WARN).length;

  let status = 'ok';
  if (evidence.length === 0) status = 'blocked';
  else if (errorCount > 0) status = 'degraded';
  else if (warnCount > 0) status = 'degraded';

  return {
    status,
    errorCount,
    warnCount,
    issues,
    // 给 UI 用的一句话说明，绝不出现"数据正常"式默认结论
    banner:
      status === 'ok'
        ? null
        : status === 'blocked'
          ? '⛔ 无可用事前证据，本次复盘已阻断：不产出归因结论。'
          : `⚠️ 数据降级（错误 ${errorCount} 项 / 提示 ${warnCount} 项）：下列结论仅基于通过校验的证据，缺失与冲突项已显式标注。`,
    checkedAt: new Date().toISOString(),
    asOfCutoff: asOfCutoff ?? null,
    cutoffLabel: formatDate(asOfCutoff),
  };
}

/** 判断某条证据是否"干净"（可用于归因） */
export function isUsable(evidenceItem, issues) {
  const bad = issues.some(
    (i) =>
      (i.severity === SEVERITY.ERROR) &&
      i.ref === evidenceItem.series &&
      (i.code === QUALITY_CODE.SOURCE_FAILED || i.code === QUALITY_CODE.CONFLICT),
  );
  if (bad) return false;
  if (!Number.isFinite(evidenceItem.value)) return false;
  return true;
}

/**
 * 按质量问题剔除"不可用的数据点"（而不是整条序列）。
 * 原则：一处冲突不应导致该标的全部指标失效；降级要精确，且必须留下 removed 记录。
 */
export function filterUsablePoints(points, issues) {
  const badKeys = new Set();
  for (const i of issues) {
    if (i.severity !== SEVERITY.ERROR || !i.ref) continue;
    if (i.code === QUALITY_CODE.CONFLICT || i.code === QUALITY_CODE.SOURCE_FAILED) {
      badKeys.add(`${i.ref}|${i.asOf ?? ''}`);
    }
  }
  const removed = [];
  const kept = points.filter((p) => {
    const key = `${p.series}|${p.asOf ?? ''}`;
    const isBad = badKeys.has(key) || Boolean(p.sourceError);
    if (isBad) removed.push(p);
    return !isBad;
  });
  return { points: kept, removed };
}
