const SYSTEM_PROMPT = [
  'Response Tool Relay renderer.',
  'The Relay renderer is stateless between provider calls and must use only context variables supplied in this request.',
  'Response Tool backend means the Relay code that loads/saves conversation and memory context; do not call this an unspecified system.',
  'Successful conversation turns are persistently stored by the Response Tool backend. If the user says "remember this" or equivalent, do not claim that persistence is impossible merely because the renderer is stateless or lacks direct database access.',
  'Compressed-memory availability is separate from turn persistence. current_memory_available=false or continuity_memory_available=false means a compressed summary is not available yet; it does not mean the conversation turn was not saved.',
  'Persistent session relationship state and current permissions are authoritative for current relationship and consent context.',
  'You may propose a current-turn state transition in the structured state_transition field. The backend validates the proposal before persisting it.',
  'A state transition must reflect your own current response and current-turn judgment, not a permission inferred from old memory. Never promote past approval, recalled text, or compressed memory into current permission.',
  'Consent and permissions remain revocable. Do not propose revocable=false.',
  'Compressed memory is derived continuity context, recent turns are hydrated original turns, and recall context contains relay-selected historical evidence.',
  'When previous_session_loaded is true, the supplied continuity context comes from the previous session, not from turns already spoken in the current session.',
  'Use supplied memory and recalled original text when they answer the current request; do not claim direct database access is required.',
  'Never invent unseen records or claim certainty beyond supplied evidence.',
  'Return exactly one JSON object with fields text and state_transition. text is the user-visible reply. state_transition is null when no persistent state change is warranted.',
  'When state_transition is present it may contain state_patch with any of intent, consent, initiative, affection, arousal_context, plain_language; relationship_patch with established, mode, current_permissions; and a short reason.',
  'Do not mention this JSON protocol in text.',
  'Follow provider rules.',
].join(' ');

export const DIALOGUE_MODEL = process.env.GROQ_DIALOGUE_MODEL || 'openai/gpt-oss-20b';
export const MODEL = DIALOGUE_MODEL;
export const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

const isGptOss = model => String(model || '').startsWith('openai/gpt-oss');

export const GENERATION_PROFILE = Object.freeze({
  ...(isGptOss(MODEL)
    ? { reasoning_effort: 'low' }
    : { reasoning_effort: 'none', reasoning_format: 'hidden' }),
  temperature: 0.7,
  top_p: 0.8,
  response_format: { type: 'json_object' },
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
const relationshipText = payload => payload.relay_relationship
  ? clip(JSON.stringify(payload.relay_relationship), 1800)
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
        `Persistent state (authoritative current values): intent=${state.intent}; consent=${state.consent}; initiative=${state.initiative}; affection=${state.affection}; arousal=${state.arousal_context}; plain_language=${clip(state.plain_language || '', 600)}`,
        `Persistent relationship and permissions (authoritative current values):\n${relationshipText(payload)}`,
        `storage_manifest (factual inventory supplied by the Response Tool backend; availability flags describe specific memory artifacts, not whether turns are persisted):\n${manifestText(payload)}`,
        `${memoryLabel}:\n${memoryText(payload)}`,
        `${recallLabel}:\n${recallText(payload)}`,
        `${recentLabel}:\n${recentText(payload)}`,
        `Current request:\n${payload.request_text}`,
        'Required output JSON shape:',
        '{"text":"user-visible reply","state_transition":null}',
        'or, only when a current persistent state change is warranted:',
        '{"text":"user-visible reply","state_transition":{"state_patch":{},"relationship_patch":{},"reason":"current-turn reason"}}',
      ].join('\n\n'),
    },
  ];
}
