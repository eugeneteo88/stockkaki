// StockKaki — Supabase Edge Function: subscribe
// Inserts an (unconfirmed) subscriber and emails them a confirmation link via Resend.
//
// Deploy:  supabase functions deploy subscribe --no-verify-jwt
// Secret:  supabase secrets set RESEND_API_KEY=re_xxx
//          (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SITE = 'https://stockkaki.com';
const FROM = 'StockKaki <alerts@stockkaki.com>';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { email } = await req.json();
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return j({ error: 'Enter a valid email.' }, 400);

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await sb.from('subscribers')
      .upsert({ email: e }, { onConflict: 'email', ignoreDuplicates: false })
      .select('confirmed, confirm_token').single();
    if (error) throw error;
    if (data.confirmed) return j({ ok: true, already: true });

    const link = `${SITE}/confirm/?t=${data.confirm_token}`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM, to: e, subject: 'Confirm your StockKaki dividend alerts',
        html: `<div style="font-family:Inter,Arial,sans-serif;max-width:460px;margin:0 auto;color:#3A2A20">
          <h2 style="font-family:Georgia,serif">One tap to confirm 🦁</h2>
          <p>You asked for StockKaki dividend &amp; ex-date alerts. Confirm your email to start:</p>
          <p><a href="${link}" style="background:#E07A3B;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600;display:inline-block">Confirm my alerts</a></p>
          <p style="color:#8C7A69;font-size:13px">If you didn't request this, just ignore this email — nothing happens.</p>
        </div>`,
      }),
    });
    if (!r.ok) throw new Error('email send failed: ' + (await r.text()));
    return j({ ok: true });
  } catch (err) {
    return j({ error: String(err) }, 500);
  }
});

function j(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
}
