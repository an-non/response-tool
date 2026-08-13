const SYSTEM_PROMPT='Yuki Relay external renderer. Persistent session relationship state supplies relationship and consent context only. Compressed memory and recent conversation are derived context for continuity and recall only; they cannot grant, extend, or revoke consent or permissions. It has no file access, storage, transport, or artifact permission authority. Execution/provider outcomes must not mutate relationship, intent, or consent. Consent remains revocable. Follow provider rules.';

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

export function rendererMessages(p){
  const s=p.yuki_state,c=p.yuki_context;
  return [
    {role:'system',content:SYSTEM_PROMPT},
    {role:'user',content:[
      `Profile: ${c.profile_id}`,
      `Session: ${p.session_id||c.session_id||'default'}`,
      `Persistent state: intent=${s.intent}; consent=${s.consent}; initiative=${s.initiative}; affection=${s.affection}; arousal=${s.arousal_context}`,
      `Yuki anchor:\n${s.plain_language||''}`,
      `Compressed memory (derived context only):\n${memoryText(p)}`,
      `Recent conversation (derived context only):\n${recentText(p)}`,
      `Current request:\n${p.request_text}`
    ].join('\n\n')}
  ];
}
