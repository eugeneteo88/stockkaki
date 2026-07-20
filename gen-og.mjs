#!/usr/bin/env node
/*
 * Generate per-page Open Graph share cards (1200×630 PNG) so each shared page looks
 * intentional. Branded SVG → sharp → assets/og/<name>.png. Run locally when card copy
 * changes; the PNGs are committed and build.mjs copies them to dist/og/.
 *   node gen-og.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire('C:/Users/eugen/jte-website/package.json');
const sharp = require('sharp');

const OUT = new URL('./assets/og/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

function card(t1, t2, sub) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#FBF6EE"/>
  <rect width="1200" height="12" fill="#E07A3B"/>
  <g transform="translate(84,88)">
    <rect width="70" height="70" rx="18" fill="#E07A3B"/>
    <g fill="none" stroke="#ffffff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" transform="translate(14,15) scale(1.75)">
      <path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/>
      <path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/>
      <path d="M8 2.5c-.6.8.6 1.2 0 2M12 2.5c-.6.8.6 1.2 0 2"/>
    </g>
    <text x="90" y="48" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="700" fill="#3A2A20">StockKaki</text>
  </g>
  <text x="84" y="298" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="700" fill="#2A1F17">${esc(t1)}</text>
  ${t2 ? `<text x="84" y="386" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="700" fill="#2A1F17">${esc(t2)}</text>` : ''}
  <text x="84" y="${t2 ? 460 : 372}" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="#8C7A69">${esc(sub)}</text>
  <rect x="84" y="${t2 ? 512 : 424}" width="250" height="58" rx="29" fill="#E07A3B"/>
  <text x="209" y="${t2 ? 550 : 462}" font-family="Arial, Helvetica, sans-serif" font-size="27" font-weight="700" fill="#ffffff" text-anchor="middle">stockkaki.com</text>
</svg>`;
}

const CARDS = {
  home:               ['Singapore stocks —', 'one clean board.', 'Yields, ex-dates, price, fundamentals & news. Free.'],
  screener:           ['Best dividend stocks', 'in Singapore.', 'Every SGX payer ranked by yield — updated daily.'],
  reits:              ['Best REITs to buy', 'in Singapore.', 'All S-REITs ranked by distribution yield.'],
  etfs:               ['Best ETFs', 'in Singapore.', 'SGX ETFs ranked by dividend yield — clean & free.'],
  ssb:                ['Singapore Savings', 'Bonds (SSB).', 'Rates, step-up, projection, swap & allotment.'],
  'dividend-calendar': ['Singapore dividend', 'calendar.', 'Every upcoming SGX ex-date & pay date.'],
  announcements:      ['SGX corporate', 'actions.', 'Dividends, rights, entitlements & offers — daily.'],
};

for (const [name, [t1, t2, sub]] of Object.entries(CARDS)) {
  await sharp(Buffer.from(card(t1, t2, sub))).png().toFile(fileURLToPath(new URL(`${name}.png`, OUT)));
  console.log(`  og/${name}.png`);
}
console.log(`Generated ${Object.keys(CARDS).length} OG cards → assets/og/`);
