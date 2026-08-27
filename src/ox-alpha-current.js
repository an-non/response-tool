import { oxModelHealth, oxModelPlan } from './ox-model-router.js';

const OPENROUTER_CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const FETCH_ROUTER_MARK = Symbol.for('response-tool.ox-openrouter-free-router');
let relayModulePromise = null;
let activePlan = null;

function resolvePlan() {
  if (activePlan) return activePlan;
  activePlan = oxModelPlan([]);
  // ox-alpha-relay resolves OX_ALPHA_MODEL at module initialization time.
  // Force the scored free model before importing it, and ignore paid/legacy values.
  process.env.OX_ALPHA_MODEL = activePlan.primary;
  return activePlan;
}

function requestHasRichInput(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some(part => ['image_url', 'file', 'input_image', 'input_file'].includes(String(part?.type || '')))) return true;
  }
  return false;
}

function installOpenRouterFreeRouting() {
  if (globalThis[FETCH_ROUTER_MARK]) return;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (url === OPENROUTER_CHAT_ENDPOINT && String(init?.method || 'GET').toUpperCase() === 'POST' && typeof init?.body === 'string') {
        const payload = JSON.parse(init.body);
        const basePlan = resolvePlan();
        if (payload?.model === basePlan.primary && Array.isArray(payload?.messages)) {
          const rich = requestHasRichInput(payload.messages);
          const requestPlan = oxModelPlan(rich ? [{ kind: 'image' }] : []);
          delete payload.model;
          payload.models = requestPlan.all_models;
          payload.provider = {
            ...(payload.provider || {}),
            allow_fallbacks: true,
            sort: { by: 'latency', partition: 'model' },
          };
          init = { ...init, body: JSON.stringify(payload) };
        }
      }
    } catch (error) {
      console.warn('[ox-model-router] request transform skipped', { error: String(error?.message || error) });
    }
    return nativeFetch(input, init);
  };
  globalThis[FETCH_ROUTER_MARK] = true;
}

async function relayModule() {
  resolvePlan();
  installOpenRouterFreeRouting();
  if (!relayModulePromise) relayModulePromise = import('./ox-alpha-relay.js');
  return relayModulePromise;
}

export async function oxAlphaRelay(req, res) {
  resolvePlan();
  installOpenRouterFreeRouting();
  const relay = await relayModule();
  return relay.oxAlphaRelay(req, res);
}

export async function oxAlphaHistory(req, res) {
  const relay = await relayModule();
  return relay.oxAlphaHistory(req, res);
}

export async function oxAlphaHealth() {
  const plan = resolvePlan();
  installOpenRouterFreeRouting();
  const relay = await relayModule();
  const health = await relay.oxAlphaHealth();
  return {
    ...health,
    model: plan.primary,
    pricing_policy: 'free_only',
    model_router: {
      ...oxModelHealth(),
      active: true,
      request_routing: {
        model_fallbacks: true,
        provider_sort: { by: 'latency', partition: 'model' },
        paid_model_guard: true,
      },
    },
    model_migration: {
      legacy_model: 'stealth/ox-alpha',
      paid_successor_not_selected: 'z-ai/glm-5.3-flash',
      replacement_model: plan.primary,
      configured_model: plan.configured_model,
      configured_model_rejected: plan.configured_model_rejected,
      reason: plan.configured_model_rejected
        ? 'A non-free configured model was ignored to prevent accidental paid inference.'
        : 'Ox Alpha ended; Response Tool now uses the highest-scoring reviewed OpenRouter free model for smooth interactive chat.',
    },
  };
}
