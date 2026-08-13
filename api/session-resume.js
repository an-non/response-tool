import { getHistory, memoryBlobConfigured, resolveActiveSession } from '../src/conversation-blob.js';
import { conversationToken } from '../src/conversation-auth.js';
const json=(res,status,body)=>{res.status(status).setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','private, no-store');res.end(JSON.stringify(body));};
export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{ok:false,error:'method_not_allowed'});
  const profile=String(req.query?.profile_id||''),clientId=String(req.query?.client_id||''),clientKey=String(req.query?.client_key||'');
  if(!profile||!clientId||!clientKey)return json(res,400,{ok:false,error:'client_credentials_required'});
  if(!memoryBlobConfigured())return json(res,503,{ok:false,error:'memory_blob_not_configured'});
  try{
    const active=await resolveActiveSession(profile,clientId,clientKey);
    if(active?.unauthorized)return json(res,401,{ok:false,error:'unauthorized'});
    if(!active?.session_id)return json(res,404,{ok:false,error:'active_session_not_found'});
    const turns=await getHistory(profile,active.session_id,req.query?.limit||30);
    return json(res,200,{ok:true,profile_id:profile,session_id:active.session_id,session_token:conversationToken(profile,active.session_id),updated_at:active.updated_at,turns});
  }catch(e){return json(res,502,{ok:false,error:'session_resume_failed',detail:String(e?.message||e)});}
}
