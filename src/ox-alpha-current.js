import { oxModelHealth, oxModelPlan } from './ox-model-router.js';

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

async function relayModule() {
  resolvePlan();
  if (!relayModulePromise) relayModulePromise = import('./ox-alpha-relay.js');
  return relayModulePromise;
}

export async function oxAlphaRelay(req, res) {
  resolvePlan();
  const relay = await relayModule();
  return relay.oxAlphaRelay(req, res);
}

export async function oxAlphaHistory(req, res) {
  const relay = await relayModule();
  return relay.oxAlphaHistory(req, res);
}

export async function oxAlphaHealth() {
  const plan = resolvePlan();
  const relay = await relayModule();
  const health = await relay.oxAlphaHealth();
  return {
    ...health,
    model: plan.primary,
    pricing_policy: 'free_only',
    model_router: oxModelHealth(),
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
