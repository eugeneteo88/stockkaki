#!/usr/bin/env node
/*
 * StockKaki static-site builder.
 * Fetches Singapore dividends from SGX's public corporate-actions API and
 * generates: homepage (upcoming), one page per stock (dividend history +
 * next ex-date, for SEO), sitemap.xml and robots.txt. Run daily via GitHub Action.
 *   node build.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const API = 'https://api.sgx.com/corporateactions/v1.0';
const SITE = 'https://stockkaki.com';

// SGX's CDN blocks Node's fetch (403) but allows curl — so shell out.
function getJSON(url) {
  const out = execFileSync('curl', ['-s', '-m', '30', '-A', UA, '-H', 'Referer: https://www.sgx.com/', '--compressed', url], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out.toString('utf8'));
}

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pretty = (s) => { if (!s) return '—'; const [y,m,d] = s.split('-').map(Number); return `${d} ${MONTHS[m-1]} ${y}`; };
const ACR = new Set(['SIA','CSOP','UOB','OCBC','DBS','GP','SATS','REIT','ETF','PLC','HPL','SPH','ST','FJ','FE','SGX','II','III','IV','NTUC','ABF','USD','SGD','HKD']);
const FIXWORD = { Iedge:'iEdge', Sreit:'S-REIT', Reits:'REITs', Limited:'Ltd', Limit:'Ltd' };
const titleCase = (s) => (s||'').toLowerCase().split(/\s+/).map(w => {
  const up = w.replace(/[^a-z]/gi,'').toUpperCase();
  if (ACR.has(up)) return w.toUpperCase();
  const t = w.charAt(0).toUpperCase() + w.slice(1);
  return FIXWORD[t] || t;
}).join(' ');
const slugify = (s) => (s||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64);
const money = (ccy, amt) => `${ccy==='USD'?'US$':ccy==='SGD'?'S$':ccy+' '}${amt}`;
const esc = (s) => (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');

const TODAY = new Date().toISOString().slice(0, 10);
const daysTo = (s) => Math.round((new Date(s) - new Date(TODAY)) / 86400000);
const exTag = (s) => { const d = daysTo(s); return d>=0 && d<=7 ? `<span class="tag soon">${d===0?'today':d+'d'}</span>` : ''; };
const yearAgo = new Date(new Date(TODAY).getTime() - 365*86400000).toISOString().slice(0,10);

async function fetchRows(pages = 20) {
  const raw = [];
  for (let p = 0; p < pages; p++) {
    let json; try { json = getJSON(`${API}?pagestart=${p}&pagesize=250`); } catch { break; }
    const data = (json && json.data) || [];
    if (!data.length) break;
    raw.push(...data);
  }
  const seen = new Set(), rows = [];
  for (const x of raw) {
    if (x.anncType !== 'DIVIDEND') continue;
    const ex = iso(x.exDate); if (!ex) continue;
    const m = (x.particulars || '').match(/Rate:\s*([A-Z]{3})?\s*([\d.]+)/i); if (!m) continue;
    const name = titleCase(x.name || ''); if (!name) continue;
    const ccy = (m[1] || 'SGD').toUpperCase(), amt = m[2];
    const key = `${name}|${ex}|${amt}`; if (seen.has(key)) continue; seen.add(key);
    rows.push({ name, slug: slugify(name), exISO: ex, rec: iso(x.recDate), pay: iso(x.datePaid), annc: iso(x.dateAnnc), ccy, amt, amtNum: parseFloat(amt) });
  }
  return rows;
}

const groupCompanies = (rows) => {
  const map = new Map();
  for (const r of rows) {
    if (!r.slug) continue;
    if (!map.has(r.slug)) map.set(r.slug, { name: r.name, slug: r.slug, divs: [] });
    map.get(r.slug).divs.push(r);
  }
  for (const c of map.values()) c.divs.sort((a,b) => a.exISO < b.exISO ? 1 : -1);
  return map;
};

// ---------- shared chrome ----------
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">`;

const CUP = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 2.5c-.6.8.6 1.2 0 2M12 2.5c-.6.8.6 1.2 0 2"/></svg>`;

const NAV = `<header class="nav"><div class="wrap row">
  <a class="brand" href="/"><span class="dot">${CUP}</span> StockKaki</a>
  <nav><a href="/">Dividends</a><a href="#">Announcements</a><a href="#">Screener</a><a href="#">REITs</a><a href="#">Alerts</a></nav>
  <button class="btn">Get ex-date alerts</button>
</div></header>`;

const ALERT = `<section class="alert">
    <div class="txt"><h3 class="serif">Never miss an ex-date again.</h3><p>Free email or Telegram alerts a few days before every dividend you follow goes ex.</p></div>
    <form onsubmit="return false"><input type="email" placeholder="you@email.com"><button class="btn">Get free alerts</button></form>
  </section>`;

const FOOTER = `<footer>
    <p style="margin-bottom:10px"><strong>StockKaki</strong> — your Singapore investing kaki. Dividends first; announcements, screener &amp; more to come. Data from SGX filings, updated daily.</p>
    <p class="disc">For information only — not financial advice, an offer, or a recommendation. Figures are sourced automatically from SGX; verify against official SGX announcements before acting. Not affiliated with SGX. © 2026.</p>
  </footer>`;

const STYLE = `
  :root{ --ink:#3A2A20; --muted:#8C7A69; --line:#EBE0D2; --bg:#FBF6EE; --card:#FFFDF9; --accent:#E07A3B; --accent-soft:#FBEADF; --accent-dk:#B45F27; }
  *{box-sizing:border-box;margin:0;padding:0} body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;line-height:1.5}
  .serif{font-family:'Poppins',sans-serif;letter-spacing:-.01em} a{color:inherit;text-decoration:none} .wrap{max-width:1080px;margin:0 auto;padding:0 20px}
  header.nav{position:sticky;top:0;z-index:20;background:rgba(251,246,238,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .nav .row{display:flex;align-items:center;justify-content:space-between;height:64px}
  .brand{display:flex;align-items:center;gap:10px;font-family:'Poppins',sans-serif;font-weight:700;font-size:20px}
  .brand .dot{width:30px;height:30px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;flex:0 0 auto}
  .nav nav{display:none;gap:26px;font-size:14px;color:var(--muted);font-weight:500} .nav nav a:hover{color:var(--ink)}
  .btn{background:var(--accent);color:#fff;font-weight:600;font-size:13.5px;padding:9px 16px;border-radius:999px;border:0;cursor:pointer} .btn:hover{background:#c9692f}
  @media(min-width:820px){ .nav nav{display:flex} }
  .hero{padding:42px 0 8px} .kicker{color:var(--accent-dk);font-weight:600;font-size:12.5px;letter-spacing:.1em;text-transform:uppercase}
  .hero h1{font-family:'Poppins',sans-serif;font-weight:700;font-size:36px;line-height:1.08;letter-spacing:-.01em;margin:12px 0 12px}
  .hero p{color:var(--muted);font-size:15.5px;max-width:560px} @media(min-width:820px){ .hero h1{font-size:48px} }
  .crumb{color:var(--muted);font-size:13px;margin-bottom:6px} .crumb a:hover{color:var(--accent-dk)}
  .live{display:inline-flex;align-items:center;gap:7px;background:var(--accent-soft);color:var(--accent-dk);font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;font-family:'JetBrains Mono',monospace}
  .live .pulse{width:7px;height:7px;border-radius:50%;background:var(--accent)}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:22px 0 6px;scrollbar-width:none} .chips::-webkit-scrollbar{display:none}
  .chip{white-space:nowrap;font-size:13px;font-weight:500;color:var(--muted);background:#fff;border:1px solid var(--line);padding:7px 14px;border-radius:999px;cursor:pointer}
  .chip.on{background:var(--ink);color:#FBF6EE;border-color:var(--ink)}
  .nextcard{margin:18px 0 4px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:18px 22px;display:flex;flex-wrap:wrap;gap:28px;align-items:center}
  .nextcard .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600} .nextcard .v{font-family:'JetBrains Mono',monospace;font-weight:600;font-size:18px;margin-top:3px}
  .metaline{color:var(--muted);font-size:13.5px;margin-top:14px} .metaline b{color:var(--ink);font-family:'JetBrains Mono',monospace}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 12px 36px -28px rgba(58,42,32,.55)}
  table{width:100%;border-collapse:collapse}
  thead th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:14px 18px;border-bottom:1px solid var(--line)}
  thead th.r,tbody td.r{text-align:right}
  tbody td{padding:15px 18px;border-bottom:1px solid var(--line);font-size:14.5px} tbody tr:last-child td{border-bottom:0} tbody tr:hover{background:#fffdf9}
  .co{font-weight:600;color:inherit} a.co:hover{color:var(--accent-dk)}
  .amt{font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:600;font-size:14px}
  .date{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;color:#6E5E50}
  .tag{display:inline-block;font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent-dk);font-family:'JetBrains Mono',monospace}
  .tag.soon{background:#FBE1CF;color:#A94E17} .type{font-size:12.5px;color:var(--muted)}
  .hide-m{display:none} @media(min-width:820px){ .hide-m{display:table-cell} }
  .mcards{display:grid;gap:12px} .mrow{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px 16px;box-shadow:0 8px 26px -24px rgba(58,42,32,.5)}
  .mrow .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px} .mrow .meta{display:flex;gap:18px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
  .mrow .meta div{font-size:12px;color:var(--muted)} .mrow .meta b{display:block;color:var(--ink);font-size:14px;margin-top:2px;font-family:'JetBrains Mono',monospace}
  @media(min-width:820px){ .mobile-only{display:none} } @media(max-width:819px){ .desktop-only{display:none} }
  .alert{margin:24px 0 8px;background:var(--accent);color:#fff;border-radius:18px;padding:24px 22px;display:flex;flex-direction:column;gap:14px}
  .alert h3{font-family:'Poppins',sans-serif;font-weight:700;font-size:21px} .alert p{color:#FFE7D6;font-size:14px;max-width:520px}
  .alert form{display:flex;gap:8px;flex-wrap:wrap} .alert input{flex:1;min-width:200px;border:0;border-radius:999px;padding:12px 16px;font-size:14px;font-family:inherit} .alert .btn{background:var(--ink);color:#fff}
  @media(min-width:820px){ .alert{flex-direction:row;align-items:center;justify-content:space-between} .alert .txt{max-width:52%} }
  footer{margin:50px 0 40px;color:var(--muted);font-size:12.5px;line-height:1.7} footer .disc{border-top:1px solid var(--line);padding-top:18px}
`;

const shell = (title, desc, canon, body) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canon}">
${FONTS}
<style>${STYLE}</style>
</head><body>
${NAV}
<main class="wrap">
${body}
${ALERT}
${FOOTER}
</main></body></html>`;

// ---------- homepage ----------
const rowHTML = (r) => `        <tr><td><a class="co" href="/stock/${r.slug}/">${r.name}</a></td><td class="date">${pretty(r.exISO)} ${exTag(r.exISO)}</td><td class="r amt">${money(r.ccy,r.amt)}</td><td class="hide-m date">${pretty(r.rec)}</td><td class="hide-m date">${pretty(r.pay)}</td><td class="hide-m type">Dividend</td></tr>`;
const cardHTML = (r) => `    <div class="mrow"><div class="top"><div><a class="co" href="/stock/${r.slug}/">${r.name}</a><div class="type">Dividend</div></div><span class="tag${daysTo(r.exISO)<=7?' soon':''}">${daysTo(r.exISO)<=7?('Ex in '+daysTo(r.exISO)+'d'):pretty(r.exISO)}</span></div><div class="meta"><div>Ex-date<b>${pretty(r.exISO)}</b></div><div>Amount<b>${money(r.ccy,r.amt)}</b></div><div>Pay date<b>${pretty(r.pay)}</b></div></div></div>`;

function homepage(upcoming) {
  const body = `  <section class="hero">
    <div class="kicker">🦁 Huat with dividends</div>
    <h1 class="serif">Catch every payout. Grow your huat.</h1>
    <p>Every upcoming SGX dividend and ex-date in one clean board &mdash; and we&rsquo;ll ping you before it goes ex. Your passive income, front and centre.</p>
    <p style="margin-top:14px"><span class="live"><span class="pulse"></span> Live from SGX · ${upcoming.length} upcoming · updated ${pretty(TODAY)}</span></p>
  </section>
  <div class="chips"><span class="chip on">All</span><span class="chip">REITs &amp; Trusts</span><span class="chip">Ex-date this week</span><span class="chip">This month</span><span class="chip">SGD only</span></div>
  <div class="card desktop-only" style="margin-top:14px"><table>
    <thead><tr><th>Company</th><th>Ex-date</th><th class="r">Amount</th><th class="hide-m">Record date</th><th class="hide-m">Pay date</th><th class="hide-m">Type</th></tr></thead>
    <tbody>
${upcoming.map(rowHTML).join('\n')}
    </tbody>
  </table></div>
  <div class="mcards mobile-only" style="margin-top:14px">
${upcoming.slice(0,14).map(cardHTML).join('\n')}
  </div>`;
  return shell('StockKaki — Upcoming Singapore Dividends & Ex-Dates',
    'Every upcoming SGX dividend, REIT distribution and ex-date — clean, fast and free. Live from SGX, updated daily.',
    SITE + '/', body);
}

// ---------- per-stock page ----------
function stockPage(c) {
  const upcoming = c.divs.filter(d => d.exISO >= TODAY).sort((a,b)=> a.exISO<b.exISO?-1:1);
  const next = upcoming[0];
  const ttm = c.divs.filter(d => d.ccy==='SGD' && d.exISO>=yearAgo && d.exISO<=TODAY).reduce((s,d)=>s+d.amtNum,0);
  const ttmStr = ttm>0 ? ('S$'+ttm.toFixed(4).replace(/0+$/,'').replace(/\.$/,'')) : null;
  const rows = c.divs.map(d => `        <tr><td class="date">${pretty(d.exISO)}${d.exISO>=TODAY?' <span class="tag soon">upcoming</span>':''}</td><td class="r amt">${money(d.ccy,d.amt)}</td><td class="hide-m date">${pretty(d.rec)}</td><td class="hide-m date">${pretty(d.pay)}</td><td class="hide-m date">${pretty(d.annc)}</td></tr>`).join('\n');
  const body = `  <section class="hero" style="padding-bottom:6px">
    <div class="crumb"><a href="/">Dividends</a> › ${c.name}</div>
    <h1 class="serif" style="font-size:30px">${c.name}</h1>
    <p>Dividend history and upcoming ex-dates for ${c.name}, live from SGX.</p>
  </section>
  ${next ? `<div class="nextcard"><div><div class="k">Next ex-date</div><div class="v">${pretty(next.exISO)}</div></div><div><div class="k">Amount</div><div class="v">${money(next.ccy,next.amt)}</div></div><div><div class="k">Pay date</div><div class="v">${pretty(next.pay)}</div></div></div>` : `<p class="metaline">No upcoming ex-date announced yet.</p>`}
  ${ttmStr ? `<p class="metaline">Trailing 12-month dividends: <b>${ttmStr}</b> per security.</p>` : ''}
  <div class="card" style="margin-top:18px"><table>
    <thead><tr><th>Ex-date</th><th class="r">Amount</th><th class="hide-m">Record date</th><th class="hide-m">Pay date</th><th class="hide-m">Announced</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>`;
  const nextTxt = next ? ` Next ex-date ${pretty(next.exISO)} (${money(next.ccy,next.amt)}).` : '';
  return shell(`${c.name} Dividend History & Next Ex-Date | StockKaki`,
    `${c.name} dividends — upcoming ex-dates, amounts, record and pay dates.${nextTxt} Live from SGX.`,
    `${SITE}/stock/${c.slug}/`, body);
}

// ---------- build ----------
const rows = await fetchRows(20);
const upcoming = rows.filter(r => r.exISO >= TODAY).sort((a,b)=> a.exISO<b.exISO?-1:1);
const companies = groupCompanies(rows);

const out = new URL('./dist/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('index.html', out), homepage(upcoming));
writeFileSync(new URL('CNAME', out), 'stockkaki.com\n');

let n = 0;
for (const c of companies.values()) {
  const dir = new URL(`stock/${c.slug}/`, out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('index.html', dir), stockPage(c));
  n++;
}

const urls = [SITE + '/', ...[...companies.values()].map(c => `${SITE}/stock/${c.slug}/`)];
writeFileSync(new URL('sitemap.xml', out),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n') +
  `\n</urlset>\n`);
writeFileSync(new URL('robots.txt', out), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Built: homepage (${upcoming.length} upcoming) + ${n} stock pages + sitemap (${urls.length} urls).`);
upcoming.slice(0,5).forEach(d => console.log(`  ${d.exISO}  ${d.name}  ${money(d.ccy,d.amt)}`));
