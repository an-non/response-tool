import { MEMORY_PREFIX, BLOB_PREFIX } from './config.js';
import { blobList, readText, readMeta } from './storage.js';

export const MEMORY_BLOCK_SIZE=10;
export const RECENT_TURN_LIMIT=4;
export const RECENT_TEXT_CHARS=900;

const safe=id=>encodeURIComponent(String(id||'default')).replace(/%/g,'_');
const pad=n=>String(Number(n)||0).padStart(6,'0');
const base=(profileId,sessionId)=>`${MEMORY_PREFIX}${safe(profileId)}/${safe(sessionId)}/`;
const turnPath=(profileId,sessionId,turnNo)=>`${base(profileId,sessionId)}turns/${pad(turnNo)}.json`;
const blockPath=(profileId,sessionId,blockNo)=>`${base(profileId,sessionId)}blocks/${pad((blockNo-1)*MEMORY_BLOCK_SIZE+1)}-${pad(blockNo*MEMORY_BLOCK_SIZE)}.json`;
const currentPath=(profileId,sessionId)=>`${base(profileId,sessionId)}current.json`;
const sessionPath=(profileId,sessionId)=>`${base(profileId,sessionId)}session.json`;
const trimText=(v,n=RECENT_TEXT_CHARS)=>{const s=String(v||'');return s.length>n?s.slice(0,n)+'…':s;};

async function auth(){
  if(process.env.BLOB_READ_WRITE_TOKEN)return{token:process.env.BLOB_READ_WRITE_TOKEN};
  const storeId=process.env.blobyuki_STORE_ID||process.env.BLOB_STORE_ID;
  if(!storeId)throw Error('blob_store_id_missing');
  const{getVercelOidcToken}=await import('@vercel/oidc');
  const oidcToken=await getVercelOidcToken();
  if(!oidcToken)throw Error('blob_oidc_token_unavailable');
  return{oidcToken,storeId};
}
async function putJson(path,value){const{put}=await import('@vercel/blob');return put(path,JSON.stringify(value,null,2),{...(await auth()),access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:'application/json; charset=utf-8'});}
async function getJson(path){try{const{get}=await import('@vercel/blob');const r=await get(path,{...(await auth()),access:'private'});if(r?.statusCode===200)return JSON.parse(await new Response(r.stream).text());}catch{}return null;}

export function memoryBlobConfigured(){return !!(process.env.BLOB_READ_WRITE_TOKEN||process.env.blobyuki_STORE_ID||process.env.BLOB_STORE_ID);}
async function listTurns(profileId,sessionId){const prefix=`${base(profileId,sessionId)}turns/`;const x=await blobList(prefix,1000);return (x.blobs||[]).map(b=>({pathname:b.pathname,turn_no:Number((b.pathname.match(/\/(\d{6})\.json$/)||[])[1]||0)})).filter(x=>x.turn_no>0).sort((a,b)=>a.turn_no-b.turn_no);}
async function listBlocks(profileId,sessionId){const prefix=`${base(profileId,sessionId)}blocks/`;const x=await blobList(prefix,1000);return (x.blobs||[]).map(b=>({pathname:b.pathname,block_no:Math.ceil(Number((b.pathname.match(/\/(\d{6})-/)||[])[1]||0)/MEMORY_BLOCK_SIZE)})).filter(x=>x.block_no>0).sort((a,b)=>a.block_no-b.block_no);}

export async function recordConversationTurn({profileId,sessionId,traceId,requestId,requestText,responseText,yukiState}){
  if(!memoryBlobConfigured())return{stored:false,reason:'blob_memory_unavailable'};
  const turns=await listTurns(profileId,sessionId);
  for(const t of turns){const row=await getJson(t.pathname);if(row?.trace_id===traceId)return{stored:true,turn_no:t.turn_no,duplicate:true,block_no:Math.ceil(t.turn_no/MEMORY_BLOCK_SIZE),compression_due:false};}
  const turnNo=(turns.at(-1)?.turn_no||0)+1;
  const createdAt=new Date().toISOString();
  const row={schema_version:'1.0',profile_id:profileId,session_id:sessionId,turn_no:turnNo,trace_id:traceId,request_id:requestId,request_path:`${BLOB_PREFIX}${traceId}/request.txt`,response_path:`${BLOB_PREFIX}${traceId}/response.txt`,metadata_path:`${BLOB_PREFIX}${traceId}/metadata.json`,yuki_state:yukiState||{},created_at:createdAt};
  await putJson(turnPath(profileId,sessionId,turnNo),row);
  await putJson(sessionPath(profileId,sessionId),{schema_version:'1.0',profile_id:profileId,session_id:sessionId,turn_count:turnNo,updated_at:createdAt});
  return{stored:true,turn_no:turnNo,block_no:Math.ceil(turnNo/MEMORY_BLOCK_SIZE),compression_due:turnNo%MEMORY_BLOCK_SIZE===0};
}

async function hydrateTurn(index){const [requestText,responseText,meta]=await Promise.all([readText(index.trace_id,'request'),readText(index.trace_id,'response'),readMeta(index.trace_id)]);return{turn_no:Number(index.turn_no),trace_id:index.trace_id,request_id:index.request_id,request_text:requestText??'',response_text:responseText??'',yuki_state:meta?.yuki_state||index.yuki_state||{},created_at:index.created_at};}

export async function getRecentTurns(profileId,sessionId,limit=RECENT_TURN_LIMIT){const turns=await listTurns(profileId,sessionId);const selected=turns.slice(-Math.max(1,Math.min(Number(limit)||RECENT_TURN_LIMIT,12)));const out=[];for(const t of selected){const idx=await getJson(t.pathname);if(!idx)continue;const h=await hydrateTurn(idx);out.push({turn_no:h.turn_no,request:trimText(h.request_text),response:trimText(h.response_text),created_at:h.created_at});}return out;}
export async function getHistory(profileId,sessionId,limit=30){const turns=await listTurns(profileId,sessionId);const selected=turns.slice(-Math.max(1,Math.min(Number(limit)||30,100)));const out=[];for(const t of selected){const idx=await getJson(t.pathname);if(idx)out.push(await hydrateTurn(idx));}return out;}
export async function getTurnsRange(profileId,sessionId,startTurn,endTurn){const turns=await listTurns(profileId,sessionId);const selected=turns.filter(t=>t.turn_no>=startTurn&&t.turn_no<=endTurn);const out=[];for(const t of selected){const idx=await getJson(t.pathname);if(idx)out.push(await hydrateTurn(idx));}return out;}
export async function getLatestMemoryState(profileId,sessionId){return await getJson(currentPath(profileId,sessionId));}
export async function getMemoryBlocks(profileId,sessionId,limit=50){const blocks=await listBlocks(profileId,sessionId);const selected=blocks.slice(-Math.max(1,Math.min(Number(limit)||50,100))).reverse();const out=[];for(const b of selected){const row=await getJson(b.pathname);if(row)out.push(row);}return out;}
export async function getStorageManifest(profileId,sessionId){
  const [turns,blocks,current,session]=await Promise.all([listTurns(profileId,sessionId),listBlocks(profileId,sessionId),getLatestMemoryState(profileId,sessionId),getJson(sessionPath(profileId,sessionId))]);
  return{schema_version:'1.0',provider:'vercel_private_blob',profile_id:profileId,session_id:sessionId,prefix:base(profileId,sessionId),turn_count:Number(session?.turn_count??turns.length),turn_index_count:turns.length,block_count:blocks.length,latest_turn_no:turns.at(-1)?.turn_no||0,latest_block_no:blocks.at(-1)?.block_no||0,current_memory_source_block_no:Number(current?.source_block_no||0),current_memory_available:!!current?.memory,stored_artifacts:{turn_index:'memory/.../turns/<turn>.json',compressed_blocks:'memory/.../blocks/<10-turn-range>.json',current_memory:'memory/.../current.json',original_request_response:'results/<trace_id>/request.txt + response.txt'}};
}
export async function saveMemoryBlock({profileId,sessionId,blockNo,startTurn,endTurn,memory,status='ready',error=null}){const now=new Date().toISOString();await putJson(blockPath(profileId,sessionId,blockNo),{schema_version:'1.0',profile_id:profileId,session_id:sessionId,block_no:blockNo,start_turn:startTurn,end_turn:endTurn,status,memory,error,updated_at:now});return true;}
export async function saveMemoryState({profileId,sessionId,sourceBlockNo,memory}){await putJson(currentPath(profileId,sessionId),{schema_version:'1.0',profile_id:profileId,session_id:sessionId,source_block_no:sourceBlockNo,memory,updated_at:new Date().toISOString()});return true;}
export async function memoryBlobHealth(){if(!memoryBlobConfigured())return{configured:false,ok:false,reason:'blob_memory_unavailable'};try{await blobList(MEMORY_PREFIX,1);return{configured:true,ok:true,provider:'vercel_private_blob',prefix:MEMORY_PREFIX};}catch(e){return{configured:true,ok:false,provider:'vercel_private_blob',error:String(e?.message||e)};}}
