// StockKaki daily growth report — GSC indexing/queries + GA organic.
//   node daily-report.mjs            → print to console
//   (with RESEND_API_KEY set)        → also email REPORT_TO (default eugeneteo1988@gmail.com)
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
const KEY = JSON.parse(readFileSync(new URL('./.ga-key.json', import.meta.url), 'utf8'));
const GA_PROPERTY = '546290038';
const SITE = 'sc-domain:stockkaki.com';
const { RESEND_API_KEY, REPORT_TO } = process.env;
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

async function token(scope){
  const now = Math.floor(Date.now()/1000);
  const head = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claim = b64url(JSON.stringify({iss:KEY.client_email,scope,aud:KEY.token_uri,iat:now,exp:now+3600}));
  const s = createSign('RSA-SHA256'); s.update(head+'.'+claim); s.end();
  const jwt = head+'.'+claim+'.'+b64url(s.sign(KEY.private_key));
  const tr = await (await fetch(KEY.token_uri,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt})})).json();
  if(!tr.access_token) throw new Error('token: '+JSON.stringify(tr));
  return tr.access_token;
}
const iso = d => d.toISOString().slice(0,10);
const daysAgo = n => { const d=new Date(); d.setUTCDate(d.getUTCDate()-n); return iso(d); };
const n = x => Number(x||0);
// AI answer-engine referrer → friendly name (AEO)
const AI_RE = 'chatgpt|openai|perplexity|gemini|copilot|claude|you\\.com|poe\\.com|edgeservices|bard|mistral|deepseek|grok';
const AI_LABEL = s => { s=(s||'').toLowerCase();
  if(s.includes('chatgpt')||s.includes('openai')) return 'ChatGPT';
  if(s.includes('perplexity')) return 'Perplexity';
  if(s.includes('gemini')||s.includes('bard')) return 'Gemini';
  if(s.includes('copilot')||s.includes('edgeservices')) return 'Copilot';
  if(s.includes('claude')) return 'Claude';
  if(s.includes('deepseek')) return 'DeepSeek';
  if(s.includes('grok')) return 'Grok';
  if(s.includes('you.com')) return 'You.com';
  if(s.includes('poe')) return 'Poe';
  if(s.includes('mistral')) return 'Mistral';
  return s; };

// ---------- Google Search Console ----------
const gscTok = await token('https://www.googleapis.com/auth/webmasters.readonly');
const gsc = async (body) => {
  const r = await (await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`,{method:'POST',headers:{Authorization:'Bearer '+gscTok,'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  if(r.error) throw new Error('gsc: '+r.error.message); return r.rows||[];
};
const START=daysAgo(28), END=daysAgo(1);
const tot   = (await gsc({startDate:START,endDate:END,dimensions:[],type:'web'}))[0]||{};
const cur7  = (await gsc({startDate:daysAgo(7), endDate:daysAgo(1), dimensions:[],type:'web'}))[0]||{};
const prev7 = (await gsc({startDate:daysAgo(14),endDate:daysAgo(8), dimensions:[],type:'web'}))[0]||{};
const pages   = await gsc({startDate:START,endDate:END,dimensions:['page'],type:'web',rowLimit:1000});
const queries = await gsc({startDate:START,endDate:END,dimensions:['query'],type:'web',rowLimit:1000});
const topQ = await gsc({startDate:START,endDate:END,dimensions:['query'],type:'web',rowLimit:8});
const topP = await gsc({startDate:START,endDate:END,dimensions:['page'],type:'web',rowLimit:8});
const daily = await gsc({startDate:daysAgo(14),endDate:END,dimensions:['date'],type:'web'});

// "Striking distance": queries ranking position 8–20 (bottom of page 1 / top of page 2) — the
// fastest wins. A page already this close just needs a nudge to reach page one. Ranked by
// impressions so the highest-traffic opportunities come first.
const striking = queries.filter(r => { const p=n(r.position); return p>=8 && p<=20; }).sort((a,b)=>n(b.impressions)-n(a.impressions)).slice(0,10);

let submitted='?';
try{
  const sm = await (await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/sitemaps`,{headers:{Authorization:'Bearer '+gscTok}})).json();
  submitted = (sm.sitemap||[]).reduce((a,s)=>a+(s.contents||[]).reduce((b,c)=>b+(+c.submitted||0),0),0) || (sm.sitemap?'listed':'none');
}catch{}

// ---------- Google Analytics (organic) ----------
const gaTok = await token('https://www.googleapis.com/auth/analytics.readonly');
const ga = async (body)=>{const r=await(await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA_PROPERTY}:runReport`,{method:'POST',headers:{Authorization:'Bearer '+gaTok,'Content-Type':'application/json'},body:JSON.stringify(body)})).json(); if(r.error)throw new Error('ga: '+r.error.message); return r.rows||[];};
const ORG={filter:{fieldName:'sessionDefaultChannelGroup',stringFilter:{value:'Organic Search'}}};
const orgDaily = await ga({dateRanges:[{startDate:'7daysAgo',endDate:'today'}],dimensions:[{name:'date'}],metrics:[{name:'sessions'}],dimensionFilter:ORG,orderBys:[{dimension:{dimensionName:'date'}}]});
const orgCur = await ga({dateRanges:[{startDate:'7daysAgo',endDate:'today'}],dimensions:[],metrics:[{name:'sessions'},{name:'totalUsers'}],dimensionFilter:ORG});
const orgPrev= await ga({dateRanges:[{startDate:'14daysAgo',endDate:'8daysAgo'}],dimensions:[],metrics:[{name:'sessions'}],dimensionFilter:ORG});
const orgCurS = orgCur[0]?n(orgCur[0].metricValues[0].value):0;
const orgCurU = orgCur[0]?n(orgCur[0].metricValues[1].value):0;
const orgPrevS= orgPrev[0]?n(orgPrev[0].metricValues[0].value):0;

// ---------- AEO: sessions arriving from AI answer engines ----------
const aiFilter={filter:{fieldName:'sessionSource',stringFilter:{matchType:'PARTIAL_REGEXP',value:AI_RE}}};
const aiRows = await ga({dateRanges:[{startDate:START,endDate:END}],dimensions:[{name:'sessionSource'}],metrics:[{name:'sessions'},{name:'totalUsers'}],dimensionFilter:aiFilter,orderBys:[{metric:{metricName:'sessions'},desc:true}]});
const aiEng={};
for(const r of aiRows){ const name=AI_LABEL(r.dimensionValues[0].value); if(!aiEng[name]) aiEng[name]={s:0,u:0}; aiEng[name].s+=n(r.metricValues[0].value); aiEng[name].u+=n(r.metricValues[1].value); }
const aiEngines = Object.entries(aiEng).map(([name,v])=>({name,sess:v.s,users:v.u})).sort((a,b)=>b.sess-a.sess);
const aiTotS = aiEngines.reduce((a,b)=>a+b.sess,0);
const aiTotU = aiEngines.reduce((a,b)=>a+b.users,0);
const aiC7 = await ga({dateRanges:[{startDate:daysAgo(7),endDate:END}],dimensions:[],metrics:[{name:'sessions'}],dimensionFilter:aiFilter});
const aiP7 = await ga({dateRanges:[{startDate:daysAgo(14),endDate:daysAgo(8)}],dimensions:[],metrics:[{name:'sessions'}],dimensionFilter:aiFilter});
const aiCur7S = aiC7[0]?n(aiC7[0].metricValues[0].value):0;
const aiPrev7S= aiP7[0]?n(aiP7[0].metricValues[0].value):0;

// ---------- traffic sources + UTM campaigns ----------
const chRows = await ga({dateRanges:[{startDate:START,endDate:END}],dimensions:[{name:'sessionDefaultChannelGroup'}],metrics:[{name:'sessions'},{name:'totalUsers'}],orderBys:[{metric:{metricName:'sessions'},desc:true}]});
const channels = chRows.map(r=>({name:r.dimensionValues[0].value||'(unknown)', s:n(r.metricValues[0].value), u:n(r.metricValues[1].value)}));
const campRows = await ga({dateRanges:[{startDate:START,endDate:END}],dimensions:[{name:'sessionCampaignName'},{name:'sessionSource'}],metrics:[{name:'sessions'},{name:'totalUsers'}],orderBys:[{metric:{metricName:'sessions'},desc:true}],limit:15});
const campaigns = campRows.map(r=>({camp:r.dimensionValues[0].value, src:r.dimensionValues[1].value, s:n(r.metricValues[0].value), u:n(r.metricValues[1].value)})).filter(c=>c.camp && !c.camp.startsWith('('));

// ---------- deltas ----------
const delta = (c,p)=>{ c=n(c);p=n(p); const d=c-p; const arrow=d>0?'▲':d<0?'▼':'–'; return `${arrow}${d>0?'+':''}${d}`; };
const impΔ = delta(cur7.impressions,prev7.impressions);
const clkΔ = delta(cur7.clicks,prev7.clicks);
const orgΔ = delta(orgCurS,orgPrevS);

// ---------- "what moved" — period-over-period (daily always · weekly on Sun · monthly on month-end) ----------
const gSeries = (await gsc({startDate:daysAgo(62),endDate:daysAgo(1),dimensions:['date'],type:'web'}))
  .map(r=>({d:r.keys[0], impr:n(r.impressions), clk:n(r.clicks), pos:n(r.position)}));
const aSeries = await ga({dateRanges:[{startDate:'62daysAgo',endDate:'yesterday'}],dimensions:[{name:'date'}],metrics:[{name:'sessions'},{name:'totalUsers'}],dimensionFilter:ORG,orderBys:[{dimension:{dimensionName:'date'}}]});
const byDate={};
for(const r of gSeries){ (byDate[r.d]=byDate[r.d]||{}).impr=r.impr; byDate[r.d].clk=r.clk; byDate[r.d].pos=r.pos; }
for(const r of aSeries){ const v=r.dimensionValues[0].value; const d=v.slice(0,4)+'-'+v.slice(4,6)+'-'+v.slice(6,8); (byDate[d]=byDate[d]||{}).sess=n(r.metricValues[0].value); byDate[d].users=n(r.metricValues[1].value); }
const rng=(from,to)=>{const a=[];for(let i=from;i>=to;i--)a.push(daysAgo(i));return a;};
const sumM=(ds,m)=>ds.reduce((a,d)=>a+((byDate[d]||{})[m]||0),0);
const wposM=ds=>{let i=0,ip=0;for(const d of ds){const o=byDate[d]||{};if(o.impr){i+=o.impr;ip+=o.impr*(o.pos||0);}}return i?ip/i:0;};
const sgtNow=new Date(Date.now()+288e5), sgtTom=new Date(Date.now()+288e5+864e5);
const isSun=sgtNow.getUTCDay()===0, isMonthEnd=sgtTom.getUTCMonth()!==sgtNow.getUTCMonth();
const fmtN=x=>Math.round(n(x)).toLocaleString(), fmtPos=x=>n(x).toFixed(1);
// GA metrics are real-time (good for daily); GSC search metrics lag ~2 days (only meaningful summed over a week+).
const METRICS={
  sess: {label:'Organic visits', m:'sess', better:'up',   fmt:fmtN},
  users:{label:'Users',          m:'users',better:'up',   fmt:fmtN},
  impr: {label:'Impressions',    m:'impr', better:'up',   fmt:fmtN},
  clk:  {label:'Clicks',         m:'clk',  better:'up',   fmt:fmtN},
  pos:  {label:'Avg position',   pos:true, better:'down', fmt:fmtPos, eps:0.05},
};
const moverStat=r=>{const cur=n(r.cur),prev=n(r.prev),dv=cur-prev;const flat=(r.pos&&(cur===0||prev===0))||(prev===0&&cur===0)||Math.abs(dv)<(r.eps||1e-9);const improved=r.better==='up'?dv>0:dv<0;const noBase=!flat&&prev===0;const pct=prev?Math.abs(Math.round((cur-prev)/prev*100)):null;return{...r,cur,prev,dv,flat,improved,noBase,pct};};
const build=(keys,cur,prev)=>keys.map(k=>{const d=METRICS[k];const c=d.pos?wposM(cur):sumM(cur,d.m);const p=d.pos?wposM(prev):sumM(prev,d.m);return moverStat({...d,cur:c,prev:p});});
const movDaily=build(['sess','users'],[daysAgo(1)],[daysAgo(2)]);                 // GA real-time → yesterday vs day before
const movWeek =build(['sess','users','impr','clk','pos'],rng(7,1),rng(14,8));      // full picture, search lag absorbed by the sum
const movMonth=build(['sess','users','impr','clk','pos'],rng(30,1),rng(60,31));

// ---------- overall WEEKLY verdict (this week vs last week) — the headline "are we up or down" ----------
const wUp = movWeek.filter(s=>!s.flat && s.improved).length;
const wDn = movWeek.filter(s=>!s.flat && !s.improved).length;
const verdict = wUp>wDn ? {tag:'Up week',   emoji:'📈', col:'#1a7f4b', bg:'#e7f4ec'}
             : wUp<wDn ? {tag:'Down week', emoji:'📉', col:'#b23a44', bg:'#f7e8ea'}
             :           {tag:'Flat week', emoji:'➡️', col:'#8a7a3a', bg:'#f4efe0'};
const vLine = movWeek.map(s=>`${s.label} ${s.flat?'—':(s.noBase?'▲ new':(s.improved?'▲':'▼')+s.pct+'%')}`).join('  ·  ');

// ---------- console ----------
console.log('════════ StockKaki growth · '+iso(new Date())+' ════════');
console.log(`\n📈 SEARCH (GSC 28d, ${START}→${END})`);
console.log(`   impressions ${n(tot.impressions)} · clicks ${n(tot.clicks)} · CTR ${(n(tot.ctr)*100).toFixed(1)}% · avg pos ${n(tot.position).toFixed(1)}`);
console.log(`   indexed & surfacing: ${pages.length} pages of ${submitted} submitted · ${queries.length} distinct queries`);
console.log(`   week-on-week: impressions ${impΔ} · clicks ${clkΔ} · organic ${orgΔ}`);
console.log('\n🔎 TOP QUERIES'); topQ.forEach(r=>console.log(`   ${String(n(r.impressions)).padStart(4)} imp pos ${n(r.position).toFixed(0).padStart(3)}  ${r.keys[0]}`));
console.log('\n📄 TOP PAGES');   topP.forEach(r=>console.log(`   ${String(n(r.impressions)).padStart(4)} imp  ${r.keys[0].replace('https://stockkaki.com','')}`));
console.log('\n🪜 STRIKING DISTANCE (pos 8–20 · one push from page 1)'); striking.length ? striking.forEach(r=>console.log(`   ${String(n(r.impressions)).padStart(4)} imp · pos ${n(r.position).toFixed(0).padStart(2)}  ${r.keys[0]}`)) : console.log('   (nothing at position 8–20 yet)');
console.log('\n🌱 ORGANIC (7d)  '+orgCurS+' sess · '+orgCurU+' users'); orgDaily.forEach(r=>{const d=r.dimensionValues[0].value;console.log(`   ${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}  ${n(r.metricValues[0].value)} sess`);});
console.log('\n🤖 AI ANSWER ENGINES (AEO 28d)  '+aiTotS+' sess · '+aiTotU+' users · wk '+delta(aiCur7S,aiPrev7S)); aiEngines.length ? aiEngines.forEach(e=>console.log(`   ${String(e.sess).padStart(4)} sess · ${e.users} users  ${e.name}`)) : console.log('   (no AI-engine referrals yet)');
console.log('\n📣 WHERE VISITORS CAME FROM (28d)'); channels.forEach(c=>console.log(`   ${String(c.s).padStart(4)} sess · ${c.u} users  ${c.name}`));
console.log('\n🔗 BY CAMPAIGN (your UTM-tagged links)'); campaigns.length ? campaigns.forEach(c=>console.log(`   ${String(c.s).padStart(4)} sess · ${c.u} users  ${c.camp}  (${c.src})`)) : console.log('   (no tagged campaigns yet)');
console.log('\n📅 IMPRESSIONS TREND (14d)'); daily.forEach(r=>console.log(`   ${r.keys[0]}  ${n(r.impressions)} imp / ${n(r.clicks)} clk`));
const printMovers=(title,rows)=>{ console.log('\n'+title); rows.forEach(s=>{const chg=s.flat?'— flat':s.noBase?'▲ new':((s.improved?'▲':'▼')+s.pct+'% '+(s.improved?'better':'softer'));console.log('   '+s.label.padEnd(15)+String(s.fmt(s.cur)).padStart(9)+'  (was '+s.fmt(s.prev)+')   '+chg);}); };
console.log('\n'+verdict.emoji+' OVERALL: '+verdict.tag.toUpperCase()+' vs last week — '+vLine);
printMovers('📅 THIS WEEK vs LAST WEEK (last 7d vs prior 7d)', movWeek);
if(isMonthEnd) printMovers('🗓️  MONTH vs MONTH (last 30d vs prior 30d)', movMonth);

// ---------- reader feedback (last ~26h) ----------
let fb=[];
const SB_URL='https://limizehmxnaaqndacynm.supabase.co';
const SB_SR=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(SB_SR){
  try{
    const since=new Date(Date.now()-26*3600*1000).toISOString();
    const fr=await fetch(`${SB_URL}/rest/v1/feedback?created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&select=created_at,message,email,page`,{headers:{apikey:SB_SR,Authorization:'Bearer '+SB_SR}});
    if(fr.ok) fb=await fr.json(); else console.log('feedback fetch HTTP '+fr.status);
  }catch(e){ console.log('feedback fetch failed:',e.message); }
}
console.log('\n💬 READER FEEDBACK (last 26h): '+fb.length);
fb.forEach(f=>console.log(`   "${(f.message||'').slice(0,90)}"${f.email?' — '+f.email:''}  [${f.page||'/'}]`));

// ---------- email ----------
if(RESEND_API_KEY){
  const to = REPORT_TO || 'eugeneteo1988@gmail.com';
  const esc=(s)=>String(s==null?'':s).replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fbHTML = fb.length ? `<div style="background:#fff;border:1px solid #e6e3dc;border-left:4px solid #2647DD;border-radius:10px;padding:14px 16px;margin:6px 0 16px">
    <div style="font-family:Georgia,serif;font-size:16px;margin-bottom:6px">💬 ${fb.length} new ${fb.length===1?'message':'messages'} from readers</div>
    ${fb.map(f=>`<div style="border-top:1px solid #f0ede6;padding:9px 0"><div style="font-size:14px;color:#1c2430;white-space:pre-wrap">${esc(f.message)}</div><div style="font-size:11px;color:#a29b8f;margin-top:4px">${f.email?'✉️ '+esc(f.email)+' · ':'(no email) · '}${esc(f.page||'/')}</div></div>`).join('')}
  </div>` : '';
  const chip=(v)=>`<b style="color:${String(v).startsWith('▲')?'#1a7f4b':String(v).startsWith('▼')?'#b23a44':'#555'}">${v}</b>`;
  const card=(label,val,sub)=>`<td style="padding:10px 14px;border:1px solid #e6e3dc;border-radius:10px;background:#fff"><div style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8378">${label}</div><div style="font-size:26px;font-weight:700;color:#1c2430;font-family:Georgia,serif">${val}</div><div style="font-size:12px;color:#6b6459">${sub}</div></td>`;
  const rowsQ = topQ.map(r=>`<tr><td style="padding:4px 8px">${r.keys[0].replace(/</g,'&lt;').slice(0,70)}</td><td style="padding:4px 8px;text-align:right;color:#6b6459">${n(r.impressions)} imp</td><td style="padding:4px 8px;text-align:right;color:#2b6cb0">pos ${n(r.position).toFixed(0)}</td></tr>`).join('');
  const rowsP = topP.map(r=>`<tr><td style="padding:4px 8px">${r.keys[0].replace('https://stockkaki.com','')||'/'}</td><td style="padding:4px 8px;text-align:right;color:#6b6459">${n(r.impressions)} imp</td></tr>`).join('');
  const strikeRows = striking.length ? striking.map(r=>`<tr><td style="padding:4px 8px">${r.keys[0].replace(/</g,'&lt;').slice(0,70)}</td><td style="padding:4px 8px;text-align:right;color:#6b6459">${n(r.impressions)} imp</td><td style="padding:4px 8px;text-align:right;color:#2b6cb0">pos ${n(r.position).toFixed(0)}</td></tr>`).join('') : `<tr><td style="padding:9px 8px;color:#8a8378">Nothing sitting at position 8–20 right now — keep publishing and they'll appear here.</td></tr>`;
  const aiRowsHTML = aiEngines.length ? aiEngines.map(e=>`<tr><td style="padding:4px 8px">${e.name}</td><td style="padding:4px 8px;text-align:right;color:#6b6459">${e.sess} sess</td><td style="padding:4px 8px;text-align:right;color:#6b6459">${e.users} users</td></tr>`).join('') : `<tr><td style="padding:9px 8px;color:#8a8378">No AI-engine referrals yet — this is where ChatGPT / Perplexity / Gemini traffic will show as AEO grows.</td></tr>`;
  const chTotal = channels.reduce((a,c)=>a+c.s,0);
  const channelSection = channels.length ? `<h3 style="font-family:Georgia,serif;font-size:15px;margin:18px 4px 6px">📣 Where your visitors came from (28d)</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e3dc;border-radius:8px">${channels.map(c=>`<tr><td style="padding:4px 8px">${c.name}</td><td style="padding:4px 8px;text-align:right;color:#6b6459">${c.s} sess · ${c.u} users</td><td style="padding:4px 8px;text-align:right;color:#2b6cb0">${chTotal?Math.round(c.s/chTotal*100):0}%</td></tr>`).join('')}</table>` : '';
  const campaignSection = `<h3 style="font-family:Georgia,serif;font-size:15px;margin:18px 4px 6px">🔗 By campaign — your tagged links</h3>
  <p style="font-size:12px;color:#6b6459;margin:0 4px 6px">Visits from links you tagged with UTM codes (e.g. your LinkedIn posts) — how you see which post drove traffic.</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e3dc;border-radius:8px">${campaigns.length ? campaigns.map(c=>`<tr><td style="padding:4px 8px">${c.camp.replace(/</g,'&lt;')}</td><td style="padding:4px 8px;color:#8a8378">${c.src.replace(/</g,'&lt;')}</td><td style="padding:4px 8px;text-align:right;color:#6b6459">${c.s} sess</td></tr>`).join('') : `<tr><td style="padding:9px 8px;color:#8a8378">No tagged campaigns yet — add UTM tags to the links you share and they'll appear here.</td></tr>`}</table>`;
  const moverHTML=(title,sub,rows)=>{
    const up=rows.filter(s=>!s.flat&&s.improved).map(s=>s.label), dn=rows.filter(s=>!s.flat&&!s.improved).map(s=>s.label);
    const tr=rows.map(s=>{const col=s.flat?'#8a8378':(s.improved?'#1a7f4b':'#b23a44');const chg=s.flat?'—':s.noBase?'▲ new':((s.improved?'▲':'▼')+' '+s.pct+'%');return `<tr><td style="padding:6px 10px">${s.label}</td><td style="padding:6px 10px;text-align:right;font-weight:600">${s.fmt(s.cur)}</td><td style="padding:6px 10px;text-align:right;color:#8a8378">${s.fmt(s.prev)}</td><td style="padding:6px 10px;text-align:right;color:${col};font-weight:700">${chg}</td></tr>`;}).join('');
    return `<h3 style="font-family:Georgia,serif;font-size:15px;margin:20px 4px 4px">${title}</h3>
    <p style="font-size:12px;color:#6b6459;margin:0 4px 7px">${sub} &nbsp; <b style="color:#1a7f4b">▲ ${up.join(', ')||'—'}</b> &nbsp;·&nbsp; <b style="color:#b23a44">▼ ${dn.join(', ')||'—'}</b></p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e3dc;border-radius:8px"><tr style="color:#8a8378;font-size:10px;text-transform:uppercase;letter-spacing:.05em"><td style="padding:5px 10px">Area</td><td style="padding:5px 10px;text-align:right">Now</td><td style="padding:5px 10px;text-align:right">Before</td><td style="padding:5px 10px;text-align:right">Change</td></tr>${tr}</table>`;
  };
  const html=`<div style="max-width:600px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2430;background:#faf8f4;padding:22px">
  <div style="font-size:13px;color:#8a8378;letter-spacing:.06em;text-transform:uppercase">StockKaki · weekly review</div>
  <h1 style="font-family:Georgia,serif;font-size:23px;margin:2px 0 12px">Your week in search, Eugene</h1>
  <div style="background:${verdict.bg};border:1px solid ${verdict.col}44;border-radius:12px;padding:14px 16px;margin:0 0 16px">
    <div style="font-size:18px;font-weight:700;color:${verdict.col};font-family:Georgia,serif">${verdict.emoji} ${verdict.tag} — vs last week</div>
    <div style="font-size:12.5px;color:#5c6470;margin-top:5px;line-height:1.7">${vLine}</div>
  </div>
  <table cellspacing="8" style="width:100%;border-collapse:separate"><tr>
    ${card('Impressions 28d',n(tot.impressions),'wk '+impΔ)}
    ${card('Indexed & surfacing',pages.length,'of '+submitted+' submitted')}
    ${card('Organic 7d',orgCurS+' sess',orgCurU+' users · '+orgΔ)}
  </tr></table>
  <p style="font-size:13px;color:#6b6459;margin:14px 4px">Clicks 28d: <b>${n(tot.clicks)}</b> · CTR ${(n(tot.ctr)*100).toFixed(1)}% · avg position <b>${n(tot.position).toFixed(1)}</b> · ${queries.length} distinct queries. Week-on-week: impressions ${chip(impΔ)}, clicks ${chip(clkΔ)}, organic ${chip(orgΔ)}.</p>
  ${moverHTML('📅 This week vs last week', 'The full picture: last 7 days vs the 7 before it. Green = improved, red = softer.', movWeek)}
  ${isMonthEnd?moverHTML('🗓️ This month vs last month', 'Last 30 days vs the 30 before it.', movMonth):''}
  ${channelSection}
  ${campaignSection}
  <h3 style="font-family:Georgia,serif;font-size:15px;margin:18px 4px 6px">🪜 Striking distance — one push from page 1</h3>
  <p style="font-size:12px;color:#6b6459;margin:0 4px 6px">Searches where StockKaki ranks <b>position 8–20</b> (bottom of page 1 / top of page 2) — your fastest wins. <b>This is the shortlist of what to write or improve this week:</b> a sharper title, more content, or a clearer answer nudges these onto page one. Work top-down.</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e3dc;border-radius:8px">${strikeRows}</table>
  <h3 style="font-family:Georgia,serif;font-size:15px;margin:18px 4px 6px">🔎 What people Googled to find you</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e3dc;border-radius:8px">${rowsQ}</table>
  <h3 style="font-family:Georgia,serif;font-size:15px;margin:18px 4px 6px">📄 Top pages in search</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e3dc;border-radius:8px">${rowsP}</table>
  <h3 style="font-family:Georgia,serif;font-size:15px;margin:18px 4px 6px">🤖 Found via AI answer engines (AEO)</h3>
  <p style="font-size:12px;color:#6b6459;margin:0 4px 6px">People who arrived from an AI tool in the last 28 days${aiTotS?` — <b>${aiTotS}</b> sessions, ${aiTotU} users, week-on-week ${chip(delta(aiCur7S,aiPrev7S))}`:''}.</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6e3dc;border-radius:8px">${aiRowsHTML}</table>
  <p style="font-size:11px;color:#a29b8f;margin-top:20px">Weekly review · Google Search Console + Analytics · ${START} → ${END} · emailed every Sunday 10am. Search data lags ~2 days.</p>
  </div>`;
  const r = await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:'StockKaki <alerts@stockkaki.com>',to,subject:`${verdict.emoji} StockKaki weekly · ${verdict.tag} — impressions ${impΔ}, clicks ${clkΔ}`,html})});
  const jr = await r.json();
  console.log(jr.id?`\n✉️  emailed ${to} (${jr.id})`:`\n✉️  email FAILED: ${JSON.stringify(jr)}`);
} else {
  console.log('\n(no RESEND_API_KEY — console only)');
}
