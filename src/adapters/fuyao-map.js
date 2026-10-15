/**
 * adapters/fuyao-map.js —— 扶摇字段 → 内部 schema 的映射与校验
 *
 * 全部是纯函数，不发起网络请求，因此可离线单测（用录制的响应做输入）。
 *
 * 本层承担的核心职责是「把上游的不可信之处挡在产品之外」：
 *
 *   ① 披露日校验。实测发现扶摇的 report_date_ms 在多个标的、多个报告期上
 *      比 A 股法定披露期限晚了整整一年（例：平安银行 2023 年报给 2025-03-15，
 *      实际应为 2024-03；宁德时代 2025Q1 给 2025-04-15 则是对的）。
 *      也就是说该字段「时对时错」，不能整体丢弃，也不能整体信任。
 *      处理方式：按法定截止日做合理性校验，通过则采用，不通过则降级到法定截止日
 *      并记一条数据质量 issue。这是保守策略——宁可晚一点确认，也不能提前知道。
 *
 *   ② 指标 ID 名称漂移。文档写 operating_income_yoy_growth_ratio，
 *      实际返回 calculate_operating_income_yoy_growth_ratio。按后缀匹配，不硬编码。
 *
 *   ③ 明确不可得的能力不伪造。扶摇没有 PE / PB / 股息率 / 不良率 / PMI 接口，
 *      其中 PE、PB 由价格与财报自行推导（口径写清、标注 derived）；
 *      股息率、不良率、PMI 一律不出点，交给产品的数据质量层报「不可得」。
 */

/* ---------------- 时间：固定 UTC+8，无夏令时 ---------------- */
const TZ_OFFSET_MS = 8 * 3600 * 1000;

export function msToIso(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + TZ_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
}

export function msToDate(ms) {
  const iso = msToIso(ms);
  return iso ? iso.slice(0, 10) : null;
}

export function dateToMs(dateStr, h = 0, m = 0, s = 0) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, h, m, s) - TZ_OFFSET_MS;
}

/** 收盘时点：A 股 15:00 收盘，日线在该时点可得 */
const CLOSE_HOUR = 15;
/** 公告时点：定期报告公告多在收盘后发布，按 19:00 作为可得时点（保守） */
const ANNOUNCE_HOUR = 19;

export const DISCLOSURE = {
  CLOSE_HOUR,
  ANNOUNCE_HOUR,
  note: '日线按当日 15:00 可得；定期报告按披露日 19:00 可得（公告多在收盘后发布，取当日更晚时点更保守）',
};

/* ---------------- 法定披露期限 ---------------- */
/**
 * A 股定期报告法定披露期限（保守取值，作为披露日不可信时的兜底）：
 *   一季报（期末 03-31）→ 当年 04-30
 *   半年报（期末 06-30）→ 当年 08-31
 *   三季报（期末 09-30）→ 当年 10-31
 *   年报  （期末 12-31）→ 次年 04-30
 * 返回的是"该日 23:59:59"——即到这一刻之前，都不能假定数据已可获得。
 */
export function legalDeadlineMs(periodEndMs) {
  const d = new Date(periodEndMs + TZ_OFFSET_MS);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const endOf = (yy, mm, dd) => dateToMs(`${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, 23, 59, 59);

  if (mo === 12 && day === 31) return endOf(y + 1, 4, 30);
  if (mo === 3 && day === 31) return endOf(y, 4, 30);
  if (mo === 6 && day === 30) return endOf(y, 8, 31);
  if (mo === 9 && day === 30) return endOf(y, 10, 31);
  return null; // 非标准报告期（如变更会计期间），不兜底
}

export const REPORT_DATE_REASON = {
  TRUSTED: 'REPORT_DATE_TRUSTED',
  AFTER_DEADLINE: 'REPORT_DATE_AFTER_LEGAL_DEADLINE',
  BEFORE_PERIOD_END: 'REPORT_DATE_BEFORE_PERIOD_END',
  MISSING: 'REPORT_DATE_MISSING',
  NO_RULE: 'REPORT_DATE_NO_LEGAL_RULE',
};

/**
 * 校验披露日是否可信，并给出"应当采用的可得时点"。
 *
 * @returns {{availableAtMs:number, ok:boolean, reason:string, lagDays:number|null,
 *            legalLagDays:number|null, reportedLagDays:number|null, note:string}}
 */
export function resolveDisclosure(periodEndMs, reportDateMs) {
  const deadline = legalDeadlineMs(periodEndMs);
  // 时滞一律按"日期"相减，而不是按毫秒相减：
  // 期末是当日 00:00、截止日是当日 23:59:59，直接相减会多出一天，
  // 让"期末后 30 天"这种说法变成 31 天，看起来像是把法定期限也弄错了。
  const daysBetweenDates = (fromMs, toMs) => Math.round((dateToMs(msToDate(toMs)) - dateToMs(msToDate(fromMs))) / 86400000);
  const legalLagDays = deadline === null ? null : daysBetweenDates(periodEndMs, deadline);
  const reportedLagDays = Number.isFinite(reportDateMs) ? daysBetweenDates(periodEndMs, reportDateMs) : null;

  // 兜底时点：法定截止日（含当日 23:59:59）
  const fallback = deadline ?? periodEndMs + 90 * 86400000;

  if (!Number.isFinite(reportDateMs)) {
    return {
      availableAtMs: fallback,
      ok: false,
      reason: REPORT_DATE_REASON.MISSING,
      lagDays: legalLagDays,
      legalLagDays,
      reportedLagDays: null,
      note: `上游未返回披露日，降级采用法定披露截止日（期末后 ${legalLagDays} 天）。`,
    };
  }

  if (reportDateMs < periodEndMs) {
    return {
      availableAtMs: fallback,
      ok: false,
      reason: REPORT_DATE_REASON.BEFORE_PERIOD_END,
      lagDays: legalLagDays,
      legalLagDays,
      reportedLagDays,
      note: `上游披露日（${msToDate(reportDateMs)}）早于报告期末（${msToDate(periodEndMs)}），不可能成立，降级采用法定截止日。`,
    };
  }

  if (deadline === null) {
    return {
      availableAtMs: reportDateMs,
      ok: false,
      reason: REPORT_DATE_REASON.NO_RULE,
      lagDays: reportedLagDays,
      legalLagDays: null,
      reportedLagDays,
      note: `非标准报告期（期末 ${msToDate(periodEndMs)}），无法用法定期限校验，直接采用上游披露日。`,
    };
  }

  if (reportDateMs > deadline) {
    return {
      availableAtMs: fallback,
      ok: false,
      reason: REPORT_DATE_REASON.AFTER_DEADLINE,
      lagDays: legalLagDays,
      legalLagDays,
      reportedLagDays,
      note:
        `上游披露日（${msToDate(reportDateMs)}）超出法定披露期限（最晚 ${msToDate(deadline)}）` +
        `${reportedLagDays - legalLagDays >= 300 ? '，超出约一年，疑为上游年份错位' : ''}；` +
        `按保守原则降级采用法定截止日。`,
    };
  }

  return {
    availableAtMs: reportDateMs,
    ok: true,
    reason: REPORT_DATE_REASON.TRUSTED,
    lagDays: reportedLagDays,
    legalLagDays,
    reportedLagDays,
    note: `上游披露日在法定期限内（期末后 ${reportedLagDays} 天），予以采用。`,
  };
}

/* ---------------- 指标 ID：按后缀匹配，容忍 calculate_ 等前缀漂移 ---------------- */
export function flattenIndicators(abilities = []) {
  const out = {};
  for (const block of abilities) {
    for (const ind of block?.indicators ?? []) {
      if (!ind?.index_id) continue;
      out[ind.index_id] = { value: ind.value, ability: block.ability };
    }
  }
  return out;
}

/**
 * 在扁平化指标里按后缀找目标指标。
 * 例：want='operating_income_yoy_growth_ratio' 可命中 'calculate_operating_income_yoy_growth_ratio'。
 */
export function pickIndicator(flat, want) {
  if (flat[want]) return { id: want, ...flat[want] };
  const keys = Object.keys(flat).filter((k) => k === want || k.endsWith(`_${want}`));
  if (keys.length === 0) return null;
  // 优先取最短的匹配（前缀最少），避免误命中更具体的指标
  keys.sort((a, b) => a.length - b.length);
  return { id: keys[0], ...flat[keys[0]] };
}

/** value 是字符串（上游为保留精度返回字符串），统一转 number；null/'' → null */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const INDICATOR_WANT = {
  revenueYoy: 'operating_income_yoy_growth_ratio',
  roe: 'index_weighted_avg_roe',
  grossMargin: 'sale_gross_margin',
  assetsDebtRatio: 'assets_debt_ratio',
  netProfitYoy: 'parent_holder_net_profit_yoy_growth_ratio',
};

/* ---------------- 序列构造 ---------------- */
const SRC = '扶摇 · 同花顺金融数据API';

function point({ series, asOfMs, publishedAtMs, value, unit, caliber, derived, requestId }) {
  return {
    series,
    asOf: msToIso(asOfMs),
    publishedAt: msToIso(publishedAtMs),
    value,
    unit,
    source: SRC,
    provenance: {
      source: 'fuyao',
      requestId: requestId ?? null,
      caliber: caliber ?? null,
      derived: Boolean(derived),
    },
  };
}

/** 日线 → price:xxx / index:xxx。asOf 与 publishedAt 都是当日 15:00。 */
export function mapPriceBars(symbol, bars, { seriesPrefix = 'price', unit = 'CNY/股', adjust = 'none', requestId = null } = {}) {
  const series = `${seriesPrefix}:${symbol}`;
  const out = [];
  for (const b of bars ?? []) {
    const date = msToDate(b.date_ms);
    if (!date) continue;
    const close = num(b.close_price);
    if (close === null) continue;
    const t = dateToMs(date, CLOSE_HOUR, 0, 0);
    out.push(
      point({
        series,
        asOfMs: t,
        publishedAtMs: t,
        // A 股最小价格变动单位为 0.01 元，按 2 位小数取整；
        // 前复权价会算出 1560.0777699999999 这类残值，既难看也会让"同一天两个数不相等"的断言难以书写。
        value: Number(close.toFixed(2)),
        unit,
        caliber: `${ADJUST_LABEL[adjust] ?? adjust}日收盘价`,
        derived: adjust !== 'none',
        requestId,
      }),
    );
  }
  return out;
}

const ADJUST_LABEL = {
  none: '未复权',
  forward: '前复权',
  backward: '后复权',
};

/** 财务指标 → revenueYoy / roe / grossMargin / assetsDebtRatio */
export function mapIndicatorPoints(symbol, { abilities, periodEndMs, disclosure, requestId }) {
  const flat = flattenIndicators(abilities);
  const defs = [
    ['revenueYoy', INDICATOR_WANT.revenueYoy, '营业收入同比增长率', '%'],
    ['roe', INDICATOR_WANT.roe, '加权平均净资产收益率', '%'],
    ['grossMargin', INDICATOR_WANT.grossMargin, '销售毛利率', '%'],
    ['assetsDebtRatio', INDICATOR_WANT.assetsDebtRatio, '资产负债率', '%'],
    ['netProfitYoy', INDICATOR_WANT.netProfitYoy, '归母净利润同比增长率', '%'],
  ];
  const asOfMs = periodEndMs + CLOSE_HOUR * 3600 * 1000;
  const out = [];
  for (const [seriesName, want, label, unit] of defs) {
    const hit = pickIndicator(flat, want);
    const value = hit ? num(hit.value) : null;
    if (value === null) continue; // 上游缺失一律不出点，不补零
    out.push(
      point({
        series: `${seriesName}:${symbol}`,
        asOfMs,
        publishedAtMs: disclosure.availableAtMs,
        value: Number(value.toFixed(4)),
        unit,
        caliber: `${label}（报告期 ${msToDate(periodEndMs)}）｜上游字段 ${hit.id}`,
        derived: false,
        requestId,
      }),
    );
  }
  return out;
}

/* ---------------- PE / PB 推导 ---------------- */
/** 报告期期末 → 财年与季度序号（Q4 即年报） */
export function fiscalKey(periodEndMs) {
  const d = new Date(periodEndMs + TZ_OFFSET_MS);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const q = { 3: 1, 6: 2, 9: 3, 12: 4 }[mo];
  return q ? { year: y, q, key: `${y}Q${q}` } : null;
}

/**
 * 由累计口径的季报推导 TTM EPS。
 * 季报的 basic_eps 是年内累计值，因此：
 *   Q4      → EPS_TTM = 当年年报 EPS
 *   Q1/Q2/Q3 → EPS_TTM = 上年年报 EPS + 本年累计 EPS − 上年同期累计 EPS
 */
export function buildEpsTtm(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const fk = fiscalKey(r.periodEndMs);
    if (fk) byKey.set(fk.key, { ...r, ...fk });
  }
  const out = new Map();
  for (const [key, r] of byKey) {
    let ttm = null;
    if (r.q === 4) {
      ttm = r.eps;
    } else {
      const fy = byKey.get(`${r.year - 1}Q4`);
      const prevSame = byKey.get(`${r.year - 1}Q${r.q}`);
      if (fy?.eps !== null && fy?.eps !== undefined && prevSame?.eps !== null && prevSame?.eps !== undefined && r.eps !== null) {
        ttm = fy.eps + r.eps - prevSame.eps;
      }
    }
    if (ttm !== null && Number.isFinite(ttm)) {
      // 累计值相减必然产生浮点残值（3.5999999999999996）。
      // 每股收益保留 4 位小数：既消掉噪声，也不损失精度（A 股 EPS 通常 2 位）。
      out.set(key, { key, epsTtm: Number(ttm.toFixed(4)), ...r });
    }
  }
  return out;
}

/**
 * 每股净资产：BPS = 归母净资产 / 股本，股本 ≈ 归母净利润 / 基本每股收益。
 * 两者同取自同一报告期，口径自洽。
 */
export function computeBps({ holderEquityTotal, parentNetProfit, basicEps }) {
  const eq = num(holderEquityTotal);
  const np = num(parentNetProfit);
  const eps = num(basicEps);
  if (eq === null || np === null || eps === null || np === 0 || eps === 0) return null;
  const shares = np / eps; // 近似股本
  if (!Number.isFinite(shares) || shares <= 0) return null;
  return { shares, bps: eq / shares };
}

/** 取"在某一时点已可得"的最新一条（按 availableAtMs 过滤），用于把财报对齐到交易日 */
export function latestAvailable(records, atMs) {
  let best = null;
  for (const r of records) {
    if (r.availableAtMs > atMs) continue;
    if (!best || r.availableAtMs > best.availableAtMs) best = r;
  }
  return best;
}

/**
 * 生成 peTtm / pb 周频序列。
 * 之所以周频而不是日频：估值变化主要由价格驱动，日频会产生大量近重复点，
 * 既拖大载荷又没有额外信息量；周频与构造数据集的粒度也保持一致。
 */
export function mapValuationWeekly(symbol, { bars, earnings, equity, seriesNames = ['peTtm', 'pb'], requestId }) {
  const out = [];
  let lastWeekKey = null;
  for (const b of bars ?? []) {
    const date = msToDate(b.date_ms);
    if (!date) continue;
    const close = num(b.close_price);
    if (close === null) continue;
    const atMs = dateToMs(date, CLOSE_HOUR, 0, 0);
    // 每周只取最后一个交易日（周五或该周最后一个交易日）
    const d = new Date(atMs + TZ_OFFSET_MS);
    const dow = d.getUTCDay();
    const curWeekKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${Math.floor(d.getUTCDate() / 7)}`;
    const nextBar = bars[bars.indexOf(b) + 1];
    const nextWeekKey = nextBar ? (() => {
      const nd = new Date(nextBar.date_ms + TZ_OFFSET_MS);
      return `${nd.getUTCFullYear()}-${nd.getUTCMonth()}-${Math.floor(nd.getUTCDate() / 7)}`;
    })() : null;
    if (curWeekKey === lastWeekKey) continue;
    if (nextWeekKey === curWeekKey) continue; // 不是本周最后一根，跳过
    lastWeekKey = curWeekKey;

    if (seriesNames.includes('peTtm')) {
      const e = latestAvailable(earnings ?? [], atMs);
      if (e && e.epsTtm > 0) {
        out.push(
          point({
            series: `peTtm:${symbol}`,
            asOfMs: atMs,
            publishedAtMs: atMs,
            value: Number((close / e.epsTtm).toFixed(2)),
            unit: '倍',
            caliber: `价格 ${close} ÷ TTM 每股收益 ${e.epsTtm.toFixed(2)}（财报口径 ${e.key}，按其可得时点对齐）`,
            derived: true,
            requestId,
          }),
        );
      }
    }
    if (seriesNames.includes('pb')) {
      const v = latestAvailable(equity ?? [], atMs);
      if (v && v.bps > 0) {
        out.push(
          point({
            series: `pb:${symbol}`,
            asOfMs: atMs,
            publishedAtMs: atMs,
            value: Number((close / v.bps).toFixed(2)),
            unit: '倍',
            caliber: `价格 ${close} ÷ 每股净资产 ${v.bps.toFixed(2)}（财报口径 ${v.key}，按其可得时点对齐）`,
            derived: true,
            requestId,
          }),
        );
      }
    }
  }
  return out;
}

/** 无 PE/PB 可用（缺财报）时，宁可不出点，由质量层报缺口 */
export function describeUnavailableCapabilities() {
  return [
    { series: 'dividendYield:*', reason: '扶摇未开放股息率接口（除复权/分红路由实测返回 404），产品无法核验股息率类理由。' },
    { series: 'nplRatio:*', reason: '扶摇财务指标不含银行不良贷款率，产品无法核验资产质量类理由。' },
    { series: 'pmi:CN', reason: '扶摇不提供宏观 PMI 数据，宏观背景无法作为决策依据纳入。' },
  ];
}
