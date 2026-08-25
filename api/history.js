import crypto from 'node:crypto';
import {
  getHistory,
  getTurnsRange,
  getMemoryDiagnostics,
  getStorageManifest,
  memoryBlobConfigured,
  resolveActiveSession
} from '../src/conversation-blob.js';
import { conversationToken, verifyConversationToken } from '../src/conversation-auth.js';
import { ensureLegacySessionCompatibility } from '../src/legacy-memory-compat.js';
import { getHistory as getOxHistory, oxDbConfigured } from '../src/ox-memory-db.js';

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(body));
};

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const oxSecret = () => String(process.env.OX_MEMORY_SIGNING_SECRET || process.env.Ox_API || process.env.OPENROUTER_API_KEY || process.env.OX_API || '').trim();
function verifyOxToken(profileId, sessionId, token) {
  const secret = oxSecret();
  if (!secret || typeof token !== 'string') return false;
  const [expiry, mac] = token.split('.');
  if (!expiry || !mac || Number(expiry) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${profileId}:${sessionId}.${expiry}`).digest('base64url');
  return safeEqual(mac, expected);
}

async function oxHistoryResponse(req, res, profile, session, token) {
  if (!verifyOxToken(profile, session, token)) return json(res, 401, { ok: false, error: 'unauthorized' });
  const turns = await getOxHistory(profile, session, req.query?.limit || 30);
  return json(res, 200, {
    ok: true,
    profile_id: profile,
    session_id: session,
    turns,
    memory_manifest: { provider: 'neon_postgres_isolated', long_term_memory: true },
  });
}

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
  await ensureLegacySessionCompatibility(profile, session);
  const includeMemory = String(req.query?.include_memory || '') === '1';
  const diagnostics = includeMemory ? await getMemoryDiagnostics(profile, session, req.query?.memory_limit) : null;
  const manifest = diagnostics?.manifest || await getStorageManifest(profile, session);
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
  const coherentDiagnostics = diagnostics ? { ...diagnostics, manifest: reconciledManifest } : null;
  return json(res, 200, {
    ok: true,
    profile_id: profile,
    session_id: session,
    session_token: conversationToken(profile, session),
    updated_at: updatedAt,
    turns,
    memory_manifest: reconciledManifest,
    memory_diagnostics: coherentDiagnostics
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const profile = String(req.query?.profile_id || '');
  if (!profile) return json(res, 400, { ok: false, error: 'profile_required' });
  try {
    const session = String(req.query?.session_id || '');
    const token = String(req.query?.token || '');
    if (profile === 'ox-alpha-default' && oxDbConfigured()) {
      if (!session || !token) return json(res, 400, { ok: false, error: 'session_token_required' });
      return oxHistoryResponse(req, res, profile, session, token);
    }
    if (!memoryBlobConfigured()) return json(res, 503, { ok: false, error: 'memory_blob_not_configured' });
    const clientId = String(req.query?.client_id || '');
    const clientKey = String(req.query?.client_key || '');
    if (session && token && verifyConversationToken(profile, session, token)) return responseForSession(req, res, profile, session);
    if (session && token && (!clientId || !clientKey)) return json(res, 401, { ok: false, error: 'unauthorized' });
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
