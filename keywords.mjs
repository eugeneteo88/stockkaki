#!/usr/bin/env node
/*
 * StockKaki keyword-discovery job.
 * Every day, ask Google Autocomplete what Singapore investors actually search
 * (seed terms + a–z expansion), keep the SG-finance phrases, and diff against
 * yesterday's run to flag NEW / rising queries — so the pages we build are named
 * from real demand, not guesses. Writes dist/keywords.json + dist/keywords/index.html.
 *   node keywords.mjs        (run after build.mjs, before deploy)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SITE = 'https://stockkaki.com';
const OUT = new URL('./dist/', import.meta.url);
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// Google's public autocomplete endpoint (SG locale) → ["query", ["suggestion", ...], ...]
function suggest(q) {
  try {
    const out = execFileSync('curl', ['-s', '-m', '12', '-A', UA, `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=sg&q=${encodeURIComponent(q)}`], { maxBuffer: 4 * 1024 * 1024 }).toString();
    return JSON.parse(out)[1] || [];
  } catch { return []; }
}

const SEEDS = [
  'best singapore stocks', 'singapore dividend', 'best sg', 'sgx', 'highest dividend',
  'best reit', 'singapore reit', 'singapore savings bond', 'best etf singapore', 'sg dividend',
  'dividend stocks singapore', 'best dividend stocks singapore', 'singapore blue chip', 'ex dividend',
];
const RELEVANT = /singapore|\bsg\b|sgx|reit|dividend|stock|\betf\b|yield|\bssb\b|savings bond|share price|\btrust\b|blue.?chip|payout|ex.?dividend/i;
const catOf = (q) =>
  /savings bond|\bssb\b/.test(q) ? 'SSB' :
  /reit|\btrust\b/.test(q) ? 'REITs' :
  /\betf\b/.test(q) ? 'ETFs' :
  /dividend|yield|payout|ex.?dividend/.test(q) ? 'Dividends' :
  /share price|market cap|blue.?chip|stocks to buy|\bp\/e\b/.test(q) ? 'Stocks & price' : 'General';

const counts = new Map();
const abc = 'abcdefghijklmnopqrstuvwxyz'.split('');
for (const seed of SEEDS) {
  for (const qy of [seed, ...abc.map((c) => `${seed} ${c}`)]) {
    for (const s of suggest(qy)) {
      const sl = String(s).toLowerCase().trim().replace(/\s+/g, ' ');
      if (sl.length < 4 || !RELEVANT.test(sl)) continue;
      counts.set(sl, (counts.get(sl) || 0) + 1);
    }
    await sleep(60);
  }
}
const all = [...counts.entries()].map(([q, n]) => ({ q, n, cat: catOf(q) })).sort((a, b) => b.n - a.n || (a.q < b.q ? -1 : 1));

// Diff vs yesterday's deployed keywords.json → flag new/rising phrases.
let prevSet = new Set();
try {
  const pj = JSON.parse(execFileSync('curl', ['-s', '-m', '12', '-A', UA, `${SITE}/keywords.json`]).toString());
  prevSet = new Set((pj.keywords || []).map((x) => x.q));
} catch {}
const rising = all.filter((x) => !prevSet.has(x.q));
const isNew = (q) => prevSet.size > 0 && !prevSet.has(q);

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL('keywords.json', OUT), JSON.stringify({ date: TODAY, total: all.length, keywords: all.slice(0, 400), rising: rising.slice(0, 80) }));

// ---- readable report (noindex, orphan page for us) ----
const CATS = ['Dividends', 'REITs', 'ETFs', 'SSB', 'Stocks & price', 'General'];
const section = (c) => {
  const rows = all.filter((x) => x.cat === c).slice(0, 30);
  if (!rows.length) return '';
  return `<h2>${c} <span class="muted">${rows.length}</span></h2>
  <ol>${rows.map((x) => `<li${isNew(x.q) ? ' class="new"' : ''}><span class="q">${esc(x.q)}</span><span class="n">${x.n}${isNew(x.q) ? ' · NEW' : ''}</span></li>`).join('')}</ol>`;
};
const report = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Keyword radar · StockKaki</title>
<style>
:root{--bg:#17120E;--card:#211A14;--ink:#F3EBE0;--muted:#A08D79;--line:#33291F;--accent:#E9944F}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif;line-height:1.5;max-width:820px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:24px;margin-bottom:4px}.sub{color:var(--muted);font-size:14px;margin-bottom:22px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);margin:26px 0 8px}.muted{color:var(--muted);font-weight:400}
ol{list-style:none;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
li{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line);font-size:14.5px}li:last-child{border-bottom:0}
li.new{background:rgba(233,148,79,.10)}li.new .q{font-weight:600}
.n{color:var(--muted);font-size:12px;font-family:ui-monospace,monospace;white-space:nowrap}
.rising{background:var(--card);border:1px solid var(--accent);border-radius:12px;padding:12px 16px;margin-bottom:8px}.rising b{color:var(--accent)}
.rising span{display:inline-block;margin:4px 10px 4px 0;font-size:14px}
</style></head><body>
<h1>🔎 Keyword radar</h1>
<div class="sub">What Singapore investors are searching (Google Autocomplete, SG) · ${TODAY} · ${all.length} phrases${prevSet.size ? ` · ${rising.length} new vs yesterday` : ''}</div>
${rising.length && prevSet.size ? `<div class="rising"><b>↑ New / rising today</b><br>${rising.slice(0, 24).map((x) => `<span>${esc(x.q)}</span>`).join('')}</div>` : ''}
${CATS.map(section).join('')}
<p class="sub" style="margin-top:26px">Frequency = how many seed queries surfaced the phrase (a rough popularity proxy). Use this to name/prioritise pages — build genuinely distinct ones, not clones.</p>
</body></html>`;
mkdirSync(new URL('keywords/', OUT), { recursive: true });
writeFileSync(new URL('keywords/index.html', OUT), report);

console.log(`Keywords: ${all.length} SG-finance phrases collected${prevSet.size ? `, ${rising.length} new vs yesterday` : ' (no previous run to diff)'}. Report → /keywords/`);
