#!/usr/bin/env node
/*
 * StockKaki static-site builder.
 * Fetches Singapore dividends from SGX's public corporate-actions API and
 * generates: homepage (upcoming board with search + filters), one page per
 * stock (dividend history, annual summary, next ex-date, yield), sitemap.xml
 * and robots.txt. Run daily via GitHub Action.  node build.mjs
 */
import { writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

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
const fmtCap = (cur, n) => { if (!n) return null; const s = csym(cur); return n>=1e9 ? s+(n/1e9).toFixed(2)+'B' : n>=1e6 ? s+(n/1e6).toFixed(0)+'M' : s+n.toFixed(0); };
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
// ---------- Yahoo Finance dividends (.SI) — accurate DPU incl. scrip REITs (free) ----------
function fetchYahooDivs(ticker) {
  let j; try { j = JSON.parse(execFileSync('curl', ['-s','-m','20','-A',UA,'--compressed', `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.SI?range=10y&interval=1wk&events=div`], { maxBuffer: 16*1024*1024 }).toString('utf8')); } catch { return null; }
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.meta) return null;
  const cur = r.meta.currency || 'SGD';
  const divs = [];
  const ev = r.events && r.events.dividends;
  if (ev) for (const d of Object.values(ev)) { if (d && d.amount > 0) divs.push({ exISO: new Date(d.date*1000).toISOString().slice(0,10), amount: d.amount }); }
  divs.sort((a,b) => a.exISO < b.exISO ? 1 : -1);
  const m = r.meta;
  const meta = { w52lo: m.fiftyTwoWeekLow, w52hi: m.fiftyTwoWeekHigh, dayLo: m.regularMarketDayLow, dayHi: m.regularMarketDayHigh, vol: m.regularMarketVolume, price: m.regularMarketPrice };
  const ts = r.timestamp || [], cl = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  const prices = [];
  for (let i = 0; i < ts.length; i++) if (cl[i] != null) prices.push({ t: ts[i], c: cl[i] });    // weekly closes for the price chart
  return { cur, divs, meta, prices };
}
// Yahoo cookie+crumb (needed for the fundamentals/quote endpoint) — fetched once per build.
function yahooCrumb() {
  const cj = tmpdir() + '/sk_yahoo_cookies.txt';
  try {
    execFileSync('curl', ['-s','-m','20','-A',UA,'-c',cj,'https://fc.yahoo.com/','-o','/dev/null']);
    const crumb = execFileSync('curl', ['-s','-m','20','-A',UA,'-b',cj,'-c',cj,'https://query2.finance.yahoo.com/v1/test/getcrumb']).toString().trim();
    if (crumb && crumb.length < 40 && !/[<{]/.test(crumb)) return { crumb, cj };
  } catch {}
  return null;
}
// Batch fundamentals (market cap, P/E, P/B, EPS, 52-week) — up to 50 symbols per call.
function fetchYahooQuotes(tickers, cr) {
  const map = {};
  if (!cr) return map;
  for (let i = 0; i < tickers.length; i += 50) {
    const syms = tickers.slice(i, i+50).map(t => encodeURIComponent(t)+'.SI').join(',');
    let rs; try { rs = JSON.parse(execFileSync('curl', ['-s','-m','25','-A',UA,'-b',cr.cj, `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms}&crumb=${encodeURIComponent(cr.crumb)}`], { maxBuffer: 16*1024*1024 }).toString()).quoteResponse.result; } catch { rs = null; }
    if (rs) for (const r of rs) { const t = (r.symbol||'').replace(/\.SI$/,''); if (t) map[t] = { mktCap:r.marketCap, pe:r.trailingPE, pb:r.priceToBook, eps:r.epsTrailingTwelveMonths, w52lo:r.fiftyTwoWeekLow, w52hi:r.fiftyTwoWeekHigh, dayLo:r.regularMarketDayLow, dayHi:r.regularMarketDayHigh, vol:r.regularMarketVolume, chg:r.regularMarketChangePercent, cur:r.currency }; }
  }
  return map;
}
const decodeEntities = (s) => (s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;|&#0?39;|&#x27;/g,"'").replace(/&#([0-9]+);/g,(_,n)=>String.fromCharCode(+n)).trim();
function fetchYahooNews(ticker) {
  let xml; try { xml = execFileSync('curl', ['-s','-m','15','-A',UA, `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}.SI&region=SG&lang=en-SG`], { maxBuffer: 8*1024*1024 }).toString('utf8'); } catch { return []; }
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const title = decodeEntities((it.match(/<title>([\s\S]*?)<\/title>/)||[])[1] || '');
    const link = ((it.match(/<link>([\s\S]*?)<\/link>/)||[])[1] || '').trim();
    const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)||[])[1];
    const desc = decodeEntities((it.match(/<description>([\s\S]*?)<\/description>/)||[])[1] || '').replace(/<[^>]+>/g,'').slice(0,180);
    if (!title || !link || NEWS_JUNK.test(title)) continue;
    let dateISO = null; try { if (pub) dateISO = new Date(pub).toISOString().slice(0,10); } catch {}
    out.push({ title, link, dateISO, desc, source: 'Yahoo Finance' });
    if (out.length >= 6) break;
  }
  return out;
}
// ---------- Google News (free, no key): per-company SG financial news, aggregating BT / The Edge / Straits Times / CNA / Reuters etc. ----------
// Reliable financial/business press ONLY — established outlets, no auto-generated/aggregator/broker blogs.
const NEWS_OK = new Set(['The Business Times','The Business Times Singapore','The Edge Singapore','The Edge Malaysia','The Straits Times','Straits Times','CNA','Channel NewsAsia','Reuters','Bloomberg','Yahoo Finance','Yahoo Finance Singapore','Nikkei Asia','Financial Times','CNBC','South China Morning Post','MarketWatch','Business Insider','Forbes','Singapore Business Review','DealStreetAsia','Barron\'s','The Motley Fool Singapore','Singapore Exchange (SGX)','SGX']);
const cleanCoName = (name) => (name||'').replace(/\b(Ltd|Limited|Pte|Plc|Corp|Corporation|Holdings?|Group|Berhad|Bhd|Inc|Company|Co)\b\.?/gi,'').replace(/\bCNY|USD|SGD|HKD|GBP|EUR\b/g,'').replace(/\s{2,}/g,' ').trim();
// Auto-generated "metric" pages (TradingView/GuruFocus etc.) — not real news; drop them.
const NEWS_JUNK = /^(price to (book|sales|earnings|cash|free cash)|enterprise value to|return on (equity|assets|capital)|peg ratio|debt to equity|(forward |trailing )?(p\/e|pe|pb|p\/b|ev\/ebitda) (ratio|forward)|net (profit )?margin|gross margin|current ratio|quick ratio)\b/i;
// Guard against ambiguous-ticker false matches (e.g. "GRC" pulling Singapore political news): keep a headline
// only if a significant word from the company name actually appears in the title.
const _nameTokens = (name) => cleanCoName(name).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
const titleHasCo = (title, name) => { const toks = _nameTokens(name); if (!toks.length) return true; const t = ' ' + (title||'').toLowerCase() + ' '; return toks.some(tok => new RegExp('\\b' + tok.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\b').test(t)); };
function fetchGoogleNews(name) {
  const q = encodeURIComponent(`"${cleanCoName(name)}" (SGX OR Singapore OR dividend)`);
  let xml; try { xml = execFileSync('curl', ['-s','-m','15','-A',UA, `https://news.google.com/rss/search?q=${q}&hl=en-SG&gl=SG&ceid=SG:en`], { maxBuffer: 12*1024*1024 }).toString('utf8'); } catch { return []; }
  const good = [], rest = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    let title = decodeEntities((it.match(/<title>([\s\S]*?)<\/title>/)||[])[1] || '');
    const link = ((it.match(/<link>([\s\S]*?)<\/link>/)||[])[1] || '').trim();
    const source = decodeEntities((it.match(/<source[^>]*>([\s\S]*?)<\/source>/)||[])[1] || '').trim();
    const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)||[])[1];
    if (!title || !link) continue;
    title = title.replace(new RegExp('\\s*-\\s*' + source.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\s*$'), '').trim();   // Google appends " - Source"
    if (NEWS_JUNK.test(title)) continue;                                  // skip auto-generated metric pages
    let dateISO = null; try { if (pub) dateISO = new Date(pub).toISOString().slice(0,10); } catch {}
    const item = { title, link, dateISO, source, desc: '' };
    (NEWS_OK.has(source) ? good : rest).push(item);
  }
  const merged = [...good, ...rest.slice(0, Math.max(0, 3 - good.length))];   // prefer quality outlets; backfill lightly so it's never empty
  return merged.slice(0, 6);
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
      alloted: +l.amt_alloted || null, rndmRate: +l.rndm_alloted_rate || 0,
    };
  }).filter(r => r.issueISO && r.y1 != null).sort((a,b) => a.issueISO < b.issueISO ? 1 : -1);
  if (!rows.length) return null;
  const held = (iso) => Math.max(0, Math.min(9, Math.floor((Date.parse(TODAY) - Date.parse(iso)) / (365.25*86400000))));
  const issued = rows.filter(r => r.issueISO <= TODAY).map(r => ({ code: r.code, ym: monthYr(r.issueISO), held: held(r.issueISO), coupons: r.coupons }));
  const allot = rows.find(r => r.applied > 0) || null;                        // latest issue with published results
  let streak = 0; for (const r of rows) { if (r.applied == null) continue; if (r.rndmRate > 0) break; streak++; }   // consecutive fully-allotted issues
  return { current: rows[0], recent: rows.slice(0, 12), series: rows.slice(0, 36).reverse(), issued, allot, streak };
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
const CLOSE = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
const WA = `<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.4A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1 1 12 20zm4.4-6c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1-.6.8-.8 1-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4.2-.4.6-1.2.1-.2 0-.3 0-.5s-.5-1.3-.7-1.8-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3A3 3 0 0 0 6.3 10a5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c2 .8 2 .6 2.4.5a2.6 2.6 0 0 0 1.7-1.2 2 2 0 0 0 .2-1.2c-.1-.1-.3-.2-.5-.3z"/></svg>`;
// TODO(Eugene): paste your WhatsApp channel/community invite link here to activate the "Join channel" button.
const WHATSAPP_URL = 'https://whatsapp.com/channel/';
const NAVLINKS = `<a href="/dividends/">Dividends</a><a href="/reits/">REITs</a><a href="/etfs/">ETFs</a><a href="/dividend-calendar/">Calendar</a><a href="/ssb/">SSB</a><a href="/news/">News</a>`;
const NAV = `<header class="nav">
  <div class="wrap row">
  <a class="brand" href="/"><span class="dot">${CUP}</span> StockKaki</a>
  <nav>${NAVLINKS}</nav>
  <div style="display:flex;align-items:center;gap:6px"><button id="themeBtn" class="tbtn" aria-label="Toggle dark mode">${MOON}${SUN}</button><a class="btn wa deskonly" href="${WHATSAPP_URL}" target="_blank" rel="noopener">${WA} Join channel</a><button id="mtoggle" class="tbtn mtoggle" aria-label="Menu">${BURGER}</button></div>
  </div>
</header>
<div id="mscrim" class="mscrim"></div>
<aside id="mmenu" class="mmenu" aria-hidden="true">
  <div class="mmenu-head"><a class="brand" href="/"><span class="dot">${CUP}</span> StockKaki</a><button id="mclose" class="tbtn" aria-label="Close menu">${CLOSE}</button></div>
  <nav class="mmenu-links">${NAVLINKS}</nav>
  <div class="mmenu-cta"><a class="btn wa" href="${WHATSAPP_URL}" target="_blank" rel="noopener">${WA} Join channel</a></div>
</aside>`;
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
// Affiliate/broker slot hidden until real partners are set up (Eugene, 2026-07). Re-enable by restoring the markup below.
const brokerSlot = () => '';
/* const brokerSlot = () => `<aside class="brokers">
    <div class="bk-h"><span class="bk-t">Start collecting dividends</span><span class="bk-ad">Affiliate</span></div>
    <p class="bk-sub">Open a brokerage account to buy SGX dividend stocks — compare popular options:</p>
    <div class="bk-list">
${BROKERS.map(b => `      <a class="bk" href="${b.u}" target="_blank" rel="sponsored noopener"><b>${b.n}</b><span>${b.d}</span></a>`).join('\n')}
    </div>
  </aside>`; */
// TODO(Eugene): make "HeyAda" clickable — wrap in <a href="https://…">HeyAda</a> once the URL is confirmed.
const FOOTER = `<footer><p class="disc">© 2026 StockKaki · brand by HeyAda · <a href="/disclaimer/" style="color:var(--accent-dk);font-weight:600">Disclaimer</a></p></footer>`;

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
  .btn.wa.deskonly{display:none} @media(min-width:820px){ .btn.wa.deskonly{display:inline-flex} }
  .mtoggle{display:inline-flex} @media(min-width:820px){ .mtoggle{display:none} }
  .mscrim{position:fixed;inset:0;background:rgba(20,14,10,.55);opacity:0;visibility:hidden;transition:opacity .25s ease;z-index:40}
  .mscrim.open{opacity:1;visibility:visible}
  .mmenu{position:fixed;top:0;bottom:0;right:0;width:min(82vw,300px);background:var(--card);border-left:1px solid var(--line);box-shadow:-16px 0 44px -20px rgba(0,0,0,.5);transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1);z-index:50;display:flex;flex-direction:column}
  .mmenu.open{transform:translateX(0)}
  .mmenu-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 12px 20px;border-bottom:1px solid var(--line)} .mmenu-head .brand{font-size:18px}
  .mmenu-links{display:flex;flex-direction:column}
  .mmenu-links a{display:block;padding:15px 22px;border-bottom:1px solid var(--line);color:var(--ink);font-weight:500;font-size:16px;opacity:0;transform:translateX(14px);transition:opacity .3s ease,transform .3s ease} .mmenu-links a:hover{background:var(--row-hover);color:var(--accent-dk)}
  .mmenu.open .mmenu-links a{opacity:1;transform:none}
  .mmenu.open .mmenu-links a:nth-child(1){transition-delay:.04s}.mmenu.open .mmenu-links a:nth-child(2){transition-delay:.08s}.mmenu.open .mmenu-links a:nth-child(3){transition-delay:.12s}.mmenu.open .mmenu-links a:nth-child(4){transition-delay:.16s}.mmenu.open .mmenu-links a:nth-child(5){transition-delay:.2s}.mmenu.open .mmenu-links a:nth-child(6){transition-delay:.24s}
  .mmenu-cta{margin-top:auto;padding:18px 20px 26px} .mmenu-cta .btn.wa{display:flex;width:100%;justify-content:center;padding:13px}
  .btn.wa{display:inline-flex;align-items:center;gap:6px;background:#25D366;color:#fff} .btn.wa:hover{background:#1fb857}
  @media(min-width:820px){ .mmenu,.mscrim{display:none!important} }
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
  .hint{margin-top:12px;font-size:12.5px;color:var(--muted);font-family:'JetBrains Mono',monospace}
  .live .pulse{width:7px;height:7px;border-radius:50%;background:var(--accent)}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:18px 0 6px;scrollbar-width:none} .chips::-webkit-scrollbar{display:none}
  .chip{white-space:nowrap;font-size:13px;font-weight:500;color:var(--muted);background:var(--card);border:1px solid var(--line);padding:7px 14px;border-radius:999px;cursor:pointer;user-select:none}
  .chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
  .nextcard{margin:18px 0 4px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:18px 22px;display:flex;flex-wrap:wrap;gap:28px;align-items:center}
  .nextcard .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600} .nextcard .v{font-family:'JetBrains Mono',monospace;font-weight:600;font-size:18px;margin-top:3px}
  .metaline{color:var(--muted);font-size:13.5px;margin-top:14px} .metaline b{color:var(--ink);font-family:'JetBrains Mono',monospace}
  .h2{font-family:'Poppins',sans-serif;font-weight:600;font-size:16px;margin:26px 0 10px}
  .faq{max-width:760px} .faq-q{font-weight:600;margin-top:16px} .faq-a{color:var(--muted);font-size:14.5px;margin-top:4px;line-height:1.7}
  .intro{max-width:730px;color:var(--muted);font-size:14.5px;line-height:1.75;margin:2px 0 6px} .intro b{color:var(--ink)} .intro a{color:var(--accent-dk);font-weight:600}
  .tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:20px 0 0;overflow-x:auto;scrollbar-width:none} .tabs::-webkit-scrollbar{display:none}
  .tab{background:none;border:0;border-bottom:2px solid transparent;padding:11px 16px;margin-bottom:-1px;font-family:'Poppins',sans-serif;font-size:15px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap} .tab.on{color:var(--ink);border-bottom-color:var(--accent)} .tab:hover{color:var(--ink)}
  .tabpane[hidden]{display:none}
  .ovgrid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-top:16px} @media(min-width:620px){.ovgrid{grid-template-columns:repeat(3,1fr)}}
  .ovstat{display:flex;flex-direction:column;gap:4px;padding:14px 16px;background:var(--card)}
  .ov-k{color:var(--muted);font-size:12px} .ov-v{font-family:'JetBrains Mono',monospace;font-weight:600;font-size:17px;color:var(--ink)}
  .ov-range{margin-top:22px} .ov-range-h{font-size:13px;color:var(--muted)}
  .ov-bar{position:relative;height:6px;background:var(--line);border-radius:3px;margin:14px 0 7px}
  .ov-mark{position:absolute;top:50%;width:13px;height:13px;border-radius:50%;background:var(--accent);transform:translate(-50%,-50%);box-shadow:0 0 0 3px var(--card)}
  .ov-range-f{display:flex;justify-content:space-between;font-size:11.5px;color:var(--muted);font-family:'JetBrains Mono',monospace}
  .newslist{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:4px 18px;box-shadow:0 12px 36px -28px rgba(58,42,32,.55);margin-top:16px}
  .annlist{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:4px 18px;box-shadow:0 12px 36px -28px rgba(58,42,32,.55);margin-top:16px}
  .annrow{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--line);align-items:flex-start} .annrow:last-child{border-bottom:0}
  .ann-type{flex:0 0 auto;padding-top:1px} .ann-body{min-width:0}
  .ann-p{font-size:14.5px;line-height:1.45} .ann-m{font-size:11.5px;color:var(--muted);margin-top:5px;font-family:'JetBrains Mono',monospace}
  .newsitem{display:block;padding:14px 0;border-bottom:1px solid var(--line);color:inherit} .newsitem:last-child{border-bottom:0}
  .news-t{display:block;font-weight:600;font-size:15px;line-height:1.4} .newsitem:hover .news-t{color:var(--accent-dk)}
  .news-d{display:block;font-size:13px;color:var(--muted);line-height:1.5;margin-top:5px}
  .news-m{display:block;font-size:11.5px;color:var(--muted);margin-top:6px;font-family:'JetBrains Mono',monospace}
  .ov-chart-h{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;color:var(--muted);margin:16px 0 4px} .ov-chart-h span:last-child{font-family:'JetBrains Mono',monospace;font-weight:600;font-size:16px;color:var(--ink)}
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
  .cols-trend .lrow{grid-template-columns:minmax(0,1fr) 92px 92px 74px}
  .cols-trend .lr-name{align-items:center}
  .lr-rank{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:23px;height:23px;border-radius:6px;background:var(--accent-soft);color:var(--accent-dk);font-family:'JetBrains Mono',monospace;font-weight:700;font-size:12px}
  /* home dashboard: adaptive dividend vs stock columns */
  .cols-home2.m-div .c-stk{display:none} .cols-home2.m-stk .c-div{display:none}
  .lr-mc,.lr-pe,.lr-chg{text-align:right;font-family:'JetBrains Mono',monospace;font-size:13.5px;white-space:nowrap} .lr-chg.up{color:#0c9a63} .lr-chg.down{color:#c0392b}
  .cols-home2.m-div .lrow{grid-template-columns:minmax(0,1fr) 86px 80px 98px 104px}
  .cols-home2.m-stk .lrow{grid-template-columns:minmax(0,1fr) 86px 120px 58px 84px}
  .lsort{display:none} .lsort[hidden]{display:none}
  @media(max-width:560px){
    .cols-screener .lrow,.cols-home .lrow,.cols-annc .lrow,.cols-ssbr .lrow,.cols-trend .lrow,.cols-home2.m-div .lrow,.cols-home2.m-stk .lrow{grid-template-columns:minmax(0,1fr) auto;row-gap:2px;padding:12px 14px}
    .lhead{display:none}
    .lr-price,.lr-div,.lr-ex,.lr-amt,.lr-exd,.lr-sub,.lr-mc,.lr-pe{display:none}
    .lr-name{grid-column:1;grid-row:1} .lr-name .tick{display:inline}
    .lr-yield{grid-column:2;grid-row:1;font-size:16px}
    .cols-home2.m-stk .lr-chg,.cols-trend .lr-chg{grid-column:2;grid-row:1;font-size:16px}
    .cols-trend .lr-yield{display:none}
    .cols-annc .lr-type{grid-column:2;grid-row:1;text-align:right}
    .lr-meta{display:block;grid-column:1/-1;grid-row:2;font-family:'JetBrains Mono',monospace;font-size:12.5px;color:var(--muted)}
    .lsort:not([hidden]){display:flex;gap:8px;margin:14px 0 -2px;overflow-x:auto;scrollbar-width:none} .lsort::-webkit-scrollbar{display:none}
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
  .bigstat.win{border-color:var(--accent);background:var(--accent-soft)}
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
  /* ---- home hub ---- */
  .hub-hero{padding:34px 0 6px} @media(max-width:560px){.hub-hero{padding:22px 0 4px}}
  .hub-hero h1{font-family:'Poppins',sans-serif;font-weight:700;font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:8px 0 10px;max-width:14ch} @media(max-width:560px){.hub-hero h1{font-size:27px}}
  .hub-hero .sub{color:var(--muted);font-size:15px;max-width:440px}
  .hub-search{position:relative;margin-top:18px;max-width:560px}
  .hub-search input{width:100%;border:1px solid var(--line);background:var(--card);border-radius:14px;padding:15px 16px 15px 46px;font-size:15px;font-family:inherit;color:var(--ink);box-shadow:0 10px 30px -22px rgba(58,42,32,.5)}
  .hub-search input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .hub-search .ic{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
  .trend{display:flex;gap:8px;align-items:center;margin-top:18px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px} .trend::-webkit-scrollbar{display:none}
  .trend .tl{color:var(--muted);font-size:13px;flex:0 0 auto}
  .tchip{flex:0 0 auto;white-space:nowrap;font-size:13px;font-weight:500;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 13px} .tchip:hover{border-color:var(--accent);background:var(--accent-soft)} .tchip b{color:var(--accent-dk);font-weight:600}
  .hub-h{font-family:'Poppins',sans-serif;font-weight:600;font-size:18px;margin:34px 0 12px;display:flex;align-items:baseline;justify-content:space-between}
  .hub-h a{font-size:13px;font-weight:500;color:var(--accent-dk)}
  .catgrid{display:grid;grid-template-columns:1fr;gap:12px} @media(min-width:620px){.catgrid{grid-template-columns:1fr 1fr}}
  .cat{display:flex;gap:14px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;transition:.15s} .cat:hover{border-color:var(--accent);background:var(--row-hover)}
  .cat .ci{width:44px;height:44px;flex:0 0 auto;border-radius:12px;background:var(--accent-soft);color:var(--accent-dk);display:flex;align-items:center;justify-content:center}
  .cat .ct{font-family:'Poppins',sans-serif;font-weight:600;font-size:15.5px;display:flex;align-items:center;gap:8px}
  .cat .cn{font-size:11.5px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--accent-dk);background:var(--accent-soft);border-radius:999px;padding:2px 8px}
  .cat .cd{font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.5} .cat .cd b{color:var(--ink);font-family:'JetBrains Mono',monospace}
  /* home trending: 2-row grid that scrolls sideways on mobile, 4-col wall on desktop */
  .trgrid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(2,1fr);grid-auto-columns:66%;gap:12px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px} .trgrid::-webkit-scrollbar{display:none}
  @media(min-width:720px){.trgrid{grid-auto-flow:row;grid-template-columns:repeat(4,1fr);grid-template-rows:none;grid-auto-columns:auto;overflow:visible}}
  .trwall{display:grid;grid-template-columns:1fr 1fr;gap:12px} @media(min-width:720px){.trwall{grid-template-columns:repeat(4,1fr)}}
  .trcard{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px 16px} .trcard:hover{border-color:var(--accent)}
  .tchip .up{color:#0c9a63} .tchip .down{color:#c0392b}
  .readmore{display:inline-block;margin-top:14px;font-size:14px;font-weight:600;color:var(--accent-dk)} .readmore:hover{text-decoration:underline}
  .hubnews .nd{font-size:13px;color:var(--muted);line-height:1.5;margin-top:5px}
  .pager{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:20px 0 4px}
  .pager .pg{font-family:inherit;font-size:13px;font-weight:600;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:9px;padding:8px 12px;cursor:pointer;min-width:38px}
  .pager .pg:hover:not([disabled]){border-color:var(--accent);color:var(--ink)} .pager .pg.on{background:var(--accent);color:#fff;border-color:var(--accent)} .pager .pg[disabled]{opacity:.4;cursor:default}
  .pager .pg-dots{color:var(--muted);align-self:center;padding:0 2px}
  .trcard .tn{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .trcard .tt{color:var(--muted);font-size:11px;font-family:'JetBrains Mono',monospace;margin-left:5px}
  .trcard .tp{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:19px;margin-top:8px}
  .trcard .tm{font-size:12px;margin-top:4px;font-family:'JetBrains Mono',monospace} .trcard .tm .ty{color:var(--accent-dk);font-weight:600} .trcard .tm .up{color:#0c9a63} .trcard .tm .down{color:#c0392b}
  .hubnews{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:2px 18px}
  .hubnews a{display:block;padding:15px 0;border-bottom:1px solid var(--line);color:inherit} .hubnews a:last-child{border-bottom:0}
  .hubnews .nt{font-weight:600;font-size:15px;line-height:1.4} .hubnews a:hover .nt{color:var(--accent-dk)}
  .hubnews .nm{font-size:11.5px;color:var(--muted);margin-top:6px;font-family:'JetBrains Mono',monospace}
  /* ---- category-page Top 10 block ---- */
  .pill-n{opacity:.72;font-weight:500;margin-left:2px}
  .top10{display:grid;grid-template-columns:1fr;gap:10px;margin-top:4px} @media(min-width:640px){.top10{grid-template-columns:1fr 1fr}}
  .t10{display:flex;align-items:center;gap:13px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 15px;transition:.15s} .t10:hover{border-color:var(--accent);background:var(--row-hover)}
  .t10 .rk{flex:0 0 auto;width:29px;height:29px;border-radius:9px;background:var(--accent-soft);color:var(--accent-dk);font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace}
  .t10.gold .rk{background:var(--accent);color:#fff}
  .t10 .ti{flex:1;min-width:0;display:block} .t10 .tn{display:block;font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .t10 .tn .tick{margin-left:5px}
  .t10 .ts{display:block;color:var(--muted);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .t10 .ty{flex:0 0 auto;text-align:right} .t10 .tyv{display:block;font-family:'JetBrains Mono',monospace;font-weight:700;font-size:16px;color:var(--accent-dk)} .t10 .tyv.mut{color:var(--muted);font-weight:600} .t10 .tp{display:block;font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-top:2px}
  /* ---- stock header: tags, actions, KPI strip ---- */
  .st-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .st-tags{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
  .st-tag{font-size:11.5px;font-weight:600;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:3px 9px} .st-tag.mono{font-family:'JetBrains Mono',monospace}
  .st-acts{flex:0 0 auto;display:flex;gap:8px}
  .st-save{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--accent-dk);background:var(--accent-soft);border:1px solid transparent;border-radius:999px;padding:8px 13px;cursor:pointer;font-family:inherit}
  .st-bell{display:inline-flex;align-items:center;justify-content:center;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:999px;width:37px;height:37px;cursor:pointer} .st-bell:hover{color:var(--accent-dk);border-color:var(--accent)}
  .st-kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:18px} @media(max-width:560px){.st-kpi{grid-template-columns:1fr 1fr}}
  .kbox{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:11px 13px}
  .kbox .kl{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
  .kbox .kv{font-family:'JetBrains Mono',monospace;font-size:17px;font-weight:700;margin-top:3px} .kbox .kv.acc{color:var(--accent-dk)}
  .st-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:var(--ink);color:var(--bg);font-size:13px;font-weight:500;padding:11px 18px;border-radius:999px;box-shadow:0 12px 30px -12px rgba(0,0,0,.5);opacity:0;visibility:hidden;transition:.25s ease;z-index:60} .st-toast.on{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}
`;
const SEARCH_IC = `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;

const shell = (title, desc, canon, body, script='', og='/og.png') => `<!DOCTYPE html>
<html lang="en"><head>
<script>(function(){try{var t=localStorage.getItem('theme');if(!t&&window.matchMedia)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="google-site-verification" content="GP6YGT1x9z7T6QlUkLDTXvfbGlqkocw2RSWOWmKkO1Q">
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#E07A3B">
<!-- Google Analytics (GA4) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-GQWYJ6T6DY"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-GQWYJ6T6DY');</script>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canon}">
<meta property="og:type" content="website"><meta property="og:site_name" content="StockKaki"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canon}"><meta property="og:image" content="${SITE}${og}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${SITE}${og}">
${FONTS}
<style>${STYLE}</style>
</head><body>
${NAV}
<main class="wrap">
${body}
${FOOTER}
</main>${script}<script>
var SBFN='${SUPABASE_URL}/functions/v1',SBK='${SUPABASE_ANON}';
(function(){
var b=document.getElementById('themeBtn');if(b)b.onclick=function(){var d=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',d);try{localStorage.setItem('theme',d);}catch(e){}};
var mt=document.getElementById('mtoggle'),mm=document.getElementById('mmenu'),ms=document.getElementById('mscrim'),mc=document.getElementById('mclose');
function toggleMenu(o){if(!mm)return;mm.classList.toggle('open',o);if(ms)ms.classList.toggle('open',o);mm.setAttribute('aria-hidden',o?'false':'true');document.body.style.overflow=o?'hidden':'';}
if(mt)mt.onclick=function(){toggleMenu(!mm.classList.contains('open'));};
if(ms)ms.onclick=function(){toggleMenu(false);};
if(mc)mc.onclick=function(){toggleMenu(false);};
if(mm)mm.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){toggleMenu(false);});});
document.querySelectorAll('.alert form').forEach(function(f){f.addEventListener('submit',function(ev){ev.preventDefault();var inp=f.querySelector('input');var e=(inp.value||'').trim();if(!e)return;var btn=f.querySelector('button');btn.textContent='…';btn.disabled=true;fetch(SBFN+'/subscribe',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+SBK,apikey:SBK},body:JSON.stringify({email:e})}).then(function(r){return r.json();}).then(function(d){if(d&&d.ok){f.innerHTML='<div style="color:#fff;font-weight:600">✓ Almost there — check your inbox to confirm.</div>';}else{btn.textContent='Try again';btn.disabled=false;}}).catch(function(){btn.textContent='Try again';btn.disabled=false;});});});
})();</script>
</body></html>`;

// ---------- homepage ---------- (a light hub: search-first, category cards, trending, news)
const CAT_IC = {
  div:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-4 3 2 5-7"/></svg>`,
  reit: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16"/><path d="M15 9h4a1 1 0 0 1 1 1v11"/><path d="M8 8h.01M11 8h.01M8 12h.01M11 12h.01M8 16h.01M11 16h.01"/></svg>`,
  etf:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/></svg>`,
  cal:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  ssb:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5z"/><path d="M9 12l2 2 4-4"/></svg>`,
  hy:   `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>`,
};
const catCard = (href, ic, title, count, desc) => `    <a class="cat" href="${href}"><span class="ci">${CAT_IC[ic]}</span><span style="min-width:0"><span class="ct">${title}${count!=null?`<span class="cn">${count}</span>`:''}</span><span class="cd">${desc}</span></span></a>`;
const trCard = (c) => {
  const CS = csym(c.cur);
  const chg = c.chg;
  const chgTxt = (chg!=null && chg!==0) ? `<span class="${chg>0?'up':'down'}">${chg>0?'▲':'▼'} ${Math.abs(chg).toFixed(1)}%</span>` : '';
  const yTxt = c.yieldPct!=null ? `<span class="ty">${c.yieldPct.toFixed(2)}% yield</span>` : '';
  return `    <a class="trcard" href="/stock/${c.slug}/"><div class="tn">${c.name}${c.ticker?`<span class="tt">${c.ticker}</span>`:''}</div><div class="tp">${c.price?CS+c.price:'—'}</div><div class="tm">${[yTxt,chgTxt].filter(Boolean).join(' · ')||'&nbsp;'}</div></a>`;
};
function homepage(listed, index, hub) {
  const idxJson = JSON.stringify(index).replace(/</g,'\\u003c');
  const trendingChips = (hub.trending||[]).slice(0,8).map(c => {
    const m = c.yieldPct!=null ? `<b>${c.yieldPct.toFixed(1)}%</b>`
      : (c.chg!=null && c.chg!==0 ? `<b class="${c.chg>0?'up':'down'}">${c.chg>0?'+':''}${c.chg.toFixed(1)}%</b>` : '');
    return `<a class="tchip" href="/stock/${c.slug}/">${c.name.split(/\s|-/)[0]}${m?' '+m:''}</a>`;
  }).join('');
  const cards = [
    catCard('/dividends/', 'div', 'Best dividend stocks', hub.divCount, 'Every SGX payer ranked by dividend yield.'),
    catCard('/reits/', 'reit', 'Best REITs to buy', hub.reitCount, 'S-REITs &amp; trusts by distribution yield.'),
    catCard('/etfs/', 'etf', 'Best ETFs', hub.etfCount, 'SGX ETFs ranked by distribution yield.'),
    catCard('/dividend-calendar/', 'cal', 'Dividend calendar', null, 'Upcoming ex-dates &amp; pay dates, in order.'),
    catCard('/ssb/', 'ssb', 'Savings Bonds (SSB)', null, hub.ssbLo!=null?`This month <b>${hub.ssbLo.toFixed(2)}%</b> → <b>${hub.ssbHi.toFixed(2)}%</b>. Rates, swap &amp; calculator.`:'Rates, step-up schedule, swap &amp; calculator.'),
    catCard('/dividends/', 'hy', 'Highest yield', hub.hyCount, 'Top yielders — with a risk note on the specials.'),
  ].join('\n');
  const trending = (hub.trending||[]).slice(0,8).map(trCard).join('\n');
  const newsHTML = (hub.news||[]).length ? `  <div class="hub-h">Latest news <a href="/news/">Read more →</a></div>
  <div class="hubnews">
${hub.news.map(n => `    <a href="${esc(n.link)}" target="_blank" rel="noopener nofollow"><div class="nt">${esc(n.title)}</div><div class="nm">${[n.source?esc(n.source):null, n.dateISO?pretty(n.dateISO):null].filter(Boolean).join(' · ')} · read ↗</div></a>`).join('\n')}
  </div>` : '';
  const body = `  <section class="hub-hero">
    <span class="kicker">🎋 Huat with StockKaki</span>
    <h1>Every Singapore stock, one clean search.</h1>
    <p class="sub">Dividends, yields, ex-dates, REITs, ETFs and savings bonds — free, fast, no clutter.</p>
    <div class="hub-search">${SEARCH_IC}<input id="q" type="text" autocomplete="off" placeholder="Search a stock or ticker — e.g. Singtel, DBS, S68"><div id="qres"></div></div>
    <div class="trend"><span class="tl">Trending:</span>${trendingChips}</div>
  </section>
  <div class="hub-h">Browse by what you're after</div>
  <div class="catgrid">
${cards}
  </div>
  <div class="hub-h">Trending stocks <a href="/trending/">See top ${hub.trendingCount||30} →</a></div>
  <div class="trgrid">
${trending}
  </div>
${newsHTML}`;
  const script = `<script>
const IDX=${idxJson};
const q=document.getElementById('q'),qr=document.getElementById('qres');
q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();if(!v){qr.style.display='none';return;}
  const h=IDX.filter(x=>x.n.toLowerCase().includes(v)||(x.t&&x.t.toLowerCase().includes(v))).slice(0,8);
  qr.innerHTML=h.length?h.map(x=>'<a href="/stock/'+x.s+'/"><span>'+x.n+'</span><span class="tick" style="margin:0">'+(x.t||'')+'</span></a>').join(''):'<div class="noqr">No match — try a ticker like Z74</div>';
  qr.style.display='block';});
document.addEventListener('click',e=>{if(!e.target.closest('.hub-search'))qr.style.display='none';});
</script>`;
  return shell('StockKaki — Singapore Dividends, Stocks, REITs, ETFs & Savings Bonds',
    'The clean way to track Singapore dividends. Search any SGX stock, browse the best dividend stocks, REITs, ETFs, the dividend calendar and Savings Bonds — free, updated daily.',
    SITE + '/', body, script, '/og/home.png');
}

// ---------- news page (aggregated latest SGX company news) ----------
function newsPage(items) {
  const faqs = [
    { q: 'Where does StockKaki get its news?', a: 'Headlines are aggregated from Singapore and global financial press — The Business Times, The Edge Singapore, The Straits Times, CNA, Reuters and others — and each links to the original article.' },
    { q: 'How often is the news updated?', a: 'Daily. Each SGX-listed company page also has its own News tab with the latest coverage of that specific stock.' },
  ];
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@context":"https://schema.org", "@type":"FAQPage", "mainEntity":faqs.map(f => ({ "@type":"Question", "name":f.q, "acceptedAnswer":{ "@type":"Answer", "text":f.a } })) }).replace(/</g,'\\u003c')}</script>`;
  const PER = 15;
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 5px">Singapore stock market news</h1>
    <p class="sub" style="margin-bottom:6px">The latest news on SGX-listed companies — updated daily.</p>
  </section>
  <div class="newslist" id="newswrap">
${items.map(n => `    <a class="newsitem" href="${esc(n.link)}" target="_blank" rel="noopener nofollow"><span class="news-t">${esc(n.title)}</span><span class="news-m">${[n.source?esc(n.source):null, n.dateISO?pretty(n.dateISO):null].filter(Boolean).join(' · ')} · read ↗</span></a>`).join('\n')}
  </div>
  <div class="pager" id="pager"></div>
  ${faqHTML}
  ${jsonLd}`;
  const script = `<script>(function(){var PER=${PER};var items=[].slice.call(document.querySelectorAll('#newswrap .newsitem'));var total=Math.max(1,Math.ceil(items.length/PER));var pager=document.getElementById('pager');var page=1;
function render(scroll){items.forEach(function(el,i){el.style.display=(i>=(page-1)*PER&&i<page*PER)?'':'none';});var h='<button class="pg" data-d="-1"'+(page===1?' disabled':'')+'>← Prev</button>';for(var p=1;p<=total;p++){h+='<button class="pg num'+(p===page?' on':'')+'" data-p="'+p+'">'+p+'</button>';}h+='<button class="pg" data-d="1"'+(page===total?' disabled':'')+'>Next →</button>';pager.innerHTML=h;if(scroll)window.scrollTo({top:0,behavior:'smooth'});}
pager.addEventListener('click',function(e){var b=e.target.closest('button');if(!b||b.disabled)return;if(b.dataset.p)page=+b.dataset.p;else page=Math.min(total,Math.max(1,page+(+b.dataset.d)));render(true);});
if(total<2)pager.style.display='none';render(false);})();</script>`;
  return shell('Singapore Stock Market News — Latest SGX Company News | StockKaki',
    'The latest news on SGX-listed Singapore stocks, REITs and ETFs — from The Business Times, The Edge, Straits Times, CNA and more. Updated daily, free.',
    SITE + '/news/', body, script, '/og/home.png');
}

// ---------- trending page (most active SGX counters by value traded) ----------
const trendingRow = (c, i) => {
  const CS = csym(c.cur);
  const chg = c.chg;
  const chgTxt = (chg!=null && chg!==0) ? `${chg>0?'▲':'▼'} ${Math.abs(chg).toFixed(1)}%` : '—';
  const chgCls = 'lr-chg' + (chg>0?' up':chg<0?' down':'');
  const yTxt = c.yieldPct!=null ? c.yieldPct.toFixed(2)+'%' : '—';
  const yCls = 'lr-yield' + (c.yieldPct==null?' mut':'');
  const priceTxt = c.price ? CS+c.price : '—';
  const meta = [priceTxt, chgTxt!=='—'?chgTxt:null, c.yieldPct!=null?yTxt+' yield':null].filter(Boolean).join('  ·  ');
  return `        <a class="lrow" href="/stock/${c.slug}/">
          <span class="lr-name"><span class="lr-rank">${i+1}</span><span class="lr-co">${c.name}</span>${c.ticker?`<span class="tick">${c.ticker}</span>`:''}</span>
          <span class="lr-price">${priceTxt}</span>
          <span class="${chgCls}">${chgTxt}</span>
          <span class="${yCls}">${yTxt}</span>
          <span class="lr-meta">${meta}</span>
        </a>`;
};
function trendingPage(items) {
  const faqs = [
    { q: 'What makes a stock “trending” on StockKaki?', a: 'These are the most actively traded SGX counters by value traded (volume × last price) — where the most money is changing hands right now. The list refreshes daily.' },
    { q: 'Does trending mean it’s a good buy?', a: 'No. Heavy trading just signals strong interest — it can be driven by results, news or momentum, in either direction. Always do your own research.' },
  ];
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@context":"https://schema.org", "@type":"FAQPage", "mainEntity":faqs.map(f => ({ "@type":"Question", "name":f.q, "acceptedAnswer":{ "@type":"Answer", "text":f.a } })) }).replace(/</g,'\\u003c')}</script>`;
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 5px">Trending Singapore stocks</h1>
    <p class="sub" style="margin-bottom:6px">The most actively traded SGX counters by value — refreshed daily.</p>
  </section>
  <div class="ltable cols-trend" style="margin-top:14px">
    <div class="lrow lhead"><span>#&nbsp;&nbsp;Company</span><span class="lr-price">Price</span><span class="lr-chg">Change</span><span class="lr-yield">Yield</span></div>
    <div>
${items.map(trendingRow).join('\n')}
    </div>
  </div>
  <p class="metaline" style="font-size:12px">Ranked by value traded (volume × last price). Dividend yield shown where the counter pays one.</p>
  ${faqHTML}
  ${jsonLd}`;
  return shell('Trending Singapore Stocks — Most Active SGX Counters Today | StockKaki',
    'The most actively traded stocks on the SGX today, ranked by value traded — with price, change and dividend yield. Updated daily, free.',
    SITE + '/trending/', body, '', '/og/home.png');
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
  const week = nx && daysTo(nx.exISO) <= 7 ? 1 : 0;
  const meta = [ c.price?priceTxt:null, c.divIncomplete?'scrip':(c.ttm>0?'Div '+csym(c.cur)+num(c.ttm):null), nx?'Ex '+prettyShort(nx.exISO):null ].filter(Boolean).join('  ·  ') || 'No dividend in 12M';
  return `        <a class="lrow" href="/stock/${c.slug}/" data-s="${esc((c.name+' '+(c.ticker||'')).toLowerCase())}" data-reit="${c.isReit?1:0}" data-etf="${c.secType==='etfs'?1:0}" data-week="${week}" data-n="${esc(c.name.toLowerCase())}" data-y="${yRank}" data-d="${c.ttm||0}" data-e="${nx?nx.exISO:''}">
          <span class="lr-name"><span class="lr-co">${c.name}</span>${c.ticker?`<span class="tick">${c.ticker}</span>`:''}</span>
          <span class="lr-price">${priceTxt}</span>
          <span class="${yCls}"${yTitle}>${yTxt}</span>
          <span class="lr-div">${divTxt}</span>
          <span class="lr-ex">${nx?prettyShort(nx.exISO):'—'}</span>
          <span class="lr-meta">${meta}</span>
        </a>`;
};
function listPage({ title, desc, kicker, h1, sub, list, canon, typeChips, intro, faqs, og, limit }) {
  // realistic yields (≤20%) rank first; likely one-off specials (>20%) and no-yield sink to the bottom
  const key = (c) => c.yieldPct==null ? -1 : (c.yieldPct<=20 ? c.yieldPct : -0.5);
  let sorted = [...list].sort((a,b) => key(b) - key(a));
  if (limit) sorted = sorted.slice(0, limit);
  const nStock = list.filter(c => !c.isReit && c.secType!=='etfs').length;
  const nReit = list.filter(c => c.isReit).length;
  const nEtf = list.filter(c => c.secType==='etfs').length;
  const chips = typeChips ? `<div class="chips">
    <span class="chip on" data-f="all">All <span class="pill-n">${list.length}</span></span>
    <span class="chip" data-f="stock">Stocks <span class="pill-n">${nStock}</span></span>
    <span class="chip" data-f="reit">REITs &amp; Trusts <span class="pill-n">${nReit}</span></span>
    <span class="chip" data-f="etf">ETFs <span class="pill-n">${nEtf}</span></span>
  </div>` : '';
  // curated Top-10 block (leads the page for the "top 10 …" search intent)
  const top10 = sorted.filter(c => c.yieldPct!=null && c.yieldPct<=20 || c.divIncomplete).slice(0, 10);
  const t10Card = (c, i) => {
    const CS = csym(c.cur);
    const type = c.secType==='etfs' ? 'ETF' : c.isReit ? 'REIT' : 'Stock';
    const sub = [type, (c.ttm>0 && !c.divIncomplete) ? `${CS}${num(c.ttm)} / yr` : (c.divIncomplete?'scrip payer':null)].filter(Boolean).join(' · ');
    const y = c.yieldPct!=null ? c.yieldPct.toFixed(2)+'%' : (c.divIncomplete?'scrip':'—');
    const yCls = 'tyv' + ((c.yieldPct==null||c.divIncomplete) ? ' mut' : '');
    return `      <a class="t10${i<3?' gold':''}" href="/stock/${c.slug}/"><span class="rk">${i+1}</span><span class="ti"><span class="tn">${c.name}${c.ticker?`<span class="tick">${c.ticker}</span>`:''}</span><span class="ts">${sub}</span></span><span class="ty"><span class="${yCls}">${y}</span>${c.price?`<span class="tp">${CS}${c.price}</span>`:''}</span></a>`;
  };
  const topBlock = (sorted.length > 10 && top10.length >= 6) ? `  <div class="hub-h" style="margin-bottom:12px">Top 10 ${h1.replace(/^Best /,'').replace(/ in Singapore$/,'')} <span style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--accent-dk);background:var(--accent-soft);border-radius:999px;padding:3px 10px;margin-left:2px">by yield</span></div>
  <div class="top10">
${top10.map(t10Card).join('\n')}
  </div>
  <div class="hub-h">All ${h1.replace(/^Best /,'').replace(/ in Singapore$/,'')}</div>` : '';
  const faqHTML = (faqs && faqs.length) ? `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>` : '';
  const jsonLd = (faqs && faqs.length) ? `<script type="application/ld+json">${JSON.stringify({ "@context":"https://schema.org", "@type":"FAQPage", "mainEntity":faqs.map(f => ({ "@type":"Question", "name":f.q, "acceptedAnswer":{ "@type":"Answer", "text":f.a } })) }).replace(/</g,'\\u003c')}</script>` : '';
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 4px">${h1}</h1>
    <p class="sub" style="margin-bottom:2px">${sub}</p>
  </section>
  ${topBlock}
  <div class="search" id="alltop" style="margin-top:14px">${SEARCH_IC}<input id="q" type="text" autocomplete="off" placeholder="Filter by name or ticker…"></div>
  ${chips}
  <div class="lsort"><button data-sort="y" class="on">Yield</button><button data-sort="d">Dividend</button><button data-sort="n">A–Z</button></div>
  <div class="ltable cols-screener" style="margin-top:12px">
    <div class="lrow lhead"><span data-sort="n">Company</span><span class="lr-price">Price</span><span class="lr-yield" data-sort="y">Yield</span><span class="lr-div" data-sort="d">12-mo div</span><span class="lr-ex" data-sort="e">Next ex-date</span></div>
    <div id="tb">
${sorted.map(companyRow).join('\n')}
    </div>
  </div>
  <div id="none" class="empty" style="display:none">No match.</div>
  <div class="pager" id="lpager"></div>
  <p class="metaline" style="font-size:12px">Yields are indicative — trailing 12-month dividends ÷ last price. <b>*</b> likely a one-off special dividend; <b>scrip</b> = pays via a reinvestment option (cash amount not in SGX's free feed).</p>
  ${intro ? `<div class="intro" style="margin-top:18px">${intro}</div>` : ''}
  ${faqHTML}
  ${jsonLd}`;
  const script = `<script>
const PER=15;
const q=document.getElementById('q'),tb=document.getElementById('tb'),none=document.getElementById('none'),pager=document.getElementById('lpager'),alltop=document.getElementById('alltop');
let matches=[],page=1;
function collect(){const v=q.value.trim().toLowerCase();const on=document.querySelector('.chip.on');const f=on?on.dataset.f:'all';
 matches=[...tb.querySelectorAll('.lrow')].filter(r=>{let ok=(!v||r.dataset.s.includes(v));
  if(ok&&f==='reit')ok=r.dataset.reit==='1'; if(ok&&f==='etf')ok=r.dataset.etf==='1'; if(ok&&f==='stock')ok=(r.dataset.reit!=='1'&&r.dataset.etf!=='1');
  return ok;});}
function pageBtns(total){var out=[],add=function(p){out.push('<button class="pg num'+(p===page?' on':'')+'" data-p="'+p+'">'+p+'</button>');};
 add(1); if(page>3)out.push('<span class="pg-dots">…</span>');
 for(var p=Math.max(2,page-1);p<=Math.min(total-1,page+1);p++)add(p);
 if(page<total-2)out.push('<span class="pg-dots">…</span>');
 if(total>1)add(total); return out.join('');}
function render(scroll){const total=Math.max(1,Math.ceil(matches.length/PER));if(page>total)page=total;if(page<1)page=1;
 tb.querySelectorAll('.lrow').forEach(r=>r.style.display='none');
 matches.slice((page-1)*PER,page*PER).forEach(r=>r.style.display='');
 none.style.display=matches.length?'none':'block';
 if(total<2){pager.innerHTML='';}else{pager.innerHTML='<button class="pg" data-d="-1"'+(page===1?' disabled':'')+'>←</button>'+pageBtns(total)+'<button class="pg" data-d="1"'+(page===total?' disabled':'')+'>→</button>';}
 if(scroll&&alltop)alltop.scrollIntoView({behavior:'smooth',block:'start'});}
function apply(){collect();page=1;render(false);}
q.addEventListener('input',apply);
document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));c.classList.add('on');apply();}));
pager.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;const total=Math.max(1,Math.ceil(matches.length/PER));if(b.dataset.p)page=+b.dataset.p;else page=Math.min(total,Math.max(1,page+(+b.dataset.d)));render(true);});
let sk='',sd=-1;
function sortBy(k){if(sk===k)sd=-sd;else{sk=k;sd=(k==='n'||k==='e')?1:-1;}
 const rows=[...tb.querySelectorAll('.lrow')];
 rows.sort((a,b)=>{let av=a.dataset[k],bv=b.dataset[k];if(k==='n'||k==='e'){av=av||'~';bv=bv||'~';return av<bv?-sd:av>bv?sd:0;}return (parseFloat(av)-parseFloat(bv))*sd;});
 rows.forEach(r=>tb.appendChild(r));
 document.querySelectorAll('.lhead [data-sort]').forEach(th=>{const o=th.querySelector('.ar');if(o)o.remove();if(th.dataset.sort===sk)th.insertAdjacentHTML('beforeend','<span class="ar">'+(sd<0?' ↓':' ↑')+'</span>');});
 document.querySelectorAll('.lsort button').forEach(bn=>bn.classList.toggle('on',bn.dataset.sort===sk));
 apply();}
document.querySelectorAll('.lhead [data-sort]').forEach(th=>th.addEventListener('click',()=>sortBy(th.dataset.sort)));
document.querySelectorAll('.lsort button').forEach(bn=>bn.addEventListener('click',()=>sortBy(bn.dataset.sort)));
sortBy('y');
</script>`;
  return shell(title, desc, canon, body, script, og);
}

// ---------- dividend calendar (upcoming ex-dates, chronological) ----------
function calendarPage(upcoming) {
  const rows = upcoming.map(r => {
    const amt = r.divIncomplete ? 'scrip' : money(r.ccy, r.amt);
    const tag = exTag(r.exISO);
    return `        <a class="lrow" href="/stock/${r.slug}/" data-s="${esc((r.name+' '+(r.ticker||'')).toLowerCase())}">
          <span class="lr-name"><span class="lr-co">${r.name}</span>${r.ticker?`<span class="tick">${r.ticker}</span>`:''}</span>
          <span class="lr-exd">${pretty(r.exISO)} ${tag}</span>
          <span class="lr-amt">${amt}</span>
          <span class="lr-ex">${pretty(r.pay)}</span>
          <span class="lr-meta">Ex ${prettyShort(r.exISO)}${tag?' '+tag:''}  ·  ${amt}  ·  Pay ${prettyShort(r.pay)}</span>
        </a>`;
  }).join('\n');
  const faqs = [
    { q: 'What is an ex-dividend date?', a: 'The ex-dividend (ex) date is the cut-off to qualify for a dividend — you must own the shares before the ex-date to be entitled. On the ex-date the share price typically drops by roughly the dividend amount.' },
    { q: "What's the difference between the ex-date and the pay date?", a: 'The ex-date decides who is entitled; the pay date is when the cash is actually credited to your account — usually a few weeks after the ex-date.' },
    { q: 'How do I use a dividend calendar?', a: 'Buy a stock before its ex-date to receive the upcoming dividend. This calendar lists the next SGX ex-dates and pay dates, updated daily.' },
  ];
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@context":"https://schema.org", "@type":"FAQPage", "mainEntity":faqs.map(f => ({ "@type":"Question", "name":f.q, "acceptedAnswer":{ "@type":"Answer", "text":f.a } })) }).replace(/</g,'\\u003c')}</script>`;
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 5px">Singapore dividend calendar</h1>
    <p class="sub" style="margin-bottom:0">Upcoming SGX ex-dividend and pay dates, in order — updated daily.</p>
  </section>
  <div class="intro">Buy a stock <b>before its ex-date</b> to receive the upcoming dividend. Below are the next <b>${upcoming.length}</b> SGX ex-dividend dates with their amounts and pay dates, newest first. For the full picture on any counter, tap through to its page.</div>
  <div class="ltable cols-home" style="margin-top:12px">
    <div class="lrow lhead"><span>Company</span><span class="lr-exd">Ex-date</span><span class="lr-amt">Amount</span><span class="lr-ex">Pay date</span></div>
    <div id="tb">
${rows}
    </div>
  </div>
  <p class="metaline" style="font-size:12px">Ex-dates &amp; amounts from SGX; <b>scrip</b> = a reinvestment-option distribution (cash amount not published in the free feed).</p>
  ${faqHTML}
  ${jsonLd}`;
  return shell('Singapore Dividend Calendar 2026 — Upcoming SGX Ex-Dates & Pay Dates | StockKaki',
    'Upcoming Singapore dividend dates — every SGX ex-dividend and pay date in order, updated daily. Never miss a payout.',
    SITE + '/dividend-calendar/', body, '', '/og/dividend-calendar.png');
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
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 5px">Announcements</h1>
    <p class="sub" style="margin-bottom:0">Latest SGX dividends, rights, entitlements and offers — updated daily.</p>
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
    SITE + '/announcements/', body, script, '/og/announcements.png');
}

// ---------- per-stock page ----------
// Inline SVG price chart (weekly closes, ~last 5 years) for the Overview tab.
function priceChart(prices, cur) {
  if (!prices || prices.length < 8) return '';
  const P = prices.slice(-260);
  const cs = P.map(p => p.c), lo = Math.min(...cs), hi = Math.max(...cs), span = (hi-lo) || 1;
  const W=680, H=190, PL=6, PR=56, PT=12, PB=22;
  const X = i => PL + (W-PL-PR) * (P.length>1 ? i/(P.length-1) : 0);
  const Y = v => PT + (H-PT-PB) * (1 - (v-lo)/span);
  const line = P.map((p,i) => X(i).toFixed(1)+','+Y(p.c).toFixed(1)).join(' ');
  const up = P[P.length-1].c >= P[0].c, col = up ? '#0c9a63' : '#c0392b';
  const area = `${X(0).toFixed(1)},${(H-PB).toFixed(1)} ${line} ${X(P.length-1).toFixed(1)},${(H-PB).toFixed(1)}`;
  const s = csym(cur);
  const fM = monthYr(new Date(P[0].t*1000).toISOString().slice(0,7));
  const lM = monthYr(new Date(P[P.length-1].t*1000).toISOString().slice(0,7));
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;overflow:visible" role="img" aria-label="price chart">
    <defs><linearGradient id="pcg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <line x1="${PL}" y1="${Y(hi).toFixed(1)}" x2="${W-PR}" y2="${Y(hi).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <line x1="${PL}" y1="${Y(lo).toFixed(1)}" x2="${W-PR}" y2="${Y(lo).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <polygon points="${area}" fill="url(#pcg)"/>
    <polyline points="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <text x="${W-PR+6}" y="${(Y(hi)+4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'JetBrains Mono',monospace">${s}${hi.toFixed(2)}</text>
    <text x="${W-PR+6}" y="${(Y(lo)+4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'JetBrains Mono',monospace">${s}${lo.toFixed(2)}</text>
    <text x="${PL}" y="${H-6}" fill="var(--muted)" font-size="11" font-family="'JetBrains Mono',monospace">${fM}</text>
    <text x="${(W-PR).toFixed(1)}" y="${H-6}" fill="var(--muted)" font-size="11" text-anchor="end" font-family="'JetBrains Mono',monospace">${lM}</text>
  </svg>`;
}

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
  const hist = c.divs.map(d => `        <tr><td class="date">${pretty(d.exISO)}${d.exISO>TODAY?' <span class="tag soon">upcoming</span>':''}</td><td class="r amt">${money(d.ccy,d.amt)}</td></tr>`).join('\n');
  const divSection = c.divs.length ? `
  ${next ? `<div class="nextcard"><div><div class="k">Next ex-date</div><div class="v">${pretty(next.exISO)}</div></div><div><div class="k">Amount</div><div class="v">${inc?'<span style="font-size:14px;color:var(--muted)">scrip</span>':money(next.ccy,next.amt)}</div></div><div><div class="k">Pay date</div><div class="v">${pretty(next.pay)}</div></div>${c.yieldPct?`<div><div class="k">Indicative yield</div><div class="v">${c.yieldPct.toFixed(2)}%</div></div>`:''}</div>` : `<p class="metaline">No upcoming ex-date announced yet.</p>`}
  ${inc ? scripNote : ''}
  ${ttmStr ? `<p class="metaline">Trailing 12-month dividends: <b>${ttmStr}</b> per security${c.yieldPct?` &middot; indicative yield <b>${c.yieldPct.toFixed(2)}%</b> at ${CS}${c.price} last`:''}.</p>` : ''}
  ${signals ? `<p class="metaline">${signals}.</p>` : ''}
  ${annual}
  <div class="h2">Full dividend history</div>
  <div class="card"><table>
    <thead><tr><th>Ex-date</th><th class="r">Amount / security</th></tr></thead>
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
      { "@type":"ListItem", "position":1, "name":"Dividends", "item":`${SITE}/dividends/` },
      { "@type":"ListItem", "position":2, "name":c.name, "item":`${SITE}/stock/${c.slug}/` } ] },
    { "@type":"FAQPage", "mainEntity":faqs.map(f => ({ "@type":"Question", "name":f.q, "acceptedAnswer":{ "@type":"Answer", "text":f.a } })) } ] };
  const jsonLd = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\u003c')}</script>`;
  const newsSection = (c.news && c.news.length) ? `
  <div class="newslist">
${c.news.map(n => `    <a class="newsitem" href="${esc(n.link)}" target="_blank" rel="noopener nofollow"><span class="news-t">${esc(n.title)}</span><span class="news-m">${[n.source?esc(n.source):null, n.dateISO?pretty(n.dateISO):null].filter(Boolean).join(' · ')}${(n.source||n.dateISO)?' · ':''}read ↗</span></a>`).join('\n')}
  </div>` : '';
  // ---- Overview tab: fundamentals (Yahoo) ----
  const f = c.fund;
  const fcur = (f && f.cur) || c.cur || 'SGD';
  const CSf = csym(fcur);
  const rangePos = (f && f.w52lo!=null && f.w52hi!=null && c.price>0 && f.w52hi>f.w52lo) ? Math.max(0, Math.min(100, (c.price-f.w52lo)/(f.w52hi-f.w52lo)*100)) : null;
  const ovStats = f ? [
    ['Market cap', fmtCap(fcur, f.mktCap)],
    ['P/E ratio', f.pe!=null ? f.pe.toFixed(1) : null],
    ['P/B ratio', f.pb!=null ? f.pb.toFixed(2) : null],
    ['EPS (ttm)', f.eps!=null ? CSf+f.eps.toFixed(2) : null],
    ['Dividend yield', c.yieldPct!=null ? c.yieldPct.toFixed(2)+'%' : null],
    ['Volume', f.vol ? fmtVol(f.vol) : null],
  ].filter(x => x[1]!=null) : [];
  const pchart = priceChart(c.prices, fcur);
  const overviewSection = (ovStats.length || rangePos!=null || pchart) ? `${pchart ? `<div class="ov-chart-h"><span>Price</span><span>${CSf}${c.price!=null?c.price:'—'}</span></div>${pchart}` : ''}<div class="ovgrid"${pchart?' style="margin-top:18px"':''}>${ovStats.map(s => `<div class="ovstat"><span class="ov-k">${s[0]}</span><span class="ov-v">${s[1]}</span></div>`).join('')}</div>
  ${rangePos!=null ? `<div class="ov-range"><div class="ov-range-h"><span>52-week range</span></div><div class="ov-bar"><div class="ov-mark" style="left:${rangePos.toFixed(1)}%"></div></div><div class="ov-range-f"><span>${CSf}${f.w52lo}</span><span style="color:var(--ink)">now ${CSf}${c.price}</span><span>${CSf}${f.w52hi}</span></div></div>` : ''}
  ${(f&&f.dayLo!=null&&f.dayHi!=null) ? `<p class="metaline" style="margin-top:16px">Day range <b>${CSf}${f.dayLo} – ${CSf}${f.dayHi}</b>.</p>` : ''}` : `<p class="metaline">Company fundamentals aren't available for this counter yet.</p>`;
  // ---- Announcements tab: this stock's SGX corporate actions ----
  const annSection = (c.anns && c.anns.length) ? `
  <div class="annlist">
${c.anns.map(a => `    <div class="annrow"><span class="ann-type"><span class="tag">${a.type}</span></span><div class="ann-body"><div class="ann-p">${esc(a.particulars) || a.type}</div><div class="ann-m">Announced ${pretty(a.annc)}${a.ex?` &middot; ex-date ${pretty(a.ex)}`:''}</div></div></div>`).join('\n')}
  </div>
  <p class="metaline" style="font-size:12px">Corporate actions filed with SGX — dividends, rights, entitlements and offers.</p>` : '';
  // ---- tabs ----
  const tabDefs = [];
  if (c.divs.length) tabDefs.push(['div','Dividends',divSection]);
  tabDefs.push(['ov','Overview',overviewSection]);
  if (c.news && c.news.length) tabDefs.push(['news','News',newsSection]);
  if (c.anns && c.anns.length) tabDefs.push(['ann','Announcements',annSection]);
  const tabsHTML = `<div class="tabs">${tabDefs.map((t,i) => `<button class="tab${i===0?' on':''}" data-tab="${t[0]}">${t[1]}</button>`).join('')}</div>
${tabDefs.map((t,i) => `  <div id="t-${t[0]}" class="tabpane"${i===0?'':' hidden'}>${t[2]}</div>`).join('\n')}`;
  const typeLabel = c.secType==='etfs' ? 'ETF' : c.isReit ? 'REIT' : 'Stock';
  const STAR = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 15 9l7 .5-5.4 4.6L18.2 21 12 17l-6.2 4 1.6-6.9L2 9.5 9 9z"/></svg>`;
  const BELL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`;
  const kpi = c.ticker ? `<div class="st-kpi">
    <div class="kbox"><div class="kl">Div yield</div><div class="kv acc">${c.yieldPct!=null?c.yieldPct.toFixed(2)+'%':'—'}</div></div>
    <div class="kbox"><div class="kl">P/E</div><div class="kv">${(f&&f.pe!=null)?f.pe.toFixed(1):'—'}</div></div>
    <div class="kbox"><div class="kl">Mkt cap</div><div class="kv">${fmtCap(fcur, f&&f.mktCap)||'—'}</div></div>
    <div class="kbox"><div class="kl">52-wk high</div><div class="kv">${(f&&f.w52hi!=null)?CSf+f.w52hi:'—'}</div></div>
  </div>` : '';
  const body = `  <section class="hero" style="padding-bottom:4px">
    <div class="crumb"><a href="/dividends/">Dividends</a> › ${c.name}</div>
    <div class="st-head">
      <div style="min-width:0">
        <h1 class="serif" style="font-size:26px;line-height:1.2">${c.name}</h1>
        <div class="st-tags"><span class="st-tag mono">SGX: ${c.ticker||'—'}</span><span class="st-tag">${typeLabel}</span>${c.cur&&c.cur!=='SGD'?`<span class="st-tag">${c.cur}</span>`:''}</div>
      </div>
      ${c.ticker?`<div class="st-acts"><button class="st-save" id="stSave">${STAR} Save</button><button class="st-bell" id="stBell" aria-label="Alerts">${BELL}</button></div>`:''}
    </div>
    ${c.price?`<div class="quote" style="margin-top:14px"><span class="q-price">${CS}${c.price}</span>${(c.chgPct!=null&&c.chgPct!==0)?`<span class="q-chg" style="color:${c.chgPct>=0?'#0f7a52':'#c0392b'}">${c.chgPct>=0?'▲':'▼'} ${Math.abs(c.chgPct).toFixed(2)}%</span>`:''}${c.vol?`<span class="q-vol">Vol ${fmtVol(c.vol)}</span>`:''}<span class="q-vol">last close</span></div>`:''}
    ${!c.ticker?`<p class="metaline" style="margin-top:6px">This counter isn’t currently trading on SGX (delisted or renamed) — shown here for its past dividend record.</p>`:''}
    ${kpi}
  </section>
  ${tabsHTML}
  ${faqHTML}
  ${brokerSlot()}
  <div class="st-toast" id="stToast">Accounts are coming soon — you'll be able to save stocks &amp; get ex-date alerts by email.</div>
  ${jsonLd}`;
  const tabScript = `<script>document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',function(){document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('on');});t.classList.add('on');document.querySelectorAll('.tabpane').forEach(function(p){p.hidden=true;});var e=document.getElementById('t-'+t.dataset.tab);if(e)e.hidden=false;});});
(function(){var to=document.getElementById('stToast');function t(){if(!to)return;to.classList.add('on');clearTimeout(window._tt);window._tt=setTimeout(function(){to.classList.remove('on');},3400);}['stSave','stBell'].forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('click',t);});})();</script>`;
  const nextTxt = next ? ` Next ex-date ${pretty(next.exISO)} (${money(next.ccy,next.amt)}).` : '';
  return shell(`${c.name}${c.ticker?' ('+c.ticker+')':''} Share Price, Dividends & Ex-Dates | StockKaki`,
    `${c.name}${c.ticker?' ('+c.ticker+')':''} — ${c.price?`last price ${CS}${c.price}, `:''}${c.yieldPct?`dividend yield ${c.yieldPct.toFixed(2)}%, `:''}dividend history and ex-dates on SGX.${nextTxt} Updated daily.`,
    `${SITE}/stock/${c.slug}/`, body, tabScript);
}

// Allotment tracker — did the latest issue fully allot, or was it balloted?
function allotCard(ssb) {
  const a = ssb.allot; if (!a || !a.size || a.applied == null) return '';
  const balloted = a.rndmRate > 0;
  const subPct = a.applied / a.size * 100;
  const guar = a.cutoff != null ? Math.round(a.cutoff * 1e6) : null;
  return `  <div class="h2">Latest allotment result</div>
  <div class="ssb-card" style="border-left-color:#3E8FB0">
    <span class="ssb-status ${balloted?'closed':'open'}">${balloted?'Balloted · oversubscribed':'Fully allotted'}</span>
    <div class="ssb-stats">
      <div class="bigstat"><div class="k">Applications</div><div class="v" style="font-size:26px">S$${a.applied.toFixed(0)}m</div><div class="cap">of S$${a.size.toFixed(0)}m offered · ${subPct.toFixed(0)}% subscribed</div></div>
      ${balloted && guar!=null
        ? `<div class="bigstat"><div class="k">Filled in full up to</div><div class="v" style="font-size:26px">S$${guar.toLocaleString('en-SG')}</div><div class="cap">above that, ${a.rndmRate.toFixed(1)}% won the next S$500 by ballot</div></div>`
        : `<div class="bigstat alt"><div class="k">Outcome</div><div class="v" style="font-size:19px;margin-top:11px">Everyone got their full amount</div><div class="cap">no balloting</div></div>`}
    </div>
    <p class="ssb-meta">Issue ${a.code} · ${monthYr(a.issueISO)}.${(!balloted && ssb.streak>1)?` The last <b>${ssb.streak}</b> issues were all fully allotted — recently, a full application has been getting filled in full.`:''}</p>
  </div>
`;
}

// Swap calculator — should you redeem your current SSB and buy the new (higher?) issue?
function swapCard(ssb) {
  if (!ssb.issued || ssb.issued.length < 2) return '';
  const c = ssb.current;
  return `  <div class="h2">Should you switch to the new issue?</div>
  <div class="ssb-card" style="border-left-color:var(--line)">
    <p class="ssb-meta" style="margin-top:0">You can redeem an SSB any month with no penalty — so if a new issue pays more than your current bond will <i>going forward</i>, it can pay to switch. But your bond has already "stepped up", so newer isn't always better. Compare:</p>
    <div class="calc">
      <div class="f"><label for="swAmt">You hold (S$)</label><input id="swAmt" type="number" min="500" step="500" value="10000"></div>
      <div class="f"><label for="swOld">Your current bond</label><select id="swOld"></select></div>
      <div class="f"><label for="swYrs">Keep for</label><select id="swYrs"></select></div>
    </div>
    <div class="calc-out">
      <div class="bigstat" id="swKeepBox"><div class="k">Keep your bond</div><div class="v" id="swKeep">—</div><div class="cap" id="swKeepAvg"></div></div>
      <div class="bigstat" id="swNewBox"><div class="k">Switch to ${c.code}</div><div class="v" id="swNew">—</div><div class="cap" id="swNewAvg"></div></div>
    </div>
    <p class="ssb-meta" id="swVerdict" style="font-weight:600;color:var(--ink)"></p>
    <p class="ssb-meta" style="font-size:12px">Compares interest earned over the period (SSB coupons are paid out, not compounded). Ignores the ~S$2 transaction fee. Your holding so far is estimated from each issue's date.</p>
  </div>
`;
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

  const body = `  <section class="hero" style="padding:22px 0 2px">
    <h1 class="serif" style="font-size:27px;margin:0 0 5px">Singapore Savings Bonds</h1>
    <p class="sub" style="margin-bottom:0">This month's SSB rates, the 10-year step-up, returns & swap calculators, and allotment — from MAS, updated every issue.</p>
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
${swapCard(ssb)}
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
${allotCard(ssb)}
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
var SWAP_NEW=${JSON.stringify(c.coupons)},SWAP_OLD=${JSON.stringify(ssb.issued||[])};
var swOld=document.getElementById('swOld'),swYrs=document.getElementById('swYrs'),swAmt=document.getElementById('swAmt');
if(swOld&&SWAP_OLD.length){
 SWAP_OLD.forEach(function(b,i){var o=document.createElement('option');o.value=i;o.textContent=b.ym+' · '+b.code;swOld.appendChild(o);});
 function fillYrs(){var b=SWAP_OLD[swOld.value];var rem=10-b.held;swYrs.innerHTML='';for(var n=1;n<=rem;n++){var o=document.createElement('option');o.value=n;o.textContent=n+' more year'+(n>1?'s':'');swYrs.appendChild(o);}swYrs.value=Math.min(3,rem);}
 function swCalc(){var b=SWAP_OLD[swOld.value];var p=parseFloat(swAmt.value)||0;var n=parseInt(swYrs.value,10);
  var keepSum=0,newSum=0;for(var i=0;i<n;i++){keepSum+=b.coupons[b.held+i];newSum+=SWAP_NEW[i];}
  var keep=p*keepSum/100,sw=p*newSum/100;
  document.getElementById('swKeep').textContent='S$'+fmt(keep);
  document.getElementById('swNew').textContent='S$'+fmt(sw);
  document.getElementById('swKeepAvg').textContent='avg '+(keepSum/n).toFixed(2)+'%/yr';
  document.getElementById('swNewAvg').textContent='avg '+(newSum/n).toFixed(2)+'%/yr';
  var kb=document.getElementById('swKeepBox'),nb=document.getElementById('swNewBox'),V=document.getElementById('swVerdict');
  kb.classList.remove('win');nb.classList.remove('win');var diff=Math.round(Math.abs(sw-keep));
  if(sw>keep+0.5){nb.classList.add('win');V.textContent='✅ Switching to ${c.code} earns about S$'+fmt(diff)+' more over '+n+' year'+(n>1?'s':'')+'.';}
  else if(keep>sw+0.5){kb.classList.add('win');V.textContent='👍 Keep your bond — it pays about S$'+fmt(diff)+' more over '+n+' year'+(n>1?'s':'')+' (it has already stepped up).';}
  else{V.textContent='≈ About the same either way over '+n+' year'+(n>1?'s':'')+'.';}}
 swOld.addEventListener('change',function(){fillYrs();swCalc();});swYrs.addEventListener('change',swCalc);swAmt.addEventListener('input',swCalc);
 fillYrs();swCalc();
}
</script>`;
  return shell('Singapore Savings Bonds (SSB) Rates This Month — 1-Year & 10-Year Returns | StockKaki',
    `Latest Singapore Savings Bonds rates: ${c.y1.toFixed(2)}% first-year and ${c.y10.toFixed(2)}% 10-year average return (issue ${c.code}). Full step-up schedule, rate trend and a returns calculator. From MAS, updated each issue.`,
    SITE + '/ssb/', body, script, '/og/ssb.png');
}

// ---------- disclaimer ----------
function disclaimerPage() {
  const body = `  <section class="hero" style="padding-bottom:4px">
    <div class="crumb"><a href="/">Dividends</a> › Disclaimer</div>
    <h1 class="serif" style="font-size:28px">Disclaimer</h1>
  </section>
  <div style="max-width:720px;color:var(--muted);font-size:14.5px;line-height:1.75">
    <p style="margin:12px 0">StockKaki provides Singapore dividend and corporate-action information for <b style="color:var(--ink)">general information only</b>. It is not financial advice, a recommendation, an offer, or a solicitation to buy or sell any security.</p>
    <p style="margin:12px 0"><b style="color:var(--ink)">Sources.</b> Figures — prices, dividends, ex-dates, fundamentals, savings-bond rates and news — are <b style="color:var(--ink)">compiled automatically from a range of public and third-party sources</b>, including the Singapore Exchange (SGX), the Monetary Authority of Singapore (MAS) and Yahoo Finance. We work to make the information as accurate and complete as possible, but it may contain errors, omissions or delays. Indicative yield is trailing 12-month dividends divided by the last available price — an estimate only. <b style="color:var(--ink)">Always verify against the official source</b> before making any decision.</p>
    <p style="margin:12px 0">StockKaki is <b style="color:var(--ink)">not affiliated with, endorsed by, or connected to SGX, MAS, Yahoo, or any data provider</b>. All company names and tickers belong to their respective owners. News headlines link to third-party sites and are not endorsements. Some outbound links may be affiliate links.</p>
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
// The securities feed is properly cased ("SBS Transit", "ESR REIT") while the dividend feed is
// ALL-CAPS — so harvest genuine acronyms (all-caps tokens) from it to fix title-casing. Some feed
// names are fully caps, so skip common corporate/geographic/English words to avoid false acronyms.
const NOTACR = new Set('LTD LIMITED GROUP HOLDINGS HOLDING CORP CORPORATION COMPANY PTE INC BERHAD BHD PLC THE AND FOR NEW ASIA PACIFIC ASIAN GLOBAL INTERNATIONAL INTL NATIONAL INDUSTRIES INDUSTRIAL RESOURCES TECHNOLOGY TECH CHINA INDIA SINGAPORE JAPAN KOREA EUROPE EUROPEAN AMERICA RETAIL PROPERTY PROPERTIES CAPITAL MARINE ENERGY FOOD FOODS GREEN HEALTH MEDICAL HEALTHCARE FINANCIAL FINANCE SERVICE SERVICES SYSTEMS SYSTEM SOLUTIONS LOGISTICS MARITIME SHIPPING PETROLEUM CHEMICAL CHEMICALS MEDIA DIGITAL INVESTMENT INVESTMENTS MANAGEMENT DEVELOPMENT ENGINEERING MANUFACTURING ELECTRONICS HOTEL HOTELS RESORT RESORTS LAND CITY METAL METALS STEEL POWER WATER GLOBAL WORLD UNITED FIRST GREAT BANK BANKING INSURANCE TELECOM AGRICULTURE PLANTATION PLANTATIONS PALM PAPER PRINT CONSTRUCTION ENTERPRISE ENTERPRISES VENTURES PARTNERS COMMERCIAL HOSPITALITY TRANSIT PHARMA MINING GOLD LIFE HOME'.split(' '));
for (const s of secList) { for (const w of (s.name||'').split(/[^A-Za-z]+/)) { if (w.length>=2 && w.length<=6 && /^[A-Z]+$/.test(w) && !NOTACR.has(w)) ACR.add(w); } }
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
const annBySlug = {};
for (const a of anns) (annBySlug[a.slug] = annBySlug[a.slug] || []).push(a);   // per-stock corporate actions

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
for (const c of companies) c.anns = (annBySlug[c.slug] || []).slice(0, 12);   // this stock's recent SGX filings

// ---- Accurate dividends (Yahoo) + per-stock news (Google News → Yahoo fallback), with a last-good cache. ----
// SKIP_YAHOO=1 → fast local build: no live fetch, but STILL uses data/yahoo-cache.json so pages aren't blank.
// Production/CI runs on a fresh IP, does the full fetch, and re-commits the cache. A throttled build degrades
// gracefully to yesterday's cached data instead of showing blanks.
const SKIP_YAHOO = process.env.SKIP_YAHOO === '1';
const ySleep = (ms) => new Promise(r => setTimeout(r, ms));
const CACHE_URL = new URL('./data/yahoo-cache.json', import.meta.url);
let cache = {};
try { if (existsSync(CACHE_URL)) cache = JSON.parse(readFileSync(CACHE_URL, 'utf8')); } catch { cache = {}; }
// Apply a Yahoo/cache record {fund,news,cur,ydivs} onto a company (re-merges SGX upcoming ex-dates with cached past divs).
const applyY = (c, rec) => {
  if (!rec) return;
  if (rec.fund) c.fund = { ...(c.fund||{}), ...rec.fund };
  if (rec.news && rec.news.length) c.news = rec.news;
  if (rec.ydivs && rec.ydivs.length) {
    const cur = rec.cur || c.cur || 'SGD';
    const past = rec.ydivs.filter(d => d.exISO <= TODAY);
    const soon = c.divs.filter(d => d.exISO > TODAY);          // fresh SGX-announced future ex-dates
    c.cur = cur;
    c.divs = [...soon, ...past].sort((a,b) => a.exISO < b.exISO ? 1 : -1);
    c.ttm = past.filter(d => d.exISO >= yearAgo).reduce((s,d) => s + d.amtNum, 0);
    c.yieldPct = (c.price > 0 && c.ttm > 0) ? c.ttm / c.price * 100 : null;
    c.divIncomplete = false;
    c.yahoo = true;
  }
};
for (const c of companies) if (cache[c.slug]) applyY(c, cache[c.slug]);   // 1) last-good baseline
const yTargets = SKIP_YAHOO ? [] : companies.filter(c => c.ticker && (c.isReit || c.secType==='etfs' || c.divs.length > 0));   // incl. ETFs so their distributions load
let yFixed = 0, yNews = 0;
const fresh = {};                                                          // this run's successful fetches → persisted to cache
if (SKIP_YAHOO) console.log(`SKIP_YAHOO=1 — fast build using cache (${Object.keys(cache).length} cached counters), no live fetch.`);
for (const c of yTargets) {                                                // 2) live fetch (overrides baseline on success)
  const rec = {};
  const y = fetchYahooDivs(c.ticker);
  await ySleep(140);
  if (y && y.meta) rec.fund = y.meta;
  if (y && y.prices && y.prices.length) c.prices = y.prices;               // chart data (not cached — regenerated live)
  if (y && y.divs.length) {
    const cur = y.cur || c.cur || 'SGD';
    const ydivs = y.divs.filter(d => d.exISO <= TODAY).map(d => ({ exISO: d.exISO, ccy: cur, amt: num(d.amount), amtNum: d.amount, rec: null, pay: null, annc: null }));
    if (ydivs.length) { rec.cur = cur; rec.ydivs = ydivs; yFixed++; }
  }
  let news = fetchYahooNews(c.ticker);                                     // Yahoo RSS — title + summary + mixed financial sources
  await ySleep(130);
  const gnews = fetchGoogleNews(c.name);                                   // Google News — breadth (BT / Edge / ST / CNA …)
  await ySleep(130);
  const seenT = new Set(news.map(n => (n.title||'').toLowerCase().slice(0,55)));
  for (const g of gnews) { const k = (g.title||'').toLowerCase().slice(0,55); if (!seenT.has(k)) { news.push(g); seenT.add(k); } }   // merge, Yahoo (summaries) first
  if (news.length) { rec.news = news.slice(0, 8); yNews++; }
  if (Object.keys(rec).length) { applyY(c, rec); fresh[c.slug] = { ...(cache[c.slug]||{}), ...rec }; }
}
if (!SKIP_YAHOO) console.log(`Enrichment: dividends ${yFixed}/${yTargets.length} · news ${yNews} (Google→Yahoo)`);

// Fundamentals (market cap, P/E, P/B, EPS, 52-week) for ALL listed counters — batched, ~15 calls.
if (!SKIP_YAHOO) {
  const cr = yahooCrumb();
  const Q = fetchYahooQuotes(companies.filter(c => c.ticker).map(c => c.ticker), cr);
  let yFund = 0;
  for (const c of companies) { if (c.ticker && Q[c.ticker]) { c.fund = { ...(c.fund||{}), ...Q[c.ticker] }; fresh[c.slug] = { ...(cache[c.slug]||{}), ...(fresh[c.slug]||{}), fund: c.fund }; yFund++; } }
  console.log(`Yahoo fundamentals: ${yFund} counters${cr ? '' : ' (crumb failed — 52-week only)'}`);
  // persist merged last-good cache (fund + news + dividends) for the next run / a throttled build
  try {
    const merged = { ...cache, ...fresh };
    mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
    writeFileSync(CACHE_URL, JSON.stringify(merged));
    console.log(`Cache saved: ${Object.keys(merged).length} counters → data/yahoo-cache.json`);
  } catch (e) { console.log('Cache save failed:', e.message); }
}

const upcoming = rows.filter(r => r.exISO >= TODAY).sort((a,b)=> a.exISO<b.exISO?-1:1)
  .map(r => { const c = divCompanies.get(r.slug); return { ...r, yieldPct: c?c.yieldPct:null, isReit: c?c.isReit:false, divIncomplete: c?c.divIncomplete:divIncomplete(r.slug) }; });
const index = companies.map(c => ({ n: c.name, t: c.ticker||'', s: c.slug })).sort((a,b)=> a.n<b.n?-1:1);
const all = companies;
const listed = all.filter(c => c.ticker);                                   // currently trading on SGX (has a live counter)
// Dividend payers = listed counters paying NOW (trailing distribution or a REIT scrip payer) — every row has a real number.
const dividendStocks = listed.filter(c => c.ttm > 0 || c.divIncomplete);
const exWeekCount = dividendStocks.filter(c => { const nx = c.divs.find(d => d.exISO >= TODAY); return nx && daysTo(nx.exISO) <= 7; }).length;

// ---- home-hub data: counts, trending (biggest names), latest news, SSB rate range ----
const reitCountH = listed.filter(c => c.isReit).length;
const etfCountH = listed.filter(c => c.secType==='etfs' && (c.ttm>0 || c.divIncomplete)).length;
const hyCount = dividendStocks.filter(c => c.yieldPct!=null && c.yieldPct>=6 && c.yieldPct<=20).length;
// Trending = most actively traded SGX counters by VALUE traded (volume × price) — a real "trending" signal.
const _turnover = (c) => (((c.fund && c.fund.vol) || c.vol || 0) * (c.price || 0));
const _seenTrend = new Set();   // one card per company — drop secondary/foreign-currency lines (e.g. "Singtel 10")
const trending = [...listed].filter(c => c.cur==='SGD' && _turnover(c) > 0)
  .sort((a,b) => _turnover(b) - _turnover(a))
  .filter(c => { const k = c.name.toLowerCase().split(/[\s-]/)[0]; if (_seenTrend.has(k)) return false; _seenTrend.add(k); return true; })
  .slice(0, 30)
  .map(c => ({ name: c.name, ticker: c.ticker, slug: c.slug, price: c.price, cur: c.cur, yieldPct: (c.yieldPct!=null && c.yieldPct<=20) ? c.yieldPct : null,
    chg: (c.chgPct!=null && c.chgPct!==0) ? c.chgPct : (c.fund && c.fund.chg!=null ? c.fund.chg : null) }));
// Hub "Latest news": curate to the biggest, best-known counters + whitelisted outlets only — avoids obscure
// micro-caps and ambiguous-ticker false matches (e.g. "GRC" pulling Singapore political news).
const _newsSlugs = new Set([...listed].filter(c => c.fund && c.fund.mktCap).sort((a,b) => b.fund.mktCap - a.fund.mktCap).slice(0, 60).map(c => c.slug));
const hubNews = companies.filter(c => _newsSlugs.has(c.slug) && c.news && c.news.length)
  .flatMap(c => c.news.filter(n => n.dateISO && NEWS_OK.has(n.source) && titleHasCo(n.title, c.name) && !NEWS_JUNK.test(n.title)).map(n => ({ title: n.title, link: n.link, dateISO: n.dateISO, slug: c.slug, name: c.name, source: n.source || '' })))
  .sort((a,b) => a.dateISO < b.dateISO ? 1 : -1)
  .filter((n,i,arr) => arr.findIndex(x => x.title === n.title) === i)   // de-dupe identical headlines across stocks
  .slice(0, 5);
// Full aggregated feed for the /news/ page (quality outlets, newest first, de-duped).
const newsFeed = companies.filter(c => c.news && c.news.length)
  .flatMap(c => c.news.filter(n => n.dateISO && NEWS_OK.has(n.source) && titleHasCo(n.title, c.name) && !NEWS_JUNK.test(n.title)).map(n => ({ title: n.title, link: n.link, dateISO: n.dateISO, source: n.source || '', name: c.name, slug: c.slug })))
  .sort((a,b) => a.dateISO < b.dateISO ? 1 : -1)
  .filter((n,i,arr) => arr.findIndex(x => x.title === n.title) === i)
  .slice(0, 60);
const hub = { divCount: dividendStocks.length, reitCount: reitCountH, etfCount: etfCountH, hyCount,
  ssbLo: ssb && ssb.current ? ssb.current.y1 : null, ssbHi: ssb && ssb.current ? ssb.current.y10 : null,
  trending, trendingCount: trending.length, news: hubNews };

const out = new URL('./dist/', import.meta.url);
// Clear dist's CONTENTS rather than rmdir'ing dist itself — on Windows the folder handle can be
// held (Explorer window, Defender, indexer) causing EBUSY on rmdir even when children are deletable.
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) rmSync(new URL(entry, out), { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
for (const f of ['favicon.svg', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png', 'favicon.ico', 'og.png']) copyFileSync(new URL(`assets/${f}`, import.meta.url), new URL(f, out));
mkdirSync(new URL('og/', out), { recursive: true });   // per-page social cards (assets/og/*.png → /og/*.png)
try { const ogDir = new URL('assets/og/', import.meta.url); for (const f of readdirSync(ogDir)) if (f.endsWith('.png')) copyFileSync(new URL(f, ogDir), new URL(`og/${f}`, out)); } catch {}
writeFileSync(new URL('index.html', out), homepage(listed, index, hub));
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
mkdirSync(new URL('dividends/', out), { recursive: true });
writeFileSync(new URL('dividends/index.html', out), listPage({
  title: 'Best Dividend Stocks in Singapore 2026 — Highest SGX Dividend Yields | StockKaki',
  desc: 'The highest-yielding SGX dividend stocks and REITs, ranked by dividend yield and updated daily. Search, filter and compare the best Singapore dividend stocks — free, no clutter.',
  h1: 'Best dividend stocks in Singapore', sub: `${dividendStocks.length} SGX counters currently paying dividends — ranked by yield, updated daily. (Search any of ${listed.length} listed stocks above.)`,
  intro: `Singapore is one of the world's best places for dividend investors — there is <b>no tax on dividends and no capital-gains tax</b>. Above are all <b>${dividendStocks.length}</b> SGX counters currently paying a dividend, ranked by trailing 12-month yield and updated daily. Use the filters for Stocks, REITs or ETFs — and note that an unusually high yield can signal a one-off special dividend or higher risk.`,
  faqs: [
    { q: 'What are the best dividend stocks in Singapore?', a: 'This page ranks every SGX counter currently paying a dividend by trailing 12-month yield — the leaders are usually high-yield REITs, trusts and selected blue chips. Filter by Stocks, REITs or ETFs above; a very high yield may include a one-off special or reflect higher risk.' },
    { q: 'What is a good dividend yield in Singapore?', a: 'Roughly 4–6% is a solid, sustainable yield for a Singapore dividend stock or REIT. Much higher — say above 10% — is worth a closer look, as it may include a special dividend or signal elevated risk.' },
    { q: 'Are dividends taxed in Singapore?', a: 'No. Singapore uses a one-tier corporate tax system, so dividends paid to individual shareholders are tax-free, and there is no capital-gains tax.' },
    { q: 'How do I buy dividend stocks in Singapore?', a: 'Through any SGX brokerage (DBS Vickers, moomoo, Tiger, Interactive Brokers and others) or with SRS funds. You must own the shares before the ex-dividend date to receive the next payout.' },
  ],
  list: dividendStocks, canon: SITE + '/dividends/', typeChips: true, og: '/og/screener.png' }));
// keep the old /screener/ URL alive → 301-style redirect to the renamed /dividends/ page
mkdirSync(new URL('screener/', out), { recursive: true });
writeFileSync(new URL('screener/index.html', out), `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Best Dividend Stocks in Singapore | StockKaki</title><link rel="canonical" href="${SITE}/dividends/"><meta http-equiv="refresh" content="0; url=/dividends/"><meta name="robots" content="noindex,follow"></head><body>Redirecting to <a href="/dividends/">Best dividend stocks in Singapore</a>…</body></html>`);
mkdirSync(new URL('reits/', out), { recursive: true });
const reitList = listed.filter(c => c.isReit);
writeFileSync(new URL('reits/index.html', out), listPage({
  title: 'Best REITs to Buy in Singapore 2026 — S-REIT Dividend Yields | StockKaki',
  desc: 'All SGX-listed REITs and business trusts ranked by distribution yield — CapitaLand, Mapletree, Keppel, Frasers and more. Live, clean, updated daily.',
  h1: 'Best REITs to buy in Singapore', sub: `All ${reitList.length} SGX-listed REITs and business trusts, ranked by distribution yield.`,
  intro: `Singapore REITs (S-REITs) are among the most popular income investments here — they must distribute at least 90% of income, so yields are typically higher than ordinary stocks, and distributions are <b>tax-free</b> for individuals. Above are all <b>${reitList.length}</b> SGX-listed REITs and business trusts, ranked by trailing distribution yield and updated daily.`,
  faqs: [
    { q: 'What is the best REIT to buy in Singapore?', a: 'There is no single best REIT — it depends on your goals. This page ranks all SGX-listed S-REITs and business trusts by trailing distribution yield so you can compare income; also weigh the sector, gearing and track record before deciding.' },
    { q: 'What is the average dividend yield of Singapore REITs?', a: 'S-REITs typically yield around 5–7%. They must distribute at least 90% of taxable income, which is why their yields are usually higher than ordinary shares.' },
    { q: 'Are Singapore REITs a good investment?', a: 'S-REITs offer regular income and property diversification, and distributions are tax-free for individuals. They carry risks too — interest rates, property values and gearing — so diversify and check each REIT’s fundamentals.' },
    { q: 'How are Singapore REIT distributions taxed?', a: 'Distributions from S-REITs are generally tax-exempt for individual investors.' },
  ],
  list: reitList, canon: SITE + '/reits/', typeChips: false, og: '/og/reits.png' }));
mkdirSync(new URL('etfs/', out), { recursive: true });
const etfList = listed.filter(c => c.secType==='etfs' && (c.ttm>0 || c.divIncomplete));
writeFileSync(new URL('etfs/index.html', out), listPage({
  title: 'Best Singapore ETFs 2026 — Top SGX ETFs by Dividend Yield | StockKaki',
  desc: 'SGX-listed ETFs ranked by distribution yield — STI, bond, REIT and dividend ETFs. Compare Singapore ETFs, clean and updated daily.',
  h1: 'Best ETFs in Singapore', sub: `${etfList.length} SGX-listed ETFs that distribute, ranked by yield.`,
  intro: `Exchange-traded funds (ETFs) let you own a whole basket of stocks or bonds in a single trade, and they trade on the SGX just like shares. Above are the <b>${etfList.length}</b> SGX-listed ETFs that currently distribute, ranked by trailing yield — useful for income. For growth, the underlying index matters more than the yield.`,
  faqs: [
    { q: 'What are the best ETFs in Singapore?', a: 'Popular SGX ETFs include the Straits Times Index (STI) ETF and a range of bond, REIT and dividend ETFs. This page ranks the distributing SGX ETFs by yield — best for income; for growth, look at the underlying index rather than the yield.' },
    { q: 'Do Singapore ETFs pay dividends?', a: 'Many do — bond, REIT and dividend ETFs distribute regularly, while some equity ETFs accumulate instead. This list shows the distributing ones, ranked by yield.' },
    { q: 'How do I buy ETFs in Singapore?', a: 'ETFs trade like stocks on the SGX — buy them through any brokerage, or via a regular-savings plan (RSP) to dollar-cost average over time.' },
  ],
  list: etfList, canon: SITE + '/etfs/', typeChips: false, og: '/og/etfs.png' }));
mkdirSync(new URL('dividend-calendar/', out), { recursive: true });
writeFileSync(new URL('dividend-calendar/index.html', out), calendarPage(upcoming));
mkdirSync(new URL('announcements/', out), { recursive: true });
writeFileSync(new URL('announcements/index.html', out), announcementsPage(anns));
mkdirSync(new URL('news/', out), { recursive: true });
writeFileSync(new URL('news/index.html', out), newsPage(newsFeed));
mkdirSync(new URL('trending/', out), { recursive: true });
writeFileSync(new URL('trending/index.html', out), trendingPage(hub.trending));
mkdirSync(new URL('ssb/', out), { recursive: true });
writeFileSync(new URL('ssb/index.html', out), ssbPage(ssb, sgs));
mkdirSync(new URL('confirm/', out), { recursive: true });
writeFileSync(new URL('confirm/index.html', out), utilPage('Confirm your alerts', 'confirm_subscriber', "You're in! 🦁", "You'll get StockKaki dividend & ex-date alerts.", 'Already confirmed (or the link expired).'));
mkdirSync(new URL('unsubscribe/', out), { recursive: true });
writeFileSync(new URL('unsubscribe/index.html', out), utilPage('Unsubscribe', 'unsubscribe', 'Unsubscribed', 'You will no longer receive StockKaki emails.', 'Already unsubscribed.'));
mkdirSync(new URL('api/', out), { recursive: true });
writeFileSync(new URL('api/upcoming.json', out), JSON.stringify(upcoming.map(r => ({ name: r.name, ticker: r.ticker || null, amt: money(r.ccy, r.amt), ex: r.exISO, slug: r.slug }))));

const urls = [SITE + '/', SITE + '/dividends/', SITE + '/reits/', SITE + '/etfs/', SITE + '/dividend-calendar/', SITE + '/ssb/', SITE + '/news/', SITE + '/trending/', SITE + '/announcements/', SITE + '/disclaimer/', ...all.map(c => `${SITE}/stock/${c.slug}/`)];
writeFileSync(new URL('sitemap.xml', out),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n') + `\n</urlset>\n`);
writeFileSync(new URL('robots.txt', out), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(new URL('llms.txt', out), `# StockKaki — Singapore dividend & stock tracker
> Free, clean tool for SGX dividends, ex-dates, yields and stock info. Data sourced from the Singapore Exchange (SGX), updated daily. Not financial advice.

## Key pages
- Upcoming SGX dividends & ex-dates: ${SITE}/
- Best dividend stocks (ranked by yield): ${SITE}/dividends/
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
