import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,open,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {UsageLedger,DesktopUsage} from '../usage.mjs';
import {INDEX_FILENAME} from '../usage-index.mjs';
import {MetricsStore} from '../store.mjs';
import {TrajectoryReader} from '../trajectory-reader.mjs';

const execFileAsync=promisify(execFile);
const hash=s=>createHash('sha256').update(s).digest('hex');
const acctA=hash('scale-account-a'),acctB=hash('scale-account-b');
const cid=n=>`${String(n).padStart(8,'0')}-1111-1111-1111-111111111111`;
const makeRow=(key,{at=Date.parse('2026-10-15T06:00:00Z'),model='Gemini 3.8 Pro',uncached=100,cacheRead=400,cacheWrite=0,output=100,partial=false}={})=>({
  id:hash(key),at,model,uncached,cacheRead,cacheWrite,output,partial,timeBasis:at===null?'unknown':'request-start',
});

test('100k historical JSON records summarize and update incrementally under --max-old-space-size=128',{timeout:120000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ag-usage-scale-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,acctA),{recursive:true});
  await mkdir(join(dir,acctB),{recursive:true});

  const filesPerAcct=100,rowsPerFile=500; // 200 files * 500 rows = 100,000 records
  const totalRecords=filesPerAcct*2*rowsPerFile;
  const now=Date.parse('2026-10-30T08:00:00Z');
  const inWinAt=Date.parse('2026-10-30T06:00:00Z');
  const oldBase=Date.parse('2026-08-01T00:00:00Z');

  for(const [acctIndex,acct]of [acctA,acctB].entries()){
    for(let f=0;f<filesPerAcct;f++){
      const records=[];
      for(let r=0;r<rowsPerFile;r++){
        const idx=acctIndex*filesPerAcct*rowsPerFile+f*rowsPerFile+r;
        const isWin=acct===acctA&&f===0&&r<10;
        const at=isWin?inWinAt:oldBase+((f*rowsPerFile+r)%80)*86400000;
        records.push(makeRow(`req-${idx}`,{at,model:acctIndex===0?'Gemini 3.8 Pro':'Claude Sonnet 4.5'}));
      }
      const file=join(dir,acct,`${hash(cid(acctIndex*1000+f+1))}.json`);
      await writeFile(file,JSON.stringify({schema:1,account:acct,records}));
    }
  }

  const usageUrl=pathToFileURL(join(import.meta.dirname,'..','usage.mjs')).href;
  const script=`
    import assert from 'node:assert/strict';
    import {UsageLedger} from ${JSON.stringify(usageUrl)};
    const dir=${JSON.stringify(dir)};
    const acctA=${JSON.stringify(acctA)};
    const now=${now};
    const totalRecords=${totalRecords};
    const totalFiles=${filesPerAcct*2};
    const groups=[{id:'gemini',name:'Gemini',windows:{'5h':{available:true,remaining:0.8,resetAt:new Date(now+2*3600000).toISOString()}}}];
    const ledger=new UsageLedger(dir);
    let coldReads=0;
    const orig=ledger.readSummaryRecord.bind(ledger);
    ledger.readSummaryRecord=async f=>{coldReads++;return orig(f);};
    const coldStart=Date.now();
    const cold=await ledger.summary('all',now,{groups,quotaAccount:acctA});
    const coldMs=Date.now()-coldStart;
    const coldHeapMb=Math.round(process.memoryUsage().heapUsed/1048576);
    assert.equal(cold.requests,totalRecords);
    assert.equal(cold.totalTokens,totalRecords*600);
    assert.equal(cold.accountsCount,2);
    assert.equal(cold.unreadableFiles,0);
    assert.equal(cold.quotaWindows['gemini:5h'].observedTokens,10*600);
    assert.equal(coldReads,totalFiles);

    // Warm restart with a fresh UsageLedger must read 0 JSON files.
    const restarted=new UsageLedger(dir);
    let restartReads=0;
    const orig2=restarted.readSummaryRecord.bind(restarted);
    restarted.readSummaryRecord=async f=>{restartReads++;return orig2(f);};
    const warmStart=Date.now();
    const warm=await restarted.summary('all',now,{groups,quotaAccount:acctA});
    const warmMs=Date.now()-warmStart;
    assert.equal(restartReads,0);
    assert.equal(warm.requests,totalRecords);
    assert.equal(warm.totalTokens,totalRecords*600);

    // Incremental update of 1 conversation reads only 1 file.
    await restarted.ingest(acctA,'99999999-1111-1111-1111-111111111111',{
      trajectory:{steps:[],generatorMetadata:[{chatModel:{modelDisplayName:'Gemini 3.8 Pro',chatStartMetadata:{createdAt:'2026-10-30T07:00:00Z'},usage:{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',responseId:'inc-1',inputTokens:'100',cacheReadTokens:'400',cacheWriteTokens:'0',outputTokens:'100'}}}]}
    });
    const incStart=Date.now();
    const inc=await restarted.summary('all',now,{groups,quotaAccount:acctA});
    const incMs=Date.now()-incStart;
    const finalHeapMb=Math.round(process.memoryUsage().heapUsed/1048576);
    assert.equal(restartReads,1);
    assert.equal(inc.requests,totalRecords+1);
    assert.equal(inc.totalTokens,(totalRecords+1)*600);
    assert.equal(inc.quotaWindows['gemini:5h'].observedTokens,11*600);
    assert.ok(finalHeapMb<80,'Expected bounded V8 heap, observed '+finalHeapMb+'MB');
    console.log(JSON.stringify({coldMs,coldHeapMb,warmMs,incMs,finalHeapMb}));
  `;

  const {stdout}=await execFileAsync(process.execPath,['--max-old-space-size=128','--input-type=module','-e',script],{timeout:110000});
  const metrics=JSON.parse(stdout.trim());
  t.diagnostic(JSON.stringify(metrics));
  assert.ok(metrics.coldHeapMb<96,`Cold heap exceeded bound: ${metrics.coldHeapMb}MB`);
  assert.ok(metrics.finalHeapMb<80,`Final heap exceeded bound: ${metrics.finalHeapMb}MB`);
});

test('corrupt persistent index self-heals automatically and timezone changes rebucket cleanly',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ag-usage-heal-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ledger=new UsageLedger(dir,{timeZone:'Asia/Shanghai'});
  // 2026-10-10T17:00:00Z is 2026-10-11 in Asia/Shanghai, 2026-10-10 in UTC.
  await ledger.ingest(acctA,cid(1),{
    trajectory:{steps:[],generatorMetadata:[{chatModel:{modelDisplayName:'Gemini 4',chatStartMetadata:{createdAt:'2026-10-10T17:00:00Z'},usage:{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',responseId:'tz-1',inputTokens:'100',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'50'}}}]}
  });
  const cn=await ledger.summary(acctA,Date.parse('2026-10-10T18:00:00Z'));
  assert.equal(cn.today,'2026-10-11');
  assert.equal(cn.todayTokens,150);

  // Switch timezone on the same persistent index.
  const utcLedger=new UsageLedger(dir,{timeZone:'UTC'});
  const utc=await utcLedger.summary(acctA,Date.parse('2026-10-10T18:00:00Z'));
  assert.equal(utc.today,'2026-10-10');
  assert.equal(utc.todayTokens,150);
  assert.equal(utc.days[0].date,'2026-10-10');

  // Corrupt the index file on disk and verify transparent self-healing.
  await writeFile(join(dir,INDEX_FILENAME),'not-a-valid-sqlite-database');
  const healed=await new UsageLedger(dir,{timeZone:'Asia/Shanghai'}).summary(acctA,Date.parse('2026-10-10T18:00:00Z'));
  assert.equal(healed.totalTokens,150);
  assert.equal(healed.requests,1);
  assert.equal(healed.unreadableFiles,0);
  assert.equal(healed.days[0].date,'2026-10-11');
});

test('large >1 MiB legacy JSON streams atomically without whole-file parse and rejects corrupt tails',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ag-usage-stream-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ledger=new UsageLedger(dir);
  await mkdir(join(dir,acctA),{recursive:true});

  const validFile=ledger.file(acctA,cid(1));
  const count=5000;
  const writeBigJson=async (target,prefix,suffix,keyPrefix,modelName)=>{
    const handle=await open(target,'w');
    try{
      await handle.write(prefix);
      let chunk='';
      for(let i=0;i<count;i++){
        chunk+=(i?',':'')+JSON.stringify(makeRow(`${keyPrefix}-${i}`,{model:modelName}));
        if(chunk.length>=65536){await handle.write(chunk);chunk='';}
      }
      if(chunk)await handle.write(chunk);
      await handle.write(suffix);
    }finally{await handle.close();}
  };
  await writeBigJson(validFile,`{"schema":1,"account":"${acctA}","records":[`,']}','big','Model-'+'X'.repeat(80));
  assert.ok((await stat(validFile)).size>1024*1024);

  let directReads=0;
  const origRead=ledger.readSummaryRecord.bind(ledger);
  ledger.readSummaryRecord=async f=>{directReads++;return origRead(f);};

  const first=await ledger.summary(acctA,Date.parse('2026-10-30T08:00:00Z'));
  assert.equal(directReads,0,'Large >1 MiB JSON should stream rather than buffer via readSummaryRecord');
  assert.equal(first.requests,count);
  assert.equal(first.totalTokens,count*600);
  assert.equal(first.unreadableFiles,0);

  // Add a >1 MiB file with wrong account at the end (must roll back staging cleanly with 0 leaked rows).
  const badFile=ledger.file(acctA,cid(2));
  await writeBigJson(badFile,'{"schema":1,"records":[',`],"account":"${acctB}"}`,'leak','Model-'+'Y'.repeat(80));
  assert.ok((await stat(badFile)).size>1024*1024);

  const second=await new UsageLedger(dir).summary(acctA,Date.parse('2026-10-30T08:00:00Z'));
  assert.equal(second.requests,count,'Failed large stream must not leak partial rows');
  assert.equal(second.unreadableFiles,1);
});

test('MetricsStore LRU cap, TrajectoryReader cache cap, and DesktopUsage memory backpressure bound retained state',async t=>{
  // 1. MetricsStore LRU cap preserves active/pending and evicts oldest idle entries.
  const store=new MetricsStore({discover:async()=>({pid:1}),call:async()=>({}),trajectory:async()=>({trajectory:{steps:[],generatorMetadata:[]}})},{history:{load:async()=>null,save:async()=>null},transcripts:null,maxCachedSessions:3});
  t.after(()=>store.dispose());
  store.identity=acctA;
  for(let i=1;i<=6;i++)store.touchSession(cid(i),{data:{conversationId:cid(i)},updatedAt:i});
  assert.equal(store.sessions.size,3);
  assert.deepEqual([...store.sessions.keys()],[cid(4),cid(5),cid(6)]);
  // Pending entry is protected from eviction.
  store.sessions.get(cid(4)).pending=Promise.resolve();
  store.touchSession(cid(7),{data:{conversationId:cid(7)},updatedAt:7});
  assert.equal(store.sessions.has(cid(4)),true);
  assert.equal(store.sessions.has(cid(5)),false);

  // 2. TrajectoryReader cache cap bounds inactive entries, defaults to full budgetBytes,
  // and evicts settled entries before actively running conversations.
  const defaultReader=new TrajectoryReader({now:()=>1000});
  assert.equal(defaultReader.cacheBudgetBytes,defaultReader.budgetBytes);
  const reader=new TrajectoryReader({now:()=>1000},{budgetBytes:1024*1024,cacheBudgetBytes:2000,maxCachedEntries:2});
  reader.entries.set('a',{data:{},bytes:1200,pending:null});reader.cachedBytes+=1200;
  reader.entries.set('b',{data:{},bytes:1200,pending:null});reader.cachedBytes+=1200;
  reader.entries.set('c',{data:{},bytes:1500,pending:null});reader.cachedBytes+=1500;
  reader.trim('c');
  assert.equal(reader.entries.has('c'),true);
  assert.equal(reader.entries.size,1);
  assert.equal(reader.cachedBytes,1500);

  const runningReader=new TrajectoryReader({now:()=>1000},{budgetBytes:1024*1024,cacheBudgetBytes:2500,maxCachedEntries:2});
  runningReader.entries.set('active',{data:{},bytes:1800,pending:null,summary:{status:'CASCADE_RUN_STATUS_RUNNING'}});runningReader.cachedBytes+=1800;
  runningReader.entries.set('settled',{data:{},bytes:1000,pending:null,summary:{status:'CASCADE_RUN_STATUS_IDLE'}});runningReader.cachedBytes+=1000;
  runningReader.entries.set('child',{data:{},bytes:600,pending:null,summary:{status:'CASCADE_RUN_STATUS_IDLE'}});runningReader.cachedBytes+=600;
  runningReader.trim('child');
  assert.equal(runningReader.entries.has('active'),true,'Settled entries must be evicted before an actively running conversation');
  assert.equal(runningReader.entries.has('settled'),false);
  assert.equal(runningReader.entries.has('child'),true);

  // 3. DesktopUsage memorySoftLimitBytes pauses full-sync slice and trims caches.
  const dir=await mkdtemp(join(tmpdir(),'ag-usage-mem-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let trimmedReader=0,trimmedStore=0,fetched=0;
  const mockStore={
    identity:acctA,epoch:1,
    trimSessions:()=>{trimmedStore++;},
    listConversations:async()=>[
      {id:cid(1),modifiedAt:'2026-10-30T01:00:00Z',status:'DONE'},
      {id:cid(2),modifiedAt:'2026-10-30T02:00:00Z',status:'DONE'},
      {id:cid(3),modifiedAt:'2026-10-30T03:00:00Z',status:'DONE'},
    ],
    client:{
      reader:{trim:()=>{trimmedReader++;}},
      trajectory:async()=>{fetched++;return {trajectory:{steps:[],generatorMetadata:[]}};},
    },
  };
  const tracker=new DesktopUsage(mockStore,new UsageLedger(dir),{
    host:'app',sliceMs:60000,continueDelay:60000,itemDelay:0,
    memorySoftLimitBytes:1, // Force watermark trip right after the first item
    discoverLocal:async()=>({conversations:[],errors:0}),
  });
  t.after(()=>tracker.dispose());
  await tracker.sync(true);
  assert.equal(fetched,1,'Watermark must pause slice after first item instead of exhausting slice');
  assert.equal(trimmedReader,1);
  assert.equal(trimmedStore,1);
  assert.equal(tracker.status,'syncing');
});
