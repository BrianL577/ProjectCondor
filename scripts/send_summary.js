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

function buildEmailHTML(reports) {
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
    </div>

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

  console.log(`Found ${reports.length} reports. Building email...`);
  const html = buildEmailHTML(reports);
  await sendEmail(html, reports);
  console.log('\n✓ Summary email sent successfully.\n');
}

run().catch(err => { console.error('Fatal error:', err); process.exit(1); });
