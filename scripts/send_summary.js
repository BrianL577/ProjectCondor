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

  const renderRow = (r) => {
    const es = (r.report_json || {}).executive_summary || {};
    const kpis = (r.report_json || {}).kpi_table || [];
    const position = kpis.find(k => k.field === 'Signature Position')?.value || '';
    const rank = kpis.find(k => k.field === 'Positional Ranking')?.value || '';
    const signals = (r.report_json || {}).market_signals || [];
    const topSignal = signals[0];
    const outlook = es.strategic_outlook || '';
    const hasInfo = outlook || position || topSignal;

    if (!hasInfo) {
      return `<tr>
        <td style="padding:8px 12px;font-weight:600;font-family:monospace;font-size:12px;color:#6b6963;vertical-align:top;white-space:nowrap;border-bottom:1px solid #e5e3de">${r.location_code}</td>
        <td style="padding:8px 12px;font-size:13px;color:#9b9892;border-bottom:1px solid #e5e3de">No new information found on ${r.location_name} this week.</td>
      </tr>`;
    }

    let text = '';
    if (position) text += `<strong>${position}</strong>${rank ? ` (${rank})` : ''}. `;
    if (outlook) text += outlook;
    if (topSignal) text += ` <em>${topSignal.signal}</em>`;

    return `<tr>
      <td style="padding:8px 12px;font-weight:600;font-family:monospace;font-size:12px;color:#1a1916;vertical-align:top;white-space:nowrap;border-bottom:1px solid #e5e3de">${r.location_code}</td>
      <td style="padding:8px 12px;font-size:13px;color:#1a1916;line-height:1.6;border-bottom:1px solid #e5e3de">${text}</td>
    </tr>`;
  };

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f9f8f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:680px;margin:0 auto;padding:32px 16px">

    <div style="background:linear-gradient(135deg,#1a3a5c,#1a6db5);border-radius:10px;padding:24px;margin-bottom:24px;color:#fff">
      <div style="font-size:22px;font-weight:700;margin-bottom:6px">✈️ Condor Market Intelligence</div>
      <div style="font-size:14px;opacity:.85">Week of ${weekLabel} · ${reports.length} locations · Signature Aviation MRO Portfolio</div>
    </div>

    <div style="background:#fff;border:1px solid #e5e3de;border-radius:10px;padding:20px;margin-bottom:16px">
      <div style="font-size:13px;font-weight:600;color:#9b9892;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">🇺🇸 United States — ${us.length} locations</div>
      <table style="width:100%;border-collapse:collapse">
        ${us.map(renderRow).join('')}
      </table>
    </div>

    <div style="background:#fff;border:1px solid #e5e3de;border-radius:10px;padding:20px;margin-bottom:24px">
      <div style="font-size:13px;font-weight:600;color:#9b9892;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">🇬🇧 UK / EMEA — ${uk.length} locations</div>
      <table style="width:100%;border-collapse:collapse">
        ${uk.map(renderRow).join('')}
      </table>
    </div>

    <div style="text-align:center;margin-bottom:24px">
      <a href="https://project-condor-xi.vercel.app" style="display:inline-block;background:#1a6db5;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-size:14px;font-weight:500">View full reports →</a>
    </div>

    <div style="font-size:11px;color:#9b9892;text-align:center;line-height:1.6">
      Generated automatically every Monday at 6 AM ET via Perplexity live web search.<br>
      Project Condor · ARGI Advisory · Signature Aviation MRO Portfolio
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
