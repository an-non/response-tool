const MINIMAX_M3_MODEL = 'minimax/minimax-m3:free';
const GLM_52_MODEL = 'z-ai/glm-5.2:free';
const NEMOTRON_LIGHTNING_MODEL = 'nvidia/nemotron-3.5-lightning:free';
const NEMOTRON_OMNI_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const GEMMA_31_MODEL = 'google/gemma-4-31b-it:free';
const OPENROUTER_MAX_ATTEMPTS = 3;

const MANAGED_OLD_DEFAULTS = new Set([
  'stealth/ox-alpha',
  'z-ai/glm-5.3-flash',
  'google/gemma-4-26b-a4b-it:free',
  'dots-studio/dots-3-note-preview:free',
  'inclusionai/ling-3.0-flash:free',
]);

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
  const managedPrimary = MINIMAX_M3_MODEL;
  const primary = configured.accepted || managedPrimary;

  // Text route: multimodal/high-context primary, then two independent model families.
  const textFallbacks = [GLM_52_MODEL, NEMOTRON_LIGHTNING_MODEL];

  // Rich route: all three accept rich inputs (MiniMax M3: image/video, Nemotron Omni:
  // image/audio/video, Gemma 4: image). OpenRouter's PDF parser remains in front of them.
  const richFallbacks = [NEMOTRON_OMNI_MODEL, GEMMA_31_MODEL];

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
      primary_model: MINIMAX_M3_MODEL,
      primary_reason: 'MiniMax M3 Free is currently listed as a zero-cost multimodal 1M-context model and is heavily used in current OpenRouter agent workloads; the router no longer depends on rate-limited Gemma Free as the first hop.',
      incident_notes: [
        'Gemma 4 26B Free was demoted after an observed Google AI Studio upstream 429 on 2026-08-27.',
        'Dots3-Note Preview was removed after an observed AtlasCloud opaque HTTP 400 on 2026-08-27.',
        'Ling 3.0 Flash Free was removed after the live API returned 404 unavailable-for-free on 2026-08-27, despite the public model page still showing Free.',
        'Gemma 4 31B Free is retained only as a rich-input last fallback after repeated upstream 429s.',
      ],
    },
    fallback_policy: {
      text: textPlan.all_models,
      rich_attachment: richPlan.all_models,
      handled_by: 'Response Tool sequential OpenRouter requests; each model still keeps OpenRouter provider failover enabled',
      retryable_http_statuses: [400, 404, 408, 429, '5xx'],
      retryable_404_policy: 'free endpoint unavailable/model missing only',
      generic_400_only: true,
    },
  };
}
