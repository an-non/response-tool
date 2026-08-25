import { neon } from '@neondatabase/serverless';

const connectionString = () => process.env.OX_MEMORY_DATABASE_URL || process.env.OX_MEMORY_POSTGRES_URL || null;

export function oxMemoryConfigured() {
  return !!connectionString();
}

export function oxMemorySql() {
  const url = connectionString();
  if (!url) throw Error('ox_memory_database_url_missing');
  return neon(url);
}

export function oxMemoryStorageInfo() {
  return {
    configured: oxMemoryConfigured(),
    provider: 'neon_postgres',
    isolated_from_yuki: true,
    expected_env: 'OX_MEMORY_DATABASE_URL',
  };
}
