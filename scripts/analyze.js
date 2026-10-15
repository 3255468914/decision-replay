/**
 * scripts/analyze.js —— 命令行跑一遍完整复盘，输出到终端并落盘 JSON/Markdown
 *
 * 用法：
 *   node scripts/analyze.js                     # 跑全部决策，生成 out/ 下的报告（默认构造数据集）
 *   node scripts/analyze.js D-2024-0311-A       # 只跑指定决策
 *   node scripts/analyze.js D-2024-0311-A --as-of 2024-03-15T09:00:00+08:00
 *                                               # 把决策时点往后挪，直观看到"时点闸门"的后果
 *   node scripts/analyze.js --source real        # 用扶摇真实数据快照跑（需先 npm run fetch:fuyao）
 *   node scripts/analyze.js --source real --out docs/samples/real
 *   node scripts/analyze.js --fault              # 注入故障：数据文件缺失，验证降级路径
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, listDecisions, buildReport } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

function parseArgs(argv) {
  const args = { id: null, asOf: null, fault: false, json: false, source: null, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--as-of') args.asOf = argv[++i];
    else if (a === '--fault') args.fault = true;
    else if (a === '--json') args.json = true;
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--out') args.outDir = argv[++i];
    else if (!a.startsWith('--')) args.id = a;
  }
  return args;
}

function md(report) {
  const L = [];
  const q = report.quality;
  L.push(`# 复盘报告｜${report.decision.name}（${report.symbol}）`);
  L.push('');
  L.push(`- 决策时点：${report.asOfDecisionTime}`);
  L.push(`- 决策时点闸门：事前可得 ${report.pit.exAnteCount} 个行情点 / 事后 ${report.pit.exPostCount} 个行情点；事件 事前 ${report.pit.eventExAnteCount} / 事后 ${report.pit.eventExPostCount}；时点缺失 ${report.pit.unknownCount}`);
  L.push(`- 数据状态：**${q.status}**${q.banner ? ` —— ${q.banner}` : ''}`);
  L.push('');
  L.push(`> ${report.summary.headline}`);
  L.push('');
  L.push(`## 1. 事实（可回到原始字段）`);
  L.push('');
  L.push('| 项 | 值 | 单位 | 来源 | 口径 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const f of report.facts) {
    L.push(`| ${f.label} | ${f.value} | ${f.unit} | ${f.source} | ${f.caliber ?? '—'} |`);
  }
  L.push('');
  L.push(`## 2. 归因（带置信度与反事实检验）`);
  L.push('');
  for (const a of report.attribution) {
    L.push(`### ${a.title}｜置信度 ${a.confidence}`);
    L.push('');
    L.push(a.statement);
    L.push('');
    L.push(`- 依据置信度的原因：${a.confidenceReason}`);
    L.push(`- ${a.counterCheck}`);
    L.push(`- 证据引用：${a.evidenceRefs.join(', ')}`);
    L.push('');
  }
  L.push(`## 3. 行为偏差（触发 / 未触发都列出）`);
  L.push('');
  L.push('| 规则 | 状态 | 说明 |');
  L.push('| --- | --- | --- |');
  for (const b of report.biases) {
    const st = b.triggered === true ? '✅ 触发' : b.triggered === false ? '— 未触发' : '⚠️ 未判定';
    L.push(`| ${b.name} | ${st} | ${String(b.explanation).replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  L.push(`## 4. 不确定与数据限制`);
  L.push('');
  for (const u of report.uncertainty) L.push(`- **${u.title}**：${u.statement}`);
  L.push('');
  L.push(`## 5. 沉淀：清单 / 提醒 / 下一次决策上下文`);
  L.push('');
  for (const l of report.learnings) L.push(`- [ ] ${l.text}`);
  L.push('');
  for (const r of report.reminders) L.push(`- ⚑ ${r.text}`);
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(report.nextContext, null, 2));
  L.push('```');
  L.push('');
  L.push('---');
  L.push('');
  L.push(report.compliance.disclaimer);
  if (report.compliance.sanitizeHits.length) {
    L.push('');
    L.push(`> 合规清洗命中 ${report.compliance.sanitizeHits.length} 处，已中性化。`);
  }
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.outDir ? path.resolve(args.outDir) : OUT;
  fs.mkdirSync(outDir, { recursive: true });

  let dataset;
  try {
    if (args.fault) {
      dataset = loadDataset(path.join(outDir, '__missing_dir_for_fault_test__'));
    } else {
      dataset = loadDataset(args.source ? { source: args.source } : undefined);
    }
  } catch (err) {
    console.error(`\n[数据加载失败] code=${err.code}`);
    console.error(`  ${err.message}`);
    console.error('  → 产品行为：不生成任何结论，直接向用户报错并给出修复建议，而不是"照常输出正常结论"。\n');
    process.exitCode = 2;
    return;
  }

  const label = dataset.meta?.source ?? dataset.sourceId ?? 'unknown';
  if (args.source) console.log(`数据源：${dataset.sourceId}（meta.source=${label}，${dataset.market.length} 个数据点）`);

  const summaries = listDecisions(dataset);
  const targets = args.id ? summaries.filter((s) => s.id === args.id) : summaries;
  if (targets.length === 0) {
    console.error(`未找到决策 ${args.id}；可选：${summaries.map((s) => s.id).join(', ')}`);
    process.exitCode = 2;
    return;
  }

  for (const t of targets) {
    const report = buildReport(dataset, t.id, { asOfOverride: args.asOf });
    fs.writeFileSync(path.join(outDir, `${t.id}.json`), JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, `${t.id}.md`), md(report), 'utf8');
    if (!args.json) {
      console.log(`\n${'='.repeat(72)}`);
      console.log(md(report));
    }
    console.log(`\n✓ 已输出 ${path.relative(process.cwd(), outDir)}\\${t.id}.json 与 .md`);
  }
}

main();
