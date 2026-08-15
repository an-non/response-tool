import {
  getHistory,
  getTurnsRange,
  getMemoryDiagnostics,
  getStorageManifest,
  memoryBlobConfigured,
  resolveActiveSession
} from '../src/conversation-blob.js';
import { conversationToken, verifyConversationToken } from '../src/conversation-auth.js';

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(body));
};

function memoryTurnFloor(manifest, diagnostics) {
  const blocks = diagnostics?.recent_block_statuses || [];
  const blockFloor = blocks
    .filter(block => block?.status === 'ready' || block?.status === 'degraded')
    .reduce((max, block) => Math.max(max, Number(block?.end_turn || 0)), 0);
  return Math.max(
    Number(manifest?.latest_turn_no || 0),
    Number(manifest?.current_memory_included_through_turn || 0),
    blockFloor,
  );
}

async function reconciledHistory(profile, session, limit, manifest, diagnostics) {
  const turns = await getHistory(profile, session, limit);
  const lastTurn = turns.reduce((max, turn) => Math.max(max, Number(turn?.turn_no || 0)), 0);
  const floor = memoryTurnFloor(manifest, diagnostics);
  if (floor <= lastTurn) return turns;

  const missing = await getTurnsRange(profile, session, lastTurn + 1, floor);
  const byTurn = new Map();
  for (const turn of [...turns, ...missing]) byTurn.set(Number(turn.turn_no), turn);
  return [...byTurn.values()]
    .sort((left, right) => Number(left.turn_no) - Number(right.turn_no))
    .slice(-Math.max(1, Math.min(Number(limit) || 30, 100)));
}

async function responseForSession(req, res, profile, session, updatedAt = null) {
  const includeMemory = String(req.query?.include_memory || '') === '1';
  const [manifest, diagnostics] = await Promise.all([
    getStorageManifest(profile, session),
    includeMemory ? getMemoryDiagnostics(profile, session, req.query?.memory_limit) : Promise.resolve(null)
  ]);
  const turns = await reconciledHistory(profile, session, req.query?.limit, manifest, diagnostics);
  const reconciledTurnCount = Math.max(
    Number(manifest?.turn_count || 0),
    turns.reduce((max, turn) => Math.max(max, Number(turn?.turn_no || 0)), 0),
    memoryTurnFloor(manifest, diagnostics),
  );
  const reconciledManifest = {
    ...manifest,
    turn_count: reconciledTurnCount,
    turn_index_count: Math.max(Number(manifest?.turn_index_count || 0), reconciledTurnCount),
    latest_turn_no: Math.max(Number(manifest?.latest_turn_no || 0), reconciledTurnCount),
    history_reconciled: reconciledTurnCount > Number(manifest?.turn_count || 0),
  };
  return json(res, 200, {
    ok: true,
    profile_id: profile,
    session_id: session,
    session_token: conversationToken(profile, session),
    updated_at: updatedAt,
    turns,
    memory_manifest: reconciledManifest,
    memory_diagnostics: diagnostics
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const profile = String(req.query?.profile_id || '');
  if (!profile) return json(res, 400, { ok: false, error: 'profile_required' });
  if (!memoryBlobConfigured()) return json(res, 503, { ok: false, error: 'memory_blob_not_configured' });
  try {
    const session = String(req.query?.session_id || '');
    const token = String(req.query?.token || '');
    if (session && token) {
      if (!verifyConversationToken(profile, session, token)) return json(res, 401, { ok: false, error: 'unauthorized' });
      return responseForSession(req, res, profile, session);
    }
    const clientId = String(req.query?.client_id || '');
    const clientKey = String(req.query?.client_key || '');
    if (!clientId || !clientKey) return json(res, 400, { ok: false, error: 'session_token_or_client_credentials_required' });
    const active = await resolveActiveSession(profile, clientId, clientKey);
    if (active?.unauthorized) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (!active?.session_id) return json(res, 404, { ok: false, error: 'active_session_not_found' });
    return responseForSession(req, res, profile, String(active.session_id), active.updated_at || null);
  } catch (error) {
    console.error('[history] failed', { profile, error: String(error?.message || error), stack: error?.stack || null });
    return json(res, 502, { ok: false, error: 'history_read_failed', detail: String(error?.message || error) });
  }
}
