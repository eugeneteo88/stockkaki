// StockKaki reader-feedback alert — emails Eugene the MOMENT (within the hour)
// new feedback lands. Silent when there's nothing: no feedback → no email.
//
//   node feedback-alert.mjs
//
// Runs hourly (feedback-alert.yml). Looks back a little longer than the cron
// interval so a late/best-effort cron never misses one; the small overlap can,
// very rarely, resend a borderline item — harmless for this volume. Reads the
// same Supabase `feedback` table the weekly report used to bundle; feedback is
// now its own channel, separate from the Sunday performance email.
import { readFileSync } from 'node:fs';

const SB_URL = 'https://limizehmxnaaqndacynm.supabase.co';
const SB_SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const { RESEND_API_KEY } = process.env;
const TO = process.env.REPORT_TO || 'eugeneteo1988@gmail.com';
const FROM = process.env.REPORT_FROM || 'StockKaki <alerts@stockkaki.com>';
const LOOKBACK_MIN = Number(process.env.LOOKBACK_MIN || 75);

if (!SB_SR) { console.log('no SUPABASE_SERVICE_ROLE_KEY — cannot check feedback'); process.exit(0); }

const since = new Date(Date.now() - LOOKBACK_MIN * 60 * 1000).toISOString();
let fb = [];
try {
  const r = await fetch(`${SB_URL}/rest/v1/feedback?created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&select=*`,
    { headers: { apikey: SB_SR, Authorization: 'Bearer ' + SB_SR } });
  if (!r.ok) { console.log('feedback fetch HTTP ' + r.status); process.exit(0); }
  fb = await r.json();
} catch (e) { console.log('feedback fetch failed:', e.message); process.exit(0); }

console.log(`feedback in last ${LOOKBACK_MIN}min: ${fb.length}`);
if (!fb.length) { console.log('nothing new — no email sent'); process.exit(0); }  // SILENT when empty

if (!RESEND_API_KEY) { console.log('(no RESEND_API_KEY — console only)'); process.exit(0); }

const esc = s => String(s == null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sgt = iso => { try { return new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', hour12: true, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };

const items = fb.map(f => {
  const meta = [f.page && `on <b>${esc(f.page)}</b>`, f.email && `from ${esc(f.email)}`, f.created_at && sgt(f.created_at)].filter(Boolean).join(' · ');
  const rating = f.rating != null ? ` <span style="color:#8a8378">(${esc(f.rating)}★)</span>` : '';
  return `<div style="border-top:1px solid #f0ede6;padding:11px 0">
      <div style="font-size:15px;color:#1c2430;white-space:pre-wrap;line-height:1.5">${esc(f.message) || '<i style="color:#8a8378">(no message)</i>'}${rating}</div>
      <div style="font-size:12px;color:#8a8378;margin-top:5px">${meta}</div>
    </div>`;
}).join('');

const html = `<div style="max-width:560px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2430;background:#faf8f4;padding:22px">
  <div style="font-size:13px;color:#8a8378;letter-spacing:.06em;text-transform:uppercase">StockKaki · reader feedback</div>
  <h1 style="font-family:Georgia,serif;font-size:22px;margin:2px 0 4px">💬 ${fb.length} new ${fb.length === 1 ? 'message' : 'messages'}</h1>
  <p style="font-size:13px;color:#6b6459;margin:0 0 8px">Someone just left feedback on StockKaki.</p>
  <div style="background:#fff;border:1px solid #e6e3dc;border-left:4px solid #2647DD;border-radius:10px;padding:6px 16px 12px">${items}</div>
  <p style="font-size:11px;color:#a29b8f;margin-top:18px">Near-instant alert · checked hourly. Weekly performance is a separate Sunday email.</p>
</div>`;

const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: FROM, to: TO, subject: `💬 New StockKaki feedback (${fb.length})`, html }) });
const jr = await r.json();
console.log(jr.id ? `emailed ${TO} (${jr.id})` : `email FAILED: ${JSON.stringify(jr)}`);
