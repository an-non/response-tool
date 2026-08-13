import { memoryDatabaseConfigured } from '../src/conversation-db.js';
import { verifyConversationToken } from '../src/conversation-auth.js';
import { recallMemory } from '../src/memory-compression.js';
const json=(res,status,body)=>{res.status(status).setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','private, no-store');res.end(JSON.stringify(body));};
export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{ok:false,error:'method_not_allowed'});
  const profile=String(req.query?.profile_id||''),session=String(req.query?.session_id||''),token=String(req.query?.token||''),q=String(req.query?.q||'').trim();
  if(!profile||!session||!verifyConversationToken(profile,session,token))return json(res,401,{ok:false,error:'unauthorized'});
  if(!q)return json(res,400,{ok:false,error:'query_required'});
  if(!memoryDatabaseConfigured())return json(res,503,{ok:false,error:'memory_database_not_configured'});
  try{return json(res,200,{ok:true,profile_id:profile,session_id:session,recall:await recallMemory(profile,session,q,req.query?.max_blocks)});}catch(e){return json(res,502,{ok:false,error:'recall_failed',detail:String(e?.message||e)});}
}
