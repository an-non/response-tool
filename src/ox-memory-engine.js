import {
  OX_MEMORY_BLOCK_SIZE,
  getMemoryBlock,
  getProfileMemory,
  getTurnsRange,
  saveMemoryBlock,
  saveProfileMemory,
} from './ox-memory-db.js';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MEMORY_MODEL = process.env.OX_MEMORY_MODEL || process.env.OX_ALPHA_MODEL || 'stealth/ox-alpha';
const clean = (value, limit = 800) => String(value || '').slice(0, limit).trim();
const array = value => Array.isArray(value) ? value : [];
const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
const keyOf = value => clean(value, 240).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');

function apiKey() {
  return String(process.env.Ox_API || process.env.OPENROUTER_API_KEY || process.env.OX_API || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw Error('memory_empty_response');
  const candidates = [raw, raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw Error('memory_invalid_json');
}

function normalizedSourceTurns(value, startTurn, endTurn) {
  const valid = [...new Set(array(value)
    .map(Number)
    .filter(turn => Number.isInteger(turn) && turn >= startTurn && turn <= endTurn))]
    .slice(0, OX_MEMORY_BLOCK_SIZE);
  return valid.length ? valid : Array.from({ length: endTurn - startTurn + 1 }, (_, offset) => startTurn + offset);
}

function weighted(items, field, startTurn, endTurn) {
  return array(items).slice(0, 16).map(item => ({
    [field]: clean(item?.[field] || item?.label || item?.text, 220),
    note: clean(item?.note || item?.reason, 360),
    weight: clamp01(item?.weight),
    source_turns: normalizedSourceTurns(item?.source_turns, startTurn, endTurn),
  })).filter(item => item[field]);
}

function normalizeBlock(raw, blockNo, startTurn, endTurn) {
  return {
    schema_version: 'ox-memory-1.1',
    block_no: blockNo,
    turn_range: [startTurn, endTurn],
    summary: clean(raw?.summary, 1400),
    facts: weighted(raw?.facts, 'fact', startTurn, endTurn),
    preferences: weighted(raw?.preferences, 'preference', startTurn, endTurn),
    decisions: weighted(raw?.decisions, 'decision', startTurn, endTurn),
    open_threads: weighted(raw?.open_threads, 'thread', startTurn, endTurn),
    episodic: weighted(raw?.episodic, 'event', startTurn, endTurn),
    recall_keys: [...new Set(array(raw?.recall_keys).map(value => clean(value, 140)).filter(Boolean))].slice(0, 40),
  };
}

function mergeWeighted(previous, next, field, { decay = 0.98, limit = 30 } = {}) {
  const map = new Map();
  for (const item of array(previous)) {
    const label = clean(item?.[field], 220);
    if (!label) continue;
    map.set(keyOf(label), { ...item, [field]: label, weight: clamp01(Number(item?.weight || 0) * decay) });
  }
  for (const item of array(next)) {
    const label = clean(item?.[field], 220);
    if (!label) continue;
    const id = keyOf(label), prior = map.get(id);
    map.set(id, {
      [field]: label,
      note: clean(item?.note || prior?.note, 420),
      weight: Math.max(clamp01(item?.weight), clamp01(prior?.weight)),
      source_turns: [...new Set([...array(prior?.source_turns), ...array(item?.source_turns)].map(Number).filter(Number.isInteger))].slice(-18),
    });
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

function mergeStrings(previous, next, limit = 50) {
  const out = [], seen = new Set();
  for (const item of [...array(next), ...array(previous)]) {
    const value = clean(item, 140), id = keyOf(value);
    if (!value || seen.has(id)) continue;
    seen.add(id); out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function mergeProfile(previousPayload, block, sessionId) {
  const previous = previousPayload || {};
  return {
    schema_version: 'ox-profile-memory-1.1',
    updated_from_session: sessionId,
    included_through_block: block.block_no,
    summary: clean([previous.summary, block.summary].filter(Boolean).join(' / Latest: '), 2200),
    facts: mergeWeighted(previous.facts, block.facts, 'fact', { decay: 0.995, limit: 36 }),
    preferences: mergeWeighted(previous.preferences, block.preferences, 'preference', { decay: 0.985, limit: 30 }),
    decisions: mergeWeighted(previous.decisions, block.decisions, 'decision', { decay: 0.99, limit: 30 }),
    open_threads: mergeWeighted(previous.open_threads, block.open_threads, 'thread', { decay: 0.94, limit: 24 }),
    episodic: mergeWeighted(previous.episodic, block.episodic, 'event', { decay: 0.96, limit: 24 }),
    recall_keys: mergeStrings(previous.recall_keys, block.recall_keys, 60),
  };
}

function memoryPrompt(turns, priorMemory, blockNo, startTurn, endTurn) {
  const transcript = turns.map(turn => `[Turn ${turn.turn_no}]\nUser: ${turn.request_text}\nAssistant: ${turn.response_text}`).join('\n\n');
  return [
    {
      role: 'system',
      content: [
        'You are a conservative long-term memory classifier for an AI chat.',
        'Return one JSON object only. Never invent facts.',
        'Store only information likely to be useful beyond the immediate exchange.',
        'facts: stable user/project/entity facts. preferences: durable likes, dislikes, working preferences or constraints.',
        'decisions: explicit choices, commitments, selected architectures, accepted plans.',
        'open_threads: unresolved tasks/questions that should be continued later.',
        'episodic: meaningful events worth recalling later, not routine small talk.',
        'Weights are 0..1 future usefulness. Omit low-value transient chatter.',
        `Every item must cite source_turns using only integers from ${startTurn} through ${endTurn}.`,
      ].join(' '),
    },
    {
      role: 'user',
      content: `Classify turns ${startTurn}-${endTurn} as memory block ${blockNo}.\n\nPRIOR MEMORY (context only; do not copy items without support in this block):\n${JSON.stringify(priorMemory || {}, null, 2)}\n\nTRANSCRIPT:\n${transcript}\n\nReturn exactly:\n{\n  "summary":"...",\n  "facts":[{"fact":"...","note":"...","weight":0.0,"source_turns":[${startTurn}]}],\n  "preferences":[{"preference":"...","note":"...","weight":0.0,"source_turns":[${startTurn}]}],\n  "decisions":[{"decision":"...","note":"...","weight":0.0,"source_turns":[${startTurn}]}],\n  "open_threads":[{"thread":"...","note":"...","weight":0.0,"source_turns":[${startTurn}]}],\n  "episodic":[{"event":"...","note":"...","weight":0.0,"source_turns":[${startTurn}]}],\n  "recall_keys":["..."]\n}`,
    },
  ];
}

async function callClassifier(messages) {
  const key = apiKey();
  if (!key) throw Error('ox_api_key_missing_for_memory');
  const response = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Response Tool / Ox Memory' },
    body: JSON.stringify({ model: MEMORY_MODEL, messages, stream: false, temperature: 0.1, max_tokens: 900 }),
  });
  const raw = await response.text();
  if (!response.ok) throw Error(`memory_provider_http_${response.status}:${clean(raw, 600)}`);
  let body = {};
  try { body = JSON.parse(raw); } catch {}
  const text = body?.choices?.[0]?.message?.content;
  return parseJson(text);
}

export function profileMemoryContext(row) {
  const memory = row?.payload;
  if (!memory || typeof memory !== 'object') return '';
  const useful = {
    summary: clean(memory.summary, 1600),
    facts: array(memory.facts).filter(x => Number(x.weight) >= 0.55).slice(0, 16),
    preferences: array(memory.preferences).filter(x => Number(x.weight) >= 0.5).slice(0, 14),
    decisions: array(memory.decisions).filter(x => Number(x.weight) >= 0.5).slice(0, 14),
    open_threads: array(memory.open_threads).filter(x => Number(x.weight) >= 0.45).slice(0, 12),
    episodic: array(memory.episodic).filter(x => Number(x.weight) >= 0.6).slice(0, 10),
  };
  return `LONG-TERM MEMORY (derived context; verify against current user message when conflicting):\n${JSON.stringify(useful)}`;
}

export async function compressDueBlock({ profileId, sessionId, turnNo }) {
  if (!Number.isInteger(Number(turnNo)) || Number(turnNo) < OX_MEMORY_BLOCK_SIZE || Number(turnNo) % OX_MEMORY_BLOCK_SIZE !== 0) {
    return { due: false };
  }
  const blockNo = Math.ceil(Number(turnNo) / OX_MEMORY_BLOCK_SIZE);
  const existing = await getMemoryBlock(profileId, sessionId, blockNo);
  if (existing?.status === 'ready') return { due: false, already_ready: true, block_no: blockNo };
  const startTurn = (blockNo - 1) * OX_MEMORY_BLOCK_SIZE + 1;
  const endTurn = blockNo * OX_MEMORY_BLOCK_SIZE;
  const turns = await getTurnsRange(profileId, sessionId, startTurn, endTurn);
  if (turns.length !== OX_MEMORY_BLOCK_SIZE) return { due: false, incomplete: true, block_no: blockNo };
  const prior = await getProfileMemory(profileId);
  try {
    await saveMemoryBlock({ profileId, sessionId, blockNo, startTurn, endTurn, status: 'pending', payload: {} });
    const classified = normalizeBlock(await callClassifier(memoryPrompt(turns, prior?.payload, blockNo, startTurn, endTurn)), blockNo, startTurn, endTurn);
    await saveMemoryBlock({ profileId, sessionId, blockNo, startTurn, endTurn, status: 'ready', payload: classified });
    const merged = mergeProfile(prior?.payload, classified, sessionId);
    await saveProfileMemory({ profileId, sourceSessionId: sessionId, sourceBlockNo: blockNo, payload: merged });
    return { due: true, compressed: true, block_no: blockNo };
  } catch (error) {
    await saveMemoryBlock({ profileId, sessionId, blockNo, startTurn, endTurn, status: 'error', payload: {}, error: clean(error?.message || error, 1200) }).catch(() => {});
    console.error('[ox-memory] compression failed', { profileId, sessionId, blockNo, error: String(error?.message || error) });
    return { due: true, compressed: false, block_no: blockNo, error: String(error?.message || error) };
  }
}
