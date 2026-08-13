import { waitUntil } from '@vercel/functions';
import { relay as appRelay } from '../src/app.js';
import { MEMORY_BLOCK_SIZE, memoryBlobConfigured, recordConversationTurn, getStorageManifest, bindActiveSession } from '../src/conversation-blob.js';
import { getRuntimeMemoryContext, compressMemoryBlock, recallMemory } from '../src/memory-compression.js';
import { conversationToken } from '../src/conversation-auth.js';

const decode=p=>JSON.parse(Buffer.from(String(p||''),'base64url').toString('utf8'));
const encode=v=>Buffer.from(JSON.stringify(v),'utf8').toString('base64url');

export default async function handler(req,res){
  if(req.method!=='GET')return appRelay(req,res);
  let payload;
  try{payload=decode(req.query?.p);}catch{return appRelay(req,res);}
  const profileId=String(payload?.yuki_context?.profile_id||'yuki-default');
  const sessionId=String(payload?.session_id||payload?.yuki_context?.session_id||'default');
  const clientId=String(payload?.client_id||'');
  const clientKey=String(payload?.client_key||'');
  payload.session_id=sessionId;
  if(memoryBlobConfigured()){
    try{
      const [ctx,recall,manifest]=await Promise.all([
        getRuntimeMemoryContext(profileId,sessionId),
        recallMemory(profileId,sessionId,payload.request_text,3),
        getStorageManifest(profileId,sessionId)
      ]);
      payload.memory_context=ctx.memory;
      payload.recent_turns=ctx.recent_turns;
      payload.recall_context=recall;
      payload.storage_manifest=manifest;
    }catch(e){payload.memory_load_error=String(e?.message||e);}
  }
  const wrappedReq=Object.create(req);
  wrappedReq.query={...(req.query||{}),p:encode(payload)};
  const originalEnd=res.end.bind(res);
  res.end=(chunk,...args)=>{
    let out=chunk;
    try{
      const body=JSON.parse(Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk||''));
      if(body?.ok===true&&body?.result_type==='generated_text'){
        body.memory={blob_configured:memoryBlobConfigured(),session_id:sessionId,session_token:conversationToken(profileId,sessionId),block_size:MEMORY_BLOCK_SIZE,authority:'derived_context_only',recall_matches:Array.isArray(payload.recall_context?.matches)?payload.recall_context.matches.length:0,recall_blocks:Array.isArray(payload.recall_context?.blocks)?payload.recall_context.blocks.length:0,manifest:payload.storage_manifest||null};
        out=JSON.stringify(body);
        if(memoryBlobConfigured())waitUntil((async()=>{
          if(clientId&&clientKey)await bindActiveSession(profileId,sessionId,clientId,clientKey);
          const recorded=await recordConversationTurn({profileId,sessionId,traceId:body.trace_id,requestId:payload.request_id,requestText:payload.request_text,responseText:body.text,yukiState:body.yuki_state_echo||payload.yuki_state});
          if(recorded?.compression_due)await compressMemoryBlock({profileId,sessionId,blockNo:recorded.block_no,currentState:body.yuki_state_echo||payload.yuki_state});
        })().catch(()=>{}));
      }
    }catch{}
    return originalEnd(out,...args);
  };
  return appRelay(wrappedReq,res);
}
