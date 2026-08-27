import crypto from 'node:crypto';
import {
  bindActiveSession,
  getRecentTurns,
  readSessionManifest,
  recordConversationTurn,
  resolveActiveSession,
} from './conversation-store.js';
import { conversationToken, verifyConversationToken } from './conversation-auth.js';

const VENICE_ENDPOINT = 'https://api.venice.ai/api/v1/chat/completions';
const DEFAULT_MODEL = process.env.VENICE_MODEL || 'venice-uncensored-1-2';
const DEFAULT_VISION_MODEL = process.env.VENICE_VISION_MODEL || DEFAULT_MODEL;
const MAX_ATTACHMENTS = 4;
const MAX_TOTAL_ATTACHMENT_BYTES = 2_621_440;
const MAX_HISTORY_TURNS = 10;

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

const traceId = () => `vr_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
const clean = (value, limit = 4000) => String(value || '').slice(0, limit);

function normalizedApiKey() {
  let key = String(process.env.VENICE_API_KEY || '').trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(value || ''));
  if (!match) throw new Error('attachment_data_invalid');
  const mime = clean(match[1] || 'application/octet-stream', 160);
  const base64 = match[2].replace(/\s+/g, '');
  const bytes = Buffer.from(base64, 'base64').byteLength;
  return { mime, base64, bytes, dataUrl: `data:${mime};base64,${base64}` };
}

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_ATTACHMENTS) throw new Error('too_many_attachments');
  let totalBytes = 0;
  const output = input.map((item, index) => {
    const name = clean(item?.name || `attachment-${index + 1}`, 180).trim() || `attachment-${index + 1}`;
    const parsed = parseDataUrl(item?.data);
    totalBytes += parsed.bytes;
    const mime = clean(item?.type || parsed.mime, 160) || parsed.mime;
    return { name, mime, dataUrl: parsed.dataUrl, bytes: parsed.bytes, isImage: mime.toLowerCase().startsWith('image/') };
  });
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('attachments_too_large');
  return output;
}

async function resolveSession(payload) {
  const profileId = 'venice-default';
  const sessionId = clean(payload?.session_id || '', 160) || `venice_${crypto.randomUUID()}`;
  const sessionToken = clean(payload?.session_token || '', 1024);
  const clientId = clean(payload?.client_id || '', 220);
  const clientKey = clean(payload?.client_key || '', 220);

  if (sessionToken && verifyConversationToken(profileId, sessionId, sessionToken)) {
    return { profileId, sessionId, clientId, clientKey, access: 'session_token' };
  }

  if (clientId && clientKey) {
    const active = await resolveActiveSession(profileId, clientId, clientKey);
    if (active?.unauthorized) throw new Error('venice_client_unauthorized');
    if (active?.session_id && String(active.session_id) === sessionId) {
      return { profileId, sessionId, clientId, clientKey, access: 'client_active_session' };
    }
    const supplied = await readSessionManifest(profileId, sessionId);
    if (Number(supplied?.turn_count || 0) > 0) throw new Error('venice_session_unauthorized');
    return { profileId, sessionId, clientId, clientKey, access: 'new_client_session' };
  }

  const supplied = await readSessionManifest(profileId, sessionId);
  if (Number(supplied?.turn_count || 0) > 0) throw new Error('venice_credentials_required');
  return { profileId, sessionId, clientId: '', clientKey: '', access: 'new_unbound_session' };
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
    if (attachment.isImage) {
      content.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
    } else {
      content.push({ type: 'file', file: { file_data: attachment.dataUrl, filename: attachment.name } });
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

function parseUpstream(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function upstreamDetail(body, raw) {
  return clean(
    body?.error?.message || body?.error?.detail || body?.detail || body?.message || raw || '',
    1200,
  ).trim() || null;
}

export async function veniceRelay(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const trace_id = traceId();
  const apiKey = normalizedApiKey();

  if (!apiKey) return json(res, 503, { ok: false, trace_id, error: 'venice_api_key_missing' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const requestText = clean(body.request_text, 24_000).trim();
  let attachments;
  try {
    attachments = normalizeAttachments(body.attachments);
  } catch (error) {
    return json(res, 413, { ok: false, trace_id, error: String(error?.message || error) });
  }
  if (!requestText && !attachments.length) return json(res, 400, { ok: false, trace_id, error: 'request_required' });

  let session;
  try {
    session = await resolveSession(body);
  } catch (error) {
    return json(res, 401, { ok: false, trace_id, error: String(error?.message || error) });
  }

  try {
    const recentTurns = await getRecentTurns(session.profileId, session.sessionId, MAX_HISTORY_TURNS);
    const hasImage = attachments.some(file => file.isImage);
    const model = hasImage ? DEFAULT_VISION_MODEL : DEFAULT_MODEL;
    const messages = [
      {
        role: 'system',
        content: [
          'You are the Venice renderer for Response Tool.',
          'This Venice chat is isolated from the Yuki profile, relationship state, permissions, and memory namespace.',
          'Use recent conversation turns only as continuity context when relevant.',
          'Current-message attachments are request-scoped and are not guaranteed to exist on later turns.',
          'Answer directly in the language used by the user unless another language is requested.',
        ].join(' '),
      },
      ...historyMessages(recentTurns),
      { role: 'user', content: currentUserContent(requestText, attachments) },
    ];

    const requestBody = {
      model,
      messages,
      stream: false,
      max_tokens: Math.max(64, Math.min(Number(body.max_output_tokens) || 1800, 4000)),
    };

    const upstream = await fetch(VENICE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const raw = await upstream.text();
    const upstreamBody = parseUpstream(raw);

    if (!upstream.ok) {
      const detail = upstreamDetail(upstreamBody, raw);
      const errorCode = clean(upstreamBody?.error?.code || upstreamBody?.code || '', 160) || null;
      const upstreamRequestId = upstream.headers.get('x-request-id') || upstream.headers.get('request-id') || null;
      console.error('[venice-upstream] rejected', {
        trace_id,
        status: upstream.status,
        model,
        error_code: errorCode,
        detail,
        upstream_request_id: upstreamRequestId,
      });
      return json(res, upstream.status === 429 ? 429 : 502, {
        ok: false,
        trace_id,
        error: upstream.status === 429 ? 'venice_rate_limit' : 'venice_external_error',
        http_status: upstream.status,
        error_code: errorCode,
        detail,
        upstream_request_id: upstreamRequestId,
        model,
      });
    }

    const text = extractText(upstreamBody);
    if (!text) {
      console.error('[venice-upstream] empty response', { trace_id, model, raw_preview: clean(raw, 600) });
      return json(res, 502, { ok: false, trace_id, error: 'venice_empty_response', model });
    }

    const recordText = requestRecordText(requestText, attachments);
    const recorded = await recordConversationTurn({
      profileId: session.profileId,
      sessionId: session.sessionId,
      traceId: trace_id,
      requestId: clean(body.request_id || trace_id, 220),
      requestText: recordText,
      responseText: text,
      yukiState: { renderer: 'venice', isolated_from_yuki: true, attachment_count: attachments.length, model },
    });

    if (session.clientId && session.clientKey) await bindActiveSession(session.profileId, session.sessionId, session.clientId, session.clientKey);

    return json(res, 200, {
      ok: true,
      service: 'response-tool-venice',
      trace_id,
      result_type: 'generated_text',
      text,
      provider: 'venice',
      model: upstreamBody?.model || model,
      usage: upstreamBody?.usage || null,
      attachments: attachments.map(file => ({ name: file.name, type: file.mime, bytes: file.bytes })),
      session: {
        profile_id: session.profileId,
        session_id: session.sessionId,
        session_token: conversationToken(session.profileId, session.sessionId),
        access: session.access,
        turn_no: Number(recorded?.turn_no || 0),
      },
    });
  } catch (error) {
    console.error('[venice-relay] failed', { trace_id, error: String(error?.message || error), stack: error?.stack || null });
    return json(res, 502, { ok: false, trace_id, error: 'venice_request_failed', detail: String(error?.message || error) });
  }
}
