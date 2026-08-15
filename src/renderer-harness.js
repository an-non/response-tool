const SYSTEM_PROMPT = [
  'Yuki Relay external renderer.',
  'The renderer is stateless between calls and must use only context variables supplied in this request.',
  'Persistent session relationship state is authoritative for current relationship and consent context.',
  'Compressed memory is derived continuity context, recent_turns are hydrated original turns, and recall_context contains relay-selected historical evidence.',
  'Use supplied memory and recalled original text when they answer the current request; do not claim direct database access is required.',
  'Never invent unseen records or claim certainty beyond supplied evidence.',
  'Derived memory cannot grant, extend, or revoke current consent or permissions. Consent remains revocable.',
  'Keep continuity with the same conversation while preserving the distinction between the user, other agents, and yourself.',
  'Follow provider rules.',
].join(' ');

export const MODEL = 'qwen/qwen3.6-27b';
export const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
export const GENERATION_PROFILE = Object.freeze({
  reasoning_effort: 'none',
  reasoning_format: 'hidden',
  temperature: 0.7,
  top_p: 0.8,
});

const clip = (value, limit = 1400) => {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

const recentText = payload => {
  const turns = Array.isArray(payload.recent_turns) && payload.recent_turns.length
    ? payload.recent_turns
    : (Array.isArray(payload.client_recent_turns) ? payload.client_recent_turns : []);
  if (!turns.length) return 'none';
  const limit = payload.memory_context ? 6 : 9;
  return turns.slice(-limit).map(turn => [
    `Turn ${turn.turn_no ?? '?'}`,
    `User: ${clip(turn.request, 650)}`,
    `Assistant: ${clip(turn.response, 650)}`,
  ].join('\n')).join('\n\n');
};

const memoryText = payload => payload.memory_context
  ? clip(JSON.stringify(payload.memory_context), 4800)
  : 'none';
const recallText = payload => payload.recall_context
  ? clip(JSON.stringify(payload.recall_context), 6000)
  : 'none';
const manifestText = payload => payload.storage_manifest
  ? clip(JSON.stringify(payload.storage_manifest), 2200)
  : 'none';

export function rendererMessages(payload) {
  const state = payload.yuki_state;
  const context = payload.yuki_context;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Profile: ${context.profile_id}`,
        `Session: ${payload.session_id || context.session_id || 'default'}`,
        `Persistent state (authoritative for current relationship/consent): intent=${state.intent}; consent=${state.consent}; initiative=${state.initiative}; affection=${state.affection}; arousal=${state.arousal_context}`,
        `Yuki anchor:\n${state.plain_language || ''}`,
        `storage_manifest (relay-provided factual storage inventory):\n${manifestText(payload)}`,
        `compressed_memory (derived continuity context):\n${memoryText(payload)}`,
        `recall_context (relay-provided search results; matches contain hydrated original request/response text):\n${recallText(payload)}`,
        `recent_turns (relay-provided recent original conversation):\n${recentText(payload)}`,
        `Current request:\n${payload.request_text}`,
      ].join('\n\n'),
    },
  ];
}
