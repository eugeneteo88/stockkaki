#!/usr/bin/env node
/*
 * StockKaki static-site builder.
 * Fetches Singapore dividends from SGX's public corporate-actions API and
 * generates: homepage (upcoming board with search + filters), one page per
 * stock (dividend history, annual summary, next ex-date, yield), sitemap.xml
 * and robots.txt. Run daily via GitHub Action.  node build.mjs
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const API = 'https://api.sgx.com/corporateactions/v1.0';
const SITE = 'https://stockkaki.com';

// SGX's CDN blocks Node's fetch (403) but allows curl — so shell out.
function getJSON(url) {
  const out = execFileSync('curl', ['-s','-m','30','-A',UA,'-H','Referer: https://www.sgx.com/','--compressed',url], { maxBuffer: 32*1024*1024 });
  return JSON.parse(out.toString('utf8'));
}

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0,10) : null);
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
const NOISE = /autocall|socgen|soc gen|macq|bnpp|\bcbbc\b|call warrant|put warrant|daily leverage|-callable|\bdlc\b|structured warrant/i;
const secNorm = (s) => (s||'').toLowerCase().replace(/&/g,' and ').replace(/\b(ltd|limited|pte|plc|corp|corporation|holdings?|group|company|co|the|berhad|bhd|reit|trust|inc|industries|international)\b/g,'').replace(/[^a-z0-9]/g,'');
const money = (ccy, amt) => `${ccy==='USD'?'US$':ccy==='SGD'?'S$':ccy+' '}${amt}`;
const num = (n) => n.toFixed(4).replace(/0+$/,'').replace(/\.$/,'');
const esc = (s) => (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');

const TODAY = new Date().toISOString().slice(0,10);
const daysTo = (s) => Math.round((new Date(s) - new Date(TODAY)) / 86400000);
const exTag = (s) => { const d = daysTo(s); return d>=0 && d<=7 ? `<span class="tag soon">${d===0?'today':d+'d'}</span>` : ''; };
const yearAgo = new Date(new Date(TODAY).getTime() - 365*86400000).toISOString().slice(0,10);

async function fetchRows(pages = 20) {
  const raw = [];
  for (let p = 0; p < pages; p++) {
    let json; try { json = getJSON(`${API}?pagestart=${p}&pagesize=250`); } catch { break; }
    const data = (json && json.data) || [];
    if (!data.length) break; raw.push(...data);
  }
  const seen = new Set(), rows = [];
  for (const x of raw) {
    if (x.anncType !== 'DIVIDEND') continue;
    const ex = iso(x.exDate); if (!ex) continue;
    const m = (x.particulars || '').match(/Rate:\s*([A-Z]{3})?\s*([\d.]+)/i); if (!m) continue;
    if (NOISE.test(x.name || '')) continue;
    const name = titleCase(x.name || ''); if (!name) continue;
    const ccy = (m[1] || 'SGD').toUpperCase(), amt = m[2];
    const key = `${name}|${ex}|${amt}`; if (seen.has(key)) continue; seen.add(key);
    rows.push({ name, slug: slugify(name), exISO: ex, rec: iso(x.recDate), pay: iso(x.datePaid), annc: iso(x.dateAnnc), ccy, amt, amtNum: parseFloat(amt) });
  }
  return rows;
}

function fetchSecurities() {
  let json; try { json = getJSON('https://api.sgx.com/securities/v1.1?excludetypes=bonds&params=nc,n,type,lt'); } catch { return new Map(); }
  const list = (json && json.data && json.data.prices) || [];
  const ok = new Set(['stocks','reits','etfs','businesstrusts']);
  const map = new Map();
  for (const s of list) { if (!ok.has(s.type) || !s.n) continue; const k = secNorm(s.n); if (k && !map.has(k)) map.set(k, { ticker: s.nc, price: s.lt, type: s.type }); }
  return map;
}
const matchTicker = (name, map) => {
  const k = secNorm(name); if (!k) return null;
  if (map.has(k)) return map.get(k);
  for (const [sk, v] of map) { if (sk.length >= 6 && k.startsWith(sk)) return v; }
  return null;
};

const groupCompanies = (rows) => {
  const map = new Map();
  for (const r of rows) {
    if (!r.slug) continue;
    if (!map.has(r.slug)) map.set(r.slug, { name: r.name, slug: r.slug, divs: [] });
    map.get(r.slug).divs.push(r);
  }
  for (const c of map.values()) {
    c.divs.sort((a,b) => a.exISO < b.exISO ? 1 : -1);
    const tk = c.divs.find(d => d.ticker);
    c.ticker = tk ? tk.ticker : null; c.price = tk ? tk.price : null; c.secType = tk ? tk.secType : null;
    c.ttm = c.divs.filter(d => d.ccy==='SGD' && d.exISO>=yearAgo && d.exISO<=TODAY).reduce((s,d)=>s+d.amtNum,0);
    c.yieldPct = (c.price>0 && c.ttm>0) ? c.ttm/c.price*100 : null;
    c.isReit = c.secType==='reits' || c.secType==='businesstrusts';
  }
  return map;
};

// ---------- shared chrome ----------
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">`;
const CUP = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 2.5c-.6.8.6 1.2 0 2M12 2.5c-.6.8.6 1.2 0 2"/></svg>`;
const NAV = `<header class="nav"><div class="wrap row">
  <a class="brand" href="/"><span class="dot">${CUP}</span> StockKaki</a>
  <nav><a href="/">Dividends</a><a href="#">Screener</a><a href="#">REITs</a><a href="#">Alerts</a></nav>
  <button class="btn">Get ex-date alerts</button>
</div></header>`;
const ALERT = `<section class="alert">
    <div class="txt"><h3 class="serif">Never miss an ex-date again.</h3><p>Free email or Telegram alerts a few days before every dividend you follow goes ex.</p></div>
    <form onsubmit="return false"><input type="email" placeholder="you@email.com"><button class="btn">Get free alerts</button></form>
  </section>`;
const FOOTER = `<footer>
    <p style="margin-bottom:10px"><strong>StockKaki</strong> — your Singapore investing kaki. Data from SGX filings, updated daily.</p>
    <p class="disc">For information only — not financial advice, an offer, or a recommendation. Yields are indicative (trailing 12-month dividends ÷ last price). Verify against official SGX announcements before acting. Not affiliated with SGX. © 2026.</p>
  </footer>`;

const STYLE = `
  :root{ --ink:#3A2A20; --muted:#8C7A69; --line:#EBE0D2; --bg:#FBF6EE; --card:#FFFDF9; --accent:#E07A3B; --accent-soft:#FBEADF; --accent-dk:#B45F27; }
  *{box-sizing:border-box;margin:0;padding:0} body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;line-height:1.5}
  .serif{font-family:'Poppins',sans-serif;letter-spacing:-.01em} a{color:inherit;text-decoration:none} .wrap{max-width:1080px;margin:0 auto;padding:0 20px}
  header.nav{position:sticky;top:0;z-index:20;background:rgba(251,246,238,.9);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .nav .row{display:flex;align-items:center;justify-content:space-between;height:60px}
  .brand{display:flex;align-items:center;gap:10px;font-family:'Poppins',sans-serif;font-weight:700;font-size:20px}
  .brand .dot{width:30px;height:30px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;flex:0 0 auto}
  .nav nav{display:none;gap:24px;font-size:14px;color:var(--muted);font-weight:500} .nav nav a:hover{color:var(--ink)}
  .btn{background:var(--accent);color:#fff;font-weight:600;font-size:13.5px;padding:9px 16px;border-radius:999px;border:0;cursor:pointer} .btn:hover{background:#c9692f}
  @media(min-width:820px){ .nav nav{display:flex} }
  .hero{padding:30px 0 4px} .kicker{color:var(--accent-dk);font-weight:600;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
  .hero h1{font-family:'Poppins',sans-serif;font-weight:700;font-size:32px;line-height:1.08;letter-spacing:-.01em;margin:8px 0 10px}
  .hero .sub{color:var(--muted);font-size:14.5px;max-width:520px} @media(min-width:820px){ .hero h1{font-size:40px} }
  @media(max-width:819px){ .hero{padding:22px 0 4px} .hero h1{font-size:26px} .hero .sub{display:none} }
  .crumb{color:var(--muted);font-size:13px;margin-bottom:6px} .crumb a:hover{color:var(--accent-dk)}
  .search{position:relative;margin-top:16px;max-width:540px}
  .search input{width:100%;border:1px solid var(--line);background:#fff;border-radius:12px;padding:13px 16px 13px 44px;font-size:15px;font-family:inherit;color:var(--ink)}
  .search input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .search .ic{position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
  #qres{position:absolute;top:52px;left:0;right:0;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 20px 44px -20px rgba(58,42,32,.45);overflow:hidden;display:none;z-index:30;max-height:340px;overflow-y:auto}
  #qres a{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line);font-size:14px} #qres a:last-child{border-bottom:0} #qres a:hover{background:var(--accent-soft)}
  #qres .noqr{padding:13px 16px;color:var(--muted);font-size:13px}
  .live{display:inline-flex;align-items:center;gap:7px;margin-top:14px;background:var(--accent-soft);color:var(--accent-dk);font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;font-family:'JetBrains Mono',monospace}
  .live .pulse{width:7px;height:7px;border-radius:50%;background:var(--accent)}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:18px 0 6px;scrollbar-width:none} .chips::-webkit-scrollbar{display:none}
  .chip{white-space:nowrap;font-size:13px;font-weight:500;color:var(--muted);background:#fff;border:1px solid var(--line);padding:7px 14px;border-radius:999px;cursor:pointer;user-select:none}
  .chip.on{background:var(--ink);color:#FBF6EE;border-color:var(--ink)}
  .nextcard{margin:18px 0 4px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:18px 22px;display:flex;flex-wrap:wrap;gap:28px;align-items:center}
  .nextcard .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600} .nextcard .v{font-family:'JetBrains Mono',monospace;font-weight:600;font-size:18px;margin-top:3px}
  .metaline{color:var(--muted);font-size:13.5px;margin-top:14px} .metaline b{color:var(--ink);font-family:'JetBrains Mono',monospace}
  .h2{font-family:'Poppins',sans-serif;font-weight:600;font-size:16px;margin:26px 0 10px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 12px 36px -28px rgba(58,42,32,.55)}
  table{width:100%;border-collapse:collapse}
  thead th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:13px 16px;border-bottom:1px solid var(--line)}
  thead th.r,tbody td.r{text-align:right}
  tbody td{padding:14px 16px;border-bottom:1px solid var(--line);font-size:14.5px} tbody tr:last-child td{border-bottom:0} tbody tr:hover{background:#fffdf9}
  .co{font-weight:600;color:inherit} a.co:hover{color:var(--accent-dk)}
  .tick{color:var(--muted);font-size:12px;font-family:'JetBrains Mono',monospace;margin-left:7px}
  .amt{font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:600;font-size:14px}
  .yld{font-family:'JetBrains Mono',monospace;font-weight:600;font-size:14px;color:var(--accent-dk)}
  .date{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;color:#6E5E50}
  .tag{display:inline-block;font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent-dk);font-family:'JetBrains Mono',monospace}
  .tag.soon{background:#FBE1CF;color:#A94E17}
  .empty{padding:26px 16px;text-align:center;color:var(--muted);font-size:14px}
  .hide-m{display:none} @media(min-width:720px){ .hide-m{display:table-cell} }
  @media(max-width:560px){ thead th,tbody td{padding:12px 10px;font-size:13px} .tick{display:none} .amt,.yld{font-size:13px} }
  .alert{margin:26px 0 8px;background:var(--accent);color:#fff;border-radius:18px;padding:24px 22px;display:flex;flex-direction:column;gap:14px}
  .alert h3{font-family:'Poppins',sans-serif;font-weight:700;font-size:21px} .alert p{color:#FFE7D6;font-size:14px;max-width:520px}
  .alert form{display:flex;gap:8px;flex-wrap:wrap} .alert input{flex:1;min-width:200px;border:0;border-radius:999px;padding:12px 16px;font-size:14px;font-family:inherit} .alert .btn{background:var(--ink);color:#fff}
  @media(min-width:820px){ .alert{flex-direction:row;align-items:center;justify-content:space-between} .alert .txt{max-width:52%} }
  footer{margin:44px 0 40px;color:var(--muted);font-size:12.5px;line-height:1.7} footer .disc{border-top:1px solid var(--line);padding-top:18px}
`;
const SEARCH_IC = `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;

const shell = (title, desc, canon, body, script='') => `<!DOCTYPE html>
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
</main>${script}
</body></html>`;

// ---------- homepage ----------
const rowHTML = (r) => {
  const y = r.yieldPct!=null ? r.yieldPct.toFixed(2) : null;
  return `        <tr data-s="${esc((r.name+' '+(r.ticker||'')).toLowerCase())}" data-reit="${r.isReit?1:0}" data-week="${daysTo(r.exISO)<=7?1:0}" data-sgd="${r.ccy==='SGD'?1:0}" data-y="${r.yieldPct!=null?r.yieldPct:-1}">
          <td><a class="co" href="/stock/${r.slug}/">${r.name}</a>${r.ticker?` <span class="tick">${r.ticker}</span>`:''}</td>
          <td class="date">${pretty(r.exISO)} ${exTag(r.exISO)}</td>
          <td class="r amt">${money(r.ccy,r.amt)}</td>
          <td class="r yld">${y?y+'%':'—'}</td>
          <td class="r date hide-m">${pretty(r.pay)}</td>
        </tr>`;
};

function homepage(upcoming, index) {
  const idxJson = JSON.stringify(index).replace(/</g,'\\u003c');
  const body = `  <section class="hero">
    <div class="kicker">🦁 Huat with dividends</div>
    <h1 class="serif">Catch every payout.</h1>
    <p class="sub">Every upcoming SGX dividend, ex-date and yield — live, clean, free.</p>
    <div class="search">${SEARCH_IC}<input id="q" type="text" autocomplete="off" placeholder="Search a stock — e.g. Singtel, DBS, S68"><div id="qres"></div></div>
    <div><span class="live"><span class="pulse"></span> Live from SGX · ${upcoming.length} upcoming · updated ${pretty(TODAY)}</span></div>
  </section>
  <div class="chips">
    <span class="chip on" data-f="all">All</span>
    <span class="chip" data-f="reit">REITs &amp; Trusts</span>
    <span class="chip" data-f="week">Ex this week</span>
    <span class="chip" data-f="sgd">SGD only</span>
    <span class="chip" data-f="yield">Highest yield ↓</span>
  </div>
  <div class="card" style="margin-top:12px"><table>
    <thead><tr><th>Company</th><th>Ex-date</th><th class="r">Amount</th><th class="r">Yield</th><th class="r hide-m">Pay date</th></tr></thead>
    <tbody id="tb">
${upcoming.map(rowHTML).join('\n')}
    </tbody>
  </table><div id="none" class="empty" style="display:none">No dividends match that filter.</div></div>`;
  const script = `<script>
const IDX=${idxJson};
const q=document.getElementById('q'),qr=document.getElementById('qres');
q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();if(!v){qr.style.display='none';return;}
  const h=IDX.filter(x=>x.n.toLowerCase().includes(v)||(x.t&&x.t.toLowerCase().includes(v))).slice(0,8);
  qr.innerHTML=h.length?h.map(x=>'<a href="/stock/'+x.s+'/"><span>'+x.n+'</span><span class="tick" style="margin:0">'+(x.t||'')+'</span></a>').join(''):'<div class="noqr">No match — try a ticker like Z74</div>';
  qr.style.display='block';});
document.addEventListener('click',e=>{if(!e.target.closest('.search'))qr.style.display='none';});
const tb=document.getElementById('tb'),none=document.getElementById('none');
document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{
  document.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));c.classList.add('on');
  const f=c.dataset.f;let rows=[...tb.querySelectorAll('tr')];let vis=0;
  rows.forEach(r=>{let show=true;if(f==='reit')show=r.dataset.reit==='1';if(f==='week')show=r.dataset.week==='1';if(f==='sgd')show=r.dataset.sgd==='1';r.style.display=show?'':'none';if(show)vis++;});
  if(f==='yield'){rows.sort((a,b)=>parseFloat(b.dataset.y)-parseFloat(a.dataset.y)).forEach(r=>tb.appendChild(r));}
  none.style.display=vis===0?'block':'none';}));
</script>`;
  return shell('StockKaki — Upcoming Singapore Dividends, Ex-Dates & Yields',
    'Search every SGX dividend, ex-date and yield in one clean board. Live from SGX, updated daily — no ads, no clutter.',
    SITE + '/', body, script);
}

// ---------- per-stock page ----------
function stockPage(c) {
  const upcoming = c.divs.filter(d => d.exISO >= TODAY).sort((a,b)=> a.exISO<b.exISO?-1:1);
  const next = upcoming[0];
  const ttmStr = c.ttm>0 ? ('S$'+num(c.ttm)) : null;
  const byYear = {};
  for (const d of c.divs) { if (d.ccy!=='SGD') continue; const y = d.exISO.slice(0,4); byYear[y] = (byYear[y]||0) + d.amtNum; }
  const years = Object.keys(byYear).sort().reverse();
  const annual = years.length ? `<div class="h2">Dividends by year</div>
  <div class="card"><table>
    <thead><tr><th>Year</th><th class="r">Total / security</th><th class="r">Yield*</th></tr></thead>
    <tbody>
${years.map(y => `        <tr><td class="date">${y}</td><td class="r amt">S$${num(byYear[y])}</td><td class="r yld">${c.price>0?(byYear[y]/c.price*100).toFixed(2)+'%':'—'}</td></tr>`).join('\n')}
    </tbody>
  </table></div>` : '';
  const hist = c.divs.map(d => `        <tr><td class="date">${pretty(d.exISO)}${d.exISO>=TODAY?' <span class="tag soon">upcoming</span>':''}</td><td class="r amt">${money(d.ccy,d.amt)}</td><td class="r date hide-m">${pretty(d.rec)}</td><td class="r date hide-m">${pretty(d.pay)}</td><td class="r date hide-m">${pretty(d.annc)}</td></tr>`).join('\n');
  const body = `  <section class="hero" style="padding-bottom:4px">
    <div class="crumb"><a href="/">Dividends</a> › ${c.name}</div>
    <h1 class="serif" style="font-size:28px">${c.name}${c.ticker?` <span class="tick">${c.ticker}</span>`:''}</h1>
  </section>
  ${next ? `<div class="nextcard"><div><div class="k">Next ex-date</div><div class="v">${pretty(next.exISO)}</div></div><div><div class="k">Amount</div><div class="v">${money(next.ccy,next.amt)}</div></div><div><div class="k">Pay date</div><div class="v">${pretty(next.pay)}</div></div>${c.yieldPct?`<div><div class="k">Indicative yield</div><div class="v">${c.yieldPct.toFixed(2)}%</div></div>`:''}</div>` : `<p class="metaline">No upcoming ex-date announced yet.</p>`}
  ${ttmStr ? `<p class="metaline">Trailing 12-month dividends: <b>${ttmStr}</b> per security${c.yieldPct?` &middot; indicative yield <b>${c.yieldPct.toFixed(2)}%</b> at S$${c.price} last`:''}.</p>` : ''}
  ${annual}
  <div class="h2">Full dividend history</div>
  <div class="card"><table>
    <thead><tr><th>Ex-date</th><th class="r">Amount</th><th class="r hide-m">Record date</th><th class="r hide-m">Pay date</th><th class="r hide-m">Announced</th></tr></thead>
    <tbody>
${hist}
    </tbody>
  </table></div>
  <p class="metaline" style="font-size:12px">*Yield uses the current last price (S$${c.price||'—'}) against each year's total — indicative only.</p>`;
  const nextTxt = next ? ` Next ex-date ${pretty(next.exISO)} (${money(next.ccy,next.amt)}).` : '';
  return shell(`${c.name}${c.ticker?' ('+c.ticker+')':''} Dividend History, Yield & Next Ex-Date | StockKaki`,
    `${c.name} dividends — ${c.yieldPct?`indicative yield ${c.yieldPct.toFixed(2)}%, `:''}upcoming ex-dates, amounts, record and pay dates.${nextTxt} Live from SGX.`,
    `${SITE}/stock/${c.slug}/`, body);
}

// ---------- build ----------
const secMap = fetchSecurities();
const rows = await fetchRows(20);
for (const r of rows) { const m = matchTicker(r.name, secMap); if (m) { r.ticker = m.ticker; r.price = m.price; r.secType = m.type; } }
const companies = groupCompanies(rows);
const upcoming = rows.filter(r => r.exISO >= TODAY).sort((a,b)=> a.exISO<b.exISO?-1:1)
  .map(r => { const c = companies.get(r.slug); return { ...r, yieldPct: c?c.yieldPct:null, isReit: c?c.isReit:false }; });
const index = [...companies.values()].map(c => ({ n: c.name, t: c.ticker||'', s: c.slug })).sort((a,b)=> a.n<b.n?-1:1);

const out = new URL('./dist/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(new URL('index.html', out), homepage(upcoming, index));
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
  urls.map(u => `  <url><loc>${u}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n') + `\n</urlset>\n`);
writeFileSync(new URL('robots.txt', out), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Built: homepage (${upcoming.length} upcoming, ${index.length} in search) + ${n} stock pages + sitemap (${urls.length} urls).`);
