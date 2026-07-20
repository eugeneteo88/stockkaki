#!/usr/bin/env node
/*
 * StockKaki static-site builder.
 * Fetches Singapore dividends from SGX's public corporate-actions API and
 * generates: homepage (upcoming board with search + filters), one page per
 * stock (dividend history, annual summary, next ex-date, yield), sitemap.xml
 * and robots.txt. Run daily via GitHub Action.  node build.mjs
 */
import { writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const API = 'https://api.sgx.com/corporateactions/v1.0';
const MAS = 'https://eservices.mas.gov.sg/statistics/api/v1/bondsandbills/m';   // Singapore Savings Bonds (public, no auth)
const SITE = 'https://stockkaki.com';
// Supabase — public values (safe to embed in the static site; RLS + service key guard the data)
const SUPABASE_URL = 'https://limizehmxnaaqndacynm.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxpbWl6ZWhteG5hYXFuZGFjeW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0NzU3NjMsImV4cCI6MjEwMDA1MTc2M30.Hw04KSZ84VaVSczBOAlwOc9bfYADfb9tjKft4js9BD4';

// SGX's CDN blocks Node's fetch (403) but allows curl — so shell out.
function getJSON(url) {
  const out = execFileSync('curl', ['-s','-m','30','-A',UA,'-H','Referer: https://www.sgx.com/','--compressed',url], { maxBuffer: 32*1024*1024 });
  return JSON.parse(out.toString('utf8'));
}

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0,10) : null);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pretty = (s) => { if (!s) return '—'; const [y,m,d] = s.split('-').map(Number); return `${d} ${MONTHS[m-1]} ${y}`; };
const monthYr = (s) => { if (!s) return '—'; const [y,m] = s.split('-').map(Number); return `${MONTHS[m-1]} ${y}`; };
const prettyShort = (s) => { if (!s) return '—'; const [y,m,d] = s.split('-').map(Number); return `${d} ${MONTHS[m-1]}`; };   // "12 Aug" — compact for mobile
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
// Name normalisation for joining SGX's two feeds (price feed abbreviates: "CapLand"↔"Capitaland",
// "Cpt Tr"↔"Centrepoint Trust", "HTrust"↔"Hospitality Trust", plus USD/SGD currency tranches).
// KEEP "reit"/"trust" as identity tokens so a REIT never merges with its parent ("OUE REIT" ≠ "OUE Ltd").
const ABBR = { capland:'capitaland', cpt:'centrepoint', hse:'house', log:'logistics', ind:'industrial', intcom:'integratedcommercial', tv:'television', kep:'keppel', cent:'centurion', accom:'accommodation', acro:'acrophyte', digicore:'digitalcore', mfg:'manufacturing', mgmt:'management', intl:'international', natl:'national', hldgs:'holdings', hldg:'holdings', grp:'group', svcs:'services', svc:'services', res:'resources', tech:'technology', dev:'development', comm:'commercial', hosp:'hospitality', htrust:'hospitalitytrust', tr:'trust', t:'trust' };
const FILLER = new Set(['ltd','limited','pte','plc','corp','corporation','holdings','holding','group','company','co','the','berhad','bhd','inc','industries','international','public','us','uk']);
// SGX's price feed uses tickers/acronyms for some blue-chips while the dividend feed uses full names.
// Canonical names (by ticker) so the two feeds join — and so pages show the proper company name.
const TICKER_ALIAS = {
  O39:'Oversea-Chinese Banking Corp', U11:'United Overseas Bank', C6L:'Singapore Airlines',
  S68:'Singapore Exchange', S63:'Singapore Tech Engineering', G13:'Genting Singapore',
  Y92:'Thai Beverage', C07:'Jardine Cycle & Carriage', J36:'Jardine Matheson Holdings',
  C09:'City Developments', D01:'DFI Retail Group', U96:'Sembcorp Industries', BS6:'Yangzijiang Shipbldg',
  // REITs/trusts the price feed abbreviates or smushes vs the dividend feed's fuller name
  J85:'CDL Hospitality Trusts', Q5T:'Far East Hospitality Trust', BUOU:'Frasers Logistics & Commercial Trust',
  CMOU:'Keppel Pacific Oak US REIT', JYEU:'Lendlease Global Commercial REIT', BTOU:'Manulife US REIT',
  OXMU:'Prime US REIT', P40U:'Starhill Global REIT', T82U:'Suntec Real Estate Inv Trust',
  ODBU:'United Hampshire US REIT', AW9U:'First Real Estate Inv Trust', NS8U:'Hutchison Port Holdings Trust',
  P7VU:'Hutchison Port Holdings Trust',
};
const secNorm = (s) => {
  s = (s||'').toLowerCase().replace(/&/g,' and ')
    .replace(/\b(usd|sgd|gbp|eur|hkd|aud|myr|rmb|cny|jpy)\b/g,' ')   // drop currency-tranche suffix
    .replace(/(reit|trust)/g,' $1 ');                                 // split smushed names but keep the token
  return s.split(/[^a-z0-9]+/).filter(Boolean).map(t => ABBR[t]!==undefined ? ABBR[t] : t).filter(t => t && !FILLER.has(t)).join('');
};
const CSYM = { SGD:'S$', USD:'US$', GBP:'£', EUR:'€', HKD:'HK$', CNY:'¥', AUD:'A$', JPY:'¥', MYR:'RM' };
const csym = (cur) => CSYM[cur] || (cur ? cur+' ' : 'S$');
const money = (ccy, amt) => `${ccy==='USD'?'US$':ccy==='SGD'?'S$':ccy+' '}${amt}`;
const num = (n) => n.toFixed(4).replace(/0+$/,'').replace(/\.$/,'');
const fmtVol = (n) => (n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? Math.round(n/1e3)+'K' : String(n));
const esc = (s) => (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');

const TODAY = new Date().toISOString().slice(0,10);
const daysTo = (s) => Math.round((new Date(s) - new Date(TODAY)) / 86400000);
const exTag = (s) => { const d = daysTo(s); return d>=0 && d<=7 ? `<span class="tag soon">${d===0?'today':d+'d'}</span>` : ''; };
const yearAgo = new Date(new Date(TODAY).getTime() - 365*86400000).toISOString().slice(0,10);

async function fetchRaw(pages = 50) {
  const raw = [];
  for (let p = 0; p < pages; p++) {
    let json; try { json = getJSON(`${API}?pagestart=${p}&pagesize=250`); } catch { break; }
    const data = (json && json.data) || [];
    if (!data.length) break; raw.push(...data);
  }
  return raw;
}
function parseDividends(raw) {
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
// Big S-REITs file distributions with a scrip/DRP leg ("N Cash Options") that carries NO
// per-unit amount in this feed — so their trailing total is unknowable here and any yield we'd
// compute is badly understated. Track those ex-dates per stock so we can suppress (not fake) the yield.
let SCRIP = new Map();   // slug -> Set(exISO) of amount-less distributions
function collectScrip(raw) {
  const m = new Map();
  for (const x of raw) {
    if (x.anncType !== 'DIVIDEND') continue;
    const ex = iso(x.exDate); if (!ex) continue;
    if (NOISE.test(x.name || '')) continue;
    if (/Rate:\s*([A-Z]{3})?\s*([\d.]+)/i.test(x.particulars || '')) continue;   // has an amount → fine
    const name = titleCase(x.name || ''); if (!name) continue;
    const slug = slugify(name); if (!slug) continue;
    if (!m.has(slug)) m.set(slug, new Set());
    m.get(slug).add(ex);
  }
  return m;
}
const divIncomplete = (slug) => { const s = SCRIP.get(slug); return !!(s && [...s].some(e => e>=yearAgo && e<=TODAY)); };

const ANNC_TYPES = { DIVIDEND:'Dividend', RIGHTS:'Rights', ENTITLEMENT:'Entitlement', OFFER:'Offer' };
function parseAnnouncements(raw) {
  const seen = new Set(), out = [];
  for (const x of raw) {
    const label = ANNC_TYPES[x.anncType]; if (!label) continue;
    if (NOISE.test(x.name || '')) continue;
    const name = titleCase(x.name || ''); if (!name) continue;
    const annc = iso(x.dateAnnc); if (!annc) continue;
    const key = `${name}|${annc}|${x.anncType}|${x.particulars}`; if (seen.has(key)) continue; seen.add(key);
    out.push({ name, slug: slugify(name), annc, ex: iso(x.exDate), type: label, particulars: (x.particulars || '').replace(/\s+/g,' ').trim() });
  }
  out.sort((a,b) => a.annc < b.annc ? 1 : -1);
  return out;
}

function fetchSecurities() {
  let json; try { json = getJSON('https://api.sgx.com/securities/v1.1?excludetypes=bonds&params=nc,n,type,lt,cur,change_vs_pc_percentage,vl'); } catch { return []; }
  const list = (json && json.data && json.data.prices) || [];
  const ok = new Set(['stocks','reits','etfs','businesstrusts']);
  const out = [];
  for (const s of list) { if (!ok.has(s.type) || !s.n) continue; if (NOISE.test(s.n)) continue; out.push({ ticker: s.nc, name: TICKER_ALIAS[s.nc] || s.n, type: s.type, price: s.lt, cur: s.cur || 'SGD', chgPct: s.change_vs_pc_percentage, vol: s.vl }); }
  return out;
}
// ---------- Singapore Savings Bonds (MAS) ----------
function getMAS(path) {
  const out = execFileSync('curl', ['-s','-m','30','-A',UA,'-H','Accept: application/json','--compressed', `${MAS}/${path}`], { maxBuffer: 16*1024*1024 });
  return JSON.parse(out.toString('utf8'));
}
function fetchSSB() {
  let I, C, L;
  try {
    I = getMAS('savingbondsinterest?rows=400').result.records;          // per-issue step-up coupons + average returns
    C = getMAS('savingbondsissuancecalendar?rows=400').result.records;  // application windows + issue/maturity dates
    L = getMAS('listsavingbonds?rows=400').result.records;              // issue size, amount applied, cut-off
  } catch { return null; }
  if (!I || !I.length) return null;
  const cBy = Object.fromEntries((C||[]).map(r => [r.issue_code, r]));
  const lBy = Object.fromEntries((L||[]).map(r => [r.issue_code, r]));
  const rows = I.map(i => {
    const c = cBy[i.issue_code] || {}, l = lBy[i.issue_code] || {};
    const coupons = [], returns = [];
    for (let y = 1; y <= 10; y++) { coupons.push(+i[`year${y}_coupon`]); returns.push(+i[`year${y}_return`]); }
    return {
      code: i.issue_code,
      issueISO: c.issue_date, applyISO: c.last_day_to_apply, annISO: c.ann_date, matISO: c.maturity_date,
      issueFmt: c.issue_date_formatted, applyFmt: c.last_day_to_apply_formatted, annFmt: c.ann_date_formatted,
      y1: returns[0], y10: returns[9], coupons, returns,
      size: +l.issue_size || null, applied: +l.amt_applied || null, cutoff: (l.cutoff_amt != null ? +l.cutoff_amt : null),
    };
  }).filter(r => r.issueISO && r.y1 != null).sort((a,b) => a.issueISO < b.issueISO ? 1 : -1);
  if (!rows.length) return null;
  return { current: rows[0], recent: rows.slice(0, 12), series: rows.slice(0, 36).reverse() };
}
// Project the NEXT (unannounced) SSB from MAS daily SGS benchmark yields.
// MAS sets each issue's rates from the average SGS yields the month before applications open,
// so the 1st-year rate tracks the 1Y yield and the N-year average return tracks the NY yield.
function fetchSGSYields() {
  let recs;
  try { recs = getMAS('pricesandyields?rows=6000&fields=end_of_period,benchmark_tenor,bid_yield').result.records; } catch { return null; }
  const withY = (recs || []).filter(r => r.bid_yield != null);
  if (!withY.length) return null;
  const latest = withY.map(r => r.end_of_period).sort().slice(-1)[0];
  const ym = latest.slice(0, 7);                                   // reference month = latest data month
  const monthRows = withY.filter(r => r.end_of_period.startsWith(ym));
  const avg = (t) => { const rs = monthRows.filter(r => String(r.benchmark_tenor)===t); return rs.length ? rs.reduce((s,r)=>s+r.bid_yield,0)/rs.length : null; };
  const days = new Set(monthRows.map(r => r.end_of_period)).size;
  const y1 = avg('1'), y10 = avg('10');
  if (y1==null || y10==null) return null;
  return { refYM: ym, days, y1, y2: avg('2'), y5: avg('5'), y10 };
}
const monthAdd = (ym, n) => { let [y,m] = ym.split('-').map(Number); m += n; y += Math.floor((m-1)/12); m = ((m-1)%12+12)%12+1; return `${MONTHS[m-1]} ${y}`; };

// Exact normalised match only. (A loose startsWith() fallback used to mis-attach e.g.
// "Keppel Pacific Oak US REIT" → "Keppel Ltd" because both start with "keppel".)
const matchTicker = (name, map) => { const k = secNorm(name); return k && map.has(k) ? map.get(k) : null; };

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
    c.chgPct = tk ? tk.chgPct : null; c.vol = tk ? tk.vol : null;
    c.cur = tk ? tk.cur : (c.divs[0] ? c.divs[0].ccy : 'SGD');   // trading currency, so USD/GBP payers aren't dropped
    c.isReit = c.secType==='reits' || c.secType==='businesstrusts' || (c.secType!=='etfs' && /\breit\b|\btrust\b/i.test(c.name));
    c.divIncomplete = c.isReit && divIncomplete(c.slug);   // scrip/DRP hides the amount only for the multi-component REIT filings
    c.ttm = c.divs.filter(d => d.ccy===c.cur && d.exISO>=yearAgo && d.exISO<=TODAY).reduce((s,d)=>s+d.amtNum,0);
    c.yieldPct = (c.price>0 && c.ttm>0 && !c.divIncomplete) ? c.ttm/c.price*100 : null;
  }
  return map;
};

// ---------- shared chrome ----------
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">`;
const CUP = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 2.5c-.6.8.6 1.2 0 2M12 2.5c-.6.8.6 1.2 0 2"/></svg>`;
const MOON = `<svg class="moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SUN = `<svg class="sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const BURGER = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;
const NAV = `<header class="nav">
  <div class="wrap row">
  <a class="brand" href="/"><span class="dot">${CUP}</span> StockKaki</a>
  <nav><a href="/">Dividends</a><a href="/screener/">Screener</a><a href="/reits/">REITs</a><a href="/ssb/">SSB</a><a href="/announcements/">Announcements</a></nav>
  <div style="display:flex;align-items:center;gap:6px"><button id="themeBtn" class="tbtn" aria-label="Toggle dark mode">${MOON}${SUN}</button><button class="btn deskonly">Get ex-date alerts</button><button id="mtoggle" class="tbtn mtoggle" aria-label="Menu">${BURGER}</button></div>
  </div>
  <div id="mmenu" class="mmenu"><a href="/">Dividends</a><a href="/screener/">Screener</a><a href="/reits/">REITs</a><a href="/ssb/">SSB</a><a href="/announcements/">Announcements</a><a href="#">Alerts</a></div>
</header>`;
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
const FOOTER = `<footer><p class="disc">© 2026 StockKaki · Data from SGX &amp; MAS, updated daily · <a href="/disclaimer/" style="color:var(--accent-dk);font-weight:600">Disclaimer</a></p></footer>`;

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
  .deskonly{display:none} @media(min-width:820px){ .deskonly{display:inline-block} }
  .mtoggle{display:inline-flex} @media(min-width:820px){ .mtoggle{display:none} }
  .mmenu{display:none;border-top:1px solid var(--line)} .mmenu.open{display:block}
  .mmenu a{display:block;padding:15px 20px;border-bottom:1px solid var(--line);color:var(--ink);font-weight:500;font-size:15.5px} .mmenu a:last-child{border-bottom:0}
  @media(min-width:820px){ .mmenu{display:none!important} }
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
  .faq{max-width:760px} .faq-q{font-weight:600;margin-top:16px} .faq-a{color:var(--muted);font-size:14.5px;margin-top:4px;line-height:1.7}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 12px 36px -28px rgba(58,42,32,.55)}
  table{width:100%;border-collapse:collapse}
  thead th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:13px 16px;border-bottom:1px solid var(--line)}
  thead th.r,tbody td.r{text-align:right}
  thead th[data-sort]{cursor:pointer;user-select:none} thead th[data-sort]:hover{color:var(--ink)} .ar{color:var(--accent-dk);font-size:11px}
  tbody td{padding:14px 16px;border-bottom:1px solid var(--line);font-size:14.5px} tbody tr:last-child td{border-bottom:0} tbody tr:hover{background:var(--row-hover)}
  .co{font-weight:600;color:inherit} a.co:hover{color:var(--accent-dk)}
  .tick{color:var(--muted);font-size:12px;font-family:'JetBrains Mono',monospace;margin-left:7px}
  .quote{display:flex;align-items:baseline;gap:14px;margin-top:4px;flex-wrap:wrap}
  .q-price{font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:600} .q-chg{font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:600} .q-vol{font-size:12px;color:var(--muted);font-family:'JetBrains Mono',monospace}
  .amt{font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:600;font-size:14px}
  .yld{font-family:'JetBrains Mono',monospace;font-weight:600;font-size:14px;color:var(--accent-dk)}
  .date{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;color:#6E5E50}
  .tag{display:inline-block;font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent-dk);font-family:'JetBrains Mono',monospace}
  .tag.soon{background:#FBE1CF;color:#A94E17}
  .empty{padding:26px 16px;text-align:center;color:var(--muted);font-size:14px}
  .hide-m{display:none} @media(min-width:720px){ .hide-m{display:table-cell} }
  @media(max-width:560px){ thead th,tbody td{padding:12px 10px;font-size:13px} .tick{display:none} .amt,.yld{font-size:13px} }
  /* ---- responsive data list (screener / reits / homepage): aligned columns on desktop, 2-line cards on mobile ---- */
  .ltable{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 12px 36px -28px rgba(58,42,32,.55)}
  .lrow{display:grid;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--line);color:inherit}
  .lrow:last-child{border-bottom:0} .lrow:not(.lhead):hover{background:var(--row-hover)}
  .lhead{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;background:transparent}
  .lhead>span[data-sort]{cursor:pointer;user-select:none} .lhead>span[data-sort]:hover{color:var(--ink)}
  .lr-name{min-width:0;display:flex;align-items:baseline;gap:7px} .lr-name .tick{flex:0 0 auto}
  .lr-co{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .lr-price,.lr-yield,.lr-div,.lr-ex,.lr-amt,.lr-exd{text-align:right;font-family:'JetBrains Mono',monospace;font-size:13.5px;white-space:nowrap}
  .lr-yield{color:var(--accent-dk);font-weight:600} .lr-yield.mut{color:var(--muted);font-weight:500}
  .lr-ex,.lr-exd{color:#6E5E50;font-size:12.5px} html[data-theme="dark"] .lr-ex,html[data-theme="dark"] .lr-exd{color:var(--muted)}
  .lr-meta{display:none} .lr-tag{margin-left:6px}
  .lr-sub{font-size:12px;color:var(--muted);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .lr-type .tag{vertical-align:middle}
  .cols-screener .lrow{grid-template-columns:minmax(0,1fr) 92px 82px 104px 108px}
  .cols-home .lrow{grid-template-columns:minmax(0,1fr) 122px 92px 84px}
  .cols-annc .lrow{grid-template-columns:minmax(0,1fr) 104px 92px 96px}
  .cols-annc .lr-name{flex-direction:column;align-items:flex-start;gap:1px}
  .cols-annc .lr-co{max-width:100%}
  .cols-ssbr .lrow{grid-template-columns:minmax(0,1fr) 78px 86px 116px 74px}
  .lsort{display:none}
  @media(max-width:560px){
    .cols-screener .lrow,.cols-home .lrow,.cols-annc .lrow,.cols-ssbr .lrow{grid-template-columns:minmax(0,1fr) auto;row-gap:2px;padding:12px 14px}
    .lhead{display:none}
    .lr-price,.lr-div,.lr-ex,.lr-amt,.lr-exd,.lr-sub{display:none}
    .lr-name{grid-column:1;grid-row:1} .lr-name .tick{display:inline}
    .lr-yield{grid-column:2;grid-row:1;font-size:16px}
    .cols-annc .lr-type{grid-column:2;grid-row:1;text-align:right}
    .lr-meta{display:block;grid-column:1/-1;grid-row:2;font-family:'JetBrains Mono',monospace;font-size:12.5px;color:var(--muted)}
    .lsort{display:flex;gap:8px;margin:14px 0 -2px;overflow-x:auto;scrollbar-width:none} .lsort::-webkit-scrollbar{display:none}
    .lsort button{white-space:nowrap;font-family:inherit;font-size:12.5px;font-weight:600;color:var(--muted);background:var(--card);border:1px solid var(--line);padding:7px 13px;border-radius:999px;cursor:pointer}
    .lsort button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
  }
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
  .ssb-card{margin:16px 0 6px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:18px;padding:22px}
  .ssb-status{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;font-family:'JetBrains Mono',monospace;padding:6px 13px;border-radius:999px}
  .ssb-status .pulse{width:7px;height:7px;border-radius:50%;background:currentColor}
  .ssb-status.open{background:#dcf3e7;color:#0c7a4e} html[data-theme="dark"] .ssb-status.open{background:#123726;color:#5fd39e}
  .ssb-status.closed{background:var(--accent-soft);color:var(--accent-dk)}
  .ssb-meta{color:var(--muted);font-size:13px;margin-top:11px} .ssb-meta b{color:var(--ink);font-family:'JetBrains Mono',monospace}
  .ssb-stats{display:flex;gap:14px;flex-wrap:wrap;margin-top:16px}
  .bigstat{flex:1;min-width:150px;background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:15px 18px}
  .bigstat .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
  .bigstat .v{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:34px;color:var(--accent-dk);margin-top:6px;line-height:1}
  .bigstat.alt .v{color:var(--ink)} .bigstat .cap{font-size:11.5px;color:var(--muted);margin-top:7px}
  .facts{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
  .fact{font-size:12px;color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:6px 12px} .fact b{color:var(--ink)}
  .calc{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
  .calc .f{flex:1;min-width:130px} .calc label{font-size:12px;color:var(--muted);font-weight:600;display:block;margin-bottom:5px}
  .calc input,.calc select{width:100%;border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:11px 13px;font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--ink)}
  .calc input:focus,.calc select:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .calc-out{margin-top:16px;display:flex;gap:14px;flex-wrap:wrap} .calc-out .bigstat{min-width:140px}
  .chartwrap{margin-top:6px} .leg{display:flex;gap:18px;font-size:12px;color:var(--muted);margin:2px 0 10px}
  .leg i{display:inline-block;width:14px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px}
  .stepup tr.hl td{background:var(--accent-soft)} .stepup tr.hl td:first-child{font-weight:700}
`;
const SEARCH_IC = `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;

const shell = (title, desc, canon, body, script='') => `<!DOCTYPE html>
<html lang="en"><head>
<script>(function(){try{var t=localStorage.getItem('theme');if(!t&&window.matchMedia)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="google-site-verification" content="GP6YGT1x9z7T6QlUkLDTXvfbGlqkocw2RSWOWmKkO1Q">
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#E07A3B">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canon}">
<meta property="og:type" content="website"><meta property="og:site_name" content="StockKaki"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canon}"><meta property="og:image" content="${SITE}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${SITE}/og.png">
${FONTS}
<style>${STYLE}</style>
</head><body>
${NAV}
<main class="wrap">
${body}
${ALERT}
${FOOTER}
</main>${script}<script>
var SBFN='${SUPABASE_URL}/functions/v1',SBK='${SUPABASE_ANON}';
(function(){
var b=document.getElementById('themeBtn');if(b)b.onclick=function(){var d=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',d);try{localStorage.setItem('theme',d);}catch(e){}};
var mt=document.getElementById('mtoggle'),mm=document.getElementById('mmenu');if(mt&&mm)mt.onclick=function(){mm.classList.toggle('open');};
document.querySelectorAll('.alert form').forEach(function(f){f.addEventListener('submit',function(ev){ev.preventDefault();var inp=f.querySelector('input');var e=(inp.value||'').trim();if(!e)return;var btn=f.querySelector('button');btn.textContent='…';btn.disabled=true;fetch(SBFN+'/subscribe',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+SBK,apikey:SBK},body:JSON.stringify({email:e})}).then(function(r){return r.json();}).then(function(d){if(d&&d.ok){f.innerHTML='<div style="color:#fff;font-weight:600">✓ Almost there — check your inbox to confirm.</div>';}else{btn.textContent='Try again';btn.disabled=false;}}).catch(function(){btn.textContent='Try again';btn.disabled=false;});});});
})();</script>
</body></html>`;

// ---------- homepage ----------
const rowHTML = (r) => {
  const y = r.yieldPct!=null ? r.yieldPct.toFixed(2) : null;
  const amtTxt = r.divIncomplete ? 'scrip' : money(r.ccy,r.amt);
  const yTxt = y ? y+'%' : (r.divIncomplete ? 'scrip' : '—');
  const yCls = 'lr-yield' + ((!y || r.divIncomplete) ? ' mut' : '');
  const tag = exTag(r.exISO);
  const meta = `Ex ${prettyShort(r.exISO)}${tag?' '+tag:''}  ·  ${amtTxt}`;
  return `        <a class="lrow" href="/stock/${r.slug}/" data-s="${esc((r.name+' '+(r.ticker||'')).toLowerCase())}" data-reit="${r.isReit?1:0}" data-week="${daysTo(r.exISO)<=7?1:0}" data-sgd="${r.ccy==='SGD'?1:0}" data-y="${r.yieldPct!=null?r.yieldPct:-1}">
          <span class="lr-name"><span class="lr-co">${r.name}</span>${r.ticker?`<span class="tick">${r.ticker}</span>`:''}</span>
          <span class="lr-exd">${pretty(r.exISO)} ${tag}</span>
          <span class="lr-amt">${amtTxt}</span>
          <span class="${yCls}">${yTxt}</span>
          <span class="lr-meta">${meta}</span>
        </a>`;
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
  <div class="ltable cols-home" style="margin-top:12px">
    <div class="lrow lhead"><span>Company</span><span class="lr-exd">Ex-date</span><span class="lr-amt">Amount</span><span class="lr-yield">Yield</span></div>
    <div id="tb">
${upcoming.map(rowHTML).join('\n')}
    </div>
  </div>
  <div id="none" class="empty" style="display:none">No dividends match that filter.</div>
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
  const f=c.dataset.f;let rows=[...tb.querySelectorAll('.lrow')];let vis=0;
  rows.forEach(r=>{let show=true;if(f==='reit')show=r.dataset.reit==='1';if(f==='week')show=r.dataset.week==='1';if(f==='sgd')show=r.dataset.sgd==='1';r.style.display=show?'':'none';if(show)vis++;});
  if(f==='yield'){rows.sort((a,b)=>parseFloat(b.dataset.y)-parseFloat(a.dataset.y)).forEach(r=>tb.appendChild(r));}
  none.style.display=vis===0?'block':'none';}));
</script>`;
  return shell('StockKaki — Upcoming Singapore Dividends, Ex-Dates & Yields',
    'Search every SGX dividend, ex-date and yield in one clean board. Live from SGX, updated daily — no ads, no clutter.',
    SITE + '/', body, script);
}

// ---------- list pages (screener / reits) ----------
const SCRIP_TITLE = 'Distributes via a scrip/reinvestment option — SGX’s free feed omits the cash amount, so the yield can’t be shown accurately.';
const companyRow = (c) => {
  const y = c.yieldPct!=null ? c.yieldPct.toFixed(2) : null;
  const special = c.yieldPct!=null && c.yieldPct > 20;   // likely a one-off special dividend
  const yTitle = special ? ' title="Trailing yield likely inflated by a one-off special dividend"' : (c.divIncomplete ? ` title="${esc(SCRIP_TITLE)}"` : '');
  const yTxt = y ? (special ? `${y}%*` : `${y}%`) : (c.divIncomplete ? 'scrip' : '—');
  const yCls = 'lr-yield' + ((!y || special || c.divIncomplete) ? ' mut' : '');
  const priceTxt = c.price ? csym(c.cur)+c.price : '—';
  const divTxt = c.divIncomplete ? 'scrip' : (c.ttm>0 ? csym(c.cur)+num(c.ttm) : '—');
  const nx = c.divs.find(d => d.exISO >= TODAY);
  const yRank = c.yieldPct==null ? -1 : (c.yieldPct<=20 ? c.yieldPct : -0.5);
  const meta = [ c.price?priceTxt:null, c.divIncomplete?'scrip':(c.ttm>0?'Div '+csym(c.cur)+num(c.ttm):null), nx?'Ex '+prettyShort(nx.exISO):null ].filter(Boolean).join('  ·  ') || 'No dividend in 12M';
  return `        <a class="lrow" href="/stock/${c.slug}/" data-s="${esc((c.name+' '+(c.ticker||'')).toLowerCase())}" data-reit="${c.isReit?1:0}" data-etf="${c.secType==='etfs'?1:0}" data-n="${esc(c.name.toLowerCase())}" data-y="${yRank}" data-d="${c.ttm||0}" data-e="${nx?nx.exISO:''}">
          <span class="lr-name"><span class="lr-co">${c.name}</span>${c.ticker?`<span class="tick">${c.ticker}</span>`:''}</span>
          <span class="lr-price">${priceTxt}</span>
          <span class="${yCls}"${yTitle}>${yTxt}</span>
          <span class="lr-div">${divTxt}</span>
          <span class="lr-ex">${nx?prettyShort(nx.exISO):'—'}</span>
          <span class="lr-meta">${meta}</span>
        </a>`;
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
  <div class="lsort"><button data-sort="y" class="on">Yield</button><button data-sort="d">Dividend</button><button data-sort="n">A–Z</button></div>
  <div class="ltable cols-screener" style="margin-top:12px">
    <div class="lrow lhead"><span data-sort="n">Company</span><span class="lr-price">Price</span><span class="lr-yield" data-sort="y">Yield</span><span class="lr-div" data-sort="d">12-mo div</span><span class="lr-ex" data-sort="e">Next ex-date</span></div>
    <div id="tb">
${sorted.map(companyRow).join('\n')}
    </div>
  </div>
  <div id="none" class="empty" style="display:none">No match.</div>
  <p class="metaline" style="font-size:12px">Yields are indicative — trailing 12-month dividends ÷ last price. <b>*</b> likely a one-off special dividend; <b>scrip</b> = pays via a reinvestment option (cash amount not in SGX's free feed).</p>`;
  const script = `<script>
const q=document.getElementById('q'),tb=document.getElementById('tb'),none=document.getElementById('none');
function apply(){const v=q.value.trim().toLowerCase();const on=document.querySelector('.chip.on');const f=on?on.dataset.f:'all';let vis=0;
 tb.querySelectorAll('.lrow').forEach(r=>{let ok=(!v||r.dataset.s.includes(v));
  if(ok&&f==='reit')ok=r.dataset.reit==='1'; if(ok&&f==='etf')ok=r.dataset.etf==='1'; if(ok&&f==='stock')ok=(r.dataset.reit!=='1'&&r.dataset.etf!=='1');
  r.style.display=ok?'':'none'; if(ok)vis++;});
 none.style.display=vis?'none':'block';}
q.addEventListener('input',apply);
document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));c.classList.add('on');apply();}));
let sk='',sd=-1;
function sortBy(k){if(sk===k)sd=-sd;else{sk=k;sd=(k==='n'||k==='e')?1:-1;}
 const rows=[...tb.querySelectorAll('.lrow')];
 rows.sort((a,b)=>{let av=a.dataset[k],bv=b.dataset[k];if(k==='n'||k==='e'){av=av||'~';bv=bv||'~';return av<bv?-sd:av>bv?sd:0;}return (parseFloat(av)-parseFloat(bv))*sd;});
 rows.forEach(r=>tb.appendChild(r));
 document.querySelectorAll('.lhead [data-sort]').forEach(th=>{const o=th.querySelector('.ar');if(o)o.remove();if(th.dataset.sort===sk)th.insertAdjacentHTML('beforeend','<span class="ar">'+(sd<0?' ↓':' ↑')+'</span>');});
 document.querySelectorAll('.lsort button').forEach(bn=>bn.classList.toggle('on',bn.dataset.sort===sk));}
document.querySelectorAll('.lhead [data-sort]').forEach(th=>th.addEventListener('click',()=>sortBy(th.dataset.sort)));
document.querySelectorAll('.lsort button').forEach(bn=>bn.addEventListener('click',()=>sortBy(bn.dataset.sort)));
sortBy('y');
</script>`;
  return shell(title, desc, canon, body, script);
}

// ---------- announcements ----------
function announcementsPage(anns) {
  const items = anns.slice(0, 200);
  const rows = items.map(a => {
    const det = esc(a.particulars || '');
    const meta = [pretty(a.annc), a.ex ? 'Ex '+prettyShort(a.ex) : null, det ? det.slice(0,46) : null].filter(Boolean).join('  ·  ');
    return `        <a class="lrow" href="/stock/${a.slug}/" data-t="${a.type}">
          <span class="lr-name"><span class="lr-co">${a.name}</span><span class="lr-sub">${det.slice(0,72) || '—'}</span></span>
          <span class="lr-type"><span class="tag">${a.type}</span></span>
          <span class="lr-exd">${pretty(a.annc)}</span>
          <span class="lr-ex">${a.ex ? prettyShort(a.ex) : '—'}</span>
          <span class="lr-meta">${meta}</span>
        </a>`;
  }).join('\n');
  const body = `  <section class="hero" style="padding-bottom:4px">
    <div class="kicker">Announcements</div>
    <h1 class="serif" style="font-size:30px">SGX corporate actions</h1>
    <p class="sub">Latest dividends, rights, entitlements and offers from SGX-listed companies — updated daily.</p>
  </section>
  <div class="chips">
    <span class="chip on" data-t="all">All</span>
    <span class="chip" data-t="Dividend">Dividends</span>
    <span class="chip" data-t="Rights">Rights</span>
    <span class="chip" data-t="Entitlement">Entitlements</span>
    <span class="chip" data-t="Offer">Offers</span>
  </div>
  <div class="ltable cols-annc" style="margin-top:12px">
    <div class="lrow lhead"><span>Company</span><span class="lr-type">Type</span><span class="lr-exd">Announced</span><span class="lr-ex">Ex-date</span></div>
    <div id="tb">
${rows}
    </div>
  </div>
  <div id="none" class="empty" style="display:none">No announcements match.</div>`;
  const script = `<script>
const tb=document.getElementById('tb'),none=document.getElementById('none');
document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));c.classList.add('on');const t=c.dataset.t;let vis=0;tb.querySelectorAll('.lrow').forEach(r=>{const ok=(t==='all'||r.dataset.t===t);r.style.display=ok?'':'none';if(ok)vis++;});none.style.display=vis?'none':'block';}));
</script>`;
  return shell('SGX Corporate Actions & Announcements — Dividends, Rights, Offers | StockKaki',
    'Latest SGX corporate actions: dividends, rights issues, entitlements and offers from Singapore-listed companies. Updated daily.',
    SITE + '/announcements/', body, script);
}

// ---------- per-stock page ----------
function stockPage(c) {
  const upcoming = c.divs.filter(d => d.exISO >= TODAY).sort((a,b)=> a.exISO<b.exISO?-1:1);
  const next = upcoming[0];
  const CS = csym(c.cur);
  const inc = c.divIncomplete;               // scrip/DRP → per-unit cash amount not in the free feed
  const ttmStr = (c.ttm>0 && !inc) ? (CS+num(c.ttm)) : null;
  const scripNote = `<div class="metaline" style="background:var(--accent-soft);border-radius:12px;padding:12px 14px;color:var(--ink)">This counter distributes via a <b>scrip / distribution-reinvestment option</b>. SGX’s free data feed doesn’t publish the full per-unit cash amount for these, so the <b>trailing yield and annual totals are omitted</b> to avoid showing a misleading figure. Individual components below are shown exactly as filed.</div>`;
  const byYear = {};
  for (const d of c.divs) { if (d.ccy!==c.cur) continue; const y = d.exISO.slice(0,4); byYear[y] = (byYear[y]||0) + d.amtNum; }
  const years = Object.keys(byYear).sort().reverse();
  const nowY = TODAY.slice(0,4);
  const complete = years.filter(y => y < nowY);
  let growth = null;
  if (complete.length >= 2 && byYear[complete[1]] > 0 && !inc) growth = (byYear[complete[0]] - byYear[complete[1]]) / byYear[complete[1]] * 100;
  let freq = null;
  if (complete.length) { const cnt = c.divs.filter(d => d.ccy==='SGD' && d.exISO.slice(0,4)===complete[0]).length; freq = cnt>=4?'Quarterly':cnt===3?'Thrice yearly':cnt===2?'Semi-annual':cnt===1?'Annual':null; }
  const sig = [];
  if (freq) sig.push(`Pays <b>${freq}</b>`);
  if (years.length) sig.push(`<b>${years.length}</b> year${years.length>1?'s':''} of dividends on record`);
  if (growth != null) sig.push(`latest full year <b>${growth>=0?'+':''}${growth.toFixed(1)}%</b> YoY`);
  const signals = sig.join(' &middot; ');
  const annual = (years.length && !inc) ? `<div class="h2">Dividends by year</div>
  <div class="card"><table>
    <thead><tr><th>Year</th><th class="r">Total / security</th><th class="r">Yield*</th></tr></thead>
    <tbody>
${years.map(y => `        <tr><td class="date">${y}</td><td class="r amt">${CS}${num(byYear[y])}</td><td class="r yld">${c.price>0?(byYear[y]/c.price*100).toFixed(2)+'%':'—'}</td></tr>`).join('\n')}
    </tbody>
  </table></div>` : '';
  const hist = c.divs.map(d => `        <tr><td class="date">${pretty(d.exISO)}${d.exISO>=TODAY?' <span class="tag soon">upcoming</span>':''}</td><td class="r amt">${money(d.ccy,d.amt)}</td><td class="r date hide-m">${pretty(d.rec)}</td><td class="r date hide-m">${pretty(d.pay)}</td><td class="r date hide-m">${pretty(d.annc)}</td></tr>`).join('\n');
  const divSection = c.divs.length ? `
  ${next ? `<div class="nextcard"><div><div class="k">Next ex-date</div><div class="v">${pretty(next.exISO)}</div></div><div><div class="k">Amount</div><div class="v">${inc?'<span style="font-size:14px;color:var(--muted)">scrip</span>':money(next.ccy,next.amt)}</div></div><div><div class="k">Pay date</div><div class="v">${pretty(next.pay)}</div></div>${c.yieldPct?`<div><div class="k">Indicative yield</div><div class="v">${c.yieldPct.toFixed(2)}%</div></div>`:''}</div>` : `<p class="metaline">No upcoming ex-date announced yet.</p>`}
  ${inc ? scripNote : ''}
  ${ttmStr ? `<p class="metaline">Trailing 12-month dividends: <b>${ttmStr}</b> per security${c.yieldPct?` &middot; indicative yield <b>${c.yieldPct.toFixed(2)}%</b> at ${CS}${c.price} last`:''}.</p>` : ''}
  ${signals ? `<p class="metaline">${signals}.</p>` : ''}
  ${annual}
  <div class="h2">Full dividend history</div>
  <div class="card"><table>
    <thead><tr><th>Ex-date</th><th class="r">Amount</th><th class="r hide-m">Record date</th><th class="r hide-m">Pay date</th><th class="r hide-m">Announced</th></tr></thead>
    <tbody>
${hist}
    </tbody>
  </table></div>
  <p class="metaline" style="font-size:12px">*Yield uses the current last price (${CS}${c.price||'—'}) against each year's total — indicative only.</p>` : `<p class="metaline">No dividends recorded for ${c.name} in the last ~6 years — shown here for price &amp; reference. If it starts paying, dividends will appear automatically.</p>`;
  const faqs = [];
  if (c.price) faqs.push({ q: `What is ${c.name}'s share price?`, a: `${c.name}${c.ticker?` (${c.ticker})`:''} last closed at ${CS}${c.price} on the SGX.` });
  if (c.divs.length) {
    faqs.push({ q: `Does ${c.name} pay dividends?`, a: `Yes. ${c.name} has paid dividends over the last ${years.length} year${years.length>1?'s':''}${freq?`, currently ${freq.toLowerCase()}`:''}${ttmStr?`, totalling ${ttmStr} per security in the past 12 months`:''}.` });
    faqs.push({ q: `What is ${c.name}'s dividend yield?`, a: c.yieldPct ? `${c.name}'s indicative dividend yield is about ${c.yieldPct.toFixed(2)}%, based on trailing 12-month dividends of ${ttmStr} per security against a last price of ${CS}${c.price}.` : (inc ? `${c.name} distributes via a scrip/reinvestment option, and SGX's free feed doesn't publish the full per-unit cash amount — so an accurate trailing yield can't be shown here.` : `${c.name} has no trailing 12-month dividends on record, so no indicative yield.`) });
    faqs.push({ q: `When is ${c.name}'s next ex-dividend date?`, a: next ? `${c.name}'s next ex-dividend date is ${pretty(next.exISO)}, paying ${money(next.ccy,next.amt)} per security (pay date ${pretty(next.pay)}). You must own the shares before the ex-date to be entitled.` : `No upcoming ex-dividend date has been announced for ${c.name}.` });
  } else {
    faqs.push({ q: `Does ${c.name} pay dividends?`, a: `${c.name} has not paid a dividend in the last ~6 years, based on SGX corporate-action filings.` });
  }
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const ld = { "@context":"https://schema.org", "@graph":[
    { "@type":"BreadcrumbList", "itemListElement":[
      { "@type":"ListItem", "position":1, "name":"Stocks", "item":`${SITE}/screener/` },
      { "@type":"ListItem", "position":2, "name":c.name, "item":`${SITE}/stock/${c.slug}/` } ] },
    { "@type":"FAQPage", "mainEntity":faqs.map(f => ({ "@type":"Question", "name":f.q, "acceptedAnswer":{ "@type":"Answer", "text":f.a } })) } ] };
  const jsonLd = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\u003c')}</script>`;
  const body = `  <section class="hero" style="padding-bottom:4px">
    <div class="crumb"><a href="/screener/">Stocks</a> › ${c.name}</div>
    <h1 class="serif" style="font-size:28px">${c.name}${c.ticker?` <span class="tick">${c.ticker}</span>`:''}</h1>
    ${c.price?`<div class="quote"><span class="q-price">${CS}${c.price}</span>${(c.chgPct!=null&&c.chgPct!==0)?`<span class="q-chg" style="color:${c.chgPct>=0?'#0f7a52':'#c0392b'}">${c.chgPct>=0?'▲':'▼'} ${Math.abs(c.chgPct).toFixed(2)}%</span>`:''}${c.vol?`<span class="q-vol">Vol ${fmtVol(c.vol)}</span>`:''}<span class="q-vol">last close</span></div>`:''}
    ${!c.ticker?`<p class="metaline" style="margin-top:6px">This counter isn’t currently trading on SGX (delisted or renamed) — shown here for its past dividend record.</p>`:''}
  </section>
  ${divSection}
  ${faqHTML}
  ${brokerSlot()}
  ${jsonLd}`;
  const nextTxt = next ? ` Next ex-date ${pretty(next.exISO)} (${money(next.ccy,next.amt)}).` : '';
  return shell(`${c.name}${c.ticker?' ('+c.ticker+')':''} Share Price, Dividends & Ex-Dates | StockKaki`,
    `${c.name}${c.ticker?' ('+c.ticker+')':''} — ${c.price?`last price ${CS}${c.price}, `:''}${c.yieldPct?`dividend yield ${c.yieldPct.toFixed(2)}%, `:''}dividend history and ex-dates on SGX.${nextTxt} Updated daily.`,
    `${SITE}/stock/${c.slug}/`, body);
}

// Projected next-issue card from SGS benchmark yields.
function projCard(ssb, sgs) {
  if (!sgs || !ssb) return '';
  const c = ssb.current;
  const refMonth = monthAdd(sgs.refYM, 0), appMonth = monthAdd(sgs.refYM, 1);
  const d = sgs.y10 - c.y10;
  const dir = Math.abs(d) < 0.03 ? '≈ about the same as' : d > 0 ? '↑ higher than' : '↓ lower than';
  return `  <div class="h2">Next issue — projected</div>
  <div class="ssb-card" style="border-left-color:#3E8FB0">
    <span class="ssb-status" style="background:var(--bg);color:var(--muted)">Projection · ${refMonth} SGS yields · ${sgs.days} trading day${sgs.days>1?'s':''} so far</span>
    <div class="ssb-stats">
      <div class="bigstat"><div class="k">Projected 1st-year</div><div class="v" style="color:#3E8FB0">~${sgs.y1.toFixed(2)}%</div><div class="cap">now ${c.y1.toFixed(2)}%</div></div>
      <div class="bigstat"><div class="k">Projected 10-yr average</div><div class="v" style="color:#3E8FB0">~${sgs.y10.toFixed(2)}%</div><div class="cap">${dir} the ${c.y10.toFixed(2)}% now</div></div>
    </div>
    <p class="ssb-meta">Projected average return by holding period: <b>1yr ~${sgs.y1.toFixed(2)}%</b> · 2yr ~${sgs.y2!=null?sgs.y2.toFixed(2):'—'}% · 5yr ~${sgs.y5!=null?sgs.y5.toFixed(2):'—'}% · <b>10yr ~${sgs.y10.toFixed(2)}%</b>. The next issue's applications open around early ${appMonth}, when MAS confirms the final rate. This is an estimate from SGS benchmark yields (MAS sets SSB rates from the prior month's average yields) — not an official figure.</p>
  </div>
`;
}

// ---------- Singapore Savings Bonds ----------
function ssbPage(ssb, sgs) {
  if (!ssb) {
    const body = `  <section class="hero"><div class="kicker">🇸🇬 Singapore Savings Bonds</div><h1 class="serif" style="font-size:30px">SSB rates</h1>
    <p class="sub">Live SSB rates from MAS are temporarily unavailable — please check back shortly.</p></section>`;
    return shell('Singapore Savings Bonds (SSB) Rates | StockKaki', 'Latest Singapore Savings Bonds interest rates.', SITE + '/ssb/', body);
  }
  const c = ssb.current;
  const open = daysTo(c.applyISO) >= 0;
  const dLeft = daysTo(c.applyISO);
  const statusHTML = open
    ? `<span class="ssb-status open"><span class="pulse"></span>Applications open · ${dLeft===0?'closes today 9pm':'closes in '+dLeft+' day'+(dLeft>1?'s':'')}</span>`
    : (daysTo(c.issueISO) >= 0
        ? `<span class="ssb-status closed">Applications closed · issues ${c.issueFmt||pretty(c.issueISO)}</span>`
        : `<span class="ssb-status closed">Latest issue · ${c.issueFmt||pretty(c.issueISO)}</span>`);

  // step-up schedule
  const stepRows = c.coupons.map((cp,i) => {
    const y = i+1, hl = (y===1||y===10) ? ' class="hl"' : '';
    return `        <tr${hl}><td class="date">Year ${y}</td><td class="r amt">${cp.toFixed(2)}%</td><td class="r yld">${c.returns[i].toFixed(2)}%</td></tr>`;
  }).join('\n');

  // recent issues (grid row: month+code, 1-yr, 10-yr avg, applied/offered, cut-off)
  const recentRows = ssb.recent.map(r => {
    const applied = (r.applied && r.size) ? 'S$'+r.applied.toFixed(0)+'m / '+r.size.toFixed(0)+'m' : '—';
    const meta = `1-yr ${r.y1.toFixed(2)}%  ·  ${applied!=='—' ? applied+' applied' : 'just opened'}`;
    return `        <div class="lrow">
          <span class="lr-name"><span class="lr-co">${monthYr(r.issueISO)}</span><span class="tick">${r.code}</span></span>
          <span class="lr-div">${r.y1.toFixed(2)}%</span>
          <span class="lr-yield">${r.y10.toFixed(2)}%</span>
          <span class="lr-amt">${applied}</span>
          <span class="lr-price">${r.cutoff!=null ? 'S$'+r.cutoff.toFixed(2) : '—'}</span>
          <span class="lr-meta">${meta}</span>
        </div>`;
  }).join('\n');

  // trend chart (inline SVG, no libs) — 1-yr rate vs 10-yr average return
  const S = ssb.series, n = S.length;
  const vals = S.flatMap(p => [p.y1, p.y10]);
  const lo = Math.floor(Math.min(...vals)*10)/10, hi = Math.ceil(Math.max(...vals)*10)/10, span = (hi-lo)||1;
  const W=640,H=210,PL=6,PR=46,PT=14,PB=26;
  const X = i => (PL+(W-PL-PR)*(n>1?i/(n-1):0));
  const Y = v => (PT+(H-PT-PB)*(1-(v-lo)/span));
  const poly = (k,col) => `<polyline fill="none" stroke="${col}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" points="${S.map((p,i)=>X(i).toFixed(1)+','+Y(p[k]).toFixed(1)).join(' ')}"/>`;
  const last = S[n-1];
  const chart = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;overflow:visible" role="img" aria-label="SSB 1-year and 10-year average return trend">
    <line x1="${PL}" y1="${Y(hi).toFixed(1)}" x2="${W-PR}" y2="${Y(hi).toFixed(1)}" stroke="var(--line)"/>
    <line x1="${PL}" y1="${Y(lo).toFixed(1)}" x2="${W-PR}" y2="${Y(lo).toFixed(1)}" stroke="var(--line)"/>
    <text x="${W-PR+6}" y="${(Y(hi)+4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'JetBrains Mono',monospace">${hi.toFixed(1)}%</text>
    <text x="${W-PR+6}" y="${(Y(lo)+4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'JetBrains Mono',monospace">${lo.toFixed(1)}%</text>
    ${poly('y1','#3E8FB0')}
    ${poly('y10','var(--accent)')}
    <circle cx="${X(n-1).toFixed(1)}" cy="${Y(last.y10).toFixed(1)}" r="3.5" fill="var(--accent)"/>
    <circle cx="${X(n-1).toFixed(1)}" cy="${Y(last.y1).toFixed(1)}" r="3.5" fill="#3E8FB0"/>
    <text x="${PL}" y="${H-8}" fill="var(--muted)" font-size="11" font-family="'JetBrains Mono',monospace">${monthYr(S[0].issueISO)}</text>
    <text x="${(W-PR).toFixed(1)}" y="${H-8}" fill="var(--muted)" font-size="11" text-anchor="end" font-family="'JetBrains Mono',monospace">${monthYr(last.issueISO)}</text>
  </svg>`;

  const faqs = [
    { q: 'What is the Singapore Savings Bond interest rate this month?', a: `The current issue (${c.code}, issued ${c.issueFmt||pretty(c.issueISO)}) pays ${c.y1.toFixed(2)}% in the first year and a ${c.y10.toFixed(2)}% average return per year if held for the full 10 years.` },
    { q: 'How does the SSB step-up interest work?', a: `SSB interest "steps up" the longer you hold. This issue starts at ${c.coupons[0].toFixed(2)}% in year 1 and rises to ${c.coupons[9].toFixed(2)}% in year 10, so your average return grows from ${c.returns[0].toFixed(2)}% to ${c.returns[9].toFixed(2)}% per year over the 10 years.` },
    { q: 'How do I buy Singapore Savings Bonds?', a: 'Apply through DBS/POSB, OCBC or UOB internet banking or ATM, or with your SRS funds. Minimum S$500, in multiples of S$500, up to S$200,000 held in total. Applications usually close on the 4th-last business day of the month.' },
    { q: 'Can I withdraw my Savings Bond early?', a: 'Yes. You can redeem in any month with no penalty and get your full principal back plus any accrued interest — one reason SSBs are considered very low risk. They are fully backed by the Singapore Government.' },
    { q: 'How is SSB interest paid?', a: 'Interest is paid every 6 months into your bank account, starting six months from the issue date.' },
  ];
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f=>`<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const ld = { "@context":"https://schema.org","@graph":[
    { "@type":"BreadcrumbList","itemListElement":[
      { "@type":"ListItem","position":1,"name":"StockKaki","item":`${SITE}/` },
      { "@type":"ListItem","position":2,"name":"Singapore Savings Bonds","item":`${SITE}/ssb/` } ] },
    { "@type":"FAQPage","mainEntity":faqs.map(f=>({ "@type":"Question","name":f.q,"acceptedAnswer":{ "@type":"Answer","text":f.a } })) } ] };
  const jsonLd = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\u003c')}</script>`;

  const body = `  <section class="hero" style="padding-bottom:2px">
    <div class="crumb"><a href="/">StockKaki</a> › Singapore Savings Bonds</div>
    <div class="kicker">🇸🇬 Singapore Savings Bonds</div>
    <h1 class="serif" style="font-size:30px">Singapore Savings Bonds (SSB)</h1>
    <p class="sub">This month's SSB rate, the full 10-year step-up, and how much you'd earn — straight from MAS, updated every issue.</p>
  </section>
  <div class="ssb-card">
    ${statusHTML}
    <div class="ssb-stats">
      <div class="bigstat"><div class="k">1st-year interest</div><div class="v">${c.y1.toFixed(2)}%</div><div class="cap">if you hold for 1 year</div></div>
      <div class="bigstat"><div class="k">10-year average return</div><div class="v">${c.y10.toFixed(2)}%</div><div class="cap">per year, held to maturity</div></div>
      <div class="bigstat alt"><div class="k">Issue</div><div class="v" style="font-size:20px;margin-top:10px">${c.code}</div><div class="cap">issued ${c.issueFmt||pretty(c.issueISO)}${open?` · apply by ${c.applyFmt||pretty(c.applyISO)}`:''}</div></div>
    </div>
    <div class="facts">
      <span class="fact">Min <b>S$500</b></span>
      <span class="fact">Max <b>S$200,000</b></span>
      <span class="fact"><b>Redeem anytime</b>, no penalty</span>
      <span class="fact"><b>SG-Government</b> backed</span>
      <span class="fact">Interest paid <b>every 6 months</b></span>
    </div>
    <p class="ssb-meta">Apply via DBS/POSB, OCBC or UOB (internet banking / ATM) or with SRS funds. Rates are the same at every bank — they're set by MAS.</p>
  </div>
${projCard(ssb, sgs)}
  <div class="h2">How much you'd earn</div>
  <div class="ssb-card" style="border-left-color:var(--line)">
    <div class="calc">
      <div class="f"><label for="amt">You invest (S$)</label><input id="amt" type="number" min="500" step="500" value="10000"></div>
      <div class="f"><label for="yrs">You hold for</label><select id="yrs">${Array.from({length:10},(_,i)=>`<option value="${i+1}"${i===9?' selected':''}>${i+1} year${i?'s':''}</option>`).join('')}</select></div>
    </div>
    <div class="calc-out">
      <div class="bigstat"><div class="k">Total interest</div><div class="v" id="oInt">—</div><div class="cap" id="oPaid"></div></div>
      <div class="bigstat alt"><div class="k">Average return</div><div class="v" id="oRate">—</div><div class="cap">per year over the period</div></div>
    </div>
    <p class="ssb-meta">Based on the current issue (${c.code}). Interest is paid out every 6 months; figures assume you hold the whole period and don't reinvest the coupons.</p>
  </div>

  <div class="h2">Interest rate step-up — issue ${c.code}</div>
  <div class="card"><table class="stepup">
    <thead><tr><th>If you hold…</th><th class="r">Interest that year</th><th class="r">Average return / year</th></tr></thead>
    <tbody>
${stepRows}
    </tbody>
  </table></div>
  <p class="metaline" style="font-size:12px">The longer you hold, the higher the rate — that's the SSB "step-up". Average return is what you'd earn per year if you redeem at the end of that year.</p>

  <div class="h2">SSB rate trend</div>
  <div class="chartwrap">
    <div class="leg"><span><i style="background:var(--accent)"></i>10-year average return</span><span><i style="background:#3E8FB0"></i>1st-year interest</span></div>
    ${chart}
  </div>

  <div class="h2">Recent issues</div>
  <div class="ltable cols-ssbr">
    <div class="lrow lhead"><span>Issue</span><span class="lr-div">1-yr</span><span class="lr-yield">10-yr avg</span><span class="lr-amt">Applied / offered</span><span class="lr-price">Cut-off</span></div>
${recentRows}
  </div>
  <p class="metaline" style="font-size:12px">Data from the Monetary Authority of Singapore (MAS), updated each issue. Not financial advice — see <a href="/disclaimer/" style="color:var(--accent-dk)">disclaimer</a>.</p>

  ${faqHTML}
  ${jsonLd}`;

  const script = `<script>
const CPN=${JSON.stringify(c.coupons)},RET=${JSON.stringify(c.returns)};
const amt=document.getElementById('amt'),yrs=document.getElementById('yrs');
function fmt(n){return n.toLocaleString('en-SG',{maximumFractionDigits:0});}
function calc(){let p=parseFloat(amt.value)||0,y=parseInt(yrs.value,10);
 let sum=0;for(let i=0;i<y;i++)sum+=CPN[i];
 let interest=p*sum/100;
 document.getElementById('oInt').textContent='S$'+fmt(interest);
 document.getElementById('oRate').textContent=RET[y-1].toFixed(2)+'%';
 document.getElementById('oPaid').textContent='over '+y+' year'+(y>1?'s':'');}
amt.addEventListener('input',calc);yrs.addEventListener('change',calc);calc();
</script>`;
  return shell('Singapore Savings Bonds (SSB) Rates This Month — 1-Year & 10-Year Returns | StockKaki',
    `Latest Singapore Savings Bonds rates: ${c.y1.toFixed(2)}% first-year and ${c.y10.toFixed(2)}% 10-year average return (issue ${c.code}). Full step-up schedule, rate trend and a returns calculator. From MAS, updated each issue.`,
    SITE + '/ssb/', body, script);
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

// ---------- confirm / unsubscribe utility pages ----------
function utilPage(title, rpc, okMsg, okSub, dupMsg) {
  const body = `  <section class="hero" style="padding-bottom:6px">
    <h1 class="serif" style="font-size:28px" id="msg">One moment…</h1>
    <p class="sub" id="sub"></p>
    <p style="margin-top:16px"><a href="/" style="color:var(--accent-dk);font-weight:600">&rarr; Back to StockKaki</a></p>
  </section>`;
  const script = `<script type="module">
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const sb=createClient('${SUPABASE_URL}','${SUPABASE_ANON}');
const t=new URLSearchParams(location.search).get('t');
const M=document.getElementById('msg'),S=document.getElementById('sub');
if(!t){M.textContent='Invalid link';}
else{const{data,error}=await sb.rpc('${rpc}',{p_token:t});
 if(error){M.textContent='Something went wrong';S.textContent='Please try again later.';}
 else if(data){M.textContent=${JSON.stringify(okMsg)};S.textContent=${JSON.stringify(okSub)};}
 else{M.textContent=${JSON.stringify(dupMsg)};}}
</script>`;
  return shell(title + ' | StockKaki', title, SITE + '/', body, script);
}

// ---------- build ----------
const secList = fetchSecurities();
const secByNorm = new Map();
for (const s of secList) { const k = secNorm(s.name); if (k && !secByNorm.has(k)) secByNorm.set(k, s); }
const ssb = fetchSSB();           // Singapore Savings Bonds (MAS)
const sgs = fetchSGSYields();     // SGS benchmark yields → project the next SSB issue
const raw = await fetchRaw(50);   // ~5-6 years of history
SCRIP = collectScrip(raw);        // stocks whose trailing distributions hide the amount (scrip/DRP)
const rows = parseDividends(raw);
for (const r of rows) { const m = matchTicker(r.name, secByNorm); if (m) { r.ticker = m.ticker; r.price = m.price; r.secType = m.type; r.chgPct = m.chgPct; r.vol = m.vol; r.cur = m.cur; } }
const divCompanies = groupCompanies(rows);
const anns = parseAnnouncements(raw);

// MASTER list = every SGX security, with dividend data merged where names match.
const divByNorm = new Map();
for (const c of divCompanies.values()) { const k = secNorm(c.name); if (k && !divByNorm.has(k)) divByNorm.set(k, c); }
const companies = [];
const seenSlug = new Set(), usedDiv = new Set();
for (const s of secList) {
  const dc = divByNorm.get(secNorm(s.name));
  const slug = dc ? dc.slug : slugify(s.name);
  if (!slug || seenSlug.has(slug)) continue; seenSlug.add(slug);
  if (dc) usedDiv.add(dc.slug);
  const cur = s.cur || 'SGD';
  const divs = dc ? dc.divs : [];
  const ttm = divs.filter(d => d.ccy===cur && d.exISO>=yearAgo && d.exISO<=TODAY).reduce((a,d)=>a+d.amtNum,0);   // yield in the counter's own currency (USD price ÷ USD dividend)
  const isReit = s.type==='reits' || s.type==='businesstrusts' || (s.type!=='etfs' && /\breit\b|\btrust\b/i.test(s.name));
  const incomplete = isReit && divIncomplete(slug);
  companies.push({
    name: dc ? dc.name : s.name, slug,
    ticker: s.ticker, price: s.price, cur, chgPct: s.chgPct, vol: s.vol, secType: s.type, isReit,
    divs, ttm, divIncomplete: incomplete, yieldPct: (s.price>0 && ttm>0 && !incomplete) ? ttm/s.price*100 : null,
  });
}
for (const c of divCompanies.values()) { if (usedDiv.has(c.slug) || seenSlug.has(c.slug)) continue; seenSlug.add(c.slug); companies.push(c); }

const upcoming = rows.filter(r => r.exISO >= TODAY).sort((a,b)=> a.exISO<b.exISO?-1:1)
  .map(r => { const c = divCompanies.get(r.slug); return { ...r, yieldPct: c?c.yieldPct:null, isReit: c?c.isReit:false, divIncomplete: c?c.divIncomplete:divIncomplete(r.slug) }; });
const index = companies.map(c => ({ n: c.name, t: c.ticker||'', s: c.slug })).sort((a,b)=> a.n<b.n?-1:1);

const out = new URL('./dist/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['favicon.svg', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png', 'favicon.ico', 'og.png']) copyFileSync(new URL(`assets/${f}`, import.meta.url), new URL(f, out));
writeFileSync(new URL('index.html', out), homepage(upcoming, index));
writeFileSync(new URL('CNAME', out), 'stockkaki.com\n');
mkdirSync(new URL('disclaimer/', out), { recursive: true });
writeFileSync(new URL('disclaimer/index.html', out), disclaimerPage());

let n = 0;
for (const c of companies) {
  const dir = new URL(`stock/${c.slug}/`, out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('index.html', dir), stockPage(c));
  n++;
}
const all = companies;
const listed = all.filter(c => c.ticker);                                   // currently trading on SGX (has a live counter)
// Screener = listed counters that pay NOW (trailing-12-month distribution, or a REIT scrip payer) — so every row has a real number, no blanks.
const dividendStocks = listed.filter(c => c.ttm > 0 || c.divIncomplete);
mkdirSync(new URL('screener/', out), { recursive: true });
writeFileSync(new URL('screener/index.html', out), listPage({
  title: 'Best Dividend Stocks in Singapore 2026 — Highest SGX Dividend Yields | StockKaki',
  desc: 'The highest-yielding SGX dividend stocks and REITs, ranked by dividend yield and updated daily. Search, filter and compare the best Singapore dividend stocks — free, no clutter.',
  kicker: 'Screener · Rankings', h1: 'Best dividend stocks in Singapore', sub: `${dividendStocks.length} SGX counters currently paying dividends — ranked by yield, updated daily. (Search any of ${listed.length} listed stocks above.)`,
  list: dividendStocks, canon: SITE + '/screener/', typeChips: true }));
mkdirSync(new URL('reits/', out), { recursive: true });
const reitList = listed.filter(c => c.isReit);
writeFileSync(new URL('reits/index.html', out), listPage({
  title: 'Singapore REIT Dividends & Distribution Yields | StockKaki',
  desc: 'All SGX-listed REITs and business trusts ranked by distribution yield. Live from SGX, updated daily.',
  kicker: 'S-REITs', h1: 'Singapore REITs by yield', sub: `All ${reitList.length} SGX-listed REITs and business trusts, ranked by distribution yield.`,
  list: reitList, canon: SITE + '/reits/', typeChips: false }));
mkdirSync(new URL('announcements/', out), { recursive: true });
writeFileSync(new URL('announcements/index.html', out), announcementsPage(anns));
mkdirSync(new URL('ssb/', out), { recursive: true });
writeFileSync(new URL('ssb/index.html', out), ssbPage(ssb, sgs));
mkdirSync(new URL('confirm/', out), { recursive: true });
writeFileSync(new URL('confirm/index.html', out), utilPage('Confirm your alerts', 'confirm_subscriber', "You're in! 🦁", "You'll get StockKaki dividend & ex-date alerts.", 'Already confirmed (or the link expired).'));
mkdirSync(new URL('unsubscribe/', out), { recursive: true });
writeFileSync(new URL('unsubscribe/index.html', out), utilPage('Unsubscribe', 'unsubscribe', 'Unsubscribed', 'You will no longer receive StockKaki emails.', 'Already unsubscribed.'));
mkdirSync(new URL('api/', out), { recursive: true });
writeFileSync(new URL('api/upcoming.json', out), JSON.stringify(upcoming.map(r => ({ name: r.name, ticker: r.ticker || null, amt: money(r.ccy, r.amt), ex: r.exISO, slug: r.slug }))));

const urls = [SITE + '/', SITE + '/screener/', SITE + '/reits/', SITE + '/ssb/', SITE + '/announcements/', SITE + '/disclaimer/', ...all.map(c => `${SITE}/stock/${c.slug}/`)];
writeFileSync(new URL('sitemap.xml', out),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n') + `\n</urlset>\n`);
writeFileSync(new URL('robots.txt', out), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(new URL('llms.txt', out), `# StockKaki — Singapore dividend & stock tracker
> Free, clean tool for SGX dividends, ex-dates, yields and stock info. Data sourced from the Singapore Exchange (SGX), updated daily. Not financial advice.

## Key pages
- Upcoming SGX dividends & ex-dates: ${SITE}/
- Best dividend stocks (screener, ranked by yield): ${SITE}/screener/
- Singapore REITs by distribution yield: ${SITE}/reits/
- Singapore Savings Bonds (SSB) rates, step-up schedule & returns calculator: ${SITE}/ssb/
- SGX corporate actions / announcements: ${SITE}/announcements/
- Per-stock pages (price, dividend history, yield, ex-dates) for all ${all.length} SGX counters: ${SITE}/stock/<slug>/ — full list in ${SITE}/sitemap.xml

## What each stock page answers
- Latest last price, day change and volume
- Next ex-date, amount and pay date
- Dividend history (up to ~6 years) and dividends-by-year with indicative yield
- Trailing-12-month dividend and indicative yield (TTM dividends / last price)
- Pay frequency and year-over-year dividend growth

## Notes
- Yields are indicative (trailing 12-month dividends / last price). Verify against official SGX announcements.
- Disclaimer: ${SITE}/disclaimer/
`);

console.log(`Built: homepage (${upcoming.length} upcoming, ${index.length} in search) + ${n} stock pages + sitemap (${urls.length} urls).`);
