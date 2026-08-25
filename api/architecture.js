import { architectureRoute } from '../src/app.js';
import { veniceRelay } from '../src/venice-relay.js';

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

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
      model: process.env.VENICE_MODEL || 'venice-uncensored',
      vision_model: process.env.VENICE_VISION_MODEL || 'qwen3-vl-235b-a22b',
    });
  }
  return architectureRoute(req, res);
}
