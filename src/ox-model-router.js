const GEMMA_31_MODEL = 'google/gemma-4-31b-it:free';
const GEMMA_26_MODEL = 'google/gemma-4-26b-a4b-it:free';
const LING_FLASH_MODEL = 'inclusionai/ling-3.0-flash:free';
const GLM_52_MODEL = 'z-ai/glm-5.2:free';
const NEMOTRON_OMNI_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const DOTS_MODEL = 'dots-studio/dots-3-note-preview:free';
const DOTS_RETIRE_AT = Date.parse('2026-10-01T00:00:00Z');
const OPENROUTER_MAX_ATTEMPTS = 3;

const MANAGED_OLD_DEFAULTS = new Set([
  'stealth/ox-alpha',
  'z-ai/glm-5.3-flash',
  GEMMA_26_MODEL,
  DOTS_MODEL,
]);

function defaultPrimary() {
  return GEMMA_31_MODEL;
}

function isExplicitFreeModel(model) {
  return String(model || '').trim().endsWith(':free');
}

function configuredFreeModel() {
  const configured = String(process.env.OX_ALPHA_MODEL || '').trim();
  if (!configured) return { configured: null, accepted: null, rejected: false, managed_old_default: false };
  if (MANAGED_OLD_DEFAULTS.has(configured)) {
    return { configured, accepted: null, rejected: false, managed_old_default: true };
  }
  if (isExplicitFreeModel(configured) && configured !== 'openrouter/free') {
    return { configured, accepted: configured, rejected: false, managed_old_default: false };
  }
  return { configured, accepted: null, rejected: true, managed_old_default: false };
}

function uniqueModels(models) {
  return [...new Set(models.filter(Boolean))].slice(0, OPENROUTER_MAX_ATTEMPTS);
}

export function oxModelPlan(attachments = []) {
  const configured = configuredFreeModel();
  const hasRichAttachment = attachments.some(file => file?.kind === 'image' || file?.kind === 'pdf');
  const primary = configured.accepted || defaultPrimary();

  // Text route emphasizes stable conversational throughput and provider diversity.
  const textFallbacks = [LING_FLASH_MODEL, GLM_52_MODEL];

  // Rich route keeps image/PDF-capable models only. Dots is retained only as a last-resort
  // temporary route while its free preview exists; it is not trusted as the primary after
  // an observed AtlasCloud opaque HTTP 400 on 2026-08-27.
  const richFallbacks = Date.now() < DOTS_RETIRE_AT
    ? [NEMOTRON_OMNI_MODEL, DOTS_MODEL]
    : [NEMOTRON_OMNI_MODEL, GEMMA_26_MODEL];

  const allModels = uniqueModels([
    primary,
    ...(hasRichAttachment ? richFallbacks : textFallbacks),
  ]);

  return {
    primary: allModels[0],
    fallbacks: allModels.slice(1),
    all_models: allModels,
    max_attempts: OPENROUTER_MAX_ATTEMPTS,
    retry_strategy: 'application_level_sequential_openrouter_requests',
    free_only: true,
    explicit_models_only: true,
    random_free_router_disabled: true,
    openrouter_models_array_disabled: true,
    has_rich_attachment: hasRichAttachment,
    configured_model: configured.configured,
    configured_model_rejected: configured.rejected,
    configured_model_managed_old_default: configured.managed_old_default,
    configured_model_rejection_reason: configured.rejected
      ? 'Only explicit :free conversational models are accepted. Paid models and openrouter/free are ignored.'
      : null,
  };
}

export function oxModelHealth() {
  const textPlan = oxModelPlan([]);
  const richPlan = oxModelPlan([{ kind: 'image' }]);
  return {
    policy: 'openrouter_explicit_free_chat_models_only',
    primary: textPlan.primary,
    fallbacks: textPlan.fallbacks,
    max_attempts: OPENROUTER_MAX_ATTEMPTS,
    configured_model: textPlan.configured_model,
    configured_model_rejected: textPlan.configured_model_rejected,
    configured_model_managed_old_default: textPlan.configured_model_managed_old_default,
    random_free_router_disabled: true,
    openrouter_models_array_disabled: true,
    excluded_model_classes: ['safety classifiers', 'rerankers', 'embedders', 'openrouter/free random router'],
    selection: {
      reviewed_at: '2026-08-27',
      primary_model: defaultPrimary(),
      primary_reason: 'Gemma 4 31B Free has two current free providers, low interactive latency, multimodal/tool support, and avoids relying on the unstable single-provider Dots preview as primary.',
      incident_notes: [
        'Gemma 4 26B Free was demoted after an observed Google AI Studio upstream 429 on 2026-08-27.',
        'Dots3-Note Preview was demoted after an observed AtlasCloud opaque HTTP 400 on 2026-08-27 and public deployment-stability caveats.',
      ],
      dots_retirement: '2026-09-30',
    },
    fallback_policy: {
      text: textPlan.all_models,
      rich_attachment: richPlan.all_models,
      handled_by: 'Response Tool sequential OpenRouter requests; each model still keeps OpenRouter provider failover enabled',
      retryable_http_statuses: [400, 408, 429, '5xx'],
      generic_400_only: true,
    },
  };
}
