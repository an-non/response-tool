import { waitUntil } from '@vercel/functions';
import { relay as appRelay } from '../src/app.js';
import { MEMORY_BLOCK_SIZE, memoryDatabaseConfigured, recordConversationTurn } from '../src/conversation-db.js';
import { getRuntimeMemoryContext, compressMemoryBlock } from '../src/memory-compression.js';
import { conversationToken } from '../src/conversation-auth.js';

const decode=p=>JSON.parse(Buffer.from(String(p||''),'base64url').toString('utf8'));
const encode=v=>Buffer.from(JSON.stringify(v),'utf8').toString('base64url');

export default async function handler(req,res){
  if(req.method!=='GET')return appRelay(req,res);
  let payload;
  try{payload=decode(req.query?.p);}catch{return appRelay(req,res);}
  const profileId=String(payload?.yuki_context?.profile_id||'yuki-default');
  const sessionId=String(payload?.session_id||payload?.yuki_context?.session_id||'default');
  payload.session_id=sessionId;
  if(memoryDatabaseConfigured()){
    try{
      const ctx=await getRuntimeMemoryContext(profileId,sessionId);
      payload.memory_context=ctx.memory;
      payload.recent_turns=ctx.recent_turns;
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
        body.memory={database_configured:memoryDatabaseConfigured(),session_id:sessionId,session_token:conversationToken(profileId,sessionId),block_size:MEMORY_BLOCK_SIZE,authority:'derived_context_only'};
        out=JSON.stringify(body);
        if(memoryDatabaseConfigured())waitUntil((async()=>{
          const recorded=await recordConversationTurn({profileId,sessionId,traceId:body.trace_id,requestId:payload.request_id,requestText:payload.request_text,responseText:body.text,yukiState:body.yuki_state_echo||payload.yuki_state});
          if(recorded?.compression_due)await compressMemoryBlock({profileId,sessionId,blockNo:recorded.block_no,currentState:body.yuki_state_echo||payload.yuki_state});
        })().catch(()=>{}));
      }
    }catch{}
    return originalEnd(out,...args);
  };
  return appRelay(wrappedReq,res);
}
