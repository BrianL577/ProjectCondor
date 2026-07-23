// ============================================================
// Condor — Environment / connectivity diagnostic endpoint
//
// GET /api/health
//
// Reports whether the required environment variables are present
// and well-formed, and whether a live Supabase query succeeds —
// without ever exposing secret values. SUPABASE_URL is not secret
// (it's already public in web/public/index.html), so it's echoed
// in full to help spot stray whitespace/typos; SUPABASE_SERVICE_KEY
// and ANTHROPIC_API_KEY are reported as present/length only.
// ============================================================

import { db } from '../lib/condor-data.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const rawUrl = process.env.SUPABASE_URL || '';
  const rawKey = process.env.SUPABASE_SERVICE_KEY || '';
  const rawAnthropicKey = process.env.ANTHROPIC_API_KEY || '';

  const info = {
    supabase_url_set: !!rawUrl,
    supabase_url_raw_length: rawUrl.length,
    supabase_url_raw: rawUrl.length && rawUrl.length < 300 ? JSON.stringify(rawUrl) : '(too long to display)',
    supabase_service_key_set: !!rawKey,
    supabase_service_key_length: rawKey.length,
    anthropic_api_key_set: !!rawAnthropicKey,
  };

  try {
    const client = db();
    const { error, count } = await client.from('reports').select('id', { count: 'exact', head: true });
    if (error) {
      info.db_query_ok = false;
      info.db_query_error = error.message;
    } else {
      info.db_query_ok = true;
      info.reports_count = count;
    }
  } catch (err) {
    info.db_query_ok = false;
    info.db_query_error = err.message;
  }

  res.status(200).json(info);
}
