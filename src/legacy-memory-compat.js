import { MEMORY_PREFIX, MEMORY_SCHEMA, MEMORY_BLOCK_SIZE, RECENT_TURN_LIMIT, RECENT_TEXT_CHARS, STORE_ENV } from './config.js';
import { blobList, readText } from './storage.js';
import { readBlobSessionManifestDirect } from './blob-session-reader.js';

const safe = id => encodeURIComponent(String(id || 'default')).replace(/%/g, '_');
const base = (profileId, sessionId) => `${MEMORY_PREFIX}${safe(profileId)}/${safe(sessionId)}/`;
const sessionPath = (profileId, sessionId) => `${base(profileId, sessionId)}session.json`;
const legacyCurrentPath = (profileId, sessionId) => `${base(profileId, sessionId)}current.json`;
const trimText = value => {
  const text = String(value || '');
  return text.length > RECENT_TEXT_CHARS ? `${text.slice(0, RECENT_TEXT_CHARS)}…` : text;
};

async function auth() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return { token: process.env.BLOB_READ_WRITE_TOKEN };
  const storeId = process.env[STORE_ENV] || process.env.BLOB_STORE_ID;
  if (!storeId) throw Error('blob_store_id_missing');
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const oidcToken = await getVercelOidcToken();
  if (!oidcToken) throw Error('blob_oidc_token_unavailable');
  return { oidcToken, storeId };
}

async function getJson(path) {
  try {
    const { get } = await import('@vercel/blob');
    const response = await get(path, { ...(await auth()), access: 'private' });
    if (response?.statusCode === 200) return JSON.parse(await new Response(response.stream).text());
  } catch {}
  return null;
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

async function listTurnRefs(profileId, sessionId) {
  const prefix = `${base(profileId, sessionId)}turns/`;
  const result = await blobList(prefix, 1000);
  return (result.blobs || [])
    .map(blob => ({
      pathname: blob.pathname,
      turn_no: Number((blob.pathname.match(/\/(\d{6})\.json$/) || [])[1] || 0),
    }))
    .filter(item => item.turn_no > 0)
    .sort((left, right) => left.turn_no - right.turn_no);
}

async function hydrateRecent(refs) {
  const selected = refs.slice(-RECENT_TURN_LIMIT);
  const rows = await Promise.all(selected.map(ref => getJson(ref.pathname)));
  const turns = [];
  for (const row of rows.filter(Boolean)) {
    let request = row.request_preview || '';
    let response = row.response_preview || '';
    if ((!request || !response) && row.trace_id) {
      const [storedRequest, storedResponse] = await Promise.all([
        readText(row.trace_id, 'request'),
        readText(row.trace_id, 'response'),
      ]);
      if (!request && typeof storedRequest === 'string') request = storedRequest;
      if (!response && typeof storedResponse === 'string') response = storedResponse;
    }
    turns.push({
      turn_no: Number(row.turn_no || 0),
      request: trimText(request),
      response: trimText(response),
      created_at: row.created_at || null,
    });
  }
  return turns.filter(turn => turn.turn_no > 0).sort((a, b) => a.turn_no - b.turn_no);
}

export async function ensureLegacySessionCompatibility(profileId, sessionId) {
  const direct = await readBlobSessionManifestDirect(profileId, sessionId);
  if (!direct) return { reconciled:false, turn_count:0, reason:'no_blob_manifest' };

  const path = sessionPath(profileId, sessionId);
  const row = direct;
  const reportedTurnCount = Math.max(Number(row?.turn_count || 0), Number(row?.latest_turn_no || 0));
  const legacyShape = !!row && (row.schema_version !== '2.0' || row.memory_schema !== MEMORY_SCHEMA);
  const missingRecent = reportedTurnCount > 0 && (!Array.isArray(row?.recent_turns) || row.recent_turns.length === 0);
  const shouldReconcile = legacyShape || reportedTurnCount === 0 || missingRecent;

  if (!shouldReconcile) {
    return { reconciled:false, turn_count:reportedTurnCount, reason:'current_manifest' };
  }

  const refs = await listTurnRefs(profileId, sessionId).catch(() => []);
  const actualTurnCount = refs.at(-1)?.turn_no || 0;
  const turnCount = Math.max(reportedTurnCount, actualTurnCount);
  const recentTurns = refs.length
    ? await hydrateRecent(refs)
    : (Array.isArray(row?.recent_turns) ? row.recent_turns.slice(-RECENT_TURN_LIMIT) : []);
  const now = new Date().toISOString();
  const next = {
    ...(row || {}),
    schema_version:'2.0',
    primary_key:`${profileId}:${sessionId}`,
    profile_id:profileId,
    session_id:sessionId,
    memory_schema:MEMORY_SCHEMA,
    block_size:MEMORY_BLOCK_SIZE,
    turn_count:turnCount,
    latest_turn_no:turnCount,
    completed_block_count:Math.floor(turnCount / MEMORY_BLOCK_SIZE),
    latest_ready_block_no:Number(row?.latest_ready_block_no || 0),
    latest_attempted_block_no:Number(row?.latest_attempted_block_no || 0),
    recent_turns:recentTurns,
    created_at:row?.created_at || now,
    updated_at:now,
    migrated_from_legacy_manifest:legacyShape || undefined,
    reconciled_from_turn_index:actualTurnCount > reportedTurnCount || undefined,
  };
  await putJson(path, next);
  return { reconciled:true, turn_count:turnCount, actual_turn_count:actualTurnCount, legacy_shape:legacyShape, recent_turns:recentTurns.length };
}

export async function getLegacyCurrentMemory(profileId, sessionId) {
  const direct = await readBlobSessionManifestDirect(profileId, sessionId);
  if (!direct) return null;
  const row = await getJson(legacyCurrentPath(profileId, sessionId));
  if (!row?.memory) return null;
  return {
    memory:row.memory,
    source_block_no:Number(row.source_block_no || 0) || null,
    updated_at:row.updated_at || null,
    source:'legacy_v1_current',
  };
}
