import crypto from 'node:crypto';
import { neonConfigured, neonSql } from './neon-storage.js';
import { MEMORY_BLOCK_SIZE, MEMORY_SCHEMA, RECENT_TURN_LIMIT } from './config.js';

const hashClientKey = key => crypto.createHash('sha256').update(String(key || ''), 'utf8').digest('base64url');

export function neonMemoryConfigured(){return neonConfigured();}

export async function ensureNeonMemorySchema(){
  const sql=neonSql();
  await sql`create table if not exists rt_sessions (
    profile_id text not null,
    session_id text not null,
    turn_count integer not null default 0,
    latest_turn_no integer not null default 0,
    completed_block_count integer not null default 0,
    latest_ready_block_no integer not null default 0,
    latest_attempted_block_no integer not null default 0,
    recent_turns jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key(profile_id,session_id)
  )`;
  await sql`create table if not exists rt_active_sessions (
    profile_id text not null,
    client_id text not null,
    session_id text not null,
    client_key_hash text not null,
    updated_at timestamptz not null default now(),
    primary key(profile_id,client_id)
  )`;
  await sql`create table if not exists rt_turns (
    profile_id text not null,
    session_id text not null,
    turn_no integer not null,
    trace_id text not null,
    request_id text,
    request_text text not null,
    response_text text not null,
    yuki_state jsonb not null default '{}'::jsonb,
    block_no integer not null,
    created_at timestamptz not null default now(),
    primary key(profile_id,session_id,turn_no),
    unique(profile_id,session_id,trace_id)
  )`;
  await sql`create index if not exists rt_turns_session_created_idx on rt_turns(profile_id,session_id,turn_no desc)`;
  await sql`create table if not exists rt_memory_blocks (
    profile_id text not null,
    session_id text not null,
    block_no integer not null,
    start_turn integer not null,
    end_turn integer not null,
    status text not null,
    payload jsonb not null,
    updated_at timestamptz not null default now(),
    primary key(profile_id,session_id,block_no)
  )`;
  await sql`create table if not exists rt_current_memory (
    profile_id text not null,
    session_id text not null,
    source_block_no integer not null default 0,
    payload jsonb not null,
    updated_at timestamptz not null default now(),
    primary key(profile_id,session_id)
  )`;
  await sql`create table if not exists rt_result_traces (
    trace_id text primary key,
    request_text text,
    response_text text,
    metadata jsonb not null default '{}'::jsonb,
    status text not null default 'pending',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
  return true;
}

export async function neonMemoryStats(){
  const sql=neonSql();
  const [sessions,active,turns,blocks,current,traces]=await Promise.all([
    sql`select count(*)::int as n from rt_sessions`,
    sql`select count(*)::int as n from rt_active_sessions`,
    sql`select count(*)::int as n from rt_turns`,
    sql`select count(*)::int as n from rt_memory_blocks`,
    sql`select count(*)::int as n from rt_current_memory`,
    sql`select count(*)::int as n from rt_result_traces`,
  ]);
  return {sessions:sessions[0].n,active_sessions:active[0].n,turns:turns[0].n,memory_blocks:blocks[0].n,current_memory:current[0].n,result_traces:traces[0].n};
}

export async function upsertActiveSession({profileId,sessionId,clientId,clientKey}){
  const sql=neonSql();
  await sql`insert into rt_active_sessions(profile_id,client_id,session_id,client_key_hash,updated_at)
    values(${profileId},${clientId},${sessionId},${hashClientKey(clientKey)},now())
    on conflict(profile_id,client_id) do update set session_id=excluded.session_id,client_key_hash=excluded.client_key_hash,updated_at=now()`;
  return true;
}

export async function getActiveSession({profileId,clientId}){
  const sql=neonSql();
  const rows=await sql`select profile_id,client_id,session_id,client_key_hash,updated_at from rt_active_sessions where profile_id=${profileId} and client_id=${clientId} limit 1`;
  return rows[0]||null;
}

export async function getSession(profileId,sessionId){
  const sql=neonSql();
  const rows=await sql`select * from rt_sessions where profile_id=${profileId} and session_id=${sessionId} limit 1`;
  return rows[0]||null;
}

export async function recordTurn({profileId,sessionId,traceId,requestId,requestText,responseText,yukiState}){
  const sql=neonSql();
  await sql`insert into rt_sessions(profile_id,session_id) values(${profileId},${sessionId}) on conflict do nothing`;
  const dup=await sql`select turn_no from rt_turns where profile_id=${profileId} and session_id=${sessionId} and trace_id=${traceId} limit 1`;
  if(dup.length)return{stored:true,duplicate:true,turn_no:Number(dup[0].turn_no),block_no:Math.ceil(Number(dup[0].turn_no)/MEMORY_BLOCK_SIZE),compression_due:false};
  const seq=await sql`update rt_sessions set turn_count=turn_count+1,latest_turn_no=turn_count+1,completed_block_count=floor((turn_count+1)::numeric/${MEMORY_BLOCK_SIZE})::int,updated_at=now() where profile_id=${profileId} and session_id=${sessionId} returning turn_count`;
  const turnNo=Number(seq[0].turn_count),blockNo=Math.ceil(turnNo/MEMORY_BLOCK_SIZE),createdAt=new Date().toISOString();
  await sql`insert into rt_turns(profile_id,session_id,turn_no,trace_id,request_id,request_text,response_text,yuki_state,block_no,created_at)
    values(${profileId},${sessionId},${turnNo},${traceId},${requestId},${requestText},${responseText},${JSON.stringify(yukiState||{})}::jsonb,${blockNo},${createdAt})`;
  const recent=await sql`select turn_no,request_text,response_text,created_at from rt_turns where profile_id=${profileId} and session_id=${sessionId} order by turn_no desc limit ${RECENT_TURN_LIMIT}`;
  const recentTurns=recent.reverse().map(r=>({turn_no:Number(r.turn_no),request:String(r.request_text||'').slice(0,900),response:String(r.response_text||'').slice(0,900),created_at:r.created_at}));
  await sql`update rt_sessions set recent_turns=${JSON.stringify(recentTurns)}::jsonb,updated_at=now() where profile_id=${profileId} and session_id=${sessionId}`;
  return{stored:true,turn_no:turnNo,block_no:blockNo,compression_due:turnNo>=MEMORY_BLOCK_SIZE};
}

export async function getTurns(profileId,sessionId,startTurn,endTurn){
  const sql=neonSql();
  return sql`select turn_no,trace_id,request_id,request_text,response_text,yuki_state,created_at from rt_turns where profile_id=${profileId} and session_id=${sessionId} and turn_no between ${startTurn} and ${endTurn} order by turn_no asc`;
}

export async function getRecentNeonTurns(profileId,sessionId,limit=RECENT_TURN_LIMIT){
  const sql=neonSql();
  const rows=await sql`select turn_no,request_text,response_text,created_at from rt_turns where profile_id=${profileId} and session_id=${sessionId} order by turn_no desc limit ${Math.max(1,Math.min(Number(limit)||RECENT_TURN_LIMIT,100))}`;
  return rows.reverse().map(r=>({turn_no:Number(r.turn_no),request:String(r.request_text||'').slice(0,900),response:String(r.response_text||'').slice(0,900),created_at:r.created_at}));
}

export async function getNeonHistory(profileId,sessionId,limit=30){
  const sql=neonSql();
  const rows=await sql`select turn_no,trace_id,request_id,request_text,response_text,yuki_state,created_at from rt_turns where profile_id=${profileId} and session_id=${sessionId} order by turn_no desc limit ${Math.max(1,Math.min(Number(limit)||30,100))}`;
  return rows.reverse().map(r=>({...r,turn_no:Number(r.turn_no)}));
}

export async function saveBlock(row){
  const sql=neonSql();
  await sql`insert into rt_memory_blocks(profile_id,session_id,block_no,start_turn,end_turn,status,payload,updated_at)
    values(${row.profile_id},${row.session_id},${row.block_no},${row.start_turn},${row.end_turn},${row.status},${JSON.stringify(row)}::jsonb,now())
    on conflict(profile_id,session_id,block_no) do update set start_turn=excluded.start_turn,end_turn=excluded.end_turn,status=excluded.status,payload=excluded.payload,updated_at=now()`;
  await sql`update rt_sessions set latest_attempted_block_no=greatest(latest_attempted_block_no,${row.block_no}),latest_ready_block_no=case when ${row.status}='ready' then greatest(latest_ready_block_no,${row.block_no}) else latest_ready_block_no end,updated_at=now() where profile_id=${row.profile_id} and session_id=${row.session_id}`;
  return row;
}

export async function getBlock(profileId,sessionId,blockNo){const sql=neonSql();const rows=await sql`select payload from rt_memory_blocks where profile_id=${profileId} and session_id=${sessionId} and block_no=${blockNo} limit 1`;return rows[0]?.payload||null;}
export async function getBlocks(profileId,sessionId,limit=50){const sql=neonSql();const rows=await sql`select payload from rt_memory_blocks where profile_id=${profileId} and session_id=${sessionId} order by block_no desc limit ${Math.max(1,Math.min(Number(limit)||50,100))}`;return rows.map(r=>r.payload);}
export async function getBlockIndex(profileId,sessionId){const rows=await getBlocks(profileId,sessionId,100);return{schema_version:'2.0',primary_key:`${profileId}:${sessionId}:memory-index`,profile_id:profileId,session_id:sessionId,block_size:MEMORY_BLOCK_SIZE,entries:rows.reverse().map(r=>({block_no:Number(r.block_no),start_turn:Number(r.start_turn),end_turn:Number(r.end_turn),status:r.status,attempts:Number(r.attempts||0),retryable:r.retryable!==false,next_retry_at:r.next_retry_at||null,error:r.error||null,provider_http_status:r.provider_http_status||null,model:r.model||null,summary:r.memory?.summary||'',recall_keys:r.memory?.recall_keys||[],identity_facts:r.memory?.identity_facts||[],important_topics:r.memory?.important_topics||[],approval:r.memory?.approval||[],conversation_flow:r.memory?.conversation_flow||[],relationship_and_extensibility:r.memory?.relationship_and_extensibility||[],current_status:r.memory?.current_status||[],unresolved:r.memory?.unresolved||[],updated_at:r.updated_at||null})),updated_at:new Date().toISOString()};}

export async function saveCurrentMemory(row){const sql=neonSql();await sql`insert into rt_current_memory(profile_id,session_id,source_block_no,payload,updated_at) values(${row.profile_id},${row.session_id},${row.source_block_no},${JSON.stringify(row)}::jsonb,now()) on conflict(profile_id,session_id) do update set source_block_no=excluded.source_block_no,payload=excluded.payload,updated_at=now()`;await sql`update rt_sessions set latest_ready_block_no=greatest(latest_ready_block_no,${row.source_block_no}),updated_at=now() where profile_id=${row.profile_id} and session_id=${row.session_id}`;return true;}
export async function getCurrentMemory(profileId,sessionId){const sql=neonSql();const rows=await sql`select payload from rt_current_memory where profile_id=${profileId} and session_id=${sessionId} limit 1`;return rows[0]?.payload||null;}

export async function writeResultStart(traceId,requestText,metadata){const sql=neonSql();await sql`insert into rt_result_traces(trace_id,request_text,metadata,status,created_at,updated_at) values(${traceId},${requestText},${JSON.stringify(metadata||{})}::jsonb,'pending',now(),now()) on conflict(trace_id) do update set request_text=excluded.request_text,metadata=excluded.metadata,status='pending',updated_at=now()`;return true;}
export async function writeResultResponse(traceId,responseText,metadata){const sql=neonSql();await sql`update rt_result_traces set response_text=${responseText},metadata=${JSON.stringify(metadata||{})}::jsonb,status='complete',updated_at=now() where trace_id=${traceId}`;return true;}
export async function writeResultMetadata(traceId,metadata){const sql=neonSql();await sql`update rt_result_traces set metadata=${JSON.stringify(metadata||{})}::jsonb,updated_at=now() where trace_id=${traceId}`;return true;}
export async function readResultTrace(traceId){const sql=neonSql();const rows=await sql`select trace_id,request_text,response_text,metadata,status,created_at,updated_at from rt_result_traces where trace_id=${traceId} limit 1`;return rows[0]||null;}

export async function neonMemoryManifest(){return{configured:neonMemoryConfigured(),provider:'neon_postgres',memory_schema:MEMORY_SCHEMA,block_size:MEMORY_BLOCK_SIZE,storage_model:'relational_primary_with_blob_legacy_fallback',tables:['rt_sessions','rt_active_sessions','rt_turns','rt_memory_blocks','rt_current_memory','rt_result_traces']};}
