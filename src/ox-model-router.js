const PRIMARY_MODEL = 'google/gemma-4-26b-a4b-it:free';
const FAST_TEXT_FALLBACK = 'openai/gpt-oss-20b:free';
const CAPABILITY_FALLBACK = 'openrouter/free';

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

// Snapshot of OpenRouter's public performance pages reviewed on 2026-08-27.
// The score is intentionally biased toward a smooth interactive chat experience:
// quality 30%, responsiveness 25%, reliability 20%, current app compatibility 15%, context 10%.
const CANDIDATES = [
  {
    id: PRIMARY_MODEL,
    label: 'Gemma 4 26B A4B (free)',
    intelligence_index: 27.1,
    latency_seconds: 1.08,
    throughput_tps: 37,
    uptime_percent: 99.7,
    context_tokens: 262_144,
    multimodal: true,
    tools: true,
    structured_output: true,
    role: 'primary',
  },
  {
    id: FAST_TEXT_FALLBACK,
    label: 'gpt-oss-20b (free)',
    intelligence_index: 24.5,
    latency_seconds: 0.55,
    throughput_tps: 31,
    uptime_percent: 99.6,
    context_tokens: 131_072,
    multimodal: false,
    tools: true,
    structured_output: true,
    role: 'fast_text_fallback',
  },
];

function candidateScore(candidate) {
  const quality = clamp01(candidate.intelligence_index / 30);
  const latency = clamp01((3 - candidate.latency_seconds) / 2.5);
  const throughput = clamp01(candidate.throughput_tps / 40);
  const responsiveness = latency * 0.5 + throughput * 0.5;
  const reliability = clamp01(candidate.uptime_percent / 100);
  const compatibility = candidate.multimodal && candidate.tools ? 1 : candidate.tools ? 0.67 : 0.45;
  const context = clamp01(candidate.context_tokens / 262_144);
  return Number((
    quality * 30 +
    responsiveness * 25 +
    reliability * 20 +
    compatibility * 15 +
    context * 10
  ).toFixed(1));
}

export const OX_MODEL_CANDIDATES = CANDIDATES.map(candidate => ({
  ...candidate,
  smooth_chat_score: candidateScore(candidate),
})).sort((a, b) => b.smooth_chat_score - a.smooth_chat_score);

function isFreeModel(model) {
  const value = String(model || '').trim();
  return value === CAPABILITY_FALLBACK || value.endsWith(':free');
}

function configuredFreeModel() {
  const configured = String(process.env.OX_ALPHA_MODEL || '').trim();
  if (!configured) return { configured: null, accepted: null, rejected: false };
  if (isFreeModel(configured)) return { configured, accepted: configured, rejected: false };
  return { configured, accepted: null, rejected: true };
}

export function oxModelPlan(attachments = []) {
  const configured = configuredFreeModel();
  const hasRichAttachment = attachments.some(file => file?.kind === 'image' || file?.kind === 'pdf');
  const primary = configured.accepted || PRIMARY_MODEL;
  const fallbackPool = hasRichAttachment
    ? [CAPABILITY_FALLBACK]
    : [FAST_TEXT_FALLBACK, CAPABILITY_FALLBACK];
  const fallbacks = fallbackPool.filter(model => model !== primary);
  return {
    primary,
    fallbacks,
    all_models: [primary, ...fallbacks],
    free_only: true,
    has_rich_attachment: hasRichAttachment,
    configured_model: configured.configured,
    configured_model_rejected: configured.rejected,
    configured_model_rejection_reason: configured.rejected
      ? 'Non-free OX_ALPHA_MODEL ignored to prevent accidental paid inference.'
      : null,
  };
}

export function oxModelHealth() {
  const plan = oxModelPlan([]);
  return {
    policy: 'openrouter_free_only',
    primary: plan.primary,
    fallbacks: plan.fallbacks,
    configured_model: plan.configured_model,
    configured_model_rejected: plan.configured_model_rejected,
    scoring: {
      reviewed_at: '2026-08-27',
      formula: 'quality 30% + responsiveness 25% + reliability 20% + app compatibility 15% + context 10%',
      candidates: OX_MODEL_CANDIDATES,
      selected_reason: 'Gemma 4 Free scored highest while preserving Response Tool image/PDF/tool compatibility and low interactive latency.',
    },
    fallback_policy: {
      text: [FAST_TEXT_FALLBACK, CAPABILITY_FALLBACK],
      rich_attachment: [CAPABILITY_FALLBACK],
      handled_by: 'OpenRouter models fallback routing',
    },
  };
}
