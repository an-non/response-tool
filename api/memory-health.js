import crypto from 'node:crypto';
import { memoryBlobHealth } from '../src/conversation-blob.js';
import { MEMORY_BLOCK_SIZE, MEMORY_SCHEMA } from '../src/config.js';
import { ensureProbeSchema, neonConfigured, runStorageProbe } from '../src/neon-storage.js';

const json=(res,status,body)=>{res.status(status).setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store, max-age=0');res.end(JSON.stringify(body));};

export default async function handler(req,res){
  if(req.method!=='GET')return json(res,405,{ok:false,error:'method_not_allowed'});

  const blob=await memoryBlobHealth();
  let neon={configured:neonConfigured(),ok:false,provider:'neon_postgres',probe:false};

  if(neon.configured&&String(req.query?.probe||'')==='neon'){
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
    }catch(error){
      neon={configured:true,ok:false,provider:'neon_postgres',probe:true,error:String(error?.message||error),blob_touched_by_neon_probe:false};
    }
  }

  const probeRequested=String(req.query?.probe||'')==='neon';
  const ok=probeRequested?neon.ok:blob.ok;
  return json(res,ok?200:503,{
    ok,
    memory:blob,
    neon,
    compression_block_size:MEMORY_BLOCK_SIZE,
    memory_schema:MEMORY_SCHEMA,
    authority:'derived_context_only',
  });
}
