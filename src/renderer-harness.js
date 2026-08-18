const SYSTEM_PROMPT = [
  'Yuki Relay external renderer.',
  'The renderer is stateless between calls and must use only context variables supplied in this request.',
  'Response Tool backend means the Relay code that loads/saves conversation and memory context; do not call this an unspecified system.',
  'Persistent session relationship state is authoritative for current relationship and consent context.',
  'Compressed memory is derived continuity context, recent turns are hydrated original turns, and recall context contains relay-selected historical evidence.',
  'When previous_session_loaded is true, the supplied continuity context comes from the previous session, not from turns already spoken in the current session.',
  'current_memory_available or continuity_memory_available only describe compressed-memory availability; false does not mean turns are not persistently stored.',
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
  const sessionId = payload.session_id || context.session_id || 'default';
  const previousSessionLoaded = payload.previous_session_loaded === true;
  const previousSessionId = previousSessionLoaded ? String(payload.previous_session_id || 'unknown') : 'none';
  const continuitySource = previousSessionLoaded ? 'previous_session' : 'current_session';
  const recentLabel = previousSessionLoaded
    ? `previous_session_recent_turns (source_session=${previousSessionId}; not current-session turn numbering)`
    : `current_session_recent_turns (source_session=${sessionId})`;
  const memoryLabel = previousSessionLoaded
    ? `previous_session_compressed_memory (source_session=${previousSessionId}; derived continuity only)`
    : `current_session_compressed_memory (source_session=${sessionId}; derived continuity only)`;
  const recallLabel = previousSessionLoaded
    ? `previous_session_recall_context (source_session=${previousSessionId}; relay-selected historical evidence)`
    : `current_session_recall_context (source_session=${sessionId}; relay-selected historical evidence)`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Profile: ${context.profile_id}`,
        `Current session: ${sessionId}`,
        `Continuity source: ${continuitySource}`,
        `Previous session loaded: ${previousSessionLoaded}`,
        `Previous session id: ${previousSessionId}`,
        `Persistent state (authoritative for current relationship/consent): intent=${state.intent}; consent=${state.consent}; initiative=${state.initiative}; affection=${state.affection}; arousal=${state.arousal_context}`,
        `Yuki anchor:\n${state.plain_language || ''}`,
        `storage_manifest (factual inventory supplied by the Response Tool backend; availability flags describe specific memory artifacts, not whether turns are persisted):\n${manifestText(payload)}`,
        `${memoryLabel}:\n${memoryText(payload)}`,
        `${recallLabel}:\n${recallText(payload)}`,
        `${recentLabel}:\n${recentText(payload)}`,
        `Current request:\n${payload.request_text}`,
      ].join('\n\n'),
    },
  ];
}
