#!/usr/bin/env node
/*
 * StockKaki alert delivery — runs in the GitHub Action after build.
 * Phase 2a: EX-DATE REMINDERS. Emails each user the watchlist stocks going ex-dividend
 * in ~3 days, respecting their saved alert preferences (user_metadata.alerts).
 *
 * Safety: fire-once (ex-date exactly 3 days out) + morning-run only + opt-in guards.
 *   DRY_RUN=1        → log who would be emailed, send nothing
 *   ALERTS_TEST=you@ → send ONE sample reminder to that address (uses soonest ex-dates), ignore matching
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
 */
import { readFileSync } from 'node:fs';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY } = process.env;
const DRY = process.env.DRY_RUN === '1';
const TEST_TO = (process.env.ALERTS_TEST || '').trim();
const SITE = 'https://stockkaki.com';
const FROM = 'StockKaki <alerts@stockkaki.com>';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
  console.log('alerts: secrets not set — skipping (backend not configured).'); process.exit(0);
}

let up;
try { up = JSON.parse(readFileSync(new URL('./dist/api/upcoming.json', import.meta.url), 'utf8')); }
catch { console.log('alerts: dist/api/upcoming.json missing — run build first.'); process.exit(0); }

const sgt = new Date(Date.now() + 8 * 3600 * 1000);                 // Singapore time
const today = sgt.toISOString().slice(0, 10);
const dayISO = (n) => new Date(sgt.getTime() + n * 86400000).toISOString().slice(0, 10);
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pretty = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${+d} ${MON[+m - 1]} ${y}`; };

function alertEmail(stocks, lead) {
  const rows = stocks.map(s => `<tr>
    <td style="padding:11px 4px;border-bottom:1px solid #EBE0D2"><b style="color:#3A2A20">${s.name}</b>${s.ticker ? ` <span style="color:#8C7A69;font-family:monospace;font-size:12px">${s.ticker}</span>` : ''}</td>
    <td style="padding:11px 4px;border-bottom:1px solid #EBE0D2;text-align:right;font-family:monospace;color:#B45F27;font-weight:700;white-space:nowrap">${s.amt}</td>
    <td style="padding:11px 4px;border-bottom:1px solid #EBE0D2;text-align:right;font-family:monospace;color:#3A2A20;white-space:nowrap">${pretty(s.ex)}</td>
  </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF6EE;padding:32px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#FFFDF9;border:1px solid #EBE0D2;border-radius:18px;overflow:hidden">
      <tr><td style="padding:30px 32px 4px"><table cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="${SITE}/apple-touch-icon.png" width="34" height="34" alt="" style="border-radius:50%;display:block"></td><td style="vertical-align:middle;padding-left:10px;font-size:19px;font-weight:700;color:#3A2A20">StockKaki</td></tr></table></td></tr>
      <tr><td style="padding:20px 32px 0"><h1 style="margin:0 0 8px;font-size:21px;color:#3A2A20;font-weight:700">Ex-dividend coming up on your watchlist</h1><p style="margin:0 0 18px;font-size:14.5px;line-height:1.6;color:#8C7A69">${lead}</p></td></tr>
      <tr><td style="padding:0 32px"><table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px"><thead><tr><th style="text-align:left;padding:0 4px 6px;color:#8C7A69;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Stock</th><th style="text-align:right;padding:0 4px 6px;color:#8C7A69;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Dividend</th><th style="text-align:right;padding:0 4px 6px;color:#8C7A69;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Ex-date</th></tr></thead><tbody>${rows}</tbody></table></td></tr>
      <tr><td align="center" style="padding:22px 32px 6px"><a href="${SITE}/account/" style="display:inline-block;background:#E07A3B;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 30px;border-radius:12px">View your watchlist &rarr;</a></td></tr>
      <tr><td style="padding:22px 32px 28px"><hr style="border:0;border-top:1px solid #EBE0D2;margin:0 0 14px"><p style="margin:0;font-size:12px;line-height:1.6;color:#8C7A69">You're getting this because these are on your StockKaki watchlist. <a href="${SITE}/account/" style="color:#B45F27">Manage your alerts</a>. Information only, not financial advice — you must own shares before the ex-date to be entitled.</p></td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#A08D79">© 2026 StockKaki · The clean way to track Singapore dividends</p>
  </td></tr></table>`;
}

async function send(to, subject, html) {
  if (DRY) { console.log(`  [dry-run] would email ${to} — "${subject}"`); return true; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!r.ok) { console.log('  send FAIL', to, await r.text()); return false; }
  return true;
}

// ---- TEST mode: sample email to one address, using the soonest upcoming ex-dates ----
if (TEST_TO) {
  const sample = up.filter(d => d.ex >= today).slice(0, 5);
  if (!sample.length) { console.log('alerts test: no upcoming ex-dates to sample.'); process.exit(0); }
  await send(TEST_TO, 'Ex-dividend coming up on your watchlist (sample)', alertEmail(sample,
    `This is a <b style="color:#3A2A20">sample</b> reminder so you can see the design. In real alerts, this lists the stocks on <i>your</i> watchlist going ex-dividend in ~3 days.`));
  console.log(`alerts test: sample ${DRY ? 'would be ' : ''}sent to ${TEST_TO}.`); process.exit(0);
}

// ---- LIVE: morning run only (fire once/day), unless dry-run ----
if (!DRY && sgt.getUTCHours() >= 12) {
  console.log(`alerts: not the morning run (SGT ${sgt.getUTCHours()}h) — skipping to avoid duplicate reminders.`); process.exit(0);
}

const target = dayISO(3);                                          // ex-dates exactly 3 days out → fires once
const due = up.filter(d => d.ex === target);
if (!due.length) { console.log(`alerts: no ex-dates on ${target} (3 days out).`); process.exit(0); }
const bySlug = Object.fromEntries(due.map(d => [d.slug, d]));

const q = (path) => fetch(`${SUPABASE_URL}${path}`, { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }).then(r => r.json());
const wl = await q('/rest/v1/watchlist?select=user_id,slug');
if (!Array.isArray(wl) || !wl.length) { console.log('alerts: no watchlist rows.'); process.exit(0); }
const uJson = await q('/auth/v1/admin/users?per_page=1000');
const list = Array.isArray(uJson) ? uJson : (uJson.users || []);
const users = Object.fromEntries(list.map(u => [u.id, { email: u.email, meta: u.user_metadata || {} }]));

const byUser = {};
for (const w of wl) { if (bySlug[w.slug]) (byUser[w.user_id] = byUser[w.user_id] || []).push(bySlug[w.slug]); }

let sent = 0, skipped = 0;
for (const uid of Object.keys(byUser)) {
  const u = users[uid]; if (!u || !u.email) continue;
  const a = u.meta.alerts || {};
  if (a.master === false || a.exdate === false) { skipped++; console.log(`  skip ${u.email} (ex-date alerts off)`); continue; }   // default ON unless explicitly off
  const stocks = byUser[uid];
  const lead = `${stocks.length} stock${stocks.length > 1 ? 's' : ''} on your watchlist go ex-dividend in about 3 days (${pretty(target)}). You must own the shares <b style="color:#3A2A20">before</b> the ex-date to receive the payout.`;
  if (await send(u.email, `📅 ${stocks.length} watchlist dividend${stocks.length > 1 ? 's' : ''} going ex in 3 days`, alertEmail(stocks, lead))) sent++;
}
console.log(`alerts: ex-date reminders ${DRY ? '(dry-run) ' : ''}— sent ${sent}, skipped ${skipped} (opted out), for ex-date ${target}.`);
