#!/usr/bin/env node
/*
 * SGDividends static-site builder.
 * Fetches upcoming Singapore dividends from SGX's public corporate-actions API
 * and generates index.html. Run daily (GitHub Action) to keep it fresh.
 *   node build.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const API = 'https://api.sgx.com/corporateactions/v1.0';

// SGX's CDN blocks Node's fetch (403 Access Denied) but allows curl — so shell out.
function getJSON(url) {
  const out = execFileSync('curl', ['-s', '-m', '30', '-A', UA, '-H', 'Referer: https://www.sgx.com/', '--compressed', url], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out.toString('utf8'));
}

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pretty = (isoStr) => { if (!isoStr) return '—'; const [y,m,d] = isoStr.split('-').map(Number); return `${d} ${MONTHS[m-1]} ${y}`; };
const ACR = new Set(['SIA','CSOP','UOB','OCBC','DBS','GP','SATS','REIT','ETF','PLC','HPL','SPH','ST','FJ','FE','SGX','II','III','IV','NTUC','ABF','USD','SGD','HKD']);
const FIXWORD = { Iedge:'iEdge', Sreit:'S-REIT', Reits:'REITs', Limited:'Ltd', Limit:'Ltd' };
const titleCase = (s) => (s||'').toLowerCase().split(/\s+/).map(w => {
  const up = w.replace(/[^a-z]/gi,'').toUpperCase();
  if (ACR.has(up)) return w.toUpperCase();
  let t = w.charAt(0).toUpperCase() + w.slice(1);
  return FIXWORD[t] || t;
}).join(' ');

const TODAY = new Date().toISOString().slice(0, 10);

async function fetchDividends() {
  const rows = [];
  for (let page = 0; page < 4; page++) {
    let json;
    try { json = getJSON(`${API}?pagestart=${page}&pagesize=250`); } catch { break; }
    const data = (json && json.data) || [];
    if (!data.length) break;
    rows.push(...data);
  }
  const seen = new Set();
  const out = [];
  for (const x of rows) {
    if (x.anncType !== 'DIVIDEND') continue;
    const ex = iso(x.exDate);
    if (!ex || ex < TODAY) continue;                     // upcoming only
    const m = (x.particulars || '').match(/Rate:\s*([A-Z]{3})?\s*([\d.]+)/i);
    if (!m) continue;
    const ccy = (m[1] || 'SGD').toUpperCase();
    const amt = m[2];
    const name = titleCase(x.name || '');
    const key = `${name}|${ex}|${amt}`;
    if (seen.has(key)) continue;                          // dedupe
    seen.add(key);
    out.push({ name, ex, exISO: ex, rec: iso(x.recDate), pay: iso(x.datePaid), ccy, amt });
  }
  out.sort((a, b) => (a.exISO < b.exISO ? -1 : 1));
  return out;
}

const money = (ccy, amt) => `${ccy === 'USD' ? 'US$' : ccy === 'SGD' ? 'S$' : ccy + ' '}${amt}`;
const daysTo = (isoStr) => Math.round((new Date(isoStr) - new Date(TODAY)) / 86400000);
const exTag = (isoStr) => { const d = daysTo(isoStr); return d <= 7 ? `<span class="tag soon">${d === 0 ? 'today' : d + 'd'}</span>` : ''; };

const rowHTML = (r) => `        <tr><td><span class="co">${r.name}</span></td><td class="date">${pretty(r.ex)} ${exTag(r.exISO)}</td><td class="r amt">${money(r.ccy, r.amt)}</td><td class="hide-m date">${pretty(r.rec)}</td><td class="hide-m date">${pretty(r.pay)}</td><td class="hide-m type">Dividend</td></tr>`;

const cardHTML = (r) => `    <div class="mrow"><div class="top"><div><div class="co">${r.name}</div><div class="type">Dividend</div></div><span class="tag${daysTo(r.exISO)<=7?' soon':''}">${daysTo(r.exISO)<=7?('Ex in '+daysTo(r.exISO)+'d'):pretty(r.ex)}</span></div><div class="meta"><div>Ex-date<b>${pretty(r.ex)}</b></div><div>Amount<b>${money(r.ccy,r.amt)}</b></div><div>Pay date<b>${pretty(r.pay)}</b></div></div></div>`;

function page(divs) {
  const updated = pretty(TODAY);
  const rows = divs.map(rowHTML).join('\n');
  const cards = divs.slice(0, 10).map(cardHTML).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StockKaki — Upcoming Singapore Dividends</title>
<meta name="description" content="Every upcoming SGX dividend, REIT distribution and ex-date — clean, fast and free. Your Singapore investing kaki. Live from SGX.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{ --ink:#0f1a14; --muted:#5c6b62; --line:#e7ece8; --bg:#fbfcfb; --card:#fff; --green:#0f7a52; --green-soft:#e7f4ee; --amber:#b7791f; --amber-soft:#fbf3e3; }
  *{box-sizing:border-box;margin:0;padding:0} body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;line-height:1.5}
  .serif{font-family:'Fraunces',serif} a{color:inherit;text-decoration:none} .wrap{max-width:1080px;margin:0 auto;padding:0 20px}
  header.nav{position:sticky;top:0;z-index:20;background:rgba(251,252,251,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .nav .row{display:flex;align-items:center;justify-content:space-between;height:62px}
  .brand{display:flex;align-items:center;gap:9px;font-family:'Fraunces',serif;font-weight:600;font-size:20px}
  .brand .dot{width:26px;height:26px;border-radius:8px;background:var(--green);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;font-family:'Inter'}
  .nav nav{display:none;gap:26px;font-size:14px;color:var(--muted);font-weight:500} .nav nav a:hover{color:var(--ink)}
  .btn{background:var(--green);color:#fff;font-weight:600;font-size:13.5px;padding:9px 16px;border-radius:999px;border:0;cursor:pointer} .btn:hover{background:#0c6444}
  @media(min-width:820px){ .nav nav{display:flex} }
  .hero{padding:40px 0 8px} .kicker{color:var(--green);font-weight:600;font-size:12.5px;letter-spacing:.12em;text-transform:uppercase}
  .hero h1{font-family:'Fraunces',serif;font-weight:600;font-size:34px;line-height:1.12;letter-spacing:-.02em;margin:12px 0 10px}
  .hero p{color:var(--muted);font-size:15.5px;max-width:580px} @media(min-width:820px){ .hero h1{font-size:44px} }
  .live{display:inline-flex;align-items:center;gap:7px;background:var(--green-soft);color:var(--green);font-size:12px;font-weight:600;padding:4px 11px;border-radius:999px}
  .live .pulse{width:7px;height:7px;border-radius:50%;background:var(--green)}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:22px 0 6px;scrollbar-width:none} .chips::-webkit-scrollbar{display:none}
  .chip{white-space:nowrap;font-size:13px;font-weight:500;color:var(--muted);background:#fff;border:1px solid var(--line);padding:7px 14px;border-radius:999px;cursor:pointer}
  .chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 10px 34px -26px rgba(15,26,20,.5)}
  table{width:100%;border-collapse:collapse}
  thead th{text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:14px 18px;border-bottom:1px solid var(--line)}
  thead th.r,tbody td.r{text-align:right}
  tbody td{padding:15px 18px;border-bottom:1px solid var(--line);font-size:14.5px} tbody tr:last-child td{border-bottom:0} tbody tr:hover{background:#fafcfb}
  .co{font-weight:600} .amt{font-variant-numeric:tabular-nums;font-weight:600} .date{font-variant-numeric:tabular-nums}
  .tag{display:inline-block;font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--green-soft);color:var(--green)}
  .tag.soon{background:var(--amber-soft);color:var(--amber)} .type{font-size:12.5px;color:var(--muted)}
  .hide-m{display:none} @media(min-width:820px){ .hide-m{display:table-cell} }
  .mcards{display:grid;gap:12px} .mrow{background:#fff;border:1px solid var(--line);border-radius:14px;padding:15px 16px;box-shadow:0 8px 26px -24px rgba(15,26,20,.5)}
  .mrow .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px} .mrow .meta{display:flex;gap:18px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
  .mrow .meta div{font-size:12px;color:var(--muted)} .mrow .meta b{display:block;color:var(--ink);font-size:14px;margin-top:2px;font-variant-numeric:tabular-nums}
  @media(min-width:820px){ .mobile-only{display:none} } @media(max-width:819px){ .desktop-only{display:none} }
  .alert{margin:22px 0 8px;background:linear-gradient(120deg,#0f1a14,#12352a);color:#eaf5ef;border-radius:18px;padding:24px 22px;display:flex;flex-direction:column;gap:14px}
  .alert h3{font-family:'Fraunces',serif;font-weight:600;font-size:21px} .alert p{color:#b9cdc3;font-size:14px;max-width:520px}
  .alert form{display:flex;gap:8px;flex-wrap:wrap} .alert input{flex:1;min-width:200px;border:0;border-radius:999px;padding:12px 16px;font-size:14px;font-family:inherit} .alert .btn{background:#4ade80;color:#06281c}
  @media(min-width:820px){ .alert{flex-direction:row;align-items:center;justify-content:space-between} .alert .txt{max-width:52%} }
  footer{margin:50px 0 40px;color:var(--muted);font-size:12.5px;line-height:1.7} footer .disc{border-top:1px solid var(--line);padding-top:18px}
</style>
</head>
<body>
<header class="nav"><div class="wrap row">
  <a class="brand" href="#"><span class="dot">K</span> StockKaki</a>
  <nav><a href="#" style="color:var(--ink);font-weight:600">Dividends</a><a href="#">Announcements</a><a href="#">Screener</a><a href="#">REITs</a><a href="#">Alerts</a></nav>
  <button class="btn">Get ex-date alerts</button>
</div></header>
<main class="wrap">
  <section class="hero">
    <div class="kicker">StockKaki · Dividends</div>
    <h1 class="serif">Upcoming Singapore dividends,<br>without the clutter.</h1>
    <p>Every SGX dividend and ex-date, straight from source. Clean, fast, free — no pop-ups, no ad walls.</p>
    <p style="margin-top:14px"><span class="live"><span class="pulse"></span> Live from SGX · ${divs.length} upcoming · updated ${updated}</span></p>
  </section>
  <div class="chips"><span class="chip on">All</span><span class="chip">REITs &amp; Trusts</span><span class="chip">Ex-date this week</span><span class="chip">This month</span><span class="chip">SGD only</span></div>
  <div class="card desktop-only" style="margin-top:14px"><table>
    <thead><tr><th>Company</th><th>Ex-date</th><th class="r">Amount</th><th class="hide-m">Record date</th><th class="hide-m">Pay date</th><th class="hide-m">Type</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>
  <div class="mcards mobile-only" style="margin-top:14px">
${cards}
  </div>
  <section class="alert">
    <div class="txt"><h3 class="serif">Never miss an ex-date again.</h3><p>Free email or Telegram alerts a few days before every dividend you follow goes ex. The thing the other sites make you dig for — we just send it to you.</p></div>
    <form onsubmit="return false"><input type="email" placeholder="you@email.com"><button class="btn">Get free alerts</button></form>
  </section>
  <footer>
    <p style="margin-bottom:10px"><strong>StockKaki</strong> — your Singapore investing kaki. Dividends first; announcements, screener &amp; more to come. Data from SGX filings, updated daily.</p>
    <p class="disc">For information only — not financial advice, an offer, or a recommendation. Figures are sourced automatically from SGX; verify against official SGX announcements before acting. Not affiliated with SGX. © 2026.</p>
  </footer>
</main>
</body>
</html>`;
}

const divs = await fetchDividends();
const outDir = new URL('./dist/', import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL('index.html', outDir), page(divs));
writeFileSync(new URL('CNAME', outDir), 'stockkaki.com\n');
console.log(`Built dist/index.html — ${divs.length} upcoming dividends. Next 5:`);
divs.slice(0, 5).forEach(d => console.log(`  ${d.ex}  ${d.name}  ${money(d.ccy, d.amt)}`));
