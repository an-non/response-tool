import { neon } from '@neondatabase/serverless';

const looksLikePostgresUrl = value => /^postgres(?:ql)?:\/\//i.test(String(value || '').trim());

function explicitCandidates() {
  return [
    ['OX_MEMORY_DATABASE_URL', process.env.OX_MEMORY_DATABASE_URL],
    ['OX_MEMORY_DATABASE_URL_URL', process.env.OX_MEMORY_DATABASE_URL_URL],
    ['OX_MEMORY_DATABASE_URL_DATABASE_URL', process.env.OX_MEMORY_DATABASE_URL_DATABASE_URL],
    ['OX_MEMORY_DATABASE_URL_POSTGRES_URL', process.env.OX_MEMORY_DATABASE_URL_POSTGRES_URL],
    ['OX_MEMORY_DATABASE_URL_NEON_DATABASE_URL', process.env.OX_MEMORY_DATABASE_URL_NEON_DATABASE_URL],
    ['OX_MEMORY_POSTGRES_URL', process.env.OX_MEMORY_POSTGRES_URL],
  ];
}

function discoveredCandidates() {
  return Object.keys(process.env)
    .filter(key => /^OX_/i.test(key))
    .filter(key => /(DATABASE|POSTGRES|NEON).*(URL|URI)|(?:URL|URI).*(DATABASE|POSTGRES|NEON)/i.test(key))
    .map(key => [key, process.env[key]])
    .filter(([, value]) => looksLikePostgresUrl(value));
}

function connectionInfo() {
  const candidates = [...explicitCandidates(), ...discoveredCandidates()];
  const seen = new Set();
  for (const [name, value] of candidates) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (looksLikePostgresUrl(value)) return { url: String(value).trim(), source: name };
  }
  return { url: null, source: null };
}

export function oxMemoryConfigured() {
  return !!connectionInfo().url;
}

export function oxMemorySql() {
  const { url } = connectionInfo();
  if (!url) throw Error('ox_memory_database_url_missing');
  return neon(url);
}

export function oxMemoryStorageInfo() {
  const { url, source } = connectionInfo();
  return {
    configured: !!url,
    provider: 'neon_postgres',
    isolated_from_yuki: true,
    expected_env: 'OX_MEMORY_DATABASE_URL',
    env_source: source,
    compatibility_mode: source && source !== 'OX_MEMORY_DATABASE_URL' ? 'prefixed_marketplace_env' : 'canonical',
  };
}
