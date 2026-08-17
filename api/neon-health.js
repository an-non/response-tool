import crypto from 'node:crypto';
import { ensureProbeSchema, neonConfigured, runStorageProbe } from '../src/neon-storage.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    res.status(405).end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return;
  }

  if (!neonConfigured()) {
    res.status(503).end(JSON.stringify({ ok: false, configured: false, error: 'neon_database_url_missing' }));
    return;
  }

  const probeId = `probe_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  try {
    await ensureProbeSchema();
    const probe = await runStorageProbe(probeId);
    const ok = probe.write_ok && probe.read_ok && probe.delete_ok;
    res.status(ok ? 200 : 500).end(JSON.stringify({
      ok,
      configured: true,
      provider: 'neon_postgres',
      schema: 'public',
      probe_table: 'rt_storage_probe',
      write_ok: probe.write_ok,
      read_ok: probe.read_ok,
      delete_ok: probe.delete_ok,
      retained_probe_rows: 0,
      blob_touched: false,
    }));
  } catch (error) {
    res.status(502).end(JSON.stringify({
      ok: false,
      configured: true,
      provider: 'neon_postgres',
      error: String(error?.message || error),
      blob_touched: false,
    }));
  }
}
