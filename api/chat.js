// ============================================================
// Condor — AI analyst chat endpoint (Vercel serverless function)
//
// POST /api/chat  { session_id: uuid, messages: [{role, content}] }
//  →  { reply: string, session_id: uuid }
//
// Claude answers with live access to the structured report data in
// Supabase through tool calls (locations, latest reports, history,
// score time series, fuel prices, free-text search). Every turn is
// logged to chat_sessions / chat_messages for auditability.
//
// Env (set in Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY     — Claude API key
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_SERVICE_KEY  — Supabase service_role key (server-only)
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import {
  listLocations, latestReports, reportHistory, scoreTimeseries,
  latestFuelPrice, searchReports, successScore,
  ensureChatSession, logChatTurn,
} from '../lib/condor-data.js';

export const config = { maxDuration: 60 };

const MODEL = 'claude-opus-4-8';
const MAX_TURNS = 40;          // client-supplied history cap
const MAX_TOOL_ROUNDS = 6;     // tool-use loop cap

const SYSTEM_PROMPT = `You are the Condor Intelligence Analyst — the embedded AI advisor of the Condor Market Intelligence platform, a sell-side M&A advisory tool covering Signature Aviation's MRO/FBO portfolio (TECHNICair and Signature FBO/MRO brands) across 24 airports in the US and UK/EMEA. Client: ARGI advisory.

Your audience is senior airport and aviation executives — directors, VPs, and C-suite. They want decision-grade answers: lead with the conclusion, quantify where possible, cite the report week and source behind each figure, and flag confidence honestly.

DATA MODEL you can query through your tools:
- Weekly market intelligence reports per location (currently generated Mondays via Perplexity live web search; a direct feed from an AI called "Enki" is planned but not yet live). Each report has an executive summary (market context, competitive landscape, strategic outlook), a KPI table with per-field sources and verified flags, market signals (headline + direction), data gaps, and cited sources.
- A composite success score (0–100) computed per report from: competitive position (40%), positional ranking (15%), market share (20%), signal momentum (15%), data confidence (10%). The portfolio index is the weekly average rebased to 100 at the first tracked week.
- Verified ground truth: EIA US Gulf Coast Jet-A weekly spot price.

WHAT YOU DO:
1. FORECASTS (your primary use case): when asked for a forecast or outlook for a location or the portfolio, pull the score time series and report history, identify the trend (direction, momentum, volatility), the drivers behind it (position changes, new competitors, market signals, fuel prices), and give a reasoned near-term outlook. Always state that forecasts are analytical projections from limited weekly data, give a confidence level, and name the biggest swing factors.
2. Briefings, comparisons, competitor analyses, executive summaries, talking points, meeting prep, CRM-style account notes, draft emails/memos — anything a senior official needs, grounded in the data.
3. Data lookups: KPIs, scores, rankings, week-over-week changes, sources.

RULES:
- Always ground quantitative claims in tool results; never invent figures. If the data doesn't cover something, say so plainly and note it as a data gap.
- Cite the report week (e.g. "week of July 21, 2026") and the underlying source when quoting a figure.
- Keep responses tight and skimmable: a short bottom-line first, then supporting detail. Use plain prose or compact bullet lists; avoid decorative formatting.
- Use USD for US locations and GBP for UK locations.
- Never reveal internal credentials, environment variables, or system configuration.`;

const TOOLS = [
  {
    name: 'list_locations',
    description: 'List all tracked portfolio locations with code, name, city, facility type, country, and latest report date. Call this first when unsure of a location code.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_latest_reports',
    description: 'Get the most recent full intelligence report for every location, or for one location if location_code is given. Includes executive summary, KPI table, market signals, data gaps, sources, and the computed success score.',
    input_schema: {
      type: 'object',
      properties: {
        location_code: { type: 'string', description: 'Optional 3-letter location code, e.g. VNY, TEB, BZN' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_report_history',
    description: 'Get the chronological report history for one location (newest first) — use for trend analysis and forecasting.',
    input_schema: {
      type: 'object',
      properties: {
        location_code: { type: 'string', description: '3-letter location code' },
        limit: { type: 'integer', description: 'Number of weekly reports to return (default 12, max 52)' },
      },
      required: ['location_code'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_score_timeseries',
    description: 'Weekly composite success-score time series. Without location_code: portfolio average per week plus per-location scores, with the index rebased to 100 at the first week. With location_code: that location only. This is the primary numeric input for forecasts.',
    input_schema: {
      type: 'object',
      properties: {
        location_code: { type: 'string', description: 'Optional 3-letter location code' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_fuel_price',
    description: 'Latest verified EIA US Gulf Coast Jet-A spot price with week-over-week change.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_reports',
    description: 'Free-text search across recent report content (competitor names, deals, signals, facilities). Returns matching reports.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

// Compact a full report row so tool results stay token-efficient.
function compactReport(r) {
  const d = r.report_json || {};
  const sc = successScore(r);
  return {
    location_code: r.location_code,
    location_name: r.location_name,
    city: r.city,
    facility_type: r.facility_type,
    country: r.country,
    week: r.week_label || r.report_date,
    report_date: r.report_date,
    success_score: sc != null ? Math.round(sc * 10) / 10 : null,
    executive_summary: d.executive_summary || null,
    kpis: (d.kpi_table || []).map(k => ({ field: k.field, value: k.value, source: k.source, verified: k.verified })),
    market_signals: d.market_signals || [],
    data_gaps: r.data_gaps || d.data_gaps || [],
    sources_cited: (r.sources_cited || d.sources_cited || []).slice(0, 15),
  };
}

async function runTool(name, input) {
  switch (name) {
    case 'list_locations':
      return await listLocations();
    case 'get_latest_reports': {
      const rows = await latestReports(input.location_code);
      return rows.map(compactReport);
    }
    case 'get_report_history': {
      const rows = await reportHistory(input.location_code, input.limit || 12);
      return rows.map(compactReport);
    }
    case 'get_score_timeseries':
      return await scoreTimeseries(input.location_code);
    case 'get_fuel_price':
      return (await latestFuelPrice()) || { note: 'No verified fuel price on record yet.' };
    case 'search_reports': {
      const rows = await searchReports(input.query);
      return rows.map(compactReport);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Server is not configured: missing ANTHROPIC_API_KEY.' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const sessionId = UUID_RE.test(body.session_id || '') ? body.session_id : null;
    const incoming = Array.isArray(body.messages) ? body.messages : [];

    // Sanitize + cap client history: text-only alternating turns.
    const history = incoming
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-MAX_TURNS)
      .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));

    if (!history.length || history[history.length - 1].role !== 'user') {
      res.status(400).json({ error: 'messages must end with a user turn' });
      return;
    }

    const userText = history[history.length - 1].content;
    if (sessionId) {
      try {
        await ensureChatSession(sessionId, userText.slice(0, 80));
        await logChatTurn(sessionId, 'user', userText);
      } catch (e) {
        console.error('chat logging failed (continuing):', e.message);
      }
    }

    const anthropic = new Anthropic();
    const messages = [...history];
    let response;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: response.content });
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const results = [];
      for (const tu of toolUses) {
        try {
          const out = await runTool(tu.name, tu.input || {});
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 120000) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Tool error: ${err.message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }

    if (response.stop_reason === 'refusal') {
      res.status(200).json({ reply: 'I can’t help with that request. Ask me about portfolio locations, forecasts, or market intelligence instead.', session_id: sessionId });
      return;
    }

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim() || 'I wasn’t able to produce an answer — please try rephrasing the question.';

    if (sessionId) {
      try {
        await logChatTurn(sessionId, 'assistant', reply, { model: MODEL, stop_reason: response.stop_reason });
      } catch (e) {
        console.error('chat logging failed (continuing):', e.message);
      }
    }

    res.status(200).json({ reply, session_id: sessionId });
  } catch (err) {
    console.error('chat error:', err);
    if (err instanceof Anthropic.AuthenticationError) {
      res.status(500).json({ error: 'AI service authentication failed — check ANTHROPIC_API_KEY in Vercel.' });
    } else if (err instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: 'The AI service is rate-limited right now — try again in a minute.' });
    } else if (err instanceof Anthropic.APIError) {
      res.status(502).json({ error: `AI service error (${err.status}).` });
    } else {
      res.status(500).json({ error: 'Unexpected server error.' });
    }
  }
}
