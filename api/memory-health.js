import { memoryBlobHealth } from '../src/conversation-blob.js';
import { MEMORY_BLOCK_SIZE, MEMORY_SCHEMA } from '../src/config.js';
const json=(res,status,body)=>{res.status(status).setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store, max-age=0');res.end(JSON.stringify(body));};
export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{ok:false,error:'method_not_allowed'});
  const health=await memoryBlobHealth();
  return json(res,health.ok?200:503,{ok:health.ok,memory:health,compression_block_size:MEMORY_BLOCK_SIZE,memory_schema:MEMORY_SCHEMA,authority:'derived_context_only'});
}
