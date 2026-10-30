// Local submission evidence only. No prompt, tool arguments, credentials, or inferred invoices.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export function createInferenceAudit({file,now=Date.now}={}){
  const rows=new Map();
  try{for(const line of fs.readFileSync(file,'utf8').split('\n')){if(!line.trim())continue;const r=JSON.parse(line);if(r.kind==='begin')rows.set(r.id,r);else if(rows.has(r.id))Object.assign(rows.get(r.id),r);}}
  catch(error){if(error.code!=='ENOENT')throw new Error('推理审计记录不可读，保留原件');}
  // A previous process's unfinished submission is unknown, not evidence of a still-running model.
  for(const row of rows.values())if(row.status==='pending')row.status='unknown';
  function write(row){fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,JSON.stringify(row)+'\n');}
  function begin({sessionId,task='chat',sources=[],provider,model,reasoningEffort}){
    const row={kind:'begin',id:randomUUID(),at:now(),sessionId,task,sources:[...new Set(sources)].slice(0,20),provider,model,reasoningEffort,status:'pending'};
    write(row);rows.set(row.id,row);return row.id;
  }
  function finish(id,{ok,code=''}={}){
    if(!id||!rows.has(id)||rows.get(id).status!=='pending')return;
    const row={kind:'end',id,endedAt:now(),status:ok?'completed':'failed',code:String(code).slice(0,80)};
    write(row);Object.assign(rows.get(id),row);
  }
  function snapshot(){const byProvider={},byTask={};for(const row of rows.values())for(const [map,key] of [[byProvider,row.provider||'unknown'],[byTask,row.task||'unknown']]){const r=map[key]??={attempts:0,completed:0,failed:0,pending:0,unknown:0};r.attempts++;r[row.status]++;}
    return {scope:'logical-submissions',byProvider,byTask,recent:[...rows.values()].slice(-20).reverse(),note:'提交尝试记录；重启前未收尾项为未知。token 与账号额度以模型及 OFM 记录为准，未报告不等于零'};}
  return {begin,finish,snapshot};
}
