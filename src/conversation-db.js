import { neon } from '@neondatabase/serverless';

export const MEMORY_BLOCK_SIZE=10;
export const RECENT_TURN_LIMIT=4;
export const RECENT_TEXT_CHARS=900;

let sqlClient=null;
let schemaPromise=null;
function databaseUrl(){return process.env.MEMORY_DATABASE_URL||process.env.DATABASE_URL||process.env.POSTGRES_URL||null;}
export function memoryDatabaseConfigured(){return !!databaseUrl();}
function sql(){const url=databaseUrl();if(!url)throw Error('memory_database_url_missing');if(!sqlClient)sqlClient=neon(url);return sqlClient;}
export async function ensureMemorySchema(){
  if(!memoryDatabaseConfigured())return false;
  if(!schemaPromise)schemaPromise=(async()=>{const q=sql();
    await q`CREATE TABLE IF NOT EXISTS conversation_sessions (profile_id text NOT NULL,session_id text NOT NULL,turn_count integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY (profile_id,session_id))`;
    await q`CREATE TABLE IF NOT EXISTS conversation_turns (profile_id text NOT NULL,session_id text NOT NULL,turn_no integer NOT NULL,trace_id text NOT NULL UNIQUE,request_id text NOT NULL,request_text text NOT NULL,response_text text NOT NULL,yuki_state jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY (profile_id,session_id,turn_no))`;
    await q`CREATE INDEX IF NOT EXISTS conversation_turns_session_created_idx ON conversation_turns (profile_id,session_id,created_at DESC)`;
    await q`CREATE TABLE IF NOT EXISTS memory_blocks (profile_id text NOT NULL,session_id text NOT NULL,block_no integer NOT NULL,start_turn integer NOT NULL,end_turn integer NOT NULL,status text NOT NULL DEFAULT 'ready',memory jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY (profile_id,session_id,block_no))`;
    await q`CREATE TABLE IF NOT EXISTS memory_state (profile_id text NOT NULL,session_id text NOT NULL,source_block_no integer NOT NULL,memory jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY (profile_id,session_id))`;
    return true;})().catch(e=>{schemaPromise=null;throw e;});
  return schemaPromise;
}
const toJson=v=>JSON.stringify(v??{});
const trimText=(v,n=RECENT_TEXT_CHARS)=>{const s=String(v||'');return s.length>n?s.slice(0,n)+'…':s;};
export async function recordConversationTurn({profileId,sessionId,traceId,requestId,requestText,responseText,yukiState}){
  if(!memoryDatabaseConfigured())return{stored:false,reason:'memory_database_url_missing'};
  await ensureMemorySchema();const q=sql();
  const existing=await q`SELECT turn_no FROM conversation_turns WHERE trace_id=${traceId} LIMIT 1`;
  if(existing.length)return{stored:true,turn_no:Number(existing[0].turn_no),duplicate:true};
  const session=await q`INSERT INTO conversation_sessions (profile_id,session_id,turn_count) VALUES (${profileId},${sessionId},1) ON CONFLICT (profile_id,session_id) DO UPDATE SET turn_count=conversation_sessions.turn_count+1,updated_at=now() RETURNING turn_count`;
  const turnNo=Number(session[0].turn_count);
  await q`INSERT INTO conversation_turns (profile_id,session_id,turn_no,trace_id,request_id,request_text,response_text,yuki_state) VALUES (${profileId},${sessionId},${turnNo},${traceId},${requestId},${requestText},${responseText},${toJson(yukiState)}::jsonb)`;
  return{stored:true,turn_no:turnNo,block_no:Math.ceil(turnNo/MEMORY_BLOCK_SIZE),compression_due:turnNo%MEMORY_BLOCK_SIZE===0};
}
export async function getRecentTurns(profileId,sessionId,limit=RECENT_TURN_LIMIT){if(!memoryDatabaseConfigured())return[];await ensureMemorySchema();const rows=await sql()`SELECT turn_no,request_text,response_text,created_at FROM conversation_turns WHERE profile_id=${profileId} AND session_id=${sessionId} ORDER BY turn_no DESC LIMIT ${Math.max(1,Math.min(Number(limit)||RECENT_TURN_LIMIT,12))}`;return rows.reverse().map(r=>({turn_no:Number(r.turn_no),request:trimText(r.request_text),response:trimText(r.response_text),created_at:r.created_at}));}
export async function getHistory(profileId,sessionId,limit=30){if(!memoryDatabaseConfigured())return[];await ensureMemorySchema();const rows=await sql()`SELECT turn_no,trace_id,request_id,request_text,response_text,created_at FROM conversation_turns WHERE profile_id=${profileId} AND session_id=${sessionId} ORDER BY turn_no DESC LIMIT ${Math.max(1,Math.min(Number(limit)||30,100))}`;return rows.reverse().map(r=>({...r,turn_no:Number(r.turn_no)}));}
export async function getTurnsRange(profileId,sessionId,startTurn,endTurn){if(!memoryDatabaseConfigured())return[];await ensureMemorySchema();const rows=await sql()`SELECT turn_no,trace_id,request_id,request_text,response_text,yuki_state,created_at FROM conversation_turns WHERE profile_id=${profileId} AND session_id=${sessionId} AND turn_no BETWEEN ${startTurn} AND ${endTurn} ORDER BY turn_no ASC`;return rows.map(r=>({...r,turn_no:Number(r.turn_no)}));}
export async function getLatestMemoryState(profileId,sessionId){if(!memoryDatabaseConfigured())return null;await ensureMemorySchema();const rows=await sql()`SELECT source_block_no,memory,updated_at FROM memory_state WHERE profile_id=${profileId} AND session_id=${sessionId} LIMIT 1`;return rows.length?{source_block_no:Number(rows[0].source_block_no),memory:rows[0].memory,updated_at:rows[0].updated_at}:null;}
export async function getMemoryBlocks(profileId,sessionId,limit=50){if(!memoryDatabaseConfigured())return[];await ensureMemorySchema();const rows=await sql()`SELECT block_no,start_turn,end_turn,status,memory,error,created_at,updated_at FROM memory_blocks WHERE profile_id=${profileId} AND session_id=${sessionId} ORDER BY block_no DESC LIMIT ${Math.max(1,Math.min(Number(limit)||50,100))}`;return rows.map(r=>({...r,block_no:Number(r.block_no),start_turn:Number(r.start_turn),end_turn:Number(r.end_turn)}));}
export async function saveMemoryBlock({profileId,sessionId,blockNo,startTurn,endTurn,memory,status='ready',error=null}){if(!memoryDatabaseConfigured())return false;await ensureMemorySchema();await sql()`INSERT INTO memory_blocks (profile_id,session_id,block_no,start_turn,end_turn,status,memory,error) VALUES (${profileId},${sessionId},${blockNo},${startTurn},${endTurn},${status},${memory?toJson(memory):null}::jsonb,${error}) ON CONFLICT (profile_id,session_id,block_no) DO UPDATE SET start_turn=EXCLUDED.start_turn,end_turn=EXCLUDED.end_turn,status=EXCLUDED.status,memory=EXCLUDED.memory,error=EXCLUDED.error,updated_at=now()`;return true;}
export async function saveMemoryState({profileId,sessionId,sourceBlockNo,memory}){if(!memoryDatabaseConfigured())return false;await ensureMemorySchema();await sql()`INSERT INTO memory_state (profile_id,session_id,source_block_no,memory) VALUES (${profileId},${sessionId},${sourceBlockNo},${toJson(memory)}::jsonb) ON CONFLICT (profile_id,session_id) DO UPDATE SET source_block_no=EXCLUDED.source_block_no,memory=EXCLUDED.memory,updated_at=now()`;return true;}
export async function memoryDatabaseHealth(){if(!memoryDatabaseConfigured())return{configured:false,ok:false,reason:'memory_database_url_missing'};try{await ensureMemorySchema();const rows=await sql()`SELECT 1 AS ok`;return{configured:true,ok:Number(rows[0]?.ok)===1,provider:'neon_postgres'};}catch(e){return{configured:true,ok:false,provider:'neon_postgres',error:String(e?.message||e)};}}
