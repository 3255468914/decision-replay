/**
 * dataset.js —— 数据加载与校验
 *
 * 支持两种数据来源，通过 meta.source 显式标注，避免"看起来是真数据"的混淆：
 *   - synthetic-fixture : 构造数据（本仓库自带，可复现）
 *   - fuyao / ifind-mcp : 真实接口（需在 .env 中配置 Key；本实现预留适配位）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REQUIRED_FILES = ['decisions.json', 'market.json', 'events.json'];

export function loadDataset(dataDir) {
  const dir = dataDir ?? path.resolve(__dirname, '..', 'data');
  const missing = [];
  const read = (name) => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      missing.push(name);
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      const e = new Error(`数据文件解析失败 ${name}: ${err.message}`);
      e.code = 'DATASET_PARSE_ERROR';
      throw e;
    }
  };

  const decisionsFile = read('decisions.json');
  const marketFile = read('market.json');
  const eventsFile = read('events.json');
  const metaFile = read('meta.json');

  if (missing.length) {
    const e = new Error(`数据文件缺失：${missing.join('、')}`);
    e.code = 'DATASET_MISSING';
    throw e;
  }

  const dataset = {
    meta: metaFile ?? { source: 'synthetic-fixture', generatedAt: null, benchmarkSeries: null },
    decisions: decisionsFile.decisions ?? [],
    exits: decisionsFile.exits ?? [],
    market: marketFile.points ?? [],
    events: eventsFile.events ?? [],
  };

  validateDataset(dataset);
  return dataset;
}

export function validateDataset(ds) {
  const problems = [];
  if (!Array.isArray(ds.decisions) || ds.decisions.length === 0) problems.push('decisions 为空');
  for (const d of ds.decisions) {
    for (const f of ['id', 'symbol', 'action', 'decidedAt', 'reasoning']) {
      if (d[f] === undefined || d[f] === null) problems.push(`decision ${d.id ?? '?'} 缺少字段 ${f}`);
    }
  }
  if (problems.length) {
    const e = new Error(`数据校验未通过：${problems.join('；')}`);
    e.code = 'DATASET_INVALID';
    e.problems = problems;
    throw e;
  }
  return true;
}

/** 决策列表摘要，供前端首页使用 */
export function listDecisions(dataset) {
  return dataset.decisions.map((d) => {
    const exit = dataset.exits.find((e) => e.decisionId === d.id);
    const ret = exit && Number.isFinite(d.price) && d.price !== 0 ? (exit.exitPrice / d.price - 1) * 100 : null;
    return {
      id: d.id,
      symbol: d.symbol,
      name: d.name ?? d.symbol,
      action: d.action,
      decidedAt: d.decidedAt,
      executedAt: d.executedAt ?? null,
      closed: Boolean(exit),
      exitedAt: exit?.exitedAt ?? null,
      returnPct: ret === null ? null : Number(ret.toFixed(2)),
      horizon: d.horizon ?? null,
      tags: d.tags ?? [],
    };
  });
}
