import {Worker} from 'node:worker_threads';
// Local usage ledger. Never stores prompts, credentials or raw request IDs.
import {readFile,writeFile,mkdir,rename,readdir,unlink,open,stat,lstat} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {tokenCount,requestCacheMetrics} from './metrics.mjs';
import {platformPaths} from '../../compat/platform.mjs';
import {discoverLocalConversations,conversationId} from './local-conversations.mjs';
import {setImmediate as yieldToLiveRequests} from 'node:timers/promises';
import {delegatedIds} from './delegation.mjs';
import {collectionFailure} from './collection-state.mjs';
import {syncAndSummarizeIndex,findForeignRequestIds} from './usage-index.mjs';
import {QuotaEstimator} from './quota-estimator.mjs';
const pricing=createRequire(import.meta.url)('../../compat/pricing.cjs')();
const HASH=/^[a-f0-9]{64}$/,GUID=/^[a-f0-9-]{36}$/i;
const hash=value=>createHash('sha256').update(value).digest('hex');
export const LOCAL_SCOPE=hash('ag-pulse:local-unauthenticated');
const keys=['uncached','cacheRead','cacheWrite','output'];
export function quotaModelFamily(value){
  const s=String(value||'');
  if(/(?:^|[^a-z])argon(?:$|[^a-z])/i.test(s))return 'gemini-argon';
  if(/gemini|hydrogen|carbon|neon|orchestrator/i.test(s))return 'gemini';
  if(/claude|sonnet|opus|haiku|anthropic|gpt|openai/i.test(s)||/(?:^|[^a-z0-9])o[134](?:$|[^a-z0-9])/i.test(s)||/^3p(?:$|[-_])/i.test(s))return '3p';
  return null;
}
export function classifyQuotaGroupId(groups,model){
  const list=Array.isArray(groups)?groups.filter(g=>g&&typeof g.id==='string'):[];
  if(!list.length)return null;
  const kind=quotaModelFamily(model);
  const specific=kind&&list.find(g=>quotaModelFamily(`${g.id} ${g.name||''}`)===kind);
  if(specific)return specific.id;
  if(kind==='gemini-argon'){const shared=list.find(g=>g.id==='gemini'&&quotaModelFamily(`${g.id} ${g.name||''}`)==='gemini');if(shared)return shared.id;}
  return kind?null:list[0].id;
}
function buildQuotaWindowSpecs(groups){
  const specs=[],groupInfos=[];
  for(const g of (Array.isArray(groups)?groups:[])){
    if(!g||typeof g.id!=='string')continue;
    groupInfos.push({id:g.id,name:String(g.name||'')});
    for(const win of ['5h','weekly']){
      const b=g.windows?.[win];
      if(!b?.available||b.disabled===true)continue;
      const endAt=typeof b.resetAt==='string'?Date.parse(b.resetAt):NaN;
      if(!Number.isFinite(endAt))continue;
      const dur=win==='5h'?18000000:604800000;
      const remaining=typeof b.remaining==='number'&&Number.isFinite(b.remaining)&&b.remaining>=0&&b.remaining<=1?b.remaining:null;
      const idle=remaining!==null&&remaining>=1;
      specs.push({id:`${g.id}:${win}`,groupId:g.id,window:win,startAt:endAt-dur,endAt,resetMinute:Math.round(endAt/60000),remaining,idle});
    }
  }
  return {specs,groupInfos};
}
function quotaWindowMeta(specs){
  return Object.fromEntries(specs.map(s=>[s.id,{resetMinute:s.resetMinute,idle:s.idle}]));
}
function finalizeQuotaWindows(specs,counts={},meta=null,{estimator=null,accountKey=null,allowUpdate=true,days=null,today=''}={}){
  const out={};
  const hasDedicatedArgon=specs.some(s=>s.window==='weekly'&&pricing.quotaFamily(s.groupId)==='gemini-argon');
  const rateFor=Array.isArray(days)&&days.length&&today?pricing.computeFamilyRates(days,today,{hasDedicatedArgon}):null;
  for(const spec of specs){
    const prev=meta?.[spec.id];
    if(prev){
      if(spec.idle!==prev.idle)continue;
      if(!spec.idle&&Math.abs(prev.resetMinute-spec.resetMinute)>2)continue;
    }
    const c=counts[spec.id];
    if(!c||!c.requests)continue;
    if(estimator){
      // Weekly windows convert cost-space full USD to tokens via recent 7-day family rate
      // (matching Overview KPI tooltips); 5h windows use the window's own blended rate first.
      const windowRate=typeof c.observedCostUsd==='number'&&c.observedCostUsd>0&&c.observedTokens>0?c.observedCostUsd/c.observedTokens:null;
      const familyRate=rateFor?rateFor(pricing.quotaFamily(spec.groupId)):null;
      const recentUsdPerToken=spec.window==='weekly'?(familyRate||windowRate):(windowRate||familyRate);
      out[spec.id]=estimator.estimate(accountKey,spec,c,{allowUpdate,recentUsdPerToken});
    }else{
      const usedFraction=typeof spec.remaining==='number'?Math.max(0,Math.min(1,1-spec.remaining)):null;
      const estimatedFullTokens=c.observedTokens>0&&usedFraction!==null&&usedFraction>=0.05?Math.round(c.observedTokens/usedFraction):null;
      out[spec.id]={observedTokens:c.observedTokens,estimatedFullTokens,requests:c.requests,usedFraction};
    }
  }
  return out;
}
const cleanModel=value=>String(value||'Unknown').replace(/[\x00-\x1f\x7f]/g,'').slice(0,120);
const stamp=value=>typeof value==='string'&&/^20\d\d-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const sum=r=>keys.reduce((n,k)=>n+(r[k]??0),0);
function mergeUsageRow(row,old){const record={...row,at:row.at??old?.at??null,timeBasis:row.at===null&&old?.at!==null&&old?.at!==undefined?old.timeBasis:row.timeBasis};for(const key of keys)record[key]=row[key]??old?.[key]??null;return record;}
// Counts include an allowance for JS object and Map overhead, not just the
// serialized projection. The original response and message text are never
// retained by the live write queue.
const projectedBytes=row=>Buffer.byteLength(JSON.stringify(row))+128;
const LIVE_UNGUARDED=Symbol('unguarded'),LIVE_RECOVERY=Symbol('recovery');
const guardActive=guard=>{try{return guard()===true;}catch{return false;}};
const BACKFILL_BYTES=8*1024*1024,BACKFILL_ENTRIES=4096;
function checkpointState(entries={},partial=false,recovery=null){
  Object.defineProperties(entries,{checkpointPartial:{value:partial,enumerable:false},checkpointRecovery:{value:recovery,enumerable:false}});return entries;
}
function boundedCheckpoints(entries,preferred=[],reportTruncation=false){
  const relevant=new Set(preferred),valid=[];let rejected=0;
  for(const [id,e]of Object.entries(entries)){
    if(!HASH.test(id)||!e||!HASH.test(e.signature)||!['complete','retry'].includes(e.state)||!Number.isSafeInteger(e.failures)||e.failures<0||!Number.isSafeInteger(e.retryAt)||e.retryAt<0){rejected++;continue;}
    valid.push([id,{signature:e.signature,state:e.state,failures:e.failures,retryAt:e.retryAt,...(e.hasDelegates===true?{hasDelegates:true}:{})}]);
  }
  // Preserve retries and the active pass before unrelated settled checkpoints.
  // Checkpoints are an optimization; eviction never deletes usage records.
  const priority=([id,e])=>e.state==='retry'?(relevant.has(id)?3:2):(relevant.has(id)?1:0);
  valid.reverse().sort((a,b)=>priority(b)-priority(a));
  return checkpointState(Object.fromEntries(valid.slice(0,BACKFILL_ENTRIES)),entries.checkpointPartial===true||reportTruncation&&(rejected>0||valid.length>BACKFILL_ENTRIES),entries.checkpointRecovery||null);
}
async function readBounded(file,budget){
  const handle=await open(file,'r');
  try{
    if((await handle.stat()).size>budget)throw Object.assign(Error('Usage file exceeds read budget'),{code:'USAGE_READ_BUDGET'});
    const chunks=[];let bytes=0;
    while(bytes<=budget){
      const chunk=Buffer.allocUnsafe(Math.min(65536,budget-bytes+1));const {bytesRead}=await handle.read(chunk,0,chunk.length,null);
      if(!bytesRead)break;bytes+=bytesRead;
      if(bytes>budget)throw Object.assign(Error('Usage file exceeds read budget'),{code:'USAGE_READ_BUDGET'});
      chunks.push(chunk.subarray(0,bytesRead));
    }
    return Buffer.concat(chunks,bytes).toString('utf8');
  }finally{await handle.close();}
}
export function dateKey(time,zone='Asia/Shanghai'){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(time);
  const get=key=>parts.find(p=>p.type===key).value;return `${get('year')}-${get('month')}-${get('day')}`;
}
export function usageRecords(raw,conversationId,{maxRows=Infinity,maxBytes=Infinity}={}){
  const trajectory=raw?.trajectory||{},rows=new Map(),steps=trajectory.steps||[];let bytes=0;
  for(const [index,g] of (trajectory.generatorMetadata||[]).entries()){
    const chat=g.chatModel,u=chat?.usage;if(!u)continue;
    const output=tokenCount(u.outputTokens),cache=requestCacheMetrics(u);
    const uncached=cache?.uncachedTokens??tokenCount(u.inputTokens);
    const read=tokenCount(u.cacheReadTokens)??(u.cacheReadTokens===undefined?0:null);
    const write=tokenCount(u.cacheWriteTokens)??(u.cacheWriteTokens===undefined?0:null);
    // Empty failed-attempt records have no reported consumption.
    if([uncached,read,write,output].every(n=>n===null||n===0))continue;
    const planners=(g.stepIndices||[]).map(i=>Number.isInteger(i)&&i>=0?steps[i]:null).filter(s=>/PLANNER_RESPONSE/.test(String(s?.type||'')));
    const times=planners.map(s=>stamp(s.metadata?.createdAt)).filter(t=>t!==null);
    const at=stamp(chat.chatStartMetadata?.createdAt)??(times.length?Math.min(...times):null);
    const identity=u.responseId?`response:${u.apiProvider||''}:${u.responseId}`:u.messageId?`message:${u.apiProvider||''}:${u.messageId}`:
      `fallback:${conversationId}:${JSON.stringify(g.stepIndices||[index])}:${at??'undated'}`;
    const row={id:hash(identity),at,model:cleanModel(chat.modelDisplayName||chat.responseModel||u.model||chat.model),
      uncached,cacheRead:read,cacheWrite:write,output,partial:uncached===null||read===null||write===null||output===null||!cache&&uncached>0,
      timeBasis:stamp(chat.chatStartMetadata?.createdAt)!==null?'request-start':at!==null?'planner-created':'unknown'};
    const old=rows.get(row.id);
    if(!old||sum(row)>sum(old)){
      if(maxRows!==Infinity||maxBytes!==Infinity){
        const next=bytes+projectedBytes(row)-(old?projectedBytes(old):0);
        if(!old&&rows.size>=maxRows||next>maxBytes){const result=[...rows.values()];Object.defineProperty(result,'overflow',{value:true});return result;}
        bytes=next;
      }
      rows.set(row.id,row);
    }
  }
  return [...rows.values()];
}
const validRow=r=>r&&HASH.test(r.id)&&typeof r.model==='string'&&r.model.length<=120&&
  (r.at===null||Number.isSafeInteger(r.at)&&r.at>=0)&&keys.every(k=>r[k]===null||Number.isSafeInteger(r[k])&&r[k]>=0);
export class UsageLedger{
  constructor(directory=join(platformPaths().data,'usage-v1'),{timeZone='Asia/Shanghai',source='desktop-local'}={}){this.directory=directory;this.timeZone=timeZone;this.source=source;this.quotaEstimator=new QuotaEstimator(directory);}
  _gate=Promise.resolve();_barrier=Promise.resolve();_writes=new Set();_files=new Map();usageWrites=new Map();revision=0;_cache=null;caches=new Map();diskSummaryPending=null;_diskSummaryRetry=null;diskSummaryRetries=new Map();jsonSummaryPending=new Map();_dirtySources=new Set();_indexQueue=Promise.resolve();
  markSourceDirty(scope,filePath){if(scope&&filePath)this._dirtySources.add(`${scope}/${basename(filePath)}`);}
  get cache(){return this._cache;}
  set cache(value){this._cache=value;if(!value)this.caches.clear();else if(value.key)this.caches.set(value.key,value);}
  get diskSummaryRetry(){return this._diskSummaryRetry;}
  set diskSummaryRetry(value){this._diskSummaryRetry=value;if(!value)this.diskSummaryRetries.clear();else if(value.key)this.diskSummaryRetries.set(value.key,value);}
  beginUsageWrite(scope){this.usageWrites.set(scope,(this.usageWrites.get(scope)||0)+1);}
  endUsageWrite(scope){const n=(this.usageWrites.get(scope)||0)-1;if(n>0)this.usageWrites.set(scope,n);else this.usageWrites.delete(scope);}
  // Public queue remains a snapshot barrier for all outstanding writes. Its
  // setter also preserves the legacy test/caller ability to suspend new work.
  get queue(){return this._barrier;}
  set queue(value){this._gate=Promise.resolve(value);this._barrier=Promise.allSettled([this._gate,...this._writes]).then(()=>{});}
  enqueue(file,operation){
    // Fail explicitly instead of retaining an unbounded number of projected
    // requests while a disk is slow. Callers can retry on a later refresh.
    if(this._writes.size>=32)return Promise.reject(Error('Usage write queue is full'));
    const previous=this._files.get(file),gate=this._gate;
    const pending=Promise.all([gate.catch(()=>{}),previous?.catch(()=>{})]).then(operation);
    const tracked=pending.finally(()=>{this._writes.delete(tracked);if(this._files.get(file)===tracked)this._files.delete(file);});
    this._writes.add(tracked);this._files.set(file,tracked);
    this._barrier=Promise.allSettled([gate,...this._writes]).then(()=>{});
    return tracked;
  }
  async backfillState(scope,host,{preferred=[]}={}){
    if(!HASH.test(scope)||!['app','ide'].includes(host))throw Error('Invalid backfill scope');
    await this.queue.catch(()=>{});
    try{
      const content=await readBounded(join(this.directory,scope,'backfill-v1.json'),BACKFILL_BYTES);
      const value=JSON.parse(content);
      if(value.schema!==1||value.account!==scope||value.host!==host||!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries))return checkpointState({},true,'invalid');
      return boundedCheckpoints(value.entries,preferred,true);
    }catch(e){if(e.code==='ENOENT')return checkpointState();if(e.code==='USAGE_READ_BUDGET')return checkpointState({},true,'oversized');if(e instanceof SyntaxError)return checkpointState({},true,'invalid');throw e;}
  }
  saveBackfillState(scope,host,entries,{preferred=[],isCurrent=()=>true}={}){
    if(!HASH.test(scope)||!['app','ide'].includes(host))throw Error('Invalid backfill scope');
    const file=join(this.directory,scope,'backfill-v1.json');
    return this.enqueue(file,async()=>{
      if(isCurrent()!==true)return;
      const bounded=boundedCheckpoints(entries,preferred),content=JSON.stringify({schema:1,account:scope,host,entries:bounded});
      if(Buffer.byteLength(content)>BACKFILL_BYTES)throw Error('Checkpoint exceeds write budget');
      await mkdir(join(this.directory,scope),{recursive:true});if(isCurrent()!==true)return;const temp=file+'.'+randomUUID()+'.tmp';
      try{
        await this.writeRecord(temp,content);if(isCurrent()!==true)return;
        let previous;try{previous=await stat(file);}catch(e){if(e.code!=='ENOENT')throw e;}
        if(isCurrent()!==true)return;
        if(previous?.size>BACKFILL_BYTES){
          // Keep oversized legacy metadata recoverable without reading/copying
          // it into memory. New checkpoints are bounded, so this happens once.
          await rename(file,join(this.directory,scope,`backfill-v1.oversized-${randomUUID()}.json`));
          if(isCurrent()!==true)return;
        }
        await rename(temp,file);return bounded;
      }finally{await unlink(temp).catch(()=>{});}
    }).catch(error=>{if(isCurrent()===true)throw error;});
  }
  async writeRecord(file,content){await writeFile(file,content,{mode:0o600});}
  async readSummaryRecord(file){return readBounded(file,16*1024*1024);}
  file(scope,id){if(!HASH.test(scope)||!GUID.test(id))throw Error('Invalid usage scope');return join(this.directory,scope,hash(id.toLowerCase())+'.json');}
  ingest(scope,id,raw,options={}){
    // Enter the per-conversation queue before the first asynchronous stat.
    // Otherwise a later disk import could overtake this older observation.
    return this.ingestMemory(scope,id,raw,options);
  }
  ingestMemory(scope,id,raw,{isCurrent=()=>true}={}){
    if(!scope)return Promise.resolve();
    return this.ingestRows(scope,id,usageRecords(raw,id),{isCurrent});
  }
  ingestRows(scope,id,rows,{isCurrent=()=>true}={}){
    if(!scope)return Promise.resolve();
    const file=this.file(scope,id);this.beginUsageWrite(scope);
    return this.enqueue(file,async()=>{
      if(isCurrent()!==true)return;
      if(await this.diskExists(scope,id)){
        this.diskWrites=(this.diskWrites||0)+1;
        try{return await this.mergeDisk(scope,id,{records:rows},{isCurrent});}finally{this.diskWrites--;}
      }
      let previous;try{previous=JSON.parse(await readBounded(file,16*1024*1024));}catch(e){if(isCurrent()!==true)return;if(e.code!=='ENOENT')throw Error('Usage ledger cannot be read');}
      if(isCurrent()!==true)return;
      if(previous&&(previous.schema!==1||previous.account!==scope||!Array.isArray(previous.records)||!previous.records.every(validRow)))throw Error('Invalid usage ledger');
      const merged=new Map((previous?.records||[]).map(r=>[r.id,r]));
      for(const row of rows)merged.set(row.id,mergeUsageRow(row,merged.get(row.id)));
      const records=[...merged.values()].sort((a,b)=>a.id.localeCompare(b.id));
      if(previous&&JSON.stringify(previous.records)===JSON.stringify(records))return;
      await mkdir(join(this.directory,scope),{recursive:true});if(isCurrent()!==true)return;const temp=file+'.'+randomUUID()+'.tmp';
      try{await this.writeRecord(temp,JSON.stringify({schema:1,account:scope,records}));if(isCurrent()!==true)return;await rename(temp,file);}
      finally{await unlink(temp).catch(()=>{});}
      // Keep the last same-account/day result as a visibly stale fallback
      // while a potentially expensive disk-backed summary is rebuilt.
      this.markSourceDirty(scope,file);
      this.revision++;
    }).catch(error=>{if(isCurrent()===true)throw error;}).finally(()=>this.endUsageWrite(scope));
  }
  async diskExists(scope,id){try{return (await stat(this.file(scope,id).replace(/\.json$/,'.sqlite'))).isFile();}catch(e){if(e.code==='ENOENT')return false;throw e;}}
  diskJob(input,options={}){this.diskPending=(this.diskPending||0)+1;const pending=(this.diskQueue||Promise.resolve()).catch(()=>{}).then(()=>this.runDiskJob(input,options));this.diskQueue=pending;return pending.finally(()=>{this.diskPending--;});}
  runDiskJob(input,{isCurrent=()=>true}={}){
    const cancel=new SharedArrayBuffer(4),flag=new Int32Array(cancel);
    return new Promise((resolve,reject)=>{
      if(isCurrent()!==true){resolve(null);return;}
      const worker=new Worker(new URL('./usage-disk-worker.mjs',import.meta.url),{workerData:{...input,cancel},resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:8}});
      let result=null,settled=false,workerError=null;
      const timer=setInterval(()=>{if(isCurrent()!==true){Atomics.store(flag,0,1);void worker.terminate();}},100);timer.unref();
      const done=(error,value)=>{if(settled)return;settled=true;clearInterval(timer);error?reject(error):resolve(value);};
      worker.on('message',value=>{result=value;});worker.on('error',error=>{workerError=error;});
      worker.on('exit',code=>{if(isCurrent()!==true)done(null,null);else if(code===0&&result?.ok)done(null,result.result);else done(workerError||Error('Usage disk processing failed'));});
    });
  }
  ingestDisk(scope,id,jobDb,options={}){return this.ingestDiskRows(scope,id,{jobDb},options);}
  async mergeDisk(scope,id,input,{isCurrent=()=>true}={}){
    const file=this.file(scope,id).replace(/\.json$/,'.sqlite');
      if(isCurrent()!==true)return;
      await mkdir(join(this.directory,scope),{recursive:true});
      let previous=null;for(const candidate of [file,this.file(scope,id)]){try{await stat(candidate);previous=candidate;break;}catch(e){if(e.code!=='ENOENT')throw e;}}
      // Repeated settled-conversation polls often produce the same bounded row
      // set. Remember a verified signature for each recently touched SQLite
      // ledger so those polls neither start workers nor reread large databases.
      // File identity is rechecked to avoid trusting external edits/deletion.
      let signature=null;
      if(previous===file&&Array.isArray(input.records)){
        const digest=createHash('sha256');for(const row of input.records)digest.update(JSON.stringify(row)+'\n');signature=digest.digest('hex');
        const cached=this.diskSignatures?.get(file),info=await lstat(file);
        if(info.isSymbolicLink()||!info.isFile())throw Error('Linked usage source rejected');
        if(cached&&cached.signature===signature&&cached.size===info.size&&cached.mtimeMs===info.mtimeMs&&cached.ctimeMs===info.ctimeMs&&cached.ino===info.ino){
          if(isCurrent()!==true)return;return {changed:false,skipped:true};
        }
      }
      const staging=file+'.'+randomUUID()+'.tmp';
      try{
        const result=await this.diskJob({action:'merge',scope,previous,staging,...input},{isCurrent});if(!result||isCurrent()!==true)return;
        if(result.changed!==false){await rename(staging,file);this.markSourceDirty(scope,file);this.revision++;}
        this.diskSignatures??=new Map();this.diskSignatures.delete(file);
        if(signature){const info=await lstat(file);if(!info.isSymbolicLink()&&info.isFile())this.diskSignatures.set(file,{signature,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,ino:info.ino});}
        while(this.diskSignatures.size>128)this.diskSignatures.delete(this.diskSignatures.keys().next().value);
        return result;
      }finally{for(const suffix of ['', '-journal'])await unlink(staging+suffix).catch(()=>{});}
  }
  ingestDiskRows(scope,id,input,options={}){
    if(!scope)return Promise.resolve();const file=this.file(scope,id);this.diskWrites=(this.diskWrites||0)+1;this.beginUsageWrite(scope);
    // The logical JSON path is shared with ingestMemory for the same account
    // and conversation, so migration and ordinary writes cannot race. The
    // diskQueue independently limits expensive workers to one at a time.
    return this.enqueue(file,()=>this.mergeDisk(scope,id,input,options)).finally(()=>{this.diskWrites--;this.endUsageWrite(scope);});
  }
  storeSummaryCache(cacheKey,entry){
    const tag=entry?.tag;
    if(tag){
      for(const [k,existing]of this.caches){
        if(k!==cacheKey&&existing?.tag===tag)this.caches.delete(k);
      }
    }
    this._cache=entry;
    this.caches.set(cacheKey,entry);
  }
  findFallbackSummaryCache(tag){
    let best=null;
    for(const entry of this.caches.values()){
      if(entry?.tag!==tag)continue;
      if(!best||(entry.revision>best.revision)||(entry.revision===best.revision&&(entry.at||0)>(best.at||0)))best=entry;
    }
    return best;
  }
  startDiskSummary(scope,now,scanRevision,cacheKey,isCurrent,options={}){
    const retry=this.diskSummaryRetries.get(cacheKey);
    if(this.diskSummaryPending||retry&&retry.at>Date.now())return;
    const staging=scope==='all'?join(this.directory,'.summary-all-'+randomUUID()+'.tmp'):join(this.directory,scope,'.summary-'+randomUUID()+'.tmp');
    const dirtyFiles=options.dirtyFiles?.length?options.dirtyFiles:null;
    const revisionRetryMs=Number.isFinite(options.revisionRetryMs)&&options.revisionRetryMs>=0?options.revisionRetryMs:30000;
    this.diskSummaryPending=this.diskJob({action:'summary',scope,rootDirectory:this.directory,directory:scope==='all'?this.directory:join(this.directory,scope),buckets:options.buckets||null,quotaAccount:options.quotaAccount||null,quotaGroups:options.groupInfos||null,quotaWindowSpecs:options.specs||null,dirtyFiles,localScope:LOCAL_SCOPE,staging,now,timeZone:this.timeZone,source:this.source},{isCurrent}).then(raw=>{
      if(!raw||isCurrent()!==true)return null;this.diskSummaryError=false;
      if(dirtyFiles&&this.revision===scanRevision){for(const k of dirtyFiles)this._dirtySources.delete(k);}
      const {quotaWindowCounts,...value}=raw;
      if(quotaWindowCounts)Object.defineProperty(value,'_quotaWindowCounts',{value:quotaWindowCounts,enumerable:false,configurable:true});
      if(options.specs?.length)Object.defineProperty(value,'_quotaWindowMeta',{value:quotaWindowMeta(options.specs),enumerable:false,configurable:true});
      const entry={key:cacheKey,tag:options.cacheTag||null,revision:scanRevision,at:now,value};
      if(this.revision===scanRevision){this.storeSummaryCache(cacheKey,entry);this._diskSummaryRetry=null;this.diskSummaryRetries.delete(cacheKey);}
      else {
        const existing=this.caches.get(cacheKey);
        if(!existing||existing.revision<=scanRevision){this.storeSummaryCache(cacheKey,entry);}
        const retryEntry={key:cacheKey,at:Date.now()+revisionRetryMs};
        this._diskSummaryRetry=retryEntry;this.diskSummaryRetries.set(cacheKey,retryEntry);
      }
      return value;
    }).catch(()=>{if(isCurrent()===true){this.diskSummaryError=true;const retryEntry={key:cacheKey,at:Date.now()+30000};this._diskSummaryRetry=retryEntry;this.diskSummaryRetries.set(cacheKey,retryEntry);}return null;}).finally(async()=>{for(const suffix of ['', '-journal'])await unlink(staging+suffix).catch(()=>{});this.diskSummaryPending=null;});
  }
  async listAccountBuckets(){
    let names=[];try{names=await readdir(this.directory);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    const buckets=[];
    for(const name of names){
      if(!HASH.test(name))continue;
      try{const info=await lstat(join(this.directory,name));if(info.isSymbolicLink()||!info.isDirectory())continue;buckets.push(name);}catch{}
    }
    return buckets;
  }
  async countAccounts(){
    const buckets=await this.listAccountBuckets();let count=0;
    for(const b of buckets){
      if(b===LOCAL_SCOPE)continue;
      try{const files=await readdir(join(this.directory,b));if(files.some(n=>/^[a-f0-9]{64}\.(json|sqlite)$/.test(n)))count++;}catch{}
    }
    return count;
  }
  async filterForeignOwnedRows(scope,rows,{isCurrent=()=>true}={}){
    if(!scope||scope===LOCAL_SCOPE||!Array.isArray(rows)||!rows.length)return rows||[];
    let names=[];
    try{names=await readdir(this.directory);}catch(e){if(e.code==='ENOENT')return rows;throw e;}
    if(isCurrent()!==true)return [];
    if(!names.some(n=>HASH.test(n)&&n!==scope&&n!==LOCAL_SCOPE))return rows;
    if(this.diskSummaryPending){
      await this.diskSummaryPending.catch(()=>{});
      if(isCurrent()!==true)return [];
    }
    const dirtySnapshot=this._dirtySources.size?new Set(this._dirtySources):null;
    const run=()=>findForeignRequestIds({
      directory:this.directory,
      scope,
      localScope:LOCAL_SCOPE,
      requestIds:rows.map(r=>r.id),
      timeZone:this.timeZone,
      readRecord:file=>this.readSummaryRecord(file),
      dirtyFiles:dirtySnapshot,
      yieldEveryMs:8,
      busyTimeoutMs:250,
    });
    const next=this._indexQueue.catch(()=>{}).then(run);
    this._indexQueue=next.catch(()=>{});
    const foreign=await next;
    if(isCurrent()!==true)return [];
    return foreign.size?rows.filter(r=>!foreign.has(r.id)):rows;
  }
  async summary(scope,now=Date.now(),{isCurrent=()=>true,groups=null,quotaAccount=null,preferCachedMaxAgeMs=0,maxWaitMs=0}={}){
    const allBuckets=scope==='all';
    if(!scope||(!allBuckets&&!HASH.test(scope)))return null;
    const {specs,groupInfos}=quotaAccount&&Array.isArray(groups)&&groups.length?buildQuotaWindowSpecs(groups):{specs:[],groupInfos:[]};
    if(specs.length&&this.quotaEstimator&&!this.quotaEstimator.loaded)await this.quotaEstimator.load();
    const winSig=specs.length?'|'+quotaAccount+'|'+specs.map(s=>`${s.id}@${s.idle?'idle':s.resetMinute}`).join(','):'';
    const today=dateKey(now,this.timeZone),cacheKey=scope+':'+today+winSig;
    const cacheTag=scope+':'+today+'|'+(quotaAccount||'');
    const finalize=(rawValue,checkMeta=false,allowUpdate=true)=>{
      if(!specs.length)return rawValue;
      return {...rawValue,quotaWindows:finalizeQuotaWindows(specs,rawValue._quotaWindowCounts||{},checkMeta?rawValue._quotaWindowMeta||null:null,{estimator:this.quotaEstimator,accountKey:quotaAccount,allowUpdate,days:rawValue.days,today:rawValue.today||today})};
    };
    const cached=this.caches.get(cacheKey);
    const fallbackCached=cached||this.findFallbackSummaryCache(cacheTag);
    const unknown=()=>({accountKey:allBuckets?'all-local':scope,timeZone:this.timeZone,today,days:[],models:[],todayTokens:null,weekTokens:null,monthTokens:null,totalTokens:null,requests:null,unreadableFiles:0,source:this.source,summaryStale:true,...(allBuckets?{accountsCount:0}:{}),...(specs.length?{quotaWindows:{}}:{}),});
    const writing=allBuckets?this.usageWrites.size>0:Boolean(this.usageWrites.get(scope));
    if(writing)return fallbackCached?{...finalize(fallbackCached.value,!cached,false),summaryStale:true}:unknown();
    if(cached&&cached.revision===this.revision)return finalize(cached.value,false,true);
    if(preferCachedMaxAgeMs>0&&cached&&Number.isFinite(cached.at)&&now>=cached.at&&now-cached.at<preferCachedMaxAgeMs){
      return {...finalize(cached.value,false,false),summaryStale:true};
    }
    const scanRevision=this.revision;
    const bucketNames=allBuckets?await this.listAccountBuckets():[scope];
    if(!isCurrent())return null;
    const bucketEntries=[];let hasSqlite=false;
    for(const b of bucketNames){
      let files=[];try{files=await readdir(join(this.directory,b));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(files.some(name=>/^[a-f0-9]{64}\.sqlite$/.test(name)))hasSqlite=true;
      bucketEntries.push({dir:b,files});
    }
    if(hasSqlite){
      this.startDiskSummary(scope,now,scanRevision,cacheKey,isCurrent,{buckets:allBuckets?bucketNames:null,quotaAccount,groupInfos,specs,cacheTag});
      return fallbackCached?{...finalize(fallbackCached.value,!cached,false),summaryStale:true}:unknown();
    }
    // Never open the shared SQLite index on the main thread while a worker is
    // already updating it, and offload multi-file (>16) foreground polls to the
    // disk worker even when the SQLite index already exists so synchronous
    // DatabaseSync calls cannot freeze the event loop past maxWaitMs.
    if(maxWaitMs>0&&this.diskSummaryPending){
      return fallbackCached?{...finalize(fallbackCached.value,!cached,false),summaryStale:true}:unknown();
    }
    if(maxWaitMs>0&&this.readSummaryRecord===UsageLedger.prototype.readSummaryRecord){
      let totalFiles=0;
      for(const entry of bucketEntries){
        for(const name of entry.files)if(/^[a-f0-9]{64}\.json$/.test(name))totalFiles++;
      }
      if(totalFiles>16){
        if(!isCurrent())return null;
        const dirtySnapshot=this._dirtySources.size?[...this._dirtySources]:null;
        this.startDiskSummary(scope,now,scanRevision,cacheKey,isCurrent,{buckets:allBuckets?bucketNames:null,quotaAccount,groupInfos,specs,cacheTag,dirtyFiles:dirtySnapshot,revisionRetryMs:2000});
        const pending=this.diskSummaryPending;
        if(pending){
          let timer;
          try{
            const raced=await Promise.race([
              pending.then(v=>({done:true,value:v})),
              new Promise(resolve=>{timer=setTimeout(()=>resolve({done:false}),maxWaitMs);timer.unref?.();}),
            ]);
            if(raced.done&&raced.value){
              if(!isCurrent())return null;
              const stillWriting=allBuckets?this.usageWrites.size>0:Boolean(this.usageWrites.get(scope));
              if(this.revision===scanRevision&&!stillWriting)return finalize(raced.value,false,true);
              return {...finalize(raced.value,false,false),summaryStale:true};
            }
          }finally{
            clearTimeout(timer);
          }
          if(!isCurrent())return null;
        }
        return fallbackCached?{...finalize(fallbackCached.value,!cached,false),summaryStale:true}:unknown();
      }
    }
    const pendingKey=cacheKey+'@'+scanRevision;
    let scan=this.jsonSummaryPending.get(pendingKey);
    if(!scan){
      scan=(async()=>{
        const dirtySnapshot=this._dirtySources.size?new Set(this._dirtySources):null;
        const runIndex=()=>syncAndSummarizeIndex({
          directory:this.directory,
          scope,
          buckets:bucketEntries,
          now,
          timeZone:this.timeZone,
          source:this.source,
          localScope:LOCAL_SCOPE,
          quotaAccount,
          quotaGroups:groupInfos,
          quotaWindowSpecs:specs,
          classifyQuotaGroupId,
          readRecord:file=>this.readSummaryRecord(file),
          dirtyFiles:dirtySnapshot,
          yieldEveryMs:8,
          busyTimeoutMs:250,
        });
        const next=this._indexQueue.catch(()=>{}).then(runIndex);
        this._indexQueue=next.catch(()=>{});
        const raw=await next;
        if(dirtySnapshot&&this.revision===scanRevision){
          for(const k of dirtySnapshot)this._dirtySources.delete(k);
        }
        const {quotaWindowCounts,...value}=raw;
        if(specs.length){
          Object.defineProperty(value,'_quotaWindowCounts',{value:quotaWindowCounts||{},enumerable:false,configurable:true});
          Object.defineProperty(value,'_quotaWindowMeta',{value:quotaWindowMeta(specs),enumerable:false,configurable:true});
        }
        const stillWriting=allBuckets?this.usageWrites.size>0:Boolean(this.usageWrites.get(scope));
        if(this.revision===scanRevision&&!stillWriting){
          this.storeSummaryCache(cacheKey,{key:cacheKey,tag:cacheTag,revision:scanRevision,at:now,value});
        }
        return value;
      })().finally(()=>{if(this.jsonSummaryPending.get(pendingKey)===scan)this.jsonSummaryPending.delete(pendingKey);});
      this.jsonSummaryPending.set(pendingKey,scan);
    }
    let value;
    if(maxWaitMs>0){
      let timer;
      try{
        const raced=await Promise.race([
          scan.then(v=>({done:true,value:v})),
          new Promise(resolve=>{timer=setTimeout(()=>resolve({done:false}),maxWaitMs);timer.unref?.();}),
        ]);
        if(!raced.done){
          scan.catch(()=>{});
          if(!isCurrent())return null;
          return fallbackCached?{...finalize(fallbackCached.value,!cached,false),summaryStale:true}:unknown();
        }
        value=raced.value;
      }catch{
        if(!isCurrent())return null;
        return fallbackCached?{...finalize(fallbackCached.value,!cached,false),summaryStale:true}:unknown();
      }finally{
        clearTimeout(timer);
      }
    }else{
      value=await scan;
    }
    if(!isCurrent())return null;
    const stillWriting=allBuckets?this.usageWrites.size>0:Boolean(this.usageWrites.get(scope));
    if(this.revision===scanRevision&&!stillWriting){const entry={key:cacheKey,tag:cacheTag,revision:scanRevision,at:now,value};this.storeSummaryCache(cacheKey,entry);return finalize(value,false,true);}
    return {...finalize(value,false,false),summaryStale:true};
  }
}
export function weekStart(date){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);}

export class DesktopUsage{
  constructor(store,ledger=new UsageLedger(),{host=null,discoverLocal=null,owns=()=>true,now=Date.now,sliceMs=1500,continueDelay=1200,itemDelay=undefined,
    maxCandidates=20,maxCandidatesPerSlice=8,maxPassMs=15000,maxMapEntries=4096,localScanMs=30000,memorySoftLimitBytes=128*1024*1024,
    liveMaxConversations=16,liveMaxRows=8192,liveMaxBytes=4*1024*1024,liveMaxGroups=128,liveMaxRecoveryGuards=16,liveMaxRecoveries=256,liveRetryMs=1000,livePollMs=1000,liveRecoveryPollMs=1000,liveBackgroundPollMs=1000,liveBackgroundRetryMs=60000}={}){
    this.store=store;this.ledger=ledger;this.fingerprints=new Map();this.host=host;this.owns=()=>owns()===true;this.now=now;
    this.discoverLocal=discoverLocal||(()=>host?discoverLocalConversations({host}):Promise.resolve({conversations:[],errors:0}));
    this.customDiscover=Boolean(discoverLocal);this.localScanMs=localScanMs;this.localScanAt=-Infinity;this.localScanResult=null;this.memorySoftLimitBytes=memorySoftLimitBytes;
    this.sliceMs=sliceMs;this.continueDelay=continueDelay;this.itemDelay=Number.isFinite(itemDelay)&&itemDelay>=0?itemDelay:(continueDelay>=100?80:0);this.maxCandidates=maxCandidates;this.maxCandidatesPerSlice=maxCandidatesPerSlice;
    this.maxPassMs=maxPassMs;this.maxMapEntries=maxMapEntries;this.fullRemaining=new Map();this.fullJournal=null;this.fullMissing=0;this.passSeen=new Set();this.passFailures=new Set();this.readFailures=new Map();this.delegatedCandidates=new Map();
    this.liveMaxConversations=liveMaxConversations;this.liveMaxRows=liveMaxRows;this.liveMaxBytes=liveMaxBytes;this.liveMaxGroups=liveMaxGroups;this.liveMaxRecoveryGuards=liveMaxRecoveryGuards;this.liveMaxRecoveries=liveMaxRecoveries;this.liveRetryMs=liveRetryMs;this.livePollMs=livePollMs;
    this.liveRecoveryPollMs=liveRecoveryPollMs;this.liveBackgroundPollMs=liveBackgroundPollMs;this.liveBackgroundRetryMs=liveBackgroundRetryMs;
    this.liveStates=new Map();this.liveOrphans=new Set();this.liveRecoveries=new Map();this.liveRows=0;this.liveBytes=0;this.liveGroups=0;this.liveScope=null;this.liveEpoch=null;this.liveUnknownOverflow=false;this.liveMarkedError=false;
  }
  syncing=false;lastSync=0;status='waiting';missingConversations=0;confirmedMissingConversations=0;retryingConversations=0;scope=null;scopeEpoch=null;forceQueued=false;disposed=false;continuation=null;
  writeScope(){return this.store.identity||LOCAL_SCOPE;}
  rememberDelegates(scope,id,raw){
    if(scope!==this.writeScope())return [];
    if(this.delegatedScope!==scope||this.delegatedEpoch!==this.store.epoch){this.delegatedCandidates.clear();this.delegatedScope=scope;this.delegatedEpoch=this.store.epoch;}
    const children=delegatedIds(id,raw,this.store.client.reader?.summaries||{});
    for(const child of children){if(this.delegatedCandidates.size>=this.maxMapEntries)break;this.delegatedCandidates.set(child,{id:child});}
    while(this.delegatedCandidates.size>this.maxMapEntries)this.delegatedCandidates.delete(this.delegatedCandidates.keys().next().value);
    return children;
  }
  capMap(map){while(map.size>this.maxMapEntries)map.delete(map.keys().next().value);}
  async ingest(scope,id,raw){
    const epoch=this.store.epoch,current=()=>!this.disposed&&this.owns()&&scope===this.writeScope()&&epoch===this.store.epoch;
    if(!current())return;this.rememberDelegates(scope,id,raw);
    if(this.ledger.ingest===UsageLedger.prototype.ingest){
      const rows=usageRecords(raw,id);
      const ownedRows=await this.ledger.filterForeignOwnedRows(scope,rows,{isCurrent:current});
      if(!current()||!ownedRows.length)return;
      await this.ledger.ingestRows(scope,id,ownedRows,{isCurrent:current});
      return;
    }
    await this.ledger.ingest(scope,id,raw,{isCurrent:current});
  }
  // Foreground metrics do not await usage persistence: a SQLite import or
  // summary can take seconds. Only bounded numeric rows cross this boundary.
  // A conversation still has a single ordered writer and coalesces repeated
  // observations by request ID while the writer is busy.
  ingestLive(scope,id,raw,options={}){
    this.refreshLiveScope();const epoch=this.store.epoch;
    const guard=typeof options.isCurrent==='function'?options.isCurrent:()=>true,guardKey=Object.hasOwn(options,'guardKey')?options.guardKey:options.isCurrent||LIVE_UNGUARDED;
    if(this.disposed||!this.owns()||scope!==this.writeScope()||!guardActive(guard))return {deferred:true};
    try{
      this.ledger.file(scope,id);id=id.toLowerCase();this.rememberDelegates(scope,id,raw);
      const rows=usageRecords(raw,id,{maxRows:this.liveMaxRows,maxBytes:this.liveMaxBytes});if(!rows.length&&!rows.overflow)return {deferred:true};
      const key=scope+':'+id;let state=this.liveStates.get(key);
      if(!state){
        if(this.liveStates.size+this.liveOrphans.size>=this.liveMaxConversations){this.queueLiveRecovery(scope,id,epoch,guardKey,guard);return {deferred:true};}
        state=this.newLiveState(scope,id,epoch);
      }
      if(rows.overflow||this.liveOversized(rows))this.markLiveRecovery(state,guardKey,guard,true);
      else if(!this.stageLiveRows(state,rows,guardKey,guard))this.markLiveRecovery(state,guardKey,guard,false);
      this.scheduleLive(state,0);
    }catch{this.queueLiveRecovery(scope,String(id).toLowerCase(),epoch,guardKey,guard);}
    return {deferred:true};
  }
  newLiveState(scope,id,epoch){
    const key=scope+':'+id,state={key,scope,id,epoch,pending:[],batch:null,running:false,timer:null,failures:0,failed:false,failureKind:null,needsRead:false,needsDisk:false,backgroundRequested:false,backgroundCommitted:false,backgroundGeneration:0,halted:false,recovering:false,recoveryGeneration:0,recoveryGuards:new Map(),persistedForegroundVersion:null};
    state.current=()=>!this.disposed&&this.owns()&&state.scope===this.writeScope()&&state.epoch===this.store.epoch;
    this.liveStates.set(key,state);return state;
  }
  updateLiveError(){
    const error=this.liveUnknownOverflow||this.liveRecoveries.size>0||[...this.liveStates.values()].some(state=>state.failed||state.recovering);
    if(typeof this.store.setUsagePersistenceError==='function')this.store.setUsagePersistenceError('live',error);
    else if(error)this.store.usagePersistenceError=true;
    else if(this.liveMarkedError)this.store.usagePersistenceError=false;
    this.liveMarkedError=error;
  }
  releaseLiveRows(rows){for(const row of rows.values()){this.liveRows--;this.liveBytes-=projectedBytes(row);}}
  releaseLiveGroup(group){this.releaseLiveRows(group.rows);this.liveGroups--;}
  pruneLiveGroups(state){const valid=[];for(const group of state.pending){if(guardActive(group.guard))valid.push(group);else this.releaseLiveGroup(group);}state.pending=valid;}
  dropLiveState(state){
    if(state.timer)clearTimeout(state.timer);state.timer=null;
    for(const group of state.pending)this.releaseLiveGroup(group);state.pending=[];
    if(this.liveStates.get(state.key)===state)this.liveStates.delete(state.key);
    if(state.running)this.liveOrphans.add(state);
    else if(state.batch){this.releaseLiveGroup(state.batch);state.batch=null;}
  }
  refreshLiveScope(){
    const scope=this.owns()&&!this.disposed?this.writeScope():null,epoch=scope?this.store.epoch:null;
    if(scope===this.liveScope&&epoch===this.liveEpoch)return;
    for(const state of this.liveStates.values())this.dropLiveState(state);
    this.liveRecoveries.clear();this.liveUnknownOverflow=false;this.liveScope=scope;this.liveEpoch=epoch;this.updateLiveError();
  }
  stageLiveRows(state,rows,guardKey,guard,{front=false,foregroundVersion=undefined}={}){
    this.pruneLiveGroups(state);
    let group=!front&&state.pending.at(-1)?.guardKey===guardKey?state.pending.at(-1):null;
    const created=!group;if(created){if(this.liveGroups>=this.liveMaxGroups)return false;group={guardKey,guard,rows:new Map(),foregroundVersion:null};}
    const changes=new Map();let count=0,bytes=0;
    for(const row of rows){
      const old=changes.get(row.id)||group.rows.get(row.id),next=mergeUsageRow(row,old);
      if(!old)count++;bytes+=projectedBytes(next)-(old?projectedBytes(old):0);changes.set(row.id,next);
      if(this.liveRows+count>this.liveMaxRows||this.liveBytes+bytes>this.liveMaxBytes)return false;
    }
    for(const [id,row]of changes)group.rows.set(id,row);group.guard=guard;group.foregroundVersion=foregroundVersion??this.store.usageFailureVersion?.('foreground:'+state.id)??null;
    if(created){front?state.pending.unshift(group):state.pending.push(group);this.liveGroups++;}
    this.liveRows+=count;this.liveBytes+=bytes;return true;
  }
  markLiveRecovery(state,guardKey,guard,disk){
    if(!guardActive(guard))return;
    if(!state.recoveryGuards.has(guardKey)&&state.recoveryGuards.size>=this.liveMaxRecoveryGuards)this.liveUnknownOverflow=true;
    else state.recoveryGuards.set(guardKey,guard);
    state.recoveryGeneration++;state.recovering=true;
    if(disk){state.needsDisk=true;state.needsRead=false;}else if(!state.needsDisk)state.needsRead=true;
    this.updateLiveError();
  }
  liveRecoveryCurrent(state){return state.current()&&[...state.recoveryGuards.values()].some(guardActive);}
  liveOversized(rows){let bytes=0;for(const row of rows){bytes+=projectedBytes(row);if(bytes>this.liveMaxBytes)return true;}return rows.length>this.liveMaxRows;}
  pruneLiveRecoveries(){
    // A guard may close over an evicted task/session. Do not keep that object
    // alive while unrelated active writes occupy all conversation slots.
    for(const [key,item]of this.liveRecoveries){
      for(const [guardKey,guard]of item.guards)if(!guardActive(guard))item.guards.delete(guardKey);
      if(!item.guards.size)this.liveRecoveries.delete(key);
    }
  }
  queueLiveRecovery(scope,id,epoch,guardKey=LIVE_UNGUARDED,guard=()=>true){
    // Recovery remembers only bounded IDs and reads this specific conversation
    // later. It never starts an automatic all-history scan.
    this.pruneLiveRecoveries();if(!guardActive(guard)){this.updateLiveError();return;}
    if(scope!==this.writeScope()||epoch!==this.store.epoch||!GUID.test(id)||!HASH.test(scope)){this.liveUnknownOverflow=true;this.updateLiveError();return;}
    const key=scope+':'+id,state=this.liveStates.get(key);
    if(state){this.markLiveRecovery(state,guardKey,guard,false);this.scheduleLive(state,this.liveRetryMs);}
    else if(this.liveRecoveries.size<this.liveMaxRecoveries||this.liveRecoveries.has(key)){
      const item=this.liveRecoveries.get(key)||{scope,id,epoch,guards:new Map()};
      if(item.guards.has(guardKey)||item.guards.size<this.liveMaxRecoveryGuards)item.guards.set(guardKey,guard);else this.liveUnknownOverflow=true;
      this.liveRecoveries.set(key,item);
    }else this.liveUnknownOverflow=true;
    this.updateLiveError();this.scheduleLiveRecoveries();
  }
  scheduleLiveRecoveries(){
    if(this.liveRecoveryTimer||!this.liveRecoveries.size||this.disposed)return;
    this.liveRecoveryTimer=setTimeout(()=>{this.liveRecoveryTimer=null;this.refreshLiveScope();this.pruneLiveRecoveries();
      while(this.liveRecoveries.size&&this.liveStates.size+this.liveOrphans.size<this.liveMaxConversations){
        const [key,item]=this.liveRecoveries.entries().next().value;this.liveRecoveries.delete(key);
        if(item.scope!==this.writeScope()||item.epoch!==this.store.epoch||!this.owns())continue;
        const guards=[...item.guards].filter(([,guard])=>guardActive(guard));if(!guards.length)continue;
        const state=this.newLiveState(item.scope,item.id,item.epoch);for(const [guardKey,guard]of guards)this.markLiveRecovery(state,guardKey,guard,false);this.scheduleLive(state,0);
      }
      this.updateLiveError();this.scheduleLiveRecoveries();
    },this.liveRecoveryPollMs);this.liveRecoveryTimer.unref?.();
  }
  scheduleLive(state,delay){
    if(state.timer||state.running||!state.current())return;
    state.timer=setTimeout(()=>{state.timer=null;void this.runLive(state);},delay);state.timer.unref?.();
  }
  async runLive(state){
    if(!state.current()){this.dropLiveState(state);this.updateLiveError();return;}
    this.pruneLiveGroups(state);
    if(state.recovering&&!this.liveRecoveryCurrent(state)){
      state.needsRead=false;state.needsDisk=false;state.recovering=false;state.recoveryGuards.clear();state.backgroundRequested=false;state.backgroundCommitted=false;state.halted=false;if(state.failureKind!=='write'){state.failed=false;state.failureKind=null;}
    }
    if(state.backgroundRequested&&state.needsDisk){this.runLiveBackground(state);return;}
    if(state.batch&&!guardActive(state.batch.guard)){this.releaseLiveGroup(state.batch);state.batch=null;if(state.failureKind==='write'){state.failed=false;state.failureKind=null;state.failures=0;}}
    if(!state.batch&&state.pending.length)state.batch=state.pending.shift();
    if(!state.batch&&!state.needsRead&&!state.needsDisk){
      state.recovering=false;state.recoveryGuards.clear();
      if(state.persistedForegroundVersion!==null&&this.store.usageFailureVersion?.('foreground:'+state.id)===state.persistedForegroundVersion)this.store.setUsagePersistenceError?.('foreground:'+state.id,false);
      this.dropLiveState(state);this.updateLiveError();this.scheduleLiveRecoveries();return;
    }
    if(!state.batch&&state.halted)return;
    if(!state.batch&&state.needsDisk){this.runLiveBackground(state);return;}
    // Keep the active live batch coalescible and cancellable while an unrelated
    // expensive disk task is already running; do not queue another full worker.
    if(this.ledger.diskPending){this.scheduleLive(state,this.livePollMs);return;}
    state.running=true;let failed=false;
    try{
      if(state.batch){
        const batch=state.batch,current=()=>state.current()&&guardActive(batch.guard);
        const ownedRows=await this.ledger.filterForeignOwnedRows(state.scope,[...batch.rows.values()],{isCurrent:current});
        if(!state.current())return;
        if(ownedRows.length)await this.ledger.ingestRows(state.scope,state.id,ownedRows,{isCurrent:current});
        if(!state.current())return;
        this.releaseLiveGroup(batch);state.batch=null;if(state.failureKind==='write'){state.failed=false;state.failureKind=null;state.failures=0;}if(current())state.persistedForegroundVersion=batch.foregroundVersion;
      }else{
        const generation=state.recoveryGeneration,version=this.store.usageFailureVersion?.('foreground:'+state.id)??null,current=()=>this.liveRecoveryCurrent(state);
        const raw=await this.store.client.trajectory(state.id,{force:true,isCurrent:current});
        if(!current())return;
        if(generation!==state.recoveryGeneration)return;
        if(!raw?.trajectory||!Array.isArray(raw.trajectory.generatorMetadata))throw Error('Live usage recovery unavailable');
        const rows=usageRecords(raw,state.id,{maxRows:this.liveMaxRows,maxBytes:this.liveMaxBytes});if(!rows.length&&!rows.overflow)throw Error('Live usage recovery unavailable');
        if(rows.overflow||this.liveOversized(rows)){state.needsRead=false;state.needsDisk=true;}
        else {if(!this.stageLiveRows(state,rows,LIVE_RECOVERY,current,{front:true,foregroundVersion:version}))throw Error('Live usage recovery exceeds budget');state.needsRead=false;if(state.failureKind==='recovery'){state.failed=false;state.failureKind=null;state.failures=0;}}
      }
    }catch(error){if(state.current()){
      const limit=!state.batch&&collectionFailure(error);
      if(limit&&limit.kind!=='field'){state.needsRead=false;state.needsDisk=true;}
      else if(limit?.kind==='field'){state.halted=true;state.failed=true;state.failureKind='recovery';}
      else {failed=true;state.failed=true;state.failureKind=state.batch?'write':'recovery';state.failures++;}
    }}
    finally{
      state.running=false;
      if(!state.current()){
        if(state.batch){this.releaseLiveGroup(state.batch);state.batch=null;}
        this.dropLiveState(state);this.liveOrphans.delete(state);
      }else{
        this.updateLiveError();
        this.scheduleLive(state,failed?Math.min(30000,this.liveRetryMs*2**Math.min(state.failures-1,5)):0);
      }
      this.scheduleLiveRecoveries();
    }
  }
  runLiveBackground(state){
    const entry=this.store.sessions?.get(state.id),background=this.store.background;
    if(!entry||!background||typeof this.store.startBackground!=='function'){
      // No bounded collector is available. Keep the incomplete status visible
      // without repeatedly re-reading the same oversized conversation.
      state.halted=true;state.failed=true;state.failureKind='recovery';this.updateLiveError();return;
    }
    const status=background.state?.(state.id);
    if(state.backgroundRequested){
      if(state.backgroundCommitted&&status?.state!=='processing'){
        state.backgroundRequested=false;state.backgroundCommitted=false;
        if(state.backgroundGeneration===state.recoveryGeneration){state.needsDisk=false;state.needsRead=false;if(state.failureKind==='recovery'){state.failed=false;state.failureKind=null;state.failures=0;}state.persistedForegroundVersion=state.backgroundForegroundVersion;this.updateLiveError();this.scheduleLive(state,0);return;}
      }else if(status?.state==='limited'){
        state.backgroundRequested=false;state.failed=true;state.failureKind='recovery';this.updateLiveError();this.scheduleLive(state,this.liveBackgroundRetryMs);return;
      }else {this.scheduleLive(state,this.liveBackgroundPollMs);return;}
    }
    state.backgroundRequested=true;state.backgroundCommitted=false;state.backgroundGeneration=state.recoveryGeneration;state.backgroundForegroundVersion=this.store.usageFailureVersion?.('foreground:'+state.id)??null;
    if(!this.store.startBackground(state.scope,state.id,entry,()=>this.liveRecoveryCurrent(state)&&this.store.sessions?.get(state.id)===entry)){
      state.backgroundRequested=false;state.failed=true;state.failureKind='recovery';this.updateLiveError();this.scheduleLive(state,this.liveBackgroundRetryMs);return;
    }
    this.scheduleLive(state,this.liveBackgroundPollMs);
  }
  async ingestDisk(scope,id,jobDb,{isCurrent=()=>true}={}){
    const epoch=this.store.epoch,current=()=>!this.disposed&&this.owns()&&scope===this.writeScope()&&epoch===this.store.epoch&&isCurrent()===true;
    if(!current())return;await this.ledger.ingestDisk(scope,id,jobDb,{isCurrent:current});
    if(!current())return;
    const state=this.liveStates.get(scope+':'+String(id).toLowerCase());
    if(state?.needsDisk&&state.backgroundRequested&&state.epoch===epoch&&this.liveRecoveryCurrent(state)){state.backgroundCommitted=true;this.scheduleLive(state,0);}
  }
  sync(forceFull=false){
    if(this.disposed||!this.owns())return Promise.resolve();
    if(forceFull)this.forceQueued=true;
    if(this.pending)return this.pending;
    if(!this.continuation){this.passSeen.clear();this.passFailures.clear();}
    clearTimeout(this.continuation);this.continuation=null;
    this.syncing=true;this.status='syncing';
    this.pending=(async()=>{
      let result;
      do{
        const force=this.forceQueued;this.forceQueued=false;
        result=await this.runSync(force);
      }while(this.forceQueued&&!this.disposed&&this.owns());
      if(!result?.current())return;
      this.lastSync=this.now();this.missingConversations=result.missing;
      this.confirmedMissingConversations=result.confirmed;this.retryingConversations=result.retrying;
      this.status=result.more?'syncing':result.missing||result.partial?'partial':'ready';
      if(result.more){this.continuation=setTimeout(()=>void this.sync(),this.continueDelay);this.continuation.unref?.();}
    })().catch(()=>{this.status='offline';this.lastSync=this.now();}).finally(()=>{this.syncing=false;this.pending=null;});return this.pending;
  }
  async runSync(forceFull){
    const scope=this.writeScope(),epoch=this.store.epoch;
    const current=()=>{
      const active=!this.disposed&&this.owns()&&scope===this.writeScope()&&epoch===this.store.epoch;
      if(!active&&this.scope===scope&&this.scopeEpoch===epoch){this.fullRemaining.clear();this.fullJournal=null;}
      return active;
    };
    if(!scope)return null;
    if(this.scope!==scope||this.scopeEpoch!==epoch){this.scope=scope;this.scopeEpoch=epoch;this.fingerprints.clear();this.fullRemaining.clear();this.fullJournal=null;this.fullMissing=0;this.passSeen.clear();this.passFailures.clear();this.readFailures.clear();this.localScanResult=null;this.localScanAt=-Infinity;}
    let missing=0,candidates,completePass=false;
    if(!forceFull&&this.fullRemaining.size){
      // A full import owns a fixed, bounded queue. Rediscovery between slices
      // could lose deleted/temporarily hidden IDs and keep the timer alive forever.
      candidates=new Map(this.fullRemaining);missing=this.fullMissing;completePass=true;
    }else{
      let listed=[],listedOk=false;
      try{listed=await this.store.listConversations(true);listedOk=true;}catch{missing++;}
      if(!current())return {current};
      let local;
      if(!this.customDiscover&&this.localScanResult&&this.now()-this.localScanAt<this.localScanMs&&!forceFull)local=this.localScanResult;
      else {local=await this.discoverLocal();if(!this.customDiscover){this.localScanResult=local;this.localScanAt=this.now();}}
      if(!current())return {current};missing+=local.errors||0;
      candidates=new Map();
      // Current conversations get priority over unloaded archives.
      for(const c of listed)if(conversationId.test(c.id)){
        if(candidates.size>=this.maxMapEntries){missing++;break;}
        candidates.set(c.id.toLowerCase(),{id:c.id.toLowerCase(),listed:c});
      }
      for(const c of local.conversations||[])if(conversationId.test(c.id)){
        const id=c.id.toLowerCase();
        if(listedOk&&c.brainOnly===true&&!candidates.has(id))continue;
        if(candidates.has(id)||candidates.size<this.maxMapEntries)candidates.set(id,{...candidates.get(id),...c,id});else missing++;
      }
      if(this.delegatedScope===scope&&this.delegatedEpoch===epoch)for(const [id,c]of this.delegatedCandidates)if(!candidates.has(id)){
        if(candidates.size>=this.maxMapEntries){missing++;break;}candidates.set(id,c);
      }
      if(forceFull||this.sliceMs===0){this.fullRemaining=new Map(candidates);this.fullMissing=missing;this.passSeen.clear();this.passFailures.clear();completePass=true;}
    }
    const reused=!forceFull&&completePass&&this.fullJournal;
    let journal=reused?this.fullJournal:this.host?await this.ledger.backfillState(scope,this.host,{preferred:[...candidates.keys()].map(hash)}):{};
    if(!reused&&journal.checkpointPartial)missing++;
    if(completePass)this.fullJournal=journal;
    const ordered=[...candidates.values()].sort((a,b)=>{
      const running=c=>/RUNNING|IN_PROGRESS/.test(String(c.listed?.status||''));
      if(running(a)!==running(b))return running(b)-running(a);
      const time=c=>Date.parse(c.listed?.modifiedAt||c.listed?.lastModifiedTime||'')||0;
      return time(b)-time(a);
    });
    const selected=completePass?ordered:ordered.slice(0,this.maxCandidates);
    const started=this.now();let processed=0,more=false,dirty=false,partial=!completePass&&ordered.length>selected.length,sliceRpc=false;
    for(const c of selected){
      if(!current())return {current};
      // Always consume one queued entry, even if the event loop was suspended
      // past the slice budget before its first read. Every continuation advances.
      if(processed&&(processed>=this.maxCandidatesPerSlice||this.now()-started>=this.maxPassMs)){more=completePass;partial=partial||completePass;break;}
      const key=hash(c.id),s=c.listed,mark=JSON.stringify([s?.stepCount,s?.modifiedAt,s?.status,s?.lastUserInputStepIndex]);
      // Recheck older imports once: they could finish without discovering
      // delegated conversations that were absent from the host's top-level list.
      const signature=hash('delegation-v1:'+c.id+':'+(c.signature||'')+mark),old=journal[key];
      const unchanged=old?.signature===signature;
      const forced=this.fullRemaining.has(c.id);
      if(!forced&&this.passSeen.has(c.id))continue;
      if(!forced&&unchanged&&old?.state==='retry'&&old.retryAt>this.now()){this.passFailures.add(c.id);continue;}
      const cached=s&&this.fingerprints.get(c.id)===mark&&!/RUNNING/.test(s.status||'');
      // A persisted checkpoint already verified both disk and host revision.
      // Restarting the collector alone must not force all settled chats to load.
      const settled=s?.modifiedAt&&/IDLE|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR/.test(String(s.status||''));
      if(!forced&&!old?.hasDelegates&&(c.signature?unchanged&&old.state==='complete'&&(!s||cached||settled):cached))continue;
      if(processed&&this.now()-started>=this.sliceMs){more=completePass;break;}
      if(processed&&this.memorySoftLimitBytes>0&&process.memoryUsage().heapUsed>=this.memorySoftLimitBytes){
        this.store.client?.reader?.trim?.();
        this.store.trimSessions?.();
        more=completePass;break;
      }
      processed++;
      this.passSeen.add(c.id);this.capMap(this.passSeen);
      this.fullRemaining.delete(c.id);
      try{
        const completed=this.store.sessions?.get(c.id),revision=JSON.stringify([s?.stepCount??null,s?.modifiedAt??s?.lastModifiedTime??null,s?.status??null,s?.lastUserInputStepIndex??null]);
        if(s&&completed?.backgroundUsageComplete===true&&completed.backgroundRevision===revision){
          const stable=!c.readSignature||await c.readSignature()===c.signature;if(!current())return {current};if(!stable)throw Error('History changed during import');
          const children=(completed.data?.delegatedConversations||[]).filter(child=>conversationId(child)&&child!==c.id);
          for(const child of children)if(!candidates.has(child)&&!this.passSeen.has(child)){
            if(candidates.size>=this.maxMapEntries||completePass&&this.passSeen.size+this.fullRemaining.size>=this.maxMapEntries){missing++;break;}
            candidates.set(child,{id:child});if(completePass)this.fullRemaining.set(child,{id:child});
          }
          this.fingerprints.set(c.id,mark);this.capMap(this.fingerprints);this.passFailures.delete(c.id);this.readFailures.delete(c.id);
          if(this.host){journal[key]={signature,state:'complete',failures:0,retryAt:0,hasDelegates:children.length>0};dirty=true;}
          await yieldToLiveRequests();continue;
        }
        // An independently discovered ID has no summary. An empty summary
        // intentionally reads steps until EOF; the shared reader still enforces
        // pagination, revision checks, memory budgets and a wall-time deadline.
        const summary=s?{stepCount:s.stepCount,lastModifiedTime:s.modifiedAt,status:s.status,lastUserInputStepIndex:s.lastUserInputStepIndex}:{};
        if(sliceRpc&&this.itemDelay>0){await new Promise(r=>{const t=setTimeout(r,this.itemDelay);t.unref?.();});if(!current())return {current};}
        sliceRpc=true;
        const raw=await this.store.client.trajectory(c.id,{summary,force:forced,isCurrent:current,usageOnly:true});
        if(!current())return {current};
        const steps=Array.isArray(raw?.trajectory?.steps)?raw.trajectory.steps:(raw?.usageOnly?[]:null);
        if(!raw?.trajectory||!steps||!Array.isArray(raw.trajectory.generatorMetadata))throw Error('Incomplete historical statistics');
        const settledEmptyDb=c.hasDb===true&&(!Number.isFinite(c.modifiedAtMs)||this.now()-c.modifiedAtMs>=60000);
        if(!s&&!steps.length&&!raw.trajectory.generatorMetadata.length&&!settledEmptyDb)throw Error('History not yet readable');
        const children=this.rememberDelegates(scope,c.id,raw);
        for(const id of children)if(!candidates.has(id)&&!this.passSeen.has(id)){
          // Match the existing local-history discovery ceiling and keep an
          // iterative map walk, so nested/shared/cyclic delegation cannot recurse.
          if(candidates.size>=this.maxMapEntries||completePass&&this.passSeen.size+this.fullRemaining.size>=this.maxMapEntries){missing++;break;}
          candidates.set(id,{id});if(completePass)this.fullRemaining.set(id,{id});
        }
        const stable=!c.readSignature||await c.readSignature()===c.signature;
        if(!current())return {current};
        if(!stable)throw Error('History changed during import');
        await this.ingest(scope,c.id,raw);if(!current())return {current};
        this.fingerprints.set(c.id,mark);this.capMap(this.fingerprints);
        this.passFailures.delete(c.id);
        this.readFailures.delete(c.id);
        if(this.host){journal[key]={signature,state:'complete',failures:0,retryAt:0,hasDelegates:children.length>0};dirty=true;}
      }catch{
        if(!current())return {current};this.passFailures.add(c.id);
        const remembered=this.readFailures.get(c.id),failures=Math.max(unchanged?old?.failures||0:0,remembered?.signature===signature?remembered.failures:0)+1;
        this.readFailures.set(c.id,{signature,failures});this.capMap(this.readFailures);this.capMap(this.passFailures);
        if(this.host){
          journal[key]={signature,state:'retry',failures,retryAt:this.now()+Math.min(30*60000,30000*2**Math.min(failures-1,6))};dirty=true;}
      }
      await yieldToLiveRequests();
    }
    // Usage records remain atomic per conversation. A crash only revalidates
    // this bounded slice; do not rewrite the whole checkpoint after every ID.
    if(dirty){
      const preferred=[...new Set([...candidates.keys(),...this.passSeen,...this.fullRemaining.keys()])].map(hash);
      const saved=await this.ledger.saveBackfillState(scope,this.host,journal,{preferred,isCurrent:current});
      if(!current())return {current};if(saved)journal=saved;if(completePass)this.fullJournal=journal;
    }
    if(completePass){this.fullMissing=missing;if(this.fullRemaining.size>0)more=true;else this.fullJournal=null;}
    const confirmed=[...this.passFailures].filter(id=>(journal[hash(id)]?.failures||this.readFailures.get(id)?.failures||0)>=2).length;
    return {current,missing:missing+this.passFailures.size,confirmed,retrying:missing+this.passFailures.size-confirmed,more,partial};
  }
  async snapshot({sync=true,scope=undefined,groups=null,maxWaitMs=0}={}){
    this.refreshLiveScope();
    const identity=this.store.identity,writeScope=this.writeScope(),epoch=this.store.epoch;
    const requestedScope=scope===undefined?(identity?'account':'local'):(scope==='account'?'account':'local');
    if(this.scope!==writeScope||this.scopeEpoch!==epoch){this.lastSync=0;this.status='waiting';this.missingConversations=0;this.confirmedMissingConversations=0;this.retryingConversations=0;if(this.pending)this.forceQueued=true;}
    if(sync&&this.now()-this.lastSync>60000&&!this.continuation)void this.sync();
    const current=()=>!this.disposed&&this.owns()&&writeScope===this.writeScope()&&epoch===this.store.epoch;
    const syncing=this.syncing||!!this.continuation||!!this.ledger.diskSummaryPending||!!this.ledger.diskWrites||this.ledger.jsonSummaryPending.size>0;
    const backfillActive=this.syncing||Boolean(this.continuation);
    if(requestedScope==='account'&&!identity){
      const today=dateKey(Date.now(),this.ledger.timeZone),accountsCount=await this.ledger.countAccounts();
      if(!current())return null;
      return {accountKey:null,activeAccountKey:null,scope:'account',accountAvailable:false,accountsCount,timeZone:this.ledger.timeZone,today,days:[],models:[],todayTokens:0,weekTokens:0,monthTokens:0,totalTokens:0,unknownTokens:0,unknownRequests:0,partialRequests:0,unreadableFiles:0,requests:0,firstDate:null,updatedAt:new Date().toISOString(),source:this.ledger.source,quotaWindows:{},syncing,status:syncing?'syncing':this.status,missingConversations:this.missingConversations,confirmedMissingConversations:this.confirmedMissingConversations,retryingConversations:this.retryingConversations,persistenceError:this.store.usagePersistenceError===true||this.ledger.diskSummaryError===true};
    }
    const ledgerTarget=requestedScope==='account'?identity:'all';
    const value=await this.ledger.summary(ledgerTarget,Date.now(),{isCurrent:current,groups:identity?groups:null,quotaAccount:identity,preferCachedMaxAgeMs:backfillActive?5000:0,maxWaitMs});if(!current())return null;
    if(scope!==undefined&&!syncing&&!value?.summaryStale&&identity&&!this.ledger.diskSummaryPending&&!this.ledger.jsonSummaryPending.size&&!this.ledger.usageWrites.size){
      const otherScope=requestedScope==='local'?identity:'all';
      const prefix=otherScope+':'+value.today;
      if(![...this.ledger.caches.keys()].some(k=>k.startsWith(prefix)))void this.ledger.summary(otherScope,Date.now(),{isCurrent:current,groups,quotaAccount:identity,maxWaitMs:350}).catch(()=>{});
    }
    const stillSyncing=syncing||value?.summaryStale===true;
    return {...value,scope:requestedScope,accountKey:requestedScope==='local'?'all-local':identity,activeAccountKey:identity||null,accountAvailable:Boolean(identity),syncing:stillSyncing,status:stillSyncing?'syncing':this.status,missingConversations:this.missingConversations,confirmedMissingConversations:this.confirmedMissingConversations,retryingConversations:this.retryingConversations,persistenceError:this.store.usagePersistenceError===true||this.ledger.diskSummaryError===true};
  }
  dispose(){this.disposed=true;this.forceQueued=false;clearTimeout(this.continuation);this.continuation=null;clearTimeout(this.liveRecoveryTimer);this.liveRecoveryTimer=null;this.refreshLiveScope();this.fullRemaining.clear();this.fullJournal=null;this.ledger?.quotaEstimator?.dispose();}
}
