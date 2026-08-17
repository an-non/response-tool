import { MODEL, GROQ } from './renderer-harness.js';
import { MEMORY_BLOCK_SIZE } from './config.js';
import {
  getTurnsRange,
  getLatestMemoryState,
  getMemoryBlock,
  getMemoryIndex,
  getMemorySnapshot,
  getDueMemoryBlockNos,
  readSessionManifest,
  saveMemoryBlock,
  saveMemoryState,
} from './conversation-store.js';

export const MEMORY_MODEL = process.env.GROQ_MEMORY_MODEL || 'openai/gpt-oss-20b';
const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
const cleanText = (value, limit = 600) => String(value || '').slice(0, limit);
const array = value => (Array.isArray(value) ? value : []);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const usableStatus = status => status === 'ready' || status === 'degraded';

class MemoryProviderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MemoryProviderError';
    Object.assign(this, details);
  }
}

function normalizeSourceTurns(value, startTurn, endTurn) {
  const explicit = array(value)
    .map(Number)
    .filter(turn => Number.isInteger(turn) && turn >= startTurn && turn <= endTurn)
    .slice(0, MEMORY_BLOCK_SIZE);
  if (explicit.length) return explicit;
  return Array.from({ length: endTurn - startTurn + 1 }, (_, offset) => startTurn + offset);
}

function normalizeWeighted(items, key = 'label', startTurn = 1, endTurn = Number.MAX_SAFE_INTEGER) {
  return array(items)
    .slice(0, 12)
    .map(item => ({
      [key]: cleanText(item?.[key] || item?.topic || item?.name, 160),
      weight: clamp01(item?.weight),
      note: cleanText(item?.note || item?.summary, 260),
      source_turns: normalizeSourceTurns(item?.source_turns, startTurn, endTurn),
    }))
    .filter(item => item[key]);
}

function exactRecallKeys(turns) {
  const text = turns.map(turn => `${turn.request_text}\n${turn.response_text}`).join('\n');
  const values = [];
  for (const match of text.matchAll(/[「『"']([^」』"']{2,100})[」』"']/g)) values.push(match[1]);
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9._/+:-]*(?:[ -][A-Za-z0-9][A-Za-z0-9._/+:-]*){0,3}/g)) values.push(match[0]);
  for (const match of text.matchAll(/(?:^|[^0-9])([0-9]{1,6}(?:\.[0-9]+)?(?:%|件|回|ターン|tokens?|TPM|RPM)?)/gi)) values.push(match[1]);
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const item = cleanText(value, 120).trim();
    const key = item.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
    if (!item || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= 32) break;
  }
  return output;
}

function provisionalBlockMemory(turns, blockNo, startTurn, endTurn) {
  const sourceTurns = turns.map(turn => Number(turn.turn_no)).filter(Number.isInteger);
  const summary = cleanText(
    turns.map(turn => `T${turn.turn_no} User: ${cleanText(turn.request_text, 260)} / Yuki: ${cleanText(turn.response_text, 220)}`).join(' | '),
    1400,
  );
  return {
    schema_version: '1.1-provisional',
    block_no: blockNo,
    turn_range: [startTurn, endTurn],
    summary,
    identity_facts: [],
    important_topics: [],
    approval: [],
    conversation_flow: [{
      label: `Turns ${startTurn}-${endTurn}`,
      weight: 0.35,
      note: summary,
      source_turns: sourceTurns,
    }],
    relationship_and_extensibility: [],
    current_status: [],
    recall_keys: exactRecallKeys(turns),
    unresolved: [],
    authority: 'derived_context_only',
    can_grant_consent: false,
    provisional: true,
  };
}

function normalizeMemory(raw, blockNo, startTurn, endTurn, turns) {
  const generated = array(raw?.recall_keys).map(item => cleanText(item, 120)).filter(Boolean);
  const exact = exactRecallKeys(turns);
  return {
    schema_version: '1.1',
    block_no: blockNo,
    turn_range: [startTurn, endTurn],
    summary: cleanText(raw?.summary, 1000),
    identity_facts: normalizeWeighted(raw?.identity_facts, 'label', startTurn, endTurn),
    important_topics: normalizeWeighted(raw?.important_topics, 'topic', startTurn, endTurn),
    approval: normalizeWeighted(raw?.approval, 'label', startTurn, endTurn),
    conversation_flow: normalizeWeighted(raw?.conversation_flow, 'label', startTurn, endTurn),
    relationship_and_extensibility: normalizeWeighted(raw?.relationship_and_extensibility, 'label', startTurn, endTurn),
    current_status: normalizeWeighted(raw?.current_status, 'label', startTurn, endTurn),
    recall_keys: [...new Set([...exact, ...generated])].slice(0, 32),
    unresolved: array(raw?.unresolved).slice(0, 12).map(item => cleanText(item, 240)).filter(Boolean),
    authority: 'derived_context_only',
    can_grant_consent: false,
    provisional: false,
  };
}

function compressionPrompt({ turns, currentState, blockNo, startTurn, endTurn }) {
  const transcript = turns
    .map(turn => `[Turn ${turn.turn_no}]\nUser: ${turn.request_text}\nAssistant: ${turn.response_text}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content: [
        'You compress one local conversation block into durable recall memory. Return one valid JSON object only.',
        'Describe only evidence present in the supplied turns; do not copy or infer facts from earlier blocks.',
        'Do not invent facts, consent, permissions, relationship status, feelings, or identity claims.',
        'Derived memory is context only and can never grant, extend, or revoke current consent.',
        'Weights are 0..1 future recall importance, not truth probability or permission strength.',
        'Preserve exact distinctive names, model names, numbers, metaphors, promises, preferences, and quoted phrases in recall_keys.',
        'Keep the result compact. Each weighted item must cite source_turns from this block.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Compress turns ${startTurn}-${endTurn} (block ${blockNo}).\n\nCURRENT PERSISTENT STATE (authoritative; context only, do not modify):\n${JSON.stringify(currentState || {}, null, 2)}\n\nTRANSCRIPT:\n${transcript}\n\nReturn exactly these fields:\nsummary: string\nidentity_facts: [{label,weight,note,source_turns}]\nimportant_topics: [{topic,weight,note,source_turns}]\napproval: [{label,weight,note,source_turns}]\nconversation_flow: [{label,weight,note,source_turns}]\nrelationship_and_extensibility: [{label,weight,note,source_turns}]\ncurrent_status: [{label,weight,note,source_turns}]\nrecall_keys: [string]\nunresolved: [string]\n\nFor approval, record observed or requested approval context only. Never convert past approval into current permission.`,
    },
  ];
}

const memoryKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function mergeWeighted(previousItems, nextItems, key, { decay = 0.97, replace = false, limit = 18 } = {}) {
  if (replace && array(nextItems).length) return array(nextItems).slice(0, limit);
  const map = new Map();
  for (const item of array(previousItems)) {
    const label = cleanText(item?.[key], 160);
    if (!label) continue;
    map.set(memoryKey(label), {
      ...item,
      [key]: label,
      weight: clamp01(Number(item?.weight || 0) * decay),
      source_turns: array(item?.source_turns).map(Number).filter(Number.isInteger).slice(-18),
    });
  }
  for (const item of array(nextItems)) {
    const label = cleanText(item?.[key], 160);
    if (!label) continue;
    const id = memoryKey(label);
    const old = map.get(id);
    map.set(id, {
      [key]: label,
      weight: Math.max(clamp01(item?.weight), clamp01(old?.weight)),
      note: cleanText(item?.note || old?.note, 300),
      source_turns: [...new Set([
        ...array(old?.source_turns).map(Number),
        ...array(item?.source_turns).map(Number),
      ].filter(Number.isInteger))].slice(-18),
    });
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

function mergeStrings(previousItems, nextItems, limit) {
  const output = [];
  const seen = new Set();
  for (const value of [...array(nextItems), ...array(previousItems)]) {
    const text = cleanText(value, 240);
    const id = memoryKey(text);
    if (!text || seen.has(id)) continue;
    seen.add(id);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function mergeMemory(previous, blockMemory) {
  const prior = previous || {};
  const latest = blockMemory || {};
  const summaryParts = [cleanText(prior.summary, 900), cleanText(latest.summary, 900)].filter(Boolean);
  return {
    schema_version: '1.2',
    source_block_no: latest.block_no || null,
    included_through_turn: array(latest.turn_range).at(-1) || null,
    summary: cleanText(summaryParts.join(' / Latest: '), 1600),
    identity_facts: mergeWeighted(prior.identity_facts, latest.identity_facts, 'label', { decay: 0.995, limit: 24 }),
    important_topics: mergeWeighted(prior.important_topics, latest.important_topics, 'topic', { decay: 0.96, limit: 24 }),
    approval: mergeWeighted(prior.approval, latest.approval, 'label', { decay: 0.94, limit: 18 }),
    conversation_flow: mergeWeighted(prior.conversation_flow, latest.conversation_flow, 'label', { decay: 0.9, limit: 18 }),
    relationship_and_extensibility: mergeWeighted(prior.relationship_and_extensibility, latest.relationship_and_extensibility, 'label', { decay: 0.96, limit: 18 }),
    current_status: mergeWeighted(prior.current_status, latest.current_status, 'label', { decay: 0.8, replace: true, limit: 12 }),
    recall_keys: mergeStrings(prior.recall_keys, latest.recall_keys, 40),
    unresolved: mergeStrings(prior.unresolved, latest.unresolved, 20),
    authority: 'derived_context_only',
    can_grant_consent: false,
  };
}

function aggregateFromIndex(index) {
  const entries = array(index?.entries)
    .filter(entry => usableStatus(entry.status))
    .sort((left, right) => Number(left.block_no) - Number(right.block_no));
  let aggregate = null;
  for (const entry of entries) {
    aggregate = mergeMemory(aggregate, {
      block_no: entry.block_no,
      turn_range: [entry.start_turn, entry.end_turn],
      summary: entry.summary,
      identity_facts: entry.identity_facts,
      important_topics: entry.important_topics,
      approval: entry.approval,
      conversation_flow: entry.conversation_flow,
      relationship_and_extensibility: entry.relationship_and_extensibility,
      current_status: entry.current_status,
      recall_keys: entry.recall_keys,
      unresolved: entry.unresolved,
    });
  }
  return aggregate;
}

function parseDurationMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.ceil(Number(text) * 1000);
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total += unit === 'ms' ? amount : unit === 's' ? amount * 1000 : unit === 'm' ? amount * 60_000 : amount * 3_600_000;
  }
  return matched ? Math.ceil(total) : null;
}

function rateLimitFromResponse(response) {
  return {
    retry_after_ms: parseDurationMs(response.headers.get('retry-after')),
    limit_tokens: Number(response.headers.get('x-ratelimit-limit-tokens')) || null,
    remaining_tokens: Number(response.headers.get('x-ratelimit-remaining-tokens')) || 0,
    reset_tokens: response.headers.get('x-ratelimit-reset-tokens') || null,
    reset_tokens_ms: parseDurationMs(response.headers.get('x-ratelimit-reset-tokens')),
    remaining_requests: Number(response.headers.get('x-ratelimit-remaining-requests')) || 0,
  };
}

function providerError(body) {
  return {
    code: typeof body?.error?.code === 'string' ? body.error.code : null,
    message: cleanText(body?.error?.message || body?.message || '', 500),
  };
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) throw Error('memory_provider_empty');
  try { return JSON.parse(raw); } catch {}
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(unfenced); } catch {}
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
  throw Error('memory_provider_invalid_json');
}

async function callMemoryProvider(messages) {
  const models = [...new Set([MEMORY_MODEL, MODEL].filter(Boolean))];
  let last = null;
  for (const model of models) {
    const requestBody = JSON.stringify({
      model,
      messages,
      stream: false,
      reasoning_effort: model.startsWith('openai/gpt-oss') ? 'low' : 'none',
      reasoning_format: 'hidden',
      response_format: { type: 'json_object' },
      temperature: 0.15,
      top_p: 0.8,
      max_completion_tokens: 700,
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response;
      let body = {};
      try {
        response = await fetch(GROQ, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: requestBody,
        });
        body = await response.json().catch(() => ({}));
      } catch (transportError) {
        last = { response: null, body: {}, rateLimit: null, error: { code: 'transport_error', message: String(transportError?.message || transportError) }, attempt, model };
        if (attempt < 3) {
          await sleep(attempt * 1500 + Math.floor(Math.random() * 350));
          continue;
        }
        throw new MemoryProviderError('memory_provider_transport_error', {
          retryable: true,
          providerHttpStatus: null,
          providerErrorCode: 'transport_error',
          providerMessage: String(transportError?.message || transportError),
          rateLimit: null,
          attempts: attempt,
          nextRetryAt: new Date(Date.now() + 15_000).toISOString(),
          model,
        });
      }
      const rateLimit = rateLimitFromResponse(response);
      const error = providerError(body);
      last = { response, body, rateLimit, error, attempt, model };
      if (response.ok) {
        const text = body?.choices?.[0]?.message?.content;
        return { raw: parseJsonObject(text), rateLimit, attempt, model: body?.model || model };
      }
      const unsupportedForThisModel = response.status === 400 || response.status === 404;
      if (unsupportedForThisModel && model !== models.at(-1)) break;
      const retryable = response.status === 429 || response.status === 498 || response.status >= 500;
      if (!retryable) {
        throw new MemoryProviderError(`memory_provider_http_${response.status}`, {
          retryable: false,
          providerHttpStatus: response.status,
          providerErrorCode: error.code,
          providerMessage: error.message,
          rateLimit,
          attempts: attempt,
          model,
        });
      }
      const suggested = rateLimit.retry_after_ms ?? rateLimit.reset_tokens_ms ?? attempt * 2000;
      if (attempt < 3 && suggested <= 12_000) {
        await sleep(Math.max(750, suggested + 250 + Math.floor(Math.random() * 500)));
        continue;
      }
      const nextRetryMs = Math.max(5_000, Math.min(suggested || 15_000, 60_000));
      throw new MemoryProviderError(`memory_provider_http_${response.status}`, {
        retryable: true,
        providerHttpStatus: response.status,
        providerErrorCode: error.code,
        providerMessage: error.message,
        rateLimit,
        attempts: attempt,
        nextRetryAt: new Date(Date.now() + nextRetryMs).toISOString(),
        model,
      });
    }
  }
  const suggested = last?.rateLimit?.retry_after_ms ?? last?.rateLimit?.reset_tokens_ms ?? 15_000;
  throw new MemoryProviderError('memory_provider_failed', {
    retryable: true,
    providerHttpStatus: last?.response?.status || null,
    providerErrorCode: last?.error?.code || null,
    providerMessage: last?.error?.message || null,
    rateLimit: last?.rateLimit || null,
    attempts: last?.attempt || 0,
    nextRetryAt: new Date(Date.now() + Math.max(5_000, Math.min(suggested, 60_000))).toISOString(),
    model: last?.model || MEMORY_MODEL,
  });
}

export function recommendedCompressionDelayMs(rateLimit) {
  if (!rateLimit) return 750;
  const remaining = Number(rateLimit.remaining_tokens);
  const reset = parseDurationMs(rateLimit.reset_tokens);
  if (Number.isFinite(remaining) && remaining < 3500 && reset != null) {
    return Math.max(750, Math.min(reset + 300, 15_000));
  }
  return 750;
}

async function rebuildCurrentMemory(profileId, sessionId) {
  const index = await getMemoryIndex(profileId, sessionId);
  const aggregate = aggregateFromIndex(index);
  if (!aggregate) return false;
  const sourceBlockNo = Math.max(0, ...array(index.entries).filter(entry => usableStatus(entry.status)).map(entry => Number(entry.block_no || 0)));
  await saveMemoryState({ profileId, sessionId, sourceBlockNo, memory: aggregate });
  return true;
}

export async function compressMemoryBlock({ profileId, sessionId, blockNo, currentState }) {
  const startTurn = (blockNo - 1) * MEMORY_BLOCK_SIZE + 1;
  const endTurn = blockNo * MEMORY_BLOCK_SIZE;
  const turns = await getTurnsRange(profileId, sessionId, startTurn, endTurn);
  if (turns.length < MEMORY_BLOCK_SIZE) {
    return { compressed: false, usable: false, reason: 'block_incomplete', count: turns.length, block_no: blockNo };
  }

  const previousAttempt = await getMemoryBlock(profileId, sessionId, blockNo);
  const attempts = Number(previousAttempt?.attempts || 0) + 1;
  const provisional = provisionalBlockMemory(turns, blockNo, startTurn, endTurn);
  await saveMemoryBlock({
    profileId,
    sessionId,
    blockNo,
    startTurn,
    endTurn,
    memory: provisional,
    status: 'pending',
    attempts,
    retryable: true,
    model: MEMORY_MODEL,
  });

  try {
    if (!process.env.GROQ_API_KEY) throw new MemoryProviderError('groq_api_key_missing', { retryable: true });
    const result = await callMemoryProvider(compressionPrompt({ turns, currentState, blockNo, startTurn, endTurn }));
    const memory = normalizeMemory(result.raw, blockNo, startTurn, endTurn, turns);
    await saveMemoryBlock({
      profileId,
      sessionId,
      blockNo,
      startTurn,
      endTurn,
      memory,
      status: 'ready',
      attempts,
      retryable: true,
      rateLimit: result.rateLimit,
      model: result.model,
    });
    await rebuildCurrentMemory(profileId, sessionId);
    console.log(JSON.stringify({
      event: 'memory_compression_ready',
      profile_id: profileId,
      session_id: sessionId,
      block_no: blockNo,
      attempts,
      model: result.model,
    }));
    return { compressed: true, usable: true, degraded: false, block_no: blockNo, memory, attempts, model: result.model };
  } catch (error) {
    const retryable = error?.retryable !== false;
    const nextRetryAt = error?.nextRetryAt || (retryable ? new Date(Date.now() + 15_000).toISOString() : null);
    await saveMemoryBlock({
      profileId,
      sessionId,
      blockNo,
      startTurn,
      endTurn,
      memory: provisional,
      status: 'degraded',
      error: {
        code: String(error?.message || error),
        provider_message: error?.providerMessage || null,
      },
      attempts: Number(error?.attempts || attempts),
      retryable,
      nextRetryAt,
      providerHttpStatus: error?.providerHttpStatus || null,
      providerErrorCode: error?.providerErrorCode || null,
      rateLimit: error?.rateLimit || null,
      model: error?.model || MEMORY_MODEL,
    }).catch(() => {});
    await rebuildCurrentMemory(profileId, sessionId).catch(() => {});
    console.error(JSON.stringify({
      event: 'memory_compression_degraded',
      profile_id: profileId,
      session_id: sessionId,
      block_no: blockNo,
      error: String(error?.message || error),
      retryable,
      next_retry_at: nextRetryAt,
      provider_http_status: error?.providerHttpStatus || null,
      provider_error_code: error?.providerErrorCode || null,
      model: error?.model || MEMORY_MODEL,
    }));
    return {
      compressed: false,
      usable: true,
      degraded: true,
      block_no: blockNo,
      reason: String(error?.message || error),
      retryable,
      next_retry_at: nextRetryAt,
    };
  }
}

export async function compressPendingMemoryBlocks({ profileId, sessionId, currentState, maxBlocks = 1 }) {
  const due = await getDueMemoryBlockNos(profileId, sessionId, maxBlocks);
  const results = [];
  for (const blockNo of due) {
    const result = await compressMemoryBlock({ profileId, sessionId, blockNo, currentState });
    results.push(result);
    if (!result.usable) break;
  }
  return { due_block_nos: due, results };
}

export async function getRuntimeMemoryContext(profileId, sessionId, suppliedSnapshot = null) {
  const snapshot = suppliedSnapshot || await getMemorySnapshot(profileId, sessionId);
  const state = snapshot.current;
  const recent = array(snapshot.recent_turns).slice(-(state?.memory ? 6 : 9));
  if (state?.memory) {
    return {
      blob_configured: true,
      memory: state.memory,
      source_block_no: state.source_block_no || null,
      memory_source: 'current',
      recent_turns: recent,
    };
  }
  const latestEntry = array(snapshot.index?.entries)
    .filter(entry => usableStatus(entry.status))
    .sort((left, right) => Number(right.block_no) - Number(left.block_no))[0];
  const latestBlock = latestEntry ? await getMemoryBlock(profileId, sessionId, latestEntry.block_no) : null;
  return {
    blob_configured: true,
    memory: latestBlock?.memory || null,
    source_block_no: latestBlock?.block_no || null,
    memory_source: latestBlock ? `latest_${latestBlock.status}_block_fallback` : 'none',
    recent_turns: recent,
  };
}

const normalize = value => String(value || '')
  .toLowerCase()
  .normalize('NFKC')
  .replace(/[\s\u3000、。,.!?！？:;；()（）\[\]{}「」『』【】"'`~〜ー・/\\_-]+/g, '');

function querySignals(query) {
  const raw = String(query || '').normalize('NFKC');
  const compact = normalize(raw);
  const quoted = [...raw.matchAll(/[「『"']([^」』"']{2,80})[」』"']/g)].map(match => normalize(match[1]));
  const latin = raw.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{1,80}/g) || [];
  const segments = raw
    .split(/[\s\u3000、。,.!?！？:;；()（）\[\]{}「」『』【】]+/)
    .map(normalize)
    .filter(part => part.length >= 2 && part.length <= 40);
  const grams = new Set();
  const source = compact.slice(0, 80);
  for (const size of [2, 3, 4]) {
    for (let index = 0; index <= source.length - size && grams.size < 120; index += 1) grams.add(source.slice(index, index + size));
  }
  return {
    raw,
    compact,
    phrases: [...new Set([...quoted, ...latin.map(normalize), ...segments])],
    grams: [...grams],
    explicitRecall: /(前|以前|過去|最初|はじめ|当初|さっき|先ほど|覚え|記憶|履歴|思い出|振り返|何て言|何と言|どのモデル|保存|昔)/.test(raw),
    earliest: /(最初|はじめ|当初|初め)/.test(raw),
  };
}

function weightedFields(entry) {
  const memoryFields = [
    entry.summary,
    ...array(entry.recall_keys),
    ...array(entry.identity_facts).map(item => `${item.label} ${item.note || ''}`),
    ...array(entry.important_topics).map(item => `${item.topic} ${item.note || ''}`),
    ...array(entry.approval).map(item => `${item.label} ${item.note || ''}`),
    ...array(entry.conversation_flow).map(item => `${item.label} ${item.note || ''}`),
    ...array(entry.relationship_and_extensibility).map(item => `${item.label} ${item.note || ''}`),
    ...array(entry.current_status).map(item => `${item.label} ${item.note || ''}`),
  ].filter(Boolean);
  const weights = [
    ...array(entry.identity_facts),
    ...array(entry.important_topics),
    ...array(entry.approval),
    ...array(entry.relationship_and_extensibility),
    ...array(entry.current_status),
  ].map(item => clamp01(item.weight));
  return { text: normalize(memoryFields.join(' ')), maxWeight: weights.length ? Math.max(...weights) : 0 };
}

function relevanceScore(entry, signals) {
  const fields = weightedFields(entry);
  let score = fields.maxWeight;
  for (const phrase of signals.phrases) {
    if (phrase.length >= 2 && fields.text.includes(phrase)) score += Math.min(10, 2 + phrase.length / 3);
  }
  if (signals.compact.length >= 2 && signals.compact.length <= 40 && fields.text.includes(signals.compact)) score += 12;
  let gramMatches = 0;
  for (const gram of signals.grams) if (fields.text.includes(gram)) gramMatches += 1;
  if (signals.grams.length) score += (gramMatches / signals.grams.length) * 6;
  return score;
}

function turnScore(turn, signals) {
  const text = normalize(`${turn.request_text}\n${turn.response_text}`);
  let score = 0;
  for (const phrase of signals.phrases) {
    if (phrase.length >= 2 && text.includes(phrase)) score += Math.min(8, 1 + phrase.length / 4);
  }
  if (signals.compact.length >= 2 && signals.compact.length <= 40 && text.includes(signals.compact)) score += 10;
  let gramMatches = 0;
  for (const gram of signals.grams) if (text.includes(gram)) gramMatches += 1;
  if (signals.grams.length) score += (gramMatches / signals.grams.length) * 5;
  return score;
}

async function rawRecallFallback(profileId, sessionId, signals, maxMatches = 9) {
  const session = await readSessionManifest(profileId, sessionId);
  const total = Number(session.turn_count || 0);
  if (!total) return [];
  const scanLimit = Math.min(total, 90);
  let start = Math.max(1, total - scanLimit + 1);
  let end = total;
  if (signals.earliest) {
    start = 1;
    end = scanLimit;
  }
  const turns = await getTurnsRange(profileId, sessionId, start, end);
  const matches = turns
    .map(turn => ({
      block_no: Math.ceil(Number(turn.turn_no) / MEMORY_BLOCK_SIZE),
      block_status: 'raw_fallback',
      turn_no: turn.turn_no,
      trace_id: turn.trace_id,
      request: turn.request_text,
      response: turn.response_text,
      score: turnScore(turn, signals),
    }))
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score || left.turn_no - right.turn_no)
    .slice(0, maxMatches);
  return matches;
}

export function shouldRecall(query) {
  return querySignals(query).explicitRecall;
}

export async function recallMemory(profileId, sessionId, query, maxBlocks = 3, suppliedIndex = null) {
  const signals = querySignals(query);
  const index = suppliedIndex || await getMemoryIndex(profileId, sessionId);
  const usable = array(index.entries).filter(entry => usableStatus(entry.status));
  if (!usable.length) {
    const rawMatches = signals.explicitRecall ? await rawRecallFallback(profileId, sessionId, signals) : [];
    return {
      query,
      searched: signals.explicitRecall,
      reason: rawMatches.length ? 'raw_fallback' : 'no_usable_blocks',
      blocks: [],
      matches: rawMatches,
    };
  }
  const ranked = usable
    .map(entry => ({ ...entry, score: relevanceScore(entry, signals) }))
    .sort((left, right) => right.score - left.score || right.block_no - left.block_no);
  const bestScore = ranked[0]?.score || 0;
  if (!signals.explicitRecall && bestScore < 2.25) {
    return { query, searched: false, reason: 'no_recall_signal', blocks: [], matches: [] };
  }
  const count = Math.max(1, Math.min(Number(maxBlocks) || 3, 5));
  const selected = signals.earliest && bestScore < 2.25
    ? usable.slice().sort((left, right) => left.block_no - right.block_no).slice(0, count)
    : ranked.slice(0, count);
  const fullBlocks = (await Promise.all(selected.map(entry => getMemoryBlock(profileId, sessionId, entry.block_no))))
    .filter(block => usableStatus(block?.status) && block.memory);
  const matches = [];
  for (const block of fullBlocks) {
    const turns = await getTurnsRange(profileId, sessionId, block.start_turn, block.end_turn);
    for (const turn of turns) {
      const score = turnScore(turn, signals);
      if (score > 0 || signals.explicitRecall) {
        matches.push({
          block_no: block.block_no,
          block_status: block.status,
          turn_no: turn.turn_no,
          trace_id: turn.trace_id,
          request: turn.request_text,
          response: turn.response_text,
          score,
        });
      }
    }
  }
  matches.sort((left, right) => right.score - left.score || left.turn_no - right.turn_no);
  let finalMatches = matches.slice(0, 9);
  let reason = 'indexed_blocks';
  if (signals.explicitRecall && (!finalMatches.length || finalMatches[0].score <= 0)) {
    finalMatches = await rawRecallFallback(profileId, sessionId, signals);
    if (finalMatches.length) reason = 'raw_fallback_after_index';
  }
  return {
    query,
    searched: true,
    reason,
    blocks: fullBlocks.map(block => ({
      block_no: block.block_no,
      status: block.status,
      start_turn: block.start_turn,
      end_turn: block.end_turn,
      score: selected.find(entry => entry.block_no === block.block_no)?.score || 0,
      memory: block.memory,
    })),
    matches: finalMatches,
  };
}
