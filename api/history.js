import { getHistory, memoryDatabaseConfigured } from '../src/conversation-db.js';
import { verifyConversationToken } from '../src/conversation-auth.js';
const json=(res,status,body)=>{res.status(status).setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','private, no-store');res.end(JSON.stringify(body));};
export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{ok:false,error:'method_not_allowed'});
  const profile=String(req.query?.profile_id||''),session=String(req.query?.session_id||''),token=String(req.query?.token||'');
  if(!profile||!session||!verifyConversationToken(profile,session,token))return json(res,401,{ok:false,error:'unauthorized'});
  if(!memoryDatabaseConfigured())return json(res,503,{ok:false,error:'memory_database_not_configured'});
  try{return json(res,200,{ok:true,profile_id:profile,session_id:session,turns:await getHistory(profile,session,req.query?.limit)});}catch(e){return json(res,502,{ok:false,error:'history_read_failed',detail:String(e?.message||e)});}
}
