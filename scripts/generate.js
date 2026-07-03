// ============================================================
// Condor Market Intelligence — Weekly Report Generator
// Runs every Monday via GitHub Actions scheduler
// Uses Perplexity AI (live web search) → saves to Supabase
// ============================================================

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { fetchGroundTruth, groundTruthPromptBlock } from './ground_truth.js';

const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!PERPLEXITY_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing required environment variables: PERPLEXITY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// All 22 locations with baseline data from MRO Location Matrix
// ============================================================
const LOCATIONS = [
  // ---- Flagship locations — Signature's two highest-profile fields ----
  // Baselines verified against LAWA/iflyvny.com, Port Authority NY&NJ traffic
  // reports, signatureaviation.com and AIN (July 2026 pass)
  { code: 'VNY', name: 'Van Nuys Airport', city: 'Los Angeles, CA', type: 'Signature FBO/MRO — Most Popular', country: 'US', flagship: true,
    baseline: { competitorCount: 4, airportTier: 1, marketSize: 'GA/Business (no scheduled pax)', annualOps: '230,000+ (LAWA)', fuelFlowage: 'Very High', mroOperators: 'Signature (East + West terminals), Clay Lacy Aviation', facilitySqFt: '250,000 (campus build-out)', maintenanceCategory: 'Hybrid', signaturePosition: 'Airport Leader — only operator with two full-service terminals', namedCompetitors: 'Clay Lacy Aviation, Castle & Cooke Aviation, Jet Aviation, The Park VNY', marketShare: 'Leading (2 of 6 FBO terminals)', positionalRank: '#1 of 5 operators' }},
  { code: 'TEB', name: 'Teterboro Airport', city: 'Teterboro, NJ', type: 'Signature FBO/MRO — Most Popular', country: 'US', flagship: true,
    baseline: { competitorCount: 2, airportTier: 1, marketSize: 'GA/Business (busiest bizav field in NY metro)', annualOps: '177,466 (PANYNJ, Jul 2023–Jul 2024)', fuelFlowage: 'Very High', mroOperators: 'Signature (East, West, South terminals), Jet Aviation', maintenanceCategory: 'Line/Hybrid', signaturePosition: 'Airport Leader — largest operator, 3 terminals after Meridian acquisition (Jan 2024)', namedCompetitors: 'Atlantic Aviation, Jet Aviation', marketShare: 'Dominant (3 of 5 FBO terminals)', positionalRank: '#1 of 3 operators' }},
  { code: 'BZN', name: "Bozeman Yellowstone Int'l", city: 'Bozeman, MT', type: 'TECHNICair Repair Station', country: 'US',
    baseline: { competitorCount: 4, airportTier: 2, marketSize: '2.68M pax/yr', annualOps: '117,304', fuelFlowage: 'High', mroOperators: "TECHNICair, Arlin's", facilitySqFt: '80,000+', maintenanceCategory: 'Hybrid', signaturePosition: 'Airport Leader', namedCompetitors: 'Jet Aviation, Yellowstone Jetcenter, Million Air', marketShare: '~25-30%', positionalRank: '#1 of 4' }},
  { code: 'FAT', name: "Fresno Yosemite Int'l", city: 'Fresno, CA', type: 'TECHNICair Repair Station', country: 'US',
    baseline: { competitorCount: 5, airportTier: 2, marketSize: '2.75M pax/yr', siteEbitda: '$0.8M', annualOps: '~86,999', fuelFlowage: 'High', mroOperators: 'Signature, NIACC-Avitech', maintenanceCategory: 'Hybrid', signaturePosition: 'Leading Provider', namedCompetitors: 'Ross Aviation (Atlantic)', marketShare: 'Dominant', positionalRank: 'Leading Provider' }},
  { code: 'GRR', name: "Gerald R. Ford Int'l", city: 'Grand Rapids, MI', type: 'TECHNICair Repair Station', country: 'US',
    baseline: { competitorCount: 8, airportTier: 2, marketSize: '4.3M pax/yr', siteEbitda: '$1.1M', annualOps: '~88,000', fuelFlowage: 'High', mroOperators: 'Landmark (Signature), L-3', facilitySqFt: '40,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Market Leader', namedCompetitors: 'AvFlight', marketShare: 'Dominant', positionalRank: '#1 of 2' }},
  { code: 'GSO', name: "Piedmont Triad Int'l", city: 'Greensboro, NC', type: 'TECHNICair Repair Station', country: 'US',
    baseline: { competitorCount: 7, airportTier: 2, marketSize: '1.9M pax/yr', siteEbitda: '$0.1M', annualOps: '~83,000', fuelFlowage: 'Very High', mroOperators: 'Signature, TIMCO, Genesis', facilitySqFt: '28,000', maintenanceCategory: 'Heavy', signaturePosition: 'Dominant Hub', namedCompetitors: 'Tries-FBO', marketShare: 'Dominant Hub', positionalRank: '#1' }},
  { code: 'INT', name: 'Smith Reynolds Airport', city: 'Winston-Salem, NC', type: 'TECHNICair Repair Station', country: 'US',
    baseline: { competitorCount: 2, airportTier: 2, marketSize: 'Regional/GA (Private)', siteEbitda: '$1.4M', annualOps: '~42,408', fuelFlowage: 'Low', mroOperators: 'Signature, Landmark', facilitySqFt: '3,000', maintenanceCategory: 'Hybrid/MRO', signaturePosition: 'Leading Provider', namedCompetitors: 'Landmark (Legacy)', marketShare: 'High (MRO/GA)', positionalRank: '#1' }},
  { code: 'MKC', name: 'Kansas City Downtown', city: 'Kansas City, MO', type: 'TECHNICair MSU', country: 'US',
    baseline: { competitorCount: 4, airportTier: 2, marketSize: 'Business (Reliever)', annualOps: '~68,000', fuelFlowage: 'Med', mroOperators: 'Signature, Atlantic, Duncan', facilitySqFt: '~35,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Refueling Leader', namedCompetitors: 'Atlantic Aviation', marketShare: 'High (Refueling)', positionalRank: '#1 of 2' }},
  { code: 'MSP', name: "Minneapolis-Saint Paul Int'l", city: 'Minneapolis-St Paul, MN', type: 'TECHNICair Repair Station', country: 'US',
    baseline: { competitorCount: 14, airportTier: 1, marketSize: '36.07M pax/yr', annualOps: '405,000', fuelFlowage: 'Very High', mroOperators: 'Signature, Elliott, Honeywell', facilitySqFt: '~150,000', maintenanceCategory: 'Heavy', signaturePosition: 'Tier 1 Leader', namedCompetitors: 'Jet Aviation', marketShare: 'Dominant Presence', positionalRank: '#1' }},
  { code: 'OMA', name: 'Eppley Airfield', city: 'Omaha, NE', type: 'TECHNICair Repair Station', country: 'US',
    baseline: { competitorCount: 5, airportTier: 1, marketSize: '5.16M pax/yr', annualOps: '~98,938', fuelFlowage: 'High', mroOperators: 'Signature, StandardAero', facilitySqFt: '~65,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Leading Provider', namedCompetitors: 'Tac Air (Acquired)', marketShare: 'Dominant', positionalRank: '#1' }},
  { code: 'STP', name: 'St. Paul Downtown Airport', city: 'St. Paul, MN', type: 'TECHNICair Repair Station', country: 'US',
    baseline: { competitorCount: 4, airportTier: 2, marketSize: 'Reliever (Private)', siteEbitda: '$1.3M', annualOps: '~42,476', fuelFlowage: 'Med', mroOperators: 'Signature TECHNICair', facilitySqFt: '~25,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Maintenance Hub', namedCompetitors: 'Regent Aviation', marketShare: 'Main Maint. Hub', positionalRank: '#1' }},
  { code: 'BUF', name: "Buffalo Niagara Int'l", city: 'Buffalo, NY', type: 'Signature FBO/MRO', country: 'US',
    baseline: { competitorCount: 7, airportTier: 1, marketSize: '5.0M pax/yr', annualOps: '~72,700', fuelFlowage: 'High', mroOperators: 'Signature (TAC Air)', facilitySqFt: '126,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Regional Lead', namedCompetitors: 'Prior: TAC Air', marketShare: 'High (Legacy TAC)', positionalRank: '#1' }},
  { code: 'CHO', name: 'Charlottesville-Albemarle', city: 'Charlottesville, VA', type: 'Signature FBO/MRO', country: 'US',
    baseline: { competitorCount: 3, airportTier: 2, marketSize: '~0.7M pax/yr', annualOps: '~32,000', fuelFlowage: 'Med', mroOperators: 'Landmark (Signature)', facilitySqFt: '~18,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Leading Provider', marketShare: '~40%', positionalRank: 'Leading Provider' }},
  { code: 'CID', name: 'Eastern Iowa Airport', city: 'Cedar Rapids, IA', type: 'Signature FBO/MRO', country: 'US',
    baseline: { competitorCount: 4, airportTier: 2, marketSize: '~1.3M pax/yr', annualOps: '~45,000', fuelFlowage: 'Med', mroOperators: 'Landmark (Signature)', facilitySqFt: '~22,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Leading Provider', marketShare: '~45%', positionalRank: 'Leading Provider' }},
  { code: 'EGE', name: 'Eagle County Regional', city: 'Vail, CO', type: 'Signature FBO/MRO', country: 'US',
    baseline: { competitorCount: 3, airportTier: 2, marketSize: '~0.4M pax/yr', annualOps: '~40,400', fuelFlowage: 'High', mroOperators: 'Landmark (Signature)', facilitySqFt: '~20,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Leading Provider', namedCompetitors: 'Vail Valley Jet Center', marketShare: 'High (Resort)', positionalRank: '#1' }},
  { code: 'FAY', name: 'Fayetteville Regional', city: 'Fayetteville, NC', type: 'Signature FBO/MRO', country: 'US',
    baseline: { competitorCount: 3, airportTier: 2, marketSize: '~0.5M pax/yr', annualOps: '~38,000', fuelFlowage: 'Med', mroOperators: 'Landmark (Signature)', facilitySqFt: '~15,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Leading Provider', marketShare: '~50%', positionalRank: 'Leading Provider' }},
  { code: 'ORF', name: "Norfolk Int'l Airport", city: 'Norfolk, VA', type: 'Signature FBO/MRO', country: 'US',
    baseline: { competitorCount: 6, airportTier: 2, marketSize: '4.89M pax/yr', annualOps: '~72,000', fuelFlowage: 'High', mroOperators: 'Landmark (Signature)', facilitySqFt: '~45,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Regional Leader', marketShare: 'Dominant', positionalRank: 'Regional Leader' }},
  { code: 'ROA', name: 'Roanoke-Blacksburg Regional', city: 'Roanoke, VA', type: 'Signature FBO/MRO', country: 'US',
    baseline: { competitorCount: 4, airportTier: 2, marketSize: '~0.75M pax/yr', annualOps: '~55,300', fuelFlowage: 'Med', mroOperators: 'Landmark (Signature)', facilitySqFt: '~12,000', maintenanceCategory: 'Hybrid', signaturePosition: 'Leading Provider', marketShare: '~55%', positionalRank: 'Leading Provider' }},
  { code: 'SLC', name: "Salt Lake City Int'l", city: 'Salt Lake City, UT', type: 'Signature FBO/MRO', country: 'US',
    baseline: { competitorCount: 11, airportTier: 1, marketSize: '28.1M pax/yr', annualOps: '319,993', fuelFlowage: 'Very High', mroOperators: 'Keystone (Signature), Duncan', facilitySqFt: '~200,000+', maintenanceCategory: 'Heavy', signaturePosition: 'Sole FBO Leader', namedCompetitors: 'None (Sole Source GA Fuel)', marketShare: '~100% (GA Fuel)', positionalRank: '#1 of 1' }},
  { code: 'BOH', name: "Bournemouth Int'l Airport", city: 'Bournemouth, England', type: 'TECHNICair UK Repair Station', country: 'UK',
    baseline: { competitorCount: 5, airportTier: 2, marketSize: '~1.1M pax/yr', annualOps: '~42,000', fuelFlowage: 'Med', mroOperators: 'CSE Bournemouth (Signature)', maintenanceCategory: 'Hybrid', signaturePosition: 'Leading Provider', namedCompetitors: 'XJET', marketShare: '~35%', positionalRank: 'Leading Provider' }},
  { code: 'BQH', name: 'London Biggin Hill Airport', city: 'London, England', type: 'Signature Line/MSU', country: 'UK',
    baseline: { competitorCount: 8, airportTier: 2, marketSize: 'Business (Private)', annualOps: '~50,000', fuelFlowage: 'High', mroOperators: 'Castle Air, Bombardier', facilitySqFt: '~30,000', maintenanceCategory: 'Heavy', signaturePosition: 'Leading Provider', namedCompetitors: 'Premier Care', marketShare: '~30%', positionalRank: 'Leading Provider' }},
  { code: 'FAB', name: 'Farnborough Airport', city: 'Farnborough, Hampshire', type: 'Signature Line/MSU', country: 'UK',
    baseline: { competitorCount: 6, airportTier: 2, marketSize: 'Business (Private)', annualOps: '~31,000', fuelFlowage: 'High', mroOperators: 'Not publicly available', maintenanceCategory: 'Hybrid', signaturePosition: 'Leading Provider', namedCompetitors: 'TAG Aviation', marketShare: '~25%', positionalRank: 'Leading Provider' }},
  { code: 'LTN', name: 'London Luton Airport', city: 'Luton, Bedfordshire', type: 'Signature Line/MSU', country: 'UK',
    baseline: { competitorCount: 12, airportTier: 1, marketSize: '~17.5M pax/yr', annualOps: '~132,000', fuelFlowage: 'Very High', mroOperators: 'Signature, Monarch, Gulfstream', facilitySqFt: '~75,000', maintenanceCategory: 'Heavy', signaturePosition: 'Airport Leader', namedCompetitors: 'Harrods Aviation', marketShare: 'High (Two Terms)', positionalRank: '#1 of 2' }},
  { code: 'MAN', name: 'Manchester Airport', city: 'Manchester, England', type: 'Signature Line/MSU', country: 'UK',
    baseline: { competitorCount: 15, airportTier: 1, marketSize: '~28.2M pax/yr', annualOps: '~195,000', fuelFlowage: 'Very High', mroOperators: 'Signature, Chevron Tech', maintenanceCategory: 'Heavy', signaturePosition: 'Airport Leader', namedCompetitors: 'Premiere Handling', marketShare: 'Dominant', positionalRank: 'Airport Leader' }}
];

// ============================================================
// Build the prompt for a single location
// ============================================================
function buildPrompt(loc, groundTruth) {
  const isUK = loc.country === 'UK';
  const regulator = isUK
    ? 'UK CAA approved organisations register (caa.co.uk)'
    : 'FAA Part 145 repair station database (av-info.faa.gov)';
  const currency = isUK ? 'GBP (£)' : 'USD ($)';
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `You are an expert aviation market intelligence analyst for Project Condor, a sell-side M&A advisory for Signature Aviation's MRO portfolio (TECHNICair and Signature FBO/MRO brands). Client: ARGI advisory.

TODAY: ${today}

LOCATION: ${loc.name} (${loc.code}) — ${loc.city} — ${loc.type} — ${loc.country}
CURRENCY: ${currency}
AUTHORITATIVE MRO REGISTRY: ${regulator}

INTERNAL BASELINE DATA (update with fresh live web data where available):
${JSON.stringify(loc.baseline, null, 2)}
${groundTruthPromptBlock(groundTruth)}

YOUR TASK: Search the web right now and generate a current weekly market intelligence report for this location. Use live sources including FAA ATADS, BTS T-100, EIA fuel data, GAMA reports, AIN/Aviation Week news, and the ${regulator}.

DATA INTEGRITY RULES — NON-NEGOTIABLE:
1. Every data point must cite its exact source URL (preferred) or authoritative dataset name — primary/official sources first: FAA, BTS, EIA, UK CAA, airport authority (LAWA, PANYNJ), operator press rooms. Blogs/charter-broker sites are NOT acceptable sources
2. Never invent competitor names. Only list operators verified from ${regulator} or an official airport-authority FBO directory. Mark others [UNVERIFIED]
3. Never fabricate financial figures. If a value cannot be verified against a named source, set "value" to "" (empty string) and add the field name to data_gaps — do NOT write "Not available" or "Unknown" as a value
4. Market share estimates must be clearly labeled as estimates with rationale
5. If using baseline data not verified this week, mark source as "Baseline data — needs verification"
6. Prefer replacing any baseline estimate with a fresher figure from an authenticated source, and cite that source

Respond ONLY with valid JSON — no markdown, no text outside the JSON:

{
  "location_code": "${loc.code}",
  "location_name": "${loc.name}",
  "city": "${loc.city}",
  "facility_type": "${loc.type}",
  "country": "${loc.country}",
  "report_date": "${new Date().toISOString().slice(0, 10)}",
  "week_label": "Week of ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}",
  "executive_summary": {
    "market_context": "2-3 sentences on current aviation market at this airport. Include specific recent data points with sources.",
    "competitive_landscape": "2-3 sentences on verified competitors. Flag any unverified names explicitly.",
    "strategic_outlook": "2-3 sentences on what matters for an M&A buyer right now at this specific location."
  },
  "kpi_table": [
    {"field": "Location", "value": "${loc.name} (${loc.code})", "source": "Internal", "verified": true},
    {"field": "Competitor Count", "value": "number + brief note", "source": "source URL or name", "verified": true},
    {"field": "Airport Tier", "value": "I/II/III/IV + rationale", "source": "FAA classifications", "verified": true},
    {"field": "Market Size (passengers/yr)", "value": "figure + year", "source": "BTS T-100 or equivalent", "verified": true},
    {"field": "Site EBITDA Context", "value": "Market-level commentary only. Never invent Signature financials.", "source": "Market estimate", "verified": false},
    {"field": "Annual Operations (T+L)", "value": "figure + year", "source": "FAA ATADS or equivalent", "verified": true},
    {"field": "Fuel Flowage", "value": "Low/Med/High/Very High + context", "source": "EIA or market data", "verified": true},
    {"field": "MRO Operators at Airport", "value": "Verified list only. Append [UNVERIFIED] for unconfirmed names.", "source": "${regulator}", "verified": true},
    {"field": "Facility Size (sq ft)", "value": "figure or range", "source": "source or Baseline data", "verified": false},
    {"field": "Maintenance Category", "value": "Line / Base / Heavy / Avionics / Hybrid", "source": "Operational profile", "verified": true},
    {"field": "Signature Position", "value": "Dominant/Leading/Competitive/Marginal + rationale", "source": "Market analysis", "verified": false},
    {"field": "Named FBO Competitors", "value": "Verified names only. Flag unverified.", "source": "${regulator}", "verified": true},
    {"field": "Best Performing Tier", "value": "Which service category drives most demand here", "source": "Market analysis", "verified": false},
    {"field": "Market Share (Signature vs Others)", "value": "Estimate range + rationale", "source": "Market estimate", "verified": false},
    {"field": "Positional Ranking", "value": "#X of Y operators", "source": "Market analysis", "verified": false}
  ],
  "market_signals": [
    {"signal": "current headline relevant to this location or market", "detail": "one sentence with specific data", "direction": "positive/negative/neutral", "source": "source URL"}
  ],
  "data_gaps": ["fields that could not be verified and need manual follow-up"],
  "sources_cited": ["complete list of all URLs and datasets referenced"]
}`;
}

// ============================================================
// Call Perplexity API (live web search on every query)
// ============================================================
async function callPerplexity(prompt) {
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PERPLEXITY_KEY}`
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are an expert aviation market intelligence analyst. You search the web for current data and always respond with valid JSON only. Never include markdown formatting or text outside the JSON object.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 3500
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Perplexity API error: ${err.error?.message || JSON.stringify(err) || response.status}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || '';
  const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    // Try to extract JSON if there's text around it
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        throw new Error(`Failed to parse Perplexity response as JSON: ${e.message}\nRaw: ${raw.slice(0, 300)}`);
      }
    }
    throw new Error(`Failed to parse Perplexity response as JSON: ${e.message}\nRaw: ${raw.slice(0, 300)}`);
  }
}

// ============================================================
// Save report to Supabase
// ============================================================
async function saveReport(reportData) {
  const { error } = await supabase.from('reports').insert({
    location_code: reportData.location_code,
    location_name: reportData.location_name,
    city: reportData.city,
    facility_type: reportData.facility_type,
    country: reportData.country,
    report_date: reportData.report_date,
    week_label: reportData.week_label,
    report_json: reportData,
    sources_cited: reportData.sources_cited || [],
    data_gaps: reportData.data_gaps || [],
    created_at: new Date().toISOString()
  });

  if (error) throw new Error(`Supabase save error: ${error.message}`);
}

// ============================================================
// Sleep helper
// ============================================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// Main runner
// ============================================================
async function run() {
  console.log(`\n========================================`);
  console.log(`Condor Market Intelligence — Weekly Run`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Locations to process: ${LOCATIONS.length}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE'}`);
  console.log(`AI Engine: Perplexity Sonar (live web search)`);
  console.log(`========================================\n`);

  console.log('Fetching authenticated ground-truth feeds...');
  const groundTruth = await fetchGroundTruth();

  const results = { success: [], failed: [] };

  for (let i = 0; i < LOCATIONS.length; i++) {
    const loc = LOCATIONS[i];
    console.log(`[${i + 1}/${LOCATIONS.length}] Generating: ${loc.name} (${loc.code})...`);

    try {
      const prompt = buildPrompt(loc, groundTruth);
      const report = await callPerplexity(prompt);
      report.ground_truth = groundTruth;

      if (!DRY_RUN) {
        await saveReport(report);
        console.log(`  ✓ Saved to database`);
      } else {
        console.log(`  ✓ Generated (dry run — not saved)`);
        console.log(`  Preview: ${report.executive_summary?.market_context?.slice(0, 120)}...`);
      }

      results.success.push(loc.code);

      // Pause between calls — Perplexity recommends ~3s between requests
      if (i < LOCATIONS.length - 1) await sleep(4000);

    } catch (err) {
      console.error(`  ✗ Failed: ${err.message.slice(0, 120)}`);
      console.log(`  ↻ Retrying in 10 seconds...`);
      await sleep(10000);
      try {
        const report = await callPerplexity(buildPrompt(loc, groundTruth));
        report.ground_truth = groundTruth;
        if (!DRY_RUN) { await saveReport(report); console.log(`  ✓ Retry succeeded — saved to database`); }
        results.success.push(loc.code);
      } catch (err2) {
        console.error(`  ✗ Retry also failed: ${err2.message.slice(0, 120)}`);
        results.failed.push({ code: loc.code, error: err2.message });
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`Run complete.`);
  console.log(`Success: ${results.success.length} locations`);
  console.log(`Failed:  ${results.failed.length} locations`);
  if (results.failed.length > 0) {
    console.log(`Failed locations:`);
    results.failed.forEach(f => console.log(`  - ${f.code}: ${f.error}`));
  }
  console.log(`========================================\n`);

  if (results.failed.length > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
