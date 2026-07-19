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
    c.isReit = c.secType==='reits' || c.secType==='businesstrusts' || /\breit\b|\btrust\b/i.test(c.name);
  }
  return map;
};

// ---------- shared chrome ----------
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">`;
const CUP = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 2.5c-.6.8.6 1.2 0 2M12 2.5c-.6.8.6 1.2 0 2"/></svg>`;
const MOON = `<svg class="moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SUN = `<svg class="sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const NAV = `<header class="nav"><div class="wrap row">
  <a class="brand" href="/"><span class="dot">${CUP}</span> StockKaki</a>
  <nav><a href="/">Dividends</a><a href="/screener/">Screener</a><a href="/reits/">REITs</a><a href="#">Alerts</a></nav>
  <div style="display:flex;align-items:center;gap:8px"><button id="themeBtn" class="tbtn" aria-label="Toggle dark mode">${MOON}${SUN}</button><button class="btn">Get ex-date alerts</button></div>
</div></header>`;
const ALERT = `<section class="alert">
    <div class="txt"><h3 class="serif">Never miss an ex-date again.</h3><p>Free email or Telegram alerts a few days before every dividend you follow goes ex.</p></div>
    <form onsubmit="return false"><input type="email" placeholder="you@email.com"><button class="btn">Get free alerts</button></form>
  </section>`;

// Broker affiliate slot. TODO(Eugene): replace `u` with your real affiliate/referral links.
const BROKERS = [
  { n: 'moomoo SG',           u: 'https://www.moomoo.com/sg',            d: 'Low fees · welcome gifts' },
  { n: 'Tiger Brokers',       u: 'https://www.tigerbrokers.com.sg',      d: 'Popular with SG investors' },
  { n: 'Interactive Brokers', u: 'https://www.interactivebrokers.com',   d: 'Global markets, low cost' },
];
const brokerSlot = () => `<aside class="brokers">
    <div class="bk-h"><span class="bk-t">Start collecting dividends</span><span class="bk-ad">Affiliate</span></div>
    <p class="bk-sub">Open a brokerage account to buy SGX dividend stocks — compare popular options:</p>
    <div class="bk-list">
${BROKERS.map(b => `      <a class="bk" href="${b.u}" target="_blank" rel="sponsored noopener"><b>${b.n}</b><span>${b.d}</span></a>`).join('\n')}
    </div>
  </aside>`;
const FOOTER = `<footer><p class="disc">© 2026 StockKaki · Data from SGX, updated daily · <a href="/disclaimer/" style="color:var(--accent-dk);font-weight:600">Disclaimer</a></p></footer>`;

const STYLE = `
  :root{ --ink:#3A2A20; --muted:#8C7A69; --line:#EBE0D2; --bg:#FBF6EE; --card:#FFFDF9; --accent:#E07A3B; --accent-soft:#FBEADF; --accent-dk:#B45F27; --nav-bg:rgba(251,246,238,.9); --row-hover:#FDF7EE; }
  html[data-theme="dark"]{ --ink:#F3EBE0; --muted:#A08D79; --line:#33291F; --bg:#17120E; --card:#211A14; --accent:#E9944F; --accent-soft:#3A2A1C; --accent-dk:#EDA766; --nav-bg:rgba(23,18,14,.92); --row-hover:#2A2018; }
  *{box-sizing:border-box;margin:0;padding:0} body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;line-height:1.5}
  .serif{font-family:'Poppins',sans-serif;letter-spacing:-.01em} a{color:inherit;text-decoration:none} .wrap{max-width:1080px;margin:0 auto;padding:0 20px}
  header.nav{position:sticky;top:0;z-index:20;background:var(--nav-bg);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .nav .row{display:flex;align-items:center;justify-content:space-between;height:60px}
  .brand{display:flex;align-items:center;gap:10px;font-family:'Poppins',sans-serif;font-weight:700;font-size:20px}
  .brand .dot{width:30px;height:30px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;flex:0 0 auto}
  .nav nav{display:none;gap:24px;font-size:14px;color:var(--muted);font-weight:500} .nav nav a:hover{color:var(--ink)}
  .btn{background:var(--accent);color:#fff;font-weight:600;font-size:13.5px;padding:9px 16px;border-radius:999px;border:0;cursor:pointer} .btn:hover{background:#c9692f}
  .tbtn{background:none;border:0;cursor:pointer;color:var(--muted);display:inline-flex;align-items:center;padding:6px;border-radius:8px} .tbtn:hover{color:var(--ink)}
  html[data-theme="dark"] .moon{display:none} html:not([data-theme="dark"]) .sun{display:none}
  @media(min-width:820px){ .nav nav{display:flex} }
  .hero{padding:30px 0 4px} .kicker{color:var(--accent-dk);font-weight:600;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
  .hero h1{font-family:'Poppins',sans-serif;font-weight:700;font-size:32px;line-height:1.08;letter-spacing:-.01em;margin:8px 0 10px}
  .hero .sub{color:var(--muted);font-size:14.5px;max-width:520px} @media(min-width:820px){ .hero h1{font-size:40px} }
  @media(max-width:819px){ .hero{padding:22px 0 4px} .hero h1{font-size:26px} .hero .sub{display:none} }
  .crumb{color:var(--muted);font-size:13px;margin-bottom:6px} .crumb a:hover{color:var(--accent-dk)}
  .search{position:relative;margin-top:16px;max-width:540px}
  .search input{width:100%;border:1px solid var(--line);background:var(--card);border-radius:12px;padding:13px 16px 13px 44px;font-size:15px;font-family:inherit;color:var(--ink)}
  .search input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .search .ic{position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
  #qres{position:absolute;top:52px;left:0;right:0;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 20px 44px -20px rgba(0,0,0,.35);overflow:hidden;display:none;z-index:30;max-height:340px;overflow-y:auto}
  #qres a{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line);font-size:14px} #qres a:last-child{border-bottom:0} #qres a:hover{background:var(--accent-soft)}
  #qres .noqr{padding:13px 16px;color:var(--muted);font-size:13px}
  .live{display:inline-flex;align-items:center;gap:7px;margin-top:14px;background:var(--accent-soft);color:var(--accent-dk);font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;font-family:'JetBrains Mono',monospace}
  .live .pulse{width:7px;height:7px;border-radius:50%;background:var(--accent)}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:18px 0 6px;scrollbar-width:none} .chips::-webkit-scrollbar{display:none}
  .chip{white-space:nowrap;font-size:13px;font-weight:500;color:var(--muted);background:var(--card);border:1px solid var(--line);padding:7px 14px;border-radius:999px;cursor:pointer;user-select:none}
  .chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
  .nextcard{margin:18px 0 4px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:18px 22px;display:flex;flex-wrap:wrap;gap:28px;align-items:center}
  .nextcard .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600} .nextcard .v{font-family:'JetBrains Mono',monospace;font-weight:600;font-size:18px;margin-top:3px}
  .metaline{color:var(--muted);font-size:13.5px;margin-top:14px} .metaline b{color:var(--ink);font-family:'JetBrains Mono',monospace}
  .h2{font-family:'Poppins',sans-serif;font-weight:600;font-size:16px;margin:26px 0 10px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 12px 36px -28px rgba(58,42,32,.55)}
  table{width:100%;border-collapse:collapse}
  thead th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:13px 16px;border-bottom:1px solid var(--line)}
  thead th.r,tbody td.r{text-align:right}
  tbody td{padding:14px 16px;border-bottom:1px solid var(--line);font-size:14.5px} tbody tr:last-child td{border-bottom:0} tbody tr:hover{background:var(--row-hover)}
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
  .alert form{display:flex;gap:8px;flex-wrap:wrap} .alert input{flex:1;min-width:200px;border:0;border-radius:999px;padding:12px 16px;font-size:14px;font-family:inherit} .alert .btn{background:#20160E;color:#fff}
  @media(min-width:820px){ .alert{flex-direction:row;align-items:center;justify-content:space-between} .alert .txt{max-width:52%} }
  .brokers{margin:24px 0 8px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
  .bk-h{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .bk-t{font-family:'Poppins',sans-serif;font-weight:600;font-size:15px}
  .bk-ad{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 8px;flex:0 0 auto}
  .bk-sub{color:var(--muted);font-size:13px;margin:6px 0 14px}
  .bk-list{display:grid;grid-template-columns:repeat(3,1fr);gap:10px} @media(max-width:620px){.bk-list{grid-template-columns:1fr}}
  .bk{display:block;border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--card);transition:.15s} .bk:hover{border-color:var(--accent);background:var(--accent-soft)}
  .bk b{display:block;font-size:14px} .bk span{font-size:12px;color:var(--muted)}
  footer{margin:36px 0 40px;color:var(--muted);font-size:12.5px;line-height:1.7} footer .disc{border-top:1px solid var(--line);padding-top:16px}
`;
const SEARCH_IC = `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;

const shell = (title, desc, canon, body, script='') => `<!DOCTYPE html>
<html lang="en"><head>
<script>(function(){try{var t=localStorage.getItem('theme');if(!t&&window.matchMedia)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
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
</main>${script}<script>(function(){var b=document.getElementById('themeBtn');if(b)b.onclick=function(){var d=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',d);try{localStorage.setItem('theme',d);}catch(e){}};})();</script>
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
  </table><div id="none" class="empty" style="display:none">No dividends match that filter.</div></div>
  ${brokerSlot()}`;
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

// ---------- list pages (screener / reits) ----------
const companyRow = (c) => {
  const y = c.yieldPct!=null ? c.yieldPct.toFixed(2) : null;
  const special = c.yieldPct!=null && c.yieldPct > 20;   // likely a one-off special dividend
  const yldCell = y ? (special ? `<span class="yld" style="color:var(--muted)" title="Trailing yield likely inflated by a one-off special dividend">${y}%*</span>` : `<span class="yld">${y}%</span>`) : '—';
  const nx = c.divs.find(d => d.exISO >= TODAY);
  return `        <tr data-s="${esc((c.name+' '+(c.ticker||'')).toLowerCase())}" data-reit="${c.isReit?1:0}" data-etf="${c.secType==='etfs'?1:0}" data-y="${c.yieldPct!=null?c.yieldPct:-1}">
          <td><a class="co" href="/stock/${c.slug}/">${c.name}</a>${c.ticker?` <span class="tick">${c.ticker}</span>`:''}</td>
          <td class="r">${yldCell}</td>
          <td class="r amt">${c.ttm>0?'S$'+num(c.ttm):'—'}</td>
          <td class="r date hide-m">${nx?pretty(nx.exISO):'—'}</td>
        </tr>`;
};
function listPage({ title, desc, kicker, h1, sub, list, canon, typeChips }) {
  // realistic yields (≤20%) rank first; likely one-off specials (>20%) and no-yield sink to the bottom
  const key = (c) => c.yieldPct==null ? -1 : (c.yieldPct<=20 ? c.yieldPct : -0.5);
  const sorted = [...list].sort((a,b) => key(b) - key(a));
  const chips = typeChips ? `<div class="chips">
    <span class="chip on" data-f="all">All</span>
    <span class="chip" data-f="stock">Stocks</span>
    <span class="chip" data-f="reit">REITs &amp; Trusts</span>
    <span class="chip" data-f="etf">ETFs</span>
  </div>` : '';
  const body = `  <section class="hero" style="padding-bottom:4px">
    <div class="kicker">${kicker}</div>
    <h1 class="serif" style="font-size:30px">${h1}</h1>
    <p class="sub">${sub}</p>
    <div class="search">${SEARCH_IC}<input id="q" type="text" autocomplete="off" placeholder="Filter by name or ticker…"></div>
  </section>
  ${chips}
  <div class="card" style="margin-top:12px"><table>
    <thead><tr><th>Company</th><th class="r">Yield ↓</th><th class="r">12-mo div</th><th class="r hide-m">Next ex-date</th></tr></thead>
    <tbody id="tb">
${sorted.map(companyRow).join('\n')}
    </tbody>
  </table><div id="none" class="empty" style="display:none">No match.</div></div>
  <p class="metaline" style="font-size:12px">Yields are indicative — trailing 12-month dividends ÷ last price. <b>*</b> likely includes a one-off special dividend.</p>`;
  const script = `<script>
const q=document.getElementById('q'),tb=document.getElementById('tb'),none=document.getElementById('none');
function apply(){const v=q.value.trim().toLowerCase();const on=document.querySelector('.chip.on');const f=on?on.dataset.f:'all';let vis=0;
 tb.querySelectorAll('tr').forEach(r=>{let ok=(!v||r.dataset.s.includes(v));
  if(ok&&f==='reit')ok=r.dataset.reit==='1'; if(ok&&f==='etf')ok=r.dataset.etf==='1'; if(ok&&f==='stock')ok=(r.dataset.reit!=='1'&&r.dataset.etf!=='1');
  r.style.display=ok?'':'none'; if(ok)vis++;});
 none.style.display=vis?'none':'block';}
q.addEventListener('input',apply);
document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));c.classList.add('on');apply();}));
</script>`;
  return shell(title, desc, canon, body, script);
}

// ---------- per-stock page ----------
function stockPage(c) {
  const upcoming = c.divs.filter(d => d.exISO >= TODAY).sort((a,b)=> a.exISO<b.exISO?-1:1);
  const next = upcoming[0];
  const ttmStr = c.ttm>0 ? ('S$'+num(c.ttm)) : null;
  const byYear = {};
  for (const d of c.divs) { if (d.ccy!=='SGD') continue; const y = d.exISO.slice(0,4); byYear[y] = (byYear[y]||0) + d.amtNum; }
  const years = Object.keys(byYear).sort().reverse();
  const nowY = TODAY.slice(0,4);
  const complete = years.filter(y => y < nowY);
  let growth = null;
  if (complete.length >= 2 && byYear[complete[1]] > 0) growth = (byYear[complete[0]] - byYear[complete[1]]) / byYear[complete[1]] * 100;
  let freq = null;
  if (complete.length) { const cnt = c.divs.filter(d => d.ccy==='SGD' && d.exISO.slice(0,4)===complete[0]).length; freq = cnt>=4?'Quarterly':cnt===3?'Thrice yearly':cnt===2?'Semi-annual':cnt===1?'Annual':null; }
  const sig = [];
  if (freq) sig.push(`Pays <b>${freq}</b>`);
  if (years.length) sig.push(`<b>${years.length}</b> year${years.length>1?'s':''} of dividends on record`);
  if (growth != null) sig.push(`latest full year <b>${growth>=0?'+':''}${growth.toFixed(1)}%</b> YoY`);
  const signals = sig.join(' &middot; ');
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
  ${signals ? `<p class="metaline">${signals}.</p>` : ''}
  ${annual}
  <div class="h2">Full dividend history</div>
  <div class="card"><table>
    <thead><tr><th>Ex-date</th><th class="r">Amount</th><th class="r hide-m">Record date</th><th class="r hide-m">Pay date</th><th class="r hide-m">Announced</th></tr></thead>
    <tbody>
${hist}
    </tbody>
  </table></div>
  <p class="metaline" style="font-size:12px">*Yield uses the current last price (S$${c.price||'—'}) against each year's total — indicative only.</p>
  ${brokerSlot()}`;
  const nextTxt = next ? ` Next ex-date ${pretty(next.exISO)} (${money(next.ccy,next.amt)}).` : '';
  return shell(`${c.name}${c.ticker?' ('+c.ticker+')':''} Dividend History, Yield & Next Ex-Date | StockKaki`,
    `${c.name} dividends — ${c.yieldPct?`indicative yield ${c.yieldPct.toFixed(2)}%, `:''}upcoming ex-dates, amounts, record and pay dates.${nextTxt} Live from SGX.`,
    `${SITE}/stock/${c.slug}/`, body);
}

// ---------- disclaimer ----------
function disclaimerPage() {
  const body = `  <section class="hero" style="padding-bottom:4px">
    <div class="crumb"><a href="/">Dividends</a> › Disclaimer</div>
    <h1 class="serif" style="font-size:28px">Disclaimer</h1>
  </section>
  <div style="max-width:720px;color:var(--muted);font-size:14.5px;line-height:1.75">
    <p style="margin:12px 0">StockKaki provides Singapore dividend and corporate-action information for <b style="color:var(--ink)">general information only</b>. It is not financial advice, a recommendation, an offer, or a solicitation to buy or sell any security.</p>
    <p style="margin:12px 0">Figures — including ex-dates, amounts and indicative yields — are sourced automatically from the Singapore Exchange (SGX) and may contain errors, omissions or delays. Indicative yield is trailing 12-month dividends divided by the last available price, and is an estimate only. Always verify against the official SGX announcement before making any decision.</p>
    <p style="margin:12px 0">StockKaki is <b style="color:var(--ink)">not affiliated with, endorsed by, or connected to SGX</b>. All company names and tickers belong to their respective owners. Some outbound links may be affiliate links.</p>
    <p style="margin:12px 0">Nothing here should be relied upon for investment decisions. Consider your own circumstances and, where appropriate, consult a licensed financial adviser. StockKaki accepts no liability for any loss arising from use of this information.</p>
  </div>`;
  return shell('Disclaimer | StockKaki', 'StockKaki disclaimer — information only, not financial advice. Data sourced from SGX; verify against official announcements.', SITE + '/disclaimer/', body);
}

// ---------- build ----------
const secMap = fetchSecurities();
const rows = await fetchRows(50);   // ~5-6 years of history for deeper track records
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
mkdirSync(new URL('disclaimer/', out), { recursive: true });
writeFileSync(new URL('disclaimer/index.html', out), disclaimerPage());

let n = 0;
for (const c of companies.values()) {
  const dir = new URL(`stock/${c.slug}/`, out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('index.html', dir), stockPage(c));
  n++;
}
const all = [...companies.values()];
mkdirSync(new URL('screener/', out), { recursive: true });
writeFileSync(new URL('screener/index.html', out), listPage({
  title: 'Best Dividend Stocks in Singapore 2026 — Highest SGX Dividend Yields | StockKaki',
  desc: 'The highest-yielding SGX dividend stocks and REITs, ranked by dividend yield and updated daily. Search, filter and compare the best Singapore dividend stocks — free, no clutter.',
  kicker: 'Screener · Rankings', h1: 'Best dividend stocks in Singapore', sub: `${all.length} dividend-paying SGX stocks, REITs & ETFs — ranked by highest yield, updated daily.`,
  list: all, canon: SITE + '/screener/', typeChips: true }));
mkdirSync(new URL('reits/', out), { recursive: true });
writeFileSync(new URL('reits/index.html', out), listPage({
  title: 'Singapore REIT Dividends & Distribution Yields | StockKaki',
  desc: 'All SGX-listed REITs and business trusts ranked by distribution yield. Live from SGX, updated daily.',
  kicker: 'S-REITs', h1: 'Singapore REITs by yield', sub: 'Every SGX REIT and business trust, ranked by distribution yield.',
  list: all.filter(c => c.isReit), canon: SITE + '/reits/', typeChips: false }));

const urls = [SITE + '/', SITE + '/screener/', SITE + '/reits/', SITE + '/disclaimer/', ...all.map(c => `${SITE}/stock/${c.slug}/`)];
writeFileSync(new URL('sitemap.xml', out),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n') + `\n</urlset>\n`);
writeFileSync(new URL('robots.txt', out), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Built: homepage (${upcoming.length} upcoming, ${index.length} in search) + ${n} stock pages + sitemap (${urls.length} urls).`);
