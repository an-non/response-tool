import { architectureRoute } from '../src/app.js';
import { veniceRelay } from '../src/venice-relay.js';

export default async function handler(req, res) {
  if (req.method === 'POST' && String(req.query?.mode || '') === 'venice') {
    return veniceRelay(req, res);
  }
  return architectureRoute(req, res);
}
