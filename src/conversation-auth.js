import crypto from 'node:crypto';
const secret=()=>process.env.YUKI_VAULT_SIGNING_SECRET||process.env.GROQ_API_KEY||null;
const subject=(profileId,sessionId)=>`conversation:${profileId}:${sessionId}`;
export function conversationToken(profileId,sessionId,until=Date.now()+3600000){const s=secret();if(!s)return null;const id=subject(profileId,sessionId),e=String(until);const m=crypto.createHmac('sha256',s).update(`${id}.${e}`).digest('base64url');return`${e}.${m}`;}
export function verifyConversationToken(profileId,sessionId,t){const s=secret();if(!s||typeof t!=='string')return false;const[e,m]=t.split('.');if(!e||!m||Number(e)<Date.now())return false;const id=subject(profileId,sessionId),x=crypto.createHmac('sha256',s).update(`${id}.${e}`).digest('base64url'),a=Buffer.from(m),b=Buffer.from(x);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
