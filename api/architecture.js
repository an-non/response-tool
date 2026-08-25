import { architectureRoute } from '../src/app.js';
import { oxAlphaHealth, oxAlphaHistory, oxAlphaRelay } from '../src/ox-alpha-relay.js';

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

export default async function handler(req, res) {
  const mode = String(req.query?.mode || '');
  if (req.method === 'POST' && mode === 'ox-alpha') {
    return oxAlphaRelay(req, res);
  }
  if (req.method === 'GET' && mode === 'ox-alpha-health') {
    return json(res, 200, await oxAlphaHealth());
  }
  if (req.method === 'GET' && mode === 'ox-alpha-history') {
    return oxAlphaHistory(req, res);
  }
  return architectureRoute(req, res);
}
