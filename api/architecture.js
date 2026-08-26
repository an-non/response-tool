import { architectureRoute } from '../src/app.js';
import { oxAlphaHealth, oxAlphaHistory, oxAlphaRelay } from '../src/ox-alpha-relay.js';
import { artifactLimits, artifactTestResponse, decorateOxResponse } from '../src/ox-artifacts.js';

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

function artifactAwareResponse(req, res) {
  return new Proxy(res, {
    get(target, prop, receiver) {
      if (prop === 'end') {
        return body => {
          let output = body;
          if (typeof body === 'string') {
            try {
              const parsed = JSON.parse(body);
              output = JSON.stringify(decorateOxResponse(req.body?.request_text || '', parsed));
            } catch {}
          }
          return target.end(output);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export default async function handler(req, res) {
  const mode = String(req.query?.mode || '');
  if (req.method === 'POST' && mode === 'ox-alpha') {
    return oxAlphaRelay(req, artifactAwareResponse(req, res));
  }
  if (req.method === 'GET' && mode === 'ox-alpha-health') {
    const health = await oxAlphaHealth();
    return json(res, 200, {
      ...health,
      artifacts: {
        enabled: true,
        mode: 'inline_text',
        persistent: false,
        test_endpoint: '/api/architecture?mode=ox-alpha-artifact-test',
        ...artifactLimits,
      },
    });
  }
  if (req.method === 'GET' && mode === 'ox-alpha-artifact-test') {
    return json(res, 200, artifactTestResponse());
  }
  if (req.method === 'GET' && mode === 'ox-alpha-history') {
    return oxAlphaHistory(req, res);
  }
  return architectureRoute(req, res);
}
