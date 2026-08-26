import crypto from 'node:crypto';

const OPENROUTER_SPEECH_ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
const SPEECH_MODEL = process.env.OX_SPEECH_MODEL || 'fish-audio/s2.1-pro-free:free';
const MAX_SPEECH_INPUT_BYTES = 32_000;
const MAX_REFERENCE_AUDIO_BYTES = 2_097_152;
const MAX_AUDIO_OUTPUT_BYTES = 3_000_000;
const AUDIO_FORMATS = new Set(['mp3', 'pcm']);

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

const clean = (value, limit = 4000) => String(value ?? '').slice(0, limit);
const traceId = () => `speech_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;

function apiKeyInfo() {
  const candidates = [
    ['OX_SPEECH_API_KEY', process.env.OX_SPEECH_API_KEY],
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

function mimeForFormat(format) {
  if (format === 'pcm') return 'audio/L16';
  return 'audio/mpeg';
}

function extensionForFormat(format) {
  return format === 'pcm' ? 'pcm' : 'mp3';
}

function parseAudioDataUrl(value, declaredType = '') {
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(value || ''));
  if (!match) throw new Error('reference_audio_data_invalid');
  const mime = clean(declaredType || match[1] || 'application/octet-stream', 120).toLowerCase();
  if (!mime.startsWith('audio/')) throw new Error(`reference_audio_type_unsupported:${mime}`);
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('reference_audio_empty');
  if (buffer.byteLength > MAX_REFERENCE_AUDIO_BYTES) throw new Error(`reference_audio_too_large:${buffer.byteLength}`);
  return { mime, bytes: buffer.byteLength };
}

function normalizeReferenceAudio(value) {
  if (!value) return null;
  const name = clean(value?.name || 'reference-audio', 180).replace(/[\\/]+/g, '_');
  const parsed = parseAudioDataUrl(value?.data, value?.type);
  return { name, ...parsed };
}

function upstreamDetail(raw) {
  try {
    const body = JSON.parse(raw || '{}');
    return clean(body?.error?.metadata?.raw || body?.error?.message || body?.message || raw, 1600).trim() || null;
  } catch {
    return clean(raw, 1600).trim() || null;
  }
}

export function oxSpeechHealth() {
  const { key, source } = apiKeyInfo();
  return {
    enabled: true,
    provider: 'openrouter',
    model: SPEECH_MODEL,
    api_key_configured: !!key,
    api_key_source: source,
    endpoint: '/api/architecture?mode=ox-speech',
    input_modalities: ['text'],
    output_modalities: ['speech'],
    formats: [...AUDIO_FORMATS],
    default_format: 'mp3',
    max_input_bytes: MAX_SPEECH_INPUT_BYTES,
    max_reference_audio_bytes: MAX_REFERENCE_AUDIO_BYTES,
    max_audio_output_bytes: MAX_AUDIO_OUTPUT_BYTES,
    reference_audio_handoff: {
      enabled: true,
      persistent: false,
      forwarded_to_openrouter: false,
      reason: 'OpenRouter currently advertises this Fish Audio model as text-to-speech only; raw reference audio is retained request-scoped for a future voice-clone adapter.',
    },
  };
}

export async function oxSpeechRelay(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const trace_id = traceId();
  const { key, source } = apiKeyInfo();
  if (!key) return json(res, 503, { ok: false, trace_id, error: 'openrouter_api_key_missing' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const input = String(body.input ?? body.text ?? '').trim();
  if (!input) return json(res, 400, { ok: false, trace_id, error: 'speech_input_required' });
  const inputBytes = Buffer.byteLength(input, 'utf8');
  if (inputBytes > MAX_SPEECH_INPUT_BYTES) return json(res, 413, { ok: false, trace_id, error: 'speech_input_too_large', input_bytes: inputBytes, max_input_bytes: MAX_SPEECH_INPUT_BYTES });

  const format = AUDIO_FORMATS.has(String(body.response_format || '').toLowerCase()) ? String(body.response_format).toLowerCase() : 'mp3';
  const voice = clean(body.voice || '', 220).trim();
  let referenceAudio = null;
  try { referenceAudio = normalizeReferenceAudio(body.reference_audio); }
  catch (error) { return json(res, 413, { ok: false, trace_id, error: String(error?.message || error) }); }

  const requestBody = { model: SPEECH_MODEL, input, response_format: format };
  if (voice) requestBody.voice = voice;

  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-Title': 'Response Tool / Fish Audio S2.1 Pro Free',
  };
  if (process.env.VERCEL_URL) headers['HTTP-Referer'] = `https://${process.env.VERCEL_URL}`;

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await fetch(OPENROUTER_SPEECH_ENDPOINT, { method: 'POST', headers, body: JSON.stringify(requestBody) });
  } catch (error) {
    return json(res, 502, { ok: false, trace_id, error: 'speech_request_failed', detail: clean(error?.message || error, 800) });
  }

  const elapsedMs = Date.now() - startedAt;
  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => '');
    const retryAfterRaw = upstream.headers.get('retry-after');
    const retryAfter = retryAfterRaw && Number.isFinite(Number(retryAfterRaw)) ? Number(retryAfterRaw) : null;
    console.error('[openrouter-fish-speech] rejected', { trace_id, status: upstream.status, model: SPEECH_MODEL, elapsed_ms: elapsedMs, detail: upstreamDetail(raw) });
    return json(res, upstream.status === 429 ? 429 : 502, {
      ok: false,
      trace_id,
      error: upstream.status === 429 ? 'speech_rate_limit' : 'speech_external_error',
      http_status: upstream.status,
      detail: upstreamDetail(raw),
      retry_after_seconds: retryAfter,
      model: SPEECH_MODEL,
      reference_audio: referenceAudio ? { ...referenceAudio, received: true, forwarded_to_openrouter: false } : null,
    });
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (!buffer.length) return json(res, 502, { ok: false, trace_id, error: 'speech_empty_response', model: SPEECH_MODEL });
  if (buffer.byteLength > MAX_AUDIO_OUTPUT_BYTES) {
    return json(res, 502, { ok: false, trace_id, error: 'speech_output_too_large_for_inline_handoff', bytes: buffer.byteLength, max_bytes: MAX_AUDIO_OUTPUT_BYTES });
  }

  const ext = extensionForFormat(format);
  const artifact = {
    id: `art_audio_${crypto.randomBytes(8).toString('hex')}`,
    filename: `fish-s2.1-${Date.now()}.${ext}`,
    mime: upstream.headers.get('content-type')?.split(';')[0] || mimeForFormat(format),
    encoding: 'base64',
    bytes: buffer.byteLength,
    data_base64: buffer.toString('base64'),
    source: 'openrouter-fish-audio',
    persistent: false,
  };

  console.info('[openrouter-fish-speech] generated', { trace_id, model: SPEECH_MODEL, bytes: buffer.byteLength, format, elapsed_ms: elapsedMs, reference_audio_received: !!referenceAudio, voice_supplied: !!voice });
  return json(res, 200, {
    ok: true,
    service: 'response-tool-speech',
    trace_id,
    result_type: 'generated_speech',
    text: 'Fish Audio S2.1 Pro Freeで音声を生成しました。',
    provider: 'openrouter',
    model: SPEECH_MODEL,
    api_key_source: source,
    generation: { input_bytes: inputBytes, audio_bytes: buffer.byteLength, response_format: format, elapsed_ms: elapsedMs, voice_supplied: !!voice },
    reference_audio: referenceAudio ? { ...referenceAudio, received: true, persistent: false, forwarded_to_openrouter: false } : null,
    artifacts: [artifact],
    artifact_handoff: { enabled: true, mode: 'inline_base64', persistent: false, kind: 'audio' },
  });
}
