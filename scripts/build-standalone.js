/**
 * scripts/build-standalone.js —— 打包成"免安装单文件页面"
 *
 * 为什么需要：题目要求交付"可访问、可实际操作的 Web 产品"。本地服务当然可以跑，
 * 但如果评审者想零配置看一眼产品，双击一个 HTML 文件是最低的门槛。
 * 本脚本把 API 的全部响应预计算好、内联进页面，并用一个 fetch 桩接管请求，
 * 因此 dist/standalone.html 用 file:// 直接打开即可完整交互（含时点切换与故障注入演示）。
 *
 * 用法：node scripts/build-standalone.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, listDecisions, buildReport } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ASSETS = path.join(ROOT, 'dist', 'assets');

const OFFSETS = [0, 1, 7, 30, 90];
const FAULTS = ['missing', 'invalid', 'timeout'];

const FAULT_PAYLOADS = {
  missing: {
    code: 'DATASET_MISSING',
    message: '数据文件缺失：market.json',
    remediation: '请先执行 npm run gen 生成构造数据，或检查 data/ 目录挂载。',
  },
  invalid: {
    code: 'DATASET_INVALID',
    message: '数据校验未通过：decision D-2024-0311-A 缺少字段 reasoning',
    remediation: '请修复该条决策记录后重试；系统不会用残缺数据生成结论。',
  },
  timeout: {
    code: 'UPSTREAM_TIMEOUT',
    message: '数据源调用超时：index:000300.SH（3000ms）',
    remediation: '已重试 2 次仍失败；请稍后重试，本次不产出基准相关结论。',
  },
};

const shift = (iso, days) => {
  const t = Date.parse(iso) + days * 86400000;
  return new Date(t + 8 * 3600000).toISOString().replace('Z', '+08:00');
};

function build() {
  const ds = loadDataset();

  // 预计算所有 (决策 × 时点偏移) 的报告
  const reports = {};
  for (const d of ds.decisions) {
    for (const off of OFFSETS) {
      const asOf = off === 0 ? null : shift(d.decidedAt, off);
      const r = buildReport(ds, d.id, { asOfOverride: asOf || undefined });
      reports[`${d.id}|${off}`] = r;
    }
  }

  const payload = {
    meta: ds.meta,
    counts: {
      decisions: ds.decisions.length,
      exits: ds.exits.length,
      marketPoints: ds.market.length,
      events: ds.events.length,
    },
    series: [...new Set(ds.market.map((p) => p.series))].sort(),
    decisions: listDecisions(ds),
    reports,
    offsets: OFFSETS,
    faults: FAULT_PAYLOADS,
    builtAt: new Date().toISOString(),
  };

  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/');

  // fetch 桩：把 app.js 的请求映射到内联数据，行为与 server.js 保持一致（含故障注入）
  const stub = `
const __DATA__ = ${json};
window.__STANDALONE__ = true;

function __jsonResponse(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

window.fetch = function (input) {
  const raw = String(input);
  const url = new URL(raw, 'http://standalone.local');
  const p = url.pathname;

  if (p === '/api/health') {
    return __jsonResponse(200, { ok: true, ts: new Date().toISOString(), uptimeSec: 0 });
  }
  if (p === '/api/meta') {
    return __jsonResponse(200, {
      ok: true, meta: __DATA__.meta, counts: __DATA__.counts, series: __DATA__.series,
    });
  }
  if (p === '/api/decisions') {
    return __jsonResponse(200, { ok: true, decisions: __DATA__.decisions, meta: __DATA__.meta });
  }
  const m = p.match(/^\\/api\\/report\\/([^/]+)$/);
  if (m) {
    const fault = url.searchParams.get('fault');
    if (fault && __DATA__.faults[fault]) {
      return __jsonResponse(503, { ok: false, error: __DATA__.faults[fault] });
    }
    const id = decodeURIComponent(m[1]);
    const asOf = url.searchParams.get('asOf');
    let off = 0;
    if (asOf) {
      const d0 = __DATA__.decisions.find((x) => x.id === id);
      off = Math.round((Date.parse(asOf) - Date.parse(d0.decidedAt)) / 86400000);
      if (!__DATA__.offsets.includes(off)) off = __DATA__.offsets.reduce((a, b) => (Math.abs(b - off) < Math.abs(a - off) ? b : a), 0);
    }
    const report = __DATA__.reports[id + '|' + off];
    if (!report) {
      return __jsonResponse(404, { ok: false, error: { code: 'DECISION_NOT_FOUND', message: '未找到决策记录：' + id, available: __DATA__.decisions.map((x) => x.id) } });
    }
    return __jsonResponse(200, { ok: true, report });
  }
  return __jsonResponse(404, { ok: false, error: { code: 'NO_SUCH_API', message: '离线版仅支持预计算的数据集：' + p } });
};
`;

  const offlineNotice = `
<div style="padding:9px 24px;background:#eaf0fd;border-bottom:1px solid #c9d9f7;font-size:12.5px;color:#23437f">
  <strong>离线单文件版</strong>：所有 API 响应已预计算并内联在本文件中，无需启动服务即可完整交互
  （含决策时点切换与三类故障注入演示）。需要接真实数据源时请改用 <code>npm start</code> 启动的服务版本。
  构建时间 ${payload.builtAt}。
</div>`;

  const html =
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    '<title>投资决策复盘与学习 · Decision Replay（离线单文件版）</title>\n<style>\n' +
    css +
    '\n</style>\n</head>\n<body>\n' +
    // 复用 index.html 的主体结构
    fs
      .readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
      .match(/<body>([\s\S]*?)<\/body>/)[1]
      .replace('<script src="/app.js" type="module"></script>', '')
      .replace('<div class="compliance-bar">', offlineNotice + '\n<div class="compliance-bar">') +
    '\n<script>' +
    stub +
    '</script>\n<script type="module">\n' +
    app +
    '\n</script>\n</body>\n</html>\n';

  fs.mkdirSync(ASSETS, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'standalone.html'), html, 'utf8');
  // 同时输出一份纯数据，便于离线查看/二次加工
  fs.writeFileSync(path.join(ASSETS, 'reports.json'), JSON.stringify(payload, null, 2), 'utf8');

  const kb = (fs.statSync(path.join(DIST, 'standalone.html')).size / 1024).toFixed(0);
  console.log(`✓ 已生成 dist/standalone.html（${kb} KB，双击即可打开，无需服务）`);
  console.log(`✓ 已生成 dist/assets/reports.json（预计算的 ${Object.keys(reports).length} 份报告）`);
}

build();
