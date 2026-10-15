/**
 * reasoning.js —— 把"当时的理由"（自然语言）转成可核验的主张
 *
 * 目的：让归因能回答"这句话在决策当时有没有数据支撑"，而不是复述直觉。
 * 做法：关键词 → 指标序列 的显式词典（可审计、可扩展），并标注每个命中是
 *       matcged（找到对应事前数据）/ unmatched（无对应字段，属于不可核验）。
 */

const LEXICON = [
  { term: '估值', series: ['peTtm:', 'pb:'], note: '估值类指标' },
  { term: '低估', series: ['peTtm:', 'pb:'], note: '估值水平判断' },
  { term: '高估', series: ['peTtm:', 'pb:'], note: '估值水平判断' },
  { term: '分位', series: ['peTtm:', 'pb:'], note: '历史分位' },
  // 「市盈率 / 市净率」是个人复盘中最高频的表述，但早期词典只收了「估值」这种概括词，
  // 于是决策 B 原文里那句"市净率只有 0.44 倍"根本没被解析出来 —— 一条本可核验的主张被漏掉了。
  { term: '市净率', series: ['pb:'], note: '市净率' },
  { term: '市盈率', series: ['peTtm:'], note: '市盈率' },
  { term: '动销', series: ['revenueYoy:'], note: '营收同比（代理指标）' },
  { term: '预增', series: ['revenueYoy:'], note: '业绩预增（代理指标）' },
  { term: '业绩', series: ['revenueYoy:', 'netProfitYoy:'], note: '业绩增长' },
  { term: '营收', series: ['revenueYoy:'], note: '营业收入同比' },
  { term: '净利润', series: ['netProfitYoy:'], note: '净利润同比' },
  { term: '毛利率', series: ['grossMargin:'], note: '盈利质量' },
  { term: '净资产收益率', series: ['roe:'], note: '盈利能力' },
  { term: '资产负债率', series: ['assetsDebtRatio:'], note: '杠杆水平' },
  { term: '股息', series: ['dividendYield:'], note: '股息率' },
  { term: '分红', series: ['dividendYield:'], note: '股息率' },
  { term: '不良率', series: ['nplRatio:'], note: '资产质量' },
  { term: '景气', series: ['pmi:'], note: '行业/宏观景气代理' },
  { term: '涨幅', series: ['price:'], note: '价格动量' },
  { term: '回调', series: ['price:'], note: '价格回撤' },
  { term: '趋势', series: ['price:'], note: '价格趋势' },
  { term: '量能', series: ['turnoverRate:'], note: '换手率代理' },
];

/** 绝对化措辞：用于"过度自信"偏差检测 */
export const ABSOLUTE_TERMS = ['一定', '肯定', '必然', '毫无疑问', '绝对', '不可能', '铁定'];

/** 结果导向 / 锚定措辞 */
export const ANCHOR_TERMS = ['回本', '成本价', '解套', '回到成本', '不亏就行', '赚回来'];
export const OUTCOME_TERMS = ['涨了', '跌了', '果然', '早知道', '没想到'];

/**
 * @param {string} text 决策理由原文
 * @param {Array} pitEvidence 事前证据集
 */
export function analyzeReasoning(text, pitEvidence) {
  const src = typeof text === 'string' ? text : '';
  const available = new Set(pitEvidence.map((e) => String(e.series).split(':')[0] + ':'));
  const matchedTerms = [];
  const unmatchedTerms = [];

  for (const entry of LEXICON) {
    if (!src.includes(entry.term)) continue;
    const matched = entry.series.some((s) => available.has(s));
    const record = { term: entry.term, expectSeries: entry.series, note: entry.note, matched };
    if (matched) matchedTerms.push(record);
    else unmatchedTerms.push(record);
  }

  // 把主张挂到具体的事前证据点上，便于 UI 一行行核对。
  // 注意要取"决策时点可得的最新一期"，而不是数组里第一条：
  // 上游点位的顺序不保证按时间排，随手取第一条会让证据引用指向一个随机日期，
  // 表面上仍然渲染正常，但引用是错的 —— 这类问题只能靠"引用必须可核对"这条纪律挡住。
  const claims = matchedTerms.map((t) => {
    const matchedPoints = pitEvidence.filter(
      (e) => t.expectSeries.some((s) => String(e.series).startsWith(s)) && Number.isFinite(e.value),
    );
    const sorted = [...matchedPoints].sort(
      (a, b) => (Date.parse(a.publishedAt ?? a.asOf) || 0) - (Date.parse(b.publishedAt ?? b.asOf) || 0),
    );
    const ev = sorted.at(-1) ?? null;
    return {
      term: t.term,
      series: ev?.series ?? null,
      value: ev?.value ?? null,
      unit: ev?.unit ?? null,
      asOf: ev?.asOf ?? null,
      publishedAt: ev?.publishedAt ?? null,
      source: ev?.source ?? null,
      // 该词项有对应字段，但决策时点拿不到有效值（缺失/被降级剔除）
      degraded: matchedPoints.length === 0,
    };
  });

  return {
    text: src,
    length: src.length,
    matchedTerms,
    unmatchedTerms,
    claims,
    absoluteHits: ABSOLUTE_TERMS.filter((t) => src.includes(t)),
    anchorHits: ANCHOR_TERMS.filter((t) => src.includes(t)),
    outcomeHits: OUTCOME_TERMS.filter((t) => src.includes(t)),
    hasInvalidation: null, // 由 preCommit 补齐
  };
}
