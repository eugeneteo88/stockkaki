// StockKaki data-accuracy monitor — weekly cross-check of LIVE yields/prices
// against an independent source (Yahoo Finance). Emails Eugene ONLY the stocks
// that drift beyond tolerance; silent when everything's clean. Catches: SGX
// parse errors, dividend payers we show blank, and stale builds (our price
// lagging live Yahoo = the build broke). Not a replacement for spot checks —
// a safety net so "is our data right?" is never a guess.
//
//   node accuracy-check.mjs
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36';
const { RESEND_API_KEY } = process.env;
const TO = process.env.REPORT_TO || 'eugeneteo1988@gmail.com';
const FROM = process.env.REPORT_FROM || 'StockKaki <alerts@stockkaki.com>';
const SITE = process.env.SITE || 'https://stockkaki.com';
// tolerances
const YIELD_GAP = Number(process.env.YIELD_GAP || 0.6);   // pct-points
const PRICE_GAP = Number(process.env.PRICE_GAP || 4);     // %
const MISSING_MIN = Number(process.env.MISSING_MIN || 1); // yahoo yield above this but we show nothing

const now = Date.now() / 1000, yrAgo = now - 365 * 86400;
const cur2code = s => s === 'US$' ? 'USD' : s === 'S$' ? 'SGD' : (s || 'SGD');

function yahoo(t) {
  try {
    const raw = execFileSync('curl', ['-s', '-m', '20', '-A', UA, '--compressed',
      `https://query1.finance.yahoo.com/v8/finance/chart/${t}.SI?range=13mo&interval=1d&events=div`], { maxBuffer: 1e7 }).toString();
    const r = JSON.parse(raw)?.chart?.result?.[0]; if (!r?.meta) return null;
    let ttm = 0; for (const d of Object.values(r.events?.dividends || {})) if (d.date >= yrAgo && d.amount > 0) ttm += d.amount;
    const price = r.meta.regularMarketPrice;
    return { cur: r.meta.currency, price, ttm, y: price > 0 ? ttm / price * 100 : null };
  } catch { return null; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1) live dataset
let data;
try {
  const raw = execFileSync('curl', ['-s', '-m', '30', '-A', UA, `${SITE}/api/stocks.json`], { maxBuffer: 5e7 }).toString();
  data = JSON.parse(raw);
} catch (e) { console.log('could not fetch live stocks.json:', e.message); process.exit(0); }

// 2) universe to check: dividend payers + all foreign-currency counters
const rows = Object.entries(data)
  .map(([slug, v]) => ({ slug, name: v[0], t: v[1], price: v[2], cur: v[3], y: v[4], type: v[5] }))
  .filter(r => r.t && (r.y != null || r.cur !== 'S$'));

console.log(`checking ${rows.length} counters against Yahoo…`);
const flags = [];
let checked = 0, yfail = 0;
for (const r of rows) {
  const y = yahoo(r.t); await sleep(120);
  if (!y || y.y == null && y.price == null) { yfail++; continue; }
  checked++;
  const issues = [];
  if (y.price > 0 && r.price > 0 && Math.abs(r.price - y.price) / y.price * 100 >= PRICE_GAP)
    issues.push(`price ${r.cur}${r.price} vs Yahoo ${y.price} (${((r.price - y.price) / y.price * 100).toFixed(1)}%)`);
  if (r.y == null && y.y != null && y.y >= MISSING_MIN)
    issues.push(`we show NO yield; Yahoo ${y.y.toFixed(2)}%`);
  else if (r.y != null && y.y != null && Math.abs(r.y - y.y) >= YIELD_GAP)
    issues.push(`yield ${r.y}% vs Yahoo ${y.y.toFixed(2)}% (${(r.y - y.y > 0 ? '+' : '') + (r.y - y.y).toFixed(2)})`);
  if (issues.length) flags.push({ ...r, y, issues });
}

console.log(`checked ${checked}, yahoo-unreachable ${yfail}, flagged ${flags.length}`);
flags.sort((a, b) => (a.type > b.type ? 1 : -1));
for (const f of flags) console.log(`  ${f.t.padEnd(6)} ${f.name.slice(0, 30).padEnd(31)} ${f.issues.join(' · ')}`);

if (!flags.length) { console.log('all within tolerance — no email'); process.exit(0); }   // SILENT when clean
if (!RESEND_API_KEY) { console.log('(no RESEND_API_KEY — console only)'); process.exit(0); }

const esc = s => String(s == null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rowsHTML = flags.map(f => `<tr>
  <td style="padding:7px 10px"><a href="${SITE}/stock/${f.slug}/" style="color:#2647DD;text-decoration:none">${esc(f.name)}</a> <span style="color:#8a8378">${esc(f.t)}</span></td>
  <td style="padding:7px 10px;color:#1c2430">${f.issues.map(esc).join('<br>')}</td></tr>`).join('');

const html = `<div style="max-width:640px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2430;background:#faf8f4;padding:22px">
  <div style="font-size:13px;color:#8a8378;letter-spacing:.06em;text-transform:uppercase">StockKaki · data accuracy</div>
  <h1 style="font-family:Georgia,serif;font-size:22px;margin:2px 0 4px">⚠️ ${flags.length} ${flags.length === 1 ? 'counter' : 'counters'} to review</h1>
  <p style="font-size:13px;color:#6b6459;margin:0 0 12px">Cross-checked ${checked} dividend/foreign counters against Yahoo Finance (independent of our SGX feed). These drifted past tolerance — a real data issue, a special dividend, or a stale build. Everything else matched.</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e3dc;border-radius:8px">
    <tr style="color:#8a8378;font-size:10px;text-transform:uppercase;letter-spacing:.05em"><td style="padding:6px 10px">Stock</td><td style="padding:6px 10px">Issue (ours vs Yahoo)</td></tr>
    ${rowsHTML}
  </table>
  <p style="font-size:11px;color:#a29b8f;margin-top:16px">Weekly · tolerances: yield ≥${YIELD_GAP}pp, price ≥${PRICE_GAP}%, missing-payer ≥${MISSING_MIN}%. Yahoo is a second opinion, not gospel — a flag means "look", not "definitely wrong".</p>
</div>`;

const rr = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: FROM, to: TO, subject: `⚠️ StockKaki data check — ${flags.length} to review`, html }) });
const jr = await rr.json();
console.log(jr.id ? `emailed ${TO} (${jr.id})` : `email FAILED: ${JSON.stringify(jr)}`);
