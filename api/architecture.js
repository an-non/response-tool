import { architectureRoute } from '../src/app.js';
import { veniceRelay } from '../src/venice-relay.js';

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

const clean = (value, limit = 800) => String(value || '').slice(0, limit);

async function previewVeniceProbe(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') return json(res, 404, { ok: false, error: 'not_found' });
  if (!process.env.VENICE_API_KEY) return json(res, 200, { ok: false, stage: 'environment', api_key_configured: false });
  const model = process.env.VENICE_MODEL || 'venice-uncensored';
  try {
    const upstream = await fetch('https://api.venice.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
        stream: false,
        max_completion_tokens: 16,
      }),
    });
    const body = await upstream.json().catch(() => ({}));
    return json(res, 200, {
      ok: upstream.ok,
      stage: 'venice_upstream',
      api_key_configured: true,
      upstream_status: upstream.status,
      model,
      upstream_model: body?.model || null,
      error_code: body?.error?.code || null,
      detail: clean(body?.error?.message || body?.message || '', 800) || null,
      response_present: typeof body?.choices?.[0]?.message?.content === 'string',
    });
  } catch (error) {
    return json(res, 200, {
      ok: false,
      stage: 'transport',
      api_key_configured: true,
      model,
      detail: clean(error?.message || error, 800),
    });
  }
}

export default async function handler(req, res) {
  const mode = String(req.query?.mode || '');
  if (req.method === 'POST' && mode === 'venice') {
    return veniceRelay(req, res);
  }
  if (req.method === 'GET' && mode === 'venice-health') {
    return json(res, 200, {
      ok: true,
      service: 'response-tool-venice',
      api_key_configured: !!process.env.VENICE_API_KEY,
      required_env_key: 'VENICE_API_KEY',
      environment: process.env.VERCEL_ENV || 'unknown',
      branch: process.env.VERCEL_GIT_COMMIT_REF || null,
      commit_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
      deployment_url: process.env.VERCEL_URL || null,
      model: process.env.VENICE_MODEL || 'venice-uncensored',
      vision_model: process.env.VENICE_VISION_MODEL || 'qwen3-vl-235b-a22b',
    });
  }
  if (req.method === 'GET' && mode === 'venice-probe') {
    return previewVeniceProbe(req, res);
  }
  return architectureRoute(req, res);
}
