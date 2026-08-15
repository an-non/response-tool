import { waitUntil } from '@vercel/functions';
import { relay as appRelay } from '../src/app.js';
import {
  memoryBlobConfigured,
  recordConversationTurn,
  getMemorySnapshot,
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

const decode = value => JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(body));
};

async function resolveMemorySession(payload, profileId) {
  const suppliedSessionId = String(payload?.session_id || payload?.yuki_context?.session_id || 'default');
  const clientId = String(payload?.client_id || '');
  const clientKey = String(payload?.client_key || '');
  const sessionToken = String(payload?.session_token || '');

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
      const snapshot = await getMemorySnapshot(profileId, sessionId);
      const [context, recall] = await Promise.all([
        getRuntimeMemoryContext(profileId, sessionId, snapshot),
        recallMemory(profileId, sessionId, payload.request_text, 3, snapshot.index),
      ]);
      payload.memory_context = context.memory;
      payload.recent_turns = context.recent_turns;
      payload.recall_context = recall;
      payload.storage_manifest = snapshot.manifest;
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
            if (recorded?.compression_due && recorded?.block_no) {
              const direct = await compressMemoryBlock({
                profileId,
                sessionId,
                blockNo: recorded.block_no,
                currentState: body.yuki_state_echo || payload.yuki_state,
              });
              compression = { due_block_nos: [recorded.block_no], results: [direct] };
            } else {
              compression = await compressPendingMemoryBlocks({
                profileId,
                sessionId,
                currentState: body.yuki_state_echo || payload.yuki_state,
                maxBlocks: 1,
              });
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
