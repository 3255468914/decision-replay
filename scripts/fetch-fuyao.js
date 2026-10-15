/**
 * scripts/fetch-fuyao.js —— 从扶摇拉取真实数据，落盘为 data/real/
 *
 * 为什么落盘而不是运行时直连：
 *   ① 密钥只存在于 .env，**落盘产物不含任何密钥**，因此 data/real/ 可以入库，
 *      评审无需申请 API Key 也能看到真实数据跑出来的报告；
 *   ② 报告的可复现性不依赖上游当时的可用性；
 *   ③ 避免每次刷新页面都打上游接口。
 *
 * 用法：
 *   node scripts/fetch-fuyao.js              # 有缓存则用缓存
 *   node scripts/fetch-fuyao.js --refresh    # 忽略缓存，重新拉取
 *   node scripts/fetch-fuyao.js --symbols 600519.SH,000300.SH
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFuyaoClient, FuyaoError } from '../src/adapters/fuyao.js';
import {
  msToDate,
  dateToMs,
  mapPriceBars,
  mapIndicatorPoints,
  mapValuationWeekly,
  buildEpsTtm,
  computeBps,
  resolveDisclosure,
  describeUnavailableCapabilities,
  num,
  DISCLOSURE,
} from '../src/adapters/fuyao-map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'real');
const CACHE_DIR = path.join(ROOT, '.tmp', 'raw');

/* ---------------- .env 读取（零依赖） ---------------- */
function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
}
loadEnv();

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const REFRESH = argv.includes('--refresh');
const symbolsArg = argv[argv.indexOf('--symbols') + 1];
const SYMBOLS = symbolsArg && !symbolsArg.startsWith('--') ? symbolsArg.split(',') : ['600519.SH', '000001.SZ', '300750.SZ'];
const BENCHMARK = '000300.SH';

/* 取数窗口：覆盖三条决策（2024-01 ~ 2024-09）及其事后 3 个月，另留一年前史用于分位计算 */
const WINDOW = { start: '2023-01-01', end: '2024-12-31' };
/* 财报窗口：多取一年，因为 TTM 需要上年同期数据 */
const FIN_WINDOW = { start: '2022-01-01', end: '2024-12-31' };

const startMs = dateToMs(WINDOW.start);
const endMs = dateToMs(WINDOW.end, 23, 59, 59);
const finStartMs = dateToMs(FIN_WINDOW.start);
const finEndMs = dateToMs(FIN_WINDOW.end, 23, 59, 59);

/**
 * 离场时点推导规则。
 *
 * 为什么需要这一步：演示样本的"离场理由"文本是为构造价格写的，直接用真实价格会自相矛盾
 * （例如理由写"触及止损线"而真实价格其实上涨了）。所以按理由的**行为含义**，
 * 用真实价格反推一个与该理由事实上相容的离场日。
 *
 * 规则全部可复现、可核验，不引入任何人工指定的日期。
 */
const EXIT_POLICY = {
  'D-2024-0311-A': {
    rule: 'first_drawdown',
    thresholdPct: -4,
    maxHoldBars: 120,
    reason: '对应"股价连续回调，担心继续下跌，先离场"',
    note: '回撤首次达到 -4% 即离场。注意其事前设定的止损线是 -10%：**他在自己的规则之前就跑了**，这本身就是一处可归因的行为偏差。',
  },
  'D-2024-0108-B': {
    rule: 'target_return',
    thresholdPct: 15,
    maxHoldBars: 240,
    reason: '对应"按事前计划离场"',
    note: '其 preCommit.targetReturnPct = 15%，取真实价格首次触及该目标之日。该标的的 -8% 止损线在真实行情中从未触发。',
  },
  'D-2024-0520-C': {
    rule: 'recover_after_drawdown',
    drawdownPct: -10,
    maxHoldBars: 240,
    reason: '对应"好不容易回到成本价上方，先卖出落袋为安"',
    note: '先要求区间回撤曾达到 -10%（"好不容易"才有依据），再取其后首次收盘价回到入场价之上之日。',
  },
};

/**
 * 从入场日之后的价格序列推导离场点。
 * @param {Map<string, number>} barsByDate 日期 → 收盘价
 */
function deriveExit(barsByDate, entryDate, policy) {
  if (!policy) return null;
  const dates = [...barsByDate.keys()].filter((d) => d >= entryDate).sort();
  if (dates.length < 2) return null;
  const entryPx = barsByDate.get(dates[0]);
  const window = dates.slice(1, policy.maxHoldBars + 1);

  if (policy.rule === 'first_drawdown') {
    for (const d of window) {
      const r = (barsByDate.get(d) / entryPx - 1) * 100;
      if (r <= policy.thresholdPct) {
        return { date: d, price: barsByDate.get(d), trace: { rule: policy.rule, thresholdPct: policy.thresholdPct, entryPx, returnPct: Number(r.toFixed(2)), note: policy.note } };
      }
    }
    return null;
  }

  if (policy.rule === 'target_return') {
    for (const d of window) {
      const r = (barsByDate.get(d) / entryPx - 1) * 100;
      if (r >= policy.thresholdPct) {
        return { date: d, price: barsByDate.get(d), trace: { rule: policy.rule, thresholdPct: policy.thresholdPct, entryPx, returnPct: Number(r.toFixed(2)), note: policy.note } };
      }
    }
    return null;
  }

  if (policy.rule === 'recover_after_drawdown') {
    let troughPct = 0;
    for (const d of window) {
      const r = (barsByDate.get(d) / entryPx - 1) * 100;
      troughPct = Math.min(troughPct, r);
      const wasDeep = troughPct <= policy.drawdownPct;
      if (wasDeep && r >= 0) {
        return {
          date: d,
          price: barsByDate.get(d),
          trace: { rule: policy.rule, drawdownPct: policy.drawdownPct, entryPx, returnPct: Number(r.toFixed(2)), troughPct: Number(troughPct.toFixed(2)), note: policy.note },
        };
      }
    }
    return null;
  }

  return null;
}

/* ---------------- 缓存 ---------------- */
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cacheHits = { hit: 0, miss: 0 };

function cachePath(key) {
  return path.join(CACHE_DIR, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

async function cached(key, fn) {
  const p = cachePath(key);
  if (!REFRESH && fs.existsSync(p)) {
    cacheHits.hit += 1;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  cacheHits.miss += 1;
  const val = await fn();
  fs.writeFileSync(p, JSON.stringify(val, null, 2));
  return val;
}

/* ---------------- 主流程 ---------------- */
const client = createFuyaoClient({ trace: [] });
const anomalies = [];
const unavailable = describeUnavailableCapabilities();
const reportPeriodRows = [];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const market = [];
  const events = [];
  const decisionTemplate = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'decisions.json'), 'utf8'));
  const barIndex = new Map(); // symbol -> Map(date -> close)

  const allSymbols = [...SYMBOLS];

  /* ---- 指数（基准） ---- */
  process.stdout.write(`拉取 ${BENCHMARK} 指数日线… `);
  {
    const { bars, requestId } = await cached(`hist_${BENCHMARK}_${WINDOW.start}_${WINDOW.end}`, () =>
      client.historicalPrices(BENCHMARK, startMs, endMs, 'none'),
    );
    const pts = mapPriceBars(BENCHMARK, bars, { seriesPrefix: 'index', unit: '点', adjust: 'none', requestId });
    market.push(...pts);
    barIndex.set(BENCHMARK, new Map(pts.map((p) => [p.asOf.slice(0, 10), p.value])));
    console.log(`${bars.length} 根K线（${msToDate(bars[0]?.date_ms)} ~ ${msToDate(bars.at(-1)?.date_ms)}）`);
  }

  /* ---- 个股：行情 + 财报 + 指标 ---- */
  for (const symbol of SYMBOLS) {
    process.stdout.write(`拉取 ${symbol} 日线… `);
    // adjust=none（未复权）而不是 forward（前复权），这是个刻意的选择：
    //   ① 前复权价会随每一次分红被**追溯修改**，同一份报告今天生成和三个月后生成数字不同，
    //      对一个以"可复现"为前提的复盘产品是致命的；
    //   ② 未复权价就是当日真实成交价，与决策记录里"我买在哪"口径一致。
    // 代价：跨除息日的持有期收益会少一块分红，已在 meta.fieldCaliber 中写明。
    const { bars, requestId } = await cached(`hist_${symbol}_${WINDOW.start}_${WINDOW.end}_none`, () =>
      client.historicalPrices(symbol, startMs, endMs, 'none'),
    );
    const pts = mapPriceBars(symbol, bars, { seriesPrefix: 'price', unit: 'CNY/股', adjust: 'none', requestId });
    market.push(...pts);
    barIndex.set(symbol, new Map(pts.map((p) => [p.asOf.slice(0, 10), p.value])));
    console.log(`${bars.length} 根K线`);

    /* 财报：利润表（EPS / 归母净利）+ 资产负债表（净资产） */
    process.stdout.write(`  拉取 ${symbol} 利润表… `);
    const income = await cached(`inc_${symbol}`, () =>
      client.statements('income-statements', symbol, { period: 'quarterly', start: finStartMs, end: finEndMs }),
    );
    const balance = await cached(`bal_${symbol}`, () =>
      client.statements('balance-sheets', symbol, { period: 'quarterly', start: finStartMs, end: finEndMs }),
    );
    console.log(`${income.items.length} 期；资产负债表 ${balance.items.length} 期`);

    const balByPeriod = new Map(balance.items.map((b) => [b.period_end_ms, b]));

    /* 逐期校验披露日，产出财报"事件"与质量异常记录 */
    const records = [];
    const equityRecords = [];
    for (const it of income.items) {
      const bal = balByPeriod.get(it.period_end_ms);
      const d = resolveDisclosure(it.period_end_ms, it.report_date_ms);
      const label = it.fiscal_period === 'FY' ? '年度报告' : `第${it.fiscal_period.slice(1)}季度报告`;
      const periodLabel = `${it.fiscal_year} 年${label}`;

      if (!d.ok) {
        anomalies.push({
          code: 'DISCLOSURE_DATE_IMPLAUSIBLE',
          symbol,
          period: `${it.fiscal_year}${it.fiscal_period}`,
          periodEnd: msToDate(it.period_end_ms),
          upstreamReportDate: msToDate(it.report_date_ms),
          legalDeadline: d.legalLagDays === null ? null : msToDate(it.period_end_ms + d.legalLagDays * 86400000),
          reportedLagDays: d.reportedLagDays,
          legalLagDays: d.legalLagDays,
          reason: d.reason,
          note: d.note,
          action: '降级采用法定披露截止日作为可得时点',
        });
      }

      records.push({
        key: `${it.fiscal_year}Q${{ Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 4 }[it.fiscal_period]}`,
        periodEndMs: it.period_end_ms,
        availableAtMs: d.availableAtMs,
        eps: num(it.basic_eps),
        parentNetProfit: num(it.parent_holder_net_profit),
        operatingIncome: num(it.operating_income),
      });

      if (bal) {
        const bps = computeBps({
          holderEquityTotal: bal.holder_equity_total,
          parentNetProfit: it.parent_holder_net_profit,
          basicEps: it.basic_eps,
        });
        if (bps) {
          equityRecords.push({
            key: `${it.fiscal_year}Q${{ Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 4 }[it.fiscal_period]}`,
            periodEndMs: it.period_end_ms,
            availableAtMs: d.availableAtMs,
            bps: bps.bps,
            shares: bps.shares,
          });
        }
      }

      reportPeriodRows.push({ symbol, fiscalYear: it.fiscal_year, fiscalPeriod: it.fiscal_period, periodEndMs: it.period_end_ms, availableAtMs: d.availableAtMs, trusted: d.ok, reportedLagDays: d.reportedLagDays });

      /* 披露事件：只保留落在取数窗口内的，且只对"披露日可信"的建事件（降级的不是真实披露时点） */
      if (d.availableAtMs >= startMs && d.availableAtMs <= endMs) {
        events.push({
          id: `E-${symbol}-${it.fiscal_year}${it.fiscal_period}`,
          publishedAt: `${msToDate(d.availableAtMs)}T${String(DISCLOSURE.ANNOUNCE_HOUR).padStart(2, '0')}:00:00+08:00`,
          title: `${symbol} ${periodLabel}${d.ok ? '' : '（披露日按法定截止日兜底）'}`,
          category: '定期报告',
          impact: 'medium',
          source: d.ok
            ? '扶摇 · 同花顺金融数据API（真实披露日）'
            : '扶摇 · 同花顺金融数据API（上游披露日不可信，按法定披露截止日兜底）',
          summary: d.ok
            ? `报告期 ${msToDate(it.period_end_ms)}，期末后 ${d.reportedLagDays} 天披露（法定期限 ${d.legalLagDays} 天）。`
            : `报告期 ${msToDate(it.period_end_ms)}。上游给出的披露日为 ${msToDate(it.report_date_ms)}（期末后 ${d.reportedLagDays} 天），超出法定披露期限 ${d.legalLagDays} 天，判定不可信，按法定截止日兜底。`,
          relatedSymbols: [symbol],
        });
      }
    }

    /* 财务指标：按报告期逐个拉取 */
    process.stdout.write(`  拉取 ${symbol} 财务指标… `);
    let indicatorCount = 0;
    for (const row of reportPeriodRows.filter((r) => r.symbol === symbol)) {
      if (row.periodEndMs < finStartMs || row.periodEndMs > finEndMs) continue;
      const q = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 4 }[row.fiscalPeriod];
      const report = `${row.fiscalYear}-${q}`;
      const { abilities, requestId: rid } = await cached(`ind_${symbol}_${report}`, () =>
        client.indicators(symbol, report),
      );
      const disclosure = { availableAtMs: row.availableAtMs };
      const mapped = mapIndicatorPoints(symbol, {
        abilities,
        periodEndMs: row.periodEndMs,
        disclosure,
        requestId: rid,
      });
      indicatorCount += mapped.length;
      market.push(...mapped);
    }
    console.log(`${indicatorCount} 个指标点`);

    /* PE / PB：由价格与财报推导，周频 */
    const epsTtm = buildEpsTtm(records);
    const valPts = mapValuationWeekly(symbol, {
      bars,
      earnings: [...epsTtm.values()],
      equity: equityRecords,
      seriesNames: ['peTtm', 'pb'],
      requestId,
    });
    market.push(...valPts);
    console.log(`  推导估值序列 ${valPts.length} 个点（peTtm + pb）`);
  }

  /* ---- 决策记录：入场价取真实收盘价；离场时点按"离场理由的行为含义"从真实价格推导 ---- */
  const decisions = decisionTemplate.decisions.map((d) => {
    const idx = barIndex.get(d.symbol);
    const entryDate = d.executedAt.slice(0, 10);
    const entry = lookupClose(idx, entryDate);
    return {
      ...d,
      price: entry ?? d.price,
      priceSource: entry ? `扶摇真实未复权收盘价（${entryDate}）` : '构造数据（该交易日无行情）',
      anonymized: true,
    };
  });

  const exits = decisionTemplate.exits.map((e) => {
    const dec = decisionTemplate.decisions.find((x) => x.id === e.decisionId);
    const idx = barIndex.get(dec.symbol);
    const entryDate = dec.executedAt.slice(0, 10);
    const entryPx = lookupClose(idx, entryDate);
    const policy = EXIT_POLICY[e.decisionId];
    const derived = entryPx ? deriveExit(idx, entryDate, policy) : null;

    if (!derived) {
      // 推导不出来就如实标注，而不是悄悄沿用构造价——那会让报告看起来是真的
      const px = lookupClose(idx, e.exitedAt.slice(0, 10));
      return {
        ...e,
        exitPrice: px ?? e.exitPrice,
        priceSource: '构造数据（离场规则在真实行情下未能推导，已回退）',
        derivation: { applied: false, policy: policy?.rule ?? null },
      };
    }
    return {
      ...e,
      exitedAt: `${derived.date}T14:40:00+08:00`,
      exitPrice: derived.price,
      priceSource: `扶摇真实未复权收盘价（${derived.date}）`,
      derivation: { applied: true, ...derived.trace },
    };
  });

  /* ---- 落盘 ---- */
  const generatedAt = new Date().toISOString();
  const seriesList = [...new Set(market.map((p) => p.series))].sort();

  fs.writeFileSync(
    path.join(OUT_DIR, 'market.json'),
    JSON.stringify(
      {
        note: '真实数据快照，由 scripts/fetch-fuyao.js 从扶摇（同花顺金融数据API）拉取后落盘。不含任何密钥。',
        generatedAt,
        window: WINDOW,
        pointCount: market.length,
        series: seriesList,
        points: market,
      },
      null,
      1,
    ),
  );

  fs.writeFileSync(
    path.join(OUT_DIR, 'decisions.json'),
    JSON.stringify(
      {
        note: '决策文本沿用演示样本（匿名代号）；入场价与离场价已替换为扶摇真实收盘价，保证与真实行情口径自洽。',
        decisions,
        exits,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(OUT_DIR, 'events.json'),
    JSON.stringify(
      {
        note: '事件来自扶摇真实披露日（仅收录披露日通过法定期限校验的报告期）。',
        events: events.sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1)),
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(OUT_DIR, 'meta.json'),
    JSON.stringify(
      {
        source: 'fuyao',
        provider: '扶摇 · 同花顺金融数据API',
        baseUrl: client.baseUrl,
        disclaimer: '行情与财报为真实数据（扶摇）。决策记录为匿名演示样本，非真实投资者行为。',
        generator: 'scripts/fetch-fuyao.js',
        generatedAt,
        window: WINDOW,
        financialWindow: FIN_WINDOW,
        benchmarkSeries: `index:${ BENCHMARK }`,
        symbols: SYMBOLS,
        apiCalls: client.callCount,
        cache: cacheHits,
        requestIds: client.trace.filter((t) => t.ok).map((t) => t.requestId).filter(Boolean).slice(0, 50),
        fieldCaliber: {
          'price:*': `未复权日收盘价，CNY/股，asOf=publishedAt=当日 ${DISCLOSURE.CLOSE_HOUR}:00+08:00。选未复权而非前复权：前复权价会随每次分红被追溯修改，破坏报告可复现性。代价是跨除息日的持有期收益未计入分红。`,
          'index:*': `未复权指数收盘，点，asOf=publishedAt=当日 ${DISCLOSURE.CLOSE_HOUR}:00+08:00`,
          'revenueYoy:*': '营业收入同比增长率，%，报告期口径，publishedAt=披露日（或降级后的法定截止日）',
          'roe:*': '加权平均净资产收益率，%，报告期口径',
          'grossMargin:*': '销售毛利率，%，报告期口径',
          'assetsDebtRatio:*': '资产负债率，%，报告期口径',
          'peTtm:*': '推导值：周频收盘价 ÷ TTM 每股收益（TTM 由累计季报拆分计算），倍',
          'pb:*': '推导值：周频收盘价 ÷ 每股净资产（净资产÷近似股本），倍',
        },
        disclosurePolicy: {          ...DISCLOSURE,
          legalDeadline: '一季报 4/30、半年报 8/31、三季报 10/31、年报次年 4/30（保守取当日 23:59:59）',
        },
        upstreamAnomalies: anomalies,
        unavailableCapabilities: unavailable,
        decisionPolicy: {
          note: '决策文本（买入理由、离场理由）为匿名演示样本，非真实投资者行为；入场价取真实未复权收盘价；离场时点按"离场理由的行为含义"由下列规则从真实价格推导，不人工指定任何日期。',
          exitRules: EXIT_POLICY,
        },
      },
      null,
      2,
    ),
  );

  /* ---- 控制台小结 ---- */
  console.log('\n─── 落盘完成 ───');
  console.log(`输出目录：${path.relative(ROOT, OUT_DIR)}`);
  console.log(`数据点：${market.length}（序列 ${seriesList.length} 条）`);
  console.log(`事件：${events.length} 条；披露日异常：${anomalies.length} 处`);
  console.log(`接口调用：${client.callCount} 次（缓存命中 ${cacheHits.hit} / 未命中 ${cacheHits.miss}）`);
  if (anomalies.length) {
    console.log('\n披露日异常（前 6 条）：');
    for (const a of anomalies.slice(0, 6)) {
      console.log(
        `  ${a.symbol} ${a.period}｜期末 ${a.periodEnd}｜上游给 ${a.upstreamReportDate}（期末后 ${a.reportedLagDays} 天）｜法定期限 ${a.legalLagDays} 天 → ${a.action}`,
      );
    }
  }
  console.log('\n序列清单：');
  for (const s of seriesList) console.log(`  ${s}`);
}

/** 取某日的收盘价；非交易日则回退到之前最近的一个交易日 */
function lookupClose(idx, date) {
  if (!idx) return null;
  if (idx.has(date)) return idx.get(date);
  const dates = [...idx.keys()].filter((d) => d <= date).sort();
  return dates.length ? idx.get(dates.at(-1)) : null;
}

main().catch((err) => {
  if (err instanceof FuyaoError) {
    console.error(`\n扶摇调用失败：${err.code}${err.bizCode ? ` (bizCode=${err.bizCode})` : ''} — ${err.message}`);
    if (err.remediation) console.error(`建议：${err.remediation}`);
  } else {
    console.error('\n拉取失败：', err);
  }
  process.exit(1);
});
