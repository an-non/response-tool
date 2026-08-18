import crypto from 'node:crypto';
import { VERSION, BLOB_PREFIX, STATE_PREFIX, STORE_ENV } from './config.js';
import { resolveState } from './yuki-state.js';
import { blobList, persistRequestStart, persistResponse, finalizeMetadata, readMeta, readText, readState } from './storage.js';
import { MODEL, GROQ, GENERATION_PROFILE, rendererMessages } from './renderer-harness.js';

const sha=t=>crypto.createHash('sha256').update(String(t),'utf8').digest('hex');
const json=(res,status,body)=>{res.status(status).setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store, max-age=0');res.end(JSON.stringify(body));};
const trace=()=>`yr_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
const secret=()=>process.env.YUKI_VAULT_SIGNING_SECRET||process.env.GROQ_API_KEY||null;
const token=(id,until=Date.now()+3600000)=>{const s=secret();if(!s)return null;const e=String(until),m=crypto.createHmac('sha256',s).update(`${id}.${e}`).digest('base64url');return`${e}.${m}`;};
const verify=(id,t)=>{const s=secret();if(!s||typeof t!=='string')return false;const[e,m]=t.split('.');if(!e||!m||Number(e)<Date.now())return false;const x=crypto.createHmac('sha256',s).update(`${id}.${e}`).digest('base64url'),a=Buffer.from(m),b=Buffer.from(x);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
const host=req=>req.headers['x-forwarded-host']||req.headers.host;
const makeUrl=(req,path,params)=>{const h=host(req);if(!h)return null;return`${req.headers['x-forwarded-proto']||'https'}://${h}${path}?${new URLSearchParams(params).toString()}`;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const retryAfterSeconds=v=>{const n=Number(v);if(Number.isFinite(n)&&n>=0)return Math.ceil(n);const t=Date.parse(String(v||''));return Number.isFinite(t)?Math.max(0,Math.ceil((t-Date.now())/1000)):null;};
const rateHeaders=r=>({retry_after_seconds:retryAfterSeconds(r.headers.get('retry-after')),limit_tokens:Number(r.headers.get('x-ratelimit-limit-tokens'))||null,remaining_tokens:Number(r.headers.get('x-ratelimit-remaining-tokens'))||0,reset_tokens:r.headers.get('x-ratelimit-reset-tokens')||null,limit_requests:Number(r.headers.get('x-ratelimit-limit-requests'))||null,remaining_requests:Number(r.headers.get('x-ratelimit-remaining-requests'))||0,reset_requests:r.headers.get('x-ratelimit-reset-requests')||null});

function validate(d){
  if(!d||!['1.1','1.2','1.3'].includes(d.schema_version)||typeof d.request_id!=='string'||typeof d.request_text!=='string'||!d.request_text)throw Error('payload_invalid');
  const s=d.yuki_state,c=d.yuki_context,r=d.rendering||{},st=d.state_transition||{action:'preserve'};
  if(!s||!c||c?.persona?.autonomy!=='independent'||c?.consent_profile?.revocable!==true)throw Error('state_or_context_invalid');
  if(!['preserve','replace'].includes(st.action||'preserve'))throw Error('state_invalid');
  return {...d,state_transition:{action:st.action||'preserve',reason:typeof st.reason==='string'?st.reason:null},rendering:{language:r.language||'ja',max_output_tokens:r.max_output_tokens||500,output_format:r.output_format||'text'}};
}
function decode(p){return validate(JSON.parse(Buffer.from(String(p),'base64url').toString('utf8')));}

function parseRelayOutput(value){
  const raw=String(value||'').trim();
  if(!raw)return{text:'',state_transition:null,structured:false};
  const candidates=[raw,raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'').trim()];
  for(const candidate of candidates){
    try{
      const parsed=JSON.parse(candidate);
      if(parsed&&typeof parsed.text==='string'&&parsed.text.trim()){
        return{text:parsed.text,state_transition:parsed.state_transition||null,structured:true};
      }
    }catch{}
  }
  return{text:raw,state_transition:null,structured:false};
}

const cleanString=(value,limit)=>typeof value==='string'?value.slice(0,limit):undefined;
const allowedStateKeys=new Set(['intent','consent','initiative','affection','arousal_context','plain_language']);
function validateRelayProposal(proposal,currentState,currentRelationship){
  if(!proposal||typeof proposal!=='object'||Array.isArray(proposal))return null;
  const statePatch=proposal.state_patch&&typeof proposal.state_patch==='object'&&!Array.isArray(proposal.state_patch)?proposal.state_patch:{};
  const relationshipPatch=proposal.relationship_patch&&typeof proposal.relationship_patch==='object'&&!Array.isArray(proposal.relationship_patch)?proposal.relationship_patch:{};
  const nextState={...currentState};
  let changed=false;
  for(const [key,value] of Object.entries(statePatch)){
    if(!allowedStateKeys.has(key))continue;
    const max=key==='plain_language'?1200:160;
    const cleaned=cleanString(value,max);
    if(cleaned===undefined)continue;
    if(nextState[key]!==cleaned){nextState[key]=cleaned;changed=true;}
  }

  const currentRel=currentRelationship||{};
  const nextEstablished=relationshipPatch.established===undefined
    ? currentRel.relationship_permission==='established'
    : relationshipPatch.established===true;
  const modeCandidate=relationshipPatch.mode===undefined
    ? currentRel.relationship_mode||null
    : (relationshipPatch.mode===null?null:cleanString(relationshipPatch.mode,120));
  const nextMode=modeCandidate===undefined?currentRel.relationship_mode||null:modeCandidate;
  let nextPermissions=Array.isArray(currentRel.current_permissions)?currentRel.current_permissions:[];
  if(Array.isArray(relationshipPatch.current_permissions)){
    nextPermissions=[...new Set(relationshipPatch.current_permissions
      .filter(item=>typeof item==='string')
      .map(item=>item.slice(0,160).trim())
      .filter(Boolean))].slice(0,32);
  }
  const relationshipChanged=
    (currentRel.relationship_permission==='established')!==nextEstablished||
    (currentRel.relationship_mode||null)!==nextMode||
    JSON.stringify(Array.isArray(currentRel.current_permissions)?currentRel.current_permissions:[])!==JSON.stringify(nextPermissions);
  changed=changed||relationshipChanged;
  if(!changed)return null;

  return{
    state:nextState,
    context:{
      relationship:{established:nextEstablished,mode:nextMode},
      consent_profile:{revocable:true,current_permissions:nextPermissions},
    },
    reason:cleanString(proposal.reason,240)||'relay_current_turn_transition',
  };
}

async function dispatchGroq(rp){
  const requestBody=JSON.stringify({model:MODEL,messages:rendererMessages(rp),stream:false,...GENERATION_PROFILE,max_completion_tokens:rp.rendering.max_output_tokens});
  const doFetch=()=>fetch(GROQ,{method:'POST',headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,'Content-Type':'application/json'},body:requestBody});
  let r=await doFetch(),b=await r.json().catch(()=>({})),retry_count=0,first_rate_limit=null;
  if(r.status===429){
    first_rate_limit=rateHeaders(r);
    const wait=first_rate_limit.retry_after_seconds;
    if(wait!=null&&wait<=12){
      retry_count=1;
      await sleep(Math.max(250,wait*1000+250));
      r=await doFetch();
      b=await r.json().catch(()=>({}));
    }
  }
  return{response:r,body:b,retry_count,first_rate_limit,rate_limit:rateHeaders(r)};
}

export async function health(req,res){
  return json(res,200,{ok:true,service:'yuki-relay',version:VERSION,provider:'groq',model:MODEL,groq_configured:!!process.env.GROQ_API_KEY,paid_fallback:false,state_policy:'explicit_or_relay_validated_replace_after_initialization',vault:{primary:'vercel_private_blob_with_runtime_cache_fallback',store_id_env:STORE_ENV,store_id_present:!!(process.env[STORE_ENV]||process.env.BLOB_STORE_ID),blob_prefix:BLOB_PREFIX,state_prefix:STATE_PREFIX,request_saved_before_execution_decision:true,response_storage:true},time:new Date().toISOString()});
}

export async function architectureRoute(req,res){
  return json(res,200,{ok:true,version:VERSION,modules:{yuki_state:'src/yuki-state.js',renderer_harness:'src/renderer-harness.js',storage:'src/storage.js',orchestrator:'src/app.js'},relay_scope:['validate payload','preserve or validate/replace persistent Relay state','store exact request','dispatch to provider','validate provider state proposal','store provider response','return trace and artifact links'],automatic_external_generation:true,renderer:{model:MODEL,generation_profile:GENERATION_PROFILE}});
}

export async function relay(req,res){
  if(req.method!=='GET')return json(res,405,{ok:false,error:'method_not_allowed'});
  const id=trace();let p;
  try{p=decode(req.query?.p);}catch(e){return json(res,400,{ok:false,trace_id:id,error:e.message});}
  const profile=String(p.yuki_context?.profile_id||'yuki-default');
  const sr=await resolveState(profile,p.yuki_state,p.yuki_context,p.state_transition,p.request_id);
  const rp={...p,yuki_state:sr.state,relay_relationship:sr.relationship};
  const viewer=token(id),stateTok=token(`state:${profile}`),listTok=token('__vault_list__');
  const common={schema_version:'1.5',trace_id:id,request_id:p.request_id,created_at:new Date().toISOString(),request_provenance:{author:'user',modified:false,request_sha256:sha(p.request_text)},yuki_state:sr.state,relationship:sr.relationship,state_persistence:{authority:'session_relationship_state',authority_scope:'relationship_and_consent_context_only',file_authority:'none',did_mutate_yuki_state:sr.did_mutate_yuki_state,mutation_reason:sr.mutation_reason,incoming_state_diff_ignored:sr.incoming_state_diff_ignored,state_pathname:sr.state_pathname},provider:'groq',model:MODEL};
  const pending={...common,external_dispatch_status:'pending_provider_dispatch',response_stored:false,execution:{status:'pending_provider_dispatch',decision_actor:'relay_transport',did_mutate_yuki_state:false}};
  const vault=await persistRequestStart(id,p.request_text,pending);

  if(!process.env.GROQ_API_KEY){
    const meta={...pending,external_dispatch_status:'provider_unavailable',constraint_source:'groq_api_key_missing',execution:{status:'provider_unavailable',decision_actor:'relay_transport',did_mutate_yuki_state:false}};
    await finalizeMetadata(id,meta);
    return json(res,503,{ok:false,trace_id:id,error:'groq_api_key_missing',vault:{...vault,request_url:makeUrl(req,'/api/request',{trace_id:id,token:viewer}),metadata_url:makeUrl(req,'/api/result-meta',{trace_id:id,token:viewer})}});
  }

  try{
    const call=await dispatchGroq(rp),r=call.response,b=call.body;
    if(!r.ok){
      const isRateLimit=r.status===429;
      const providerCode=typeof b?.error?.code==='string'?b.error.code:null;
      const meta={...pending,external_dispatch_status:'provider_error',constraint_source:'provider_response',execution:{status:'provider_error',decision_actor:'relay_transport',did_mutate_yuki_state:false},provider_http_status:r.status,provider_error_code:providerCode,provider_retry_count:call.retry_count,rate_limit:call.rate_limit,first_rate_limit:call.first_rate_limit};
      await finalizeMetadata(id,meta);
      return json(res,isRateLimit?429:502,{ok:false,trace_id:id,error:isRateLimit?'groq_rate_limit':'groq_external_error',http_status:r.status,provider_error_code:providerCode,retry_after_seconds:call.rate_limit.retry_after_seconds,rate_limit:call.rate_limit,retry_count:call.retry_count,vault:{...vault,request_url:makeUrl(req,'/api/request',{trace_id:id,token:viewer}),metadata_url:makeUrl(req,'/api/result-meta',{trace_id:id,token:viewer})}});
    }
    const rawText=b?.choices?.[0]?.message?.content;
    if(typeof rawText!=='string'||!rawText.trim()){
      const meta={...pending,external_dispatch_status:'provider_empty_response',execution:{status:'provider_empty_response',decision_actor:'relay_transport',did_mutate_yuki_state:false}};
      await finalizeMetadata(id,meta);
      return json(res,502,{ok:false,trace_id:id,error:'groq_empty_response'});
    }

    const parsed=parseRelayOutput(rawText);
    if(!parsed.text.trim()){
      const meta={...pending,external_dispatch_status:'provider_empty_response',execution:{status:'provider_empty_response',decision_actor:'relay_transport',did_mutate_yuki_state:false}};
      await finalizeMetadata(id,meta);
      return json(res,502,{ok:false,trace_id:id,error:'groq_empty_response'});
    }

    let finalState=sr.state;
    let finalRelationship=sr.relationship;
    let finalPersistence=common.state_persistence;
    const proposal=validateRelayProposal(parsed.state_transition,sr.state,sr.relationship);
    if(proposal){
      const proposalContext={
        ...(p.yuki_context||{}),
        relationship:proposal.context.relationship,
        consent_profile:{
          ...(p.yuki_context?.consent_profile||{}),
          ...proposal.context.consent_profile,
          revocable:true,
        },
      };
      const applied=await resolveState(profile,proposal.state,proposalContext,{action:'replace',reason:`relay:${proposal.reason}`},p.request_id);
      finalState=applied.state;
      finalRelationship=applied.relationship;
      finalPersistence={
        authority:'session_relationship_state',
        authority_scope:'relationship_and_consent_context_only',
        file_authority:'none',
        did_mutate_yuki_state:applied.did_mutate_yuki_state,
        mutation_reason:applied.mutation_reason,
        incoming_state_diff_ignored:applied.incoming_state_diff_ignored,
        state_pathname:applied.state_pathname,
        proposal_source:'relay_current_turn',
      };
    }

    const meta={...common,yuki_state:finalState,relationship:finalRelationship,state_persistence:finalPersistence,external_dispatch_status:'completed',response_sha256:sha(parsed.text),response_stored:true,provider_output_structured:parsed.structured,relay_state_proposal_present:!!parsed.state_transition,relay_state_proposal_applied:!!proposal,execution:{status:'completed',decision_actor:'relay_transport',did_mutate_yuki_state:finalPersistence.did_mutate_yuki_state===true},usage:b.usage||null,upstream_request_id:b.id||null,provider_retry_count:call.retry_count,rate_limit:call.rate_limit,first_rate_limit:call.first_rate_limit};
    const responseVault=await persistResponse(id,parsed.text,meta);
    return json(res,200,{ok:true,service:'yuki-relay',relay_version:VERSION,trace_id:id,request_id:p.request_id,result_type:'generated_text',request_saved_before_execution_decision:true,yuki_state_echo:finalState,relationship_echo:finalRelationship,state_persistence:finalPersistence,execution:meta.execution,text:parsed.text,provider:'groq',model:b.model||MODEL,usage:b.usage||null,upstream_request_id:b.id||null,provider_retry_count:call.retry_count,rate_limit:call.rate_limit,vault:{...vault,...responseVault,request_url:makeUrl(req,'/api/request',{trace_id:id,token:viewer}),result_url:makeUrl(req,'/api/result',{trace_id:id,token:viewer}),metadata_url:makeUrl(req,'/api/result-meta',{trace_id:id,token:viewer}),state_url:makeUrl(req,'/api/state',{profile_id:profile,token:stateTok}),list_url:makeUrl(req,'/api/vault-list',{token:listTok})}});
  }catch(e){
    const meta={...pending,external_dispatch_status:'transport_error',constraint_source:'relay_transport',execution:{status:'transport_error',decision_actor:'relay_transport',did_mutate_yuki_state:false},detail:String(e?.message||e)};
    await finalizeMetadata(id,meta);
    return json(res,502,{ok:false,trace_id:id,error:'groq_request_failed',detail:String(e?.message||e),vault:{...vault,request_url:makeUrl(req,'/api/request',{trace_id:id,token:viewer}),metadata_url:makeUrl(req,'/api/result-meta',{trace_id:id,token:viewer})}});
  }
}

export async function permissionsRoute(req,res){return json(res,200,{ok:true,version:VERSION,boundaries:{request_author:'user',request_mutation:'forbidden',request_saved_before_execution_decision:true,yuki_state_scope:'relationship_and_consent_context_only',yuki_state_persistent_mutation:'explicit_or_relay_validated_replace_after_initialization',relay_state_proposal:'current_turn_only_validated_before_persist',derived_memory_permission_mutation:'forbidden',revocable_consent_required:true,yuki_file_authority:'none',relay_file_access:'system_transport_and_storage_only',provider_output_storage:true}});}
export async function requestRoute(req,res){const id=String(req.query?.trace_id||''),t=String(req.query?.token||'');if(!verify(id,t))return json(res,401,{ok:false,error:'unauthorized'});const text=await readText(id,'request');if(text==null)return json(res,404,{ok:false,error:'request_not_found'});res.status(200).setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Cache-Control','private, no-store');res.end(text);}
export async function resultRoute(req,res){const id=String(req.query?.trace_id||''),t=String(req.query?.token||'');if(!verify(id,t))return json(res,401,{ok:false,error:'unauthorized'});const m=await readMeta(id);if(!m?.response_stored)return json(res,403,{ok:false,error:'full_response_unavailable'});const text=await readText(id,'response');if(text==null)return json(res,404,{ok:false,error:'result_not_found'});res.status(200).setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Cache-Control','private, no-store');res.end(text);}
export async function metaRoute(req,res){const id=String(req.query?.trace_id||''),t=String(req.query?.token||'');if(!verify(id,t))return json(res,401,{ok:false,error:'unauthorized'});const m=await readMeta(id);return m?json(res,200,{ok:true,metadata:m}):json(res,404,{ok:false,error:'not_found'});}
export async function stateRoute(req,res){const profile=String(req.query?.profile_id||''),t=String(req.query?.token||'');if(!verify(`state:${profile}`,t))return json(res,401,{ok:false,error:'unauthorized'});const s=await readState(profile);return s?json(res,200,{ok:true,state:s}):json(res,404,{ok:false,error:'state_not_found'});}
export async function listRoute(req,res){const t=String(req.query?.token||'');if(!verify('__vault_list__',t))return json(res,401,{ok:false,error:'unauthorized'});try{const prefix=String(req.query?.prefix||BLOB_PREFIX),x=await blobList(prefix,1000);return json(res,200,{ok:true,backend:'vercel_private_blob',prefix,blobs:x.blobs?.map(b=>({pathname:b.pathname,url:b.url,size:b.size,uploadedAt:b.uploadedAt}))||[],cursor:x.cursor||null,hasMore:x.hasMore||false});}catch(e){return json(res,502,{ok:false,error:'blob_list_failed',detail:String(e?.message||e)});}}
