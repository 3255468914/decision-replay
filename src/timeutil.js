/**
 * 时间工具：统一用毫秒时间戳做比较，避免字符串比较带来的时区/格式陷阱。
 * 约定：所有时间字段使用带时区偏移的 ISO 8601 字符串，例如 "2024-03-11T14:20:00+08:00"。
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 解析时间；无法解析返回 null（调用方必须显式处理，不允许静默当"现在"） */
export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function daysBetween(a, b) {
  const ta = parseTime(a);
  const tb = parseTime(b);
  if (ta === null || tb === null) return null;
  return Math.round((tb - ta) / DAY_MS);
}

/** 是否为交易日：仅排除周六周日。节假日简化处理，已在 README「已知边界」中说明。 */
export function isTradingDay(dateStr) {
  const d = new Date(dateStr);
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6;
}

export function formatDate(ts, tz = 'Asia/Shanghai') {
  const t = parseTime(ts);
  if (t === null) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(t));
}

export function formatDateTime(ts, tz = 'Asia/Shanghai') {
  const t = parseTime(ts);
  if (t === null) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(t));
}
