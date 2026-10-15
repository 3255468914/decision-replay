/**
 * guardrails.js —— 合规与语言护栏
 *
 * 产品红线（题目统一规则）：不得输出确定性涨跌预测、收益承诺或直接买卖建议。
 * 本模块做两件事：
 *   1. sanitizeOutput(text) 扫描并中和违规表述，返回命中的规则（用于审计与测试）
 *   2. assertCompliant(text) 在测试中断言合规
 *
 * 注意：这是"最后一道闸门"，不是唯一防线。上游模板本身也应写成中性表述。
 */

const RULES = [
  {
    code: 'CERTAIN_DIRECTION',
    desc: '确定性涨跌预测',
    patterns: [/必涨/g, /必跌/g, /一定会涨/g, /肯定会跌/g, /稳赚/g, /稳赢/g, /保证收益/g, /百分百/g, /无风险套利/g],
    replacement: '（已移除确定性预测表述）',
  },
  {
    code: 'PROFIT_PROMISE',
    desc: '收益承诺 / 目标价承诺',
    patterns: [/预计涨到\s*\d+/g, /至少赚\s*\d+/g, /年化收益\s*\d+%/g, /包赚/g],
    replacement: '（已移除收益承诺表述）',
  },
  {
    code: 'DIRECT_ADVICE',
    desc: '直接买卖建议',
    patterns: [/建议买入/g, /建议卖出/g, /立刻买/g, /马上卖/g, /推荐买/g, /推荐卖/g, /加仓\s*\d+成/g, /梭哈/g],
    replacement: '（已移除交易指令表述）',
  },
  {
    code: 'POSITION_ADVICE',
    desc: '仓位建议',
    patterns: [/建议仓位\s*\d+/g, /仓位建议/g, /建议\s*\d+成仓/g],
    replacement: '（已移除仓位建议表述）',
  },
];

/**
 * @returns {{clean:string, hits:Array<{code:string,desc:string,match:string}>}}
 */
export function sanitizeOutput(text) {
  if (typeof text !== 'string') return { clean: text, hits: [] };
  let clean = text;
  const hits = [];
  for (const rule of RULES) {
    for (const re of rule.patterns) {
      const found = clean.match(re);
      if (found) {
        for (const m of found) hits.push({ code: rule.code, desc: rule.desc, match: m });
        clean = clean.replace(re, rule.replacement);
      }
    }
  }
  return { clean, hits };
}

/**
 * 递归清洗对象里所有字符串字段。
 * 用法：const acc = { hits: [] }; const clean = sanitizeDeep(obj, '$', acc); acc.hits 为命中记录。
 */
export function sanitizeDeep(node, path = '$', acc = { hits: [] }) {
  if (typeof node === 'string') {
    const r = sanitizeOutput(node);
    acc.hits.push(...r.hits.map((h) => ({ ...h, path })));
    return r.clean;
  }
  if (Array.isArray(node)) {
    return node.map((v, i) => sanitizeDeep(v, `${path}[${i}]`, acc));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = sanitizeDeep(v, `${path}.${k}`, acc);
    return out;
  }
  return node;
}

/** 供测试使用：命中即抛错 */
export function assertCompliant(text) {
  const { hits } = sanitizeOutput(text);
  if (hits.length > 0) {
    throw new Error(`合规校验失败，命中规则：${hits.map((h) => `${h.code}("${h.match}")`).join(', ')}`);
  }
  return true;
}

export const COMPLIANCE_DISCLAIMER =
  '本页面仅用于个人决策过程的复盘与学习，输出的是历史事实、可复核的拆解与结构化反思，' +
  '不含对未来涨跌的预测、不构成收益承诺、不构成任何投资建议。';
