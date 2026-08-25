import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import {
  bindActiveSession as legacyBindActiveSession,
  getRecentTurns as legacyGetRecentTurns,
  readSessionManifest as legacyReadSessionManifest,
  recordConversationTurn as legacyRecordConversationTurn,
  resolveActiveSession as legacyResolveActiveSession,
} from './conversation-store.js';
import {
  bindActiveSession as dbBindActiveSession,
  ensureOxMemorySchema,
  getHistory as dbGetHistory,
  getProfileMemory,
  getRecentTurns as dbGetRecentTurns,
  getSession as dbGetSession,
  memoryStats,
  oxDbConfigured,
  recordTurn as dbRecordTurn,
  resolveActiveSession as dbResolveActiveSession,
} from './ox-memory-db.js';
import { compressDueBlock, profileMemoryContext } from './ox-memory-engine.js';
import { oxMemoryStorageInfo } from './ox-memory-storage.js';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = process.env.OX_ALPHA_MODEL || 'stealth/ox-alpha';
const MAX_ATTACHMENTS = 4;
const MAX_TOTAL_ATTACHMENT_BYTES = 2_621_440;
const MAX_HISTORY_TURNS = 10;
const MAX_TEXT_ATTACHMENT_CHARS = 120_000;
const PROFILE_ID = 'ox-alpha-default';

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

const traceId = () => `ox_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
const clean = (value, limit = 4000) => String(value || '').slice(0, limit);
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function apiKeyInfo() {
  const candidates = [
    ['Ox_API', process.env.Ox_API],
    ['OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY],
    ['OX_API', process.env.OX_API],
  ];
  const found = candidates.find(([, value]) => String(value || '').trim());
  if (!found) return { key: '', source: null };
  let key = String(found[1]).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1).trim();
  return { key, source: found[0] };
}

function sessionSecret() {
  return String(process.env.OX_MEMORY_SIGNING_SECRET || process.env.Ox_API || process.env.OPENROUTER_API_KEY || process.env.OX_API || '').trim();
}

function sessionToken(profileId, sessionId, until = Date.now() + 30 * 24 * 60 * 60 * 1000) {
  const secret = sessionSecret();
  if (!secret) return null;
  const expiry = String(until);
  const mac = crypto.createHmac('sha256', secret).update(`${profileId}:${sessionId}.${expiry}`).digest('base64url');
  return `${expiry}.${mac}`;
}

function verifySessionToken(profileId, sessionId, token) {
  const secret = sessionSecret();
  if (!secret || typeof token !== 'string') return false;
  const [expiry, mac] = token.split('.');
  if (!expiry || !mac || Number(expiry) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${profileId}:${sessionId}.${expiry}`).digest('base64url');
  return safeEqual(mac, expected);
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(value || ''));
  if (!match) throw new Error('attachment_data_invalid');
  const mime = clean(match[1] || 'application/octet-stream', 160);
  const base64 = match[2].replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  return { mime, base64, buffer, bytes: buffer.byteLength, dataUrl: `data:${mime};base64,${base64}` };
}

function textLike(name, mime) {
  if (mime.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/javascript', 'application/x-javascript'].includes(mime)) return true;
  return /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|kts|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|css|scss|sass|less|html|htm|vue|svelte|toml|ini|cfg|conf|log)$/i.test(name);
}

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_ATTACHMENTS) throw new Error('too_many_attachments');
  let totalBytes = 0;
  const output = input.map((item, index) => {
    const name = clean(item?.name || `attachment-${index + 1}`, 180).trim() || `attachment-${index + 1}`;
    const parsed = parseDataUrl(item?.data);
    totalBytes += parsed.bytes;
    const mime = (clean(item?.type || parsed.mime, 160) || parsed.mime).toLowerCase();
    const kind = mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : textLike(name, mime) ? 'text' : 'unsupported';
    return { name, mime, kind, dataUrl: parsed.dataUrl, buffer: parsed.buffer, bytes: parsed.bytes };
  });
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('attachments_too_large');
  const unsupported = output.find(file => file.kind === 'unsupported');
  if (unsupported) throw new Error(`unsupported_attachment_type:${unsupported.name}:${unsupported.mime}`);
  return output;
}

async function resolveSession(payload) {
  const profileId = PROFILE_ID;
  const sessionId = clean(payload?.session_id || '', 160) || `ox_${crypto.randomUUID()}`;
  const suppliedToken = clean(payload?.session_token || '', 1024);
  const clientId = clean(payload?.client_id || '', 220);
  const clientKey = clean(payload?.client_key || '', 220);
  if (suppliedToken && verifySessionToken(profileId, sessionId, suppliedToken)) return { profileId, sessionId, clientId, clientKey, access: 'session_token' };

  if (oxDbConfigured()) {
    if (clientId && clientKey) {
      const active = await dbResolveActiveSession(profileId, clientId, clientKey);
      if (active?.unauthorized) throw new Error('ox_client_unauthorized');
      if (active?.session_id === sessionId) return { profileId, sessionId, clientId, clientKey, access: 'client_active_session' };
      const supplied = await dbGetSession(profileId, sessionId);
      if (Number(supplied?.turn_count || 0) > 0) throw new Error('ox_session_unauthorized');
      return { profileId, sessionId, clientId, clientKey, access: 'new_client_session' };
    }
    const supplied = await dbGetSession(profileId, sessionId);
    if (Number(supplied?.turn_count || 0) > 0) throw new Error('ox_credentials_required');
    return { profileId, sessionId, clientId: '', clientKey: '', access: 'new_unbound_session' };
  }

  if (clientId && clientKey) {
    const active = await legacyResolveActiveSession(profileId, clientId, clientKey);
    if (active?.unauthorized) throw new Error('ox_client_unauthorized');
    if (active?.session_id === sessionId) return { profileId, sessionId, clientId, clientKey, access: 'legacy_client_active_session' };
    const supplied = await legacyReadSessionManifest(profileId, sessionId);
    if (Number(supplied?.turn_count || 0) > 0) throw new Error('ox_session_unauthorized');
  }
  return { profileId, sessionId, clientId, clientKey, access: 'legacy_fallback' };
}

async function recentTurns(profileId, sessionId) {
  return oxDbConfigured() ? dbGetRecentTurns(profileId, sessionId, MAX_HISTORY_TURNS) : legacyGetRecentTurns(profileId, sessionId, MAX_HISTORY_TURNS);
}

function historyMessages(turns) {
  const messages = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    const request = clean(turn?.request ?? turn?.request_text, 6000).trim();
    const response = clean(turn?.response ?? turn?.response_text, 6000).trim();
    if (request) messages.push({ role: 'user', content: request });
    if (response) messages.push({ role: 'assistant', content: response });
  }
  return messages;
}

function currentUserContent(requestText, attachments) {
  if (!attachments.length) return requestText;
  const content = [{ type: 'text', text: requestText || '添付された内容を確認してください。' }];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') content.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
    else if (attachment.kind === 'pdf') content.push({ type: 'file', file: { filename: attachment.name, file_data: attachment.dataUrl } });
    else if (attachment.kind === 'text') {
      const text = attachment.buffer.toString('utf8').slice(0, MAX_TEXT_ATTACHMENT_CHARS);
      content.push({ type: 'text', text: `\n--- ${attachment.name} (${attachment.mime}) ---\n${text}\n--- end ${attachment.name} ---` });
    }
  }
  return content;
}

function requestRecordText(requestText, attachments) {
  if (!attachments.length) return requestText;
  const names = attachments.map(file => `${file.name} (${file.mime})`).join(', ');
  return `${requestText || '添付された内容を確認してください。'}\n\n[Attachments: ${names}]`;
}

function extractText(body) {
  const value = body?.choices?.[0]?.message?.content;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : part?.text).filter(Boolean).join('\n').trim();
  return '';
}

function parseUpstream(raw) { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
function upstreamDetail(body, raw) { return clean(body?.error?.message || body?.error?.detail || body?.detail || body?.message || raw || '', 1400).trim() || null; }

async function longTermContext(profileId) {
  if (!oxDbConfigured()) return '';
  try { return profileMemoryContext(await getProfileMemory(profileId)); }
  catch (error) { console.error('[ox-memory] read failed', { error: String(error?.message || error) }); return ''; }
}

export async function oxAlphaHealth() {
  const { key, source } = apiKeyInfo();
  const storage = oxMemoryStorageInfo();
  let memory = { ...storage, schema_ok: false, stats: null, error: null };
  if (storage.configured) {
    try {
      await ensureOxMemorySchema();
      memory = { ...storage, schema_ok: true, stats: await memoryStats(PROFILE_ID), error: null };
    } catch (error) {
      memory = { ...storage, schema_ok: false, stats: null, error: clean(error?.message || error, 500) };
    }
  }
  return {
    ok: true,
    service: 'response-tool-ox-alpha',
    api_key_configured: !!key,
    api_key_source: source,
    expected_env_key: 'Ox_API',
    environment: process.env.VERCEL_ENV || 'unknown',
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    commit_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    deployment_url: process.env.VERCEL_URL || null,
    provider: 'openrouter',
    model: DEFAULT_MODEL,
    memory,
  };
}

export async function oxAlphaHistory(req, res) {
  if (!oxDbConfigured()) return json(res, 503, { ok: false, error: 'ox_memory_database_not_configured' });
  const profileId = clean(req.query?.profile_id || PROFILE_ID, 160);
  const sessionId = clean(req.query?.session_id || '', 160);
  const token = clean(req.query?.token || '', 1024);
  if (profileId !== PROFILE_ID || !sessionId || !verifySessionToken(profileId, sessionId, token)) return json(res, 401, { ok: false, error: 'unauthorized' });
  try {
    const turns = await dbGetHistory(profileId, sessionId, Number(req.query?.limit) || 30);
    return json(res, 200, { ok: true, profile_id: profileId, session_id: sessionId, turns });
  } catch (error) {
    return json(res, 502, { ok: false, error: 'ox_history_failed', detail: clean(error?.message || error, 600) });
  }
}

export async function oxAlphaRelay(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const trace_id = traceId();
  const { key: apiKey, source: apiKeySource } = apiKeyInfo();
  if (!apiKey) return json(res, 503, { ok: false, trace_id, error: 'openrouter_api_key_missing', expected_env_key: 'Ox_API' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const requestText = clean(body.request_text, 24_000).trim();
  let attachments;
  try { attachments = normalizeAttachments(body.attachments); }
  catch (error) {
    const message = String(error?.message || error);
    return json(res, message.startsWith('unsupported_attachment_type:') ? 415 : 413, { ok: false, trace_id, error: message });
  }
  if (!requestText && !attachments.length) return json(res, 400, { ok: false, trace_id, error: 'request_required' });

  let session;
  try { session = await resolveSession(body); }
  catch (error) { return json(res, 401, { ok: false, trace_id, error: String(error?.message || error) }); }

  try {
    const [recent, memoryContext] = await Promise.all([recentTurns(session.profileId, session.sessionId), longTermContext(session.profileId)]);
    const systemParts = [
      'You are Ox Alpha running through OpenRouter for Response Tool.',
      'This chat is isolated from the Yuki profile, relationship state, permissions, and memory namespace.',
      'Use durable memory as fallible derived context. The current user message always overrides stale or conflicting memory.',
      'Use recent conversation turns for local continuity.',
      'Current-message attachments are request-scoped and are not guaranteed to exist on later turns.',
      'Answer directly in the language used by the user unless another language is requested.',
    ];
    if (memoryContext) systemParts.push(memoryContext);
    const messages = [
      { role: 'system', content: systemParts.join(' ') },
      ...historyMessages(recent),
      { role: 'user', content: currentUserContent(requestText, attachments) },
    ];

    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Response Tool / Ox Alpha' };
    if (process.env.VERCEL_URL) headers['HTTP-Referer'] = `https://${process.env.VERCEL_URL}`;
    const upstream = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST', headers,
      body: JSON.stringify({ model: DEFAULT_MODEL, messages, stream: false, max_tokens: Math.max(64, Math.min(Number(body.max_output_tokens) || 1800, 4000)) }),
    });
    const raw = await upstream.text();
    const upstreamBody = parseUpstream(raw);
    if (!upstream.ok) {
      const detail = upstreamDetail(upstreamBody, raw), errorCode = clean(upstreamBody?.error?.code || upstreamBody?.code || '', 160) || null;
      console.error('[openrouter-ox-alpha] rejected', { trace_id, status: upstream.status, model: DEFAULT_MODEL, error_code: errorCode, detail });
      return json(res, upstream.status === 429 ? 429 : 502, { ok: false, trace_id, error: upstream.status === 429 ? 'openrouter_rate_limit' : 'openrouter_external_error', http_status: upstream.status, error_code: errorCode, detail, model: DEFAULT_MODEL });
    }

    const text = extractText(upstreamBody);
    if (!text) return json(res, 502, { ok: false, trace_id, error: 'openrouter_empty_response', model: DEFAULT_MODEL });

    const recordArgs = {
      profileId: session.profileId,
      sessionId: session.sessionId,
      traceId: trace_id,
      requestId: clean(body.request_id || trace_id, 220),
      requestText: requestRecordText(requestText, attachments),
      responseText: text,
      metadata: { renderer: 'ox-alpha', provider: 'openrouter', isolated_from_yuki: true, attachment_count: attachments.length, model: DEFAULT_MODEL },
    };
    let recorded;
    if (oxDbConfigured()) {
      recorded = await dbRecordTurn(recordArgs);
      if (session.clientId && session.clientKey) await dbBindActiveSession(session.profileId, session.sessionId, session.clientId, session.clientKey);
      if (recorded?.compression_due) {
        waitUntil(compressDueBlock({ profileId: session.profileId, sessionId: session.sessionId, turnNo: Number(recorded.turn_no) }));
      }
    } else {
      recorded = await legacyRecordConversationTurn({ ...recordArgs, yukiState: recordArgs.metadata });
      if (session.clientId && session.clientKey) await legacyBindActiveSession(session.profileId, session.sessionId, session.clientId, session.clientKey);
    }

    return json(res, 200, {
      ok: true,
      service: 'response-tool-ox-alpha',
      trace_id,
      result_type: 'generated_text',
      text,
      provider: 'openrouter',
      model: upstreamBody?.model || DEFAULT_MODEL,
      usage: upstreamBody?.usage || null,
      api_key_source: apiKeySource,
      memory: {
        provider: oxDbConfigured() ? 'neon_postgres_isolated' : 'legacy_fallback',
        long_term_enabled: oxDbConfigured(),
        compression_due: !!recorded?.compression_due,
        block_no: Number(recorded?.block_no || 0),
      },
      attachments: attachments.map(file => ({ name: file.name, type: file.mime, bytes: file.bytes, kind: file.kind })),
      session: {
        profile_id: session.profileId,
        session_id: session.sessionId,
        session_token: sessionToken(session.profileId, session.sessionId),
        access: session.access,
        turn_no: Number(recorded?.turn_no || 0),
      },
    });
  } catch (error) {
    console.error('[openrouter-ox-alpha] failed', { trace_id, error: String(error?.message || error), stack: error?.stack || null });
    return json(res, 502, { ok: false, trace_id, error: 'openrouter_request_failed', detail: String(error?.message || error) });
  }
}
