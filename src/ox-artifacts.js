import crypto from 'node:crypto';

const MAX_ARTIFACTS = 4;
const MAX_ARTIFACT_BYTES = 524_288;

const EXTENSION_MIME = {
  txt: 'text/plain;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  tsv: 'text/tab-separated-values;charset=utf-8',
  json: 'application/json;charset=utf-8',
  jsonl: 'application/x-ndjson;charset=utf-8',
  xml: 'application/xml;charset=utf-8',
  yaml: 'application/yaml;charset=utf-8',
  yml: 'application/yaml;charset=utf-8',
  html: 'text/html;charset=utf-8',
  htm: 'text/html;charset=utf-8',
  css: 'text/css;charset=utf-8',
  js: 'text/javascript;charset=utf-8',
  mjs: 'text/javascript;charset=utf-8',
  cjs: 'text/javascript;charset=utf-8',
  ts: 'text/plain;charset=utf-8',
  tsx: 'text/plain;charset=utf-8',
  jsx: 'text/plain;charset=utf-8',
  py: 'text/x-python;charset=utf-8',
  sh: 'text/x-shellscript;charset=utf-8',
  bash: 'text/x-shellscript;charset=utf-8',
  zsh: 'text/x-shellscript;charset=utf-8',
  bat: 'text/plain;charset=utf-8',
  cmd: 'text/plain;charset=utf-8',
  ps1: 'text/plain;charset=utf-8',
  psm1: 'text/plain;charset=utf-8',
  psd1: 'text/plain;charset=utf-8',
  sql: 'text/plain;charset=utf-8',
  log: 'text/plain;charset=utf-8',
  ini: 'text/plain;charset=utf-8',
  cfg: 'text/plain;charset=utf-8',
  conf: 'text/plain;charset=utf-8',
  toml: 'text/plain;charset=utf-8',
};

const EXTENSIONS = Object.keys(EXTENSION_MIME);
const EXT_PATTERN = EXTENSIONS.join('|');

function clean(value, limit = 4000) {
  return String(value ?? '').slice(0, limit);
}

function extensionOf(filename) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return match ? match[1].toLowerCase() : '';
}

function sanitizeFilename(value, fallback = 'generated.txt') {
  let name = clean(value, 160)
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^\.+/, '');
  if (!name) name = fallback;
  const ext = extensionOf(name);
  if (!EXTENSION_MIME[ext]) return fallback;
  return name.slice(0, 140);
}

function mimeFor(filename, requestedMime = '') {
  const ext = extensionOf(filename);
  const canonical = EXTENSION_MIME[ext] || 'text/plain;charset=utf-8';
  const requested = clean(requestedMime, 120).toLowerCase();
  if (requested.startsWith('text/') || requested.startsWith('application/json') || requested.startsWith('application/xml') || requested.startsWith('application/yaml')) {
    return requested.includes('charset=') ? requested : `${requested};charset=utf-8`;
  }
  return canonical;
}

function buildArtifact(filename, mime, content, source = 'ox-alpha') {
  const safeName = sanitizeFilename(filename);
  const text = String(content ?? '');
  const buffer = Buffer.from(text, 'utf8');
  if (!buffer.length || buffer.byteLength > MAX_ARTIFACT_BYTES) return null;
  return {
    id: `art_${crypto.randomBytes(8).toString('hex')}`,
    filename: safeName,
    mime: mimeFor(safeName, mime),
    encoding: 'utf-8',
    bytes: buffer.byteLength,
    content: text,
    source,
    persistent: false,
  };
}

function explicitArtifacts(text) {
  const artifacts = [];
  const marker = /<<<RT_ARTIFACT\s+(\{[^\r\n]+\})>>>\r?\n([\s\S]*?)\r?\n<<<END_RT_ARTIFACT>>>/g;
  const visible = String(text || '').replace(marker, (full, rawMeta, content) => {
    if (artifacts.length >= MAX_ARTIFACTS) return '';
    try {
      const meta = JSON.parse(rawMeta);
      const artifact = buildArtifact(meta?.filename, meta?.mime, content, 'ox-alpha-explicit');
      if (artifact) {
        artifacts.push(artifact);
        return '';
      }
    } catch {}
    return full;
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: visible, artifacts };
}

function requestedFilename(requestText) {
  const text = String(requestText || '');
  const exact = new RegExp(`([\\p{L}\\p{N}_().\\-（）]+\\.(?:${EXT_PATTERN}))`, 'iu').exec(text);
  if (exact) return sanitizeFilename(exact[1]);

  const asksForFile = /(ファイル|file|ダウンロード|download|保存|出力)/i.test(text);
  if (!asksForFile) return null;

  const formats = [
    [/\b(?:csv)\b|CSV/i, 'generated.csv'],
    [/\b(?:jsonl)\b|JSONL/i, 'generated.jsonl'],
    [/\b(?:json)\b|JSON/i, 'generated.json'],
    [/Markdown|マークダウン|\bmd\b/i, 'generated.md'],
    [/PowerShell|\bps1\b/i, 'generated.ps1'],
    [/バッチ|\bbat\b/i, 'generated.bat'],
    [/Python|\bpy\b/i, 'generated.py'],
    [/JavaScript|\bjs\b/i, 'generated.js'],
    [/TypeScript|\bts\b/i, 'generated.ts'],
    [/HTML|\bhtml\b/i, 'generated.html'],
    [/XML|\bxml\b/i, 'generated.xml'],
    [/YAML|\byml\b|\byaml\b/i, 'generated.yaml'],
    [/テキスト|text|\btxt\b/i, 'generated.txt'],
  ];
  for (const [pattern, filename] of formats) if (pattern.test(text)) return filename;
  return 'generated.txt';
}

function languageForExtension(ext) {
  const aliases = {
    md: ['md', 'markdown'],
    markdown: ['md', 'markdown'],
    js: ['js', 'javascript'],
    mjs: ['js', 'javascript'],
    cjs: ['js', 'javascript'],
    ts: ['ts', 'typescript'],
    tsx: ['tsx', 'typescript'],
    py: ['py', 'python'],
    sh: ['sh', 'shell', 'bash'],
    bash: ['sh', 'shell', 'bash'],
    zsh: ['zsh', 'shell'],
    bat: ['bat', 'batch', 'cmd'],
    cmd: ['cmd', 'bat', 'batch'],
    ps1: ['ps1', 'powershell'],
    csv: ['csv'],
    json: ['json'],
    jsonl: ['jsonl', 'ndjson'],
    xml: ['xml'],
    yaml: ['yaml', 'yml'],
    yml: ['yaml', 'yml'],
    html: ['html'],
    htm: ['html'],
    css: ['css'],
    sql: ['sql'],
  };
  return aliases[ext] || [ext];
}

function fencedContent(text, filename) {
  const blocks = [];
  const fence = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(String(text || ''))) !== null) {
    blocks.push({ language: String(match[1] || '').trim().toLowerCase(), content: match[2].replace(/\r?\n$/, '') });
  }
  if (!blocks.length) return null;
  const aliases = languageForExtension(extensionOf(filename));
  return (blocks.find(block => aliases.some(alias => block.language === alias || block.language.includes(alias))) || blocks[0]).content;
}

export function decorateOxResponse(requestText, payload) {
  if (!payload?.ok || typeof payload?.text !== 'string') return payload;

  const explicit = explicitArtifacts(payload.text);
  if (explicit.artifacts.length) {
    return {
      ...payload,
      text: explicit.text || 'ファイルを生成しました。',
      artifacts: explicit.artifacts,
      artifact_handoff: { enabled: true, mode: 'inline_text', persistent: false },
    };
  }

  const filename = requestedFilename(requestText);
  if (!filename) return payload;
  const content = fencedContent(payload.text, filename) ?? payload.text;
  const artifact = buildArtifact(filename, '', content, 'ox-alpha-derived');
  if (!artifact) return payload;
  return {
    ...payload,
    artifacts: [artifact],
    artifact_handoff: { enabled: true, mode: 'inline_text', persistent: false },
  };
}

export function artifactTestResponse() {
  const content = [
    'Response Tool artifact handoff test',
    'status: ok',
    'encoding: utf-8',
    'This file was returned through /api/architecture without OpenRouter.',
    '',
  ].join('\n');
  const artifact = buildArtifact('response-tool-artifact-test.txt', 'text/plain;charset=utf-8', content, 'response-tool-test');
  return {
    ok: true,
    service: 'response-tool-ox-alpha',
    result_type: 'artifact_handoff_test',
    text: 'Artifact受け渡しテスト用ファイルを生成しました。',
    artifacts: artifact ? [artifact] : [],
    artifact_handoff: { enabled: true, mode: 'inline_text', persistent: false, test: true },
  };
}

export const artifactLimits = {
  max_artifacts: MAX_ARTIFACTS,
  max_artifact_bytes: MAX_ARTIFACT_BYTES,
  supported_extensions: EXTENSIONS,
};
