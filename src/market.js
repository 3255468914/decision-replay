/**
 * market.js —— 行情/估值序列的取值与指标计算
 *
 * 所有计算都在"事前证据集"上进行（调用方负责先做时点切分）。
 * 每个返回值都携带 sourceSnapshot（原始字段引用），以满足"结论可回到原始字段"的要求。
 */

import { parseTime, DAY_MS } from './timeutil.js';

/**
 * 可得时点（availability time）：
 * 一个数据点有两个时间——asOf（所属时点）与 publishedAt（实际可得时点）。
 * 做 point-in-time 判断必须用 publishedAt，否则会把"未来才披露的财报"当成已知信息。
 */
export function availableAt(p) {
  return p?.publishedAt ?? p?.asOf ?? null;
}

/** 同一 series 的所有点，按可得时间升序 */
export function sortByTime(points, pickTime = availableAt) {
  return [...points].sort((a, b) => (parseTime(pickTime(a)) ?? 0) - (parseTime(pickTime(b)) ?? 0));
}

/** 取 series 在 cutoff 之前（含）最后一个"可得"的点 */
export function valueAtOrBefore(points, series, cutoff) {
  const c = parseTime(cutoff);
  if (c === null) return null;
  const candidates = points
    .filter((p) => p.series === series)
    .filter((p) => {
      const t = parseTime(availableAt(p));
      return t !== null && t <= c;
    });
  if (candidates.length === 0) return null;
  return sortByTime(candidates).at(-1);
}

/** 取 series 在 [from, to] 区间内"可得"的全部点（升序，按可得时间） */
export function windowPoints(points, series, from, to) {
  const f = parseTime(from);
  const t2 = parseTime(to);
  if (f === null || t2 === null) return [];
  return sortByTime(
    points.filter((p) => {
      if (p.series !== series) return false;
      const t = parseTime(availableAt(p));
      return t !== null && t >= f && t <= t2;
    }),
  );
}

/** 区间涨跌幅（%）: 末值/首值 - 1 */
export function pctChange(points, series, from, to) {
  const win = windowPoints(points, series, from, to);
  if (win.length < 2) return null;
  const first = win[0];
  const last = win.at(-1);
  if (!Number.isFinite(first.value) || !Number.isFinite(last.value) || first.value === 0) return null;
  return {
    pct: ((last.value / first.value - 1) * 100),
    first,
    last,
    sampleSize: win.length,
  };
}

/** 分位：value 在参考样本中的百分位（0-100），参考样本为 cutoff 时点已"可得"的点 */
export function percentileRank(points, series, value, cutoff) {
  const c = parseTime(cutoff);
  if (c === null || !Number.isFinite(value)) return null;
  const sample = points
    .filter((p) => p.series === series)
    .filter((p) => {
      const t = parseTime(availableAt(p));
      return t !== null && t <= c && Number.isFinite(p.value);
    })
    .map((p) => p.value);
  if (sample.length < 10) return null;
  const below = sample.filter((v) => v <= value).length;
  return { percentile: (below / sample.length) * 100, sampleSize: sample.length };
}

/** 最大回撤及其发生区间 */
export function maxDrawdown(points, series, from, to) {
  const win = windowPoints(points, series, from, to);
  if (win.length < 2) return null;
  let peak = win[0];
  let worst = 0;
  let worstPeak = win[0];
  let worstTrough = win[0];
  for (const p of win) {
    if (p.value > peak.value) peak = p;
    const dd = (p.value / peak.value - 1) * 100;
    if (dd < worst) {
      worst = dd;
      worstPeak = peak;
      worstTrough = p;
    }
  }
  return { pct: worst, peak: worstPeak, trough: worstTrough, sampleSize: win.length };
}

/** 近 N 个自然日窗口的起止时间 */
export function lookback(fromTs, days) {
  const t = parseTime(fromTs);
  if (t === null) return { from: null, to: null };
  return { from: t - days * DAY_MS, to: t };
}

/** 距区间内最高点的百分比距离（负值 = 低于高点） */
export function distanceFromHigh(points, series, from, to) {
  const win = windowPoints(points, series, from, to);
  if (win.length < 2) return null;
  const high = win.reduce((a, b) => (b.value > a.value ? b : a));
  const last = win.at(-1);
  if (high.value === 0) return null;
  return { pct: (last.value / high.value - 1) * 100, high, last };
}
