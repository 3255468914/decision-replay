/**
 * pit.js —— Point-In-Time Gate（时点闸门）
 *
 * 这是本题最核心的机制：任何一条证据，只有在其"数据可得时点"(asOf / publishedAt)
 * 不晚于"决策时点"时，才允许进入"事前可知"证据集。
 * 晚于决策时点的内容一律进入"事后信息"分区，并在 UI 上打上「禁止用于归因」标签。
 *
 * 设计原则：
 * 1. 时点缺失 -> 进入 unknown 分区，并上报数据质量问题；绝不猜测为"事前"。
 * 2. 边界取等号：asOf <= decidedAt 视为事前可知（决策时点已经能看到该数据）。
 * 3. 本模块是纯函数，不读文件、不发请求，便于单测覆盖极端边界。
 */

import { parseTime } from './timeutil.js';

export const PIT_BUCKET = {
  EX_ANTE: 'exAnte', // 事前可知
  EX_POST: 'exPost', // 事后信息
  UNKNOWN: 'unknown', // 时点缺失或不可解析
};

/**
 * 按决策时点切分证据集。
 * @param {Array} items 证据条目
 * @param {(item:any)=>string} pickTime 取时间字段
 * @param {string} decidedAt 决策时点
 * @returns {{exAnte:Array, exPost:Array, unknown:Array, issues:Array}}
 */
export function splitByDecisionTime(items, pickTime, decidedAt) {
  const cutoff = parseTime(decidedAt);
  const out = { exAnte: [], exPost: [], unknown: [], issues: [] };

  if (cutoff === null) {
    out.issues.push({
      code: 'DECISION_TIME_UNPARSEABLE',
      level: 'error',
      message: `决策时点无法解析：${JSON.stringify(decidedAt)}；已跳过时点切分，全部证据降级为 unknown。`,
    });
    out.unknown.push(...items.map((i) => ({ ...i, _bucket: PIT_BUCKET.UNKNOWN })));
    return out;
  }

  for (const item of items) {
    const t = parseTime(pickTime(item));
    if (t === null) {
      out.unknown.push({ ...item, _bucket: PIT_BUCKET.UNKNOWN });
      out.issues.push({
        code: 'EVIDENCE_TIME_MISSING',
        level: 'warn',
        ref: item.id ?? item.series ?? null,
        message: `证据缺少可解析的时间字段，无法确认是否为事前信息，已隔离到 unknown 分区。`,
      });
      continue;
    }
    if (t <= cutoff) out.exAnte.push({ ...item, _bucket: PIT_BUCKET.EX_ANTE });
    else out.exPost.push({ ...item, _bucket: PIT_BUCKET.EX_POST });
  }

  return out;
}

/**
 * 把"事前证据"进一步约束到"持有期窗口"，用于事后检验：
 * 只保留 (decidedAt, exitedAt] 区间内产生的信息，标记为后见信息但可用于「事后对照」栏。
 */
export function inHoldingWindow(items, pickTime, decidedAt, exitedAt) {
  const from = parseTime(decidedAt);
  const to = parseTime(exitedAt);
  if (from === null || to === null) return [];
  return items.filter((item) => {
    const t = parseTime(pickTime(item));
    return t !== null && t > from && t <= to;
  });
}
