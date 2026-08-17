import crypto from 'node:crypto';
import * as blob from './conversation-blob.js';
import {
  ensureNeonMemorySchema,
  neonMemoryConfigured,
  getActiveSession as getNeonActiveSession,
  getSession as getNeonSession,
  upsertActiveSession,
  recordTurn,
  getTurns,
  getRecentNeonTurns,
  getNeonHistory,
  getBlock,
  getBlocks,
  getBlockIndex,
  saveBlock,
  getCurrentMemory,
  saveCurrentMemory,
} from './neon-memory.js';
import { MEMORY_BLOCK_SIZE, MEMORY_SCHEMA, RECENT_TURN_LIMIT, MEMORY_MAX_INDEX_BLOCKS } from './config.js';

export { MEMORY_BLOCK_SIZE } from './config.js';
let readyPromise=null;
const ready=()=>{if(!readyPromise)readyPromise=ensureNeonMemorySchema();return readyPromise;};
const hash=key=>crypto.createHash('sha256').update(String(key||''),'utf8').digest('base64url');
const secureEqual=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const pad=n=>String(Number(n)||0).padStart(6,'0');

function defaultSession(profileId,sessionId){const now=new Date().toISOString();return{schema_version:'2.0',primary_key:`${profileId}:${sessionId}`,profile_id:profileId,session_id:sessionId,memory_schema:MEMORY_SCHEMA,block_size:MEMORY_BLOCK_SIZE,turn_count:0,latest_turn_no:0,completed_block_count:0,latest_ready_block_no:0,latest_attempted_block_no:0,recent_turns:[],created_at:now,updated_at:now};}
function normalizeSession(profileId,sessionId,row){const base=defaultSession(profileId,sessionId),count=Math.max(Number(row?.turn_count||0),Number(row?.latest_turn_no||0));return{...base,...row,schema_version:'2.0',primary_key:`${profileId}:${sessionId}`,profile_id:profileId,session_id:sessionId,memory_schema:MEMORY_SCHEMA,block_size:MEMORY_BLOCK_SIZE,turn_count:count,latest_turn_no:count,completed_block_count:Math.floor(count/MEMORY_BLOCK_SIZE),latest_ready_block_no:Number(row?.latest_ready_block_no||0),latest_attempted_block_no:Number(row?.latest_attempted_block_no||0),recent_turns:Array.isArray(row?.recent_turns)?row.recent_turns.slice(-RECENT_TURN_LIMIT):[],created_at:row?.created_at||base.created_at,updated_at:row?.updated_at||base.updated_at};}
async function neonSession(profileId,sessionId){if(!neonMemoryConfigured())return null;try{await ready();return await getNeonSession(profileId,sessionId);}catch{return null;}}

export function memoryBlobConfigured(){return neonMemoryConfigured()||blob.memoryBlobConfigured();}
export async function readSessionManifest(profileId,sessionId){const row=await neonSession(profileId,sessionId);if(row)return normalizeSession(profileId,sessionId,row);return blob.readSessionManifest(profileId,sessionId);}
export async function bindActiveSession(profileId,sessionId,clientId,clientKey){if(neonMemoryConfigured()&&clientId&&clientKey&&sessionId){try{await ready();await upsertActiveSession({profileId,sessionId,clientId,clientKey});return true;}catch{}}return blob.bindActiveSession(profileId,sessionId,clientId,clientKey);}
export async function resolveActiveSession(profileId,clientId,clientKey){if(neonMemoryConfigured()&&clientId&&clientKey){try{await ready();const row=await getNeonActiveSession({profileId,clientId});if(row){if(!secureEqual(row.client_key_hash,hash(clientKey)))return{unauthorized:true};return{profile_id:profileId,client_id:clientId,session_id:String(row.session_id||''),updated_at:row.updated_at||null};}}catch{}}return blob.resolveActiveSession(profileId,clientId,clientKey);}
export async function verifyClientSession(profileId,sessionId,clientId,clientKey){const row=await resolveActiveSession(profileId,clientId,clientKey);return!!row&&!row.unauthorized&&row.session_id===String(sessionId||'');}
export async function recordConversationTurn(args){if(neonMemoryConfigured()){try{await ready();return await recordTurn(args);}catch{}}return blob.recordConversationTurn(args);}
export async function getRecentTurns(profileId,sessionId,limit=RECENT_TURN_LIMIT){if(await neonSession(profileId,sessionId))return getRecentNeonTurns(profileId,sessionId,limit);return blob.getRecentTurns(profileId,sessionId,limit);}
export async function getHistory(profileId,sessionId,limit=30){if(await neonSession(profileId,sessionId))return getNeonHistory(profileId,sessionId,limit);return blob.getHistory(profileId,sessionId,limit);}
export async function getTurnsRange(profileId,sessionId,startTurn,endTurn){if(await neonSession(profileId,sessionId)){const rows=await getTurns(profileId,sessionId,startTurn,endTurn);return rows.map(r=>({...r,turn_no:Number(r.turn_no)}));}return blob.getTurnsRange(profileId,sessionId,startTurn,endTurn);}
export async function getLatestMemoryState(profileId,sessionId){if(await neonSession(profileId,sessionId)){const row=await getCurrentMemory(profileId,sessionId);if(row)return row;}return blob.getLatestMemoryState(profileId,sessionId);}
export async function getMemoryIndex(profileId,sessionId){if(await neonSession(profileId,sessionId))return getBlockIndex(profileId,sessionId);return blob.getMemoryIndex(profileId,sessionId);}
export async function getMemoryBlock(profileId,sessionId,blockNo){if(await neonSession(profileId,sessionId)){const row=await getBlock(profileId,sessionId,blockNo);if(row)return row;}return blob.getMemoryBlock(profileId,sessionId,blockNo);}

export async function saveMemoryBlock({profileId,sessionId,blockNo,startTurn,endTurn,memory,status='ready',error=null,attempts=1,retryable=true,nextRetryAt=null,providerHttpStatus=null,providerErrorCode=null,rateLimit=null,model=null}){
  if(neonMemoryConfigured()){
    try{await ready();const now=new Date().toISOString();const row={schema_version:'2.0',primary_key:`${profileId}:${sessionId}:block:${pad(blockNo)}`,session_primary_key:`${profileId}:${sessionId}`,profile_id:profileId,session_id:sessionId,block_no:blockNo,block_size:MEMORY_BLOCK_SIZE,start_turn:startTurn,end_turn:endTurn,source_turn_primary_keys:Array.from({length:endTurn-startTurn+1},(_,i)=>`${profileId}:${sessionId}:turn:${pad(startTurn+i)}`),status,attempts,retryable,next_retry_at:nextRetryAt,memory,error,provider_http_status:providerHttpStatus,provider_error_code:providerErrorCode,rate_limit:rateLimit,model,updated_at:now};return await saveBlock(row);}catch{}
  }
  return blob.saveMemoryBlock({profileId,sessionId,blockNo,startTurn,endTurn,memory,status,error,attempts,retryable,nextRetryAt,providerHttpStatus,providerErrorCode,rateLimit,model});
}
export async function saveMemoryState({profileId,sessionId,sourceBlockNo,memory}){if(neonMemoryConfigured()){try{await ready();const row={schema_version:'2.0',primary_key:`${profileId}:${sessionId}:current-memory`,profile_id:profileId,session_id:sessionId,source_block_no:sourceBlockNo,included_through_turn:Number(sourceBlockNo)*MEMORY_BLOCK_SIZE,memory,updated_at:new Date().toISOString()};return await saveCurrentMemory(row);}catch{}}return blob.saveMemoryState({profileId,sessionId,sourceBlockNo,memory});}
export async function getMemoryBlocks(profileId,sessionId,limit=50){if(await neonSession(profileId,sessionId))return getBlocks(profileId,sessionId,limit);return blob.getMemoryBlocks(profileId,sessionId,limit);}
export async function getDueMemoryBlockNos(profileId,sessionId,limit=1){if(!(await neonSession(profileId,sessionId)))return blob.getDueMemoryBlockNos(profileId,sessionId,limit);const [session,index]=await Promise.all([readSessionManifest(profileId,sessionId),getMemoryIndex(profileId,sessionId)]);const completed=Math.floor(session.turn_count/MEMORY_BLOCK_SIZE),map=new Map((index.entries||[]).map(e=>[Number(e.block_no),e])),now=Date.now(),due=[];for(let n=1;n<=completed;n++){const e=map.get(n);if(e?.status==='ready')continue;if(e?.status==='pending'){const age=now-Date.parse(e.updated_at||0);if(Number.isFinite(age)&&age<90000)continue;}if(e?.retryable===false)continue;if(e?.next_retry_at&&Date.parse(e.next_retry_at)>now)continue;due.push(n);if(due.length>=Math.max(1,Number(limit)||1))break;}return due;}

function manifest(profileId,sessionId,session,index,current){const entries=index.entries||[];return{schema_version:'2.0',provider:'neon_postgres',legacy_fallback:'vercel_private_blob',storage_model:'relational_primary_with_blob_legacy_fallback',primary_key:`${profileId}:${sessionId}`,profile_id:profileId,session_id:sessionId,memory_schema:MEMORY_SCHEMA,block_size:MEMORY_BLOCK_SIZE,hot_index_block_limit:MEMORY_MAX_INDEX_BLOCKS,turn_count:session.turn_count,turn_index_count:session.turn_count,completed_block_count:Math.floor(session.turn_count/MEMORY_BLOCK_SIZE),block_count:entries.length,ready_block_count:entries.filter(e=>e.status==='ready').length,degraded_block_count:entries.filter(e=>e.status==='degraded').length,usable_block_count:entries.filter(e=>e.status==='ready'||e.status==='degraded').length,pending_block_count:entries.filter(e=>e.status==='pending').length,error_block_count:entries.filter(e=>e.status==='error').length,latest_turn_no:session.latest_turn_no,latest_ready_block_no:session.latest_ready_block_no,current_memory_source_block_no:Number(current?.source_block_no||0),current_memory_included_through_turn:Number(current?.included_through_turn||0),current_memory_available:!!current?.memory,stored_artifacts:{session_manifest:'rt_sessions',turn_index:'rt_turns',trace_index:'rt_turns.trace_id',memory_index:'derived from rt_memory_blocks',compressed_blocks:'rt_memory_blocks',current_memory:'rt_current_memory',original_request_response:'rt_result_traces',active_session:'rt_active_sessions'}};}
export async function getMemorySnapshot(profileId,sessionId){if(!(await neonSession(profileId,sessionId)))return blob.getMemorySnapshot(profileId,sessionId);const [session,index,current]=await Promise.all([readSessionManifest(profileId,sessionId),getMemoryIndex(profileId,sessionId),getLatestMemoryState(profileId,sessionId)]);const desired=current?.memory?Math.min(6,RECENT_TURN_LIMIT):RECENT_TURN_LIMIT;let recent=Array.isArray(session.recent_turns)&&session.recent_turns.length>=desired?session.recent_turns.slice(-desired):[];if(recent.length<desired&&session.turn_count>0)recent=await getRecentTurns(profileId,sessionId,desired);return{session,index,current,recent_turns:recent,manifest:manifest(profileId,sessionId,session,index,current)};}
export async function getStorageManifest(profileId,sessionId){return(await getMemorySnapshot(profileId,sessionId)).manifest;}
export async function getMemoryDiagnostics(profileId,sessionId){const s=await getMemorySnapshot(profileId,sessionId);return{manifest:s.manifest,current_memory:s.current||null,recent_block_statuses:(s.index.entries||[]).slice(-12),due_block_nos:await getDueMemoryBlockNos(profileId,sessionId,12)};}
export async function memoryBlobHealth(){return blob.memoryBlobHealth();}
