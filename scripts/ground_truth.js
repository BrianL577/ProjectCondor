// ============================================================
// Condor — Authenticated ground-truth data feeds
// Fetched once per weekly run and injected into every report
// prompt as verified data (bypasses AI search for these figures).
//
// EIA requires a free API key: register at https://www.eia.gov/opendata/
// and add it as the EIA_API_KEY repository secret. If the key is missing
// or a feed fails, the run continues without that feed.
// ============================================================

import fetch from 'node-fetch';

const EIA_KEY = process.env.EIA_API_KEY;

// Weekly U.S. Gulf Coast Kerosene-Type Jet Fuel Spot Price FOB ($/gal)
// Series EER_EPJK_PF4_RGC_DPG — the same series linked on the Data sources page
async function fetchJetFuelPrice() {
  if (!EIA_KEY) {
    console.log('  · EIA_API_KEY not set — skipping jet fuel feed (register free at eia.gov/opendata)');
    return null;
  }
  const url = 'https://api.eia.gov/v2/petroleum/pri/spt/data/'
    + `?api_key=${EIA_KEY}`
    + '&frequency=weekly&data[0]=value'
    + '&facets[series][]=EER_EPJK_PF4_RGC_DPG'
    + '&sort[0][column]=period&sort[0][direction]=desc&length=2';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`EIA API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const rows = json?.response?.data || [];
  if (!rows.length) throw new Error('EIA API returned no rows');
  const latest = rows[0], prior = rows[1];
  return {
    period: latest.period,
    priceUsdGal: Number(latest.value),
    priorPriceUsdGal: prior ? Number(prior.value) : null,
    wowChangePct: prior ? ((latest.value - prior.value) / prior.value * 100) : null,
    source: 'EIA — U.S. Gulf Coast Kerosene-Type Jet Fuel Spot Price (weekly), eia.gov/opendata',
    sourceUrl: 'https://www.eia.gov/dnav/pet/hist/eer_epjk_pf4_rgc_dpgW.htm'
  };
}

export async function fetchGroundTruth() {
  const gt = {};
  try {
    const jetFuel = await fetchJetFuelPrice();
    if (jetFuel) {
      gt.jetFuel = jetFuel;
      const wow = jetFuel.wowChangePct == null ? '' : ` (${jetFuel.wowChangePct >= 0 ? '+' : ''}${jetFuel.wowChangePct.toFixed(1)}% WoW)`;
      console.log(`  ✓ EIA jet fuel: $${jetFuel.priceUsdGal.toFixed(3)}/gal for week ${jetFuel.period}${wow}`);
    }
  } catch (err) {
    console.error(`  ✗ EIA jet fuel feed failed (continuing without it): ${err.message.slice(0, 150)}`);
  }
  return gt;
}

// Renders the verified-data block inserted into each location prompt
export function groundTruthPromptBlock(gt) {
  if (!gt || !gt.jetFuel) return '';
  const f = gt.jetFuel;
  const wow = f.wowChangePct == null ? '' : `, ${f.wowChangePct >= 0 ? '+' : ''}${f.wowChangePct.toFixed(1)}% vs prior week`;
  return `
VERIFIED GROUND TRUTH THIS WEEK (fetched directly from the source API — treat as authoritative, do NOT search for or contradict these figures):
- U.S. Gulf Coast Jet-A spot price, week of ${f.period}: $${f.priceUsdGal.toFixed(3)}/gal${wow} (source: ${f.source})
Use this exact figure for fuel-price context in the Fuel Flowage KPI and market signals, cite the source verbatim, and set "verified": true on any KPI row that uses it.
`;
}
