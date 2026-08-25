import { neon } from '@neondatabase/serverless';

function connectionInfo() {
  const candidates = [
    ['OX_MEMORY_DATABASE_URL', process.env.OX_MEMORY_DATABASE_URL],
    ['OX_MEMORY_DATABASE_URL_URL', process.env.OX_MEMORY_DATABASE_URL_URL],
    ['OX_MEMORY_POSTGRES_URL', process.env.OX_MEMORY_POSTGRES_URL],
  ];
  const found = candidates.find(([, value]) => String(value || '').trim());
  if (!found) return { url: null, source: null };
  return { url: String(found[1]).trim(), source: found[0] };
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
    compatibility_envs: ['OX_MEMORY_DATABASE_URL_URL', 'OX_MEMORY_POSTGRES_URL'],
  };
}
