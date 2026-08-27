const LEGACY_OX_MODEL = 'stealth/ox-alpha';
const GLM_FLASH_MODEL = 'z-ai/glm-5.3-flash';

let relayModulePromise = null;
let modelResolution = null;

function resolveModel() {
  if (modelResolution) return modelResolution;
  const configured = String(process.env.OX_ALPHA_MODEL || '').trim();
  const migrated = !configured || configured === LEGACY_OX_MODEL;
  const active = migrated ? GLM_FLASH_MODEL : configured;
  process.env.OX_ALPHA_MODEL = active;
  modelResolution = {
    configured: configured || null,
    active,
    migrated_from: configured === LEGACY_OX_MODEL ? LEGACY_OX_MODEL : null,
    migration_applied: migrated,
  };
  return modelResolution;
}

async function relayModule() {
  resolveModel();
  if (!relayModulePromise) relayModulePromise = import('./ox-alpha-relay.js');
  return relayModulePromise;
}

export async function oxAlphaRelay(req, res) {
  const relay = await relayModule();
  return relay.oxAlphaRelay(req, res);
}

export async function oxAlphaHistory(req, res) {
  const relay = await relayModule();
  return relay.oxAlphaHistory(req, res);
}

export async function oxAlphaHealth() {
  const resolution = resolveModel();
  const relay = await relayModule();
  const health = await relay.oxAlphaHealth();
  return {
    ...health,
    model: resolution.active,
    model_migration: {
      legacy_model: LEGACY_OX_MODEL,
      replacement_model: GLM_FLASH_MODEL,
      configured_model: resolution.configured,
      migration_applied: resolution.migration_applied,
      reason: 'The Stealth Ox Alpha testing period ended; OpenRouter identified the model as Z.AI GLM-5.3 Flash.',
    },
  };
}
