/**
 * test/fuyao.test.js —— 扶摇适配层（离线，不发网络请求）
 *
 * 覆盖两类东西：
 *   A. 纯函数的映射与校验逻辑 —— 尤其"披露日不可信时如何降级"，这是本适配层的核心职责。
 *   B. 交付物卫生 —— 数据快照与产物中不得出现任何 API Key（题目明令禁止提交密钥）。
 *
 * 之所以全部离线：适配层一旦依赖实时上游，测试就不再可复现；
 * 上游字段名与数值都可能变动，回归基线必须钉死在本地。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  legalDeadlineMs,
  resolveDisclosure,
  REPORT_DATE_REASON,
  dateToMs,
  msToDate,
  flattenIndicators,
  pickIndicator,
  num,
  buildEpsTtm,
  computeBps,
  mapPriceBars,
  mapIndicatorPoints,
  latestAvailable,
  fiscalKey,
  describeUnavailableCapabilities,
} from '../src/adapters/fuyao-map.js';
import { BIZ_CODE_MAP, FuyaoError } from '../src/adapters/fuyao.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ==================== A. 法定披露期限 ==================== */

test('法定披露期限：一季报 4/30、半年报 8/31、三季报 10/31、年报次年 4/30', () => {
  assert.equal(msToDate(legalDeadlineMs(dateToMs('2024-03-31'))), '2024-04-30');
  assert.equal(msToDate(legalDeadlineMs(dateToMs('2024-06-30'))), '2024-08-31');
  assert.equal(msToDate(legalDeadlineMs(dateToMs('2024-09-30'))), '2024-10-31');
  assert.equal(msToDate(legalDeadlineMs(dateToMs('2023-12-31'))), '2024-04-30', '年报应跨年到次年 4/30');
});

test('法定披露期限取当日 23:59:59，而不是当日 00:00 —— 当天开盘前不能假定数据已披露', () => {
  const deadline = legalDeadlineMs(dateToMs('2024-03-31'));
  assert.equal(msToDate(deadline), '2024-04-30');
  const morning = dateToMs('2024-04-30', 9, 0, 0);
  assert.ok(morning < deadline, '4/30 上午 9 点必须早于兜底可得时点');
});

/* ==================== A. 披露日校验与降级 ==================== */

test('披露日在法定期限内 → 采用上游日期', () => {
  const r = resolveDisclosure(dateToMs('2024-03-31'), dateToMs('2024-04-25', 19, 0, 0));
  assert.equal(r.ok, true);
  assert.equal(r.reason, REPORT_DATE_REASON.TRUSTED);
  assert.equal(msToDate(r.availableAtMs), '2024-04-25');
  assert.equal(r.reportedLagDays, 25);
});

test('上游披露日超出法定期限 → 判定不可信，降级到法定截止日', () => {
  // 这正是扶摇实测的表现：2024Q1 报 2025-04-30，比法定期限晚整整一年
  const r = resolveDisclosure(dateToMs('2024-03-31'), dateToMs('2025-04-30'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, REPORT_DATE_REASON.AFTER_DEADLINE);
  assert.equal(msToDate(r.availableAtMs), '2024-04-30', '应降级到法定截止日');
  assert.equal(r.legalLagDays, 30);
  assert.equal(r.reportedLagDays, 395);
  assert.match(r.note, /年份错位/);
});

test('披露日早于报告期末 → 不可能成立，同样降级', () => {
  const r = resolveDisclosure(dateToMs('2024-03-31'), dateToMs('2024-03-01'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, REPORT_DATE_REASON.BEFORE_PERIOD_END);
  assert.equal(msToDate(r.availableAtMs), '2024-04-30');
});

test('披露日缺失 → 降级而不是当作"随时可得"', () => {
  const r = resolveDisclosure(dateToMs('2024-06-30'), null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, REPORT_DATE_REASON.MISSING);
  assert.equal(msToDate(r.availableAtMs), '2024-08-31');
});

test('降级的可得时点一定不早于法定截止日 —— 绝不提前知道', () => {
  for (const periodEnd of ['2023-03-31', '2023-06-30', '2023-09-30', '2023-12-31']) {
    for (const upstream of [null, dateToMs('2026-01-01'), dateToMs('2022-01-01')]) {
      const r = resolveDisclosure(dateToMs(periodEnd), upstream);
      const deadline = legalDeadlineMs(dateToMs(periodEnd));
      assert.ok(
        r.availableAtMs >= deadline || r.ok === true,
        `${periodEnd} 的降级时点不得早于法定截止日`,
      );
    }
  }
});

/* ==================== A. 指标 ID 漂移 ==================== */

test('指标 ID 匹配：精确命中优先；只有带前缀的版本时才退到后缀匹配', () => {
  // 文档写 operating_income_yoy_growth_ratio，实际返回 calculate_operating_income_yoy_growth_ratio
  const onlyPrefixed = flattenIndicators([
    { ability: 'growth', indicators: [{ index_id: 'calculate_operating_income_yoy_growth_ratio', value: '18.481045' }] },
  ]);
  assert.equal(pickIndicator(onlyPrefixed, 'operating_income_yoy_growth_ratio').value, '18.481045', '只有带前缀的版本时必须能命中');

  // 两个都存在时，精确的同名指标更可信，不应被后缀匹配抢走
  const both = flattenIndicators([
    { ability: 'growth', indicators: [{ index_id: 'calculate_operating_income_yoy_growth_ratio', value: '18.481045' }] },
    { ability: 'growth', indicators: [{ index_id: 'operating_income_yoy_growth_ratio', value: '99' }] },
  ]);
  assert.equal(pickIndicator(both, 'operating_income_yoy_growth_ratio').value, '99', '精确同名应优先');
});

test('指标不存在时返回 null，调用方据此不出点（不补零、不臆造）', () => {
  const flat = flattenIndicators([{ ability: 'solvency', indicators: [{ index_id: 'current_ratio', value: null }] }]);
  assert.equal(pickIndicator(flat, 'operating_income_yoy_growth_ratio'), null);
});

test('num() 把上游的字符串数值转成 number，空值一律 null', () => {
  assert.equal(num('18.481045'), 18.481045);
  assert.equal(num(null), null);
  assert.equal(num(''), null);
  assert.equal(num('abc'), null);
});

/* ==================== A. 估值推导 ==================== */

test('TTM EPS：年报直接用当年 EPS', () => {
  const m = buildEpsTtm([
    { key: '2023Q4', periodEndMs: dateToMs('2023-12-31'), eps: 4.0, parentNetProfit: 400, operatingIncome: 4000, availableAtMs: dateToMs('2024-04-30') },
  ]);
  assert.equal(m.get('2023Q4').epsTtm, 4.0);
});

test('TTM EPS：季报用「上年年报 + 本年累计 − 上年同期累计」', () => {
  const mk = (y, q, eps) => ({ key: `${y}Q${q}`, periodEndMs: dateToMs(`${q === 4 ? y : y}-${String(q * 3).padStart(2, '0')}-30`), eps, parentNetProfit: eps * 100, operatingIncome: 0, availableAtMs: 0 });
  const m = buildEpsTtm([
    mk(2022, 4, 3.0),
    mk(2022, 3, 2.0),
    mk(2023, 3, 2.6),
    mk(2023, 4, 3.5),
  ]);
  // 2023Q3 的 TTM = 2022 年报 3.0 + 2023Q3 累计 2.6 − 2022Q3 累计 2.0 = 3.6
  assert.equal(m.get('2023Q3').epsTtm, 3.6);
});

test('TTM EPS：缺少上年同期数据时不出值，而不是用累计值冒充', () => {
  const m = buildEpsTtm([{ key: '2023Q2', periodEndMs: dateToMs('2023-06-30'), eps: 1.5, parentNetProfit: 150, operatingIncome: 0, availableAtMs: 0 }]);
  assert.equal(m.get('2023Q2'), undefined);
});

test('每股净资产：由「归母净资产 ÷ 近似股本」推导，股本反解自净利润与 EPS', () => {
  const r = computeBps({ holderEquityTotal: 1000e8, parentNetProfit: 100e8, basicEps: 5 });
  assert.ok(Math.abs(r.shares - 20e8) < 1e-6, `股本应约 20 亿，实际 ${r.shares}`);
  assert.ok(Math.abs(r.bps - 50) < 1e-6, `BPS 应为 50，实际 ${r.bps}`);
});

test('每股净资产：输入缺失或 EPS 为 0 时返回 null，避免除零产生 Infinity', () => {
  assert.equal(computeBps({ holderEquityTotal: 100, parentNetProfit: 10, basicEps: 0 }), null);
  assert.equal(computeBps({ holderEquityTotal: null, parentNetProfit: 10, basicEps: 1 }), null);
});

test('财报按「可得时点」对齐，不得用未来才披露的财报算历史估值', () => {
  const records = [
    { key: '2023Q3', availableAtMs: dateToMs('2023-10-31', 23, 59, 59), bps: 10 },
    { key: '2023Q4', availableAtMs: dateToMs('2024-04-30', 23, 59, 59), bps: 12 },
  ];
  // 2024-03-01：只能看到 2023Q3
  assert.equal(latestAvailable(records, dateToMs('2024-03-01')).key, '2023Q3');
  // 2024-05-01：2023 年报已可得
  assert.equal(latestAvailable(records, dateToMs('2024-05-01')).key, '2023Q4');
  // 边界：截止日当天 00:00 仍不可得
  assert.equal(latestAvailable(records, dateToMs('2024-04-30', 0, 0, 0)).key, '2023Q3');
});

/* ==================== A. 序列构造 ==================== */

test('日线映射：asOf 与 publishedAt 都是当日 15:00（收盘后才可得），价格取 2 位小数', () => {
  const pts = mapPriceBars('600519.SH', [
    { date_ms: dateToMs('2024-03-11'), close_price: 1694.4900000000002, open_price: 1, high_price: 1, low_price: 1, volume: 1, turnover: 1 },
  ]);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].series, 'price:600519.SH');
  assert.equal(pts[0].value, 1694.49, '应消除浮点残值');
  assert.equal(pts[0].asOf, '2024-03-11T15:00:00+08:00');
  assert.equal(pts[0].publishedAt, '2024-03-11T15:00:00+08:00');
});

test('财务指标映射：publishedAt 用披露日，asOf 用报告期末，二者必须可区分', () => {
  const pts = mapIndicatorPoints('600519.SH', {
    abilities: [{ ability: 'growth', indicators: [{ index_id: 'calculate_operating_income_yoy_growth_ratio', value: '18.481045' }] }],
    periodEndMs: dateToMs('2023-09-30'),
    disclosure: { availableAtMs: dateToMs('2023-10-31', 23, 59, 59) },
  });
  assert.equal(pts.length, 1);
  assert.equal(pts[0].series, 'revenueYoy:600519.SH');
  assert.equal(pts[0].asOf.slice(0, 10), '2023-09-30');
  assert.equal(pts[0].publishedAt.slice(0, 10), '2023-10-31');
  assert.ok(pts[0].provenance.caliber.includes('calculate_operating_income_yoy_growth_ratio'), '口径里要留下上游字段名');
});

test('上游指标为 null 时不出点 —— 缺口要显式暴露，而不是补 0', () => {
  const pts = mapIndicatorPoints('000001.SZ', {
    abilities: [{ ability: 'profitability', indicators: [{ index_id: 'sale_gross_margin', value: null }] }],
    periodEndMs: dateToMs('2023-09-30'),
    disclosure: { availableAtMs: dateToMs('2023-10-31') },
  });
  assert.equal(pts.find((p) => p.series.startsWith('grossMargin:')), undefined, '银行确实没有毛利率，不得造一个出来');
});

test('明确声明扶摇不提供的能力清单（含股息率、不良率、PMI）', () => {
  const list = describeUnavailableCapabilities();
  assert.ok(list.length >= 3);
  const joined = list.map((x) => x.series).join(',');
  assert.match(joined, /dividendYield/);
  assert.match(joined, /nplRatio/);
  assert.match(joined, /pmi/);
});

test('报告期解析：只有季末才产出财年季度键', () => {
  assert.equal(fiscalKey(dateToMs('2023-12-31')).key, '2023Q4');
  assert.equal(fiscalKey(dateToMs('2023-03-31')).key, '2023Q1');
  assert.equal(fiscalKey(dateToMs('2023-05-15')), null, '非季末不应产生报告期');
});

/* ==================== A. 错误码映射 ==================== */

test('业务错误码映射：区分可重试与不可重试', () => {
  assert.equal(BIZ_CODE_MAP[2001].code, 'AUTH_MISSING');
  assert.equal(BIZ_CODE_MAP[2001].retryable, false, '鉴权失败重试没有意义');
  assert.equal(BIZ_CODE_MAP[2003].code, 'AUTH_FORBIDDEN');
  assert.equal(BIZ_CODE_MAP[3002].code, 'DATA_NOT_READY');
  assert.equal(BIZ_CODE_MAP[4001].retryable, true, '限流应退避重试');
  assert.equal(BIZ_CODE_MAP[5002].retryable, true);
  assert.equal(BIZ_CODE_MAP[5003].retryable, true);
});

test('未配置 API Key 时客户端直接拒绝，不留到请求阶段才报错', async () => {
  const { createFuyaoClient } = await import('../src/adapters/fuyao.js');
  assert.throws(() => createFuyaoClient({ apiKey: '' }), (e) => e instanceof FuyaoError && e.code === 'AUTH_MISSING');
});

test('鉴权失败不重试：只发一次请求就抛出（避免用错误 Key 打爆上游）', async () => {
  const { createFuyaoClient } = await import('../src/adapters/fuyao.js');
  let calls = 0;
  const client = createFuyaoClient({
    apiKey: 'test',
    maxRetries: 3,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return {
        status: 200,
        text: async () => JSON.stringify({ code: 2003, message: 'Missing X-api-key', data: null, request_id: 'r1' }),
      };
    },
  });
  await assert.rejects(() => client.request('/api/a-share/prices/snapshot'), (e) => e.code === 'AUTH_FORBIDDEN');
  assert.equal(calls, 1, `鉴权失败应只请求 1 次，实际 ${calls} 次`);
});

test('非 JSON 响应（上游返回 HTML 错误页）被显式识别，而不是当成解析失败', async () => {
  const { createFuyaoClient } = await import('../src/adapters/fuyao.js');
  const client = createFuyaoClient({
    apiKey: 'test',
    maxRetries: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => ({ status: 400, text: async () => '<!doctype html><html><head><title>HTTP Status 400</title></head></html>' }),
  });
  await assert.rejects(
    () => client.request('/api/meta/tickers/search', { q: '平安银行' }),
    (e) => e.code === 'RESPONSE_NOT_JSON' && e.status === 400,
  );
});

test('限流（4001）会退避重试，重试成功则正常返回', async () => {
  const { createFuyaoClient } = await import('../src/adapters/fuyao.js');
  let calls = 0;
  const client = createFuyaoClient({
    apiKey: 'test',
    maxRetries: 3,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      const body = calls === 1
        ? { code: 4001, message: 'rate limited', data: null, request_id: 'r1' }
        : { code: 0, message: 'success', data: { timestamp: 1, item: [{ thscode: 'X' }] }, request_id: 'r2' };
      return { status: 200, text: async () => JSON.stringify(body) };
    },
  });
  const r = await client.request('/api/a-share/prices/snapshot');
  assert.equal(calls, 2, '第一次限流后应重试');
  assert.equal(r.data.item.length, 1);
});

/* ==================== B. 交付物卫生 ==================== */

test('数据快照与产物中不得出现任何 API Key（题目明令禁止提交密钥）', () => {
  const scanDirs = ['data', 'dist', 'public', 'docs'];
  const keyPattern = /sk-[A-Za-z0-9_-]{12,}|FUYAO_API_KEY\s*=\s*["']?sk-/;
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(p);
      } else if (/\.(json|js|md|html|css|txt)$/i.test(entry.name)) {
        const text = fs.readFileSync(p, 'utf8');
        if (keyPattern.test(text)) hits.push(path.relative(ROOT, p));
      }
    }
  };
  for (const d of scanDirs) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs);
  }
  assert.deepEqual(hits, [], `以下文件疑似含密钥：${hits.join(', ')}`);
});

test('.env 必须被 .gitignore 排除，避免密钥被误提交', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /^\.env$/m, '.gitignore 应包含 .env');
});
