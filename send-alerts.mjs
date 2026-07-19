#!/usr/bin/env node
/*
 * StockKaki weekly dividend digest. Runs in the daily GitHub Action AFTER build.
 * Emails confirmed subscribers the SGX dividends going ex in the next 7 days.
 * Phase 1 = a weekly digest (sends Mondays, Singapore time). No-ops safely if
 * secrets are missing (so it's harmless before the backend is configured).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
 */
import { readFileSync } from 'node:fs';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
  console.log('alerts: secrets not set — skipping (backend not configured yet).');
  process.exit(0);
}

const SITE = 'https://stockkaki.com';
const now = new Date(Date.now() + 8 * 3600 * 1000);      // Singapore time
if (now.getUTCDay() !== 1) { console.log('alerts: not Monday (SGT) — weekly digest skipped.'); process.exit(0); }

let up;
try { up = JSON.parse(readFileSync(new URL('./dist/api/upcoming.json', import.meta.url), 'utf8')); }
catch { console.log('alerts: dist/api/upcoming.json missing — run build first.'); process.exit(0); }

const today = now.toISOString().slice(0, 10);
const in7 = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
const soon = up.filter((d) => d.ex >= today && d.ex <= in7);
if (!soon.length) { console.log('alerts: no ex-dates in next 7 days.'); process.exit(0); }

const res = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?confirmed=eq.true&select=email,unsub_token`, {
  headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
});
const subs = await res.json();
if (!Array.isArray(subs) || !subs.length) { console.log('alerts: no confirmed subscribers.'); process.exit(0); }

const rows = soon.map((d) => `<tr>
  <td style="padding:9px 10px;border-bottom:1px solid #EBE0D2"><b>${d.name}</b>${d.ticker ? ` <span style="color:#8C7A69;font-family:monospace">${d.ticker}</span>` : ''}</td>
  <td style="padding:9px 10px;border-bottom:1px solid #EBE0D2;text-align:right;font-family:monospace">${d.amt}</td>
  <td style="padding:9px 10px;border-bottom:1px solid #EBE0D2;text-align:right;font-family:monospace">${d.ex}</td>
</tr>`).join('');

const digest = (unsub) => `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#3A2A20">
  <h2 style="font-family:Georgia,serif">Dividends going ex this week 🦁</h2>
  <p style="color:#8C7A69">${soon.length} SGX counters go ex-dividend in the next 7 days. Buy <b>before</b> the ex-date to be entitled.</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr>
      <th style="text-align:left;padding:8px 10px;color:#8C7A69;font-size:11px;text-transform:uppercase">Company</th>
      <th style="text-align:right;padding:8px 10px;color:#8C7A69;font-size:11px;text-transform:uppercase">Amount</th>
      <th style="text-align:right;padding:8px 10px;color:#8C7A69;font-size:11px;text-transform:uppercase">Ex-date</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="margin-top:18px"><a href="${SITE}/" style="color:#B45F27;font-weight:600">See all upcoming dividends &rarr;</a></p>
  <p style="color:#B0A396;font-size:12px;border-top:1px solid #EBE0D2;padding-top:12px;margin-top:20px">You subscribed at stockkaki.com. <a href="${unsub}" style="color:#8C7A69">Unsubscribe</a>. Information only, not financial advice.</p>
</div>`;

let sent = 0;
for (const s of subs) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'StockKaki <alerts@stockkaki.com>', to: s.email,
      subject: `📅 ${soon.length} SGX dividends going ex this week`,
      html: digest(`${SITE}/unsubscribe/?t=${s.unsub_token}`),
    }),
  });
  if (r.ok) sent++; else console.log('send fail', s.email, await r.text());
}
console.log(`alerts: sent ${sent}/${subs.length} weekly digests.`);
