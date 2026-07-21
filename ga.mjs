// StockKaki — Google Analytics 4 reporter (dependency-free).
//   node ga.mjs            → default snapshot (today, 7d, 28d, top pages, sources)
// Reads the service-account key from .ga-key.json (git-ignored). Property via GA_PROPERTY env or the default below.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const KEY = JSON.parse(readFileSync(new URL('./.ga-key.json', import.meta.url), 'utf8'));
const PROPERTY = process.env.GA_PROPERTY || '546290038';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: KEY.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: KEY.token_uri, iat: now, exp: now + 3600 }));
  const s = createSign('RSA-SHA256'); s.update(head + '.' + claim); s.end();
  const jwt = head + '.' + claim + '.' + b64url(s.sign(KEY.private_key));
  const r = await fetch(KEY.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('auth failed: ' + JSON.stringify(j));
  return j.access_token;
}
const TOKEN = await accessToken();
async function api(method, body) {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:${method}`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j;
}
const m = (j, i = 0) => (j.rows && j.rows[0] ? +j.rows[0].metricValues[i].value : 0);
const rows = (j) => (j.rows || []).map(r => ({ dim: r.dimensionValues.map(d => d.value), val: r.metricValues.map(v => +v.value) }));

// live users right now
const live = await api('runRealtimeReport', { metrics: [{ name: 'activeUsers' }] });
// today / 7d / 28d totals
const mk = (start) => api('runReport', { dateRanges: [{ startDate: start, endDate: 'today' }], metrics: [{ name: 'totalUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }] });
const [today, d7, d28] = await Promise.all([mk('today'), mk('7daysAgo'), mk('28daysAgo')]);
// top pages (7d)
const pages = await api('runReport', { dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 8 });
// traffic sources (7d)
const src = await api('runReport', { dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }, { name: 'totalUsers' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 8 });

const line = '─'.repeat(46);
console.log('\n📊  StockKaki · Google Analytics\n' + line);
console.log(`🟢 Right now (live):   ${m(live)} active user${m(live) === 1 ? '' : 's'}`);
console.log(line);
console.log(`             users   sessions   pageviews`);
console.log(`Today        ${String(m(today)).padStart(5)}   ${String(m(today, 1)).padStart(8)}   ${String(m(today, 2)).padStart(9)}`);
console.log(`Last 7 days  ${String(m(d7)).padStart(5)}   ${String(m(d7, 1)).padStart(8)}   ${String(m(d7, 2)).padStart(9)}`);
console.log(`Last 28 days ${String(m(d28)).padStart(5)}   ${String(m(d28, 1)).padStart(8)}   ${String(m(d28, 2)).padStart(9)}`);
console.log(line);
console.log('Top pages (7d):');
const P = rows(pages); if (!P.length) console.log('  (no data yet)'); else P.forEach(p => console.log(`  ${String(p.val[0]).padStart(4)}  ${p.dim[0]}`));
console.log(line);
console.log('Where visitors came from (7d):');
const S = rows(src); if (!S.length) console.log('  (no data yet)'); else S.forEach(s => console.log(`  ${String(s.val[0]).padStart(4)} sessions  ${s.dim[0]}`));
console.log(line + '\n');
