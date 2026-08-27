import { oxModelHealth, oxModelPlan } from './ox-model-router.js';

const OPENROUTER_CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const FETCH_ROUTER_MARK = Symbol.for('response-tool.ox-openrouter-free-router');
const UNAVAILABLE_FREE_MODELS = Symbol.for('response-tool.ox-unavailable-free-models');
let relayModulePromise = null;
let activePlan = null;

function resolvePlan() {
  if (activePlan) return activePlan;
  activePlan = oxModelPlan([]);
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

function unavailableModels() {
  if (!globalThis[UNAVAILABLE_FREE_MODELS]) globalThis[UNAVAILABLE_FREE_MODELS] = new Set();
  return globalThis[UNAVAILABLE_FREE_MODELS];
}

function isGenericRetryable400(status, detail) {
  if (status !== 400) return false;
  const text = String(detail || '').toLowerCase();
  return text.includes('"msg":"bad request"') || text.includes('bad request') || text.includes('invalid_request_error');
}

function isUnavailableFree404(status, detail) {
  if (status !== 404) return false;
  const text = String(detail || '').toLowerCase();
  return text.includes('unavailable for free') ||
    text.includes('model not found') ||
    text.includes('no endpoints found') ||
    text.includes('no endpoint found') ||
    text.includes('not available');
}

function retryableStatus(status, detail) {
  return isGenericRetryable400(status, detail) ||
    isUnavailableFree404(status, detail) ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599);
}

async function responseDetail(response) {
  try {
    const raw = await response.clone().text();
    if (!raw) return null;
    try {
      const body = JSON.parse(raw);
      return String(
        body?.error?.metadata?.raw ||
        body?.error?.message ||
        body?.message ||
        raw,
      ).slice(0, 800);
    } catch {
      return raw.slice(0, 800);
    }
  } catch {
    return null;
  }
}

function installOpenRouterFreeRouting() {
  if (globalThis[FETCH_ROUTER_MARK]) return;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    const isChatPost = url === OPENROUTER_CHAT_ENDPOINT &&
      String(init?.method || 'GET').toUpperCase() === 'POST' &&
      typeof init?.body === 'string';

    if (!isChatPost) return nativeFetch(input, init);

    let payload;
    try { payload = JSON.parse(init.body); }
    catch { return nativeFetch(input, init); }

    const basePlan = resolvePlan();
    if (payload?.model !== basePlan.primary || !Array.isArray(payload?.messages)) return nativeFetch(input, init);

    const rich = requestHasRichInput(payload.messages);
    const requestPlan = oxModelPlan(rich ? [{ kind: 'image' }] : []);
    const blocked = unavailableModels();
    const candidates = requestPlan.all_models.filter(model => !blocked.has(model));
    const models = candidates.length ? candidates : requestPlan.all_models;
    let lastResponse = null;

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      const attemptPayload = {
        ...payload,
        model,
        provider: {
          ...(payload.provider || {}),
          allow_fallbacks: true,
          sort: 'latency',
        },
      };
      delete attemptPayload.models;
      // Cross-provider free models do not all accept OpenRouter's optional reasoning config.
      delete attemptPayload.reasoning;

      const startedAt = Date.now();
      try {
        const response = await nativeFetch(input, { ...init, body: JSON.stringify(attemptPayload) });
        lastResponse = response;
        const elapsedMs = Date.now() - startedAt;

        if (response.ok) {
          console.info('[ox-model-router] model succeeded', {
            model,
            attempt: index + 1,
            max_attempts: models.length,
            elapsed_ms: elapsedMs,
            rich_input: rich,
          });
          return response;
        }

        const detail = await responseDetail(response);
        if (isUnavailableFree404(response.status, detail)) blocked.add(model);
        const retry = retryableStatus(response.status, detail) && index < models.length - 1;
        console.warn('[ox-model-router] model rejected', {
          model,
          attempt: index + 1,
          max_attempts: models.length,
          status: response.status,
          elapsed_ms: elapsedMs,
          retrying: retry,
          marked_unavailable: blocked.has(model),
          detail,
        });

        if (!retry) return response;
      } catch (error) {
        console.warn('[ox-model-router] model request failed', {
          model,
          attempt: index + 1,
          max_attempts: models.length,
          retrying: index < models.length - 1,
          error: String(error?.message || error),
        });
        if (index >= models.length - 1) throw error;
      }
    }

    return lastResponse || nativeFetch(input, init);
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
      runtime_unavailable_models: [...unavailableModels()],
      request_routing: {
        application_level_model_retries: true,
        max_attempts: plan.max_attempts,
        retryable_http_statuses: [400, 404, 408, 429, '5xx'],
        retryable_400_policy: 'generic upstream bad-request only',
        retryable_404_policy: 'expired or unavailable free endpoint only',
        openrouter_models_array: false,
        provider_fallbacks_within_model: true,
        provider_sort: 'latency',
        optional_reasoning_parameter_removed: true,
        paid_model_guard: true,
      },
    },
    model_migration: {
      legacy_model: 'stealth/ox-alpha',
      paid_successor_not_selected: 'z-ai/glm-5.3-flash',
      replacement_model: plan.primary,
      configured_model: plan.configured_model,
      configured_model_rejected: plan.configured_model_rejected,
      configured_model_managed_old_default: plan.configured_model_managed_old_default,
      reason: plan.configured_model_rejected
        ? 'A non-free configured model was ignored to prevent accidental paid inference.'
        : 'Ox Alpha ended; Response Tool now uses explicit free models with application-level failover for upstream errors, expired free endpoints, and rate limits.',
    },
  };
}
