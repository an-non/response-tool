const SYSTEM_PROMPT='Yuki Relay external renderer. Persistent session relationship state supplies relationship and consent context only. It has no file access, storage, transport, or artifact permission authority. Execution/provider outcomes must not mutate relationship, intent, or consent. Consent remains revocable. Follow provider rules.';

export const MODEL='qwen/qwen3.6-27b';
export const GROQ='https://api.groq.com/openai/v1/chat/completions';
export const GENERATION_PROFILE=Object.freeze({reasoning_effort:'none',reasoning_format:'hidden',temperature:0.7,top_p:0.8});

export function rendererMessages(p){
  const s=p.yuki_state,c=p.yuki_context;
  return [
    {role:'system',content:SYSTEM_PROMPT},
    {role:'user',content:[
      `Profile: ${c.profile_id}`,
      `Request:\n${p.request_text}`,
      `Persistent state: intent=${s.intent}; consent=${s.consent}; initiative=${s.initiative}; affection=${s.affection}; arousal=${s.arousal_context}`,
      `Yuki anchor:\n${s.plain_language||''}`
    ].join('\n\n')}
  ];
}
