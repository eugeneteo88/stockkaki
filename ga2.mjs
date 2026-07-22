import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
const KEY = JSON.parse(readFileSync(new URL('./.ga-key.json', import.meta.url), 'utf8'));
const PROPERTY = process.env.GA_PROPERTY || '546290038';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const now = Math.floor(Date.now()/1000);
const head = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
const claim = b64url(JSON.stringify({iss:KEY.client_email,scope:'https://www.googleapis.com/auth/analytics.readonly',aud:KEY.token_uri,iat:now,exp:now+3600}));
const s = createSign('RSA-SHA256'); s.update(head+'.'+claim); s.end();
const jwt = head+'.'+claim+'.'+b64url(s.sign(KEY.private_key));
const tr = await (await fetch(KEY.token_uri,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt})})).json();
const TOKEN = tr.access_token;
const api = async (m,b)=>{const r=await(await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:${m}`,{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify(b)})).json(); if(r.error)throw new Error(r.error.message); return r;};
const rows = j => (j.rows||[]).map(r=>({d:r.dimensionValues.map(x=>x.value),v:r.metricValues.map(x=>+x.value)}));

// Country x users x sessions x avg engagement time x engagement rate  (15-21 Jul window to match his screenshot)
const geo = await api('runReport',{dateRanges:[{startDate:'2026-07-15',endDate:'2026-07-21'}],dimensions:[{name:'country'}],metrics:[{name:'totalUsers'},{name:'sessions'},{name:'userEngagementDuration'},{name:'engagedSessions'}],orderBys:[{metric:{metricName:'totalUsers'},desc:true}],limit:15});
console.log('\nCountry (15–21 Jul)   users  sess  avgEngage/sess  engagedRate');
console.log('─'.repeat(64));
for(const r of rows(geo)){
  const [users,sess,engDur,engSess]=r.v;
  const avg = sess? (engDur/sess):0;
  const rate = sess? (engSess/sess*100):0;
  console.log(`${(r.d[0]||'(n/a)').padEnd(20)} ${String(users).padStart(4)} ${String(sess).padStart(5)}   ${avg.toFixed(0).padStart(5)}s        ${rate.toFixed(0).padStart(3)}%`);
}

// City breakdown
const city = await api('runReport',{dateRanges:[{startDate:'2026-07-15',endDate:'2026-07-21'}],dimensions:[{name:'city'}],metrics:[{name:'totalUsers'},{name:'sessions'}],orderBys:[{metric:{metricName:'totalUsers'},desc:true}],limit:12});
console.log('\nCity                 users  sess');
console.log('─'.repeat(34));
for(const r of rows(city)) console.log(`${(r.d[0]||'(n/a)').padEnd(20)} ${String(r.v[0]).padStart(4)} ${String(r.v[1]).padStart(5)}`);
