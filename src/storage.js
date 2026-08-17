import { getCache } from '@vercel/functions';
import { BLOB_PREFIX, STATE_PREFIX, STORE_ENV, CACHE_NAMESPACE, TTL } from './config.js';
import { neonMemoryConfigured, readResultTrace, writeResultMetadata, writeResultResponse, writeResultStart } from './neon-memory.js';
const cache=()=>getCache({namespace:CACHE_NAMESPACE});
const safe=id=>encodeURIComponent(String(id||'default')).replace(/%/g,'_');
export const statePath=id=>`${STATE_PREFIX}${safe(id)}/current.json`;
export const resultBase=id=>`${BLOB_PREFIX}${id}`;
async function blobAuth(){if(process.env.BLOB_READ_WRITE_TOKEN)return{token:process.env.BLOB_READ_WRITE_TOKEN};const storeId=process.env[STORE_ENV]||process.env.BLOB_STORE_ID;if(!storeId)throw Error('blob_store_id_missing');const{getVercelOidcToken}=await import('@vercel/oidc');const oidcToken=await getVercelOidcToken();if(!oidcToken)throw Error('blob_oidc_token_unavailable');return{oidcToken,storeId};}
async function blobPut(path,body,type='application/json; charset=utf-8'){const{put}=await import('@vercel/blob');return put(path,body,{...(await blobAuth()),access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:type});}
async function blobGet(path){const{get}=await import('@vercel/blob');return get(path,{...(await blobAuth()),access:'private'});}
export async function blobList(prefix,limit=1000){const{list}=await import('@vercel/blob');return list({...(await blobAuth()),prefix,limit});}
async function cacheSet(id,key,val){await cache().set(`${id}:${key}`,val,{ttl:TTL,tags:[`trace:${id}`],name:`yuki-${key}`});}
async function cacheGet(id,key){return cache().get(`${id}:${key}`);}
export async function readState(profile){try{const r=await blobGet(statePath(profile));if(r?.statusCode===200)return JSON.parse(await new Response(r.stream).text());}catch{}return await cacheGet(`state:${safe(profile)}`,'current')||null;}
export async function writeState(profile,record){try{await blobPut(statePath(profile),JSON.stringify(record,null,2));await cacheSet(`state:${safe(profile)}`,'current',record);}catch{await cacheSet(`state:${safe(profile)}`,'current',record);}}
export async function persistRequestStart(id,requestText,metadata){
  if(neonMemoryConfigured()){
    try{await writeResultStart(id,requestText,metadata);return{backend:'neon_postgres',trace_id:id,request_saved:true,blob_attempted:false};}catch(e){await cacheSet(id,'request',requestText);await cacheSet(id,'metadata',{...metadata,neon_attempted:true,neon_attempt_error:String(e?.message||e)});return{backend:'vercel_runtime_cache',ttl_seconds:TTL,neon_attempted:true,neon_attempt_error:String(e?.message||e)};}
  }
  try{const base=resultBase(id);const q=await blobPut(`${base}/request.txt`,requestText,'text/plain; charset=utf-8');metadata.request_pathname=q.pathname;const m=await blobPut(`${base}/metadata.json`,JSON.stringify(metadata,null,2));return{backend:'vercel_private_blob',store_hostname:new URL(m.url).hostname,base_pathname:base,request_pathname:q.pathname,metadata_pathname:m.pathname};}catch(e){await cacheSet(id,'request',requestText);await cacheSet(id,'metadata',{...metadata,blob_attempted:true,blob_attempt_error:String(e?.message||e)});return{backend:'vercel_runtime_cache',ttl_seconds:TTL,blob_attempted:true,blob_attempt_error:String(e?.message||e)};}
}
export async function readMeta(id){
  if(neonMemoryConfigured()){try{const row=await readResultTrace(id);if(row?.metadata)return row.metadata;}catch{}
  }
  try{const r=await blobGet(`${resultBase(id)}/metadata.json`);if(r?.statusCode===200)return JSON.parse(await new Response(r.stream).text());}catch{}return await cacheGet(id,'metadata')||null;
}
export async function readText(id,name){
  if(neonMemoryConfigured()){try{const row=await readResultTrace(id);const v=name==='request'?row?.request_text:name==='response'?row?.response_text:null;if(typeof v==='string')return v;}catch{}
  }
  try{const r=await blobGet(`${resultBase(id)}/${name}.txt`);if(r?.statusCode===200)return await new Response(r.stream).text();}catch{}return await cacheGet(id,name)||null;
}
export async function finalizeMetadata(id,metadata){
  if(neonMemoryConfigured()){try{await writeResultMetadata(id,metadata);return true;}catch{await cacheSet(id,'metadata',metadata);return false;}}
  try{await blobPut(`${resultBase(id)}/metadata.json`,JSON.stringify(metadata,null,2));return true;}catch{await cacheSet(id,'metadata',metadata);return false;}
}
export async function persistResponse(id,responseText,metadata){
  if(neonMemoryConfigured()){
    try{await writeResultResponse(id,responseText,metadata);return{backend:'neon_postgres',trace_id:id,response_saved:true,blob_attempted:false};}catch(e){await cacheSet(id,'response',responseText);await cacheSet(id,'metadata',{...metadata,neon_attempted:true,neon_attempt_error:String(e?.message||e)});return{backend:'vercel_runtime_cache',ttl_seconds:TTL,neon_attempted:true,neon_attempt_error:String(e?.message||e)};}
  }
  try{const r=await blobPut(`${resultBase(id)}/response.txt`,responseText,'text/plain; charset=utf-8');metadata.response_pathname=r.pathname;await blobPut(`${resultBase(id)}/metadata.json`,JSON.stringify(metadata,null,2));return{backend:'vercel_private_blob',response_pathname:r.pathname};}catch(e){await cacheSet(id,'response',responseText);await cacheSet(id,'metadata',{...metadata,blob_attempted:true,blob_attempt_error:String(e?.message||e)});return{backend:'vercel_runtime_cache',ttl_seconds:TTL,blob_attempted:true,blob_attempt_error:String(e?.message||e)};}
}
