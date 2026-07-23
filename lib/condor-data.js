// ============================================================
// Condor — Structured data access layer
// Single source of truth for querying report data out of
// Supabase. Used by the chat API (Claude tools) and any future
// server-side consumer (e.g. the Enki ingestion pipeline).
//
// All functions are read-only except logChatTurn/ensureChatSession.
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in the environment.
// ============================================================

import { createClient } from '@supabase/supabase-js';

let _client = null;

// Neither a Supabase project URL nor a service_role JWT ever legitimately
// contains whitespace — so stripping ALL whitespace (not just leading/
// trailing) is safe and catches the common case of a multi-line paste
// leaving an embedded newline in the middle of the value, which .trim()
// alone does not clean up.
function sanitizeEnvValue(v) {
  return (v || '').replace(/\s+/g, '').replace(/^['"]+|['"]+$/g, '');
}

export function db() {
  if (_client) return _client;
  const url = sanitizeEnvValue(process.env.SUPABASE_URL).replace(/\/+$/, '');
  const key = sanitizeEnvValue(process.env.SUPABASE_SERVICE_KEY);
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY environment variable(s).');
  try {
    new URL(url);
  } catch {
    throw new Error(`SUPABASE_URL is not a valid URL ("${url}"). It should look like https://xxxxx.supabase.co with no trailing path or slash.`);
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

// ------------------------------------------------------------
// Success scoring — mirror of the client-side composite score in
// web/public/index.html. Keep the two in sync if heuristics change.
// ------------------------------------------------------------
function kpiVal(kpis, field) {
  return (kpis.find(k => k.field === field) || {}).value || '';
}
function isNA(v) {
  const s = String(v || '').trim().toLowerCase();
  return !s || ['not available', 'not publicly available', 'n/a', 'na', 'unknown', 'unavailable', 'none', 'not applicable', 'tbd', 'not found'].some(x => s === x || s.startsWith(x + '.') || s.startsWith(x + ' -'));
}
function positionScore(pos) {
  const p = (pos || '').toLowerCase();
  if (!p) return null;
  if (p.includes('sole') || p.includes('dominant')) return 100;
  if (p.includes('leader') || p.includes('leading') || p.includes('#1') || p.includes('hub')) return 85;
  if (p.includes('competitive') || p.includes('regional')) return 60;
  if (p.includes('marginal') || p.includes('weak')) return 35;
  return 55;
}
function rankScore(rank) {
  const m = (rank || '').match(/#\s*(\d+)/);
  if (m) { const n = +m[1]; return n === 1 ? 100 : n === 2 ? 70 : 45; }
  const r = (rank || '').toLowerCase();
  if (r.includes('lead') || r.includes('dominant')) return 90;
  return r ? 60 : null;
}
function shareScore(share) {
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
}
export function successScore(reportRow) {
  const d = reportRow.report_json || {};
  const kpis = d.kpi_table || [];
  const parts = [];
  const push = (v, w) => { if (v != null) parts.push([v, w]); };
  push(positionScore(kpiVal(kpis, 'Signature Position')), 0.40);
  push(rankScore(kpiVal(kpis, 'Positional Ranking')), 0.15);
  push(shareScore(kpiVal(kpis, 'Market Share (Signature vs Others)')), 0.20);
  const sigs = d.market_signals || [];
  if (sigs.length) {
    const net = sigs.reduce((a, s) => a + (s.direction === 'positive' ? 1 : s.direction === 'negative' ? -1 : 0), 0) / sigs.length;
    push(50 + net * 50, 0.15);
  }
  const filled = kpis.filter(k => k.value && !isNA(k.value));
  if (kpis.length) push(100 * filled.filter(k => k.verified).length / kpis.length * 0.5 + 100 * filled.length / kpis.length * 0.5, 0.10);
  if (!parts.length) return null;
  const wSum = parts.reduce((a, p) => a + p[1], 0);
  return parts.reduce((a, p) => a + p[0] * p[1], 0) / wSum;
}

// ------------------------------------------------------------
// Query helpers — the structured surface Claude's tools call into
// ------------------------------------------------------------

/** Distinct locations with their most recent report metadata. */
export async function listLocations() {
  const { data, error } = await db()
    .from('reports')
    .select('location_code, location_name, city, facility_type, country, report_date, created_at')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  const seen = new Map();
  for (const r of data) {
    if (!seen.has(r.location_code)) seen.set(r.location_code, r);
  }
  return [...seen.values()];
}

/** Latest full report per location (optionally a single location). */
export async function latestReports(locationCode) {
  let q = db().from('reports').select('*').order('created_at', { ascending: false }).limit(1000);
  if (locationCode) q = q.eq('location_code', locationCode.toUpperCase());
  const { data, error } = await q;
  if (error) throw error;
  const seen = new Set();
  return data.filter(r => { if (seen.has(r.location_code)) return false; seen.add(r.location_code); return true; });
}

/** Full report history for one location, newest first. */
export async function reportHistory(locationCode, limit = 12) {
  const { data, error } = await db()
    .from('reports')
    .select('*')
    .eq('location_code', locationCode.toUpperCase())
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 52));
  if (error) throw error;
  return data;
}

/**
 * Weekly composite-score time series — the numeric backbone for
 * forecasting. Returns per-location weekly scores plus the
 * portfolio average per week (rebased to 100 at first week).
 */
export async function scoreTimeseries(locationCode) {
  const { data, error } = await db()
    .from('reports')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(2000);
  if (error) throw error;
  const rows = locationCode ? data.filter(r => r.location_code === locationCode.toUpperCase()) : data;
  const byWeek = {};
  for (const r of rows) {
    const wk = r.report_date || (r.created_at || '').slice(0, 10);
    const sc = successScore(r);
    if (!wk || sc == null) continue;
    (byWeek[wk] = byWeek[wk] || { scores: [], locations: {} });
    byWeek[wk].scores.push(sc);
    byWeek[wk].locations[r.location_code] = Math.round(sc * 10) / 10;
  }
  const weeks = Object.keys(byWeek).sort();
  let base = null;
  return weeks.map(w => {
    const avg = byWeek[w].scores.reduce((a, b) => a + b, 0) / byWeek[w].scores.length;
    if (base == null) base = avg;
    return {
      week: w,
      average_score: Math.round(avg * 10) / 10,
      index_rebased_100: Math.round(avg / base * 1000) / 10,
      locations: byWeek[w].locations,
    };
  });
}

/** Latest verified EIA jet fuel ground truth, if present. */
export async function latestFuelPrice() {
  const { data, error } = await db()
    .from('reports')
    .select('report_json, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  for (const r of data) {
    const f = r.report_json?.ground_truth?.jetFuel;
    if (f && f.priceUsdGal != null) return f;
  }
  return null;
}

/** Case-insensitive text search across recent report JSON. */
export async function searchReports(query, limit = 8) {
  const { data, error } = await db()
    .from('reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = [];
  for (const r of data) {
    const hay = JSON.stringify(r.report_json || {}).toLowerCase()
      + ` ${r.location_code} ${r.location_name} ${r.city}`.toLowerCase();
    if (terms.every(t => hay.includes(t))) hits.push(r);
    if (hits.length >= limit) break;
  }
  return hits;
}

// ------------------------------------------------------------
// Chat logging — every conversation turn is persisted so it can
// be audited and, later, queried as context by the AI itself.
// ------------------------------------------------------------
export async function ensureChatSession(sessionId, title) {
  const { error } = await db()
    .from('chat_sessions')
    .upsert({ id: sessionId, title: (title || 'Untitled session').slice(0, 200) }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
}

export async function logChatTurn(sessionId, role, content, meta = {}) {
  const { error } = await db().from('chat_messages').insert({
    session_id: sessionId,
    role,
    content: String(content).slice(0, 40000),
    meta,
  });
  if (error) throw error;
}
