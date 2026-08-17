import crypto from 'node:crypto';
import {
  MEMORY_PREFIX,
  BLOB_PREFIX,
  MEMORY_SCHEMA,
  MEMORY_BLOCK_SIZE,
  RECENT_TURN_LIMIT,
  RECENT_TEXT_CHARS,
  MEMORY_MAX_INDEX_BLOCKS,
} from './config.js';
import { blobList, readText } from './storage.js';
export { MEMORY_BLOCK_SIZE } from './config.js';

const safe = id => encodeURIComponent(String(id || 'default')).replace(/%/g, '_');
const pad = n => String(Number(n) || 0).padStart(6, '0');
const base = (profileId, sessionId) => `${MEMORY_PREFIX}${safe(profileId)}/${safe(sessionId)}/`;
const memoryBase = (profileId, sessionId) => `${base(profileId, sessionId)}${MEMORY_SCHEMA}/`;
const clientPath = (profileId, clientId) => `${MEMORY_PREFIX}${safe(profileId)}/clients/${safe(clientId)}/active.json`;
const turnPath = (profileId, sessionId, turnNo) => `${base(profileId, sessionId)}turns/${pad(turnNo)}.json`;
const tracePath = (profileId, sessionId, traceId) => `${base(profileId, sessionId)}traces/${safe(traceId)}.json`;
const sessionPath = (profileId, sessionId) => `${base(profileId, sessionId)}session.json`;
const blockPath = (profileId, sessionId, blockNo) => {
  const start = (blockNo - 1) * MEMORY_BLOCK_SIZE + 1;
  const end = blockNo * MEMORY_BLOCK_SIZE;
  return `${memoryBase(profileId, sessionId)}blocks/${pad(start)}-${pad(end)}.json`;
};
const currentPath = (profileId, sessionId) => `${memoryBase(profileId, sessionId)}current.json`;
const indexPath = (profileId, sessionId) => `${memoryBase(profileId, sessionId)}index.json`;
const trimText = (value, limit = RECENT_TEXT_CHARS) => {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const clientKeyHash = key => crypto.createHash('sha256').update(String(key || ''), 'utf8').digest('base64url');
const secureEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

async function auth() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return { token: process.env.BLOB_READ_WRITE_TOKEN };
  const storeId = process.env.blobyuki_STORE_ID || process.env.BLOB_STORE_ID;
  if (!storeId) throw Error('blob_store_id_missing');
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const oidcToken = await getVercelOidcToken();
  if (!oidcToken) throw Error('blob_oidc_token_unavailable');
  return { oidcToken, storeId };
}

async function putJson(path, value) {
  const { put } = await import('@vercel/blob');
  return put(path, JSON.stringify(value, null, 2), {
    ...(await auth()),
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
  });
}

async function getJson(path) {
  try {
    const { get } = await import('@vercel/blob');
    const response = await get(path, { ...(await auth()), access: 'private' });
    if (response?.statusCode === 200) return JSON.parse(await new Response(response.stream).text());
  } catch {}
  return null;
}

function defaultSession(profileId, sessionId) {
  const now = new Date().toISOString();
  return {
    schema_version: '2.0',
    primary_key: `${profileId}:${sessionId}`,
    profile_id: profileId,
    session_id: sessionId,
    memory_schema: MEMORY_SCHEMA,
    block_size: MEMORY_BLOCK_SIZE,
    turn_count: 0,
    latest_turn_no: 0,
    completed_block_count: 0,
    latest_ready_block_no: 0,
    latest_attempted_block_no: 0,
    recent_turns: [],
    created_at: now,
    updated_at: now,
  };
}

function normalizeSession(profileId, sessionId, row) {
  const baseRow = defaultSession(profileId, sessionId);
  const turnCount = Math.max(Number(row?.turn_count || 0), Number(row?.latest_turn_no || 0));
  return {
    ...baseRow,
    ...(row || {}),
    schema_version: '2.0',
    primary_key: `${profileId}:${sessionId}`,
    profile_id: profileId,
    session_id: sessionId,
    memory_schema: MEMORY_SCHEMA,
    block_size: MEMORY_BLOCK_SIZE,
    turn_count: turnCount,
    latest_turn_no: turnCount,
    completed_block_count: Math.floor(turnCount / MEMORY_BLOCK_SIZE),
    latest_ready_block_no: Number(row?.latest_ready_block_no || 0),
    latest_attempted_block_no: Number(row?.latest_attempted_block_no || 0),
    recent_turns: Array.isArray(row?.recent_turns) ? row.recent_turns.slice(-RECENT_TURN_LIMIT) : [],
    created_at: row?.created_at || baseRow.created_at,
    updated_at: row?.updated_at || baseRow.updated_at,
  };
}

async function listTurnRefs(profileId, sessionId) {
  const prefix = `${base(profileId, sessionId)}turns/`;
  const result = await blobList(prefix, 1000);
  return (result.blobs || [])
    .map(blob => ({
      pathname: blob.pathname,
      turn_no: Number((blob.pathname.match(/\/(\d{6})\.json$/) || [])[1] || 0),
    }))
    .filter(item => item.turn_no > 0)
    .sort((a, b) => a.turn_no - b.turn_no);
}

async function listBlockRefs(profileId, sessionId) {
  const prefix = `${memoryBase(profileId, sessionId)}blocks/`;
  const result = await blobList(prefix, 1000);
  return (result.blobs || [])
    .map(blob => {
      const match = blob.pathname.match(/\/(\d{6})-(\d{6})\.json$/);
      if (!match) return null;
      const start = Number(match[1]);
      return { pathname: blob.pathname, block_no: Math.ceil(start / MEMORY_BLOCK_SIZE) };
    })
    .filter(Boolean)
    .sort((a, b) => a.block_no - b.block_no);
}

export function memoryBlobConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.blobyuki_STORE_ID || process.env.BLOB_STORE_ID);
}

export async function readSessionManifest(profileId, sessionId) {
  const row = await getJson(sessionPath(profileId, sessionId));
  if (row) return normalizeSession(profileId, sessionId, row);

  // Legacy sessions already have deterministic turn indexes. List only once when the manifest is missing.
  const refs = await listTurnRefs(profileId, sessionId).catch(() => []);
  const session = defaultSession(profileId, sessionId);
  if (refs.length) {
    session.turn_count = refs.at(-1).turn_no;
    session.latest_turn_no = session.turn_count;
    session.completed_block_count = Math.floor(session.turn_count / MEMORY_BLOCK_SIZE);
    session.migrated_from_legacy_turn_index = true;
  }
  return session;
}

async function writeSessionManifest(profileId, sessionId, patch) {
  const current = await readSessionManifest(profileId, sessionId);
  const next = normalizeSession(profileId, sessionId, {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  });
  await putJson(sessionPath(profileId, sessionId), next);
  return next;
}

export async function bindActiveSession(profileId, sessionId, clientId, clientKey) {
  if (!memoryBlobConfigured() || !clientId || !clientKey || !sessionId) return false;
  await putJson(clientPath(profileId, clientId), {
    schema_version: '1.1',
    primary_key: `${profileId}:${clientId}`,
    profile_id: profileId,
    client_id: clientId,
    session_id: sessionId,
    client_key_hash: clientKeyHash(clientKey),
    updated_at: new Date().toISOString(),
  });
  return true;
}

export async function resolveActiveSession(profileId, clientId, clientKey) {
  if (!memoryBlobConfigured() || !clientId || !clientKey) return null;
  const row = await getJson(clientPath(profileId, clientId));
  if (!row) return null;
  if (!secureEqual(row.client_key_hash, clientKeyHash(clientKey))) return { unauthorized: true };
  return {
    profile_id: profileId,
    client_id: clientId,
    session_id: String(row.session_id || ''),
    updated_at: row.updated_at || null,
  };
}

export async function verifyClientSession(profileId, sessionId, clientId, clientKey) {
  const row = await resolveActiveSession(profileId, clientId, clientKey);
  return !!row && !row.unauthorized && row.session_id === String(sessionId || '');
}

export async function recordConversationTurn({
  profileId,
  sessionId,
  traceId,
  requestId,
  requestText,
  responseText,
  yukiState,
}) {
  if (!memoryBlobConfigured()) return { stored: false, reason: 'blob_memory_unavailable' };

  const duplicate = await getJson(tracePath(profileId, sessionId, traceId));
  if (duplicate?.turn_no) {
    return {
      stored: true,
      duplicate: true,
      turn_no: Number(duplicate.turn_no),
      block_no: Math.ceil(Number(duplicate.turn_no) / MEMORY_BLOCK_SIZE),
      compression_due: false,
    };
  }

  const session = await readSessionManifest(profileId, sessionId);
  let turnNo = session.turn_count + 1;
  for (let i = 0; i < 3; i += 1) {
    const occupied = await getJson(turnPath(profileId, sessionId, turnNo));
    if (!occupied) break;
    if (occupied.trace_id === traceId) {
      return {
        stored: true,
        duplicate: true,
        turn_no: turnNo,
        block_no: Math.ceil(turnNo / MEMORY_BLOCK_SIZE),
        compression_due: false,
      };
    }
    turnNo += 1;
  }

  const createdAt = new Date().toISOString();
  const blockNo = Math.ceil(turnNo / MEMORY_BLOCK_SIZE);
  const row = {
    schema_version: '2.0',
    primary_key: `${profileId}:${sessionId}:turn:${pad(turnNo)}`,
    session_primary_key: `${profileId}:${sessionId}`,
    trace_primary_key: traceId,
    profile_id: profileId,
    session_id: sessionId,
    turn_no: turnNo,
    previous_turn_no: turnNo > 1 ? turnNo - 1 : null,
    block_no: blockNo,
    block_primary_key: `${profileId}:${sessionId}:block:${pad(blockNo)}`,
    trace_id: traceId,
    request_id: requestId,
    request_path: `${BLOB_PREFIX}${traceId}/request.txt`,
    response_path: `${BLOB_PREFIX}${traceId}/response.txt`,
    metadata_path: `${BLOB_PREFIX}${traceId}/metadata.json`,
    request_preview: trimText(requestText),
    response_preview: trimText(responseText),
    yuki_state: yukiState || {},
    created_at: createdAt,
  };

  await putJson(turnPath(profileId, sessionId, turnNo), row);
  await putJson(tracePath(profileId, sessionId, traceId), {
    schema_version: '1.0',
    trace_id: traceId,
    turn_no: turnNo,
    turn_path: turnPath(profileId, sessionId, turnNo),
    created_at: createdAt,
  });
  await writeSessionManifest(profileId, sessionId, {
    turn_count: turnNo,
    latest_turn_no: turnNo,
    completed_block_count: Math.floor(turnNo / MEMORY_BLOCK_SIZE),
    recent_turns: [
      ...(Array.isArray(session.recent_turns) ? session.recent_turns : []),
      { turn_no: turnNo, request: trimText(requestText), response: trimText(responseText), created_at: createdAt },
    ].slice(-RECENT_TURN_LIMIT),
  });

  return {
    stored: true,
    turn_no: turnNo,
    block_no: blockNo,
    compression_due: turnNo >= MEMORY_BLOCK_SIZE,
  };
}

async function hydrateTurn(index, fullText = true) {
  let requestText = index.request_preview ?? '';
  let responseText = index.response_preview ?? '';
  if (fullText || !requestText || !responseText) {
    const [storedRequest, storedResponse] = await Promise.all([
      readText(index.trace_id, 'request'),
      readText(index.trace_id, 'response'),
    ]);
    if (typeof storedRequest === 'string' && storedRequest.length > 0) requestText = storedRequest;
    if (typeof storedResponse === 'string' && storedResponse.length > 0) responseText = storedResponse;
  }
  return {
    turn_no: Number(index.turn_no),
    trace_id: index.trace_id,
    request_id: index.request_id,
    request_text: requestText ?? '',
    response_text: responseText ?? '',
    yuki_state: index.yuki_state || {},
    created_at: index.created_at,
  };
}

async function getTurnIndexes(profileId, sessionId, startTurn, endTurn) {
  const numbers = [];
  for (let turn = startTurn; turn <= endTurn; turn += 1) numbers.push(turn);
  const rows = await Promise.all(numbers.map(turn => getJson(turnPath(profileId, sessionId, turn))));
  return rows.filter(Boolean);
}

export async function getRecentTurns(profileId, sessionId, limit = RECENT_TURN_LIMIT) {
  const session = await readSessionManifest(profileId, sessionId);
  const count = Math.max(1, Math.min(Number(limit) || RECENT_TURN_LIMIT, 12));
  if (Array.isArray(session.recent_turns) && session.recent_turns.length >= count) {
    return session.recent_turns.slice(-count);
  }
  const start = Math.max(1, session.turn_count - count + 1);
  const indexes = await getTurnIndexes(profileId, sessionId, start, session.turn_count);
  const turns = await Promise.all(indexes.map(index => hydrateTurn(index, false)));
  return turns.map(turn => ({
    turn_no: turn.turn_no,
    request: trimText(turn.request_text),
    response: trimText(turn.response_text),
    created_at: turn.created_at,
  }));
}

export async function getHistory(profileId, sessionId, limit = 30) {
  const session = await readSessionManifest(profileId, sessionId);
  const count = Math.max(1, Math.min(Number(limit) || 30, 100));
  const start = Math.max(1, session.turn_count - count + 1);
  const indexes = await getTurnIndexes(profileId, sessionId, start, session.turn_count);
  return Promise.all(indexes.map(hydrateTurn));
}

export async function getTurnsRange(profileId, sessionId, startTurn, endTurn) {
  const indexes = await getTurnIndexes(profileId, sessionId, startTurn, endTurn);
  return Promise.all(indexes.map(hydrateTurn));
}

export async function getLatestMemoryState(profileId, sessionId) {
  return getJson(currentPath(profileId, sessionId));
}

export async function getMemoryIndex(profileId, sessionId) {
  const row = await getJson(indexPath(profileId, sessionId));
  return row || {
    schema_version: '2.0',
    primary_key: `${profileId}:${sessionId}:memory-index`,
    profile_id: profileId,
    session_id: sessionId,
    block_size: MEMORY_BLOCK_SIZE,
    entries: [],
    updated_at: null,
  };
}

async function writeMemoryIndex(profileId, sessionId, entries) {
  const limited = [...entries]
    .sort((a, b) => a.block_no - b.block_no)
    .slice(-MEMORY_MAX_INDEX_BLOCKS);
  const row = {
    schema_version: '2.0',
    primary_key: `${profileId}:${sessionId}:memory-index`,
    profile_id: profileId,
    session_id: sessionId,
    block_size: MEMORY_BLOCK_SIZE,
    entries: limited,
    updated_at: new Date().toISOString(),
  };
  await putJson(indexPath(profileId, sessionId), row);
  return row;
}

export async function getMemoryBlock(profileId, sessionId, blockNo) {
  return getJson(blockPath(profileId, sessionId, blockNo));
}

function compactWeighted(items, key, limit = 7) {
  return (Array.isArray(items) ? items : []).slice(0, limit).map(item => ({
    [key]: String(item?.[key] || ''),
    weight: Number(item?.weight || 0),
    note: trimText(item?.note || '', 120),
    source_turns: (Array.isArray(item?.source_turns) ? item.source_turns : [])
      .map(Number)
      .filter(Number.isInteger)
      .slice(-18),
  })).filter(item => item[key]);
}

function blockIndexEntry(row) {
  const memory = row?.memory || {};
  return {
    block_no: Number(row.block_no),
    start_turn: Number(row.start_turn),
    end_turn: Number(row.end_turn),
    status: row.status,
    attempts: Number(row.attempts || 0),
    retryable: row.retryable !== false,
    next_retry_at: row.next_retry_at || null,
    error: row.error || null,
    provider_http_status: row.provider_http_status || null,
    model: row.model || null,
    summary: trimText(memory.summary, 700),
    recall_keys: (Array.isArray(memory.recall_keys) ? memory.recall_keys : []).slice(0, 24),
    identity_facts: compactWeighted(memory.identity_facts, 'label'),
    important_topics: compactWeighted(memory.important_topics, 'topic'),
    approval: compactWeighted(memory.approval, 'label'),
    conversation_flow: compactWeighted(memory.conversation_flow, 'label'),
    relationship_and_extensibility: compactWeighted(memory.relationship_and_extensibility, 'label'),
    current_status: compactWeighted(memory.current_status, 'label'),
    unresolved: (Array.isArray(memory.unresolved) ? memory.unresolved : []).slice(0, 8).map(item => trimText(item, 160)),
    updated_at: row.updated_at,
  };
}

export async function saveMemoryBlock({
  profileId,
  sessionId,
  blockNo,
  startTurn,
  endTurn,
  memory,
  status = 'ready',
  error = null,
  attempts = 1,
  retryable = true,
  nextRetryAt = null,
  providerHttpStatus = null,
  providerErrorCode = null,
  rateLimit = null,
  model = null,
}) {
  const now = new Date().toISOString();
  const row = {
    schema_version: '2.0',
    primary_key: `${profileId}:${sessionId}:block:${pad(blockNo)}`,
    session_primary_key: `${profileId}:${sessionId}`,
    profile_id: profileId,
    session_id: sessionId,
    block_no: blockNo,
    block_size: MEMORY_BLOCK_SIZE,
    start_turn: startTurn,
    end_turn: endTurn,
    source_turn_primary_keys: Array.from({ length: endTurn - startTurn + 1 }, (_, offset) => `${profileId}:${sessionId}:turn:${pad(startTurn + offset)}`),
    status,
    attempts,
    retryable,
    next_retry_at: nextRetryAt,
    memory,
    error,
    provider_http_status: providerHttpStatus,
    provider_error_code: providerErrorCode,
    rate_limit: rateLimit,
    model,
    updated_at: now,
  };
  await putJson(blockPath(profileId, sessionId, blockNo), row);

  const index = await getMemoryIndex(profileId, sessionId);
  const entries = (index.entries || []).filter(entry => Number(entry.block_no) !== Number(blockNo));
  entries.push(blockIndexEntry(row));
  await writeMemoryIndex(profileId, sessionId, entries);

  const session = await readSessionManifest(profileId, sessionId);
  const sessionPatch = {
    latest_attempted_block_no: Math.max(Number(blockNo), Number(session.latest_attempted_block_no || 0)),
  };
  if (status === 'ready') {
    sessionPatch.latest_ready_block_no = Math.max(Number(blockNo), Number(session.latest_ready_block_no || 0));
  }
  await writeSessionManifest(profileId, sessionId, sessionPatch);
  return row;
}

export async function saveMemoryState({ profileId, sessionId, sourceBlockNo, memory }) {
  const row = {
    schema_version: '2.0',
    primary_key: `${profileId}:${sessionId}:current-memory`,
    profile_id: profileId,
    session_id: sessionId,
    source_block_no: sourceBlockNo,
    included_through_turn: Number(sourceBlockNo) * MEMORY_BLOCK_SIZE,
    memory,
    updated_at: new Date().toISOString(),
  };
  await putJson(currentPath(profileId, sessionId), row);
  await writeSessionManifest(profileId, sessionId, {
    latest_ready_block_no: Math.max(
      Number(sourceBlockNo),
      Number((await readSessionManifest(profileId, sessionId)).latest_ready_block_no || 0),
    ),
  });
  return true;
}

export async function getMemoryBlocks(profileId, sessionId, limit = 50) {
  const index = await getMemoryIndex(profileId, sessionId);
  let refs = (index.entries || [])
    .slice()
    .sort((a, b) => b.block_no - a.block_no)
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, MEMORY_MAX_INDEX_BLOCKS)));

  if (!refs.length) {
    refs = (await listBlockRefs(profileId, sessionId).catch(() => []))
      .reverse()
      .slice(0, Math.max(1, Math.min(Number(limit) || 50, MEMORY_MAX_INDEX_BLOCKS)));
  }

  const rows = await Promise.all(refs.map(ref => getMemoryBlock(profileId, sessionId, ref.block_no)));
  return rows.filter(Boolean);
}

export async function getDueMemoryBlockNos(profileId, sessionId, limit = 1) {
  const [session, index] = await Promise.all([
    readSessionManifest(profileId, sessionId),
    getMemoryIndex(profileId, sessionId),
  ]);
  const completed = Math.floor(session.turn_count / MEMORY_BLOCK_SIZE);
  const byNo = new Map((index.entries || []).map(entry => [Number(entry.block_no), entry]));
  const now = Date.now();
  const due = [];

  for (let blockNo = 1; blockNo <= completed; blockNo += 1) {
    const entry = byNo.get(blockNo);
    if (entry?.status === 'ready') continue;
    if (entry?.status === 'pending') {
      const age = now - Date.parse(entry.updated_at || 0);
      if (Number.isFinite(age) && age < 90_000) continue;
    }
    if (entry?.retryable === false) continue;
    if (entry?.next_retry_at && Date.parse(entry.next_retry_at) > now) continue;
    due.push(blockNo);
    if (due.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return due;
}

function buildStorageManifest(profileId, sessionId, session, index, current) {
  const entries = index.entries || [];
  return {
    schema_version: '2.0',
    provider: 'vercel_private_blob',
    storage_model: 'manifest_plus_relational_indexes',
    primary_key: `${profileId}:${sessionId}`,
    profile_id: profileId,
    session_id: sessionId,
    prefix: base(profileId, sessionId),
    memory_schema: MEMORY_SCHEMA,
    block_size: MEMORY_BLOCK_SIZE,
    hot_index_block_limit: MEMORY_MAX_INDEX_BLOCKS,
    turn_count: session.turn_count,
    turn_index_count: session.turn_count,
    completed_block_count: Math.floor(session.turn_count / MEMORY_BLOCK_SIZE),
    block_count: entries.length,
    ready_block_count: entries.filter(entry => entry.status === 'ready').length,
    degraded_block_count: entries.filter(entry => entry.status === 'degraded').length,
    usable_block_count: entries.filter(entry => entry.status === 'ready' || entry.status === 'degraded').length,
    pending_block_count: entries.filter(entry => entry.status === 'pending').length,
    error_block_count: entries.filter(entry => entry.status === 'error').length,
    latest_turn_no: session.latest_turn_no,
    latest_ready_block_no: session.latest_ready_block_no,
    current_memory_source_block_no: Number(current?.source_block_no || 0),
    current_memory_included_through_turn: Number(current?.included_through_turn || 0),
    current_memory_available: !!current?.memory,
    stored_artifacts: {
      session_manifest: 'memory/<profile>/<session>/session.json',
      turn_index: 'memory/<profile>/<session>/turns/<turn>.json',
      trace_index: 'memory/<profile>/<session>/traces/<trace_id>.json',
      memory_index: `memory/<profile>/<session>/${MEMORY_SCHEMA}/index.json`,
      compressed_blocks: `memory/<profile>/<session>/${MEMORY_SCHEMA}/blocks/<range>.json`,
      current_memory: `memory/<profile>/<session>/${MEMORY_SCHEMA}/current.json`,
      original_request_response: 'results/<trace_id>/request.txt + response.txt',
      active_session: 'memory/<profile>/clients/<client_id>/active.json',
    },
  };
}

export async function getMemorySnapshot(profileId, sessionId) {
  const [session, index, current] = await Promise.all([
    readSessionManifest(profileId, sessionId),
    getMemoryIndex(profileId, sessionId),
    getLatestMemoryState(profileId, sessionId),
  ]);
  const desiredRecent = current?.memory ? Math.min(6, RECENT_TURN_LIMIT) : RECENT_TURN_LIMIT;
  let recentTurns = Array.isArray(session.recent_turns) && session.recent_turns.length >= desiredRecent
    ? session.recent_turns.slice(-desiredRecent)
    : [];
  if (recentTurns.length < desiredRecent && session.turn_count > 0) {
    recentTurns = await getRecentTurns(profileId, sessionId, desiredRecent);
  }
  return {
    session,
    index,
    current,
    recent_turns: recentTurns,
    manifest: buildStorageManifest(profileId, sessionId, session, index, current),
  };
}

export async function getStorageManifest(profileId, sessionId) {
  return (await getMemorySnapshot(profileId, sessionId)).manifest;
}

export async function getMemoryDiagnostics(profileId, sessionId) {
  const snapshot = await getMemorySnapshot(profileId, sessionId);
  return {
    manifest: snapshot.manifest,
    current_memory: snapshot.current || null,
    recent_block_statuses: (snapshot.index.entries || []).slice(-12),
    due_block_nos: await getDueMemoryBlockNos(profileId, sessionId, 12),
  };
}

export async function memoryBlobHealth() {
  if (!memoryBlobConfigured()) return { configured: false, ok: false, reason: 'blob_memory_unavailable' };
  try {
    await blobList(MEMORY_PREFIX, 1);
    return {
      configured: true,
      ok: true,
      provider: 'vercel_private_blob',
      prefix: MEMORY_PREFIX,
      memory_schema: MEMORY_SCHEMA,
      block_size: MEMORY_BLOCK_SIZE,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      provider: 'vercel_private_blob',
      error: String(error?.message || error),
    };
  }
}
