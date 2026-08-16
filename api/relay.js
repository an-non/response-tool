import { waitUntil } from '@vercel/functions';
import { relay as appRelay } from '../src/app.js';
import {
  memoryBlobConfigured,
  recordConversationTurn,
  getMemorySnapshot,
  saveMemoryState,
  bindActiveSession,
  resolveActiveSession,
  readSessionManifest,
} from '../src/conversation-blob.js';
import {
  getRuntimeMemoryContext,
  compressMemoryBlock,
  compressPendingMemoryBlocks,
  recallMemory,
  MEMORY_MODEL,
} from '../src/memory-compression.js';
import { conversationToken, verifyConversationToken } from '../src/conversation-auth.js';
import { MEMORY_BLOCK_SIZE, MEMORY_SCHEMA } from '../src/config.js';
import { ensureLegacySessionCompatibility, getLegacyCurrentMemory } from '../src/legacy-memory-compat.js';

const decode = value => JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(body));
};
const array = value => Array.isArray(value) ? value : [];
const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const memoryKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function mergeWeighted(previous, latest, key, limit = 24, replace = false) {
  if (replace && array(latest).length) return array(latest).slice(0, limit);
  const map = new Map();
  for (const item of array(previous)) {
    const label = String(item?.[key] || '').slice(0, 160);
    if (!label) continue;
    map.set(memoryKey(label), {
      ...item,
      [key]: label,
      weight: clamp(item?.weight),
      source_turns: array(item?.source_turns).map(Number).filter(Number.isInteger).slice(-18),
    });
  }
  for (const item of array(latest)) {
    const label = String(item?.[key] || '').slice(0, 160);
    if (!label) continue;
    const id = memoryKey(label);
    const old = map.get(id);
    map.set(id, {
      [key]: label,
      weight: Math.max(clamp(item?.weight), clamp(old?.weight)),
      note: String(item?.note || old?.note || '').slice(0, 300),
      source_turns: [...new Set([
        ...array(old?.source_turns).map(Number),
        ...array(item?.source_turns).map(Number),
      ].filter(Number.isInteger))].slice(-18),
    });
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

function mergeStrings(previous, latest, limit) {
  const output = [];
  const seen = new Set();
  for (const value of [...array(latest), ...array(previous)]) {
    const text = String(value || '').slice(0, 240).trim();
    const id = memoryKey(text);
    if (!text || seen.has(id)) continue;
    seen.add(id);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function mergeFreshBlock(previous, latest) {
  if (!latest) return previous || null;
  const prior = previous || {};
  const priorSummary = String(prior.summary || '').slice(0, 900);
  const latestSummary = String(latest.summary || '').slice(0, 900);
  return {
    schema_version: '1.2',
    source_block_no: Number(latest.block_no || prior.source_block_no || 0),
    included_through_turn: Number(array(latest.turn_range).at(-1) || prior.included_through_turn || 0),
    summary: [priorSummary, latestSummary].filter(Boolean).join(' / Latest: ').slice(0, 1600),
    identity_facts: mergeWeighted(prior.identity_facts, latest.identity_facts, 'label', 24),
    important_topics: mergeWeighted(prior.important_topics, latest.important_topics, 'topic', 24),
    approval: mergeWeighted(prior.approval, latest.approval, 'label', 18),
    conversation_flow: mergeWeighted(prior.conversation_flow, latest.conversation_flow, 'label', 18),
    relationship_and_extensibility: mergeWeighted(prior.relationship_and_extensibility, latest.relationship_and_extensibility, 'label', 18),
    current_status: mergeWeighted(prior.current_status, latest.current_status, 'label', 12, true),
    recall_keys: mergeStrings(prior.recall_keys, latest.recall_keys, 40),
    unresolved: mergeStrings(prior.unresolved, latest.unresolved, 20),
    authority: 'derived_context_only',
    can_grant_consent: false,
  };
}

async function resolveMemorySession(payload, profileId) {
  const suppliedSessionId = String(payload?.session_id || payload?.yuki_context?.session_id || 'default');
  const clientId = String(payload?.client_id || '');
  const clientKey = String(payload?.client_key || '');
  const sessionToken = String(payload?.session_token || '');

  if (sessionToken && verifyConversationToken(profileId, suppliedSessionId, sessionToken)) {
    return {
      sessionId: suppliedSessionId,
      clientId,
      clientKey,
      authorized: true,
      access: 'session_token',
      resumed: false,
    };
  }

  if (clientId && clientKey) {
    const active = await resolveActiveSession(profileId, clientId, clientKey);
    if (active?.unauthorized) return { error: 'memory_client_unauthorized' };
    if (active?.session_id) {
      return {
        sessionId: String(active.session_id),
        clientId,
        clientKey,
        authorized: true,
        access: 'client_active_session',
        resumed: String(active.session_id) !== suppliedSessionId,
      };
    }

    const supplied = await readSessionManifest(profileId, suppliedSessionId);
    if (supplied.turn_count > 0) return { error: 'memory_session_unauthorized' };
    return {
      sessionId: suppliedSessionId,
      clientId,
      clientKey,
      authorized: true,
      access: 'new_client_session',
      resumed: false,
    };
  }

  if (sessionToken) {
    if (!verifyConversationToken(profileId, suppliedSessionId, sessionToken)) {
      return { error: 'memory_session_unauthorized' };
    }
    return {
      sessionId: suppliedSessionId,
      clientId: '',
      clientKey: '',
      authorized: true,
      access: 'session_token',
      resumed: false,
    };
  }

  const supplied = await readSessionManifest(profileId, suppliedSessionId);
  if (supplied.turn_count > 0) return { error: 'memory_credentials_required' };
  return {
    sessionId: suppliedSessionId,
    clientId: '',
    clientKey: '',
    authorized: true,
    access: 'new_unbound_session',
    resumed: false,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return appRelay(req, res);

  let payload;
  try {
    payload = decode(req.query?.p);
  } catch {
    return appRelay(req, res);
  }

  const profileId = String(payload?.yuki_context?.profile_id || 'yuki-default');
  const access = memoryBlobConfigured()
    ? await resolveMemorySession(payload, profileId)
    : {
        sessionId: String(payload?.session_id || payload?.yuki_context?.session_id || 'default'),
        clientId: String(payload?.client_id || ''),
        clientKey: String(payload?.client_key || ''),
        authorized: true,
        access: 'memory_unavailable',
        resumed: false,
      };

  if (access.error) return json(res, 401, { ok: false, error: access.error });

  const sessionId = access.sessionId;
  payload.session_id = sessionId;
  payload.yuki_context = { ...(payload.yuki_context || {}), session_id: sessionId };

  if (memoryBlobConfigured() && access.authorized) {
    try {
      const compatibility = await ensureLegacySessionCompatibility(profileId, sessionId);
      const snapshot = await getMemorySnapshot(profileId, sessionId);
      let legacyCurrent = null;
      if (!snapshot.current?.memory) {
        legacyCurrent = await getLegacyCurrentMemory(profileId, sessionId);
        if (legacyCurrent?.memory) {
          snapshot.current = {
            schema_version: 'legacy-v1-read-compat',
            profile_id: profileId,
            session_id: sessionId,
            source_block_no: legacyCurrent.source_block_no,
            memory: legacyCurrent.memory,
            updated_at: legacyCurrent.updated_at,
          };
        }
      }
      const [context, recall] = await Promise.all([
        getRuntimeMemoryContext(profileId, sessionId, snapshot),
        recallMemory(profileId, sessionId, payload.request_text, 3, snapshot.index),
      ]);
      if (legacyCurrent?.memory) context.memory_source = 'legacy_v1_current';
      payload.memory_context = context.memory;
      payload.recent_turns = context.recent_turns;
      payload.recall_context = recall;
      payload.storage_manifest = {
        ...snapshot.manifest,
        continuity_memory_available: !!context.memory,
        continuity_memory_source: context.memory_source || 'none',
        legacy_manifest_reconciled: compatibility?.reconciled === true,
      };
      payload.memory_source = context.memory_source;
    } catch (error) {
      payload.memory_load_error = String(error?.message || error);
      console.error(JSON.stringify({
        event: 'memory_load_error',
        profile_id: profileId,
        session_id: sessionId,
        error: payload.memory_load_error,
      }));
    }
  }

  const wrappedReq = Object.create(req);
  wrappedReq.query = { ...(req.query || {}), p: encode(payload) };
  const originalEnd = res.end.bind(res);

  res.end = (chunk, ...args) => {
    let output = chunk;
    try {
      const body = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''));
      if (body?.ok === true && body?.result_type === 'generated_text') {
        body.memory = {
          blob_configured: memoryBlobConfigured(),
          session_id: sessionId,
          session_token: conversationToken(profileId, sessionId),
          block_size: MEMORY_BLOCK_SIZE,
          memory_schema: MEMORY_SCHEMA,
          memory_model: MEMORY_MODEL,
          authority: 'derived_context_only',
          access: access.access,
          resumed: access.resumed,
          source: payload.memory_source || 'none',
          recall_matches: Array.isArray(payload.recall_context?.matches) ? payload.recall_context.matches.length : 0,
          recall_blocks: Array.isArray(payload.recall_context?.blocks) ? payload.recall_context.blocks.length : 0,
          manifest: payload.storage_manifest || null,
          compression_scheduled: memoryBlobConfigured(),
        };
        output = JSON.stringify(body);

        if (memoryBlobConfigured()) {
          waitUntil((async () => {
            if (access.clientId && access.clientKey) {
              await bindActiveSession(profileId, sessionId, access.clientId, access.clientKey);
            }
            const recorded = await recordConversationTurn({
              profileId,
              sessionId,
              traceId: body.trace_id,
              requestId: payload.request_id,
              requestText: payload.request_text,
              responseText: body.text,
              yukiState: body.yuki_state_echo || payload.yuki_state,
            });

            let compression = { due_block_nos: [], results: [] };
            const isBlockBoundary = Number(recorded?.turn_no || 0) > 0
              && Number(recorded.turn_no) % MEMORY_BLOCK_SIZE === 0;

            if (isBlockBoundary && recorded?.block_no) {
              const direct = await compressMemoryBlock({
                profileId,
                sessionId,
                blockNo: recorded.block_no,
                currentState: body.yuki_state_echo || payload.yuki_state,
              });
              compression = { due_block_nos: [recorded.block_no], results: [direct] };
              if (direct?.memory) {
                const merged = mergeFreshBlock(payload.memory_context, direct.memory);
                await saveMemoryState({
                  profileId,
                  sessionId,
                  sourceBlockNo: recorded.block_no,
                  memory: merged,
                });
              }
            } else {
              compression = await compressPendingMemoryBlocks({
                profileId,
                sessionId,
                currentState: body.yuki_state_echo || payload.yuki_state,
                maxBlocks: 1,
              });
              const latestUsable = [...compression.results].reverse().find(result => result?.memory);
              if (latestUsable?.memory) {
                const merged = mergeFreshBlock(payload.memory_context, latestUsable.memory);
                await saveMemoryState({
                  profileId,
                  sessionId,
                  sourceBlockNo: latestUsable.block_no,
                  memory: merged,
                });
              }
            }

            console.log(JSON.stringify({
              event: 'memory_post_response_complete',
              profile_id: profileId,
              session_id: sessionId,
              turn_no: recorded?.turn_no || null,
              due_block_nos: compression.due_block_nos,
              compression_results: compression.results.map(result => ({
                block_no: result.block_no,
                compressed: result.compressed,
                usable: result.usable,
                reason: result.reason || null,
              })),
            }));
          })().catch(error => {
            console.error(JSON.stringify({
              event: 'memory_post_response_error',
              profile_id: profileId,
              session_id: sessionId,
              error: String(error?.message || error),
            }));
          }));
        }
      }
    } catch {}
    return originalEnd(output, ...args);
  };

  return appRelay(wrappedReq, res);
}
