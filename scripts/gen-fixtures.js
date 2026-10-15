/**
 * scripts/gen-fixtures.js —— 构造可复现的行情/估值/宏观数据
 *
 * 为什么用构造数据：题目统一规则明确允许"涉及用户画像/持仓时使用匿名或构造数据"，
 * 而复盘产品要验证的核心是「时点对齐」逻辑，需要一个能精确控制的输入。
 * 本脚本用确定性随机数（无外部依赖的 mulberry32）生成，任何人重跑结果完全一致。
 *
 * 生成规则（重要，体现 point-in-time 纪律）：
 *   - price:*        每个交易日收盘后 15:00 可得
 *   - peTtm/pb/dividendYield:*  每周末 18:00 可得
 *   - nplRatio:*     所属期结束后 +80 天可得（模拟财报披露时滞）
 *   - pmi:CN         月末后 +2 天可得
 * 即：一个数据点有两个时间——"所属时点 asOf" 与 "可得时点 publishedAt"，二者可能相差数月。
 *
 * 用法：node scripts/gen-fixtures.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'data');

/* ---------------- 确定性随机 ---------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 日期工具 ---------------- */
const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

function weekdaysBetween(start, end) {
  const out = [];
  for (let d = D(start); d <= D(end); d = addDays(d, 1)) {
    if (!isWeekend(d)) out.push(iso(d));
  }
  return out;
}

function lastWeekdayOfMonth(y, m) {
  // m: 1-12
  let d = new Date(Date.UTC(y, m, 0)); // 当月最后一天
  while (isWeekend(d)) d = addDays(d, -1);
  return iso(d);
}

function monthsBetween(start, end) {
  const out = [];
  const s = D(start);
  const e = D(end);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth() + 1;
  while (true) {
    const key = lastWeekdayOfMonth(y, m);
    if (D(key) > e) break;
    if (D(key) >= s) out.push(key);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/* ---------------- 插值 ---------------- */
/** 在锚点之间做对数线性插值，得到日期 -> 值 的函数 */
function interp(anchors) {
  const pts = anchors.map((a) => ({ t: D(a.date).getTime(), v: a.value }));
  return (dateStr) => {
    const t = D(dateStr).getTime();
    if (t <= pts[0].t) return pts[0].v;
    if (t >= pts.at(-1).t) return pts.at(-1).v;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      if (t >= a.t && t <= b.t) {
        const w = (t - a.t) / (b.t - a.t);
        return Math.exp(Math.log(a.v) * (1 - w) + Math.log(b.v) * w);
      }
    }
    return pts.at(-1).v;
  };
}

/**
 * 生成一个序列的点
 * @param {object} spec {series, unit, freq, digits, jitter, publishHour, publishOffsetDays, anchors}
 */
function buildSeries(spec) {
  const dates = new Set();
  const start = spec.anchors[0].date;
  const end = spec.anchors.at(-1).date;

  if (spec.freq === 'daily') weekdaysBetween(start, end).forEach((d) => dates.add(d));
  else if (spec.freq === 'weekly') {
    for (let d = D(start); d <= D(end); d = addDays(d, 7)) {
      let x = d;
      if (isWeekend(x)) x = addDays(x, 2); // 顺延到周一
      dates.add(iso(x));
    }
  } else if (spec.freq === 'monthly') monthsBetween(start, end).forEach((d) => dates.add(d));
  // 锚点日期必须精确出现在序列里
  spec.anchors.forEach((a) => dates.add(a.date));

  const f = interp(spec.anchors);
  const rnd = mulberry32(spec.seed ?? 20240311);
  const anchorDates = new Set(spec.anchors.map((a) => a.date));

  return [...dates].sort().map((date) => {
    let v = f(date);
    if (!anchorDates.has(date) && spec.jitter) {
      v *= 1 + (rnd() - 0.5) * 2 * spec.jitter;
    }
    return {
      series: spec.series,
      asOf: `${date}T15:00:00+08:00`,
      ...(spec.publishOffsetDays
        ? { publishedAt: `${iso(addDays(D(date), spec.publishOffsetDays))}T${(spec.publishHour ?? 18).toString().padStart(2, '0')}:00:00+08:00` }
        : { publishedAt: `${date}T${(spec.publishHour ?? 15).toString().padStart(2, '0')}:00:00+08:00` }),
      value: Number(v.toFixed(spec.digits ?? 2)),
      unit: spec.unit,
      source: spec.source ?? '构造数据（scripts/gen-fixtures.js）',
    };
  });
}

/* ------------------------------------------------------------------ */
/* 序列定义                                                            */
/* ------------------------------------------------------------------ */

const SERIES = [
  /* --- 价格：日频，收盘后 15:00 可得 --- */
  {
    series: 'price:600519.SH', unit: 'CNY/股', freq: 'daily', digits: 2, jitter: 0.0035, seed: 11, publishHour: 15,
    anchors: [
      { date: '2023-06-01', value: 1650 }, { date: '2023-10-20', value: 1420 },
      { date: '2024-01-15', value: 1560 }, { date: '2024-02-20', value: 1462 },
      { date: '2024-03-11', value: 1680 }, { date: '2024-04-22', value: 1612 },
      { date: '2024-06-28', value: 1500 }, { date: '2024-10-31', value: 1520 },
    ],
  },
  {
    series: 'price:000001.SZ', unit: 'CNY/股', freq: 'daily', digits: 2, jitter: 0.0035, seed: 22, publishHour: 15,
    anchors: [
      { date: '2023-06-01', value: 11.8 }, { date: '2023-10-20', value: 10.2 },
      { date: '2024-01-08', value: 9.42 }, { date: '2024-06-28', value: 8.35 },
      { date: '2024-10-31', value: 9.1 },
    ],
  },
  {
    series: 'price:300750.SZ', unit: 'CNY/股', freq: 'daily', digits: 2, jitter: 0.0035, seed: 33, publishHour: 15,
    anchors: [
      { date: '2023-06-01', value: 228 }, { date: '2023-10-20', value: 172 },
      { date: '2024-02-05', value: 158 }, { date: '2024-05-20', value: 198 },
      { date: '2024-09-12', value: 205.5 }, { date: '2024-10-31', value: 214 },
    ],
  },
  {
    series: 'index:000300.SH', unit: '点', freq: 'daily', digits: 2, jitter: 0.0025, seed: 44, publishHour: 15,
    anchors: [
      { date: '2023-06-01', value: 3850 }, { date: '2023-10-20', value: 3480 },
      { date: '2024-01-08', value: 3280 }, { date: '2024-03-11', value: 3560 },
      { date: '2024-04-22', value: 3420 }, { date: '2024-05-20', value: 3650 },
      { date: '2024-06-28', value: 3380 }, { date: '2024-09-12', value: 3180 },
      { date: '2024-10-31', value: 3400 },
    ],
  },

  /* --- 估值：周频，周末 18:00 可得 --- */
  {
    series: 'peTtm:600519.SH', unit: '倍', freq: 'weekly', digits: 2, jitter: 0.004, seed: 55,
    anchors: [
      { date: '2021-09-03', value: 55 }, { date: '2022-06-03', value: 45 },
      { date: '2022-10-28', value: 30 }, { date: '2023-01-06', value: 42 },
      { date: '2023-05-05', value: 33 }, { date: '2023-10-20', value: 26 },
      { date: '2024-01-12', value: 30 }, { date: '2024-03-08', value: 28.4 },
      { date: '2024-04-19', value: 26.5 }, { date: '2024-10-31', value: 24.8 },
    ],
  },
  {
    series: 'pb:000001.SZ', unit: '倍', freq: 'weekly', digits: 2, jitter: 0.003, seed: 66,
    anchors: [
      { date: '2023-01-06', value: 0.62 }, { date: '2023-06-02', value: 0.55 },
      { date: '2023-10-20', value: 0.47 }, { date: '2024-01-05', value: 0.44 },
      { date: '2024-06-28', value: 0.39 }, { date: '2024-10-31', value: 0.45 },
    ],
  },
  {
    series: 'dividendYield:000001.SZ', unit: '%', freq: 'weekly', digits: 2, jitter: 0.003, seed: 77,
    anchors: [
      { date: '2023-01-06', value: 5.1 }, { date: '2023-07-07', value: 6.0 },
      { date: '2024-01-05', value: 7.1 }, { date: '2024-06-28', value: 8.0 },
      { date: '2024-10-31', value: 7.4 },
    ],
  },
  {
    series: 'peTtm:300750.SZ', unit: '倍', freq: 'weekly', digits: 2, jitter: 0.005, seed: 88,
    anchors: [
      { date: '2023-01-06', value: 32 }, { date: '2023-06-02', value: 25 },
      { date: '2023-10-20', value: 17 }, { date: '2024-05-17', value: 19.5 },
      { date: '2024-09-13', value: 21 }, { date: '2024-10-31', value: 22.4 },
    ],
  },

  /* --- 财报：季频，所属期后 +80 天才可得（披露时滞） --- */
  {
    series: 'nplRatio:000001.SZ', unit: '%', freq: 'monthly', digits: 2, jitter: 0, seed: 99,
    publishOffsetDays: 80, publishHour: 19, source: '构造数据（模拟财报披露时滞 +80 天）',
    anchors: [
      { date: '2023-03-31', value: 1.05 }, { date: '2023-06-30', value: 1.03 },
      { date: '2023-09-30', value: 1.04 }, { date: '2023-12-31', value: 1.06 },
      { date: '2024-03-31', value: 1.07 }, { date: '2024-06-30', value: 1.08 },
    ],
  },

  /* --- 宏观：月频，月末 +2 天可得 --- */
  {
    series: 'pmi:CN', unit: '点', freq: 'monthly', digits: 1, jitter: 0.002, seed: 111,
    publishOffsetDays: 2, publishHour: 9, source: '构造数据（模拟统计局发布时间）',
    anchors: [
      { date: '2023-06-30', value: 49.0 }, { date: '2023-09-29', value: 50.2 },
      { date: '2023-12-29', value: 49.0 }, { date: '2024-02-29', value: 49.1 },
      { date: '2024-03-29', value: 50.8 }, { date: '2024-05-31', value: 49.5 },
      { date: '2024-08-30', value: 49.1 }, { date: '2024-10-31', value: 50.1 },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* 注入异常样本（用于降级测试与演示）                                    */
/* ------------------------------------------------------------------ */

function injectAnomalies(points) {
  const injected = [];

  // ① 缺失值：300750 的营收同比字段为 null（模拟字段返回空），且该财报在决策时点前已披露
  injected.push({
    series: 'revenueYoy:300750.SZ', asOf: '2023-12-31T15:00:00+08:00',
    publishedAt: '2024-04-25T19:00:00+08:00', value: null, unit: '%',
    source: '构造数据（异常样本：字段缺失）', injected: 'MISSING_VALUE',
  });

  // ② 冲突：同一时点（决策前已可得的最近一个交易日）两个来源给出不同收盘价
  injected.push({
    series: 'price:300750.SZ', asOf: '2024-05-17T15:00:00+08:00',
    publishedAt: '2024-05-17T15:00:00+08:00', value: 193.8, unit: 'CNY/股',
    source: '构造数据-来源B（异常样本：价格冲突）', injected: 'CONFLICT',
  });

  // ③ 数据源调用失败
  injected.push({
    series: 'turnoverRate:300750.SZ', asOf: '2024-05-17T15:00:00+08:00',
    publishedAt: '2024-05-17T15:00:00+08:00', value: 1.62, unit: '%',
    source: '构造数据（异常样本：接口失败）', injected: 'SOURCE_FAILED',
    sourceError: 'HTTP 503 Service Unavailable（已重试 3 次）',
  });

  // ④ 过期数据：估值点距决策时点超过 400 天
  injected.push({
    series: 'peTtm:300750.SZ', asOf: '2022-11-04T15:00:00+08:00',
    publishedAt: '2022-11-04T18:00:00+08:00', value: 41.5, unit: '倍',
    source: '构造数据（异常样本：过期快照）', injected: 'STALE',
  });

  return [...points, ...injected];
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  let points = [];
  for (const spec of SERIES) points = points.concat(buildSeries(spec));
  points = injectAnomalies(points);
  points.sort((a, b) => (a.series + a.asOf).localeCompare(b.series + b.asOf));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'market.json'),
    JSON.stringify(
      {
        note: '构造数据，仅用于演示与测试，不代表任何真实标的的历史表现。可执行 node scripts/gen-fixtures.js 复现。',
        pointCount: points.length,
        series: [...new Set(points.map((p) => p.series))],
        points,
      },
      null,
      1,
    ),
    'utf8',
  );

  fs.writeFileSync(
    path.join(OUT_DIR, 'meta.json'),
    JSON.stringify(
      {
        source: 'synthetic-fixture',
        disclaimer: '全部行情、估值、财报与宏观数据均为构造数据，用于演示与自动化测试，不代表任何真实标的的历史或未来表现。',
        generator: 'scripts/gen-fixtures.js',
        generatedAt: new Date().toISOString(),
        benchmarkSeries: 'index:000300.SH',
        calendar: '交易日历仅排除周末，未剔除法定节假日与停牌日（见 README「已知边界」）',
        fieldCaliber: {
          'price:*': '日收盘价，CNY/股，asOf=当日，publishedAt=当日 15:00',
          'peTtm:*': '滚动市盈率，倍，周频，publishedAt=当周 18:00',
          'pb:*': '市净率，倍，周频',
          'dividendYield:*': '股息率，%，周频',
          'nplRatio:*': '不良贷款率，%，季频，publishedAt=所属期后 80 天（模拟披露时滞）',
          'pmi:CN': '制造业 PMI，点，月频，publishedAt=月末后 2 天',
        },
        injectedAnomalies: ['MISSING_VALUE', 'CONFLICT', 'SOURCE_FAILED', 'STALE'],
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`✓ 已生成 ${points.length} 个数据点 → data/market.json`);
  console.log(`✓ 序列：${[...new Set(points.map((p) => p.series))].join(', ')}`);
}

main();
