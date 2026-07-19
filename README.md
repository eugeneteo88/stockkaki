# YieldLion (working name) — Singapore dividend & announcement tracker

A clean, fast, ad-light alternative to SGinvestors.io / dividends.sg. Wedge = UX +
ex-date alerts, not more data (data is a commodity from SGX).

## Status
- ✅ Data feasibility CONFIRMED: SGX public JSON API is free & reachable.
  Working endpoint (proven): `https://api.sgx.com/securities/v1.1?excludetypes=bonds&params=nc,cn,p,c,dp,dpc`
  (needs browser User-Agent header; returns all SGX securities + prices).
- ⏳ TODO: find the exact dividend/corporate-action route. The announcement/CA
  endpoints returned "Missing Authentication Token" (= wrong AWS route, not real
  auth). Discover the real path from the XHR calls on
  https://www.sgx.com/securities/corporate-actions?cat=DIVIDEND (Chrome DevTools → Network).
- ✅ `index.html` — clean MVP prototype of the "Upcoming Dividends" page (SAMPLE data).

## Architecture (decided)
Static site + **daily scheduled rebuild** (same pattern as JTE blog auto-publish):
a Node script fetches SGX data daily → generates static pages (upcoming dividends,
per-stock pages) → deploy to GitHub Pages / Vercel (free). Cheap, fast, great SEO.

## MVP scope (v1)
1. Upcoming dividends page (sortable/filterable) — DONE as prototype.
2. Per-stock dividend history pages (SEO — rank on "<company> dividend").
3. Free **ex-date email/Telegram alerts** (owned audience + differentiator).
Later: yield screener, portfolio dividend tracker, income projections.

## Monetisation
Broker/robo affiliate referrals (moomoo/Tiger/IBKR/Syfe/StashAway) = primary;
freemium premium (alerts+portfolio, no ads); sponsored dividend newsletter.

## Legal
Factual data only — NOT financial advice (MAS/FAA). Disclaimer on every page.
Source from SGX filings (primary), NOT by scraping competitors. Respect ToS,
cache, rate-limit.

## Name
Working name YieldLion. Shortlist: YieldLion, ExDate, SGDividends, DividendKaki,
LionYield, PayoutSG, TheDividendDesk, HuatYield, DivviSG, IncomeLah.
(Avoid "SGX" in any brand name — trademark.)
