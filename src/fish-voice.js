import crypto from 'node:crypto';

const FISH_API_BASE = 'https://api.fish.audio';
const FISH_TTS_MODEL = process.env.FISH_AUDIO_MODEL || 's2.1-pro-free';
const MAX_VOICE_FILES = 3;
const MAX_VOICE_FILE_BYTES = 2_500_000;
const MAX_VOICE_TOTAL_BYTES = 3_000_000;

const clean = (value, limit = 4000) => String(value ?? '').slice(0, limit);
const traceId = prefix => `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

export function fishApiKeyInfo() {
  const candidates = [
    ['FISH_AUDIO_API_KEY', process.env.FISH_AUDIO_API_KEY],
    ['FISH_API_KEY', process.env.FISH_API_KEY],
  ];
  const found = candidates.find(([, value]) => String(value || '').trim());
  if (!found) return { key: '', source: null };
  let key = String(found[1]).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1).trim();
  return { key, source: found[0] };
}

function parseAudioDataUrl(value, declaredType = '') {
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(value || ''));
  if (!match) throw new Error('voice_sample_data_invalid');
  const mime = clean(declaredType || match[1] || 'application/octet-stream', 120).toLowerCase();
  if (!mime.startsWith('audio/')) throw new Error(`voice_sample_type_unsupported:${mime}`);
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('voice_sample_empty');
  if (buffer.byteLength > MAX_VOICE_FILE_BYTES) throw new Error(`voice_sample_too_large:${buffer.byteLength}`);
  return { mime, buffer, bytes: buffer.byteLength };
}

function normalizeSamples(values) {
  const samples = Array.isArray(values) ? values : [];
  if (!samples.length) throw new Error('voice_sample_required');
  if (samples.length > MAX_VOICE_FILES) throw new Error(`too_many_voice_samples:${samples.length}`);
  const normalized = samples.map((sample, index) => {
    const parsed = parseAudioDataUrl(sample?.data, sample?.type);
    const name = clean(sample?.name || `voice-sample-${index + 1}.mp3`, 160).replace(/[\\/]+/g, '_');
    const text = clean(sample?.text || '', 3000).trim();
    return { name, text, ...parsed };
  });
  const totalBytes = normalized.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > MAX_VOICE_TOTAL_BYTES) throw new Error(`voice_samples_total_too_large:${totalBytes}`);
  return { samples: normalized, totalBytes };
}

async function readJsonSafe(response) {
  const raw = await response.text().catch(() => '');
  if (!raw) return { raw: '', body: null };
  try { return { raw, body: JSON.parse(raw) }; }
  catch { return { raw, body: null }; }
}

function upstreamDetail(raw, body) {
  return clean(body?.detail || body?.message || body?.error?.message || body?.error || raw, 1800).trim() || null;
}

export function fishVoiceHealth() {
  const { key, source } = fishApiKeyInfo();
  return {
    enabled: true,
    api_key_configured: !!key,
    api_key_source: source,
    provider: 'fish_audio_direct',
    model: FISH_TTS_MODEL,
    clone_endpoint: '/api/architecture?mode=fish-voice-clone',
    status_endpoint: '/api/architecture?mode=fish-voice-status',
    max_voice_files: MAX_VOICE_FILES,
    max_voice_file_bytes: MAX_VOICE_FILE_BYTES,
    max_voice_total_bytes: MAX_VOICE_TOTAL_BYTES,
    clone_defaults: {
      type: 'tts',
      train_mode: 'fast',
      visibility: 'private',
      enhance_audio_quality: true,
      generate_sample: false,
    },
  };
}

export async function fishVoiceClone(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const trace_id = traceId('voice_clone');
  const { key, source } = fishApiKeyInfo();
  if (!key) return json(res, 503, { ok: false, trace_id, error: 'fish_audio_api_key_missing', expected_env: 'FISH_AUDIO_API_KEY' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const title = clean(body.title || '', 80).trim();
  if (!title) return json(res, 400, { ok: false, trace_id, error: 'voice_clone_title_required' });

  let normalized;
  try { normalized = normalizeSamples(body.samples); }
  catch (error) {
    const message = String(error?.message || error);
    const status = message.includes('too_large') ? 413 : 400;
    return json(res, status, { ok: false, trace_id, error: message });
  }

  const form = new FormData();
  form.append('type', 'tts');
  form.append('title', title);
  form.append('train_mode', 'fast');
  form.append('visibility', 'private');
  form.append('enhance_audio_quality', 'true');
  form.append('generate_sample', 'false');
  const description = clean(body.description || 'Created from Response Tool voice response panel.', 300).trim();
  if (description) form.append('description', description);

  const allHaveText = normalized.samples.every(sample => sample.text);
  for (const sample of normalized.samples) {
    form.append('voices', new Blob([sample.buffer], { type: sample.mime }), sample.name);
    if (allHaveText) form.append('texts', sample.text);
  }

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await fetch(`${FISH_API_BASE}/model`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch (error) {
    return json(res, 502, { ok: false, trace_id, error: 'fish_voice_clone_request_failed', detail: clean(error?.message || error, 800) });
  }

  const elapsed_ms = Date.now() - startedAt;
  const { raw, body: upstreamBody } = await readJsonSafe(upstream);
  if (!upstream.ok || !upstreamBody?._id) {
    const detail = upstreamDetail(raw, upstreamBody);
    console.error('[fish-voice-clone] rejected', { trace_id, status: upstream.status, elapsed_ms, detail, sample_count: normalized.samples.length, sample_bytes: normalized.totalBytes });
    return json(res, upstream.status === 401 ? 401 : upstream.status === 429 ? 429 : 502, {
      ok: false,
      trace_id,
      error: upstream.status === 401 ? 'fish_audio_auth_failed' : upstream.status === 429 ? 'fish_voice_clone_rate_limit' : 'fish_voice_clone_external_error',
      http_status: upstream.status,
      detail,
    });
  }

  const voice = {
    id: upstreamBody._id,
    title: upstreamBody.title || title,
    state: upstreamBody.state || 'created',
    visibility: upstreamBody.visibility || 'private',
    train_mode: upstreamBody.train_mode || 'fast',
    created_at: upstreamBody.created_at || null,
  };
  console.info('[fish-voice-clone] created', { trace_id, voice_id: voice.id, state: voice.state, elapsed_ms, sample_count: normalized.samples.length, sample_bytes: normalized.totalBytes });
  return json(res, 201, {
    ok: true,
    service: 'response-tool-fish-voice-clone',
    trace_id,
    provider: 'fish_audio_direct',
    api_key_source: source,
    voice,
    samples: { count: normalized.samples.length, bytes: normalized.totalBytes, transcripts_supplied: allHaveText },
  });
}

export async function fishVoiceStatus(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const trace_id = traceId('voice_status');
  const { key } = fishApiKeyInfo();
  if (!key) return json(res, 503, { ok: false, trace_id, error: 'fish_audio_api_key_missing', expected_env: 'FISH_AUDIO_API_KEY' });
  const voiceId = clean(req.query?.id || '', 120).trim();
  if (!voiceId) return json(res, 400, { ok: false, trace_id, error: 'voice_id_required' });

  let upstream;
  try {
    upstream = await fetch(`${FISH_API_BASE}/model/${encodeURIComponent(voiceId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (error) {
    return json(res, 502, { ok: false, trace_id, error: 'fish_voice_status_request_failed', detail: clean(error?.message || error, 800) });
  }
  const { raw, body } = await readJsonSafe(upstream);
  if (!upstream.ok || !body?._id) return json(res, upstream.status === 404 ? 404 : 502, { ok: false, trace_id, error: 'fish_voice_status_external_error', http_status: upstream.status, detail: upstreamDetail(raw, body) });
  return json(res, 200, {
    ok: true,
    trace_id,
    voice: {
      id: body._id,
      title: body.title || '',
      state: body.state || 'unknown',
      visibility: body.visibility || null,
      train_mode: body.train_mode || null,
      created_at: body.created_at || null,
      updated_at: body.updated_at || null,
    },
  });
}

export async function fishDirectTts({ text, referenceId = '', format = 'mp3' }) {
  const { key, source } = fishApiKeyInfo();
  if (!key) {
    const error = new Error('fish_audio_api_key_missing');
    error.code = 'fish_audio_api_key_missing';
    throw error;
  }
  const body = { text: String(text || ''), format: format === 'pcm' ? 'pcm' : 'mp3' };
  if (referenceId) body.reference_id = referenceId;
  const startedAt = Date.now();
  const response = await fetch(`${FISH_API_BASE}/v1/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      model: FISH_TTS_MODEL,
    },
    body: JSON.stringify(body),
  });
  const elapsed_ms = Date.now() - startedAt;
  if (!response.ok) {
    const { raw, body: errorBody } = await readJsonSafe(response);
    const error = new Error(upstreamDetail(raw, errorBody) || `fish_tts_http_${response.status}`);
    error.status = response.status;
    error.httpStatus = response.status;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    contentType: response.headers.get('content-type')?.split(';')[0] || (body.format === 'pcm' ? 'audio/L16' : 'audio/mpeg'),
    elapsed_ms,
    model: FISH_TTS_MODEL,
    api_key_source: source,
    reference_id: referenceId || null,
  };
}
