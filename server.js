/**
 * server.js —— 零依赖 HTTP 服务（静态资源 + JSON API）
 *
 * 端点：
 *   GET /                        产品页面
 *   GET /api/meta                数据集元信息（来源、口径、生成时间）
 *   GET /api/decisions           决策列表摘要
 *   GET /api/report/:id          完整复盘报告
 *        ?asOf=<ISO>             覆盖决策时点，用于演示「时点闸门」的效果
 *        ?fault=missing|invalid|timeout
 *                                故障注入，用于演示接口异常时的降级路径
 *   GET /api/health              健康检查
 *
 * 设计说明：服务端不缓存数据集，每次请求重新读盘 —— 便于在演示中直接改 data/*.json 看变化。
 * 若追求吞吐可加缓存层，但这会掩盖"数据刚更新"的场景，与本产品的时点意识相冲突。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, listDecisions, buildReport } from './src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT ?? 5173);
// 默认绑定 0.0.0.0：云托管沙箱只注入 PORT，要求服务监听全部网卡才能被反向代理到。
// 纯本地使用时可设 HOST=127.0.0.1 收窄到本机。
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message, extra = {}) {
  // 关键：错误必须结构化返回，前端据此展示"为什么没有结论"，而不是静默给一个默认结论
  sendJson(res, status, { ok: false, error: { code, message, ...extra } });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'FORBIDDEN', '路径越界');
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

/** 故障注入：把"数据源出问题"变成可被产品语义化处理的场景 */
function applyFault(fault) {
  if (fault === 'missing') {
    const e = new Error('数据文件缺失：market.json');
    e.code = 'DATASET_MISSING';
    e.statusCode = 503;
    e.remediation = '请先执行 npm run gen 生成构造数据，或检查 data/ 目录挂载。';
    throw e;
  }
  if (fault === 'invalid') {
    const e = new Error('数据校验未通过：decision D-2024-0311-A 缺少字段 reasoning');
    e.code = 'DATASET_INVALID';
    e.statusCode = 503;
    e.remediation = '请修复该条决策记录后重试；系统不会用残缺数据生成结论。';
    throw e;
  }
  if (fault === 'timeout') {
    const e = new Error('数据源调用超时：index:000300.SH（3000ms）');
    e.code = 'UPSTREAM_TIMEOUT';
    e.statusCode = 503;
    e.remediation = '已重试 2 次仍失败；请稍后重试，本次不产出基准相关结论。';
    throw e;
  }
}

export function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, ts: new Date().toISOString(), uptimeSec: Math.round(process.uptime()) });
    }

    if (pathname.startsWith('/api/')) {
      const fault = url.searchParams.get('fault');
      if (fault) applyFault(fault);

      let dataset;
      try {
        dataset = loadDataset();
      } catch (err) {
        return sendError(res, 503, err.code ?? 'DATASET_ERROR', err.message, { remediation: err.remediation ?? null });
      }

      if (pathname === '/api/meta') {
        return sendJson(res, 200, {
          ok: true,
          meta: dataset.meta,
          counts: {
            decisions: dataset.decisions.length,
            exits: dataset.exits.length,
            marketPoints: dataset.market.length,
            events: dataset.events.length,
          },
          series: [...new Set(dataset.market.map((p) => p.series))].sort(),
        });
      }

      if (pathname === '/api/decisions') {
        return sendJson(res, 200, { ok: true, decisions: listDecisions(dataset), meta: dataset.meta });
      }

      const reportMatch = pathname.match(/^\/api\/report\/([^/]+)$/);
      if (reportMatch) {
        const id = decodeURIComponent(reportMatch[1]);
        const asOf = url.searchParams.get('asOf');
        try {
          const report = buildReport(dataset, id, { asOfOverride: asOf || undefined });
          return sendJson(res, 200, { ok: true, report });
        } catch (err) {
          if (err.code === 'DECISION_NOT_FOUND') {
            return sendError(res, 404, err.code, err.message, { available: err.available });
          }
          return sendError(res, 500, 'REPORT_FAILED', String(err.message));
        }
      }

      return sendError(res, 404, 'NO_SUCH_API', `未知接口：${pathname}`);
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    // 故障注入的错误自带 statusCode，统一按语义化的状态码返回，而不是一律 500
    return sendError(res, err.statusCode ?? 500, err.code ?? 'INTERNAL', String(err.message), {
      remediation: err.remediation ?? null,
    });
  }
}

export function createServer() {
  return http.createServer(requestHandler);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`投资决策复盘与学习 · 服务已启动`);
    console.log(`  本地访问： http://${HOST}:${PORT}`);
    console.log(`  健康检查： http://${HOST}:${PORT}/api/health`);
    console.log(`  故障演示： http://${HOST}:${PORT}/api/report/D-2024-0311-A?fault=missing`);
  });
}
