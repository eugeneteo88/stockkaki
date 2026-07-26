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
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const fullMonthYr = (s) => { if (!s) return ''; const [y,m] = s.split('-').map(Number); return `${MONTHS_FULL[m-1]} ${y}`; };   // "August 2026" — matches how people search SSB rates
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
const pxf = (sym, p) => !p ? '—' : sym + (Number(p) >= 1 ? Number(p).toFixed(2) : p);   // prices: 2dp above S$1, keep precision for penny stocks
const num = (n) => n.toFixed(4).replace(/0+$/,'').replace(/\.$/,'');
const fmtVol = (n) => (n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? Math.round(n/1e3)+'K' : String(n));
const fmtCap = (cur, n) => { if (!n) return null; const s = csym(cur); return n>=1e9 ? s+(n/1e9).toFixed(2)+'B' : n>=1e6 ? s+(n/1e6).toFixed(0)+'M' : s+n.toFixed(0); };
// Rough FX → SGD, so market caps in different currencies rank correctly (approximate; ranking only, not display).
const FXSGD = { SGD:1, USD:1.35, HKD:0.173, CNY:0.187, GBP:1.72, EUR:1.46, MYR:0.30, AUD:0.88, JPY:0.0086, IDR:0.000083, THB:0.037, KRW:0.00098, TWD:0.042, INR:0.016 };
const capSGD = (cur, n) => (n||0) * (FXSGD[cur] || 1);
const esc = (s) => (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');

const TODAY = new Date().toISOString().slice(0,10);
const YEAR = TODAY.slice(0,4);   // current year — for self-updating "best ... <year>" SEO titles (never hardcode the year)
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
  for (const s of list) { if (!ok.has(s.type) || !s.n) continue; if (NOISE.test(s.n)) continue;
    if (/\s(?:R\d*|W\d*)$/.test(s.n) || /\b(?:rights?|nil.?paid|warrants?)\b/i.test(s.n)) continue;   // rights/warrants/nil-paid entitlements — not real companies (e.g. "TC Auto R", "AcroMeta Grp R1")
    out.push({ ticker: s.nc, name: TICKER_ALIAS[s.nc] || s.n, type: s.type, price: s.lt, cur: s.cur || 'SGD', chgPct: s.change_vs_pc_percentage, vol: s.vl }); }
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
    const fields = 'marketCap,sharesOutstanding,regularMarketPrice,trailingPE,priceToBook,epsTrailingTwelveMonths,fiftyTwoWeekLow,fiftyTwoWeekHigh,regularMarketDayLow,regularMarketDayHigh,regularMarketVolume,regularMarketChangePercent,currency';
    let rs; try { rs = JSON.parse(execFileSync('curl', ['-s','-m','25','-A',UA,'-b',cr.cj, `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms}&fields=${fields}&crumb=${encodeURIComponent(cr.crumb)}`], { maxBuffer: 16*1024*1024 }).toString()).quoteResponse.result; } catch { rs = null; }
    if (rs) for (const r of rs) { const t = (r.symbol||'').replace(/\.SI$/,''); if (!t) continue;
      const mc = r.marketCap || ((r.sharesOutstanding && r.regularMarketPrice) ? r.sharesOutstanding * r.regularMarketPrice : undefined);   // Yahoo sometimes omits marketCap → derive from shares × price
      map[t] = { mktCap:mc, pe:r.trailingPE, pb:r.priceToBook, eps:r.epsTrailingTwelveMonths, w52lo:r.fiftyTwoWeekLow, w52hi:r.fiftyTwoWeekHigh, dayLo:r.regularMarketDayLow, dayHi:r.regularMarketDayHigh, vol:r.regularMarketVolume, chg:r.regularMarketChangePercent, cur:r.currency }; }
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
// General Singapore-market news — a single broad, recency-biased query so the /news/ feed always has fresh
// daily market headlines even when no individual tracked counter published news. Quality outlets ONLY.
function fetchMarketNews() {
  const q = encodeURIComponent('(SGX OR "Straits Times Index" OR "Singapore shares" OR "Singapore stocks" OR "Singapore market") when:4d');
  let xml; try { xml = execFileSync('curl', ['-s','-m','20','-A',UA, `https://news.google.com/rss/search?q=${q}&hl=en-SG&gl=SG&ceid=SG:en`], { maxBuffer: 12*1024*1024 }).toString('utf8'); } catch { return []; }
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    let title = decodeEntities((it.match(/<title>([\s\S]*?)<\/title>/)||[])[1] || '');
    const link = ((it.match(/<link>([\s\S]*?)<\/link>/)||[])[1] || '').trim();
    const source = decodeEntities((it.match(/<source[^>]*>([\s\S]*?)<\/source>/)||[])[1] || '').trim();
    const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)||[])[1];
    if (!title || !link) continue;
    title = title.replace(new RegExp('\\s*-\\s*' + source.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\s*$'), '').trim();
    if (NEWS_JUNK.test(title)) continue;
    if (!NEWS_OK.has(source)) continue;                       // general feed = reputable outlets only
    let dateISO = null; try { if (pub) dateISO = new Date(pub).toISOString().slice(0,10); } catch {}
    if (!dateISO) continue;
    out.push({ title, link, dateISO, source, name: 'Singapore market' });
  }
  return out.slice(0, 25);
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

// ---------- Singapore Treasury Bills (MAS auctions) ----------
// Retail T-bills are product_type "B": issue codes BS…(6-month) and BY…(1-year). product_type "M" = MAS Bills (institutional) — excluded.
function fetchTBills() {
  let recs;
  // sort=auction_date desc → newest first; the space MUST be %20-encoded or MAS ignores it and returns the oldest rows
  try { recs = getMAS('listbondsandbills?rows=200&sort=auction_date%20desc').result.records; } catch { return null; }
  const B = (recs || []).filter(r => r.product_type === 'B' && (r.auction_tenor === 0.5 || r.auction_tenor === 1))
    .sort((a, b) => a.auction_date < b.auction_date ? 1 : -1);   // newest auction first (defensive)
  if (!B.length) return null;
  const done = (r) => r.cutoff_yield > 0;                                   // auction whose results are published
  const tenor = (t) => B.filter(r => r.auction_tenor === t);
  const six = tenor(0.5), one = tenor(1);
  const latest = (arr) => arr.find(done) || null;                          // newest with a cut-off yield
  const next = [...B].filter(r => r.auction_date >= TODAY).sort((a,b) => a.auction_date < b.auction_date ? -1 : 1)[0] || null;
  return {
    l6: latest(six), l1: latest(one), next,
    hist6: six.filter(done).slice(0, 12),                                   // recent 6-month results (main retail product)
    trend: six.filter(done).slice(0, 14).reverse().map(r => ({ y: r.cutoff_yield, iso: r.auction_date })),
  };
}

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
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;
const CUP = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 2.5c-.6.8.6 1.2 0 2M12 2.5c-.6.8.6 1.2 0 2"/></svg>`;
const MOON = `<svg class="moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SUN = `<svg class="sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const BURGER = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;
const CLOSE = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
const WA = `<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.4A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1 1 12 20zm4.4-6c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1-.6.8-.8 1-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4.2-.4.6-1.2.1-.2 0-.3 0-.5s-.5-1.3-.7-1.8-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3A3 3 0 0 0 6.3 10a5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c2 .8 2 .6 2.4.5a2.6 2.6 0 0 0 1.7-1.2 2 2 0 0 0 .2-1.2c-.1-.1-.3-.2-.5-.3z"/></svg>`;
const ACCT_IC = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
// TODO(Eugene): paste your WhatsApp channel/community invite link here to activate the "Join channel" button.
const WHATSAPP_URL = 'https://whatsapp.com/channel/';
const NAVLINKS = `<a href="/stocks/">Stocks</a><a href="/dividends/">Dividends</a><a href="/reits/">REITs</a><a href="/etfs/">ETFs</a><a href="/dividend-calendar/">Calendar</a><a href="/savings/">Savings</a><a href="/news/">News</a><a href="/guides/">Guides</a>`;
const NAV = `<header class="nav">
  <div class="wrap row">
  <a class="brand" href="/">StockKaki<span class="bdot">.</span></a>
  <nav>${NAVLINKS}</nav>
  <div style="display:flex;align-items:center;gap:6px"><button id="themeBtn" class="tbtn" aria-label="Toggle dark mode">${MOON}${SUN}</button><a class="tbtn" href="/account/" aria-label="Account" title="Your account">${ACCT_IC}</a><button id="mtoggle" class="tbtn mtoggle" aria-label="Menu">${BURGER}</button></div>
  </div>
</header>
<div id="mscrim" class="mscrim"></div>
<aside id="mmenu" class="mmenu" aria-hidden="true">
  <div class="mmenu-head"><a class="brand" href="/">StockKaki<span class="bdot">.</span></a><button id="mclose" class="tbtn" aria-label="Close menu">${CLOSE}</button></div>
  <nav class="mmenu-links">${NAVLINKS}<a href="/account/">Account</a></nav>
  <div class="mmenu-cta"><span class="btn wa soon" title="Coming soon">${WA} Join channel <span class="soon-tag">Soon</span></span></div>
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
// moomoo affiliate card — shown only on tradeable stock pages (has a ticker), personalised to the stock. SHIPPED 2026-07.
const MOOMOO_URL = 'https://j.moomoo.com/0EQpF6';
const brokerSlot = (c) => (c && c.ticker) ? `  <aside class="mm-card" aria-label="Sponsored — open a brokerage account">
    <div class="mm-top"><span class="mm-eyebrow">Ready to invest?</span><span class="mm-tile"><img src="/moomoo.png" width="38" height="38" alt="moomoo" loading="lazy"></span></div>
    <p class="mm-lede">Open a <b>moomoo</b> account to buy <b>${esc(c.name)}</b> and 970+ SGX stocks — plus US, HK &amp; China markets, all in one app.</p>
    <div class="mm-offer">New users get <b>up to S$1,200</b> in welcome rewards</div>
    <a class="mm-btn" href="${MOOMOO_URL}" target="_blank" rel="sponsored nofollow noopener">Open a moomoo account →</a>
    <p class="mm-disc">Affiliate link — StockKaki may earn a commission if you sign up, at no extra cost to you. Not financial advice.</p>
  </aside>` : '';
/* const brokerSlot = () => `<aside class="brokers">
    <div class="bk-h"><span class="bk-t">Start collecting dividends</span><span class="bk-ad">Affiliate</span></div>
    <p class="bk-sub">Open a brokerage account to buy SGX dividend stocks — compare popular options:</p>
    <div class="bk-list">
${BROKERS.map(b => `      <a class="bk" href="${b.u}" target="_blank" rel="sponsored noopener"><b>${b.n}</b><span>${b.d}</span></a>`).join('\n')}
    </div>
  </aside>`; */
// TODO(Eugene): make "HeyAda" clickable — wrap in <a href="https://…">HeyAda</a> once the URL is confirmed.
const FOOTER = `<footer><div class="wrap"><div class="disc"><a href="/disclaimer/" style="color:var(--accent-dk);font-weight:600">Disclaimer</a><span>© ${YEAR} StockKaki</span></div></div></footer>`;

const STYLE = `
  :root{ --ink:#0F1319; --muted:#6B7280; --line:#E6E8EE; --hair-2:#EEF0F4; --bg:#F7F8FA; --card:#FFFFFF; --accent:#2647DD; --accent-soft:#EBEEFF; --accent-dk:#1E3AB8; --up:#0E9E6E; --down:#DA3B3B; --nav-bg:rgba(247,248,250,.85); --row-hover:#F1F3F7; }
  html[data-theme="dark"]{ --ink:#EAECF1; --muted:#8B93A2; --line:#20242E; --hair-2:#191D25; --bg:#0B0D12; --card:#12151C; --accent:#6E86FF; --accent-soft:#1A2033; --accent-dk:#8FA2FF; --up:#2FD69C; --down:#FF6060; --nav-bg:rgba(11,13,18,.85); --row-hover:#171B23; }
  *{box-sizing:border-box;margin:0;padding:0} html{overflow-x:clip}
  body{font-family:'IBM Plex Sans',system-ui,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;line-height:1.5;min-height:100dvh;display:flex;flex-direction:column;overflow-x:clip}
  main.wrap{flex:1 0 auto;min-width:0}
  .serif{font-family:'IBM Plex Serif',sans-serif;letter-spacing:-.01em} a{color:inherit;text-decoration:none} .wrap{width:100%;max-width:1000px;margin:0 auto;padding:0 20px}
  header.nav{position:sticky;top:0;z-index:20;background:var(--nav-bg);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .nav .row{display:flex;align-items:center;justify-content:space-between;height:60px}
  .brand{display:inline-flex;align-items:center;font-family:'IBM Plex Serif',serif;font-weight:600;font-size:20px}
  .brand{letter-spacing:-.015em} .brand .bdot{color:var(--accent)}
  .nav nav{display:none;gap:24px;font-size:14px;color:var(--muted);font-weight:500} .nav nav a:hover{color:var(--ink)}
  .btn{background:var(--accent);color:#fff;font-weight:600;font-size:13.5px;padding:9px 16px;border-radius:999px;border:0;cursor:pointer} .btn:hover{background:var(--accent-dk)}
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
  .btn.wa.soon,.btn.wa.soon:hover{background:var(--line);color:var(--muted);cursor:default;pointer-events:none}
  .soon-tag{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;background:var(--muted);color:var(--card);border-radius:999px;padding:2px 6px;line-height:1;opacity:.85}
  @media(min-width:820px){ .mmenu,.mscrim{display:none!important} }
  @media(min-width:820px){ .nav nav{display:flex} }
  .hero{padding:30px 0 4px} .kicker{color:var(--accent-dk);font-weight:600;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
  .hero h1{font-family:'IBM Plex Serif',sans-serif;font-weight:700;font-size:32px;line-height:1.08;letter-spacing:-.01em;margin:8px 0 10px}
  .hero .sub{color:var(--muted);font-size:14.5px;max-width:520px} @media(min-width:820px){ .hero h1{font-size:40px} }
  @media(max-width:819px){ .hero{padding:22px 0 4px} .hero h1{font-size:26px} .hero .sub{display:none} }
  .crumb{color:var(--muted);font-size:13px;margin-bottom:6px} .crumb a:hover{color:var(--accent-dk)}
  .prose{max-width:680px;font-size:16px;line-height:1.72;color:var(--ink);margin-top:8px}
  .prose p{margin:0 0 18px}
  .prose h2{font-family:'IBM Plex Serif',serif;font-weight:600;font-size:22px;letter-spacing:-.01em;margin:34px 0 12px}
  .prose ul,.prose ol{margin:0 0 18px 20px} .prose li{margin:7px 0}
  .prose a{color:var(--accent-dk);font-weight:500;border-bottom:1px solid var(--line)} .prose a:hover{border-color:var(--accent)}
  .prose strong{font-weight:600} .prose em{font-style:italic}
  .prose .formula{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:15px 18px;margin:0 0 20px;font-family:'IBM Plex Mono',monospace;font-size:15px;line-height:1.5}
  .guidelist{display:grid;grid-template-columns:1fr;gap:10px;max-width:760px;margin-top:8px} @media(min-width:640px){.guidelist{grid-template-columns:1fr 1fr}}
  .gcard{display:block;border:1px solid var(--line);border-radius:10px;padding:18px 20px;color:inherit} .gcard:hover{border-color:var(--accent);background:var(--row-hover)}
  .gc-t{display:block;font-family:'IBM Plex Serif',serif;font-weight:600;font-size:17px;letter-spacing:-.01em}
  .gc-b{display:block;font-size:13.5px;color:var(--muted);margin-top:6px;line-height:1.5}
  .search{position:relative;margin-top:16px;max-width:540px}
  .search input{width:100%;border:1px solid var(--line);background:var(--card);border-radius:12px;padding:13px 16px 13px 44px;font-size:15px;font-family:inherit;color:var(--ink)}
  .search input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .search .ic{position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
  #qres{position:absolute;top:52px;left:0;right:0;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 20px 44px -20px rgba(0,0,0,.35);overflow:hidden;display:none;z-index:30;max-height:340px;overflow-y:auto}
  #qres a{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line);font-size:14px} #qres a:last-child{border-bottom:0} #qres a:hover{background:var(--accent-soft)}
  #qres .noqr{padding:13px 16px;color:var(--muted);font-size:13px}
  .live{display:inline-flex;align-items:center;gap:7px;margin-top:14px;background:var(--accent-soft);color:var(--accent-dk);font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;font-family:'IBM Plex Mono',monospace}
  .hint{margin-top:12px;font-size:12.5px;color:var(--muted);font-family:'IBM Plex Mono',monospace}
  .live .pulse{width:7px;height:7px;border-radius:50%;background:var(--accent)}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:18px 0 6px;scrollbar-width:none} .chips::-webkit-scrollbar{display:none}
  .chip{white-space:nowrap;font-size:13px;font-weight:500;color:var(--muted);background:var(--card);border:1px solid var(--line);padding:7px 14px;border-radius:999px;cursor:pointer;user-select:none}
  .chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
  .nextcard{margin:18px 0 4px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:18px 22px;display:flex;flex-wrap:wrap;gap:28px;align-items:center}
  .nextcard .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600} .nextcard .v{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:18px;margin-top:3px}
  .metaline{color:var(--muted);font-size:13.5px;margin-top:14px} .metaline b{color:var(--ink);font-family:'IBM Plex Mono',monospace}
  .h2{font-family:'IBM Plex Sans',sans-serif;font-weight:600;font-size:15px;letter-spacing:-.01em;margin:28px 0 11px}
  .faq{max-width:760px} .faq-q{font-weight:600;margin-top:16px} .faq-a{color:var(--muted);font-size:14.5px;margin-top:4px;line-height:1.7}
  .intro{max-width:730px;color:var(--muted);font-size:14.5px;line-height:1.75;margin:2px 0 6px} .intro b{color:var(--ink)} .intro a{color:var(--accent-dk);font-weight:600}
  .tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:20px 0 0;overflow-x:auto;scrollbar-width:none} .tabs::-webkit-scrollbar{display:none}
  .tab{background:none;border:0;border-bottom:2px solid transparent;padding:11px 16px;margin-bottom:-1px;font-family:'IBM Plex Serif',sans-serif;font-size:15px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap} .tab.on{color:var(--ink);border-bottom-color:var(--accent)} .tab:hover{color:var(--ink)}
  .tabpane[hidden]{display:none}
  .ovgrid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-top:16px} @media(min-width:620px){.ovgrid{grid-template-columns:repeat(3,1fr)}}
  .ovstat{display:flex;flex-direction:column;gap:4px;padding:14px 16px;background:var(--card)}
  .ov-k{color:var(--muted);font-size:12px} .ov-v{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:17px;color:var(--ink)}
  .ov-range{margin-top:22px} .ov-range-h{font-size:13px;color:var(--muted)}
  .ov-bar{position:relative;height:6px;background:var(--line);border-radius:3px;margin:14px 0 7px}
  .ov-mark{position:absolute;top:50%;width:13px;height:13px;border-radius:50%;background:var(--accent);transform:translate(-50%,-50%);box-shadow:0 0 0 3px var(--card)}
  .ov-range-f{display:flex;justify-content:space-between;font-size:11.5px;color:var(--muted);font-family:'IBM Plex Mono',monospace}
  .newslist{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:4px 18px;margin-top:16px}
  .annlist{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:4px 18px;margin-top:16px}
  .annrow{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--line);align-items:flex-start} .annrow:last-child{border-bottom:0}
  .ann-type{flex:0 0 auto;padding-top:1px} .ann-body{min-width:0}
  .ann-p{font-size:14.5px;line-height:1.45} .ann-m{font-size:11.5px;color:var(--muted);margin-top:5px;font-family:'IBM Plex Mono',monospace}
  .newsitem{display:block;padding:14px 0;border-bottom:1px solid var(--line);color:inherit} .newsitem:last-child{border-bottom:0}
  .news-t{display:block;font-weight:600;font-size:15px;line-height:1.4} .newsitem:hover .news-t{color:var(--accent-dk)}
  .news-d{display:block;font-size:13px;color:var(--muted);line-height:1.5;margin-top:5px}
  .news-m{display:block;font-size:11.5px;color:var(--muted);margin-top:6px;font-family:'IBM Plex Mono',monospace}
  .ov-chart-h{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;color:var(--muted);margin:16px 0 4px} .ov-chart-h span:last-child{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:16px;color:var(--ink)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;max-width:820px}
  .card:has(table){max-width:560px}
  thead th,tbody td{padding-top:11px;padding-bottom:11px}
  table{width:100%;border-collapse:collapse}
  thead th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:13px 16px;border-bottom:1px solid var(--line)}
  thead th.r,tbody td.r{text-align:right}
  thead th[data-sort]{cursor:pointer;user-select:none} thead th[data-sort]:hover{color:var(--ink)} .ar{color:var(--accent-dk);font-size:11px}
  tbody td{padding:14px 16px;border-bottom:1px solid var(--line);font-size:14.5px} tbody tr:last-child td{border-bottom:0} tbody tr:hover{background:var(--row-hover)}
  .co{font-weight:600;color:inherit} a.co:hover{color:var(--accent-dk)}
  .tick{color:var(--muted);font-size:12px;font-family:'IBM Plex Mono',monospace;margin-left:7px}
  .quote{display:flex;align-items:baseline;gap:14px;margin-top:4px;flex-wrap:wrap}
  .q-price{font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:600} .q-chg{font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600} .q-vol{font-size:12px;color:var(--muted);font-family:'IBM Plex Mono',monospace}
  .amt{font-family:'IBM Plex Mono',ui-monospace,monospace;font-weight:600;font-size:14px}
  .yld{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:14px;color:var(--accent-dk)}
  .date{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:13px;color:var(--muted)}
  .tag{display:inline-block;font-size:11px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent-dk);font-family:'IBM Plex Mono',monospace}
  .tag.soon{background:var(--accent);color:#fff}
  .empty{padding:26px 16px;text-align:center;color:var(--muted);font-size:14px}
  .hide-m{display:none} @media(min-width:720px){ .hide-m{display:table-cell} }
  @media(max-width:560px){ thead th,tbody td{padding:12px 10px;font-size:13px} .tick{display:none} .amt,.yld{font-size:13px} }
  /* ---- responsive data list (screener / reits / homepage): aligned columns on desktop, 2-line cards on mobile ---- */
  .ltable{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .lrow{display:grid;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--line);color:inherit}
  .lrow:last-child{border-bottom:0} .lrow:not(.lhead):hover{background:var(--row-hover)}
  .lhead{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;background:transparent}
  .lhead>span[data-sort]{cursor:pointer;user-select:none} .lhead>span[data-sort]:hover{color:var(--ink)}
  .lr-name{min-width:0;display:flex;align-items:baseline;gap:7px} .lr-name .tick{flex:0 0 auto}
  .lr-co{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .lr-price,.lr-yield,.lr-div,.lr-ex,.lr-amt,.lr-exd{text-align:right;font-family:'IBM Plex Mono',monospace;font-size:13.5px;white-space:nowrap}
  .lr-yield{color:var(--accent-dk);font-weight:600} .lr-yield.mut{color:var(--muted);font-weight:500}
  .lr-ex,.lr-exd{color:var(--muted);font-size:12.5px} html[data-theme="dark"] .lr-ex,html[data-theme="dark"] .lr-exd{color:var(--muted)}
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
  .cols-stocks .lrow{grid-template-columns:minmax(0,1fr) 88px 82px 100px 56px}
  .cols-trend .lr-name{align-items:center}
  .lr-rank{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:23px;height:23px;border-radius:6px;background:var(--accent-soft);color:var(--accent-dk);font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:12px}
  /* home dashboard: adaptive dividend vs stock columns */
  .cols-home2.m-div .c-stk{display:none} .cols-home2.m-stk .c-div{display:none}
  .lr-mc,.lr-pe,.lr-chg{text-align:right;font-family:'IBM Plex Mono',monospace;font-size:13.5px;white-space:nowrap} .lr-chg.up{color:var(--up)} .lr-chg.down{color:var(--down)}
  .cols-home2.m-div .lrow{grid-template-columns:minmax(0,1fr) 86px 80px 98px 104px}
  .cols-home2.m-stk .lrow{grid-template-columns:minmax(0,1fr) 86px 120px 58px 84px}
  .lsort{display:none} .lsort[hidden]{display:none}
  @media(max-width:560px){
    .cols-screener .lrow,.cols-home .lrow,.cols-annc .lrow,.cols-ssbr .lrow,.cols-trend .lrow,.cols-stocks .lrow,.cols-home2.m-div .lrow,.cols-home2.m-stk .lrow{grid-template-columns:minmax(0,1fr) auto;row-gap:2px;padding:12px 14px}
    .lhead{display:none}
    .lr-price,.lr-div,.lr-ex,.lr-amt,.lr-exd,.lr-sub,.lr-mc,.lr-pe{display:none}
    .lr-name{grid-column:1;grid-row:1} .lr-name .tick{display:inline}
    .lr-yield{grid-column:2;grid-row:1;font-size:16px}
    .cols-home2.m-stk .lr-chg,.cols-trend .lr-chg,.cols-stocks .lr-chg{grid-column:2;grid-row:1;font-size:16px}
    .cols-trend .lr-yield{display:none}
    .cols-annc .lr-type{grid-column:2;grid-row:1;text-align:right}
    .lr-meta{display:block;grid-column:1/-1;grid-row:2;font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:var(--muted)}
    .lsort:not([hidden]){display:flex;gap:8px;margin:14px 0 -2px;overflow-x:auto;scrollbar-width:none} .lsort::-webkit-scrollbar{display:none}
    .lsort button{white-space:nowrap;font-family:inherit;font-size:12.5px;font-weight:600;color:var(--muted);background:var(--card);border:1px solid var(--line);padding:7px 13px;border-radius:999px;cursor:pointer}
    .lsort button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
  }
  .alert{margin:26px 0 8px;background:var(--accent);color:#fff;border-radius:18px;padding:24px 22px;display:flex;flex-direction:column;gap:14px}
  .alert h3{font-family:'IBM Plex Serif',sans-serif;font-weight:700;font-size:21px} .alert p{color:#FFE7D6;font-size:14px;max-width:520px}
  .alert form{display:flex;gap:8px;flex-wrap:wrap} .alert input{flex:1;min-width:200px;border:0;border-radius:999px;padding:12px 16px;font-size:14px;font-family:inherit} .alert .btn{background:#20160E;color:#fff}
  @media(min-width:820px){ .alert{flex-direction:row;align-items:center;justify-content:space-between} .alert .txt{max-width:52%} }
  .brokers{margin:24px 0 8px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
  .bk-h{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .bk-t{font-family:'IBM Plex Serif',sans-serif;font-weight:600;font-size:15px}
  .bk-ad{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 8px;flex:0 0 auto}
  .bk-sub{color:var(--muted);font-size:13px;margin:6px 0 14px}
  .bk-list{display:grid;grid-template-columns:repeat(3,1fr);gap:10px} @media(max-width:620px){.bk-list{grid-template-columns:1fr}}
  .bk{display:block;border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--card);transition:.15s} .bk:hover{border-color:var(--accent);background:var(--accent-soft)}
  .bk b{display:block;font-size:14px} .bk span{font-size:12px;color:var(--muted)}
  footer{flex-shrink:0;margin-top:36px;padding-bottom:34px;color:var(--muted);font-size:12.5px;line-height:1.7} footer .disc{border-top:1px solid var(--line);padding-top:16px;display:flex;justify-content:space-between;align-items:center;gap:12px}
  .ssb-card{margin:16px 0 6px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:12px;padding:22px;max-width:820px}
  .ssb-status{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;font-family:'IBM Plex Mono',monospace;padding:6px 13px;border-radius:999px}
  .ssb-status .pulse{width:7px;height:7px;border-radius:50%;background:currentColor}
  .ssb-status.open{background:#dcf3e7;color:#0c7a4e} html[data-theme="dark"] .ssb-status.open{background:#123726;color:#5fd39e}
  .ssb-status.closed{background:var(--accent-soft);color:var(--accent-dk)}
  .ssb-meta{color:var(--muted);font-size:13px;margin-top:11px} .ssb-meta b{color:var(--ink);font-family:'IBM Plex Mono',monospace}
  .ssb-stats{display:flex;gap:14px;flex-wrap:wrap;margin-top:16px}
  .bigstat{flex:1;min-width:150px;background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:15px 18px}
  .bigstat .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
  .bigstat .v{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:34px;color:var(--accent-dk);margin-top:6px;line-height:1}
  .bigstat.alt .v{color:var(--ink)} .bigstat .cap{font-size:11.5px;color:var(--muted);margin-top:7px}
  .bigstat.win{border-color:var(--accent);background:var(--accent-soft)}
  .facts{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
  .fact{font-size:12px;color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:6px 12px} .fact b{color:var(--ink)}
  .calc{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
  .calc .f{flex:1;min-width:130px} .calc label{font-size:12px;color:var(--muted);font-weight:600;display:block;margin-bottom:5px}
  .calc input,.calc select{width:100%;border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:11px 13px;font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--ink)}
  .calc input:focus,.calc select:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .calc-out{margin-top:16px;display:flex;gap:14px;flex-wrap:wrap} .calc-out .bigstat{min-width:140px}
  .calc-out .bigstat .v{font-size:26px;letter-spacing:-.015em;white-space:nowrap}
  #swKeepBox .k,#swNewBox .k{min-height:2.5em}
  .chartwrap{margin-top:6px} .leg{display:flex;gap:18px;font-size:12px;color:var(--muted);margin:2px 0 10px}
  .leg i{display:inline-block;width:14px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px}
  .stepup tr.hl td{background:var(--accent-soft)} .stepup tr.hl td:first-child{font-weight:700}
  /* ---- home hub ---- */
  .hub-hero{padding:34px 0 6px} @media(max-width:560px){.hub-hero{padding:22px 0 4px}}
  .hub-hero h1{font-family:'IBM Plex Serif',sans-serif;font-weight:700;font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:8px 0 10px;max-width:14ch} @media(max-width:560px){.hub-hero h1{font-size:27px}}
  .hub-hero .sub{color:var(--muted);font-size:15px;max-width:440px}
  .hub-search{position:relative;margin-top:18px;max-width:560px}
  .hub-search input{width:100%;border:1px solid var(--line);background:var(--card);border-radius:14px;padding:15px 16px 15px 46px;font-size:15px;font-family:inherit;color:var(--ink)}
  .hub-search input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .hub-search .ic{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
  .trend{display:flex;gap:8px;align-items:center;margin-top:18px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px} .trend::-webkit-scrollbar{display:none}
  .trend .tl{color:var(--muted);font-size:13px;flex:0 0 auto}
  .tchip{flex:0 0 auto;white-space:nowrap;font-size:13px;font-weight:500;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 13px} .tchip:hover{border-color:var(--accent);background:var(--accent-soft)} .tchip b{color:var(--accent-dk);font-weight:600}
  .hub-h{font-family:'IBM Plex Sans',sans-serif;font-weight:600;font-size:16px;letter-spacing:-.01em;margin:34px 0 12px;display:flex;align-items:baseline;justify-content:space-between}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:10px;background:var(--card);overflow:hidden;margin-top:24px;max-width:820px}
  .stat{padding:15px 18px;border-right:1px solid var(--line);color:inherit} .stat:last-child{border-right:0} .stat:hover{background:var(--row-hover)}
  .stat .sl{font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  .stat .sv{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums;font-size:23px;font-weight:500;letter-spacing:-.01em;margin-top:8px} .stat .sv.acc{color:var(--accent)}
  .stat .sc{font-size:12px;color:var(--muted);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  @media(max-width:640px){.stats{grid-template-columns:1fr 1fr} .stat{border-bottom:1px solid var(--line)} .stat:nth-child(2n){border-right:0} .stat:nth-child(n+3){border-bottom:0}}
  .hub-h a{font-size:13px;font-weight:500;color:var(--accent-dk)}
  .catgrid{display:grid;grid-template-columns:1fr;gap:12px} @media(min-width:620px){.catgrid{grid-template-columns:1fr 1fr}}
  .cat{display:flex;gap:14px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:15px 18px;transition:.15s} .cat:hover{border-color:var(--accent);background:var(--row-hover)}
  .cat .ci{display:none}
  .cat .ct{font-family:'IBM Plex Sans',sans-serif;font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px}
  .cat .cn{font-size:11.5px;font-weight:700;font-family:'IBM Plex Mono',monospace;color:var(--accent-dk);background:var(--accent-soft);border-radius:999px;padding:2px 8px}
  .cat .cd{font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.5} .cat .cd b{color:var(--ink);font-family:'IBM Plex Mono',monospace}
  /* home trending: 2-row grid that scrolls sideways on mobile, 4-col wall on desktop */
  .trgrid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(2,1fr);grid-auto-columns:min(74vw,264px);gap:12px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px;min-width:0} .trgrid::-webkit-scrollbar{display:none}
  @media(min-width:720px){.trgrid{grid-auto-flow:row;grid-template-columns:repeat(4,1fr);grid-template-rows:none;grid-auto-columns:auto;overflow:visible}}
  .trwall{display:grid;grid-template-columns:1fr 1fr;gap:12px} @media(min-width:720px){.trwall{grid-template-columns:repeat(4,1fr)}}
  .trcard{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:15px 16px} .trcard:hover{border-color:var(--accent)}
  .tchip .up{color:var(--up)} .tchip .down{color:var(--down)}
  .readmore{display:inline-block;margin-top:14px;font-size:14px;font-weight:600;color:var(--accent-dk)} .readmore:hover{text-decoration:underline}
  .hubnews .nd{font-size:13px;color:var(--muted);line-height:1.5;margin-top:5px}
  .pager{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:20px 0 4px}
  .pager .pg{font-family:inherit;font-size:13px;font-weight:600;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:9px;padding:8px 12px;cursor:pointer;min-width:38px}
  .pager .pg:hover:not([disabled]){border-color:var(--accent);color:var(--ink)} .pager .pg.on{background:var(--accent);color:#fff;border-color:var(--accent)} .pager .pg[disabled]{opacity:.4;cursor:default}
  .pager .pg-dots{color:var(--muted);align-self:center;padding:0 2px}
  .trcard .tn{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .trcard .tt{color:var(--muted);font-size:11px;font-family:'IBM Plex Mono',monospace;margin-left:5px}
  .trcard .tp{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:19px;margin-top:8px}
  .trcard .tm{font-size:12px;margin-top:4px;font-family:'IBM Plex Mono',monospace} .trcard .tm .ty{color:var(--accent-dk);font-weight:600} .trcard .tm .up{color:var(--up)} .trcard .tm .down{color:var(--down)}
  .hubnews{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:2px 18px}
  .hubnews a{display:block;padding:15px 0;border-bottom:1px solid var(--line);color:inherit} .hubnews a:last-child{border-bottom:0}
  .hubnews .nt{font-weight:600;font-size:15px;line-height:1.4} .hubnews a:hover .nt{color:var(--accent-dk)}
  .hubnews .nm{font-size:11.5px;color:var(--muted);margin-top:6px;font-family:'IBM Plex Mono',monospace}
  /* ---- category-page Top 10 block ---- */
  .pill-n{opacity:.72;font-weight:500;margin-left:2px}
  .top10{display:grid;grid-template-columns:1fr;gap:10px;margin-top:4px} @media(min-width:640px){.top10{grid-template-columns:1fr 1fr}}
  .t10{display:flex;align-items:center;gap:13px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 15px;transition:.15s} .t10:hover{border-color:var(--accent);background:var(--row-hover)}
  .t10 .rk{flex:0 0 auto;width:29px;height:29px;border-radius:9px;background:var(--accent-soft);color:var(--accent-dk);font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Mono',monospace}
  .t10.gold .rk{background:var(--accent);color:#fff}
  .t10 .ti{flex:1;min-width:0;display:block} .t10 .tn{display:block;font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .t10 .tn .tick{margin-left:5px}
  .t10 .ts{display:block;color:var(--muted);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .t10 .ty{flex:0 0 auto;text-align:right} .t10 .tyv{display:block;font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:16px;color:var(--accent-dk)} .t10 .tyv.mut{color:var(--muted);font-weight:600} .t10 .tp{display:block;font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace;margin-top:2px}
  /* ---- moomoo affiliate card (stock pages) ---- */
  .mm-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;position:relative;overflow:hidden;margin:26px 0 8px;max-width:820px}
  .mm-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
  .mm-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:11px}
  .mm-eyebrow{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-dk)}
  .mm-tile{background:#fff;border-radius:11px;padding:7px 11px;display:inline-flex;align-items:center;box-shadow:0 1px 4px rgba(58,42,32,.12)}
  .mm-tile img{height:38px;width:auto;display:block}
  .mm-lede{font-size:14.5px;color:var(--muted);line-height:1.6;margin-bottom:14px} .mm-lede b{color:var(--ink)}
  .mm-offer{font-size:13px;font-weight:600;color:var(--accent-dk);background:var(--accent-soft);border-radius:10px;padding:9px 13px;margin-bottom:16px;line-height:1.5} .mm-offer b{font-weight:700}
  .mm-btn{display:inline-flex;align-items:center;gap:7px;background:var(--accent);color:#fff;font-weight:600;font-size:14px;text-decoration:none;padding:11px 20px;border-radius:999px} .mm-btn:hover{background:var(--accent-dk)}
  .mm-disc{font-size:11px;color:var(--muted);margin-top:12px;line-height:1.55}
  .related{display:grid;grid-template-columns:1fr;gap:8px;max-width:820px} @media(min-width:480px){.related{grid-template-columns:1fr 1fr}} @media(min-width:720px){.related{grid-template-columns:1fr 1fr 1fr}}
  .rel{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--line);border-radius:8px;padding:11px 14px;color:inherit} .rel:hover{border-color:var(--accent);background:var(--row-hover)}
  .rel-n{font-size:13.5px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rel-t{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);margin-left:7px}
  .rel-y{font-family:'IBM Plex Mono',monospace;font-size:13.5px;font-weight:600;color:var(--accent-dk);flex:0 0 auto}
  /* ---- stock header: tags, actions, KPI strip ---- */
  .st-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .st-tags{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
  .st-tag{font-size:11.5px;font-weight:600;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:3px 9px} .st-tag.mono{font-family:'IBM Plex Mono',monospace}
  .st-acts{flex:0 0 auto;display:flex;gap:8px}
  .st-save{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--accent-dk);background:var(--accent-soft);border:1px solid transparent;border-radius:999px;padding:8px 13px;cursor:pointer;font-family:inherit}
  .st-kpi{display:grid;grid-template-columns:repeat(4,1fr);margin-top:18px;max-width:640px;border:1px solid var(--line);border-radius:10px;overflow:hidden} @media(max-width:560px){.st-kpi{grid-template-columns:1fr 1fr}}
  .kbox{background:var(--card);border:0;border-right:1px solid var(--line);border-radius:0;padding:13px 16px} .kbox:last-child{border-right:0} @media(max-width:560px){.kbox:nth-child(2n){border-right:0} .kbox:nth-child(-n+2){border-bottom:1px solid var(--line)}}
  .kbox .kl{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
  .kbox .kv{font-family:'IBM Plex Mono',monospace;font-size:17px;font-weight:700;margin-top:3px} .kbox .kv.acc{color:var(--accent-dk)}
  .kicker,thead th,.lhead,.kbox .kl,.bigstat .k,.nextcard .k,.lsort{font-family:'IBM Plex Mono',monospace}
  .st-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:var(--ink);color:var(--bg);font-size:13px;font-weight:500;padding:11px 18px;border-radius:999px;box-shadow:0 12px 30px -12px rgba(0,0,0,.5);opacity:0;visibility:hidden;transition:.25s ease;z-index:60} .st-toast.on{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}
  .st-save.on{background:var(--accent);color:#fff}
  /* ---- account / login ---- */
  .ac-note{color:var(--muted);padding:20px 2px}
  .ac-authwrap{max-width:420px;margin:6px auto 0}
  .ac-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
  .ac-authcard{text-align:center}
  .ac-lede{color:var(--muted);font-size:14px;line-height:1.6;margin-bottom:18px}
  .ac-google{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;font-size:15px;font-weight:600;color:var(--ink);cursor:pointer;font-family:inherit} .ac-google:hover{background:var(--row-hover);border-color:var(--muted)}
  .ac-google:disabled{opacity:.55;cursor:not-allowed} .ac-google:disabled:hover{background:var(--card);border-color:var(--line)}
  .ac-or{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:12px;margin:16px 0} .ac-or:before,.ac-or:after{content:"";flex:1;height:1px;background:var(--line)}
  .ac-emailform{display:flex;flex-direction:column;gap:10px} .ac-emailform input{border:1px solid var(--line);background:var(--bg);border-radius:12px;padding:12px 14px;font-size:15px;font-family:inherit;color:var(--ink);text-align:center} .ac-emailform input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .ac-msg{font-size:13px;margin-top:12px;line-height:1.5} .ac-msg.ok{color:#0c7a4e} html[data-theme="dark"] .ac-msg.ok{color:#5fd39e} .ac-msg.err{color:#c0442e}
  .ac-fine{font-size:12px;color:var(--muted);margin-top:14px;line-height:1.6}
  .ac-head{display:flex;align-items:center;justify-content:space-between;gap:14px}
  .ac-who{display:flex;align-items:center;gap:13px;min-width:0}
  .ac-avatar{width:44px;height:44px;flex:0 0 auto;border-radius:50%;background:var(--accent-soft);color:var(--accent-dk);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;font-family:'IBM Plex Serif',sans-serif}
  .ac-nm{font-weight:700;font-size:16px;display:block} .ac-em{color:var(--muted);font-size:13px;font-family:'IBM Plex Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:200px}
  .ac-signout{font-size:12.5px;font-weight:600;color:var(--muted);background:none;border:1px solid var(--line);border-radius:999px;padding:8px 14px;cursor:pointer;flex:0 0 auto} .ac-signout:hover{color:var(--ink);border-color:var(--muted)}
  .acct-ic{position:relative}
  .ac-avatar{background:linear-gradient(135deg,var(--accent),var(--accent-dk));color:#fff}
  .ac-sect{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:26px 2px 10px}
  .ac-secth{font-family:'IBM Plex Serif',sans-serif;font-weight:600;font-size:16px}
  .ac-sectc{font-size:13px;color:var(--muted)}
  .ac-soon{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent-dk);background:var(--accent-soft);border-radius:999px;padding:3px 9px}
  .ac-wlcard{padding:2px 16px}
  .ac-empty{color:var(--muted);font-size:13.5px;text-align:center;padding:16px 0;line-height:1.6}
  .ac-emptybox{text-align:center;padding:22px 10px} .ac-emptybox svg{color:var(--line);margin-bottom:8px}
  .ac-browse{display:inline-block;margin-top:12px;font-size:14px;font-weight:600;color:#fff;background:var(--accent);padding:9px 18px;border-radius:999px} .ac-browse:hover{background:var(--accent-dk)}
  .ac-wl{display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--line)} .ac-wl:last-child{border-bottom:0}
  .ac-wllink{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:14px 0;color:inherit} .ac-wllink:hover .ac-wlnm{color:var(--accent-dk)}
  .ac-wlinfo{flex:1;min-width:0} .ac-wlnm{font-weight:600;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .ac-wlsub{display:block;color:var(--muted);font-size:12.5px;margin-top:2px;font-family:'IBM Plex Mono',monospace}
  .ac-wly{flex:0 0 auto;text-align:right;font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:15.5px;color:var(--accent-dk);line-height:1.1} .ac-wly.mut{color:var(--muted);font-weight:500}
  .ac-wlyl{display:block;font-family:'IBM Plex Sans',sans-serif;font-size:10px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);margin-top:1px}
  .ac-x{color:var(--muted);background:none;border:0;cursor:pointer;padding:8px;border-radius:8px;flex:0 0 auto;display:inline-flex} .ac-x:hover{color:#c0442e;background:var(--row-hover)}
  .ac-alerts{padding:6px 18px}
  .ac-alert{display:flex;gap:13px;align-items:flex-start;padding:13px 0;border-bottom:1px solid var(--line)} .ac-alert:last-of-type{border-bottom:0}
  .ac-alic{width:34px;height:34px;flex:0 0 auto;border-radius:9px;background:var(--accent-soft);color:var(--accent-dk);display:flex;align-items:center;justify-content:center}
  .ac-alt{font-weight:600;font-size:14px;display:block} .ac-ald{display:block;color:var(--muted);font-size:12.5px;margin-top:2px;line-height:1.5}
  .ac-alsend{font-size:12px;color:var(--muted);text-align:center;margin:14px 0 6px;line-height:1.5} .ac-alsend b{color:var(--ink)}
  /* account tabs */
  .ac-tabs{display:flex;border-bottom:1px solid var(--line);margin:22px 0 4px}
  .ac-tab{flex:1 1 0;text-align:center;background:none;border:0;border-bottom:2px solid transparent;padding:12px 8px;margin-bottom:-1px;font-family:'IBM Plex Serif',sans-serif;font-size:15px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap} .ac-tab.on{color:var(--ink);border-bottom-color:var(--accent)} .ac-tab:hover{color:var(--ink)}
  .ac-pane{padding-top:6px}
  .ac-sect{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:16px 2px 8px} .ac-sectc{font-size:13px;color:var(--muted)}
  .ac-grp{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:18px 2px 8px;display:flex;align-items:center;gap:7px} .ac-grp span{font-family:'IBM Plex Mono',monospace;color:var(--accent-dk);background:var(--accent-soft);border-radius:999px;padding:1px 8px;font-size:10.5px}
  .ac-grpcard{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:2px 16px}
  /* profile form */
  .ac-form{padding:20px} .ac-formlede{font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:16px}
  .ac-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;min-width:0} .ac-field label{font-size:12px;font-weight:600;color:var(--muted)} .ac-opt{font-weight:400;text-transform:none;letter-spacing:0;opacity:.8}
  .ac-field input{width:100%;min-width:0;border:1px solid var(--line);background:var(--bg);border-radius:11px;padding:11px 13px;font-size:15px;font-family:inherit;color:var(--ink)} .ac-field input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)} .ac-field input:disabled{color:var(--muted);cursor:not-allowed}
  .ac-row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
  .ac-savebar{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:6px} .ac-save{padding:10px 20px;border-radius:11px}
  .ac-saved{font-size:13px;font-weight:600;color:#0c7a4e} html[data-theme="dark"] .ac-saved{color:#5fd39e} .ac-saved.err{color:#c0442e}
  .ac-note{font-size:12px;color:var(--muted);flex:1;text-align:left}
  /* alert toggles */
  .ac-toprow{display:flex;align-items:center;gap:14px;justify-content:space-between;padding:14px 0 4px;border-bottom:1px solid var(--line)} .ac-alt2{font-weight:600;font-size:14.5px} .ac-toprow .ac-alt2{font-size:15px}
  .ac-subs{transition:opacity .2s} .ac-subs.off{opacity:.45;pointer-events:none}
  .ac-alert2{display:flex;gap:12px;align-items:center;padding:13px 0;border-bottom:1px solid var(--line)} .ac-alert2:last-child{border-bottom:0}
  .sw{flex:0 0 auto;width:46px;height:27px;border-radius:999px;background:var(--line);position:relative;cursor:pointer;transition:.2s;border:0;padding:0}
  .sw:after{content:"";position:absolute;top:3px;left:3px;width:21px;height:21px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
  .sw.on{background:var(--accent)} .sw.on:after{left:22px}
`;
const SEARCH_IC = `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;

const shell = (title, desc, canon, body, script='', og='/og.png') => `<!DOCTYPE html>
<html lang="en"><head>
<script>(function(){try{var t=localStorage.getItem('theme');if(!t&&window.matchMedia)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="google-site-verification" content="GP6YGT1x9z7T6QlUkLDTXvfbGlqkocw2RSWOWmKkO1Q">
<link rel="icon" href="/favicon.ico?v=3" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=3"><link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png?v=3"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=3">
<meta name="theme-color" content="#2647DD">
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
</main>
${FOOTER}
${script}<script>
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
  stk:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h13M3 12h13M3 18h9"/><path d="M19 9l2 2-2 2M19 15l2 2-2 2" opacity="0"/><circle cx="20" cy="6" r="1.6"/><circle cx="20" cy="12" r="1.6"/></svg>`,
  bc:   `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M8.5 12.4 7 21l5-3 5 3-1.5-8.6"/></svg>`,
  tb:   `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.4"/><path d="M6 12h.01M18 12h.01"/></svg>`,
};
const catCard = (href, ic, title, count, desc) => `    <a class="cat" href="${href}"><span class="ci">${CAT_IC[ic]}</span><span style="min-width:0"><span class="ct">${title}${count!=null?`<span class="cn">${count}</span>`:''}</span><span class="cd">${desc}</span></span></a>`;
const trCard = (c) => {
  const CS = csym(c.cur);
  const chg = c.chg;
  const chgTxt = (chg!=null && chg!==0) ? `<span class="${chg>0?'up':'down'}">${chg>0?'▲':'▼'} ${Math.abs(chg).toFixed(1)}%</span>` : '';
  const yTxt = c.yieldPct!=null ? `<span class="ty">${c.yieldPct.toFixed(2)}% yield</span>` : '';
  return `    <a class="trcard" href="/stock/${c.slug}/"><div class="tn">${c.name}${c.ticker?`<span class="tt">${c.ticker}</span>`:''}</div><div class="tp">${pxf(CS,c.price)}</div><div class="tm">${[yTxt,chgTxt].filter(Boolean).join(' · ')||'&nbsp;'}</div></a>`;
};
function homepage(listed, index, hub, upcoming) {
  const idxJson = JSON.stringify(index).replace(/</g,'\\u003c');
  const topY = (listed||[]).filter(c => c.yieldPct!=null && !c.divIncomplete && c.yieldPct<=30).sort((a,b)=>b.yieldPct-a.yieldPct)[0];
  const nextEx = (upcoming||[])[0];
  const statsHTML = (topY || nextEx || hub.ssbHi!=null) ? `  <div class="stats">
    ${topY?`<a class="stat" href="/dividends/"><div class="sl">Highest yield</div><div class="sv acc">${topY.yieldPct.toFixed(2)}%</div><div class="sc">${esc(topY.name)}</div></a>`:''}
    <a class="stat" href="/stocks/"><div class="sl">Counters tracked</div><div class="sv">${hub.stockCount}</div><div class="sc">Stocks · REITs · ETFs</div></a>
    ${nextEx?`<a class="stat" href="/dividend-calendar/"><div class="sl">Next ex-date</div><div class="sv">${prettyShort(nextEx.exISO)}</div><div class="sc">${esc(nextEx.name)}</div></a>`:''}
    ${hub.ssbHi!=null?`<a class="stat" href="/ssb/"><div class="sl">SSB 10-yr</div><div class="sv">${hub.ssbHi.toFixed(2)}%</div><div class="sc">this month</div></a>`:''}
  </div>` : '';
  const trendingChips = (hub.trending||[]).slice(0,8).map(c => {
    const m = c.yieldPct!=null ? `<b>${c.yieldPct.toFixed(1)}%</b>`
      : (c.chg!=null && c.chg!==0 ? `<b class="${c.chg>0?'up':'down'}">${c.chg>0?'+':''}${c.chg.toFixed(1)}%</b>` : '');
    return `<a class="tchip" href="/stock/${c.slug}/">${c.name.split(/\s|-/)[0]}${m?' '+m:''}</a>`;
  }).join('');
  const cards = [
    catCard('/stocks/', 'stk', 'All Singapore stocks', hub.stockCount, 'Every SGX counter — price, market cap &amp; P/E.'),
    catCard('/blue-chips/', 'bc', 'Blue-chip stocks', null, 'The biggest SGX companies — the STI heavyweights.'),
    catCard('/dividends/', 'div', 'Best dividend stocks', hub.divCount, 'Every SGX payer ranked by dividend yield.'),
    catCard('/reits/', 'reit', 'Best REITs to buy', hub.reitCount, 'S-REITs &amp; trusts by distribution yield.'),
    catCard('/etfs/', 'etf', 'Best ETFs', hub.etfCount, 'SGX ETFs ranked by distribution yield.'),
    catCard('/dividend-calendar/', 'cal', 'Dividend calendar', null, 'Upcoming ex-dates &amp; pay dates, in order.'),
    catCard('/ssb/', 'ssb', 'Savings Bonds (SSB)', null, hub.ssbLo!=null?`This month <b>${hub.ssbLo.toFixed(2)}%</b> → <b>${hub.ssbHi.toFixed(2)}%</b>. Rates, swap &amp; calculator.`:'Rates, step-up schedule, swap &amp; calculator.'),
    catCard('/t-bills/', 'tb', 'T-bill rates', null, hub.tb6!=null?`Latest 6-mo <b>${hub.tb6.toFixed(2)}%</b>. Cut-off yields, next auction & history.`:'Latest 6-month & 1-year auction cut-off yields.'),
    catCard('/dividends/', 'hy', 'Highest yield', hub.hyCount, 'Top yielders — with a risk note on the specials.'),
  ].join('\n');
  const trending = (hub.trending||[]).slice(0,8).map(trCard).join('\n');
  const newsHTML = (hub.news||[]).length ? `  <div class="hub-h">Latest news <a href="/news/">Read more →</a></div>
  <div class="hubnews">
${hub.news.map(n => `    <a href="${esc(n.link)}" target="_blank" rel="noopener nofollow"><div class="nt">${esc(n.title)}</div><div class="nm">${[n.source?esc(n.source):null, n.dateISO?pretty(n.dateISO):null].filter(Boolean).join(' · ')} · read ↗</div></a>`).join('\n')}
  </div>` : '';
  const body = `  <section class="hub-hero">
    <span class="kicker">Singapore dividends · updated daily</span>
    <h1>Every Singapore stock, one clean search.</h1>
    <p class="sub">Dividends, yields, ex-dates, REITs, ETFs and savings bonds — free, fast, no clutter.</p>
    <div class="hub-search">${SEARCH_IC}<input id="q" type="text" autocomplete="off" placeholder="Search a stock or ticker — e.g. Singtel, DBS, S68"><div id="qres"></div></div>
    <div class="trend"><span class="tl">Trending:</span>${trendingChips}</div>
  </section>
${statsHTML}
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
    <p class="sub" style="margin-bottom:6px">The latest on the Singapore market and SGX-listed companies — refreshed through the day.</p>
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
  const priceTxt = pxf(CS,c.price);
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
  const priceTxt = pxf(csym(c.cur),c.price);
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
    return `      <a class="t10${i<3?' gold':''}" href="/stock/${c.slug}/"><span class="rk">${i+1}</span><span class="ti"><span class="tn">${c.name}${c.ticker?`<span class="tick">${c.ticker}</span>`:''}</span><span class="ts">${sub}</span></span><span class="ty"><span class="${yCls}">${y}</span>${c.price?`<span class="tp">${pxf(CS,c.price)}</span>`:''}</span></a>`;
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

// ---------- Best performing REITs (ranked by real 1-year price return; 52-week-range fallback on fast builds) ----------
// 1-year price return from the weekly-close series (Yahoo). Returns null unless there is ~a full
// year of history, so we never overstate a newly-listed REIT's gain. Distributions are excluded
// (shown separately as yield) — this is price performance, honestly labelled.
const reitRet1y = (c) => {
  const p = c.prices;
  if (!Array.isArray(p) || p.length < 20) return null;
  const lastPt = p[p.length - 1];
  const last = c.price || lastPt.c;
  if (!last) return null;
  const target = lastPt.t - 365 * 86400;            // ~1 year ago (timestamps are Unix seconds)
  if (p[0].t > target + 40 * 86400) return null;    // <~11 months of history — skip rather than mislead
  let base = null;
  for (const pt of p) { if (pt.t >= target) { base = pt.c; break; } }
  if (base == null || base <= 0) return null;
  return (last - base) / base * 100;
};
// Position in the 52-week range (0 = at low, 100 = at high). Always available from cached Yahoo
// fundamentals, so it's the fallback ranking when the live price series isn't present (push builds).
const reitRangePos = (c) => {
  const f = c.fund;
  if (!f || f.w52lo == null || f.w52hi == null || !(c.price > 0) || !(f.w52hi > f.w52lo)) return null;
  return Math.max(0, Math.min(100, (c.price - f.w52lo) / (f.w52hi - f.w52lo) * 100));
};
function bestPerfReitsPage(reitList) {
  const rows = reitList.map(c => ({ c, ret: reitRet1y(c), pos: reitRangePos(c) }));
  const useReturn = rows.filter(r => r.ret != null).length >= 5;   // full build → real returns; fast build → range fallback
  const ranked = (useReturn ? rows.filter(r => r.ret != null) : rows.filter(r => r.pos != null))
    .sort((a, b) => useReturn ? b.ret - a.ret : b.pos - a.pos);
  const metricLabel = useReturn ? '1-year return' : '52-week range';
  const card = (r, i) => {
    const c = r.c, CS = csym(c.cur);
    const val = useReturn ? `${r.ret >= 0 ? '+' : ''}${r.ret.toFixed(1)}%` : `${r.pos.toFixed(0)}%`;
    const neg = useReturn && r.ret < 0;
    const yld = c.yieldPct != null ? `${c.yieldPct.toFixed(2)}% yield` : (c.divIncomplete ? 'scrip payer' : 'no dividend');
    return `      <a class="t10${i < 3 ? ' gold' : ''}" href="/stock/${c.slug}/"><span class="rk">${i + 1}</span><span class="ti"><span class="tn">${c.name}${c.ticker ? `<span class="tick">${c.ticker}</span>` : ''}</span><span class="ts">REIT · ${yld}</span></span><span class="ty"><span class="tyv${neg ? ' mut' : ''}">${val}</span>${c.price ? `<span class="tp">${pxf(CS, c.price)}</span>` : ''}</span></a>`;
  };
  const h1 = `Best performing REITs in Singapore — ${YEAR}`;
  const sub = useReturn
    ? `All ${ranked.length} SGX-listed REITs &amp; business trusts, ranked by 1-year share-price return. Updated ${prettyShort(TODAY)}.`
    : `All ${ranked.length} SGX-listed REITs &amp; business trusts, ranked by where they trade in their 52-week range. Updated ${prettyShort(TODAY)}.`;
  const intro = `&ldquo;Best performing&rdquo; here means <b>price performance</b>, not yield &mdash; ${useReturn
    ? `each S-REIT below is ranked by its <b>share-price return over the last 12 months</b>, with distributions paid on top (the yield column shows the income you'd also have earned).`
    : `each S-REIT below is ranked by where its price sits in its <b>52-week range</b> &mdash; near the top means it has been one of the year's stronger performers.`} Want income instead? See our <a href="/reits/">best REITs by dividend yield</a>. Figures refresh daily and are for information only, not advice.`;
  const faqs = [
    { q: `What is the best performing REIT in Singapore in ${YEAR}?`, a: `This page ranks every SGX-listed S-REIT and business trust by ${useReturn ? '12-month share-price return' : 'position in its 52-week price range'}, updated daily. Past performance doesn't guarantee future results, so always check a REIT's sector, gearing and outlook before investing.` },
    { q: 'Does "best performing" mean the highest dividend yield?', a: 'No. Yield measures income; performance here measures share-price gain over the past year. A REIT can have a high yield but a falling price, or a rising price with a modest yield. This page ranks by price performance and shows the yield beside each one so you see both.' },
    { q: 'Are the best performing REITs a good buy?', a: 'Not automatically. A REIT that has already risen strongly may be fully valued, while a laggard could be a recovery play or a value trap. Use this ranking as a starting point, then weigh each REIT’s fundamentals, sector and interest-rate sensitivity.' },
    { q: 'How often is this ranking updated?', a: 'Daily. Prices come from the Singapore Exchange (SGX) and Yahoo Finance, and the ranking is recomputed on every scheduled build.' },
  ];
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": faqs.map(f => ({ "@type": "Question", "name": f.q, "acceptedAnswer": { "@type": "Answer", "text": f.a } })) }).replace(/</g, '\\u003c')}</script>`;
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 4px">${h1}</h1>
    <p class="sub" style="margin-bottom:2px">${sub}</p>
  </section>
  <div class="hub-h" style="margin:14px 0 12px">Ranked by ${metricLabel} <span style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--accent-dk);background:var(--accent-soft);border-radius:999px;padding:3px 10px;margin-left:2px">best first</span></div>
  <div class="top10">
${ranked.map(card).join('\n')}
  </div>
  <p class="metaline" style="font-size:12px;margin-top:14px">${useReturn ? '1-year return = change in share price over the last ~52 weeks, from weekly closing prices; it excludes distributions (shown separately as yield).' : 'Ranked by position in the 52-week price range while the full price history refreshes on the next scheduled build.'} Prices from SGX &amp; Yahoo Finance, updated daily. Not investment advice.</p>
  <div class="intro" style="margin-top:18px">${intro}</div>
  ${faqHTML}
  ${jsonLd}`;
  const title = `Best Performing REITs in Singapore ${YEAR} — S-REITs by 1-Year Return | StockKaki`;
  const desc = `SGX-listed REITs ranked by 1-year share-price return for ${YEAR} — see which Singapore S-REITs and business trusts have performed best, with dividend yields alongside. Updated daily, free.`;
  return shell(title, desc, SITE + '/best-performing-reits/', body, '', '/og/reits.png');
}

// ---------- Bank rates: Fixed Deposits + Savings Accounts (verified monthly against each bank's own page) ----------
// Compact card: essentials always visible; full detail lives in .rc-detail (in the HTML for SEO,
// display:none) and is revealed in the bottom-sheet drawer on tap.
const rateCard = (r, i) => {
  const badge = r.verified ? ` <span style="font-size:10px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--up)">&#10003;</span>` : ` <span style="font-size:10px;color:var(--muted)">listed</span>`;
  const meta = [r.tenure ? esc(r.tenure) : null, r.min ? 'min S$' + r.min.toLocaleString() : null].filter(Boolean).join(' &middot; ');
  return `      <div class="rcard" role="button" tabindex="0" data-bank="${esc(r.bank)}" data-url="${esc(r.url)}" onclick="openSheet(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSheet(this)}">
        <span class="rk"${i < 3 ? ' style="background:var(--accent);color:#fff"' : ''}>${i + 1}</span>
        <div class="rc-main">
          <div class="rc-top"><span class="rc-bank">${esc(r.bank)}${badge}</span><span class="rc-rate">${r.rate.toFixed(2)}<span> % p.a.</span></span></div>
          <div class="rc-meta"><span class="rc-metatext">${meta}</span><span class="rc-more">details &rsaquo;</span></div>
        </div>
        <div class="rc-detail">${esc(r.note || '')}</div>
      </div>`;
};
function ratePage({ title, desc, h1, sub, intro, list, faqs, canon, tag }) {
  const sorted = [...list].sort((a, b) => b.rate - a.rate);
  // Deep "help you understand" layer — served from a script object, NOT the indexed HTML (keeps the
  // page lean and doesn't dilute SEO; its job is to help the reader, not to rank).
  const detailMap = Object.fromEntries(list.map(r => [r.bank, {
    ex: `At ${r.rate.toFixed(2)}% p.a., every S$10,000 earns about S$${Math.round(r.rate * 100)} a year${r.tenure ? '' : ' — at the full rate, once you meet the conditions'}.`,
    watch: r.watch || '',
    suits: r.suits || '',
    steps: r.steps || [],
  }]));
  const detailJSON = JSON.stringify(detailMap).replace(/</g, '\\u003c');
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": faqs.map(f => ({ "@type": "Question", "name": f.q, "acceptedAnswer": { "@type": "Answer", "text": f.a } })) }).replace(/</g, '\\u003c')}</script>`;
  const topR = sorted[0];
  const lowMin = [...list].filter(r => r.min).sort((a, b) => a.min - b.min)[0];
  const summary = `<div style="background:var(--accent-soft);border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:13px"><b>Quick answer:</b> top rate &mdash; ${esc(topR.bank)} <b>${topR.rate.toFixed(2)}%</b>${lowMin ? `; lowest entry &mdash; ${esc(lowMin.bank)} at <b>S$${lowMin.min.toLocaleString()}</b>` : ''}. Tap any bank for the details.</div>`;
  const style = `<style>
.rcard{display:flex;gap:12px;align-items:center;width:100%;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 15px;margin-bottom:10px;cursor:pointer;transition:border-color .15s}
.rcard:hover,.rcard:focus-visible{border-color:var(--accent);outline:none}
.rc-main{flex:1;min-width:0}
.rc-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.rc-bank{font-weight:600}
.rc-rate{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:17px;color:var(--accent-dk);white-space:nowrap}
.rc-rate span{font-size:11px;color:var(--muted);font-weight:600}
.rc-meta{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted);margin-top:3px}
.rc-more{color:var(--accent-dk);white-space:nowrap;font-weight:600}
.rc-detail{display:none}
.skscrim{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;visibility:hidden;transition:opacity .25s;z-index:60}
.skscrim.on{opacity:1;visibility:visible}
.sksheet{position:fixed;left:0;right:0;bottom:0;z-index:61;background:var(--card);border-top:1px solid var(--line);border-radius:18px 18px 0 0;padding:6px 20px 28px;max-width:640px;margin:0 auto;transform:translateY(101%);transition:transform .28s cubic-bezier(.32,.72,0,1);box-shadow:0 -12px 40px rgba(0,0,0,.18)}
.sksheet.on{transform:translateY(0)}
.skgrab{width:40px;height:4px;border-radius:3px;background:var(--line);margin:8px auto 16px}
.skbank{font-family:'Playfair Display',serif;font-weight:700;font-size:19px}
.skrate{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:24px;color:var(--accent-dk);margin:4px 0 1px}
.skrate span{font-size:12px;color:var(--muted)}
.skmeta{font-size:13px;color:var(--muted);margin-bottom:14px}
.sknote{font-size:14.5px;line-height:1.6;margin-bottom:16px}
.sksec{margin-bottom:14px}
.sklabel{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent-dk);margin-bottom:3px}
.sksecv{font-size:14px;line-height:1.55}
.sksteps{margin:0;padding-left:20px;font-size:14px;line-height:1.5}
.sksteps li{margin-bottom:5px}
.sklink{display:inline-block;background:var(--accent);color:#fff;border-radius:11px;padding:11px 18px;text-decoration:none;font-weight:600;font-size:14px;margin-top:2px}
</style>`;
  const sheet = `<div class="skscrim" id="skscrim" onclick="closeSheet()"></div>
  <div class="sksheet" id="sksheet" role="dialog" aria-modal="true" aria-label="Rate details">
    <div class="skgrab"></div>
    <div class="skbank" id="skb"></div>
    <div class="skrate" id="skr"></div>
    <div class="skmeta" id="skm"></div>
    <div class="sknote" id="skn"></div>
    <div class="sksec" id="skex"><div class="sklabel">What it means for you</div><div class="sksecv" id="skexv"></div></div>
    <div class="sksec" id="sksteps"><div class="sklabel">How to reach the top rate</div><ol class="sksteps" id="skstepsv"></ol></div>
    <div class="sksec" id="skwatch"><div class="sklabel">Things to note</div><div class="sksecv" id="skwatchv"></div></div>
    <div class="sksec" id="sksuits"><div class="sklabel">Who it suits</div><div class="sksecv" id="sksuitsv"></div></div>
    <a class="sklink" id="skl" target="_blank" rel="noopener nofollow">View the bank&rsquo;s official page &rarr;</a>
    <div style="font-size:11px;color:var(--muted);margin-top:12px">Verified against the bank&rsquo;s own page &middot; always confirm before placing funds.</div>
  </div>`;
  const drawerJS = `<script>
window.RATEDETAIL=${detailJSON};
function openSheet(el){var g=function(id){return document.getElementById(id)};g('skb').textContent=el.dataset.bank;g('skr').innerHTML=el.querySelector('.rc-rate').innerHTML;g('skm').textContent=el.querySelector('.rc-metatext').textContent;g('skn').textContent=el.querySelector('.rc-detail').textContent;g('skl').href=el.dataset.url;
var d=(window.RATEDETAIL||{})[el.dataset.bank]||{};var sec=function(box,val,vEl){if(val){document.getElementById(vEl).textContent=val;document.getElementById(box).style.display='';}else{document.getElementById(box).style.display='none';}};sec('skex',d.ex,'skexv');sec('skwatch',d.watch,'skwatchv');sec('sksuits',d.suits,'sksuitsv');
var st=document.getElementById('skstepsv');if(d.steps&&d.steps.length){st.innerHTML=d.steps.map(function(s){return '<li>'+s.replace(/</g,'&lt;')+'</li>'}).join('');document.getElementById('sksteps').style.display='';}else{document.getElementById('sksteps').style.display='none';}
g('skscrim').classList.add('on');g('sksheet').classList.add('on');document.body.style.overflow='hidden';}
function closeSheet(){document.getElementById('skscrim').classList.remove('on');document.getElementById('sksheet').classList.remove('on');document.body.style.overflow='';}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeSheet();});
</script>`;
  const body = `${style}
  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 4px">${h1}</h1>
    <p class="sub" style="margin-bottom:2px">${sub}</p>
  </section>
  <div class="hub-h" style="margin:14px 0 10px">${tag} <span style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--accent-dk);background:var(--accent-soft);border-radius:999px;padding:3px 10px;margin-left:2px">verified ${prettyShort(BANK.updated)}</span></div>
  ${summary}
  ${sorted.map(rateCard).join('\n')}
  <p class="metaline" style="font-size:12px;margin-top:14px">Every rate here is checked against the bank&rsquo;s own website, last verified ${pretty(BANK.updated)}. Promotional rates can change at any time &mdash; always confirm with the bank before placing funds. Not financial advice.</p>
  <div class="intro" style="margin-top:18px">${intro}</div>
  ${faqHTML}
  ${jsonLd}
  ${sheet}`;
  return shell(title, desc, canon, body, drawerJS, '/og/home.png');
}
function savingsHubPage() {
  const fdBest = Math.max(...BANK.fd.map(r => r.rate)), svBest = Math.max(...BANK.savings.map(r => r.rate));
  const card = (name, href, blurb) => `    <a href="${href}" style="display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:12px;text-decoration:none">
      <div style="font-weight:600;color:var(--ink);font-size:16px">${name} <span style="color:var(--accent-dk)">&rarr;</span></div>
      <div style="font-size:13px;color:var(--muted);margin-top:4px">${blurb}</div>
    </a>`;
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 4px">Where to park your cash in Singapore</h1>
    <p class="sub">The safe, interest-earning options compared &mdash; fixed deposits, high-interest savings accounts, Singapore Savings Bonds and T-bills. Rates verified against each provider.</p>
  </section>
  <div style="margin-top:16px">
${card('Fixed Deposits', '/fixed-deposits/', `Lock in a guaranteed rate for a set term. Best verified now: <b>${fdBest.toFixed(2)}% p.a.</b>`)}
${card('Savings Accounts', '/savings-accounts/', `High-interest accounts that reward salary + spend. Up to <b>${svBest.toFixed(2)}% p.a.</b> (conditions apply).`)}
${card('Singapore Savings Bonds (SSB)', '/ssb/', 'Government-backed, fully flexible, step-up interest that rises the longer you hold.')}
${card('Treasury Bills (T-bills)', '/t-bills/', '6-month and 1-year Singapore Government T-bills, by latest auction cut-off yield.')}
  </div>
  <div class="intro" style="margin-top:18px">Every option here is capital-safe &mdash; either government-backed or SDIC-insured up to S$100,000 per bank. The best choice depends on how long you can set the money aside and how much flexibility you want; this hub keeps the current rates side by side so you can decide. Rates verified ${pretty(BANK.updated)}.</div>`;
  return shell(`Best Savings Rates in Singapore ${YEAR} — FD, Savings Accounts, SSB & T-bills | StockKaki`,
    `Compare where to park your cash in Singapore for ${YEAR} — fixed deposits, high-interest savings accounts, Singapore Savings Bonds and T-bills, with current verified rates. Free, updated.`,
    SITE + '/savings/', body, '', '/og/home.png');
}

// ---------- all Singapore stocks (full SGX universe) — same concept as the dividend page, ranked by market cap ----------
const stockRow = (c) => {
  const f = c.fund || {};
  const priceTxt = pxf(csym(c.cur),c.price);
  const mc = fmtCap(f.cur||c.cur, f.mktCap) || '—';
  const pe = f.pe!=null ? f.pe.toFixed(1) : '—';
  const chg = (c.chgPct!=null && c.chgPct!==0) ? c.chgPct : (f.chg!=null ? f.chg : null);
  const chgTxt = (chg!=null && chg!==0) ? (chg>0?'+':'')+chg.toFixed(2)+'%' : '—';
  const chgCls = 'lr-chg' + (chg>0?' up':chg<0?' down':'');
  const type = c.secType==='etfs' ? 'ETF' : c.isReit ? 'REIT' : 'Stock';
  const meta = [priceTxt, chgTxt!=='—'?chgTxt:null, f.mktCap?'Cap '+mc:null, f.pe!=null?'P/E '+pe:null].filter(Boolean).join('  ·  ') || type;
  return `        <a class="lrow" href="/stock/${c.slug}/" data-s="${esc((c.name+' '+(c.ticker||'')).toLowerCase())}" data-reit="${c.isReit?1:0}" data-etf="${c.secType==='etfs'?1:0}" data-n="${esc(c.name.toLowerCase())}" data-mc="${Math.round(capSGD(f.cur||c.cur, f.mktCap))}" data-pe="${f.pe||0}" data-chg="${chg!=null?chg:-999}">
          <span class="lr-name"><span class="lr-co">${c.name}</span>${c.ticker?`<span class="tick">${c.ticker}</span>`:''}</span>
          <span class="lr-price">${priceTxt}</span>
          <span class="${chgCls}">${chgTxt}</span>
          <span class="lr-mc">${mc}</span>
          <span class="lr-pe">${pe}</span>
          <span class="lr-meta">${meta}</span>
        </a>`;
};
function stocksPage(list) {
  // collapse dual-currency / secondary twins — the SAME security listed twice (e.g. "AEM SGD" + "AEM USD",
  // "CSOP … S$" + "US$", "Singtel" + "Singtel 10"). Keep one per name-group, preferring the SGD / most-traded line.
  const stripCur = (n) => n.replace(/\s*(?:S\$|US\$|U\$|SGD|USD|HKD|CNY|RMB|GBP|EUR|JPY|YEN\s?1k|CNY\s?1k|1k|10|100)\s*$/i,'').replace(/\s{2,}/g,' ').trim().toLowerCase();
  const bestBy = new Map();
  for (const c of list) { const k = stripCur(c.name); const score = (c.cur==='SGD'?1e15:0) + (((c.fund&&c.fund.vol)||c.vol||0) * (c.price||0)); const prev = bestBy.get(k); if (!prev || score > prev.s) bestBy.set(k, { c, s:score }); }
  const uniq = [...bestBy.values()].map(x => x.c);
  const sorted = [...uniq].sort((a,b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);   // A–Z default (reliable; market-cap data can be patchy)
  const nStock = uniq.filter(c => !c.isReit && c.secType!=='etfs').length;
  const nReit = uniq.filter(c => c.isReit).length;
  const nEtf = uniq.filter(c => c.secType==='etfs').length;
  const chips = `<div class="chips">
    <span class="chip on" data-f="all">All <span class="pill-n">${uniq.length}</span></span>
    <span class="chip" data-f="stock">Stocks <span class="pill-n">${nStock}</span></span>
    <span class="chip" data-f="reit">REITs &amp; Trusts <span class="pill-n">${nReit}</span></span>
    <span class="chip" data-f="etf">ETFs <span class="pill-n">${nEtf}</span></span>
  </div>`;
  const faqs = [
    { q: 'How many stocks are listed on the SGX?', a: `There are around ${uniq.length} counters listed on the Singapore Exchange (SGX), including ordinary shares, REITs, business trusts and ETFs. This page lists them all — search, filter and sort.` },
    { q: 'What are the biggest companies on the SGX?', a: 'By market capitalisation, the largest SGX-listed companies are the three local banks — DBS, OCBC and UOB — followed by names like Singtel and Singapore Exchange. Sort this list by market cap to see them ranked.' },
    { q: 'How do I buy Singapore stocks?', a: 'Open an account with any SGX brokerage (DBS Vickers, moomoo, Tiger, Interactive Brokers and others), or use SRS funds. You buy and sell SGX-listed shares in board lots during trading hours.' },
    { q: 'Which Singapore stocks pay dividends?', a: 'Many do — Singapore has no tax on dividends, so income investing is popular. See the dedicated best dividend stocks and best REITs pages for counters ranked by yield.' },
  ];
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@context":"https://schema.org", "@type":"FAQPage", "mainEntity":faqs.map(f => ({ "@type":"Question", "name":f.q, "acceptedAnswer":{ "@type":"Answer", "text":f.a } })) }).replace(/</g,'\\u003c')}</script>`;
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 4px">All Singapore stocks</h1>
    <p class="sub" style="margin-bottom:2px">Every SGX-listed counter — price, day change, market cap and P/E. Search, filter and sort.</p>
  </section>
  <div class="search" id="alltop" style="margin-top:16px">${SEARCH_IC}<input id="q" type="text" autocomplete="off" placeholder="Search any stock or ticker…"></div>
  ${chips}
  <div class="lsort"><button data-sort="n" class="on">A–Z</button><button data-sort="mc">Market cap</button><button data-sort="chg">% change</button></div>
  <div class="ltable cols-stocks" style="margin-top:12px">
    <div class="lrow lhead"><span data-sort="n">Company</span><span class="lr-price">Price</span><span class="lr-chg" data-sort="chg">Change</span><span class="lr-mc" data-sort="mc">Market cap</span><span class="lr-pe" data-sort="pe">P/E</span></div>
    <div id="tb">
${sorted.map(stockRow).join('\n')}
    </div>
  </div>
  <div id="none" class="empty" style="display:none">No match.</div>
  <div class="pager" id="lpager"></div>
  <p class="metaline" style="font-size:12px">Market cap, P/E and day change from live market data; last price from the SGX. Updated daily.</p>
  <div class="intro" style="margin-top:18px">The Singapore Exchange (SGX) is home to around <b>${uniq.length}</b> listed counters — from the big local banks and <a href="/blue-chips/">blue chips</a> to REITs, business trusts and ETFs. Above is every one of them with live price, day change, market cap and P/E. Use the filters for Stocks, REITs or ETFs, sort by name / market cap / day change, or search any name or ticker. Tap any counter for its full page — price, dividends, ex-dates, fundamentals and news.</div>
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
function sortBy(k){if(sk===k)sd=-sd;else{sk=k;sd=(k==='n')?1:-1;}
 const rows=[...tb.querySelectorAll('.lrow')];
 rows.sort((a,b)=>{let av=a.dataset[k],bv=b.dataset[k];if(k==='n'){av=av||'~';bv=bv||'~';return av<bv?-sd:av>bv?sd:0;}return (parseFloat(av)-parseFloat(bv))*sd;});
 rows.forEach(r=>tb.appendChild(r));
 document.querySelectorAll('.lhead [data-sort]').forEach(th=>{const o=th.querySelector('.ar');if(o)o.remove();if(th.dataset.sort===sk)th.insertAdjacentHTML('beforeend','<span class="ar">'+(sd<0?' ↓':' ↑')+'</span>');});
 document.querySelectorAll('.lsort button').forEach(bn=>bn.classList.toggle('on',bn.dataset.sort===sk));
 apply();}
document.querySelectorAll('.lhead [data-sort]').forEach(th=>th.addEventListener('click',()=>sortBy(th.dataset.sort)));
document.querySelectorAll('.lsort button').forEach(bn=>bn.addEventListener('click',()=>sortBy(bn.dataset.sort)));
sortBy('n');
</script>`;
  return shell('All Singapore Stocks — Every SGX-Listed Company | StockKaki',
    `Browse all ~${list.length} SGX-listed Singapore stocks, REITs and ETFs — with live price, day change, market cap and P/E. Search, filter and sort. Free, updated daily.`,
    SITE + '/stocks/', body, script, '/og/screener.png');
}

// ---------- Singapore blue-chip stocks — the largest, most established SGX companies (an STI proxy), by market cap ----------
function blueChipsPage(list) {
  // de-dupe currency twins the same way the stocks hub does, so DBS / OCBC etc. appear once
  const stripCur = (n) => n.replace(/\s*(?:S\$|US\$|U\$|SGD|USD|HKD|CNY|RMB|GBP|EUR|JPY|YEN\s?1k|CNY\s?1k|1k|10|100)\s*$/i,'').replace(/\s{2,}/g,' ').trim().toLowerCase();
  const score = (c) => (c.cur==='SGD'?1e15:0) + (((c.fund&&c.fund.vol)||c.vol||0) * (c.price||0));
  const bestBy = new Map();
  for (const c of list) { const k = stripCur(c.name); const prev = bestBy.get(k); if (!prev || score(c) > score(prev)) bestBy.set(k, c); }
  // second pass: collapse counters that share a ticker but have name variants (e.g. "Keppel Ltd." + "Keppel Corporation Ltd" = BN4)
  const byTicker = new Map();
  for (const c of bestBy.values()) { const k = c.ticker ? c.ticker.toUpperCase() : 'n:' + stripCur(c.name); const prev = byTicker.get(k); if (!prev || score(c) > score(prev)) byTicker.set(k, c); }
  const uniq = [...byTicker.values()];
  // blue chips = biggest, most established companies & trusts — exclude ETFs, require a market cap
  const pool = uniq.filter(c => c.secType!=='etfs' && c.fund && c.fund.mktCap);
  const N = 30;
  const sorted = [...pool].sort((a,b) => capSGD(b.fund.cur||b.cur, b.fund.mktCap) - capSGD(a.fund.cur||a.cur, a.fund.mktCap)).slice(0, N);
  const top5 = sorted.slice(0, 5).map(c => c.name);
  const top5Txt = top5.length >= 5 ? `${top5.slice(0, 4).join(', ')} and ${top5[4]}` : top5.join(', ');
  const faqs = [
    { q: 'What are the blue-chip stocks in Singapore?', a: `Blue chips are the largest, most established and financially sound companies listed on the SGX — the heavyweights that anchor the Straits Times Index (STI). By market capitalisation the biggest right now are ${top5Txt}. This page ranks the top ${sorted.length} by market cap, updated daily.` },
    { q: 'Are Singapore blue-chip stocks a good investment?', a: 'Blue chips are prized for stability, steady dividends and staying power through downturns rather than explosive growth. Many local blue chips — the banks, Singtel, ST Engineering — are popular income holdings because Singapore has no tax on dividends. As always, diversify and check each company’s fundamentals.' },
    { q: 'What is the Straits Times Index (STI)?', a: 'The STI tracks the 30 largest and most liquid companies on the SGX — effectively Singapore’s blue-chip benchmark. This list closely mirrors it, ranked by market capitalisation. You can also buy the whole basket in a single trade via an STI ETF.' },
    { q: 'How do I buy Singapore blue-chip stocks?', a: 'Through any SGX brokerage (DBS Vickers, moomoo, Tiger, Interactive Brokers and others), or with SRS funds. Many investors dollar-cost average into blue chips via a monthly regular-savings plan (RSP).' },
  ];
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@context":"https://schema.org", "@type":"FAQPage", "mainEntity":faqs.map(f => ({ "@type":"Question", "name":f.q, "acceptedAnswer":{ "@type":"Answer", "text":f.a } })) }).replace(/</g,'\\u003c')}</script>`;
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 4px">Singapore blue-chip stocks — ${YEAR}</h1>
    <p class="sub" style="margin-bottom:2px">The ${sorted.length} largest SGX-listed companies and trusts, ranked by market capitalisation — updated daily.</p>
  </section>
  <div class="intro" style="margin-top:14px">Blue chips are the biggest, most established companies on the SGX — the heavyweights that anchor the <b>Straits Times Index (STI)</b>: the local banks, Singtel, the exchange itself and other household names. They are prized for stability and steady, tax-free <a href="/dividends/">dividends</a> rather than explosive growth. Below are the <b>${sorted.length}</b> largest by market cap; tap any for its full page, or browse <a href="/stocks/">all SGX counters</a>.</div>
  <div class="search" id="alltop" style="margin-top:16px">${SEARCH_IC}<input id="q" type="text" autocomplete="off" placeholder="Filter blue chips…"></div>
  <div class="lsort"><button data-sort="mc" class="on">Market cap</button><button data-sort="chg">% change</button><button data-sort="n">A–Z</button></div>
  <div class="ltable cols-stocks" style="margin-top:12px">
    <div class="lrow lhead"><span data-sort="n">Company</span><span class="lr-price">Price</span><span class="lr-chg" data-sort="chg">Change</span><span class="lr-mc" data-sort="mc">Market cap</span><span class="lr-pe" data-sort="pe">P/E</span></div>
    <div id="tb">
${sorted.map(stockRow).join('\n')}
    </div>
  </div>
  <div id="none" class="empty" style="display:none">No match.</div>
  <div class="pager" id="lpager"></div>
  <p class="metaline" style="font-size:12px">Ranked by market capitalisation from live market data; last price from the SGX. A close proxy for the STI — updated daily.</p>
  ${faqHTML}
  ${jsonLd}`;
  const script = `<script>
const PER=30;
const q=document.getElementById('q'),tb=document.getElementById('tb'),none=document.getElementById('none'),pager=document.getElementById('lpager'),alltop=document.getElementById('alltop');
let matches=[],page=1;
function collect(){const v=q.value.trim().toLowerCase();
 matches=[...tb.querySelectorAll('.lrow')].filter(r=>(!v||r.dataset.s.includes(v)));}
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
pager.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;const total=Math.max(1,Math.ceil(matches.length/PER));if(b.dataset.p)page=+b.dataset.p;else page=Math.min(total,Math.max(1,page+(+b.dataset.d)));render(true);});
let sk='',sd=-1;
function sortBy(k){if(sk===k)sd=-sd;else{sk=k;sd=(k==='n')?1:-1;}
 const rows=[...tb.querySelectorAll('.lrow')];
 rows.sort((a,b)=>{let av=a.dataset[k],bv=b.dataset[k];if(k==='n'){av=av||'~';bv=bv||'~';return av<bv?-sd:av>bv?sd:0;}return (parseFloat(av)-parseFloat(bv))*sd;});
 rows.forEach(r=>tb.appendChild(r));
 document.querySelectorAll('.lhead [data-sort]').forEach(th=>{const o=th.querySelector('.ar');if(o)o.remove();if(th.dataset.sort===sk)th.insertAdjacentHTML('beforeend','<span class="ar">'+(sd<0?' ↓':' ↑')+'</span>');});
 document.querySelectorAll('.lsort button').forEach(bn=>bn.classList.toggle('on',bn.dataset.sort===sk));
 apply();}
document.querySelectorAll('.lhead [data-sort]').forEach(th=>th.addEventListener('click',()=>sortBy(th.dataset.sort)));
document.querySelectorAll('.lsort button').forEach(bn=>bn.addEventListener('click',()=>sortBy(bn.dataset.sort)));
sortBy('mc');
</script>`;
  return shell(`Singapore Blue-Chip Stocks ${YEAR} — Largest SGX Companies (STI) | StockKaki`,
    `The ${sorted.length} largest SGX-listed companies by market cap — Singapore's blue-chip stocks and STI heavyweights. Live price, market cap, P/E and yield. Free, updated daily.`,
    SITE + '/blue-chips/', body, script, '/og/screener.png');
}

// ---------- Singapore T-bill rates (latest MAS auction cut-off yields) ----------
function tbillsPage(tb) {
  const mo = fullMonthYr(TODAY);
  if (!tb || !tb.l6) {
    const body = `  <section class="hero" style="padding:22px 0 2px"><h1 class="serif" style="font-size:27px;margin:0 0 5px">Singapore T-Bill Rates — ${mo}</h1><p class="sub">Live T-bill auction data from MAS is temporarily unavailable — please check back shortly.</p></section>`;
    return shell(`Singapore T-Bill Rates ${YEAR} — Latest 6-Month & 1-Year Yields | StockKaki`, 'Latest Singapore Treasury Bill (T-bill) cut-off yields from MAS.', SITE + '/t-bills/', body);
  }
  const l6 = tb.l6, l1 = tb.l1, nx = tb.next;
  const tenorName = (t) => t === 0.5 ? '6-month' : t === 1 ? '1-year' : `${t}-year`;
  const nextHTML = nx
    ? `<span class="ssb-status open"><span class="pulse"></span>Next auction · ${pretty(nx.auction_date)} · ${tenorName(nx.auction_tenor)} T-bill · issues ${pretty(nx.issue_date)}</span>`
    : `<span class="ssb-status closed">Next auction date to be announced by MAS</span>`;
  const histRows = tb.hist6.map(r =>
    `        <tr><td class="date">${pretty(r.auction_date)}</td><td class="r amt">${r.cutoff_yield.toFixed(2)}%</td><td class="r yld">${r.bid_to_cover ? r.bid_to_cover.toFixed(2) + '×' : '—'}</td></tr>`).join('\n');

  // 6-month cut-off yield trend (inline SVG, no libs)
  const T = tb.trend, n = T.length;
  let chart = '';
  if (n >= 2) {
    const vals = T.map(p => p.y);
    const lo = Math.floor(Math.min(...vals) * 10) / 10, hi = Math.ceil(Math.max(...vals) * 10) / 10, span = (hi - lo) || 1;
    const W = 640, H = 200, PL = 6, PR = 46, PT = 14, PB = 26;
    const X = i => (PL + (W - PL - PR) * (n > 1 ? i / (n - 1) : 0));
    const Y = v => (PT + (H - PT - PB) * (1 - (v - lo) / span));
    const pts = T.map((p, i) => X(i).toFixed(1) + ',' + Y(p.y).toFixed(1)).join(' ');
    const last = T[n - 1];
    chart = `  <div class="h2">6-month T-bill yield trend</div>
  <div class="chartwrap">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;overflow:visible" role="img" aria-label="Singapore 6-month T-bill cut-off yield trend">
      <line x1="${PL}" y1="${Y(hi).toFixed(1)}" x2="${W - PR}" y2="${Y(hi).toFixed(1)}" stroke="var(--line)"/>
      <line x1="${PL}" y1="${Y(lo).toFixed(1)}" x2="${W - PR}" y2="${Y(lo).toFixed(1)}" stroke="var(--line)"/>
      <text x="${W - PR + 6}" y="${(Y(hi) + 4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'IBM Plex Mono',monospace">${hi.toFixed(1)}%</text>
      <text x="${W - PR + 6}" y="${(Y(lo) + 4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'IBM Plex Mono',monospace">${lo.toFixed(1)}%</text>
      <polyline fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>
      <circle cx="${X(n - 1).toFixed(1)}" cy="${Y(last.y).toFixed(1)}" r="3.5" fill="var(--accent)"/>
      <text x="${PL}" y="${H - 8}" fill="var(--muted)" font-size="11" font-family="'IBM Plex Mono',monospace">${monthYr(T[0].iso)}</text>
      <text x="${(W - PR).toFixed(1)}" y="${H - 8}" fill="var(--muted)" font-size="11" text-anchor="end" font-family="'IBM Plex Mono',monospace">${monthYr(last.iso)}</text>
    </svg>
  </div>
  <p class="metaline" style="font-size:12px">Cut-off yield at each 6-month T-bill auction — the annualised return the last successful bidder locked in. Source: MAS.</p>`;
  }

  const faqs = [
    { q: `What is the latest Singapore T-bill rate?`, a: `The most recent 6-month T-bill (${l6.issue_code}, auctioned ${pretty(l6.auction_date)}) had a cut-off yield of ${l6.cutoff_yield.toFixed(2)}% per year.${l1 ? ` The latest 1-year T-bill (${l1.issue_code}, ${pretty(l1.auction_date)}) came in at ${l1.cutoff_yield.toFixed(2)}%.` : ''} The cut-off yield is the effective annualised return you earn if allotted.` },
    { q: `How do Singapore T-bills work?`, a: `A T-bill is a short-term Singapore Government security. You buy it at a discount to its face value and are repaid the full face value at maturity — the difference is your return. There are two tenors: 6-month and 1-year. They are as low-risk as it gets, being fully backed by the AAA-rated Singapore Government.` },
    { q: `How do I buy T-bills in Singapore?`, a: `Apply through DBS/POSB, OCBC or UOB (internet banking or ATM) during the auction window, using cash, SRS, or CPF-OA/CPF-SA funds. The minimum is S$1,000, in multiples of S$1,000. Most retail investors submit a "non-competitive" bid and are allotted at the cut-off yield.` },
    { q: `Can I buy T-bills with CPF?`, a: `Yes. T-bills can be bought with CPF Ordinary Account (CPF-OA) and CPF Special Account (CPF-SA) funds, as well as cash and SRS. This makes them a popular way to earn a fixed return on idle CPF-OA savings — though you should weigh it against the CPF-OA interest you give up.` },
    { q: `Are T-bills or Singapore Savings Bonds better?`, a: `It depends on your needs. T-bills lock in a fixed rate for 6 or 12 months and can be bought with CPF; SSBs are flexible — redeemable any month with no penalty — and step up the longer you hold. See our full SSB vs T-bills comparison for the details.` },
  ];
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const ld = { "@context":"https://schema.org","@graph":[
    { "@type":"BreadcrumbList","itemListElement":[
      { "@type":"ListItem","position":1,"name":"StockKaki","item":`${SITE}/` },
      { "@type":"ListItem","position":2,"name":"Singapore T-Bill Rates","item":`${SITE}/t-bills/` } ] },
    { "@type":"FAQPage","mainEntity":faqs.map(f => ({ "@type":"Question","name":f.q,"acceptedAnswer":{ "@type":"Answer","text":f.a } })) } ] };
  const jsonLd = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\u003c')}</script>`;

  const body = `  <section class="hero" style="padding:22px 0 2px">
    <h1 class="serif" style="font-size:27px;margin:0 0 5px">Singapore T-Bill Rates — ${mo}</h1>
    <p class="sub" style="margin-bottom:0">The latest 6-month Singapore T-bill (${l6.issue_code}) cut off at <b>${l6.cutoff_yield.toFixed(2)}%</b> per year, auctioned ${pretty(l6.auction_date)}.${l1 ? ` The latest 1-year T-bill cut off at <b>${l1.cutoff_yield.toFixed(2)}%</b>.` : ''} Rates, next auction and yield history below — from MAS, updated every auction.</p>
  </section>
  <div class="ssb-card">
    ${nextHTML}
    <div class="ssb-stats">
      <div class="bigstat"><div class="k">6-month cut-off yield</div><div class="v">${l6.cutoff_yield.toFixed(2)}%</div><div class="cap">${l6.issue_code} · auctioned ${pretty(l6.auction_date)}</div></div>
      <div class="bigstat"><div class="k">1-year cut-off yield</div><div class="v">${l1 ? l1.cutoff_yield.toFixed(2) + '%' : '—'}</div><div class="cap">${l1 ? l1.issue_code + ' · auctioned ' + pretty(l1.auction_date) : 'quarterly issue'}</div></div>
      <div class="bigstat alt"><div class="k">Next auction</div><div class="v" style="font-size:20px;margin-top:10px">${nx ? prettyShort(nx.auction_date) : '—'}</div><div class="cap">${nx ? tenorName(nx.auction_tenor) + ' · issues ' + pretty(nx.issue_date) : 'to be announced'}</div></div>
    </div>
    <div class="facts">
      <span class="fact">Min <b>S$1,000</b></span>
      <span class="fact">Cash · <b>SRS</b> · <b>CPF-OA/SA</b></span>
      <span class="fact"><b>6-month</b> or <b>1-year</b></span>
      <span class="fact"><b>SG-Government</b> backed</span>
      <span class="fact">Returns <b>tax-free</b></span>
    </div>
    <p class="ssb-meta">Apply via DBS/POSB, OCBC or UOB (internet banking / ATM), or with SRS or CPF funds, during the auction window. Applications generally close about a day before the auction (earlier for CPF) — check your bank's cut-off. Rates are set at auction, so they're the same wherever you apply.</p>
  </div>
  <div class="intro" style="margin-top:16px">A <b>Treasury Bill (T-bill)</b> is a short-term Singapore Government security — as safe as a <a href="/ssb/">Savings Bond</a>, but it works differently. You buy it at a <b>discount</b> and are repaid the full face value at maturity; the difference is your return, quoted above as the annualised <b>cut-off yield</b>. MAS auctions the 6-month T-bill roughly every two weeks and the 1-year about once a quarter.</div>
  <div class="h2">Recent 6-month T-bill auctions</div>
  <div class="card"><table class="stepup">
    <thead><tr><th>Auction date</th><th class="r">Cut-off yield</th><th class="r">Bid-to-cover</th></tr></thead>
    <tbody>
${histRows}
    </tbody>
  </table></div>
  <p class="metaline" style="font-size:12px">Bid-to-cover = total bids ÷ amount offered; higher means stronger demand. A higher demand auction often pushes the cut-off yield down. Source: MAS.</p>
${chart}
  <div class="intro" style="margin-top:18px"><b>T-bill or Savings Bond?</b> T-bills lock in a fixed rate for 6–12 months and can be bought with CPF; SSBs are flexible — redeem any month with no penalty — and step up the longer you hold. Read the full <a href="/guides/singapore-savings-bonds-vs-t-bills/">SSB vs T-bills comparison</a>, or check the latest <a href="/ssb/">Singapore Savings Bond rates</a>.</div>
  ${faqHTML}
  ${jsonLd}`;
  return shell(`Singapore T-Bill Rates ${YEAR} — Latest 6-Month & 1-Year Cut-off Yields | StockKaki`,
    `The latest Singapore T-bill rates from MAS: 6-month and 1-year cut-off yields, the next auction date, and full yield history. Clean, free, updated every auction.`,
    SITE + '/t-bills/', body, '', '/og/ssb.png');
}

// ---------- dividend calendar (upcoming ex-dates, chronological) ----------
function calendarPage(upcoming) {
  const cm = fullMonthYr(TODAY);   // current month, e.g. "August 2026" — self-updates daily so the page targets "SGX ex-dividend dates <month>" searches
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
    { q: `Which Singapore stocks go ex-dividend in ${cm}?`, a: `The calendar above lists every SGX counter going ex-dividend from ${cm} onwards — with its ex-date, dividend amount and pay date, updated daily. Buy before a stock's ex-date to receive its next dividend.` },
    { q: 'What is an ex-dividend date?', a: 'The ex-dividend (ex) date is the cut-off to qualify for a dividend — you must own the shares before the ex-date to be entitled. On the ex-date the share price typically drops by roughly the dividend amount.' },
    { q: "What's the difference between the ex-date and the pay date?", a: 'The ex-date decides who is entitled; the pay date is when the cash is actually credited to your account — usually a few weeks after the ex-date.' },
    { q: 'How do I use a dividend calendar?', a: 'Buy a stock before its ex-date to receive the upcoming dividend. This calendar lists the next SGX ex-dates and pay dates, updated daily.' },
  ];
  const faqHTML = `<div class="h2">Common questions</div><div class="faq">${faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@context":"https://schema.org", "@type":"FAQPage", "mainEntity":faqs.map(f => ({ "@type":"Question", "name":f.q, "acceptedAnswer":{ "@type":"Answer", "text":f.a } })) }).replace(/</g,'\\u003c')}</script>`;
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <h1 class="serif" style="font-size:27px;margin:0 0 5px">Singapore Dividend Calendar — ${cm}</h1>
    <p class="sub" style="margin-bottom:0">Every upcoming SGX ex-dividend and pay date for ${cm} and beyond, in order — updated daily.</p>
  </section>
  <div class="intro">Buy a stock <b>before its ex-date</b> to receive the upcoming dividend. Below are the next <b>${upcoming.length}</b> SGX ex-dividend dates from <b>${cm}</b> onwards, with their amounts and pay dates, newest first. For the full picture on any counter, tap through to its page.</div>
  <div class="ltable cols-home" style="margin-top:12px">
    <div class="lrow lhead"><span>Company</span><span class="lr-exd">Ex-date</span><span class="lr-amt">Amount</span><span class="lr-ex">Pay date</span></div>
    <div id="tb">
${rows}
    </div>
  </div>
  <p class="metaline" style="font-size:12px">Ex-dates &amp; amounts from SGX; <b>scrip</b> = a reinvestment-option distribution (cash amount not published in the free feed).</p>
  ${faqHTML}
  ${jsonLd}`;
  return shell(`Singapore Dividend Calendar ${cm} — Upcoming SGX Ex-Dividend & Pay Dates | StockKaki`,
    `Singapore dividend calendar for ${cm}: every upcoming SGX ex-dividend and pay date in order, updated daily. Never miss a payout.`,
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
  const up = P[P.length-1].c >= P[0].c, col = up ? 'var(--up)' : 'var(--down)';
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
    <text x="${W-PR+6}" y="${(Y(hi)+4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'IBM Plex Mono',monospace">${s}${hi.toFixed(2)}</text>
    <text x="${W-PR+6}" y="${(Y(lo)+4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'IBM Plex Mono',monospace">${s}${lo.toFixed(2)}</text>
    <text x="${PL}" y="${H-6}" fill="var(--muted)" font-size="11" font-family="'IBM Plex Mono',monospace">${fM}</text>
    <text x="${(W-PR).toFixed(1)}" y="${H-6}" fill="var(--muted)" font-size="11" text-anchor="end" font-family="'IBM Plex Mono',monospace">${lM}</text>
  </svg>`;
}

// Related counters — same class (REIT/ETF/stock), closest by dividend yield (falls back to market-cap proximity).
// Builds a dense internal-link web (each page → 6 peers) that helps crawl/indexing and stock-to-stock discovery.
function relatedStocks(c) {
  if (!c.ticker || typeof listed === 'undefined') return '';
  const classOf = (x) => x.isReit ? 'reit' : x.secType === 'etfs' ? 'etf' : 'stock';
  const cls = classOf(c);
  const label = cls === 'reit' ? 'REITs' : cls === 'etf' ? 'ETFs' : 'dividend stocks';
  const pool = listed.filter(x => x.slug !== c.slug && x.ticker && classOf(x) === cls);
  if (!pool.length) return '';
  let ranked;
  if (c.yieldPct != null) ranked = pool.filter(x => x.yieldPct != null).sort((a,b) => Math.abs(a.yieldPct - c.yieldPct) - Math.abs(b.yieldPct - c.yieldPct));
  else ranked = pool.filter(x => x.fund && x.fund.mktCap).sort((a,b) => Math.abs((a.fund.mktCap||0) - ((c.fund&&c.fund.mktCap)||0)) - Math.abs((b.fund.mktCap||0) - ((c.fund&&c.fund.mktCap)||0)));
  const picks = (ranked.length ? ranked : pool).slice(0, 6);
  if (!picks.length) return '';
  return `  <div class="h2">Related ${label}</div>
  <div class="related">
${picks.map(x => `    <a class="rel" href="/stock/${x.slug}/"><span class="rel-n">${esc(x.name)}${x.ticker?`<span class="rel-t">${x.ticker}</span>`:''}</span><span class="rel-y">${x.yieldPct!=null?x.yieldPct.toFixed(2)+'%':'—'}</span></a>`).join('\n')}
  </div>`;
}
// ---------- Plain-English metric explainers (ⓘ) — glossary served from a script object (not indexed) ----------
const GLOSS = {
  'market-cap': { t: 'Market cap', w: "The total value of all the company's shares — share price × number of shares.", r: "It tells you the company's size. Large-cap (in the billions) is usually established and steadier; small-cap has more room to grow but tends to carry more risk." },
  'pe': { t: 'P/E ratio', w: "Price ÷ earnings per share — roughly how many years of profit you're paying for one share.", r: "Lower can mean cheaper; higher often means investors expect growth. Only compare within the same industry. Many Singapore stocks sit around 8–20." },
  'pb': { t: 'P/B ratio', w: "Price ÷ the company's net asset value per share (its 'book value').", r: "Below 1 means it trades for less than its assets on paper. Most useful for asset-heavy businesses, banks and REITs." },
  'eps': { t: 'EPS — earnings per share', w: "The company's profit divided by its number of shares.", r: "How much profit each share earns. Rising EPS over the years is a good sign. Compare it against the price and you get the P/E." },
  'yield': { t: 'Dividend yield', w: "The yearly dividend as a percentage of the share price.", r: "Your income return if the dividend holds. A very high yield (say above 8–10%) can be a warning — check whether the company can keep paying it." },
  'volume': { t: 'Volume', w: "How many shares changed hands, usually over the latest trading day.", r: "Higher volume means it's easier to buy and sell at a fair price. Very low volume can mean a wide gap between buyers' and sellers' prices." },
  'range52': { t: '52-week range', w: "The highest and lowest price over the past year, and where today's price sits between them.", r: "Near the high = strong momentum (but pricier); near the low = out of favour (a bargain, or a warning). Use it as context, not a signal on its own." },
};
const infoIcon = (k) => `<button class="tinfo" type="button" onclick="openTerm('${k}')" aria-label="Explain this">i</button>`;
const TERM_STYLE = `<style>
.tinfo{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:1px solid var(--muted);color:var(--muted);font:italic 700 10px/1 Georgia,serif;background:none;cursor:pointer;margin-left:5px;padding:0;vertical-align:middle}
.tinfo:hover,.tinfo:focus-visible{border-color:var(--accent);color:var(--accent);outline:none}
.tscrim{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;visibility:hidden;transition:opacity .25s;z-index:60}
.tscrim.on{opacity:1;visibility:visible}
.tsheet{position:fixed;left:0;right:0;bottom:0;z-index:61;background:var(--card);border-top:1px solid var(--line);border-radius:18px 18px 0 0;padding:6px 20px 30px;max-width:640px;margin:0 auto;transform:translateY(101%);transition:transform .28s cubic-bezier(.32,.72,0,1);box-shadow:0 -12px 40px rgba(0,0,0,.18)}
.tsheet.on{transform:translateY(0)}
.tgrab{width:40px;height:4px;border-radius:3px;background:var(--line);margin:8px auto 16px}
.tstitle{font-family:'Playfair Display',serif;font-weight:700;font-size:20px;margin-bottom:14px}
.tssec{margin-bottom:14px}
.tslabel{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent-dk);margin-bottom:3px}
.tssec .tsv{font-size:14.5px;line-height:1.6}
</style>`;
const TERM_SHEET = `<div class="tscrim" id="tscrim" onclick="closeTerm()"></div>
  <div class="tsheet" id="tsheet" role="dialog" aria-modal="true" aria-label="Explainer">
    <div class="tgrab"></div>
    <div class="tstitle" id="tst"></div>
    <div class="tssec"><div class="tslabel">What it is</div><div class="tsv" id="tswhat"></div></div>
    <div class="tssec"><div class="tslabel">How to read it</div><div class="tsv" id="tsread"></div></div>
  </div>`;
const TERM_JS = `window.GLOSS=${JSON.stringify(GLOSS).replace(/</g, '\\u003c')};
function openTerm(k){var d=(window.GLOSS||{})[k];if(!d)return;document.getElementById('tst').textContent=d.t;document.getElementById('tswhat').textContent=d.w;document.getElementById('tsread').textContent=d.r;document.getElementById('tscrim').classList.add('on');document.getElementById('tsheet').classList.add('on');document.body.style.overflow='hidden';}
function closeTerm(){document.getElementById('tscrim').classList.remove('on');document.getElementById('tsheet').classList.remove('on');document.body.style.overflow='';}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeTerm();});`;
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
  ${ttmStr ? `<p class="metaline">Trailing 12-month dividends: <b>${ttmStr}</b> per security${c.yieldPct?` &middot; indicative yield <b>${c.yieldPct.toFixed(2)}%</b> at ${pxf(CS,c.price)} last`:''}.</p>` : ''}
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
  if (c.price) faqs.push({ q: `What is ${c.name}'s share price?`, a: `${c.name}${c.ticker?` (${c.ticker})`:''} last closed at ${pxf(CS,c.price)} on the SGX.` });
  if (c.divs.length) {
    faqs.push({ q: `Does ${c.name} pay dividends?`, a: `Yes. ${c.name} has paid dividends over the last ${years.length} year${years.length>1?'s':''}${freq?`, currently ${freq.toLowerCase()}`:''}${ttmStr?`, totalling ${ttmStr} per security in the past 12 months`:''}.` });
    faqs.push({ q: `What is ${c.name}'s dividend yield?`, a: c.yieldPct ? `${c.name}'s indicative dividend yield is about ${c.yieldPct.toFixed(2)}%, based on trailing 12-month dividends of ${ttmStr} per security against a last price of ${pxf(CS,c.price)}.` : (inc ? `${c.name} distributes via a scrip/reinvestment option, and SGX's free feed doesn't publish the full per-unit cash amount — so an accurate trailing yield can't be shown here.` : `${c.name} has no trailing 12-month dividends on record, so no indicative yield.`) });
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
    ['Market cap', fmtCap(fcur, f.mktCap), 'market-cap'],
    ['P/E ratio', f.pe!=null ? f.pe.toFixed(1) : null, 'pe'],
    ['P/B ratio', f.pb!=null ? f.pb.toFixed(2) : null, 'pb'],
    ['EPS (ttm)', f.eps!=null ? CSf+f.eps.toFixed(2) : null, 'eps'],
    ['Dividend yield', c.yieldPct!=null ? c.yieldPct.toFixed(2)+'%' : null, 'yield'],
    ['Volume', f.vol ? fmtVol(f.vol) : null, 'volume'],
  ].filter(x => x[1]!=null) : [];
  const pchart = priceChart(c.prices, fcur);
  const overviewSection = (ovStats.length || rangePos!=null || pchart) ? `${pchart ? `<div class="ov-chart-h"><span>Price</span><span>${CSf}${c.price!=null?c.price:'—'}</span></div>${pchart}` : ''}<div class="ovgrid"${pchart?' style="margin-top:18px"':''}>${ovStats.map(s => `<div class="ovstat"><span class="ov-k">${s[0]}${s[2]?infoIcon(s[2]):''}</span><span class="ov-v">${s[1]}</span></div>`).join('')}</div>
  ${rangePos!=null ? `<div class="ov-range"><div class="ov-range-h"><span>52-week range ${infoIcon('range52')}</span></div><div class="ov-bar"><div class="ov-mark" style="left:${rangePos.toFixed(1)}%"></div></div><div class="ov-range-f"><span>${CSf}${f.w52lo}</span><span style="color:var(--ink)">now ${CSf}${c.price}</span><span>${CSf}${f.w52hi}</span></div></div>` : ''}
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
  const kpi = c.ticker ? `<div class="st-kpi">
    <div class="kbox"><div class="kl">Div yield</div><div class="kv acc">${c.yieldPct!=null?c.yieldPct.toFixed(2)+'%':'—'}</div></div>
    <div class="kbox"><div class="kl">P/E</div><div class="kv">${(f&&f.pe!=null)?f.pe.toFixed(1):'—'}</div></div>
    <div class="kbox"><div class="kl">Mkt cap</div><div class="kv">${fmtCap(fcur, f&&f.mktCap)||'—'}</div></div>
    <div class="kbox"><div class="kl">52-wk high</div><div class="kv">${(f&&f.w52hi!=null)?CSf+f.w52hi:'—'}</div></div>
  </div>` : '';
  const body = `${TERM_STYLE}
  <section class="hero" style="padding-bottom:4px">
    <div class="crumb"><a href="/dividends/">Dividends</a> › ${c.name}</div>
    <div class="st-head">
      <div style="min-width:0">
        <h1 class="serif" style="font-size:26px;line-height:1.2">${c.name}</h1>
        <div class="st-tags"><span class="st-tag mono">SGX: ${c.ticker||'—'}</span><span class="st-tag">${typeLabel}</span>${c.cur&&c.cur!=='SGD'?`<span class="st-tag">${c.cur}</span>`:''}</div>
      </div>
      ${c.ticker?`<div class="st-acts"><button class="st-save" id="stSave">${STAR} <span class="lbl">Save</span></button></div>`:''}
    </div>
    ${c.price?`<div class="quote" style="margin-top:14px"><span class="q-price">${pxf(CS,c.price)}</span>${(c.chgPct!=null&&c.chgPct!==0)?`<span class="q-chg" style="color:${c.chgPct>=0?'var(--up)':'var(--down)'}">${c.chgPct>=0?'▲':'▼'} ${Math.abs(c.chgPct).toFixed(2)}%</span>`:''}${c.vol?`<span class="q-vol">Vol ${fmtVol(c.vol)}</span>`:''}<span class="q-vol">last close</span></div>`:''}
    ${!c.ticker?`<p class="metaline" style="margin-top:6px">This counter isn’t currently trading on SGX (delisted or renamed) — shown here for its past dividend record.</p>`:''}
    ${kpi}
  </section>
  ${tabsHTML}
  ${brokerSlot(c)}
  ${relatedStocks(c)}
  ${faqHTML}
  <div class="st-toast" id="stToast"></div>
  ${TERM_SHEET}
  ${jsonLd}`;
  const tabScript = `<script>${TERM_JS}
document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',function(){document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('on');});t.classList.add('on');document.querySelectorAll('.tabpane').forEach(function(p){p.hidden=true;});var e=document.getElementById('t-'+t.dataset.tab);if(e)e.hidden=false;});});
(function(){
var to=document.getElementById('stToast');
function toast(m){if(!to)return;to.textContent=m;to.classList.add('on');clearTimeout(window._tt);window._tt=setTimeout(function(){to.classList.remove('on');},3400);}
var saveBtn=document.getElementById('stSave');
if(!saveBtn)return;
var SLUG=${JSON.stringify(c.slug)};
function lbl(x){var s=saveBtn.querySelector('.lbl');if(s)s.textContent=x;}
function toLogin(){location.href='/account/?next='+encodeURIComponent(location.pathname);}
var hasToken=false;try{for(var i=0;i<localStorage.length;i++){if(/^sb-.*-auth-token$/.test(localStorage.key(i))){hasToken=true;break;}}}catch(e){}
if(!hasToken){saveBtn.addEventListener('click',toLogin);return;}
import('https://esm.sh/@supabase/supabase-js@2').then(async function(m){
 var sb=m.createClient(${JSON.stringify(SUPABASE_URL)},${JSON.stringify(SUPABASE_ANON)});
 var s=(await sb.auth.getSession()).data.session;
 if(!s){saveBtn.addEventListener('click',toLogin);return;}
 var saved=false,busy=false;
 function paint(){saveBtn.classList.toggle('on',saved);lbl(saved?'Saved':'Save');}
 var r=await sb.from('watchlist').select('slug').eq('slug',SLUG).maybeSingle();saved=!!(r&&r.data);paint();
 saveBtn.addEventListener('click',async function(){if(busy)return;busy=true;
  if(saved){await sb.from('watchlist').delete().eq('slug',SLUG);saved=false;toast('Removed from watchlist');}
  else{await sb.from('watchlist').insert({slug:SLUG,user_id:s.user.id});saved=true;toast('★ Saved — we\\'ll remind you before it goes ex-dividend');}
  paint();busy=false;});
});
})();</script>`;
  const nextTxt = next ? ` Next ex-date ${pretty(next.exISO)} (${money(next.ccy,next.amt)}).` : '';
  return shell(`${c.name}${c.ticker?' ('+c.ticker+')':''} Share Price, Dividends & Ex-Dates | StockKaki`,
    `${c.name}${c.ticker?' ('+c.ticker+')':''} — ${c.price?`last price ${pxf(CS,c.price)}, `:''}${c.yieldPct?`dividend yield ${c.yieldPct.toFixed(2)}%, `:''}dividend history and ex-dates on SGX.${nextTxt} Updated daily.`,
    `${SITE}/stock/${c.slug}/`, body, tabScript,
    (typeof ogStockSet !== 'undefined' && ogStockSet.has(c.slug)) ? `/og/stock/${c.slug}.png` : '/og.png');
}

// Allotment tracker — did the latest issue fully allot, or was it balloted?
function allotCard(ssb) {
  const a = ssb.allot; if (!a || !a.size || a.applied == null) return '';
  const balloted = a.rndmRate > 0;
  const subPct = a.applied / a.size * 100;
  const guar = a.cutoff != null ? Math.round(a.cutoff * 1e6) : null;
  return `  <div class="h2">Latest allotment result</div>
  <div class="ssb-card" style="border-left-color:var(--muted)">
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
  <div class="ssb-card" style="border-left-color:var(--muted)">
    <span class="ssb-status" style="background:var(--bg);color:var(--muted)">Projection · ${refMonth} SGS yields · ${sgs.days} trading day${sgs.days>1?'s':''} so far</span>
    <div class="ssb-stats">
      <div class="bigstat"><div class="k">Projected 1st-year</div><div class="v" style="color:var(--muted)">~${sgs.y1.toFixed(2)}%</div><div class="cap">now ${c.y1.toFixed(2)}%</div></div>
      <div class="bigstat"><div class="k">Projected 10-yr average</div><div class="v" style="color:var(--muted)">~${sgs.y10.toFixed(2)}%</div><div class="cap">${dir} the ${c.y10.toFixed(2)}% now</div></div>
    </div>
    <p class="ssb-meta">Projected average return by holding period: <b>1yr ~${sgs.y1.toFixed(2)}%</b> · 2yr ~${sgs.y2!=null?sgs.y2.toFixed(2):'—'}% · 5yr ~${sgs.y5!=null?sgs.y5.toFixed(2):'—'}% · <b>10yr ~${sgs.y10.toFixed(2)}%</b>. The next issue's applications open around early ${appMonth}, when MAS confirms the final rate. This is an estimate from SGS benchmark yields (MAS sets SSB rates from the prior month's average yields) — not an official figure.</p>
  </div>
`;
}

// ---------- Singapore Savings Bonds ----------
function ssbPage(ssb, sgs) {
  if (!ssb) {
    const body = `  <section class="hero"><div class="kicker">Singapore Savings Bonds</div><h1 class="serif" style="font-size:30px">SSB rates</h1>
    <p class="sub">Live SSB rates from MAS are temporarily unavailable — please check back shortly.</p></section>`;
    return shell('Singapore Savings Bonds (SSB) Rates | StockKaki', 'Latest Singapore Savings Bonds interest rates.', SITE + '/ssb/', body);
  }
  const c = ssb.current;
  const tm = fullMonthYr(c.issueISO);   // e.g. "August 2026" — the current tranche's month; drives the SEO title/H1 so the page auto-targets "SSB <month> <year>" searches each build
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
    <text x="${W-PR+6}" y="${(Y(hi)+4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'IBM Plex Mono',monospace">${hi.toFixed(1)}%</text>
    <text x="${W-PR+6}" y="${(Y(lo)+4).toFixed(1)}" fill="var(--muted)" font-size="11" font-family="'IBM Plex Mono',monospace">${lo.toFixed(1)}%</text>
    ${poly('y1','var(--muted)')}
    ${poly('y10','var(--accent)')}
    <circle cx="${X(n-1).toFixed(1)}" cy="${Y(last.y10).toFixed(1)}" r="3.5" fill="var(--accent)"/>
    <circle cx="${X(n-1).toFixed(1)}" cy="${Y(last.y1).toFixed(1)}" r="3.5" fill="var(--muted)"/>
    <text x="${PL}" y="${H-8}" fill="var(--muted)" font-size="11" font-family="'IBM Plex Mono',monospace">${monthYr(S[0].issueISO)}</text>
    <text x="${(W-PR).toFixed(1)}" y="${H-8}" fill="var(--muted)" font-size="11" text-anchor="end" font-family="'IBM Plex Mono',monospace">${monthYr(last.issueISO)}</text>
  </svg>`;

  const faqs = [
    { q: `What is the Singapore Savings Bond interest rate for ${tm}?`, a: `The ${tm} issue (${c.code}, issued ${c.issueFmt||pretty(c.issueISO)}) pays ${c.y1.toFixed(2)}% in the first year and a ${c.y10.toFixed(2)}% average return per year if held for the full 10 years.` },
    { q: 'How does the SSB step-up interest work?', a: `SSB interest "steps up" the longer you hold. This issue starts at ${c.coupons[0].toFixed(2)}% in year 1 and rises to ${c.coupons[9].toFixed(2)}% in year 10, so your average return grows from ${c.returns[0].toFixed(2)}% to ${c.returns[9].toFixed(2)}% per year over the 10 years.` },
    { q: 'How do I buy Singapore Savings Bonds?', a: 'Apply through DBS/POSB, OCBC or UOB internet banking or ATM, or with your SRS funds. Minimum S$500, in multiples of S$500, up to the individual holding cap of S$200,000 in total. Applications usually close on the 4th-last business day of the month.' },
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
    <h1 class="serif" style="font-size:27px;margin:0 0 5px">Singapore Savings Bonds (SSB) interest rates — ${tm}</h1>
    <p class="sub" style="margin-bottom:0">The latest Singapore Savings Bond for <b>${tm}</b> (issue ${c.code}) pays <b>${c.y1.toFixed(2)}%</b> in year one and a <b>${c.y10.toFixed(2)}%</b> average return over 10 years. Full step-up schedule, returns & swap calculators and rate history below — from MAS, updated every issue.</p>
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
    <p class="ssb-meta">Apply via DBS/POSB, OCBC or UOB (internet banking / ATM) or with SRS funds. Rates are the same at every bank — they're set by MAS. Prefer a fixed 6–12 month rate you can also buy with CPF? Compare the latest <a href="/t-bills/">Singapore T-bill rates</a>.</p>
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
    <div class="leg"><span><i style="background:var(--accent)"></i>10-year average return</span><span><i style="background:var(--muted)"></i>1st-year interest</span></div>
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
  if(sw>keep+0.5){nb.classList.add('win');V.textContent='Switching to ${c.code} earns about S$'+fmt(diff)+' more over '+n+' year'+(n>1?'s':'')+'.';}
  else if(keep>sw+0.5){kb.classList.add('win');V.textContent='Keep your bond — it pays about S$'+fmt(diff)+' more over '+n+' year'+(n>1?'s':'')+' (it has already stepped up).';}
  else{V.textContent='≈ About the same either way over '+n+' year'+(n>1?'s':'')+'.';}}
 swOld.addEventListener('change',function(){fillYrs();swCalc();});swYrs.addEventListener('change',swCalc);swAmt.addEventListener('input',swCalc);
 fillYrs();swCalc();
}
</script>`;
  return shell(`Singapore Savings Bonds (SSB) Interest Rate ${tm}: ${c.y1.toFixed(2)}%–${c.y10.toFixed(2)}% | StockKaki`,
    `Singapore Savings Bonds (SSB) for ${tm}: ${c.y1.toFixed(2)}% first-year and ${c.y10.toFixed(2)}% 10-year average return (issue ${c.code}). Step-up schedule, rate trend and a returns calculator. From MAS, updated each issue.`,
    SITE + '/ssb/', body, script, '/og/ssb.png');
}

// ---------- disclaimer ----------
// ---------- Evergreen guides (top-of-funnel content; internal-linked to the tools) ----------
const GUIDES = [
  {
    slug: 'how-is-dividend-yield-calculated',
    title: 'How Is Dividend Yield Calculated? (With Singapore Examples) | StockKaki',
    desc: 'Dividend yield explained simply — the formula, a worked SGX example, trailing vs forward yield, and what actually counts as a good yield in Singapore. Free, no jargon.',
    h1: 'How is dividend yield calculated?',
    blurb: 'The formula, a worked SGX example, and what actually counts as a good yield in Singapore.',
    body: `<p><strong>Dividend yield</strong> tells you how much income a stock pays each year <strong>relative to its price</strong>. It's the single most useful number for comparing dividend stocks — a S$50 share and a S$2 share can't be compared on dividend amount alone, but their yields put them on the same footing.</p>
<h2>The formula</h2>
<div class="formula">Dividend yield (%) = Annual dividend per share ÷ Share price × 100</div>
<p>Take the total dividends a company paid over a year, divide by the current share price, and multiply by 100 to get a percentage. That's all there is to it.</p>
<h2>A worked example</h2>
<p>Say a stock trades at <strong>S$2.00</strong> and paid <strong>S$0.10</strong> in dividends over the past 12 months:</p>
<div class="formula">S$0.10 ÷ S$2.00 × 100 = 5.0%</div>
<p>So for every S$1,000 invested at that price, you'd receive about <strong>S$50 a year</strong> in dividends. Notice what happens if the share price rises to S$2.50 while the dividend stays the same: the yield <em>falls</em> to 4.0%, because you're paying more for the same payout. Yield and price move in opposite directions.</p>
<h2>Trailing vs forward yield</h2>
<p>You'll see two versions of the number:</p>
<ul>
<li><strong>Trailing yield</strong> uses the dividends actually paid over the <em>last</em> 12 months. It's factual and can't be dressed up.</li>
<li><strong>Forward yield</strong> uses the dividends a company is <em>expected</em> to pay over the next 12 months. It's an estimate — and it's wrong if the company later cuts or raises the payout.</li>
</ul>
<p>StockKaki shows the <strong>trailing 12-month yield</strong> on every <a href="/dividends/">dividend stock page</a> — the real, paid figure — so you're comparing facts, not forecasts.</p>
<h2>What's a good dividend yield in Singapore?</h2>
<p>Roughly <strong>4–6%</strong> is a solid, sustainable yield for an SGX blue chip or REIT. Singapore is unusually kind to dividend investors: there's <strong>no tax on dividends and no capital-gains tax</strong>, so the yield you see is close to the yield you keep. You can compare every payer on the <a href="/dividends/">best dividend stocks</a> page, or the typically higher-yielding property plays on the <a href="/reits/">Singapore REITs</a> page.</p>
<h2>When a high yield is a warning, not a bargain</h2>
<p>A very high yield — say above 10% — deserves a second look rather than an instant buy. Two common reasons:</p>
<ul>
<li><strong>The price fell for a reason.</strong> Because yield = dividend ÷ price, a sinking share price mechanically <em>pushes the yield up</em>. This is the classic "yield trap" — the market may be pricing in a coming dividend cut.</li>
<li><strong>A one-off special dividend.</strong> A single large payout inflates the trailing yield for a year, then disappears — so the "normal" yield is lower than it looks.</li>
</ul>
<p>Always check whether the dividend is <em>sustainable</em>: is it covered by earnings, and has it been paid consistently? Every stock page shows the full <a href="/dividend-calendar/">dividend history and upcoming ex-dates</a>, so you can judge the track record rather than the headline number.</p>`,
    faqs: [
      { q: 'What is a good dividend yield in Singapore?', a: 'Around 4–6% is a solid, sustainable yield for an SGX blue chip or REIT. Because Singapore has no tax on dividends and no capital-gains tax, the yield you see is close to what you keep. Yields much above 10% warrant a closer look — they can signal a falling price or a one-off special dividend.' },
      { q: 'Is a higher dividend yield always better?', a: 'No. A very high yield often means the share price has fallen (a "yield trap"), or that a one-off special dividend has temporarily inflated the trailing figure. What matters is whether the dividend is sustainable — covered by earnings and paid consistently.' },
      { q: 'Does StockKaki use trailing or forward dividend yield?', a: 'Trailing 12-month yield — the dividends actually paid over the last year, divided by the current price. It is factual and lets you compare counters on the same basis, rather than relying on a forecast.' },
    ],
  },
  {
    slug: 'singapore-savings-bonds-vs-t-bills',
    title: `Singapore Savings Bonds vs T-Bills — Which Is Better? | StockKaki`,
    desc: `Singapore Savings Bonds vs Treasury Bills compared: tenor, interest, early exit, minimums and when each makes sense. Both are Singapore-Government-backed. Plain English.`,
    h1: `Singapore Savings Bonds vs T-bills`,
    blurb: `Both are backed by the Singapore Government — but they suit very different needs. A plain comparison.`,
    body: `<p>Both <strong>Singapore Savings Bonds (SSBs)</strong> and <strong>Treasury Bills (T-bills)</strong> are issued by the Singapore Government, so both are about as low-risk as an investment gets. But they work differently, and the right one depends on your time horizon and how much flexibility you want.</p>
<h2>What each one is</h2>
<p><strong>Singapore Savings Bonds</strong> are long-dated (up to 10 years) but flexible. Interest <em>steps up</em> the longer you hold, and you can redeem in any month with no penalty and get your capital back plus accrued interest. A new issue is offered every month.</p>
<p><strong>Treasury Bills</strong> are short-dated — <strong>6-month</strong> or <strong>1-year</strong>. You buy them at a discount to face value and receive the full face value at maturity; the difference is your return. They are sold by auction, and you generally cannot redeem early (you would have to sell on the secondary market). See the latest <a href="/t-bills/">Singapore T-bill rates</a> for current cut-off yields.</p>
<h2>The key differences</h2>
<ul>
<li><strong>Tenor</strong> — SSB: up to 10 years, hold as long or short as you like. T-bill: fixed 6-month or 1-year.</li>
<li><strong>How the return works</strong> — SSB: step-up coupons paid every 6 months. T-bill: a single discount, locked in at auction.</li>
<li><strong>Early exit</strong> — SSB: redeem any month, no penalty. T-bill: no early redemption; sell on the secondary market if you must.</li>
<li><strong>Minimum</strong> — SSB: S$500 (multiples of S$500, max S$200,000 held). T-bill: S$1,000 (multiples of S$1,000).</li>
<li><strong>Funds you can use</strong> — SSB: cash or SRS. T-bill: cash, SRS, and CPF-OA/SA — useful for deploying idle CPF savings.</li>
</ul>
<h2>When to choose which</h2>
<p>Pick an <strong>SSB</strong> if you value flexibility — you are parking money you might need back at short notice, or you want a long-term home for cash you can top up and exit freely. Pick a <strong>T-bill</strong> if you have a fixed sum you will not need for 6–12 months and want to lock in a known return, or if you want to put CPF-OA funds to work.</p>
<p>Rates on both move with the market. You can see the latest SSB rates, the full step-up schedule and a returns calculator on the <a href="/ssb/">Singapore Savings Bonds page</a>, which also projects the likely rate of the next issue.</p>
<h2>What they have in common</h2>
<p>Both are backed by the AAA-rated Singapore Government, both are bought through DBS/POSB, OCBC or UOB (internet banking or ATM), and the return on either is <strong>not taxed</strong> in Singapore. They are tools for the safe part of a portfolio — not a substitute for the growth you would seek from <a href="/dividends/">dividend stocks</a> or <a href="/reits/">REITs</a>.</p>`,
    faqs: [
      { q: `Do Singapore Savings Bonds or T-bills pay more?`, a: `It depends on the interest-rate environment — sometimes short-term T-bills yield more than the first-year SSB rate, sometimes less. SSBs reward longer holding via step-up interest, while T-bills lock in a single rate for 6 or 12 months. Check the current SSB rates and recent T-bill cut-offs before deciding.` },
      { q: `Can I use CPF to buy T-bills and Singapore Savings Bonds?`, a: `T-bills can be bought with CPF-OA and CPF-SA funds, as well as cash and SRS. Singapore Savings Bonds are bought with cash or SRS (not CPF). This makes T-bills a common choice for deploying idle CPF-OA savings.` },
      { q: `Are Singapore Savings Bonds and T-bills safe?`, a: `Both are issued and fully backed by the Singapore Government, which is AAA-rated, so credit risk is minimal. The main practical difference is liquidity: SSBs can be redeemed any month with no penalty, while T-bills are meant to be held to maturity.` },
    ],
  },
  {
    slug: 'what-is-an-ex-dividend-date',
    title: `What Is an Ex-Dividend Date? (How to Qualify for a Dividend) | StockKaki`,
    desc: `The ex-dividend date is the cut-off to receive a dividend. Learn the key dates, how to qualify, why the price drops on the ex-date, and the dividend-capture myth. SGX-focused.`,
    h1: `What is an ex-dividend date?`,
    blurb: `The cut-off that decides who gets the dividend — plus the key dates around it, explained simply.`,
    body: `<p>The <strong>ex-dividend date</strong> (or "ex-date") is the cut-off that decides who receives a dividend. The rule is simple: <strong>you must already own the shares before the ex-date</strong> to be entitled to that dividend. Buy on the ex-date or later, and the dividend goes to the seller instead.</p>
<h2>The four dates to know</h2>
<ul>
<li><strong>Declaration date</strong> — when the company announces the dividend, the amount, and the dates below.</li>
<li><strong>Ex-dividend date</strong> — the cut-off. Own the shares <em>before</em> this date to qualify.</li>
<li><strong>Record date</strong> — usually the business day after the ex-date; the company checks its register to confirm who the shareholders are.</li>
<li><strong>Payment date</strong> — when the cash actually lands in your account, typically a few weeks after the ex-date.</li>
</ul>
<h2>Why the share price usually drops on the ex-date</h2>
<p>On the ex-date, the share price typically falls by roughly the dividend amount. That is not a loss — it simply reflects that new buyers no longer get the upcoming payout, so they pay a little less. If a S$2.00 stock pays a S$0.10 dividend, it might open around S$1.90 on the ex-date. The S$0.10 has not vanished; it is on its way to existing shareholders as cash.</p>
<h2>The "dividend capture" myth</h2>
<p>A common idea is to buy just before the ex-date, collect the dividend, and sell straight after for free income. In practice it rarely works: the price drop on the ex-date roughly cancels the dividend, and you would owe brokerage costs on both trades. Dividends reward <em>holding</em> good businesses, not timing the calendar.</p>
<h2>How to use it in practice</h2>
<p>If you want a stock's next dividend, make sure you own it <strong>before</strong> its ex-date — buying at least one trading day earlier is the safe approach. You do not need to keep holding until the payment date; once you are past the ex-date as an owner, the dividend is yours even if you sell.</p>
<p>You can see the next ex-dates and pay dates for every SGX counter, in order, on the <a href="/dividend-calendar/">Singapore dividend calendar</a> — and each <a href="/dividends/">stock page</a> lists that counter's full history of past ex-dates and amounts.</p>`,
    faqs: [
      { q: `Do I need to hold a stock until the payment date to get the dividend?`, a: `No. As long as you owned the shares before the ex-dividend date, the dividend is yours — even if you sell before the payment date. Entitlement is fixed at the ex-date, not the pay date.` },
      { q: `If I buy a stock on its ex-dividend date, do I get the dividend?`, a: `No. Buying on the ex-date or later means you are not entitled to that dividend — it goes to the previous owner. You must own the shares before the ex-date.` },
      { q: `Why does a share price fall on the ex-dividend date?`, a: `Because new buyers no longer receive the upcoming dividend, the stock trades lower by roughly the dividend amount on the ex-date. It is a mechanical adjustment, not a loss — the cash is being paid out to existing shareholders.` },
    ],
  },
  {
    slug: 'how-to-buy-dividend-stocks-in-singapore',
    title: `How to Buy Dividend Stocks in Singapore (Beginner's Guide) | StockKaki`,
    desc: `A step-by-step guide to buying dividend stocks in Singapore: opening a brokerage (CDP vs custodian), funding, choosing stocks, placing a trade, and collecting dividends.`,
    h1: `How to buy dividend stocks in Singapore`,
    blurb: `From opening a brokerage to placing your first trade and collecting dividends — a step-by-step start.`,
    body: `<p>Buying dividend stocks on the SGX is straightforward once your account is set up. Here is the whole process, start to finish.</p>
<h2>Step 1 — Open a brokerage account</h2>
<p>You will need a broker to place trades. There are two account types to understand:</p>
<ul>
<li><strong>CDP-linked</strong> — your shares are held in your own name in a Central Depository (CDP) account. You are the direct legal owner, and dividends are paid straight to your linked bank account.</li>
<li><strong>Custodian</strong> — your shares are held by the broker on your behalf. Fees are often lower, but the broker is the nominee.</li>
</ul>
<p>For long-term dividend investing many Singaporeans prefer CDP for the direct ownership; for lower costs, a custodian works well. Either is fine to start.</p>
<h2>Step 2 — Fund your account</h2>
<p>Transfer money in via PayNow, FAST or bank transfer. You can also invest with your <strong>SRS</strong> funds through most brokers, which can bring tax relief on the amount you contribute.</p>
<h2>Step 3 — Choose your stocks</h2>
<p>This is where StockKaki helps. Compare every SGX payer ranked by yield on the <a href="/dividends/">best dividend stocks</a> page, or the property plays on the <a href="/reits/">Singapore REITs</a> page. Do not chase the highest number blindly — a very high yield can be a warning (see <a href="/guides/how-is-dividend-yield-calculated/">how dividend yield works</a>). Look for a sustainable payout and a consistent history, and spread your money across a few names rather than one.</p>
<h2>Step 4 — Place the order</h2>
<p>In your broker's app, search the stock, choose <strong>buy</strong>, and pick an order type: a <strong>market order</strong> fills immediately at the going price, while a <strong>limit order</strong> only fills at your chosen price or better. SGX trades in board lots of 100 shares.</p>
<h2>Step 5 — Collect your dividends</h2>
<p>Once you own a stock <strong>before its ex-dividend date</strong> (see <a href="/guides/what-is-an-ex-dividend-date/">what an ex-date is</a>), you are entitled to its next payout. Dividends are paid automatically — to your bank account (CDP) or into your brokerage (custodian) — on the payment date, usually a few weeks later. There is nothing to claim.</p>
<h2>A note on costs and tax</h2>
<p>Brokers charge a commission per trade, often with a minimum, so very small trades can be inefficient — factor that in. The good news on tax: Singapore has <strong>no tax on dividends and no capital-gains tax</strong>, so the income and any gains are yours to keep (<a href="/guides/are-dividends-taxed-in-singapore/">more on dividend tax</a>).</p>`,
    faqs: [
      { q: `How much money do I need to start buying dividend stocks in Singapore?`, a: `There is no official minimum, but because brokers charge a commission (often with a minimum fee) and SGX trades in lots of 100 shares, very small trades are inefficient. Many beginners start with a few hundred to a few thousand dollars per stock so fees are a small percentage of the trade.` },
      { q: `Should I use a CDP or custodian account?`, a: `CDP holds shares in your own name with dividends paid to your bank — favoured for long-term ownership. Custodian accounts, held by the broker, usually have lower fees. Both are legitimate; the choice comes down to whether you prioritise direct ownership or lower costs.` },
      { q: `Do I pay tax on dividends from Singapore stocks?`, a: `No. Singapore does not tax dividends from SGX-listed companies for individual investors, and there is no capital-gains tax. Foreign stocks can be subject to withholding tax in their home country.` },
    ],
  },
  {
    slug: 'how-to-buy-etf-in-singapore',
    title: `How to Buy an ETF in Singapore (Beginner's Guide) | StockKaki`,
    desc: `A step-by-step guide to buying ETFs in Singapore: choosing an ETF, opening a brokerage, Regular Savings Plans for dollar-cost averaging, and the US vs Ireland-domiciled withholding-tax difference.`,
    h1: `How to buy an ETF in Singapore`,
    blurb: `Pick an ETF, open a broker, and start — including Regular Savings Plans and the withholding-tax trick that saves you money.`,
    body: `<p>An <strong>ETF</strong> (exchange-traded fund) holds a whole basket of stocks or bonds in one unit, and it trades on an exchange just like a share. Buying one in Singapore is the same process as buying a stock — here it is, start to finish.</p>
<h2>Step 1 — Choose an ETF</h2>
<p>Decide what you want exposure to first:</p>
<ul>
<li><strong>The Singapore market</strong> — an <strong>STI ETF</strong> tracks the 30 <a href="/blue-chips/">blue-chip STI companies</a> in a single trade. Two trade on the SGX: the SPDR STI ETF (ES3) and the Nikko AM STI ETF (G3B).</li>
<li><strong>The US / global market</strong> — an <strong>S&amp;P 500</strong> or all-world ETF gives broad global growth. These are listed overseas, so you need a broker that offers US or London-listed markets.</li>
<li><strong>Income</strong> — bond, REIT and dividend ETFs distribute regularly. Compare the SGX-listed ones ranked by yield on the <a href="/etfs/">best Singapore ETFs</a> page.</li>
</ul>
<h2>Step 2 — Open a brokerage account</h2>
<p>You need a broker to place trades. As with stocks, there are two account types: <strong>CDP-linked</strong> (shares held in your own name — only for SGX-listed ETFs like the STI ETF) and <strong>custodian</strong> (held by the broker; usually lower fees, and required for overseas ETFs). Popular choices include DBS Vickers, moomoo, Tiger, FSMOne and Interactive Brokers.</p>
<h2>Step 3 — Consider a Regular Savings Plan (RSP)</h2>
<p>This is the ETF investor's best friend in Singapore. An <strong>RSP</strong> automatically invests a fixed sum every month — say S$100 or S$500 — buying more units when prices are low and fewer when high. This is <strong>dollar-cost averaging</strong>, and it removes the temptation to time the market. Many brokers and banks offer RSPs into the STI ETF and popular global ETFs. It is the simplest way for a beginner to build a position steadily.</p>
<h2>Step 4 — Place the order</h2>
<p>To buy a lump sum instead, search the ETF in your broker's app, choose <strong>buy</strong>, and pick a <strong>market order</strong> (fills immediately) or a <strong>limit order</strong> (fills only at your price or better). SGX ETFs trade in board lots, often 100 or 10 units.</p>
<h2>A note on withholding tax (this can save you money)</h2>
<p>For ETFs that hold <em>US</em> shares, where the fund is legally based matters. A <strong>US-domiciled</strong> ETF has <strong>30%</strong> tax withheld on its US dividends for Singapore investors; an <strong>Ireland-domiciled</strong> (UCITS) ETF holding the same shares is taxed at only <strong>15%</strong>. For long-term investors that gap compounds, so many Singaporeans prefer Ireland-domiciled ETFs — these usually have <strong>"UCITS"</strong> in the name and trade on the London Stock Exchange (for example CSPX or VUAA for the S&amp;P 500). There is a second reason too: US-domiciled ETFs can expose foreign investors to <strong>US estate tax</strong> on holdings above about US$60,000, which Ireland-domiciled ETFs avoid. Singapore-listed ETFs like the STI ETF are not affected by either, and Singapore itself charges <strong>no tax on the dividends or gains</strong> you receive.</p>
<p>Once you own the ETF, distributions (if it is a distributing ETF) are paid automatically; accumulating ETFs reinvest internally instead. That is all there is to it.</p>`,
    faqs: [
      { q: `What is the best ETF for beginners in Singapore?`, a: `A common starting point is an STI ETF (ES3 or G3B) for instant exposure to Singapore's 30 blue chips, or a global/S&P 500 ETF for worldwide growth. Beginners often build the position gradually through a monthly Regular Savings Plan rather than one lump sum.` },
      { q: `Can I buy the S&P 500 ETF in Singapore?`, a: `Yes — through a broker that offers US or London-listed markets. Note that a US-domiciled S&P 500 ETF has 30% US withholding tax on dividends for Singapore investors, while an Ireland-domiciled (UCITS) equivalent is taxed at 15%, which is why many locals choose the Ireland-domiciled version for the long term.` },
      { q: `What is a Regular Savings Plan (RSP)?`, a: `An RSP automatically invests a fixed amount each month into an ETF (or stock), buying more units when prices are low and fewer when high. This dollar-cost averaging smooths out your entry price and removes the need to time the market — ideal for beginners.` },
      { q: `Do ETFs in Singapore pay dividends?`, a: `Many do. Bond, REIT and dividend ETFs distribute regularly, while some equity ETFs "accumulate" — reinvesting income internally instead of paying it out. The SGX-listed distributing ETFs are ranked by yield on the StockKaki ETFs page.` },
    ],
  },
  {
    slug: 'singapore-reits-explained',
    title: `Singapore REITs Explained: How S-REITs Work | StockKaki`,
    desc: `What Singapore REITs (S-REITs) are, why they yield more, the key numbers to check — distribution yield, gearing, occupancy, WALE — and the main risks. Plain English.`,
    h1: `Singapore REITs explained`,
    blurb: `What S-REITs are, why they yield more, and the key numbers to check before buying.`,
    body: `<p>A <strong>REIT</strong> — Real Estate Investment Trust — owns a portfolio of income-producing property (malls, offices, warehouses, data centres) and passes the rental income to unitholders. Singapore's REITs, or <strong>S-REITs</strong>, are one of the most popular ways locals earn passive income.</p>
<h2>Why S-REITs yield more than ordinary stocks</h2>
<p>To keep their tax-transparent status, S-REITs must distribute <strong>at least 90% of their taxable income</strong> to unitholders. That rule forces a high payout, which is why REIT distribution yields — often <strong>5–7%</strong> — tend to be higher than the dividend yields of ordinary shares. For individual investors, those distributions are also <strong>tax-exempt</strong>.</p>
<h2>The main types</h2>
<p>S-REITs are usually grouped by the property they hold: <strong>retail</strong> (malls), <strong>industrial &amp; logistics</strong> (warehouses, business parks), <strong>office</strong>, <strong>hospitality</strong> (hotels, serviced apartments), <strong>data centre</strong>, <strong>healthcare</strong>, and <strong>diversified</strong>. Each behaves a little differently — hospitality is more cyclical, while data centres and logistics have been structural growth areas.</p>
<h2>The numbers to check before you buy</h2>
<ul>
<li><strong>Distribution yield</strong> — the annual distribution divided by the price. Higher is not automatically better; check it is sustainable.</li>
<li><strong>Gearing (aggregate leverage)</strong> — how much debt the REIT carries against its assets, capped at <strong>50%</strong> by regulation. Lower gearing (say under 40%) means more headroom if property values fall.</li>
<li><strong>Occupancy rate</strong> — the percentage of space actually rented. High and stable is good.</li>
<li><strong>WALE</strong> — weighted average lease expiry, i.e. how long current leases run. A longer WALE means more predictable income.</li>
<li><strong>Sponsor quality</strong> — a strong sponsor (CapitaLand, Mapletree, Frasers, Keppel) can back the REIT with a property pipeline and cheaper funding.</li>
</ul>
<h2>The risks</h2>
<p>REITs are <strong>interest-rate sensitive</strong>: they borrow to buy property, so rising rates raise their costs and can pull unit prices down. They can also raise money by issuing new units (a <strong>rights issue</strong>), which dilutes existing holders. And ultimately their value tracks the property market. None of this makes them bad — it just means the yield is not free of risk.</p>
<p>You can compare every S-REIT by distribution yield on the <a href="/reits/">Singapore REITs page</a>, and each REIT's page shows its full distribution history and upcoming ex-dates.</p>`,
    faqs: [
      { q: `How are Singapore REIT distributions taxed?`, a: `Distributions from S-REITs are generally tax-exempt for individual investors holding the units in their personal capacity. This is part of what makes S-REITs attractive for income.` },
      { q: `What is a good yield for a Singapore REIT?`, a: `Around 5–7% is typical and reasonable for an S-REIT. A yield well above that can signal higher gearing, a weaker portfolio, or a market pricing in trouble — so check the fundamentals rather than buying on yield alone.` },
      { q: `What is gearing in a REIT?`, a: `Gearing (aggregate leverage) is the REIT's total debt as a percentage of its asset value, capped at 50% by MAS. Lower gearing means more financial headroom and less risk if property values decline or interest rates rise.` },
    ],
  },
  {
    slug: 'are-dividends-taxed-in-singapore',
    title: `Are Dividends Taxed in Singapore? | StockKaki`,
    desc: `The short answer is no — Singapore does not tax dividends from local companies, and there is no capital-gains tax. Plus the nuances for REITs and foreign (e.g. US) stocks.`,
    h1: `Are dividends taxed in Singapore?`,
    blurb: `The short answer is no — but there are a few nuances worth knowing (REITs, foreign stocks, when it applies).`,
    body: `<p><strong>For dividends from Singapore-resident companies, the answer is no — they are tax-free in your hands.</strong> There is also no capital-gains tax, so profits when you sell are yours to keep. This is a big part of why Singapore is such a friendly place for income investors.</p>
<h2>Why Singapore dividends are not taxed</h2>
<p>Singapore uses a <strong>one-tier corporate tax system</strong>. Companies pay tax on their profits, and when those after-tax profits are paid out as dividends, they are <em>not</em> taxed again at the shareholder level. So a dividend from an SGX-listed Singapore company arrives with no further tax to pay, and nothing to declare.</p>
<h2>What about REIT distributions?</h2>
<p>Distributions from <a href="/reits/">Singapore REITs</a> are generally <strong>tax-exempt for individuals</strong> holding units in their personal capacity. Different rules can apply if you hold them through a business or as a trading activity.</p>
<h2>The nuance: foreign stocks</h2>
<p>The tax-free treatment applies to <em>Singapore</em> dividends. If you own foreign shares, the <strong>source country may withhold tax</strong> before the dividend reaches you. The most common example: US-listed stocks withhold <strong>30%</strong> on dividends for Singapore residents (there is no US–Singapore tax treaty to reduce it). This does not apply to SGX-listed Singapore companies — but it is worth knowing before you buy US dividend stocks for income.</p>
<h2>When could Singapore tax apply?</h2>
<p>For ordinary investors buying and holding SGX stocks, dividends and capital gains are not taxed. Tax can enter the picture in narrower cases — for instance if you are assessed as <em>trading</em> shares as a business rather than investing — but that is the exception, not the rule for a typical dividend investor.</p>
<p>Because the yield you see is close to the yield you keep, comparing SGX payers is refreshingly simple — start with the <a href="/dividends/">best dividend stocks</a> page.</p>
<p style="font-size:14px;color:var(--muted)"><em>This is general information, not tax advice. For your own situation, check <a href="https://www.iras.gov.sg/" target="_blank" rel="noopener nofollow">IRAS</a> or a qualified tax professional.</em></p>`,
    faqs: [
      { q: `Do I need to pay tax on dividends from Singapore stocks?`, a: `No. Under Singapore's one-tier corporate tax system, dividends from SGX-listed Singapore-resident companies are tax-exempt for shareholders, and there is no capital-gains tax. You generally do not need to declare them.` },
      { q: `Are dividends from US stocks taxed for Singapore investors?`, a: `Yes — the US withholds 30% on dividends paid to Singapore residents, as there is no US–Singapore tax treaty to reduce the rate. This is separate from Singapore, which does not tax the dividend again.` },
      { q: `Is there capital-gains tax in Singapore?`, a: `No. Singapore does not impose a capital-gains tax, so profits from selling shares are generally not taxable for individual investors.` },
    ],
  },
];
function guidePage(g) {
  const faqHTML = (g.faqs && g.faqs.length) ? `<div class="h2">Common questions</div><div class="faq">${g.faqs.map(f => `<div class="faq-q">${f.q}</div><div class="faq-a">${f.a}</div>`).join('')}</div>` : '';
  const ld = { "@context":"https://schema.org","@graph":[
    { "@type":"BreadcrumbList","itemListElement":[ { "@type":"ListItem","position":1,"name":"Guides","item":`${SITE}/guides/` }, { "@type":"ListItem","position":2,"name":g.h1,"item":`${SITE}/guides/${g.slug}/` } ] },
    { "@type":"Article","headline":g.h1,"description":g.desc,"author":{ "@type":"Organization","name":"StockKaki" },"publisher":{ "@type":"Organization","name":"StockKaki" },"mainEntityOfPage":`${SITE}/guides/${g.slug}/` },
    ...(g.faqs && g.faqs.length ? [{ "@type":"FAQPage","mainEntity":g.faqs.map(f => ({ "@type":"Question","name":f.q,"acceptedAnswer":{ "@type":"Answer","text":f.a } })) }] : []),
  ] };
  const jsonLd = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\u003c')}</script>`;
  const body = `  <section class="hero" style="padding:22px 0 6px">
    <div class="crumb"><a href="/guides/">Guides</a> › ${g.h1}</div>
    <h1 class="serif" style="font-size:30px;max-width:22ch;line-height:1.12">${g.h1}</h1>
  </section>
  <article class="prose">${g.body}</article>
  ${faqHTML}
  ${jsonLd}`;
  return shell(g.title, g.desc, `${SITE}/guides/${g.slug}/`, body);
}
function guidesIndexPage(guides) {
  const body = `  <section class="hero" style="padding:22px 0 4px">
    <span class="kicker">Learn</span>
    <h1 class="serif" style="font-size:30px;margin:6px 0 6px">Guides</h1>
    <p class="sub" style="margin-bottom:0">Plain-English explainers for Singapore dividend &amp; income investing — no jargon, no fluff.</p>
  </section>
  <div class="guidelist">
${guides.map(g => `    <a class="gcard" href="/guides/${g.slug}/"><span class="gc-t">${g.h1}</span><span class="gc-b">${g.blurb}</span></a>`).join('\n')}
  </div>`;
  return shell('Investing Guides — Singapore Dividends & Income Explained | StockKaki', 'Plain-English guides to dividend investing in Singapore — how dividend yield works, SSB vs T-bills, ex-dividend dates, REITs and more. Free, no jargon.', `${SITE}/guides/`, body);
}
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

// ---------- account (login when logged-out, watchlist when logged-in) ----------
const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
function accountPage() {
  const body = `  <section class="hero" style="padding:24px 0 4px"><h1 class="serif" style="font-size:26px" id="acTitle">Your account</h1></section>
  <div id="acLoading" class="ac-note">Loading…</div>
  <div id="acAuth" hidden class="ac-authwrap">
    <div class="ac-card ac-authcard">
      <p class="ac-lede">Sign in to save stocks to your watchlist and — soon — get ex-date &amp; dividend alerts by email. <b>No password</b> — we email you a secure sign-in link.</p>
      <form id="emailForm" class="ac-emailform">
        <input id="acEmail" type="email" autocomplete="email" placeholder="you@email.com" required>
        <button class="btn" type="submit" style="width:100%;padding:13px;border-radius:12px;font-size:15px">Email me a sign-in link</button>
      </form>
      <p id="acMsg" class="ac-msg"></p>
      <div class="ac-or"><span>or</span></div>
      <button id="googleBtn" class="ac-google" disabled title="Coming soon">${GOOGLE_G} Continue with Google <span class="soon-tag">Soon</span></button>
      <p class="ac-fine">We'll only ever email you sign-in links and the alerts you choose — never spam.</p>
    </div>
  </div>
  <div id="acView" hidden>
    <div class="ac-card ac-head">
      <div class="ac-who"><span class="ac-avatar" id="acAvatar">?</span><span style="min-width:0;display:block"><span class="ac-nm" id="acName">You</span><span class="ac-em" id="acEm"></span></span></div>
      <button id="signOut" class="ac-signout">Sign out</button>
    </div>

    <div class="ac-tabs" role="tablist">
      <button class="ac-tab on" data-t="wl">Watchlist</button>
      <button class="ac-tab" data-t="pf">Profile</button>
      <button class="ac-tab" data-t="al">Alerts</button>
    </div>

    <div class="ac-pane" id="pane-wl">
      <div class="ac-sect"><span class="ac-sectc" id="acWlCount"></span></div>
      <div id="acWl"><p class="ac-empty">Loading…</p></div>
    </div>

    <div class="ac-pane" id="pane-pf" hidden>
      <div class="ac-card ac-form">
        <p class="ac-formlede">Add a few details for your profile. Only your email is required — the rest is optional and helps us personalise alerts later.</p>
        <div class="ac-field"><label>Email</label><input id="pfEmail" type="email" disabled></div>
        <div class="ac-row2">
          <div class="ac-field"><label>First name</label><input id="pfFirst" type="text" autocomplete="given-name" placeholder="Eugene"></div>
          <div class="ac-field"><label>Last name</label><input id="pfLast" type="text" autocomplete="family-name" placeholder="Teo"></div>
        </div>
        <div class="ac-field"><label>Mobile number <span class="ac-opt">optional</span></label><input id="pfMobile" type="tel" autocomplete="tel" placeholder="+65 9xxx xxxx"></div>
        <div class="ac-savebar"><span class="ac-saved" id="pfMsg"></span><button class="btn ac-save" id="pfSave">Save profile</button></div>
      </div>
    </div>

    <div class="ac-pane" id="pane-al" hidden>
      <div class="ac-card">
        <div class="ac-toprow"><div style="min-width:0"><div class="ac-alt2">Email me alerts</div><div class="ac-ald">Master switch for all StockKaki alert emails, sent to <b id="acEm2">you</b>.</div></div><button class="sw on" id="alMaster" data-k="master" role="switch" aria-label="Email me alerts"></button></div>
        <div class="ac-subs" id="alSubs">
          <div class="ac-alert2"><span class="ac-alic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></span><div style="flex:1;min-width:0"><div class="ac-alt2">Ex-date reminders</div><div class="ac-ald">3 days before a watchlist stock goes ex-dividend.</div></div><button class="sw on" data-k="exdate" role="switch"></button></div>
          <div class="ac-alert2"><span class="ac-alic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-4 3 2 5-7"/></svg></span><div style="flex:1;min-width:0"><div class="ac-alt2">Dividend changes</div><div class="ac-ald">When a saved stock declares, raises, cuts or suspends its dividend.</div></div><button class="sw on" data-k="divchange" role="switch"></button></div>
          <div class="ac-alert2"><span class="ac-alic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5z"/><path d="M9 12l2 2 4-4"/></svg></span><div style="flex:1;min-width:0"><div class="ac-alt2">New Savings Bond (SSB)</div><div class="ac-ald">Each month's new SSB issue with its 1-year &amp; 10-year rates.</div></div><button class="sw" data-k="ssb" role="switch"></button></div>
        </div>
        <div class="ac-savebar"><span class="ac-note" id="alNote">Delivery is rolling out soon — set your preferences now.</span><button class="btn ac-save" id="alSave">Save</button></div>
      </div>
    </div>
  </div>`;
  const script = `<script type="module">
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const sb=createClient('${SUPABASE_URL}','${SUPABASE_ANON}');
const $=function(id){return document.getElementById(id);};
const nextUrl=new URLSearchParams(location.search).get('next');
function show(v){['acLoading','acAuth','acView'].forEach(function(x){$(x).hidden=(x!==v);});}
$('googleBtn').onclick=function(){sb.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+'/account/'}});};
$('emailForm').addEventListener('submit',async function(e){e.preventDefault();var email=$('acEmail').value.trim();if(!email)return;var btn=e.target.querySelector('button');btn.textContent='Sending…';btn.disabled=true;var r=await sb.auth.signInWithOtp({email:email,options:{emailRedirectTo:location.origin+'/account/'}});$('acMsg').className='ac-msg '+(r.error?'err':'ok');$('acMsg').textContent=r.error?('Could not send — '+r.error.message):('✓ Check your inbox — sign-in link sent to '+email);btn.textContent='Email me a sign-in link';btn.disabled=false;});
$('signOut').onclick=async function(){await sb.auth.signOut();location.href='/';};
var TRASH='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>';
var STARBIG='<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 15 9l7 .5-5.4 4.6L18.2 21 12 17l-6.2 4 1.6-6.9L2 9.5 9 9z"/></svg>';
function rowHTML(it){
  var tk=it.tk?' <span class="tick">'+it.tk+'</span>':'';
  var sub=it.price?'<span class="ac-wlsub">'+it.cur+it.price+'</span>':'';
  var yld=(it.y!=null)?'<span class="ac-wly">'+(+it.y).toFixed(2)+'%<span class="ac-wlyl">yield</span></span>':'<span class="ac-wly mut">—</span>';
  return '<div class="ac-wl"><a class="ac-wllink" href="/stock/'+it.slug+'/"><span class="ac-wlinfo"><span class="ac-wlnm">'+it.name+tk+'</span>'+sub+'</span>'+yld+'</a><button class="ac-x" data-slug="'+it.slug+'" aria-label="Remove">'+TRASH+'</button></div>';
}
function bindRemove(){document.querySelectorAll('#acWl .ac-x').forEach(function(b){b.onclick=async function(){if(DEMO){b.closest('.ac-wl').remove();return;}await sb.from('watchlist').delete().eq('slug',b.dataset.slug);loadWatchlist();};});}
function paintRows(items){
  var wl=$('acWl');
  $('acWlCount').textContent=items.length?(items.length+' saved · grouped by type'):'';
  if(!items.length){wl.innerHTML='<div class="ac-emptybox">'+STARBIG+'<p class="ac-empty">No saved stocks yet.<br>Tap <b>★ Save</b> on any stock to add it here.</p><a class="ac-browse" href="/stocks/">Browse stocks →</a></div>';return;}
  var groups=[['stock','Stocks'],['reit','REITs & Trusts'],['etf','ETFs']],html='';
  groups.forEach(function(g){var gi=items.filter(function(it){return (it.type||'stock')===g[0];});if(!gi.length)return;
    html+='<div class="ac-grp">'+g[1]+' <span>'+gi.length+'</span></div><div class="ac-grpcard">'+gi.map(rowHTML).join('')+'</div>';});
  wl.innerHTML=html;bindRemove();
}
async function loadWatchlist(){
  var res=await sb.from('watchlist').select('slug,created_at').order('created_at',{ascending:false});
  var rows=res.data||[];var idx={};try{idx=await(await fetch('/api/stocks.json')).json();}catch(e){}
  paintRows(rows.map(function(r){var d=idx[r.slug]||[r.slug];return {slug:r.slug,name:d[0]||r.slug,tk:d[1]||'',price:d[2],cur:d[3]||'S$',y:d[4],type:d[5]||'stock'};}));
}
function fillUser(nm,em){$('acName').textContent=nm;$('acEm').textContent=em;$('acAvatar').textContent=(nm[0]||'?').toUpperCase();var e2=$('acEm2');if(e2)e2.textContent=em;var pe=$('pfEmail');if(pe)pe.value=em;}
function fillProfile(meta){$('pfFirst').value=meta.first_name||'';$('pfLast').value=meta.last_name||'';$('pfMobile').value=meta.mobile||'';
  if(meta.alerts){var a=meta.alerts;var m=$('alMaster');if(m)m.classList.toggle('on',a.master!==false);['exdate','divchange','ssb'].forEach(function(k){var s=document.querySelector('#alSubs .sw[data-k="'+k+'"]');if(s)s.classList.toggle('on',!!a[k]);});$('alSubs').classList.toggle('off',a.master===false);}}
var DEMO=new URLSearchParams(location.search).has('demo');
document.querySelectorAll('.ac-tab').forEach(function(t){t.onclick=function(){document.querySelectorAll('.ac-tab').forEach(function(x){x.classList.remove('on');});t.classList.add('on');['wl','pf','al'].forEach(function(k){var p=$('pane-'+k);if(p)p.hidden=(k!==t.dataset.t);});};});
document.addEventListener('click',function(e){var s=e.target.closest&&e.target.closest('#pane-al .sw');if(!s)return;s.classList.toggle('on');if(s.id==='alMaster')$('alSubs').classList.toggle('off',!s.classList.contains('on'));});
$('pfSave').onclick=async function(){var data={first_name:$('pfFirst').value.trim(),last_name:$('pfLast').value.trim(),mobile:$('pfMobile').value.trim()};var btn=$('pfSave');btn.disabled=true;btn.textContent='Saving…';var r=DEMO?{}:await sb.auth.updateUser({data:data});btn.disabled=false;btn.textContent='Save profile';var msg=$('pfMsg');msg.className='ac-saved'+((r&&r.error)?' err':'');msg.textContent=(r&&r.error)?'Could not save':'✓ Saved';setTimeout(function(){msg.textContent='';},2500);var nm=(data.first_name+' '+data.last_name).trim();if(nm){$('acName').textContent=nm;$('acAvatar').textContent=nm[0].toUpperCase();}};
$('alSave').onclick=async function(){var pref={};document.querySelectorAll('#pane-al .sw').forEach(function(s){pref[s.dataset.k]=s.classList.contains('on');});var btn=$('alSave');btn.disabled=true;btn.textContent='Saving…';var r=DEMO?{}:await sb.auth.updateUser({data:{alerts:pref}});btn.disabled=false;btn.textContent='Save';var n=$('alNote');n.textContent=(r&&r.error)?'Could not save — try again':'✓ Preferences saved';setTimeout(function(){n.textContent='Delivery is rolling out soon — set your preferences now.';},2800);};
function trackAuth(user){try{if(!window.gtag||!user)return;var method=(user.app_metadata&&user.app_metadata.provider)||'email';var isNew=false;try{isNew=(Date.now()-new Date(user.created_at).getTime())<120000;}catch(e){}var k='sk_su_'+user.id;if(isNew&&!localStorage.getItem(k)){window.gtag('event','sign_up',{method:method});try{localStorage.setItem(k,'1');}catch(e){}}window.gtag('event','login',{method:method});}catch(e){}}
async function render(){
  if(DEMO){fillUser('Eugene Teo','eugeneteo1988@gmail.com');fillProfile({first_name:'Eugene',last_name:'Teo',mobile:'+65 9123 4567'});show('acView');paintRows([{slug:'dbs-group-holdings-ltd',name:'DBS Group Holdings',tk:'D05',price:71.9,cur:'S$',y:4.31,type:'stock'},{slug:'singtel',name:'Singtel',tk:'Z74',price:4.46,cur:'S$',y:4.09,type:'stock'},{slug:'capitaland-ascendas-reit',name:'CapLand Ascendas REIT',tk:'A17U',price:2.48,cur:'S$',y:4.93,type:'reit'},{slug:'mapletree-industrial-trust',name:'Mapletree Industrial Trust',tk:'ME8U',price:1.92,cur:'S$',y:6.59,type:'reit'},{slug:'abf-sg-bond-etf',name:'ABF SG Bond ETF',tk:'A35',price:1.115,cur:'S$',y:3.1,type:'etf'}]);return;}
  var s=(await sb.auth.getSession()).data.session;
  if(!s){show('acAuth');return;}
  var u=s.user;var em=u.email||'';var meta=u.user_metadata||{};var nm=((meta.first_name||'')+' '+(meta.last_name||'')).trim()||meta.name||meta.full_name||em.split('@')[0]||'You';
  fillUser(nm,em);fillProfile(meta);show('acView');loadWatchlist();
  if(location.hash==='#alerts'){var at=document.querySelector('.ac-tab[data-t="al"]');if(at)at.click();}
  if(nextUrl&&/^\\/stock\\//.test(nextUrl)){history.replaceState({},'',location.pathname);}
}
if(!DEMO)sb.auth.onAuthStateChange(function(evt,sess){if(evt==='SIGNED_IN'&&sess)trackAuth(sess.user);render();});
render();
</script>`;
  return shell('Your account | StockKaki', 'Sign in to StockKaki to save stocks to your watchlist and get dividend alerts.', SITE + '/account/', body, script);
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
const tbills = fetchTBills();     // Singapore Treasury Bill auction cut-off yields (MAS)
const BANK = JSON.parse(readFileSync(new URL('./data/bank-rates.json', import.meta.url), 'utf8'));   // FD + savings rates, verified monthly against each bank's page
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

// General Singapore-market news feed (cached like everything else so push builds keep it).
let marketNews = Array.isArray(cache.__market) ? cache.__market : [];
if (!SKIP_YAHOO) {
  const mn = fetchMarketNews();
  if (mn.length) { marketNews = mn; fresh.__market = mn; }
  console.log(`Market news: ${mn.length} items fetched (${marketNews.length} in feed)`);
}

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
const _dedupe = (arr) => arr.filter((n,i) => arr.findIndex(x => x.title === n.title) === i);   // keep first (newest, post-sort)
const marketItems = (marketNews || []).filter(n => n.dateISO && NEWS_OK.has(n.source) && !NEWS_JUNK.test(n.title))
  .map(n => ({ title: n.title, link: n.link, dateISO: n.dateISO, source: n.source || '', name: 'Singapore market', slug: null }));
// Homepage "Latest news": general market feed + top-counter news, newest first.
const hubNews = _dedupe([
  ...marketItems,
  ...companies.filter(c => _newsSlugs.has(c.slug) && c.news && c.news.length)
    .flatMap(c => c.news.filter(n => n.dateISO && NEWS_OK.has(n.source) && titleHasCo(n.title, c.name) && !NEWS_JUNK.test(n.title)).map(n => ({ title: n.title, link: n.link, dateISO: n.dateISO, slug: c.slug, name: c.name, source: n.source || '' }))),
].sort((a,b) => a.dateISO < b.dateISO ? 1 : -1)).slice(0, 5);
// Full aggregated feed for the /news/ page: general market feed + every counter's news, newest first, de-duped.
const newsFeed = _dedupe([
  ...marketItems,
  ...companies.filter(c => c.news && c.news.length)
    .flatMap(c => c.news.filter(n => n.dateISO && NEWS_OK.has(n.source) && titleHasCo(n.title, c.name) && !NEWS_JUNK.test(n.title)).map(n => ({ title: n.title, link: n.link, dateISO: n.dateISO, source: n.source || '', name: c.name, slug: c.slug }))),
].sort((a,b) => a.dateISO < b.dateISO ? 1 : -1)).slice(0, 60);
const hub = { stockCount: listed.length, divCount: dividendStocks.length, reitCount: reitCountH, etfCount: etfCountH, hyCount,
  ssbLo: ssb && ssb.current ? ssb.current.y1 : null, ssbHi: ssb && ssb.current ? ssb.current.y10 : null,
  tb6: tbills && tbills.l6 ? tbills.l6.cutoff_yield : null,
  trending, trendingCount: trending.length, news: hubNews };

const out = new URL('./dist/', import.meta.url);
// Clear dist's CONTENTS rather than rmdir'ing dist itself — on Windows the folder handle can be
// held (Explorer window, Defender, indexer) causing EBUSY on rmdir even when children are deletable.
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) rmSync(new URL(entry, out), { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
for (const f of ['favicon.svg', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png', 'favicon.ico', 'og.png', 'moomoo.png']) copyFileSync(new URL(`assets/${f}`, import.meta.url), new URL(f, out));
mkdirSync(new URL('og/', out), { recursive: true });   // per-page social cards (assets/og/*.png → /og/*.png)
try { const ogDir = new URL('assets/og/', import.meta.url); for (const f of readdirSync(ogDir)) if (f.endsWith('.png')) copyFileSync(new URL(f, ogDir), new URL(`og/${f}`, out)); } catch {}
try { const sd = new URL('assets/og/stock/', import.meta.url); mkdirSync(new URL('og/stock/', out), { recursive: true }); for (const f of readdirSync(sd)) if (f.endsWith('.png')) copyFileSync(new URL(f, sd), new URL(`og/stock/${f}`, out)); } catch {}   // per-stock share cards
writeFileSync(new URL('index.html', out), homepage(listed, index, hub, upcoming));
writeFileSync(new URL('CNAME', out), 'stockkaki.com\n');
mkdirSync(new URL('disclaimer/', out), { recursive: true });
writeFileSync(new URL('disclaimer/index.html', out), disclaimerPage());
mkdirSync(new URL('guides/', out), { recursive: true });
writeFileSync(new URL('guides/index.html', out), guidesIndexPage(GUIDES));
for (const g of GUIDES) { const gd = new URL(`guides/${g.slug}/`, out); mkdirSync(gd, { recursive: true }); writeFileSync(new URL('index.html', gd), guidePage(g)); }

// Per-stock OG share cards: the top-N counters by market cap get a data-rich card; the rest use the generic /og.png.
const OG_TOP_N = 200;
const ogStocks = listed.filter(c => c.fund && c.fund.mktCap)
  .sort((a, b) => capSGD(b.fund.cur || b.cur, b.fund.mktCap) - capSGD(a.fund.cur || a.cur, a.fund.mktCap))
  .slice(0, OG_TOP_N);
const ogStockSet = new Set(ogStocks.map(c => c.slug));
mkdirSync(new URL('api/', out), { recursive: true });
writeFileSync(new URL('api/og-stocks.json', out), JSON.stringify(ogStocks.map(c => ({
  slug: c.slug, name: c.name, ticker: c.ticker || '', cur: csym(c.cur),
  yield: c.yieldPct != null ? +c.yieldPct.toFixed(2) : null,
  ttm: (c.ttm > 0 && !c.divIncomplete) ? +c.ttm.toFixed(4) : null,
  type: c.isReit ? 'REIT' : c.secType === 'etfs' ? 'ETF' : 'Stock',
  mcap: fmtCap(c.fund.cur || c.cur, c.fund.mktCap) || ''
}))));

let n = 0;
for (const c of companies) {
  const dir = new URL(`stock/${c.slug}/`, out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('index.html', dir), stockPage(c));
  n++;
}
mkdirSync(new URL('stocks/', out), { recursive: true });
writeFileSync(new URL('stocks/index.html', out), stocksPage(listed));
mkdirSync(new URL('blue-chips/', out), { recursive: true });
writeFileSync(new URL('blue-chips/index.html', out), blueChipsPage(listed));
mkdirSync(new URL('dividends/', out), { recursive: true });
writeFileSync(new URL('dividends/index.html', out), listPage({
  title: `Best Dividend Stocks in Singapore ${YEAR} — Highest SGX Dividend Yields | StockKaki`,
  desc: `The highest-yielding SGX dividend stocks and REITs for ${YEAR}, ranked by dividend yield and updated daily. Search, filter and compare the best Singapore dividend stocks — free, no clutter.`,
  h1: `Best dividend stocks in Singapore — ${YEAR}`, sub: `${dividendStocks.length} SGX counters currently paying dividends — ranked by yield, updated daily. (Search any of ${listed.length} listed stocks above.)`,
  intro: `Singapore is one of the world's best places for dividend investors — there is <b>no tax on dividends and no capital-gains tax</b>. Above are all <b>${dividendStocks.length}</b> SGX counters currently paying a dividend, ranked by trailing 12-month yield and updated daily. Use the filters for Stocks, REITs or ETFs — and note that an unusually high yield can signal a one-off special dividend or higher risk.`,
  faqs: [
    { q: `What are the best dividend stocks in Singapore in ${YEAR}?`, a: 'This page ranks every SGX counter currently paying a dividend by trailing 12-month yield — the leaders are usually high-yield REITs, trusts and selected blue chips. Filter by Stocks, REITs or ETFs above; a very high yield may include a one-off special or reflect higher risk.' },
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
  title: `Best REITs to Buy in Singapore ${YEAR} — S-REIT Dividend Yields | StockKaki`,
  desc: `All SGX-listed REITs and business trusts ranked by distribution yield for ${YEAR} — CapitaLand, Mapletree, Keppel, Frasers and more. Live, clean, updated daily.`,
  h1: `Best REITs to buy in Singapore — ${YEAR}`, sub: `All ${reitList.length} SGX-listed REITs and business trusts, ranked by distribution yield.`,
  intro: `Singapore REITs (S-REITs) are among the most popular income investments here — they must distribute at least 90% of income, so yields are typically higher than ordinary stocks, and distributions are <b>tax-free</b> for individuals. Above are all <b>${reitList.length}</b> SGX-listed REITs and business trusts, ranked by trailing distribution yield and updated daily. Looking for price gains rather than income? See the <a href="/best-performing-reits/">best performing S-REITs by 1-year return</a>.`,
  faqs: [
    { q: `What is the best REIT to buy in Singapore in ${YEAR}?`, a: 'There is no single best REIT — it depends on your goals. This page ranks all SGX-listed S-REITs and business trusts by trailing distribution yield so you can compare income; also weigh the sector, gearing and track record before deciding.' },
    { q: 'What is the average dividend yield of Singapore REITs?', a: 'S-REITs typically yield around 5–7%. They must distribute at least 90% of taxable income, which is why their yields are usually higher than ordinary shares.' },
    { q: 'Are Singapore REITs a good investment?', a: 'S-REITs offer regular income and property diversification, and distributions are tax-free for individuals. They carry risks too — interest rates, property values and gearing — so diversify and check each REIT’s fundamentals.' },
    { q: 'How are Singapore REIT distributions taxed?', a: 'Distributions from S-REITs are generally tax-exempt for individual investors.' },
  ],
  list: reitList, canon: SITE + '/reits/', typeChips: false, og: '/og/reits.png' }));
mkdirSync(new URL('best-performing-reits/', out), { recursive: true });
writeFileSync(new URL('best-performing-reits/index.html', out), bestPerfReitsPage(reitList));
mkdirSync(new URL('etfs/', out), { recursive: true });
const etfList = listed.filter(c => c.secType==='etfs' && (c.ttm>0 || c.divIncomplete));
writeFileSync(new URL('etfs/index.html', out), listPage({
  title: `Best Singapore ETFs ${YEAR} — Top SGX ETFs by Dividend Yield | StockKaki`,
  desc: `SGX-listed ETFs ranked by distribution yield for ${YEAR} — STI, bond, REIT and dividend ETFs. Compare Singapore ETFs, clean and updated daily.`,
  h1: `Best ETFs in Singapore — ${YEAR}`, sub: `${etfList.length} SGX-listed ETFs that distribute, ranked by yield.`,
  intro: `Exchange-traded funds (ETFs) let you own a whole basket of stocks or bonds in a single trade, and they trade on the SGX just like shares. Above are the <b>${etfList.length}</b> SGX-listed ETFs that currently distribute, ranked by trailing yield — useful for income. For growth, the underlying index matters more than the yield. New to this? See <a href="/guides/how-to-buy-etf-in-singapore/">how to buy an ETF in Singapore</a>.`,
  faqs: [
    { q: `What are the best ETFs in Singapore in ${YEAR}?`, a: 'Popular SGX ETFs include the Straits Times Index (STI) ETF and a range of bond, REIT and dividend ETFs. This page ranks the distributing SGX ETFs by yield — best for income; for growth, look at the underlying index rather than the yield.' },
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
mkdirSync(new URL('t-bills/', out), { recursive: true });
writeFileSync(new URL('t-bills/index.html', out), tbillsPage(tbills));
// --- Savings hub + Fixed Deposits + Savings Accounts (bank rates) ---
mkdirSync(new URL('savings/', out), { recursive: true });
writeFileSync(new URL('savings/index.html', out), savingsHubPage());
mkdirSync(new URL('fixed-deposits/', out), { recursive: true });
writeFileSync(new URL('fixed-deposits/index.html', out), ratePage({
  canon: SITE + '/fixed-deposits/', tag: 'Ranked by rate',
  title: `Best Fixed Deposit Rates in Singapore ${YEAR} — Verified Bank Comparison | StockKaki`,
  desc: `Singapore fixed deposit (FD) rates compared and verified against each bank's own page for ${YEAR} — DBS, UOB, OCBC, Standard Chartered and more. See the real rate, not the headline.`,
  h1: `Best fixed deposit rates in Singapore — ${YEAR}`,
  sub: `SGD fixed deposit rates, ranked and checked against each bank's official page.`,
  list: BANK.fd,
  intro: `<p style="margin:0 0 12px">A fixed deposit locks your money away for a set term in return for a <b>guaranteed</b> rate &mdash; you know exactly what you'll earn, and it doesn't depend on how you spend. The list above is ranked by the <b>effective rate</b> (what you actually earn), each figure checked against the bank's own page. Every FD here is SDIC-insured up to S$100,000 per bank.</p>
  <div style="background:var(--accent-soft);border-radius:12px;padding:14px 16px;margin:0 0 12px">
    <div style="font-weight:600;margin-bottom:6px">How to read these rates &mdash; in plain English</div>
    <div style="font-size:13px;line-height:1.7"><b>Effective rate</b> is what lands in your pocket. When a bank shows a higher &ldquo;up to&rdquo; number, the rate usually <b>steps up</b> over the term &mdash; you only reach the top rate near the end, so the average you earn is a bit lower. We rank by the effective rate so it's a fair, like-for-like comparison.<br><b>Fresh funds</b> &mdash; many of the best rates are for new money, not cash already sitting with the bank.<br><b>Tenure</b> &mdash; the rate depends on how long you lock it up (usually 6 or 12 months).<br><b>Minimum</b> &mdash; how much you need to start, from S$500 to S$25,000.<br><b>Tier</b> &mdash; a few of the top rates are for Priority or Private banking clients.</div>
  </div>
  <p style="margin:0">Prefer to keep your money flexible, or chase a higher rate with some conditions? Compare <a href="/savings-accounts/">high-interest savings accounts</a> or <a href="/ssb/">Singapore Savings Bonds</a>.</p>`,
  faqs: [
    { q: `What is the best fixed deposit rate in Singapore in ${YEAR}?`, a: `The highest SGD fixed deposit rates are around 1.50–1.55% p.a. — from Maybank (1.50% effective), Hong Leong Finance, RHB and Bank of China (which needs just S$500). The three local banks (UOB, OCBC 1.30%; DBS/POSB 1.00%) sit lower. Rates are verified against each bank's own page and change with promotions.` },
    { q: `Why is the advertised rate sometimes higher than what I actually earn?`, a: `Two common reasons, both perfectly normal. First, many promotions "step up" — the rate rises over the term, so you touch the top number only near the end and the effective (average) rate is a little lower. Second, the highest rate can be for a specific customer tier — for example Standard Chartered shows 1.30% standard, 1.40% Priority and 1.60% Priority Private. The number that matters is the effective rate for the tier you're in, which is what we rank by.` },
    { q: `Is my fixed deposit safe in Singapore?`, a: `Yes. SGD deposits with a Singapore bank or finance company are insured by the Singapore Deposit Insurance Corporation (SDIC) up to S$100,000 per depositor per bank.` },
    { q: `Fixed deposit or high-interest savings account — which is better?`, a: `A fixed deposit gives a guaranteed rate with no hoops but locks your money for the term. A savings account can pay more but only if you credit your salary and spend on a card. If you value certainty and simplicity, choose an FD; if you can meet the conditions, a savings account may pay more.` },
  ],
}));
mkdirSync(new URL('savings-accounts/', out), { recursive: true });
writeFileSync(new URL('savings-accounts/index.html', out), ratePage({
  canon: SITE + '/savings-accounts/', tag: 'Ranked by max rate',
  title: `Best Savings Accounts in Singapore ${YEAR} — Highest Interest Compared | StockKaki`,
  desc: `Singapore's highest-interest savings accounts for ${YEAR} — DBS Multiplier, UOB One, OCBC 360 and the digital banks — with the real conditions behind each rate. Verified, free.`,
  h1: `Best savings accounts in Singapore — ${YEAR}`,
  sub: `High-interest savings accounts, ranked by headline rate &mdash; with the conditions spelled out.`,
  list: BANK.savings,
  intro: `<p style="margin:0 0 12px">A high-interest savings account can pay more than a fixed deposit &mdash; the top rates are &ldquo;bonus interest&rdquo; you unlock by doing things: crediting your salary, spending on a card, sometimes insuring and investing too. The list above is ranked by headline rate, each figure verified against the bank's page, with the conditions shown plainly.</p>
  <div style="background:var(--accent-soft);border-radius:12px;padding:14px 16px;margin:0 0 12px">
    <div style="font-weight:600;margin-bottom:6px">How to read these rates &mdash; in plain English</div>
    <div style="font-size:13px;line-height:1.7"><b>Bonus interest stacks.</b> You earn a small base rate on everything, plus extra for each thing you do (salary, spend, insure, invest). The headline &ldquo;up to&rdquo; number is what you'd earn only if you tick every box &mdash; OCBC 360, for example, is about 1.95% on salary + save + spend, and reaches 4.45% when you also insure and invest.<br><b>There's usually a cap</b> &mdash; the bonus interest applies only up to a limit, often the first S$100,000.<br><b>The no-hoops option</b> &mdash; the digital banks (GXS, Trust) pay a flat 2.4&ndash;2.8% with almost no conditions, the simplest choice if you'd rather not juggle requirements.</div>
  </div>
  <p style="margin:0">Want a guaranteed rate with no conditions at all? See <a href="/fixed-deposits/">fixed deposits</a>.</p>`,
  faqs: [
    { q: `Which savings account has the highest interest in Singapore in ${YEAR}?`, a: `DBS Multiplier and UOB One advertise the highest headline rates (up to ~4.1% and ~3.4%), but only if you meet several salary and spending conditions. For an easy high rate with almost no conditions, the digital banks GXS (up to 2.82%) and Trust (2.4%) are hard to beat.` },
    { q: `Do I actually get the advertised savings rate?`, a: `You earn the base rate on your whole balance, plus bonus interest for each condition you meet — so you'd reach the headline "up to" number only if you tick every box (salary, spend, insure, invest). The practical tip: look at the rate for the conditions you'll realistically meet, not the maximum. If you'd rather keep it simple, the digital banks pay a flat rate with almost no conditions.` },
    { q: `Are digital bank savings accounts (GXS, Trust) safe?`, a: `Yes. GXS and Trust are licensed Singapore banks and deposits are SDIC-insured up to S$100,000 per bank, the same protection as DBS, UOB or OCBC.` },
    { q: `Savings account or fixed deposit?`, a: `A savings account keeps your money fully accessible and can pay more if you meet the conditions; a fixed deposit gives a guaranteed rate but locks the funds for the term. Match it to whether you need flexibility or certainty.` },
  ],
}));
mkdirSync(new URL('account/', out), { recursive: true });
writeFileSync(new URL('account/index.html', out), accountPage());
mkdirSync(new URL('confirm/', out), { recursive: true });
writeFileSync(new URL('confirm/index.html', out), utilPage('Confirm your alerts', 'confirm_subscriber', "You're in! 🦁", "You'll get StockKaki dividend & ex-date alerts.", 'Already confirmed (or the link expired).'));
mkdirSync(new URL('unsubscribe/', out), { recursive: true });
writeFileSync(new URL('unsubscribe/index.html', out), utilPage('Unsubscribe', 'unsubscribe', 'Unsubscribed', 'You will no longer receive StockKaki emails.', 'Already unsubscribed.'));
mkdirSync(new URL('api/', out), { recursive: true });
writeFileSync(new URL('api/upcoming.json', out), JSON.stringify(upcoming.map(r => ({ name: r.name, ticker: r.ticker || null, amt: money(r.ccy, r.amt), ex: r.exISO, slug: r.slug }))));
// compact slug -> [name, ticker, price, currency, yield] map for the account watchlist to render saved stocks
writeFileSync(new URL('api/stocks.json', out), JSON.stringify(Object.fromEntries(listed.map(c => [c.slug, [c.name, c.ticker || '', c.price || null, csym(c.cur), c.yieldPct != null ? +c.yieldPct.toFixed(2) : null, c.isReit ? 'reit' : c.secType === 'etfs' ? 'etf' : 'stock']]))));
if (ssb && ssb.current) writeFileSync(new URL('api/ssb.json', out), JSON.stringify({ code: ssb.current.code, y1: ssb.current.y1, y10: ssb.current.y10, applyFmt: ssb.current.applyFmt, issueFmt: ssb.current.issueFmt }));   // for new-SSB alerts

const urls = [SITE + '/', SITE + '/stocks/', SITE + '/blue-chips/', SITE + '/dividends/', SITE + '/reits/', SITE + '/best-performing-reits/', SITE + '/etfs/', SITE + '/dividend-calendar/', SITE + '/savings/', SITE + '/fixed-deposits/', SITE + '/savings-accounts/', SITE + '/ssb/', SITE + '/t-bills/', SITE + '/news/', SITE + '/guides/', SITE + '/trending/', SITE + '/announcements/', SITE + '/disclaimer/', ...GUIDES.map(g => `${SITE}/guides/${g.slug}/`), ...all.map(c => `${SITE}/stock/${c.slug}/`)];
writeFileSync(new URL('sitemap.xml', out),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n') + `\n</urlset>\n`);
writeFileSync(new URL('robots.txt', out), `User-agent: *\nAllow: /\nDisallow: /account/\nDisallow: /confirm/\nDisallow: /unsubscribe/\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(new URL('llms.txt', out), `# StockKaki — Singapore dividend & stock tracker
> Free, clean tool for SGX dividends, ex-dates, yields and stock info. Data sourced from the Singapore Exchange (SGX), updated daily. Not financial advice.

## Key pages
- Upcoming SGX dividends & ex-dates: ${SITE}/
- Best dividend stocks (ranked by yield): ${SITE}/dividends/
- Singapore REITs by distribution yield: ${SITE}/reits/
- Best performing S-REITs (ranked by 1-year share-price return): ${SITE}/best-performing-reits/
- Where to park cash (fixed deposits, savings accounts, SSB, T-bills) compared: ${SITE}/savings/
- Best fixed deposit rates in Singapore (verified against each bank): ${SITE}/fixed-deposits/
- Best high-interest savings accounts in Singapore (with real conditions): ${SITE}/savings-accounts/
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
