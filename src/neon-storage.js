import { neon } from '@neondatabase/serverless';

const connectionString = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || null;

export function neonConfigured() {
  return !!connectionString();
}

export function neonSql() {
  const url = connectionString();
  if (!url) throw Error('neon_database_url_missing');
  return neon(url);
}

export async function ensureProbeSchema() {
  const sql = neonSql();
  await sql`
    create table if not exists rt_storage_probe (
      id text primary key,
      created_at timestamptz not null default now(),
      payload jsonb not null
    )
  `;
  return true;
}

export async function runStorageProbe(id) {
  const sql = neonSql();
  const payload = {
    probe: 'response-tool-neon-stage1',
    created_at: new Date().toISOString(),
  };

  await sql`
    insert into rt_storage_probe (id, payload)
    values (${id}, ${JSON.stringify(payload)}::jsonb)
    on conflict (id) do update set payload = excluded.payload, created_at = now()
  `;

  const rows = await sql`
    select id, created_at, payload
    from rt_storage_probe
    where id = ${id}
    limit 1
  `;

  const deleted = await sql`
    delete from rt_storage_probe
    where id = ${id}
    returning id
  `;

  return {
    write_ok: true,
    read_ok: rows.length === 1 && rows[0]?.id === id,
    delete_ok: deleted.length === 1 && deleted[0]?.id === id,
    row: rows[0] || null,
  };
}
