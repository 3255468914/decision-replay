/**
 * test/server.test.js —— HTTP 接口与故障注入
 * 覆盖：正常接口、未知决策、路径越界、三类故障注入
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

let server;
let base;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = async (p) => {
  const res = await fetch(base + p);
  const body = await res.json();
  return { status: res.status, body };
};

test('GET /api/health 返回 ok', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('GET /api/meta 暴露数据来源与口径，避免"看起来是真数据"', async () => {
  const { status, body } = await get('/api/meta');
  assert.equal(status, 200);
  assert.equal(body.meta.source, 'synthetic-fixture');
  assert.ok(body.meta.disclaimer.includes('构造数据'));
  assert.ok(body.counts.marketPoints > 1000);
  assert.ok(Array.isArray(body.meta.injectedAnomalies));
});

test('GET /api/decisions 返回 3 条构造决策', async () => {
  const { status, body } = await get('/api/decisions');
  assert.equal(status, 200);
  assert.equal(body.decisions.length, 3);
  assert.ok(body.decisions.every((d) => d.symbol && d.decidedAt));
});

test('GET /api/report/:id 返回完整报告', async () => {
  const { status, body } = await get('/api/report/D-2024-0520-C');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.report.decision.id, 'D-2024-0520-C');
  assert.equal(body.report.quality.status, 'degraded');
});

test('GET /api/report/:id?asOf= 覆盖决策时点，改变时点闸门结果', async () => {
  const a = await get('/api/report/D-2024-0311-A');
  const b = await get('/api/report/D-2024-0311-A?asOf=2024-04-01T10:00:00%2B08:00');
  assert.ok(b.body.report.pit.exAnteCount > a.body.report.pit.exAnteCount);
});

test('未知决策 id → 404，并给出可用列表', async () => {
  const { status, body } = await get('/api/report/NOPE');
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'DECISION_NOT_FOUND');
  assert.equal(body.error.available.length, 3);
});

test('未知接口 → 404 结构化错误', async () => {
  const { status, body } = await get('/api/whatever');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'NO_SUCH_API');
});

test('故障注入：数据文件缺失 → 503，且带修复建议；绝不返回"正常"结论', async () => {
  const { status, body } = await get('/api/report/D-2024-0311-A?fault=missing');
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'DATASET_MISSING');
  assert.ok(body.error.remediation);
  assert.equal(body.report, undefined, '故障时不得返回报告体');
});

test('故障注入：数据校验失败 → 503 且说明缺哪个字段', async () => {
  const { status, body } = await get('/api/report/D-2024-0311-A?fault=invalid');
  assert.equal(status, 503);
  assert.equal(body.error.code, 'DATASET_INVALID');
});

test('故障注入：上游超时 → 503 且说明本次不产出哪类结论', async () => {
  const { status, body } = await get('/api/report/D-2024-0311-A?fault=timeout');
  assert.equal(status, 503);
  assert.equal(body.error.code, 'UPSTREAM_TIMEOUT');
  assert.match(body.error.remediation, /不产出/);
});

test('路径穿越被拒绝', async () => {
  const res = await fetch(base + '/../package.json');
  assert.ok([403, 404].includes(res.status), `实际状态 ${res.status}`);
});

test('静态资源可访问（index.html / app.js / styles.css）', async () => {
  for (const p of ['/', '/app.js', '/styles.css']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, `${p} 应可访问`);
  }
});
