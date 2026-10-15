/**
 * test/pit.test.js —— 时点闸门（本题最核心的机制）
 * 覆盖：边界取等号、时点缺失、时点不可解析、决策时点被覆盖时的后果
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitByDecisionTime, PIT_BUCKET, loadDataset, buildReport } from '../src/index.js';

const items = [
  { id: 'A', t: '2024-03-11T14:19:59+08:00' },
  { id: 'B', t: '2024-03-11T14:20:00+08:00' }, // 与决策时点完全相同
  { id: 'C', t: '2024-03-11T14:20:01+08:00' },
  { id: 'D', t: null },
  { id: 'E', t: 'not-a-date' },
];

test('边界：与决策时点完全相同的证据算作「事前可知」', () => {
  const r = splitByDecisionTime(items, (i) => i.t, '2024-03-11T14:20:00+08:00');
  assert.deepEqual(
    r.exAnte.map((i) => i.id),
    ['A', 'B'],
  );
  assert.deepEqual(
    r.exPost.map((i) => i.id),
    ['C'],
  );
});

test('时点缺失或不可解析的证据进入 unknown，不得被当作事前信息', () => {
  const r = splitByDecisionTime(items, (i) => i.t, '2024-03-11T14:20:00+08:00');
  assert.deepEqual(
    r.unknown.map((i) => i.id),
    ['D', 'E'],
  );
  assert.equal(r.issues.filter((i) => i.code === 'EVIDENCE_TIME_MISSING').length, 2);
  // unknown 分区不允许泄漏进 exAnte
  assert.equal(r.exAnte.some((i) => i.id === 'D' || i.id === 'E'), false);
});

test('决策时点不可解析时，全部证据降级为 unknown 并上报 error', () => {
  const r = splitByDecisionTime(items, (i) => i.t, 'garbage');
  assert.equal(r.exAnte.length, 0);
  assert.equal(r.exPost.length, 0);
  assert.equal(r.unknown.length, items.length);
  assert.equal(r.issues[0].code, 'DECISION_TIME_UNPARSEABLE');
  assert.equal(r.issues[0].level, 'error');
});

test('主链路：当日收盘价（15:00）不得成为 14:20 决策的事前证据', () => {
  const ds = loadDataset();
  const r = buildReport(ds, 'D-2024-0311-A');
  const sameDayClose = r.exAnteEvidence.find(
    (e) => e.series === 'price:600519.SH' && String(e.asOf).startsWith('2024-03-11'),
  );
  assert.equal(sameDayClose, undefined, '决策时点之后的当日收盘价不应出现在事前证据中');

  const prevClose = r.exAnteEvidence
    .filter((e) => e.series === 'price:600519.SH')
    .map((e) => e.asOf)
    .sort()
    .at(-1);
  assert.ok(prevClose.startsWith('2024-03-08'), `事前最新收盘应为 2024-03-08，实际 ${prevClose}`);
});

test('把决策时点后移会让原本「事后」的证据被纳入「事前」分区', () => {
  const ds = loadDataset();
  const base = buildReport(ds, 'D-2024-0311-A');
  const shifted = buildReport(ds, 'D-2024-0311-A', { asOfOverride: '2024-04-01T10:00:00+08:00' });
  assert.ok(shifted.pit.exAnteCount > base.pit.exAnteCount, '后移决策时点应能纳入更多事前证据');
  assert.ok(shifted.pit.exPostCount < base.pit.exPostCount, '原先的事后证据应相应减少——信息是从「事后」迁入「事前」');
  assert.ok(shifted.pit.eventExAnteCount >= base.pit.eventExAnteCount, '原本的事后事件应被重新纳为事前');
});

test('披露时滞：2023 年报的数据点在 2024-01-08 决策时不可得', () => {
  const ds = loadDataset();
  const r = buildReport(ds, 'D-2024-0108-B');
  const npl = r.exAnteEvidence.filter((e) => e.series === 'nplRatio:000001.SZ');
  assert.ok(npl.length > 0, '应有可得的历史期数据');
  for (const p of npl) {
    assert.ok(Date.parse(p.publishedAt) <= Date.parse(r.asOfDecisionTime), '事前证据的可得时点必须不晚于决策时点');
    assert.ok(!String(p.asOf).startsWith('2023-12-31'), 'asOf=2023-12-31 的年报在 2024-01-08 尚未披露，不应进入事前证据');
  }
});
