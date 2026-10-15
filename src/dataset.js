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

/**
 * 可切换的数据源。
 *   fixture —— 构造数据集（默认）：确定性、可复现，供自动化测试使用。
 *   real    —— 扶摇真实数据快照：由 scripts/fetch-fuyao.js 拉取后落盘，**不含密钥**。
 *
 * 之所以默认仍是 fixture：测试需要逐字节可复现的输入，
 * 真实数据会随上游修订而变化，不适合作为回归基线。
 */
export const DATA_SOURCES = {
  fixture: {
    dir: 'data',
    label: '构造数据集',
    metaSource: 'synthetic-fixture',
    note: '确定性生成，用于演示与自动化测试。',
  },
  real: {
    dir: 'data/real',
    label: '真实数据（扶摇）',
    metaSource: 'fuyao',
    note: '从扶摇（同花顺金融数据API）拉取的真实行情与财报快照；决策文本为匿名样本，入场/离场价已替换为真实收盘价。',
  },
};

export const DEFAULT_SOURCE = 'fixture';

export function listDataSources() {
  return Object.entries(DATA_SOURCES).map(([id, s]) => {
    const abs = path.resolve(__dirname, '..', s.dir);
    let available = false;
    let pointCount = null;
    try {
      available = REQUIRED_FILES.every((f) => fs.existsSync(path.join(abs, f)));
      if (available) {
        pointCount = JSON.parse(fs.readFileSync(path.join(abs, 'market.json'), 'utf8')).pointCount ?? null;
      }
    } catch {
      available = false;
    }
    return { id, label: s.label, note: s.note, available, pointCount, relDir: s.dir };
  });
}

export function resolveDataDir(source = DEFAULT_SOURCE) {
  const key = source ?? DEFAULT_SOURCE;
  const spec = DATA_SOURCES[key];
  if (!spec) {
    const e = new Error(`未知数据源：${key}（可选：${Object.keys(DATA_SOURCES).join(' / ')}）`);
    e.code = 'DATASET_INVALID';
    e.statusCode = 400;
    throw e;
  }
  return path.resolve(__dirname, '..', spec.dir);
}

/**
 * 载入数据集。
 * @param {string|{source?:string, dataDir?:string}} [arg]
 *        省略 → fixture；字符串 → 视为目录（向后兼容）；对象 → 按 source 解析
 */
export function loadDataset(arg) {
  let dir;
  let sourceId = DEFAULT_SOURCE;
  if (typeof arg === 'string') {
    dir = arg;
    sourceId = null;
  } else if (arg && typeof arg === 'object') {
    if (arg.dataDir) {
      dir = arg.dataDir;
      sourceId = null;
    } else {
      sourceId = arg.source ?? DEFAULT_SOURCE;
      dir = resolveDataDir(sourceId);
    }
  } else {
    dir = resolveDataDir(sourceId);
  }

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
    sourceId,
    dataDir: dir,
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
