import { getHistory, memoryBlobConfigured, resolveActiveSession } from '../src/conversation-blob.js';
import { conversationToken, verifyConversationToken } from '../src/conversation-auth.js';
const json=(res,status,body)=>{res.status(status).setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','private, no-store');res.end(JSON.stringify(body));};
export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{ok:false,error:'method_not_allowed'});
  const profile=String(req.query?.profile_id||'');
  if(!profile)return json(res,400,{ok:false,error:'profile_required'});
  if(!memoryBlobConfigured())return json(res,503,{ok:false,error:'memory_blob_not_configured'});
  try{
    const session=String(req.query?.session_id||''),token=String(req.query?.token||'');
    if(session&&token){
      if(!verifyConversationToken(profile,session,token))return json(res,401,{ok:false,error:'unauthorized'});
      return json(res,200,{ok:true,profile_id:profile,session_id:session,turns:await getHistory(profile,session,req.query?.limit)});
    }
    const clientId=String(req.query?.client_id||''),clientKey=String(req.query?.client_key||'');
    if(!clientId||!clientKey)return json(res,400,{ok:false,error:'session_token_or_client_credentials_required'});
    const active=await resolveActiveSession(profile,clientId,clientKey);
    if(active?.unauthorized)return json(res,401,{ok:false,error:'unauthorized'});
    if(!active?.session_id)return json(res,404,{ok:false,error:'active_session_not_found'});
    const activeSession=String(active.session_id);
    return json(res,200,{ok:true,profile_id:profile,session_id:activeSession,session_token:conversationToken(profile,activeSession),updated_at:active.updated_at,turns:await getHistory(profile,activeSession,req.query?.limit||30)});
  }catch(e){return json(res,502,{ok:false,error:'history_read_failed',detail:String(e?.message||e)});}
}
