/**
 * adapters/fuyao.js —— 扶摇（同花顺金融数据 API）客户端
 *
 * 设计要点（都是实测踩出来的，不是照文档抄的）：
 *   1. 鉴权头是 `X-api-key`。用 `Authorization: Bearer` 会返回 code=2003「Missing X-api-key」，
 *      注意它是 HTTP 200 + 业务错误码，不是 401 —— 只看 HTTP 状态码会误判为成功。
 *   2. 所有业务结果（含错误）走 HTTP 200 + 信封 {code,message,request_id,data}；
 *      但**并非总是**如此：参数含未编码的中文会返回 Tomcat 的 HTML 400 页面。
 *      所以解析前必须先判断响应体是不是 JSON。
 *   3. code=3002（数据未就绪）不是故障，是"这个时点真的没有数据"，调用方拿 null 继续。
 *   4. code=4001 与 HTTP 429 是限流，可退避重试；5002/5003 是上游抖动，同样可重试。
 *   5. 每次请求的 request_id 都进 trace，供落盘时保留取数凭证（可追溯性）。
 *
 * 零依赖：使用 Node 18+ 内置 fetch。
 */

const DEFAULT_BASE = 'https://fuyao.aicubes.cn';
const DEFAULT_TIMEOUT_MS = 20_000;

/** 业务码 → 领域错误码。区分"可重试"与"不可重试"，避免对参数错误做无意义重试。 */
export const BIZ_CODE_MAP = {
  1001: { code: 'PARAM_MISSING', retryable: false, message: '缺少必填参数' },
  1002: { code: 'PARAM_INVALID', retryable: false, message: '参数格式错误' },
  1003: { code: 'PARAM_OUT_OF_RANGE', retryable: false, message: '参数取值越界或窗口超限' },
  1004: { code: 'PARAM_CONFLICT', retryable: false, message: '参数冲突（区间模式与 limit 互斥）' },
  2001: { code: 'AUTH_MISSING', retryable: false, message: '未认证：X-api-key 缺失或无效' },
  2003: { code: 'AUTH_FORBIDDEN', retryable: false, message: '权限不足：该 Key 无权调用此能力' },
  3001: { code: 'SYMBOL_NOT_FOUND', retryable: false, message: '标的不存在' },
  3002: { code: 'DATA_NOT_READY', retryable: false, message: '标的存在但暂无可用数据' },
  3004: { code: 'CAPABILITY_UNSUPPORTED', retryable: false, message: '该标的类型不支持此能力' },
  4001: { code: 'RATE_LIMITED', retryable: true, message: '触发限流' },
  5001: { code: 'UPSTREAM_ERROR', retryable: true, message: '上游服务内部错误' },
  5002: { code: 'UPSTREAM_TIMEOUT', retryable: true, message: '上游服务超时' },
  5003: { code: 'UPSTREAM_UNAVAILABLE', retryable: true, message: '上游服务不可用或响应不符合契约' },
  404: { code: 'ROUTE_NOT_FOUND', retryable: false, message: '路由不存在（文档与实现不一致）' },
};

export class FuyaoError extends Error {
  constructor(message, { code, bizCode = null, requestId = null, retryable = false, remediation = null, status = null } = {}) {
    super(message);
    this.name = 'FuyaoError';
    this.code = code ?? 'UPSTREAM_ERROR';
    this.bizCode = bizCode;
    this.requestId = requestId;
    this.retryable = retryable;
    this.remediation = remediation;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把业务码翻译成 FuyaoError；3002 之外的非 0 码都算失败 */
function toError(envelope, status) {
  const bizCode = envelope?.code;
  const mapped = BIZ_CODE_MAP[bizCode] ?? {
    code: 'UPSTREAM_UNKNOWN',
    retryable: false,
    message: '未登记的业务错误码',
  };
  return new FuyaoError(
    `扶摇接口返回 code=${bizCode}：${envelope?.message ?? mapped.message}`,
    {
      code: mapped.code,
      bizCode,
      requestId: envelope?.request_id ?? null,
      retryable: mapped.retryable,
      status,
      remediation:
        mapped.code === 'AUTH_MISSING'
          ? '检查 .env 中的 FUYAO_API_KEY 是否已配置且有效。'
          : mapped.code === 'AUTH_FORBIDDEN'
            ? '该 API Key 无权调用此能力，请在扶摇控制台确认能力授权。'
            : mapped.code === 'RATE_LIMITED'
              ? '已触发限流，请降低并发或稍后重试。'
              : null,
    },
  );
}

export function createFuyaoClient(options = {}) {
  const {
    apiKey = process.env.FUYAO_API_KEY ?? '',
    baseUrl = process.env.FUYAO_API_BASE ?? DEFAULT_BASE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = 3,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    trace = [],
  } = options;

  if (!apiKey) {
    throw new FuyaoError('未配置 FUYAO_API_KEY', {
      code: 'AUTH_MISSING',
      remediation: '在 .env 中设置 FUYAO_API_KEY（该文件已被 .gitignore 排除）。',
    });
  }

  let callCount = 0;

  /**
   * 发一次请求并解析信封。
   * @param {string} path 形如 /api/a-share/prices/historical
   * @param {object} params 查询参数（null/undefined/'' 会被丢弃）
   * @param {{allowNotReady?: boolean}} opts
   */
  async function request(path, params = {}, opts = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      callCount += 1;
      const startedAt = Date.now();
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { 'X-api-key': apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // 网络层失败（DNS/超时/连接被拒）——一律可重试
        lastErr = new FuyaoError(`扶摇请求失败：${err.message}`, {
          code: err.name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR',
          retryable: true,
        });
        trace.push({ path, attempt, ok: false, code: lastErr.code, elapsedMs: Date.now() - startedAt });
        if (attempt < maxRetries) {
          await sleepImpl(400 * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }

      const raw = await res.text();
      let envelope = null;
      try {
        envelope = JSON.parse(raw);
      } catch {
        // 实测：参数含未编码中文时返回 Tomcat 的 HTML 400 页面，而不是约定的信封。
        // 这里必须显式识别，否则会被当成"解析失败"而掩盖真实原因。
        const snippet = raw.slice(0, 140).replace(/\s+/g, ' ');
        lastErr = new FuyaoError(`扶摇返回非 JSON 响应（HTTP ${res.status}）：${snippet}`, {
          code: 'RESPONSE_NOT_JSON',
          status: res.status,
          retryable: false,
          remediation: '检查查询参数是否含未 URL 编码的非 ASCII 字符。',
        });
        trace.push({ path, attempt, ok: false, code: lastErr.code, status: res.status, elapsedMs: Date.now() - startedAt });
        throw lastErr;
      }

      const requestId = envelope?.request_id ?? null;

      if (res.status === 429 || envelope?.code === 4001) {
        lastErr = toError(envelope ?? { code: 4001, message: 'rate limited' }, res.status);
        trace.push({ path, attempt, ok: false, code: 'RATE_LIMITED', requestId, status: res.status, elapsedMs: Date.now() - startedAt });
        if (attempt < maxRetries) {
          await sleepImpl(600 * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }

      if (envelope?.code === 0) {
        trace.push({ path, attempt, ok: true, requestId, status: res.status, elapsedMs: Date.now() - startedAt });
        return { data: envelope.data ?? null, requestId, envelope };
      }

      // 数据未就绪不是故障：调用方拿到 null 走"当期无数据"分支
      if (envelope?.code === 3002 && opts.allowNotReady) {
        trace.push({ path, attempt, ok: true, code: 'DATA_NOT_READY', requestId, status: res.status, elapsedMs: Date.now() - startedAt });
        return { data: null, requestId, envelope };
      }

      const err = toError(envelope, res.status);
      trace.push({ path, attempt, ok: false, code: err.code, bizCode: err.bizCode, requestId, status: res.status, elapsedMs: Date.now() - startedAt });
      if (err.retryable && attempt < maxRetries) {
        lastErr = err;
        await sleepImpl(600 * 2 ** attempt);
        continue;
      }
      throw err;
    }
    throw lastErr ?? new FuyaoError('扶摇请求失败（无更多重试）', { code: 'UPSTREAM_ERROR' });
  }

  return {
    baseUrl,
    trace,
    get callCount() {
      return callCount;
    },
    request,

    /** 行情快照：批量按 thscodes 取，返回数组 */
    async snapshotPrices(thscodes) {
      const list = Array.isArray(thscodes) ? thscodes.join(',') : String(thscodes);
      const { data, requestId } = await request('/api/a-share/prices/snapshot', { thscodes: list }, { allowNotReady: true });
      return { items: data?.item ?? [], asOfMs: data?.timestamp ?? null, requestId };
    },

    /** 历史日 K：接口层强约束单只标的、窗口 ≤10 年 */
    async historicalPrices(thscode, startMs, endMs, adjust = 'forward') {
      const { data, requestId } = await request(
        '/api/a-share/prices/historical',
        { thscode, interval: '1d', start: startMs, end: endMs, adjust },
        { allowNotReady: true },
      );
      return { bars: data?.item ?? [], asOfMs: data?.timestamp ?? null, requestId };
    },

    /** 利润表 / 资产负债表 / 现金流量表：三接口入参契约一致 */
    async statements(kind, thscode, { period = 'quarterly', limit, start, end } = {}) {
      const path = `/api/a-share/financials/${kind}`;
      const { data, requestId } = await request(path, { thscode, period, limit, start, end }, { allowNotReady: true });
      return { items: data?.item ?? [], requestId };
    },

    /** 财务指标：report 形如 '2023-3'（1 一季报 / 2 中报 / 3 三季报 / 4 年报） */
    async indicators(thscode, report) {
      const { data, requestId } = await request(
        '/api/a-share/financials/indicators',
        { thscode, report },
        { allowNotReady: true },
      );
      return { abilities: data?.abilities ?? [], requestId };
    },
  };
}
