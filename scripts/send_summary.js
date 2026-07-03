// ============================================================
// Condor Market Intelligence — Weekly Email Summary
// Runs after generate.js — sends combined summary via SendGrid
// ============================================================

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EMAIL_TO = process.env.SUMMARY_EMAIL_TO; // comma-separated
const EMAIL_FROM = process.env.SUMMARY_EMAIL_FROM;

if (!SENDGRID_KEY || !SUPABASE_URL || !SUPABASE_KEY || !EMAIL_TO || !EMAIL_FROM) {
  console.error('Missing env vars: SENDGRID_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, SUMMARY_EMAIL_TO, SUMMARY_EMAIL_FROM');
  process.exit(1);
}

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getLatestReports() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseClient
    .from('reports')
    .select('*')
    .eq('report_date', today)
    .order('location_code', { ascending: true });
  if (error) throw new Error(`Supabase error: ${error.message}`);
  return data || [];
}

// Most recent report per location from any earlier week, for change detection
async function getPriorReports(today) {
  const { data, error } = await supabaseClient
    .from('reports')
    .select('*')
    .neq('report_date', today)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(`Supabase error: ${error.message}`);
  const seen = new Set();
  return (data || []).filter(r => { if (seen.has(r.location_code)) return false; seen.add(r.location_code); return true; });
}

// ============================================================
// WHAT CHANGED THIS WEEK — mirror of the diff logic in
// web/public/index.html; keep the heuristics in sync
// ============================================================
const kpiVal = (kpis, field) => (kpis.find(k => k.field === field) || {}).value || '';
const isNA = v => {
  const s = String(v || '').trim().toLowerCase();
  return !s || ['not available', 'not publicly available', 'n/a', 'na', 'unknown', 'unavailable', 'none', 'not applicable', 'tbd', 'not found'].some(x => s === x || s.startsWith(x + '.') || s.startsWith(x + ' -'));
};
const positionScore = pos => {
  const p = (pos || '').toLowerCase();
  if (!p) return null;
  if (p.includes('sole') || p.includes('dominant')) return 100;
  if (p.includes('leader') || p.includes('leading') || p.includes('#1') || p.includes('hub')) return 85;
  if (p.includes('competitive') || p.includes('regional')) return 60;
  if (p.includes('marginal') || p.includes('weak')) return 35;
  return 55;
};
const rankScore = rank => {
  const m = (rank || '').match(/#\s*(\d+)/);
  if (m) { const n = +m[1]; return n === 1 ? 100 : n === 2 ? 70 : 45; }
  const r = (rank || '').toLowerCase();
  if (r.includes('lead') || r.includes('dominant')) return 90;
  return r ? 60 : null;
};
const shareScore = share => {
  const s = (share || '').toLowerCase();
  if (!s) return null;
  const nums = s.match(/\d+(\.\d+)?/g);
  if (nums && nums.length) {
    const vals = nums.map(Number).filter(n => n <= 100);
    if (vals.length) return Math.min(100, vals.reduce((a, b) => a + b, 0) / vals.length + 25);
  }
  if (s.includes('dominant') || s.includes('100')) return 95;
  if (s.includes('high') || s.includes('main')) return 80;
  if (s.includes('med')) return 55;
  if (s.includes('low')) return 30;
  return 55;
};
const competitorNames = v => String(v || '').split(/[,;]/)
  .map(s => s.replace(/\[UNVERIFIED\]/ig, '').replace(/\(.*?\)/g, '').trim().toLowerCase())
  .filter(s => s.length > 2 && !['none', 'n/a', 'various', 'not publicly available'].includes(s));

function computeWeeklyChanges(reports, priorByLoc) {
  const changes = [];
  let hasPrior = false;
  for (const cur of reports) {
    const prev = priorByLoc[cur.location_code];
    if (!prev) continue;
    hasPrior = true;
    const ck = (cur.report_json || {}).kpi_table || [];
    const pk = (prev.report_json || {}).kpi_table || [];
    const items = [];
    for (const [f, scorer] of [['Signature Position', positionScore], ['Positional Ranking', rankScore], ['Market Share (Signature vs Others)', shareScore]]) {
      const a = kpiVal(pk, f), b = kpiVal(ck, f);
      if (a && b && !isNA(a) && !isNA(b) && a.trim().toLowerCase() !== b.trim().toLowerCase()) {
        const sa = scorer(a), sb = scorer(b);
        const dir = sa == null || sb == null || sa === sb ? 'neutral' : sb > sa ? 'positive' : 'negative';
        items.push({ label: f.replace(' (Signature vs Others)', ''), from: a, to: b, dir });
      }
    }
    const prevNames = new Set([...competitorNames(kpiVal(pk, 'Named FBO Competitors')), ...competitorNames(kpiVal(pk, 'MRO Operators at Airport'))]);
    const curNames = [...new Set([...competitorNames(kpiVal(ck, 'Named FBO Competitors')), ...competitorNames(kpiVal(ck, 'MRO Operators at Airport'))])];
    const added = curNames.filter(n => !prevNames.has(n) && !n.includes('signature') && !n.includes('technicair') && !n.includes('landmark'));
    if (prevNames.size && added.length) items.push({ label: 'New competitor mentioned', to: added.join(', '), dir: 'negative' });
    if (items.length) changes.push({ code: cur.location_code, name: cur.location_name, items });
  }
  return { changes, hasPrior };
}

function buildChangesHTML(changesResult) {
  const { changes, hasPrior } = changesResult;
  let body;
  if (!hasPrior) {
    body = `<p style="font-size:13px;color:#6b675f;line-height:1.6;margin:0">First tracked week — changes will appear here from next week's report.</p>`;
  } else if (!changes.length) {
    body = `<p style="font-size:13px;color:#6b675f;line-height:1.6;margin:0">No material changes across the portfolio this week — positions, rankings, and competitor sets held steady.</p>`;
  } else {
    const arrow = dir => dir === 'positive' ? '<span style="color:#1a7a45;font-weight:700">&#9650;</span>' : dir === 'negative' ? '<span style="color:#b52020;font-weight:700">&#9660;</span>' : '<span style="color:#9b9892;font-weight:700">&#9679;</span>';
    body = changes.map(c => `
      <div style="padding:8px 0;border-bottom:1px solid #efede9">
        <div style="font-size:13px;font-weight:700;color:#1a1916;margin-bottom:2px">${c.code} — ${c.name}</div>
        ${c.items.map(it => `<div style="font-size:12.5px;color:#514e48;line-height:1.6">${arrow(it.dir)} <strong>${it.label}:</strong> ${it.from ? `${it.from} &rarr; ` : ''}${it.to}</div>`).join('')}
      </div>`).join('');
  }
  return `
    <div style="background:#fff;border:1px solid #e5e3de;border-radius:10px;padding:20px 24px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:#9b9892;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">What changed this week</div>
      ${body}
    </div>`;
}

// Verified jet fuel line for the header card, when the run captured it
function fuelLine(reports) {
  const f = reports.map(r => (r.report_json || {}).ground_truth?.jetFuel).find(Boolean);
  if (!f || f.priceUsdGal == null) return '';
  const wow = f.wowChangePct == null ? '' : ` (${f.wowChangePct >= 0 ? '+' : ''}${f.wowChangePct.toFixed(1)}% WoW)`;
  return `<div style="font-size:12px;opacity:.85;margin-top:6px">Jet-A spot (Gulf Coast, EIA): $${Number(f.priceUsdGal).toFixed(2)}/gal${wow}</div>`;
}

function buildEmailHTML(reports, changesResult) {
  const weekLabel = reports[0]?.week_label || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const us = reports.filter(r => r.country === 'US');
  const uk = reports.filter(r => r.country === 'UK');

  // Build paragraph 1 — US overview
  const usLeaders = us.filter(r => {
    const kpis = (r.report_json||{}).kpi_table || [];
    const pos = kpis.find(k => k.field === 'Signature Position')?.value || '';
    return pos.toLowerCase().includes('dominant') || pos.toLowerCase().includes('leader');
  }).map(r => r.location_code);

  const usSignals = us.flatMap(r => (r.report_json||{}).market_signals || [])
    .filter(s => s.direction === 'positive').slice(0, 2).map(s => s.signal).join('; ');

  const para1 = `Signature / TECHNICair holds a leading or dominant market position at ${usLeaders.length} of ${us.length} US locations this week, with strongest positioning at ${usLeaders.slice(0,4).join(', ')}${usLeaders.length > 4 ? ` and ${usLeaders.length - 4} others` : ''}. ${usSignals ? `Key positive signals: ${usSignals}.` : ''}`;

  // Build paragraph 2 — UK overview + M&A angle
  const ukLeaders = uk.filter(r => {
    const kpis = (r.report_json||{}).kpi_table || [];
    const pos = kpis.find(k => k.field === 'Signature Position')?.value || '';
    return pos.toLowerCase().includes('dominant') || pos.toLowerCase().includes('leader');
  }).map(r => r.location_code);

  const ukSignals = uk.flatMap(r => (r.report_json||{}).market_signals || [])
    .filter(s => s.direction !== 'neutral').slice(0, 2).map(s => s.signal).join('; ');

  const allOutlooks = reports.flatMap(r => {
    const es = (r.report_json||{}).executive_summary || {};
    return es.strategic_outlook ? [es.strategic_outlook] : [];
  });
  const topOutlook = allOutlooks[0] || '';

  const para2 = `In the UK/EMEA portfolio, Signature maintains a leading position at ${ukLeaders.length} of ${uk.length} locations${ukLeaders.length ? ` including ${ukLeaders.slice(0,3).join(', ')}` : ''}. ${ukSignals ? `Notable market signals: ${ukSignals}.` : ''} ${topOutlook ? topOutlook : ''}`.trim();

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f9f8f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:620px;margin:0 auto;padding:28px 16px">

    <div style="background:linear-gradient(135deg,#1a3a5c,#1a6db5);border-radius:10px;padding:20px 24px;margin-bottom:20px;color:#fff">
      <div style="font-size:20px;font-weight:700;margin-bottom:4px">✈️ Condor Market Intelligence</div>
      <div style="font-size:13px;opacity:.8">Week of ${weekLabel} · ${reports.length} locations · Signature Aviation MRO Portfolio</div>
      ${fuelLine(reports)}
    </div>

    ${buildChangesHTML(changesResult)}

    <div style="background:#fff;border:1px solid #e5e3de;border-radius:10px;padding:20px 24px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:#9b9892;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">Weekly summary</div>
      <p style="font-size:14px;color:#1a1916;line-height:1.75;margin-bottom:14px">${para1}</p>
      <p style="font-size:14px;color:#1a1916;line-height:1.75">${para2}</p>
    </div>

    <div style="text-align:center;margin-bottom:20px">
      <a href="https://project-condor-xi.vercel.app" style="display:inline-block;background:#1a6db5;color:#fff;text-decoration:none;padding:11px 26px;border-radius:6px;font-size:13px;font-weight:500">View full reports →</a>
    </div>

    <div style="font-size:11px;color:#9b9892;text-align:center;line-height:1.6">
      Auto-generated every Monday 6 AM ET · Perplexity live web search<br>
      Project Condor · ARGI Advisory
    </div>
  </div>
</body>
</html>`;
}
async function sendEmail(htmlContent, reports) {
  const weekLabel = reports[0]?.week_label || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const recipients = EMAIL_TO.split(',').map(e => ({ email: e.trim() }));

  const body = {
    personalizations: [{ to: recipients }],
    from: { email: EMAIL_FROM, name: 'Condor Market Intelligence' },
    subject: `✈️ Weekly Aviation Market Report — ${weekLabel}`,
    content: [{ type: 'text/html', value: htmlContent }]
  };

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`SendGrid error ${response.status}: ${err}`);
  }
  console.log(`  ✓ Email sent to: ${EMAIL_TO}`);
}

async function run() {
  console.log('\n========================================');
  console.log('Condor — Weekly Email Summary');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log('========================================\n');

  const reports = await getLatestReports();
  if (!reports.length) { console.log('No reports found for today. Skipping email.'); return; }

  console.log(`Found ${reports.length} reports. Computing week-over-week changes...`);
  const today = new Date().toISOString().slice(0, 10);
  let changesResult = { changes: [], hasPrior: false };
  try {
    const prior = await getPriorReports(today);
    const priorByLoc = Object.fromEntries(prior.map(r => [r.location_code, r]));
    changesResult = computeWeeklyChanges(reports, priorByLoc);
    console.log(`  ${changesResult.changes.length} locations with material changes`);
  } catch (err) {
    console.error(`  Change detection failed (email continues without it): ${err.message}`);
  }

  console.log('Building email...');
  const html = buildEmailHTML(reports, changesResult);
  await sendEmail(html, reports);
  console.log('\n✓ Summary email sent successfully.\n');
}

run().catch(err => { console.error('Fatal error:', err); process.exit(1); });
