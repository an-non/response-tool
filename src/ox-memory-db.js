import crypto from 'node:crypto';
import { oxMemoryConfigured, oxMemorySql } from './ox-memory-storage.js';

export const OX_MEMORY_BLOCK_SIZE = 3;
const RECENT_LIMIT = 12;
let schemaReady = null;
const hash = value => crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('base64url');
const clampLimit = (value, fallback = 10, max = 100) => Math.max(1, Math.min(Number(value) || fallback, max));

export function oxDbConfigured() { return oxMemoryConfigured(); }

export function ensureOxMemorySchema() {
  if (!schemaReady) schemaReady = createSchema().catch(error => { schemaReady = null; throw error; });
  return schemaReady;
}

async function createSchema() {
  const sql = oxMemorySql();
  await sql`create table if not exists ox_sessions (
    profile_id text not null,
    session_id text not null,
    turn_count integer not null default 0,
    latest_turn_no integer not null default 0,
    latest_memory_block_no integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key(profile_id, session_id)
  )`;
  await sql`create table if not exists ox_active_sessions (
    profile_id text not null,
    client_id text not null,
    session_id text not null,
    client_key_hash text not null,
    updated_at timestamptz not null default now(),
    primary key(profile_id, client_id)
  )`;
  await sql`create table if not exists ox_turns (
    profile_id text not null,
    session_id text not null,
    turn_no integer not null,
    trace_id text not null,
    request_id text,
    request_text text not null,
    response_text text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    primary key(profile_id, session_id, turn_no),
    unique(profile_id, session_id, trace_id)
  )`;
  await sql`create index if not exists ox_turns_recent_idx on ox_turns(profile_id, session_id, turn_no desc)`;
  await sql`create table if not exists ox_memory_blocks (
    profile_id text not null,
    session_id text not null,
    block_no integer not null,
    start_turn integer not null,
    end_turn integer not null,
    status text not null default 'pending',
    payload jsonb not null default '{}'::jsonb,
    error text,
    updated_at timestamptz not null default now(),
    primary key(profile_id, session_id, block_no)
  )`;
  await sql`create table if not exists ox_profile_memory (
    profile_id text primary key,
    source_session_id text,
    source_block_no integer not null default 0,
    payload jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  )`;
  return true;
}

async function ready() {
  if (!oxDbConfigured()) throw Error('ox_memory_database_not_configured');
  await ensureOxMemorySchema();
}

export async function getSession(profileId, sessionId) {
  await ready();
  const sql = oxMemorySql();
  const rows = await sql`select * from ox_sessions where profile_id=${profileId} and session_id=${sessionId} limit 1`;
  return rows[0] || null;
}

export async function resolveActiveSession(profileId, clientId, clientKey) {
  await ready();
  const sql = oxMemorySql();
  const rows = await sql`select session_id, client_key_hash, updated_at from ox_active_sessions where profile_id=${profileId} and client_id=${clientId} limit 1`;
  const row = rows[0];
  if (!row) return null;
  if (row.client_key_hash !== hash(clientKey)) return { unauthorized: true };
  return { profile_id: profileId, session_id: row.session_id, updated_at: row.updated_at };
}

export async function bindActiveSession(profileId, sessionId, clientId, clientKey) {
  await ready();
  const sql = oxMemorySql();
  await sql`insert into ox_active_sessions(profile_id,client_id,session_id,client_key_hash,updated_at)
    values(${profileId},${clientId},${sessionId},${hash(clientKey)},now())
    on conflict(profile_id,client_id) do update set session_id=excluded.session_id,client_key_hash=excluded.client_key_hash,updated_at=now()`;
  return true;
}

export async function recordTurn({ profileId, sessionId, traceId, requestId, requestText, responseText, metadata }) {
  await ready();
  const sql = oxMemorySql();
  await sql`insert into ox_sessions(profile_id,session_id) values(${profileId},${sessionId}) on conflict do nothing`;
  const dup = await sql`select turn_no from ox_turns where profile_id=${profileId} and session_id=${sessionId} and trace_id=${traceId} limit 1`;
  if (dup.length) {
    const turnNo = Number(dup[0].turn_no);
    return { stored: true, duplicate: true, turn_no: turnNo, block_no: Math.ceil(turnNo / OX_MEMORY_BLOCK_SIZE), compression_due: turnNo % OX_MEMORY_BLOCK_SIZE === 0 };
  }
  const seq = await sql`update ox_sessions set turn_count=turn_count+1,latest_turn_no=turn_count+1,updated_at=now() where profile_id=${profileId} and session_id=${sessionId} returning turn_count`;
  const turnNo = Number(seq[0].turn_count);
  await sql`insert into ox_turns(profile_id,session_id,turn_no,trace_id,request_id,request_text,response_text,metadata)
    values(${profileId},${sessionId},${turnNo},${traceId},${requestId},${requestText},${responseText},${JSON.stringify(metadata || {})}::jsonb)`;
  return { stored: true, turn_no: turnNo, block_no: Math.ceil(turnNo / OX_MEMORY_BLOCK_SIZE), compression_due: turnNo % OX_MEMORY_BLOCK_SIZE === 0 };
}

export async function getRecentTurns(profileId, sessionId, limit = RECENT_LIMIT) {
  await ready();
  const sql = oxMemorySql();
  const rows = await sql`select turn_no,request_text,response_text,created_at from ox_turns where profile_id=${profileId} and session_id=${sessionId} order by turn_no desc limit ${clampLimit(limit, RECENT_LIMIT)}`;
  return rows.reverse().map(row => ({ turn_no: Number(row.turn_no), request: row.request_text, response: row.response_text, created_at: row.created_at }));
}

export async function getHistory(profileId, sessionId, limit = 30) {
  await ready();
  const sql = oxMemorySql();
  const rows = await sql`select turn_no,trace_id,request_id,request_text,response_text,metadata,created_at from ox_turns where profile_id=${profileId} and session_id=${sessionId} order by turn_no desc limit ${clampLimit(limit, 30)}`;
  return rows.reverse().map(row => ({ ...row, turn_no: Number(row.turn_no) }));
}

export async function getTurnsRange(profileId, sessionId, startTurn, endTurn) {
  await ready();
  const sql = oxMemorySql();
  const rows = await sql`select turn_no,request_text,response_text,created_at from ox_turns where profile_id=${profileId} and session_id=${sessionId} and turn_no between ${startTurn} and ${endTurn} order by turn_no asc`;
  return rows.map(row => ({ ...row, turn_no: Number(row.turn_no) }));
}

export async function getMemoryBlock(profileId, sessionId, blockNo) {
  await ready();
  const sql = oxMemorySql();
  const rows = await sql`select status,payload,error,updated_at from ox_memory_blocks where profile_id=${profileId} and session_id=${sessionId} and block_no=${blockNo} limit 1`;
  return rows[0] || null;
}

export async function saveMemoryBlock({ profileId, sessionId, blockNo, startTurn, endTurn, status, payload, error = null }) {
  await ready();
  const sql = oxMemorySql();
  await sql`insert into ox_memory_blocks(profile_id,session_id,block_no,start_turn,end_turn,status,payload,error,updated_at)
    values(${profileId},${sessionId},${blockNo},${startTurn},${endTurn},${status},${JSON.stringify(payload || {})}::jsonb,${error},now())
    on conflict(profile_id,session_id,block_no) do update set start_turn=excluded.start_turn,end_turn=excluded.end_turn,status=excluded.status,payload=excluded.payload,error=excluded.error,updated_at=now()`;
  if (status === 'ready') {
    await sql`update ox_sessions set latest_memory_block_no=greatest(latest_memory_block_no,${blockNo}),updated_at=now() where profile_id=${profileId} and session_id=${sessionId}`;
  }
  return true;
}

export async function getProfileMemory(profileId) {
  await ready();
  const sql = oxMemorySql();
  const rows = await sql`select source_session_id,source_block_no,payload,updated_at from ox_profile_memory where profile_id=${profileId} limit 1`;
  return rows[0] || null;
}

export async function saveProfileMemory({ profileId, sourceSessionId, sourceBlockNo, payload }) {
  await ready();
  const sql = oxMemorySql();
  await sql`insert into ox_profile_memory(profile_id,source_session_id,source_block_no,payload,updated_at)
    values(${profileId},${sourceSessionId},${sourceBlockNo},${JSON.stringify(payload || {})}::jsonb,now())
    on conflict(profile_id) do update set source_session_id=excluded.source_session_id,source_block_no=excluded.source_block_no,payload=excluded.payload,updated_at=now()`;
  return true;
}

export async function memoryStats(profileId = 'ox-alpha-default') {
  await ready();
  const sql = oxMemorySql();
  const [sessions, turns, blocks, profile] = await Promise.all([
    sql`select count(*)::int as n from ox_sessions where profile_id=${profileId}`,
    sql`select count(*)::int as n from ox_turns where profile_id=${profileId}`,
    sql`select count(*)::int as n from ox_memory_blocks where profile_id=${profileId} and status='ready'`,
    sql`select count(*)::int as n from ox_profile_memory where profile_id=${profileId}`,
  ]);
  return { sessions: sessions[0].n, turns: turns[0].n, ready_blocks: blocks[0].n, profile_memory: profile[0].n };
}
