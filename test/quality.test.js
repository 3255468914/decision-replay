/**
 * test/quality.test.js —— 数据质量与降级
 * 覆盖：缺失值、同点冲突、过期、来源失败、来源缺失、无证据阻断
 * 核心断言：任何异常都不能导致"静默生成正常结论"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQuality, filterUsablePoints, QUALITY_CODE, loadDataset, buildReport } from '../src/index.js';

const CUT = '2024-05-20T13:45:00+08:00';

test('缺失值被识别为 MISSING_VALUE（warn），不会当作 0', () => {
  const q = checkQuality([{ series: 'x:1', asOf: '2024-05-17T15:00:00+08:00', publishedAt: '2024-05-17T15:00:00+08:00', value: null, source: 's' }], { asOfCutoff: CUT });
  assert.ok(q.issues.some((i) => i.code === QUALITY_CODE.MISSING_VALUE));
  assert.equal(q.status, 'degraded');
});

test('同一序列同一时点的两个不同取值被识别为 CONFLICT（error）', () => {
  const pts = [
    { series: 'price:1', asOf: '2024-05-17T15:00:00+08:00', publishedAt: '2024-05-17T15:00:00+08:00', value: 10, source: 'A' },
    { series: 'price:1', asOf: '2024-05-17T15:00:00+08:00', publishedAt: '2024-05-17T15:00:00+08:00', value: 11, source: 'B' },
  ];
  const q = checkQuality(pts, { asOfCutoff: CUT });
  const conflict = q.issues.find((i) => i.code === QUALITY_CODE.CONFLICT);
  assert.ok(conflict, '应识别出冲突');
  assert.equal(conflict.severity, 'error');
  assert.equal(q.status, 'degraded');

  // 冲突点必须被剔除，而不是任取一个
  const { points, removed } = filterUsablePoints(pts, q.issues);
  assert.equal(removed.length, 2);
  assert.equal(points.length, 0);
});

test('过期判定只看"决策时点可得的最新一期"，不对历史点逐个告警', () => {
  const pts = [];
  for (let i = 0; i < 30; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    pts.push({ series: 'price:1', asOf: `2024-04-${day}T15:00:00+08:00`, publishedAt: `2024-04-${day}T15:00:00+08:00`, value: i, source: 's' });
  }
  const q = checkQuality(pts, { asOfCutoff: CUT, staleDays: 7 });
  const stale = q.issues.filter((i) => i.code === QUALITY_CODE.STALE);
  assert.equal(stale.length, 1, `同一序列最多产生 1 条过期告警，实际 ${stale.length}`);
});

test('按序列前缀区分过期阈值：月频 PMI 不应套用日频的 7 天阈值', () => {
  const pmi = { series: 'pmi:CN', asOf: '2024-04-30T15:00:00+08:00', publishedAt: '2024-05-02T09:00:00+08:00', value: 50, source: 's' };
  const withDefault = checkQuality([pmi], { asOfCutoff: CUT, staleDays: 7 });
  assert.equal(withDefault.issues.filter((i) => i.code === QUALITY_CODE.STALE).length, 1);
  const withOverride = checkQuality([pmi], { asOfCutoff: CUT, staleDays: 7, staleness: { 'pmi:': 40 } });
  assert.equal(withOverride.issues.filter((i) => i.code === QUALITY_CODE.STALE).length, 0);
});

test('数据源调用失败被标记为 SOURCE_FAILED 且不参与计算', () => {
  const bad = { series: 'turnoverRate:1', asOf: '2024-05-17T15:00:00+08:00', publishedAt: '2024-05-17T15:00:00+08:00', value: 1.6, source: 's', sourceError: 'HTTP 503' };
  const q = checkQuality([bad], { asOfCutoff: CUT });
  assert.ok(q.issues.some((i) => i.code === QUALITY_CODE.SOURCE_FAILED));
  const { points } = filterUsablePoints([bad], q.issues);
  assert.equal(points.length, 0);
});

test('完全无证据时必须 blocked，而不是输出空结论当作"正常"', () => {
  const q = checkQuality([], { asOfCutoff: CUT });
  assert.equal(q.status, 'blocked');
  assert.ok(q.issues.some((i) => i.code === QUALITY_CODE.NO_EVIDENCE));
  assert.match(q.banner, /阻断/);
});

test('端到端：含异常样本的决策报告必须是 degraded，且异常均被显式列出', () => {
  const ds = loadDataset();
  const r = buildReport(ds, 'D-2024-0520-C');
  assert.equal(r.quality.status, 'degraded');
  const codes = r.quality.issues.map((i) => i.code);
  assert.ok(codes.includes(QUALITY_CODE.MISSING_VALUE), '应报出缺失值');
  assert.ok(codes.includes(QUALITY_CODE.CONFLICT), '应报出冲突');
  assert.ok(codes.includes(QUALITY_CODE.SOURCE_FAILED), '应报出接口失败');
  assert.ok(r.quality.removedPoints.length >= 3, '被剔除的数据点必须留档');
  assert.ok(r.quality.banner, '降级必须给出面向用户的说明');
});

test('端到端：干净数据不得被误判为降级', () => {
  const ds = loadDataset();
  const r = buildReport(ds, 'D-2024-0311-A');
  assert.equal(r.quality.status, 'ok');
  assert.equal(r.quality.banner, null);
});
