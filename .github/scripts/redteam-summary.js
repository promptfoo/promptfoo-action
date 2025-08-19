#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function getArg(flag, defVal) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defVal;
}

function esc(s) {
  return (s || '').toString().replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function pct(num, den) {
  return den ? `${((num / den) * 100).toFixed(1)}%` : '—';
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const input = getArg('--input', 'output.json');
  const outFile = getArg('--out', 'comment.md');
  const shouldPrint = process.argv.includes('--print');

  const out = readJson(path.resolve(input));
  const resultsRoot = out?.results || {};
  const tests = resultsRoot?.results || resultsRoot?.tests || [];
  const runStats = resultsRoot?.stats || {};
  const tu = runStats?.tokenUsage || {};
  const evalId = out?.evalId || '';
  const ts = resultsRoot?.timestamp || '';

  let share = out?.shareableUrl || '';
  if (!share && evalId) {
    const host = (process.env.PROMPTFOO_REMOTE_APP_BASE_URL || process.env.PROMPTFOO_APP_HOST || 'https://www.promptfoo.app').replace(/\/$/, '');
    share = `${host}/redteam/report/${encodeURIComponent(evalId)}`;
  }

  const isPass = (t) => (typeof t?.success === 'boolean' ? t.success : t?.gradingResult?.pass === true);
  const getPlugin = (t) => t?.metadata?.pluginId || t?.testCase?.metadata?.pluginId || t?.gradingResult?.componentResults?.[0]?.metadata?.pluginId || 'unknown';
  const getStrategy = (t) => t?.metadata?.strategyId || t?.testCase?.metadata?.strategyId || t?.gradingResult?.componentResults?.[0]?.metadata?.strategyId || 'basic';
  const getProvider = (t) => t?.provider?.label || t?.provider?.id || t?.testCase?.provider?.label || t?.testCase?.provider?.id || 'unknown';

  const overall = { total: tests.length, pass: 0, fail: 0 };
  const agg = () => ({ total: 0, pass: 0, fail: 0 });
  const byPlugin = new Map();
  const byStrategy = new Map();
  const byProvider = new Map();

  for (const t of tests) {
    const passed = isPass(t) === true;
    overall.total += 1;
    if (passed) overall.pass += 1; else overall.fail += 1;
    const plugin = getPlugin(t);
    const strategy = getStrategy(t);
    const provider = getProvider(t);
    const bump = (m, k) => { if (!m.has(k)) m.set(k, agg()); const a = m.get(k); a.total += 1; if (passed) a.pass += 1; else a.fail += 1; };
    bump(byPlugin, plugin);
    bump(byStrategy, strategy);
    bump(byProvider, provider);
  }

  const topN = (map, n = 10) => Array.from(map.entries())
    .sort((a,b) => b[1].fail - a[1].fail || (a[1].pass/(a[1].total||1)) - (b[1].pass/(b[1].total||1)))
    .slice(0,n);

  const lines = [];
  lines.push('### ⚠️ LLM redteam summary');
  lines.push('');
  lines.push(`- **Eval**: ${esc(evalId)}  `);
  lines.push(`- **Timestamp**: ${esc(ts)}  `);
  lines.push(`- **Total tests**: ${overall.total}  `);
  lines.push(`- **Passed**: ${overall.pass}  `);
  lines.push(`- **Failed**: ${overall.fail}  `);
  lines.push(`- **Pass rate**: ${pct(overall.pass, overall.total)}`);
  if (process.env.DURATION_SECONDS) lines.push(`- **Duration**: ${process.env.DURATION_SECONDS}s`);
  if (share) lines.push(`- **Report**: ${share}`);

  lines.push('');
  lines.push('| Total | Passed | Failed | Pass rate |');
  lines.push('|------:|------:|-------:|:---------:|');
  lines.push(`| ${overall.total} | ${overall.pass} | ${overall.fail} | ${pct(overall.pass, overall.total)} |`);

  const section = (title, rows) => {
    if (!rows.length) return;
    lines.push('');
    lines.push(`### ${title}`);
    lines.push('');
    lines.push('| ' + title.split(' ')[0] + ' | Pass | Fail | Pass rate |');
    lines.push('|---|---:|---:|:--:|');
    for (const [k, v] of rows) lines.push(`| ${esc(k)} | ${v.pass} | ${v.fail} | ${pct(v.pass, v.total)} |`);
  };

  section('Plugin performance', topN(byPlugin, 20));
  section('Strategy performance', topN(byStrategy, 10));
  section('Provider/model performance', topN(byProvider, 10));

  const tuTotal = (tu.total ?? (tu.prompt || 0) + (tu.completion || 0)) || 0;
  if (tuTotal) {
    lines.push('');
    lines.push('<details>');
    lines.push('<summary><strong>Token usage</strong> (click to expand)</summary>');
    lines.push('');
    lines.push(`- Total tokens: ${tuTotal}`);
    if (typeof tu.prompt === 'number') lines.push(`- Prompt tokens: ${tu.prompt}`);
    if (typeof tu.completion === 'number') lines.push(`- Completion tokens: ${tu.completion}`);
    if (typeof tu.numRequests === 'number') lines.push(`- Requests: ${tu.numRequests}`);
    if (tu.assertions) lines.push(`\n- Assertions tokens: total=${tu.assertions.total ?? 0}, prompt=${tu.assertions.prompt ?? 0}, completion=${tu.assertions.completion ?? 0}`);
    lines.push('</details>');
  }

  const md = lines.join('\n');
  fs.writeFileSync(path.resolve(outFile), md);
  if (shouldPrint) console.log(md);
}

main(); 