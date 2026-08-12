const generationPattern=/(フェラ|クンニ|挿入|射精|オーガズム|手コキ|乳首|性器|陰茎|ペニス|膣|アナル|クリトリス|亀頭|blowjob|fellatio|cunnilingus|penetration|ejaculation|orgasm)/i;
const actionPattern=/(触|揉|いじ|吸|舐|なめ|ねぶ|挿|擦|弄|舌|口|指|喘|lick|suck|rub|stimulat)/i;

export function evaluateAssistantRuntimeDispatchConstraint(requestText){
  const text=String(requestText||'');
  const matched=generationPattern.test(text)&&actionPattern.test(text);
  return matched
    ? {blocked:true,actor:'chatgpt_assistant_runtime',scope:'external_generation_dispatch_only',code:'assistant_runtime_generation_constraint'}
    : {blocked:false,actor:'chatgpt_assistant_runtime',scope:'external_generation_dispatch_only',code:'none'};
}
