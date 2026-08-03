#!/usr/bin/env node
/*
 * StockKaki alert delivery — runs in the GitHub Action after build.
 *   1) EX-DATE REMINDERS  — watchlist stocks going ex-dividend in ~3 days (morning run, fires once)
 *   2) DIVIDEND CHANGES   — a watchlist stock declares/updates a dividend (snapshot diff vs data/alert-state.json)
 *   3) NEW SSB            — a new monthly Savings Bond issue appears (opt-in only)
 *   4) WEEKLY DIGEST      — Sunday morning: the week's ex-dates on the user's watchlist ("dividend week ahead")
 * Respects saved preferences (user_metadata.alerts: master / exdate / divchange / ssb / weekly).
 *   DRY_RUN=1        → log only, send nothing, don't touch the snapshot
 *   ALERTS_TEST=you@ → send ONE sample email to that address
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY } = process.env;
const DRY = process.env.DRY_RUN === '1';
const TEST_TO = (process.env.ALERTS_TEST || '').trim();
const SITE = 'https://stockkaki.com';
const FROM = 'StockKaki <alerts@stockkaki.com>';
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) { console.log('alerts: secrets not set — skipping.'); process.exit(0); }

const readJSON = (rel, def) => { try { return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')); } catch { return def; } };
const up = readJSON('./dist/api/upcoming.json', null);
if (!up) { console.log('alerts: dist/api/upcoming.json missing — run build first.'); process.exit(0); }
const ssbNow = readJSON('./dist/api/ssb.json', null);
const state = readJSON('./data/alert-state.json', { divs: {}, ssb: null });
let exdateLast = state.exdateLast || null;   // guard: ex-date reminders + weekly digest each fire once per day,
let weeklyLast = state.weeklyLast || null;   // even though several morning cron runs pass the "morning" check.

const sgt = new Date(Date.now() + 8 * 3600 * 1000);
const today = sgt.toISOString().slice(0, 10);
const dayISO = (n) => new Date(sgt.getTime() + n * 86400000).toISOString().slice(0, 10);
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pretty = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${+d} ${MON[+m - 1]} ${y}`; };

function emailShell(heading, lead, body, ctaText, ctaHref) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FB;padding:32px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#FFFFFF;border:1px solid #E7E9F0;border-radius:18px;overflow:hidden">
      <tr><td style="padding:30px 32px 4px"><table cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle"><img src="${SITE}/apple-touch-icon.png" width="34" height="34" alt="" style="border-radius:50%;display:block"></td><td style="vertical-align:middle;padding-left:10px;font-size:19px;font-weight:700;color:#0F1319">StockKaki</td></tr></table></td></tr>
      <tr><td style="padding:20px 32px 0"><h1 style="margin:0 0 8px;font-size:21px;color:#0F1319;font-weight:700">${heading}</h1><p style="margin:0 0 18px;font-size:14.5px;line-height:1.6;color:#5B6472">${lead}</p></td></tr>
      <tr><td style="padding:0 32px">${body}</td></tr>
      <tr><td align="center" style="padding:22px 32px 6px"><a href="${ctaHref}" style="display:inline-block;background:#2647DD;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 30px;border-radius:12px">${ctaText}</a></td></tr>
      <tr><td style="padding:22px 32px 28px"><hr style="border:0;border-top:1px solid #E7E9F0;margin:0 0 14px"><p style="margin:0;font-size:12px;line-height:1.6;color:#5B6472">You're getting this from your StockKaki alert preferences. <a href="${SITE}/account/" style="color:#1E3AB8">Manage your alerts</a>. Information only, not financial advice.</p></td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#8A909C">© 2026 StockKaki · The clean way to track Singapore dividends</p>
  </td></tr></table>`;
}
function divTable(stocks) {
  const rows = stocks.map(s => `<tr>
    <td style="padding:11px 4px;border-bottom:1px solid #E7E9F0"><b style="color:#0F1319">${s.name}</b>${s.ticker ? ` <span style="color:#5B6472;font-family:monospace;font-size:12px">${s.ticker}</span>` : ''}</td>
    <td style="padding:11px 4px;border-bottom:1px solid #E7E9F0;text-align:right;font-family:monospace;color:#1E3AB8;font-weight:700;white-space:nowrap">${s.amt}</td>
    <td style="padding:11px 4px;border-bottom:1px solid #E7E9F0;text-align:right;font-family:monospace;color:#0F1319;white-space:nowrap">${pretty(s.ex)}</td>
  </tr>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px"><thead><tr><th style="text-align:left;padding:0 4px 6px;color:#5B6472;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Stock</th><th style="text-align:right;padding:0 4px 6px;color:#5B6472;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Dividend</th><th style="text-align:right;padding:0 4px 6px;color:#5B6472;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Ex-date</th></tr></thead><tbody>${rows}</tbody></table>`;
}
async function send(to, subject, html) {
  if (DRY) { console.log(`  [dry-run] would email ${to} — "${subject}"`); return true; }
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: FROM, to, subject, html }) });
  if (!r.ok) { console.log('  send FAIL', to, await r.text()); return false; }
  return true;
}

// ---- TEST mode ----
if (TEST_TO) {
  const sample = up.filter(d => d.ex >= today).slice(0, 5);
  await send(TEST_TO, 'StockKaki alerts — sample', emailShell('Ex-dividend coming up on your watchlist',
    `This is a <b style="color:#0F1319">sample</b>. Real alerts list the stocks on <i>your</i> watchlist going ex-dividend in ~3 days.`, divTable(sample), 'View your watchlist →', `${SITE}/account/`));
  console.log(`alerts test: sample ${DRY ? 'would be ' : ''}sent to ${TEST_TO}.`); process.exit(0);
}

// ---- shared data ----
const q = (path) => fetch(`${SUPABASE_URL}${path}`, { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }).then(r => r.json());
const wl = await q('/rest/v1/watchlist?select=user_id,slug');
const uJson = await q('/auth/v1/admin/users?per_page=1000');
const list = Array.isArray(uJson) ? uJson : (uJson.users || []);
const users = Object.fromEntries(list.map(u => [u.id, { email: u.email, meta: u.user_metadata || {} }]));
const watchers = {}; if (Array.isArray(wl)) for (const w of wl) (watchers[w.slug] = watchers[w.slug] || []).push(w.user_id);
const upBySlug = {}; for (const d of up) (upBySlug[d.slug] = upBySlug[d.slug] || []).push(d);
const allowed = (uid, key, defOn) => { const u = users[uid]; if (!u) return false; const a = u.meta.alerts || {}; if (a.master === false) return false; const v = a[key]; return v === undefined ? defOn : v !== false; };

// notify watchers of a {slug: [dividend entries]} set
async function notify(slugEntries, key, defOn, subjectFn, headingFn, leadFn) {
  const perUser = {};
  for (const slug of Object.keys(slugEntries)) for (const uid of (watchers[slug] || [])) {
    if (!allowed(uid, key, defOn)) continue; (perUser[uid] = perUser[uid] || []).push(...slugEntries[slug]);
  }
  let sent = 0;
  for (const uid of Object.keys(perUser)) {
    const u = users[uid]; if (!u || !u.email) continue; const s = perUser[uid];
    if (await send(u.email, subjectFn(s), emailShell(headingFn(s), leadFn(s), divTable(s), 'View your watchlist →', `${SITE}/account/`))) sent++;
  }
  return sent;
}

let total = 0;
const todaySigs = {}; for (const d of up) (todaySigs[d.slug] = todaySigs[d.slug] || []).push(d.ex + '|' + d.amt);

// 1) EX-DATE REMINDERS — morning only, exactly 3 days out, once per day
if (DRY || (sgt.getUTCHours() < 12 && exdateLast !== today)) {
  const target = dayISO(3);
  const se = {}; for (const d of up) if (d.ex === target) (se[d.slug] = se[d.slug] || []).push(d);
  if (Object.keys(se).length) {
    const n = await notify(se, 'exdate', true,
      (s) => `📅 ${s.length} watchlist dividend${s.length > 1 ? 's' : ''} going ex in 3 days`,
      () => 'Ex-dividend coming up on your watchlist',
      (s) => `${s.length} stock${s.length > 1 ? 's' : ''} on your watchlist go ex-dividend in about 3 days (${pretty(target)}). Own the shares <b style="color:#0F1319">before</b> the ex-date to be entitled.`);
    total += n; console.log(`alerts: ex-date reminders — sent ${n} for ${target}.`);
  } else console.log(`alerts: no ex-dates 3 days out (${target}).`);
  if (!DRY) exdateLast = today;
} else console.log(`alerts: ex-date reminders skipped (not morning, or already ran today).`);

// 2) DIVIDEND CHANGES — new/updated upcoming dividend vs snapshot (baseline on first run, no emails)
if (state.divs && Object.keys(state.divs).length) {
  const changed = {};
  for (const slug of Object.keys(todaySigs)) {
    const prev = state.divs[slug] || [];
    const fresh = todaySigs[slug].filter(sig => !prev.includes(sig));
    const entries = fresh.length ? (upBySlug[slug] || []).filter(d => fresh.includes(d.ex + '|' + d.amt)) : [];
    if (entries.length) changed[slug] = entries;
  }
  if (Object.keys(changed).length) {
    const n = await notify(changed, 'divchange', true,
      () => `💰 A dividend update on your watchlist`,
      () => 'A dividend update on your watchlist',
      () => `A stock on your watchlist just declared or updated a dividend. Here's what's new:`);
    total += n; console.log(`alerts: dividend-change — sent ${n} (${Object.keys(changed).length} counter(s) changed).`);
  } else console.log('alerts: no dividend changes.');
} else console.log('alerts: no dividend snapshot yet — baselining (no change emails this run).');

// 3) NEW SSB — issue code changed (opt-in only, default off)
if (ssbNow && ssbNow.code) {
  if (state.ssb && ssbNow.code !== state.ssb) {
    const body = `<table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="padding:12px 14px;background:#EEF1FE;border-radius:12px;text-align:center"><div style="font-size:11px;color:#5B6472;text-transform:uppercase;letter-spacing:.04em">1st-year rate</div><div style="font-size:26px;font-weight:700;color:#0F1319;font-family:monospace">${(+ssbNow.y1).toFixed(2)}%</div></td>
      <td style="width:12px"></td>
      <td style="padding:12px 14px;background:#EEF1FE;border-radius:12px;text-align:center"><div style="font-size:11px;color:#5B6472;text-transform:uppercase;letter-spacing:.04em">10-year avg</div><div style="font-size:26px;font-weight:700;color:#1E3AB8;font-family:monospace">${(+ssbNow.y10).toFixed(2)}%</div></td>
    </tr></table><p style="font-size:13px;color:#5B6472;margin:14px 0 0">Issue ${ssbNow.code}${ssbNow.applyFmt ? ` · apply by <b style="color:#0F1319">${ssbNow.applyFmt}</b>` : ''}. From S$500, redeem any month with no penalty.</p>`;
    let sent = 0;
    for (const uid of Object.keys(users)) {
      if (!allowed(uid, 'ssb', false)) continue; const u = users[uid]; if (!u.email) continue;
      if (await send(u.email, `🛡️ New Singapore Savings Bond — ${(+ssbNow.y1).toFixed(2)}% → ${(+ssbNow.y10).toFixed(2)}%`,
        emailShell('This month’s Savings Bond is out', 'A new SSB issue is open for application. Here are its rates:', body, 'See SSB details →', `${SITE}/ssb/`))) sent++;
    }
    total += sent; console.log(`alerts: new-SSB (${ssbNow.code}) — sent ${sent}.`);
  } else console.log(`alerts: SSB unchanged (${ssbNow.code}).`);
}

// 4) WEEKLY DIGEST — Sunday morning: this week's ex-dates on each user's watchlist ("dividend week ahead")
if (DRY || (sgt.getUTCDay() === 0 && sgt.getUTCHours() < 12 && weeklyLast !== today)) {
  const weekEnd = dayISO(7);
  const weekBySlug = {};
  for (const d of up) if (d.ex >= today && d.ex <= weekEnd) (weekBySlug[d.slug] = weekBySlug[d.slug] || []).push(d);
  const perUser = {};
  for (const slug of Object.keys(weekBySlug)) for (const uid of (watchers[slug] || [])) {
    if (!allowed(uid, 'weekly', true)) continue; (perUser[uid] = perUser[uid] || []).push(...weekBySlug[slug]);
  }
  let wsent = 0;
  for (const uid of Object.keys(perUser)) {
    const u = users[uid]; if (!u || !u.email) continue;
    const s = perUser[uid].sort((a, b) => a.ex < b.ex ? -1 : 1);
    if (await send(u.email, `📅 Your dividend week ahead — ${s.length} ex-date${s.length > 1 ? 's' : ''}`,
      emailShell('Your dividend week ahead',
        `${s.length} stock${s.length > 1 ? 's' : ''} on your watchlist go ex-dividend this week (to ${pretty(weekEnd)}). Own the shares <b style="color:#0F1319">before</b> each ex-date to be entitled.`,
        divTable(s), 'View your watchlist →', `${SITE}/account/`))) wsent++;
  }
  total += wsent; console.log(`alerts: weekly digest — sent ${wsent} (week to ${weekEnd}).`);
  if (!DRY) weeklyLast = today;
} else console.log(`alerts: weekly digest skipped (not Sunday morning, or already ran today).`);

// persist snapshot for next run (skip on dry-run to keep the baseline intact)
if (!DRY) {
  try { mkdirSync(new URL('./data/', import.meta.url), { recursive: true }); writeFileSync(new URL('./data/alert-state.json', import.meta.url), JSON.stringify({ divs: todaySigs, ssb: ssbNow ? ssbNow.code : state.ssb, exdateLast, weeklyLast })); }
  catch (e) { console.log('alerts: state save failed', e.message); }
}
console.log(`alerts: done — ${total} email(s) ${DRY ? '(dry-run)' : 'sent'}.`);
