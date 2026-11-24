import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {UsageLedger,DesktopUsage,usageRecords,dateKey} from '../usage.mjs';
import {INDEX_FILENAME} from '../usage-index.mjs';
import {MetricsStore} from '../store.mjs';
const scope=s=>createHash('sha256').update(s).digest('hex'),account=scope('account A');
const id='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
const raw=(options={})=>({trajectory:{steps:[{type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',metadata:{createdAt:'2026-10-10T16:05:00Z',...options.metadata}}],generatorMetadata:[{stepIndices:[0],chatModel:{modelDisplayName:options.model||'Gemini 3.8',...(options.start?{chatStartMetadata:{createdAt:options.start}}:{}),usage:{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',responseId:'private-request-id',inputTokens:'100',cacheReadTokens:'900',cacheWriteTokens:'20',outputTokens:'80',thinkingOutputTokens:'30',...options.usage}}}]}});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'ag-usage-'));const ledger=new UsageLedger(dir);t.after(async()=>{ledger.quotaEstimator?.dispose();await rm(dir,{recursive:true,force:true});});return ledger;}
test('usage survives restart, upserts, and deduplicates across conversations',async t=>{
 const ledger=await fixture(t);await Promise.all([ledger.ingest(account,id,raw()),ledger.ingest(account,id,raw())]);
 await ledger.ingest(account,other,raw());let summary=await new UsageLedger(ledger.directory).summary(account,Date.parse('2026-10-11T02:00:00Z'));
 assert.equal(summary.totalTokens,1100);assert.equal(summary.requests,1);assert.equal(summary.todayTokens,1100);
 await ledger.ingest(account,id,raw({usage:{outputTokens:100}}));summary=await ledger.summary(account);assert.equal(summary.totalTokens,1120);
 await ledger.ingest(account,id,{trajectory:{generatorMetadata:[]}});assert.equal((await ledger.summary(account)).totalTokens,1120);
 const content=await readFile(ledger.file(account,id),'utf8');assert.equal(content.includes('private-request-id'),false);assert.equal(content.includes(id),false);
 assert.equal((await ledger.summary(scope('other'))).totalTokens,0);assert.throws(()=>ledger.file(account,'../escape'));
});
test('request time wins, planner-created is fallback, and unknown dates stay out of today',async t=>{
 assert.equal(dateKey(Date.parse('2026-10-10T16:05:00Z')),'2026-10-11');
 assert.equal(usageRecords(raw(),id)[0].timeBasis,'planner-created');
 const start=usageRecords(raw({start:'2026-10-10T15:59:59Z'}),id)[0];assert.equal(dateKey(start.at),'2026-10-10');assert.equal(start.timeBasis,'request-start');
 const ledger=await fixture(t);await ledger.ingest(account,id,raw({metadata:{createdAt:undefined}}));
 const summary=await ledger.summary(account,Date.parse('2026-10-11T02:00:00Z'));assert.equal(summary.unknownTokens,1100);assert.equal(summary.unknownRequests,1);assert.equal(summary.todayTokens,0);assert.equal(summary.totalTokens,1100);
 await ledger.ingest(account,id,raw());assert.equal((await ledger.summary(account)).unknownRequests,0);
});
test('thinking is included once, anomalous TPS is irrelevant, partial fields do not destroy known counts',async t=>{
 const r=usageRecords(raw(),id)[0];assert.equal(r.output,80);assert.equal(r.uncached+r.cacheRead+r.cacheWrite+r.output,1100);
 const ledger=await fixture(t);await ledger.ingest(account,id,raw());await ledger.ingest(account,id,raw({usage:{outputTokens:'invalid'}}));
 const summary=await ledger.summary(account);assert.equal(summary.totalTokens,1100);assert.equal(summary.partialRequests,1);
 const invalid=raw({usage:{inputTokens:'bad',cacheReadTokens:'bad',outputTokens:'50'}});assert.equal(usageRecords(invalid,id)[0].partial,true);
});
test('weekly/monthly buckets use the configured calendar, unreadable records are reported',async t=>{
 const ledger=await fixture(t);await ledger.ingest(account,id,raw({start:'2026-09-30T16:00:00Z'}));
 await ledger.ingest(account,other,raw({usage:{responseId:'request-two'},start:'2026-10-11T00:00:00Z'}));
 let summary=await ledger.summary(account,Date.parse('2026-10-11T08:00:00Z'));assert.equal(summary.monthTokens,2200);assert.equal(summary.weekTokens,1100);
 await writeFile(ledger.file(account,other),'{broken');summary=await new UsageLedger(ledger.directory).summary(account);assert.equal(summary.unreadableFiles,1);
});
test('backfill refreshes changed trajectories and isolates an account change in flight',async t=>{
 const ledger=await fixture(t);let calls=0,release;const store={identity:account,epoch:1,listConversations:async()=>[{id,modifiedAt:'one',status:'DONE'}],client:{trajectory:async()=>{calls++;return raw();}}};
 const tracker=new DesktopUsage(store,ledger);await tracker.sync();await tracker.sync();assert.equal(calls,1);assert.equal((await tracker.snapshot()).totalTokens,1100);
 store.listConversations=async()=>[{id:other,modifiedAt:'two',status:'DONE'}];store.client.trajectory=()=>new Promise(r=>{release=r;});
 const pending=tracker.sync();await new Promise(r=>setImmediate(r));store.identity=scope('B');store.epoch++;release(raw());await pending;
 assert.equal((await ledger.summary(store.identity)).totalTokens,0);
});
test('MetricsStore forwards authenticated raw records and preserves live speed on ledger failure',async()=>{
 const history={load:async()=>null,save:async()=>null};let scopeSeen=null;
 const client={discover:async()=>({pid:1}),call:async name=>name==='GetUserStatus'?{userStatus:{email:'fixture@example.test'}}:{},trajectory:async()=>raw()};
 const store=new MetricsStore(client,{history,onTrajectory:async s=>{scopeSeen=s;throw Error('disk unavailable');}});const result=await store.snapshot({conversationId:id});
 assert.equal(scopeSeen,scope('fixture@example.test'));assert.equal(store.usagePersistenceError,true);assert.equal(result.speed.counts.input,100);
 store.onTrajectory=async()=>{};await store.snapshot({conversationId:id,force:true});assert.equal(store.usagePersistenceError,false);
});
test('IDE usage keeps a separate ledger and source across collector restarts',async t=>{
 const desktop=await fixture(t),ide=new UsageLedger(join(desktop.directory,'ide'),{source:'ide-local'});
 const store={identity:account,epoch:1,listConversations:async()=>[{id,modifiedAt:'one',status:'DONE'}],client:{trajectory:async()=>raw()}};
 const tracker=new DesktopUsage(store,ide);await tracker.sync();assert.equal((await tracker.snapshot()).source,'ide-local');assert.equal((await tracker.snapshot()).totalTokens,1100);
 assert.equal((await desktop.summary(account)).totalTokens,0);
 const restarted=new DesktopUsage(store,new UsageLedger(ide.directory,{source:'ide-local'}));await restarted.sync();assert.equal((await restarted.snapshot()).totalTokens,1100);assert.equal((await restarted.snapshot()).requests,1);
});
test('all-local scope aggregates across accounts + unauthenticated sessions and computes active quota-window reference',async t=>{
  const ledger=await fixture(t),acctB=scope('account B'),cid3='33333333-3333-3333-3333-333333333333';
  const now=Date.parse('2026-10-11T08:00:00Z');
  const fiveReset=new Date(now+2*3600000).toISOString();
  const weekReset=new Date(now+3*86400000).toISOString();
  await ledger.ingest(account,id,raw({model:'Gemini 3.8 Pro',start:'2026-10-11T06:00:00Z',usage:{responseId:'a-1',inputTokens:'100',cacheReadTokens:'900',cacheWriteTokens:'0',outputTokens:'100'}}));
  await ledger.ingest(account,other,raw({model:'Gemini 3.8 Pro',start:'2026-10-01T00:00:00Z',usage:{responseId:'a-old',inputTokens:'500',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'500'}}));
  await ledger.ingest(acctB,cid3,raw({model:'Claude Sonnet 4.5',start:'2026-10-11T07:00:00Z',usage:{responseId:'b-1',inputTokens:'200',cacheReadTokens:'1800',cacheWriteTokens:'0',outputTokens:'200'}}));
  await ledger.ingest(acctB,other,raw({model:'Gemini 3.8 Pro',start:'2026-10-11T06:00:00Z',usage:{responseId:'a-1',inputTokens:'100',cacheReadTokens:'900',cacheWriteTokens:'0',outputTokens:'100'}}));
  const groups=[
    {id:'gemini',name:'Gemini',windows:{'5h':{available:true,remaining:0.8,resetAt:fiveReset},weekly:{available:true,remaining:0.98,resetAt:weekReset}}},
    {id:'3p',name:'Claude / GPT',windows:{'5h':{available:true,remaining:0.5,resetAt:fiveReset},weekly:{available:true,remaining:0.5,resetAt:weekReset}}},
  ];
  const store={identity:account,epoch:1,listConversations:async()=>[],client:{trajectory:async()=>raw()}};
  const tracker=new DesktopUsage(store,ledger);t.after(()=>tracker.dispose());
  const localSnap=await tracker.snapshot({sync:false,scope:'local',groups});
  assert.equal(localSnap.scope,'local');assert.equal(localSnap.accountKey,'all-local');assert.equal(localSnap.accountsCount,2);
  assert.equal(localSnap.requests,3);
  assert.equal(localSnap.totalTokens,1100+1000+2200);
  assert.equal(localSnap.quotaWindows['gemini:5h'].observedTokens,1100);
  assert.equal(localSnap.quotaWindows['gemini:5h'].estimatedFullTokens,5500);
  assert.equal(localSnap.quotaWindows['gemini:weekly'].observedTokens,1100);
  assert.equal(localSnap.quotaWindows['gemini:weekly'].estimatedFullTokens,null);
  assert.equal(localSnap.quotaWindows['3p:5h'],undefined);
  const acctSnap=await tracker.snapshot({sync:false,scope:'account',groups});
  assert.equal(acctSnap.scope,'account');assert.equal(acctSnap.totalTokens,2100);assert.equal(acctSnap.quotaWindows['gemini:5h'].observedTokens,1100);
  store.identity=null;store.epoch++;
  await ledger.ingest(scope('ag-pulse:local-unauthenticated'),cid3,raw({model:'Gemini 3.8 Flash',start:'2026-10-11T07:30:00Z',usage:{responseId:'unauth-1',inputTokens:'300',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'100'}}));
  tracker.ingestLive(scope('ag-pulse:local-unauthenticated'),id,raw({usage:{responseId:'live-unauth',inputTokens:'50',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'50'}}));
  const liveDeadline=Date.now()+10000;
  while(tracker.liveStates.size>0||ledger.usageWrites.size>0){if(Date.now()>liveDeadline)throw Error('live ingest did not settle');await new Promise(r=>setTimeout(r,10));}
  await ledger.queue;
  const unauthLocal=await tracker.snapshot({sync:false,scope:'local',groups});
  assert.equal(unauthLocal.accountAvailable,false);assert.equal(unauthLocal.accountsCount,2);assert.equal(unauthLocal.totalTokens,1100+1000+2200+400+100);
  const unauthAcct=await tracker.snapshot({sync:false,scope:'account',groups});
  assert.equal(unauthAcct.accountAvailable,false);assert.equal(unauthAcct.totalTokens,0);
});

test('idle quota resetAt drift keeps cache warm and same-account fallback avoids empty quotaWindows during writes',async t=>{
  const ledger=await fixture(t);
  const now=Date.parse('2026-10-11T08:00:00Z');
  const fiveReset=new Date(now+2*3600000).toISOString();
  const weekReset=new Date(now+3*86400000).toISOString();
  await ledger.ingest(account,id,raw({model:'Gemini 4 Neon (High)',start:'2026-10-11T06:00:00Z',usage:{responseId:'g-1',inputTokens:'500',cacheReadTokens:'1500',cacheWriteTokens:'0',outputTokens:'200'}}));
  let reads=0;
  const origRead=ledger.readSummaryRecord.bind(ledger);
  ledger.readSummaryRecord=async file=>{reads++;return origRead(file);};

  const makeGroups=({five=fiveReset,week=weekReset,fiveRem=0.8,weekRem=0.5,idleShiftMin=0}={})=>[
    {id:'gemini',name:'Gemini',windows:{'5h':{available:true,remaining:fiveRem,resetAt:five},weekly:{available:true,remaining:weekRem,resetAt:week}}},
    {id:'3p',name:'Claude / GPT',windows:{'5h':{available:true,remaining:1,resetAt:new Date(now+5*3600000+idleShiftMin*60000).toISOString()},weekly:{available:true,remaining:1,resetAt:new Date(now+7*86400000+idleShiftMin*60000).toISOString()}}},
  ];

  const first=await ledger.summary('all',now,{groups:makeGroups({idleShiftMin:0}),quotaAccount:account});
  assert.equal(reads,1);
  assert.equal(first.quotaWindows['gemini:5h'].observedTokens,2200);
  assert.equal(first.quotaWindows['gemini:weekly'].observedTokens,2200);

  // Rolling resetAt on idle (remaining=1) 3p windows must hit cache with zero extra reads or cache growth.
  const second=await ledger.summary('all',now+120000,{groups:makeGroups({idleShiftMin:2,fiveRem:0.75}),quotaAccount:account});
  assert.equal(reads,1,'Idle 3p resetAt drift must not invalidate summary cache');
  assert.equal(ledger.caches.size,1);
  assert.equal(second.quotaWindows['gemini:5h'].observedTokens,2200);
  assert.equal(second.quotaWindows['gemini:5h'].estimatedFullTokens,8800);

  // While a write is in progress and active 5h resets to a new cycle, weekly stays preserved and reset 5h does not leak old usage.
  ledger.beginUsageWrite(account);
  try{
    const jitter=await ledger.summary('all',now+180000,{groups:makeGroups({five:new Date(Date.parse(fiveReset)+60000).toISOString()}),quotaAccount:account});
    assert.equal(jitter.summaryStale,true);
    assert.equal(jitter.quotaWindows['gemini:5h'].observedTokens,2200);
    assert.equal(jitter.quotaWindows['gemini:weekly'].observedTokens,2200);

    const reset5h=await ledger.summary('all',now+180000,{groups:makeGroups({five:new Date(Date.parse(fiveReset)+5*3600000).toISOString()}),quotaAccount:account});
    assert.equal(reset5h.summaryStale,true);
    assert.equal(reset5h.quotaWindows['gemini:5h'],undefined,'Reset 5h window must not display prior cycle usage');
    assert.equal(reset5h.quotaWindows['gemini:weekly'].observedTokens,2200,'Unchanged weekly window stays visible without flicker');
  }finally{
    ledger.endUsageWrite(account);
  }
});

test('maxWaitMs returns promptly during slow cold index build while background scan warms cache',async t=>{
  const ledger=await fixture(t);
  const now=Date.now();
  await ledger.ingest(account,id,raw({start:new Date(now-60000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:'cold-1',inputTokens:'400',cacheReadTokens:'1000',cacheWriteTokens:'0',outputTokens:'100'}}));
  ledger.caches.clear();

  let releaseRead;
  const readGate=new Promise(resolve=>{releaseRead=resolve;});
  const origRead=ledger.readSummaryRecord.bind(ledger);
  ledger.readSummaryRecord=async file=>{
    await readGate;
    return origRead(file);
  };

  const t0=Date.now();
  const early=await ledger.summary('all',now,{maxWaitMs:40});
  const elapsed=Date.now()-t0;
  assert.ok(elapsed<5000,`maxWaitMs should bound cold-start wait without hanging, took ${elapsed}ms`);
  assert.equal(early.summaryStale,true);
  assert.equal(early.totalTokens,null);
  assert.equal(ledger.jsonSummaryPending.size,1,'background scan stays alive after timeout');

  releaseRead();
  await Promise.all([...ledger.jsonSummaryPending.values()]);
  assert.equal(ledger.caches.size,1,'background scan populates summary cache on completion');

  const warm=await ledger.summary('all',now,{maxWaitMs:40});
  assert.equal(warm.summaryStale,undefined);
  assert.equal(warm.totalTokens,1500);
});

test('summary avoids main-thread SQLite contention while diskSummaryPending is active and offloads cold bulk builds',async t=>{
  const ledger=await fixture(t);
  const now=Date.now();
  await ledger.ingest(account,id,raw({start:new Date(now-60000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:'busy-1',inputTokens:'200',cacheReadTokens:'800',cacheWriteTokens:'0',outputTokens:'100'}}));
  const baseline=await ledger.summary('all',now);
  assert.equal(baseline.totalTokens,1100);

  // While a worker summary is already active, main-thread summary returns stale fallback immediately without touching SQLite.
  ledger.revision++;
  let workerCalls=0;
  ledger.diskSummaryPending=new Promise(()=>{});
  try{
    const duringWorker=await ledger.summary('all',now,{maxWaitMs:350});
    assert.equal(duringWorker.summaryStale,true);
    assert.equal(duringWorker.totalTokens,1100);
    assert.equal(ledger.jsonSummaryPending.size,0);
  }finally{
    ledger.diskSummaryPending=null;
  }

  // Cold bulk build (>16 JSON files with no existing index) during foreground poll (maxWaitMs > 0) offloads to worker.
  const bulkLedger=await fixture(t);
  for(let i=1;i<=18;i++){
    const cid=`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`;
    await bulkLedger.ingest(account,cid,raw({start:new Date(now-60000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:`bulk-${i}`,inputTokens:'10',cacheReadTokens:'20',cacheWriteTokens:'0',outputTokens:'5'}}));
  }
  bulkLedger.caches.clear();
  bulkLedger.startDiskSummary=()=>{workerCalls++;};
  const offloaded=await bulkLedger.summary('all',now,{maxWaitMs:350});
  assert.equal(workerCalls,1,'Cold bulk foreground poll must offload to disk worker instead of blocking main thread');
  assert.equal(offloaded.summaryStale,true);
  assert.equal(bulkLedger.jsonSummaryPending.size,0);
});

test('account-scoped quota window query uses indexed IN subquery without nested co-routine scan and matches dedup rules',async t=>{
  const ledger=await fixture(t);
  const now=Date.parse('2026-10-11T10:00:00Z');
  const reset5h=new Date(now+2*3600*1000).toISOString();
  const groups=[{id:'gemini',name:'Gemini',windows:{'5h':{available:true,remaining:0.8,resetAt:reset5h}}}];
  const otherAcct=scope('account B');
  // Cross-conversation duplicate request in same account: higher total (1500) must win over lower (1100).
  await ledger.ingest(account,id,raw({start:new Date(now-60*60*1000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:'dup-win',inputTokens:'100',cacheReadTokens:'900',cacheWriteTokens:'0',outputTokens:'100'}}));
  await ledger.ingest(account,other,raw({start:new Date(now-60*60*1000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:'dup-win',inputTokens:'200',cacheReadTokens:'1100',cacheWriteTokens:'0',outputTokens:'200'}}));
  // Unique in-window request in target account.
  await ledger.ingest(account,other,raw({start:new Date(now-30*60*1000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:'solo-win',inputTokens:'50',cacheReadTokens:'400',cacheWriteTokens:'0',outputTokens:'50'}}));
  // Out-of-window request (>5h ago) must be excluded.
  await ledger.ingest(account,id,raw({start:new Date(now-6*3600*1000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:'old-win',inputTokens:'500',cacheReadTokens:'500',cacheWriteTokens:'0',outputTokens:'500'}}));
  // Other-account-only request in window must be excluded from target quotaAccount.
  await ledger.ingest(otherAcct,id,raw({start:new Date(now-20*60*1000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:'other-acct',inputTokens:'300',cacheReadTokens:'300',cacheWriteTokens:'0',outputTokens:'300'}}));

  const acctSummary=await ledger.summary(account,now,{groups,quotaAccount:account});
  const allSummary=await ledger.summary('all',now,{groups,quotaAccount:account});
  assert.equal(acctSummary.quotaWindows['gemini:5h']?.observedTokens,2000);
  assert.equal(acctSummary.quotaWindows['gemini:5h']?.requests,2);
  assert.equal(allSummary.quotaWindows['gemini:5h']?.observedTokens,2000);
  assert.equal(allSummary.quotaWindows['gemini:5h']?.requests,2);

  const db=new DatabaseSync(join(ledger.directory,INDEX_FILENAME),{readOnly:true});
  try{
    const idx=db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_source_rows_acct_at'").get();
    assert.equal(idx?.name,'idx_source_rows_acct_at');
    const plan=db.prepare(`
      EXPLAIN QUERY PLAN
      WITH winners AS (
        SELECT s.request_id, s.at, s.model, s.total,
               ROW_NUMBER() OVER (PARTITION BY s.request_id ORDER BY s.total DESC, s.source_id ASC) AS rn
        FROM source_rows s
        WHERE s.account = ?
          AND s.request_id IN (
            SELECT DISTINCT request_id
            FROM source_rows
            WHERE account = ? AND at IS NOT NULL AND at >= ? AND at <= ?
          )
      )
      SELECT at, model, total
      FROM winners
      WHERE rn = 1 AND at IS NOT NULL AND at >= ? AND at <= ?
    `).all(account,account,now-5*3600*1000,now+2*3600*1000,now-5*3600*1000,now+2*3600*1000);
    const details=plan.map(r=>r.detail).join('\n');
    assert.ok(details.includes('LIST SUBQUERY'),`Expected LIST SUBQUERY in query plan:\n${details}`);
    assert.ok(details.includes('idx_source_rows_acct_at'),`Expected idx_source_rows_acct_at in query plan:\n${details}`);
    assert.ok(details.includes('idx_source_rows_acct_req'),`Expected idx_source_rows_acct_req in query plan:\n${details}`);
    assert.equal(details.includes('SCAN source_rows'),false,`Account quota query must not full-scan source_rows:\n${details}`);
    assert.equal(details.includes('USE TEMP B-TREE FOR ORDER BY'),false,`Window function should stream directly from idx_source_rows_acct_req:\n${details}`);
  }finally{
    db.close();
  }
});

test('foreground summary with >16 JSON files offloads to disk worker even when SQLite index already exists and syncs dirty updates',async t=>{
  const ledger=await fixture(t);
  const now=Date.parse('2026-10-11T10:00:00Z');
  const reset5h=new Date(now+2*3600*1000).toISOString();
  const groups=[{id:'gemini',name:'Gemini',windows:{'5h':{available:true,remaining:0.8,resetAt:reset5h}}}];
  for(let i=1;i<=18;i++){
    const cid=`${String(i).padStart(8,'0')}-2222-4222-8222-222222222222`;
    await ledger.ingest(account,cid,raw({start:new Date(now-60000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:`warm-bulk-${i}`,inputTokens:'10',cacheReadTokens:'20',cacheWriteTokens:'0',outputTokens:'5'}}));
  }
  // Build the SQLite index first so .usage-index-v1.sqlite exists on disk.
  const built=await ledger.summary(account,now,{groups,quotaAccount:account});
  assert.equal(built.totalTokens,18*35);
  assert.equal(built.quotaWindows['gemini:5h']?.observedTokens,18*35);

  // Cold restart with existing SQLite index must still offload foreground polls to worker.
  ledger.caches.clear();
  let workerCalls=0;
  const origStart=ledger.startDiskSummary.bind(ledger);
  ledger.startDiskSummary=(...args)=>{workerCalls++;return origStart(...args);};
  const fresh=await ledger.summary(account,now,{maxWaitMs:5000,groups,quotaAccount:account});
  assert.equal(workerCalls,1,'Existing SQLite index with >16 files must still offload foreground poll to worker');
  assert.equal(fresh.summaryStale,undefined,'Fast worker completion within maxWaitMs should return fresh summary immediately');
  assert.equal(fresh.totalTokens,18*35);
  assert.equal(fresh.quotaWindows['gemini:5h']?.observedTokens,18*35);
  assert.equal(ledger.jsonSummaryPending.size,0);

  // Dirty updates must also be forwarded to the worker and cleared after completion.
  const cid1='00000001-2222-4222-8222-222222222222';
  await ledger.ingest(account,cid1,raw({start:new Date(now-30000).toISOString(),model:'Gemini 4 Neon (High)',usage:{responseId:'warm-bulk-extra',inputTokens:'100',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'0'}}));
  assert.ok(ledger._dirtySources.size>0);
  ledger.caches.clear();
  const updated=await ledger.summary(account,now,{maxWaitMs:5000,groups,quotaAccount:account});
  assert.equal(workerCalls,2);
  assert.equal(updated.summaryStale,undefined);
  assert.equal(updated.totalTokens,18*35+100);
  assert.equal(updated.quotaWindows['gemini:5h']?.observedTokens,18*35+100);
  assert.equal(ledger._dirtySources.size,0);
});

test('quota window summary accumulates exact per-request USD cost and estimates full USD capacity',async t=>{
  const ledger=await fixture(t);
  const now=Date.parse('2026-11-20T12:00:00Z');
  const weekReset=new Date(now+2*86400000).toISOString();
  const groups=[{id:'gemini',name:'Gemini',windows:{weekly:{available:true,remaining:0.8,resetAt:weekReset}}}];
  // Request 1: Gemini 4 Hydrogen (base: uncached $1.5/M, cacheRead $0.075/M, output $7.5/M) -> 1M uncached ($1.5) + 10M cache ($0.75) + 0.5M out ($3.75) = $6.00
  await ledger.ingest(account,id,raw({model:'Gemini 4 Hydrogen (High)',start:'2026-11-19T10:00:00Z',usage:{responseId:'cost-h1',inputTokens:'1000000',cacheReadTokens:'10000000',cacheWriteTokens:'0',outputTokens:'500000'}}));
  // Request 2: Gemini 4 Neon (base: uncached $3/M, cacheRead $0.15/M, output $15/M) -> 1M uncached ($3) + 10M cache ($1.5) + 0.5M out ($7.5) = $12.00
  await ledger.ingest(account,other,raw({model:'Gemini 4 Neon (XHigh)',start:'2026-11-20T08:00:00Z',usage:{responseId:'cost-n1',inputTokens:'1000000',cacheReadTokens:'10000000',cacheWriteTokens:'0',outputTokens:'500000'}}));
  const summary=await ledger.summary(account,now,{groups,quotaAccount:account});
  const win=summary.quotaWindows['gemini:weekly'];
  assert.equal(win.observedTokens,23_000_000);
  assert.ok(Math.abs(win.observedCostUsd-18.0)<1e-4,`expected $18.00 observed cost, got ${win.observedCostUsd}`);
  assert.ok(Math.abs(win.estimatedFullUsd-90.0)<1e-3,`expected $90.00 full USD at 20% used, got ${win.estimatedFullUsd}`);
  assert.equal(win.estimatedFullTokens,115_000_000);
});

test('multi-account backfill and live viewing isolate request_ids already owned by another authenticated account',async t=>{
  const ledger=await fixture(t);
  const acctA=scope('account-A'),acctB=scope('account-B'),unauth=scope('ag-pulse:local-unauthenticated');
  const cidB='44444444-4444-4444-4444-444444444444';
  const cidU='55555555-5555-5555-5555-555555555555';
  const makeMultiRaw=resps=>({
    trajectory:{
      cascadeId:cidB,
      steps:resps.map(()=>({type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',metadata:{createdAt:'2026-11-20T10:00:00Z'}})),
      generatorMetadata:resps.map((rid,i)=>({
        stepIndices:[i],
        chatModel:{
          modelDisplayName:'Gemini 4 Neon (High)',
          chatStartMetadata:{createdAt:'2026-11-20T10:00:00Z'},
          usage:{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',responseId:rid,inputTokens:'100',cacheReadTokens:'900',cacheWriteTokens:'0',outputTokens:'100'},
        },
      })),
    },
  });
  // Account B produces cidB with requests b-1 and b-2.
  const store={
    identity:acctB,epoch:1,
    listConversations:async()=>[{id:cidB,modifiedAt:'v1',status:'DONE'}],
    client:{trajectory:async()=>makeMultiRaw(['b-1','b-2'])},
  };
  const tracker=new DesktopUsage(store,ledger,{host:'app',discoverLocal:async()=>({conversations:[],errors:0})});
  t.after(()=>tracker.dispose());
  await tracker.sync(true);
  assert.equal((await ledger.summary(acctB)).requests,2);

  // Also seed an unauthenticated LOCAL_SCOPE request u-1 in cidU.
  await ledger.ingest(unauth,cidU,makeMultiRaw(['u-1']));

  // User switches to Account A. Local disk still has cidB (from B) and cidU (from unauth).
  store.identity=acctA;store.epoch++;
  store.listConversations=async()=>[{id:cidB,modifiedAt:'v1',status:'DONE'},{id:cidU,modifiedAt:'v1',status:'DONE'}];
  store.client.trajectory=async cid=>cid===cidB?makeMultiRaw(['b-1','b-2']):makeMultiRaw(['u-1']);
  await tracker.sync(true);
  // Account A MUST NOT steal b-1 / b-2 from Account B, but CAN claim unauthenticated u-1.
  const snapA1=await ledger.summary(acctA);
  assert.equal(snapA1.requests,1,'Account A should claim only unauthenticated u-1, not Account B requests');
  assert.equal(snapA1.totalTokens,1100);

  // Viewing Account B's chat via ingestLive while signed in as Account A must also skip b-1 / b-2,
  // while a brand-new turn a-3 sent by Account A in the same chat IS attributed to Account A.
  tracker.ingestLive(acctA,cidB,makeMultiRaw(['b-1','b-2','a-3']));
  const deadline=Date.now()+10000;
  while(tracker.liveStates.size>0||ledger.usageWrites.size>0){if(Date.now()>deadline)throw Error('live ingest did not settle');await new Promise(r=>setTimeout(r,10));}
  await ledger.queue;
  const snapA2=await ledger.summary(acctA);
  assert.equal(snapA2.requests,2,'Account A now owns u-1 + new turn a-3, still excluding b-1/b-2');
  assert.equal(snapA2.totalTokens,2200);
  const snapB=await ledger.summary(acctB);
  assert.equal(snapB.requests,2,'Account B retains its original b-1 and b-2 untouched');
});
