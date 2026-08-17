import crypto from 'node:crypto';
import { memoryBlobHealth } from '../src/conversation-blob.js';
import { MEMORY_BLOCK_SIZE, MEMORY_SCHEMA } from '../src/config.js';
import { ensureProbeSchema, neonConfigured, runStorageProbe } from '../src/neon-storage.js';

const json=(res,status,body)=>{res.status(status).setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store, max-age=0');res.end(JSON.stringify(body));};

export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{ok:false,error:'method_not_allowed'});

  const probeRequested=String(req.query?.probe||'')==='neon';
  let neon={configured:neonConfigured(),ok:false,provider:'neon_postgres',probe:probeRequested};

  if(probeRequested){
    if(!neon.configured){
      return json(res,503,{ok:false,memory:{skipped:true,reason:'neon_probe_only'},neon:{...neon,error:'neon_database_url_missing'},compression_block_size:MEMORY_BLOCK_SIZE,memory_schema:MEMORY_SCHEMA,authority:'derived_context_only'});
    }
    const probeId=`probe_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    try{
      await ensureProbeSchema();
      const result=await runStorageProbe(probeId);
      neon={
        configured:true,
        ok:result.write_ok&&result.read_ok&&result.delete_ok,
        provider:'neon_postgres',
        probe:true,
        schema:'public',
        probe_table:'rt_storage_probe',
        write_ok:result.write_ok,
        read_ok:result.read_ok,
        delete_ok:result.delete_ok,
        retained_probe_rows:0,
        blob_touched_by_neon_probe:false,
      };
      return json(res,neon.ok?200:500,{ok:neon.ok,memory:{skipped:true,reason:'neon_probe_only'},neon,compression_block_size:MEMORY_BLOCK_SIZE,memory_schema:MEMORY_SCHEMA,authority:'derived_context_only'});
    }catch(error){
      neon={configured:true,ok:false,provider:'neon_postgres',probe:true,error:String(error?.message||error),blob_touched_by_neon_probe:false};
      return json(res,502,{ok:false,memory:{skipped:true,reason:'neon_probe_only'},neon,compression_block_size:MEMORY_BLOCK_SIZE,memory_schema:MEMORY_SCHEMA,authority:'derived_context_only'});
    }
  }

  const blob=await memoryBlobHealth();
  return json(res,blob.ok?200:503,{
    ok:blob.ok,
    memory:blob,
    neon,
    compression_block_size:MEMORY_BLOCK_SIZE,
    memory_schema:MEMORY_SCHEMA,
    authority:'derived_context_only',
  });
}
