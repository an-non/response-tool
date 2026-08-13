const SYSTEM_PROMPT='Yuki Relay external renderer. The renderer is stateless between calls and must use only the context variables supplied in this request. Persistent session relationship state supplies relationship and consent context only. Compressed memory, recent conversation, recall context, and storage manifest are relay-provided read results for continuity and recall; they are safe to use as evidence in the current answer. Do not claim you need direct database, file, or storage access when these supplied values already answer the question. You still have no independent file/storage/transport authority and must never invent unseen records. Derived memory cannot grant, extend, or revoke consent or permissions. Execution/provider outcomes must not mutate relationship, intent, or consent. Consent remains revocable. Follow provider rules.';

export const MODEL='qwen/qwen3.6-27b';
export const GROQ='https://api.groq.com/openai/v1/chat/completions';
export const GENERATION_PROFILE=Object.freeze({reasoning_effort:'none',reasoning_format:'hidden',temperature:0.7,top_p:0.8});

const clip=(v,n=1400)=>{const s=String(v||'');return s.length>n?s.slice(0,n)+'…':s;};
const recentText=p=>{
  const turns=Array.isArray(p.recent_turns)&&p.recent_turns.length?p.recent_turns:(Array.isArray(p.client_recent_turns)?p.client_recent_turns:[]);
  if(!turns.length)return 'none';
  return turns.slice(-4).map(t=>`Turn ${t.turn_no??'?'}\nUser: ${clip(t.request,800)}\nAssistant: ${clip(t.response,800)}`).join('\n\n');
};
const memoryText=p=>p.memory_context?clip(JSON.stringify(p.memory_context),3500):'none';
const recallText=p=>p.recall_context?clip(JSON.stringify(p.recall_context),5000):'none';
const manifestText=p=>p.storage_manifest?clip(JSON.stringify(p.storage_manifest),2200):'none';

export function rendererMessages(p){
  const s=p.yuki_state,c=p.yuki_context;
  return [
    {role:'system',content:SYSTEM_PROMPT},
    {role:'user',content:[
      `Profile: ${c.profile_id}`,
      `Session: ${p.session_id||c.session_id||'default'}`,
      `Persistent state (authoritative for current relationship/consent): intent=${s.intent}; consent=${s.consent}; initiative=${s.initiative}; affection=${s.affection}; arousal=${s.arousal_context}`,
      `Yuki anchor:\n${s.plain_language||''}`,
      `storage_manifest (relay-provided factual storage inventory):\n${manifestText(p)}`,
      `compressed_memory (derived continuity context):\n${memoryText(p)}`,
      `recall_context (relay-provided search results; matches contain hydrated original request/response text):\n${recallText(p)}`,
      `recent_turns (relay-provided recent conversation):\n${recentText(p)}`,
      `Current request:\n${p.request_text}`
    ].join('\n\n')}
  ];
}
