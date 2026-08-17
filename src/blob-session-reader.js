import { MEMORY_PREFIX, MEMORY_SCHEMA, MEMORY_BLOCK_SIZE, RECENT_TURN_LIMIT, STORE_ENV } from './config.js';

const safe = id => encodeURIComponent(String(id || 'default')).replace(/%/g, '_');
const base = (profileId, sessionId) => `${MEMORY_PREFIX}${safe(profileId)}/${safe(sessionId)}/`;
const sessionPath = (profileId, sessionId) => `${base(profileId, sessionId)}session.json`;

async function auth() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return { token: process.env.BLOB_READ_WRITE_TOKEN };
  const storeId = process.env[STORE_ENV] || process.env.BLOB_STORE_ID;
  if (!storeId) return null;
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const oidcToken = await getVercelOidcToken();
  if (!oidcToken) return null;
  return { oidcToken, storeId };
}

function normalize(profileId, sessionId, row) {
  if (!row) return null;
  const turnCount = Math.max(Number(row.turn_count || 0), Number(row.latest_turn_no || 0));
  return {
    ...row,
    schema_version: '2.0',
    primary_key: `${profileId}:${sessionId}`,
    profile_id: profileId,
    session_id: sessionId,
    memory_schema: row.memory_schema || MEMORY_SCHEMA,
    block_size: Number(row.block_size || MEMORY_BLOCK_SIZE),
    turn_count: turnCount,
    latest_turn_no: turnCount,
    completed_block_count: Math.floor(turnCount / MEMORY_BLOCK_SIZE),
    latest_ready_block_no: Number(row.latest_ready_block_no || 0),
    latest_attempted_block_no: Number(row.latest_attempted_block_no || 0),
    recent_turns: Array.isArray(row.recent_turns) ? row.recent_turns.slice(-RECENT_TURN_LIMIT) : [],
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export async function readBlobSessionManifestDirect(profileId, sessionId) {
  const credentials = await auth();
  if (!credentials) return null;
  try {
    const { get } = await import('@vercel/blob');
    const response = await get(sessionPath(profileId, sessionId), { ...credentials, access: 'private' });
    if (response?.statusCode !== 200) return null;
    return normalize(profileId, sessionId, JSON.parse(await new Response(response.stream).text()));
  } catch {
    return null;
  }
}
