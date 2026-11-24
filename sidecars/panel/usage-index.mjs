// Persistent incremental SQLite usage index.
// Keeps summary memory O(1) in V8 regardless of historical file/request count.
// Never stores prompts, credentials, or raw request IDs (only SHA-256 hashes and numeric counts).
import {DatabaseSync} from 'node:sqlite';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {setImmediate as yieldToEventLoop} from 'node:timers/promises';
import {TrajectoryJson} from './trajectory-json.mjs';

const pricing=createRequire(import.meta.url)('../../compat/pricing.cjs')();

export const INDEX_FILENAME='.usage-index-v1.sqlite';
const SCHEMA_VERSION='2';
const HASH=/^[a-f0-9]{64}$/;
const FILE_PATTERN=/^[a-f0-9]{64}\.(json|sqlite)$/;
const KEYS=['uncached','cacheRead','cacheWrite','output'];
const MAX_SOURCE_BYTES=256*1024*1024;
const DIRECT_JSON_MAX_BYTES=1024*1024;
const RESULT_BUDGET_BYTES=4*1024*1024;
const STREAM_BATCH_SIZE=512;
const BUCKET_MS=15*60*1000;

export const INDEX_CANCELLED=Symbol('usage-index-cancelled');

const rowTotal=r=>KEYS.reduce((n,k)=>n+(r[k]??0),0);
const validRow=r=>Boolean(
  r&&HASH.test(r.id)&&typeof r.model==='string'&&r.model.length<=120&&
  (r.at===null||Number.isSafeInteger(r.at)&&r.at>=0)&&
  KEYS.every(k=>r[k]===null||Number.isSafeInteger(r[k])&&r[k]>=0)
);

function createDateKeyResolver(timeZone='Asia/Shanghai'){
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
  const formatExact=time=>{
    const parts=formatter.formatToParts(time);
    let y='',m='',d='';
    for(const p of parts){
      if(p.type==='year')y=p.value;
      else if(p.type==='month')m=p.value;
      else if(p.type==='day')d=p.value;
    }
    return `${y}-${m}-${d}`;
  };
  const cache=new Map();
  return time=>{
    if(time===null||time===undefined)return null;
    const bucket=Math.floor(time/BUCKET_MS);
    const cached=cache.get(bucket);
    if(cached!==undefined)return cached===null?formatExact(time):cached;
    const start=bucket*BUCKET_MS;
    const a=formatExact(start),b=formatExact(start+BUCKET_MS-1);
    const value=a===b?a:null;
    if(cache.size>=4096)cache.clear();
    cache.set(bucket,value);
    return value===null?formatExact(time):value;
  };
}

export function indexDateKey(time,timeZone='Asia/Shanghai'){
  return createDateKeyResolver(timeZone)(time);
}

export function indexWeekStart(date){
  const d=new Date(date+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
  return d.toISOString().slice(0,10);
}

function applyPragmas(db,busyTimeoutMs=5000){
  const busy=Number.isSafeInteger(busyTimeoutMs)&&busyTimeoutMs>=0?busyTimeoutMs:5000;
  db.exec(
    'PRAGMA journal_mode=DELETE;' +
    'PRAGMA synchronous=NORMAL;' +
    'PRAGMA temp_store=FILE;' +
    'PRAGMA cache_size=-8192;' +
    'PRAGMA mmap_size=0;' +
    `PRAGMA busy_timeout=${busy};` +
    'PRAGMA max_page_count=262144;'
  );
}

const ROW_INDEX_SQLS=[
  'CREATE INDEX IF NOT EXISTS idx_source_rows_req ON source_rows(request_id, total DESC, source_id ASC);',
  'CREATE INDEX IF NOT EXISTS idx_source_rows_acct_req ON source_rows(account, request_id, total DESC, source_id ASC);',
  'CREATE INDEX IF NOT EXISTS idx_source_rows_at ON source_rows(at) WHERE at IS NOT NULL;',
  'CREATE INDEX IF NOT EXISTS idx_source_rows_acct_at ON source_rows(account, at) WHERE at IS NOT NULL;',
];

function createRowIndexes(db){
  for(const sql of ROW_INDEX_SQLS)db.exec(sql);
}

async function createRowIndexesCooperative(db,{yieldEveryMs=0,onCheck=null}={}){
  for(const sql of ROW_INDEX_SQLS){
    onCheck?.();
    if(yieldEveryMs>0){
      await yieldToEventLoop();
      onCheck?.();
    }
    db.exec(sql);
  }
}

function dropRowIndexes(db){
  db.exec(`
    DROP INDEX IF EXISTS idx_source_rows_req;
    DROP INDEX IF EXISTS idx_source_rows_acct_req;
    DROP INDEX IF EXISTS idx_source_rows_at;
    DROP INDEX IF EXISTS idx_source_rows_acct_at;
  `);
}

function ensureSchema(db,timeZone){
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_files (
      source_id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      filename TEXT NOT NULL,
      size TEXT NOT NULL,
      mtime_ns TEXT NOT NULL,
      ctime_ns TEXT NOT NULL,
      ino TEXT NOT NULL,
      unreadable INTEGER NOT NULL DEFAULT 0,
      row_count INTEGER NOT NULL DEFAULT 0,
      is_sqlite INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account, filename)
    );
    CREATE TABLE IF NOT EXISTS source_rows (
      source_id INTEGER NOT NULL,
      account TEXT NOT NULL,
      request_id TEXT NOT NULL,
      at INTEGER,
      day TEXT,
      model TEXT NOT NULL,
      uncached INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      output INTEGER NOT NULL,
      total INTEGER NOT NULL,
      partial INTEGER NOT NULL,
      UNIQUE(source_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS scope_summary_cache (
      scope TEXT PRIMARY KEY,
      time_zone TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  createRowIndexes(db);
  const getMeta=db.prepare('SELECT value FROM index_meta WHERE key=?');
  const setMeta=db.prepare('INSERT INTO index_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const version=getMeta.get('schema_version')?.value;
  if(version&&version!==SCHEMA_VERSION)throw Error('USAGE_INDEX_SCHEMA_MISMATCH');
  if(!version)setMeta.run('schema_version',SCHEMA_VERSION);
  const savedZone=getMeta.get('time_zone')?.value;
  if(!savedZone){
    setMeta.run('time_zone',timeZone);
  }else if(savedZone!==timeZone){
    const resolveDay=createDateKeyResolver(timeZone);
    const updateDay=db.prepare('UPDATE source_rows SET day=? WHERE rowid=?');
    const selectTimed=db.prepare('SELECT rowid, at FROM source_rows WHERE at IS NOT NULL');
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const r of selectTimed.iterate()){
        updateDay.run(resolveDay(r.at),r.rowid);
      }
      db.exec('DELETE FROM scope_summary_cache');
      setMeta.run('time_zone',timeZone);
      db.exec('COMMIT');
    }catch(e){
      try{db.exec('ROLLBACK');}catch{}
      throw e;
    }
  }
}

async function unlinkIndexFiles(indexPath){
  for(const suffix of ['','-journal','-wal','-shm']){
    await unlink(indexPath+suffix).catch(()=>{});
  }
}

function isLockError(error){
  return error?.errcode===5||error?.errcode===6||/locked|busy/i.test(String(error?.message||error?.errstr||''));
}

async function openIndexDb(directory,timeZone,{busyTimeoutMs=5000}={}){
  await mkdir(directory,{recursive:true});
  const indexPath=join(directory,INDEX_FILENAME);
  for(let attempt=0;attempt<2;attempt++){
    let db=null;
    try{
      db=new DatabaseSync(indexPath);
      applyPragmas(db,busyTimeoutMs);
      ensureSchema(db,timeZone);
      return db;
    }catch(error){
      if(db){try{db.close();}catch{}}
      if(attempt===0&&!isLockError(error)){
        await unlinkIndexFiles(indexPath);
        continue;
      }
      throw error;
    }
  }
  throw Error('Failed to open usage index');
}

function emptySummary({allBuckets,scope,timeZone,today,now,source,hasSpecs}){
  return {
    accountKey:allBuckets?'all-local':scope,
    timeZone,
    today,
    days:[],
    models:[],
    todayTokens:0,
    weekTokens:0,
    monthTokens:0,
    totalTokens:0,
    unknownTokens:0,
    unknownRequests:0,
    partialRequests:0,
    unreadableFiles:0,
    requests:0,
    firstDate:null,
    updatedAt:new Date(now).toISOString(),
    source,
    ...(allBuckets?{accountsCount:0}:{}),
    ...(hasSpecs?{quotaWindowCounts:{}}:{}),
  };
}

function isCancelError(error){
  return error?.code===INDEX_CANCELLED||error?.message==='Usage operation cancelled';
}

function activeFilesForBucket(files){
  const matching=(Array.isArray(files)?files:[]).filter(name=>FILE_PATTERN.test(name));
  const sqliteBases=new Set(matching.filter(n=>n.endsWith('.sqlite')).map(n=>n.slice(0,-7)));
  const active=[];
  for(const name of matching){
    if(name.endsWith('.json')&&sqliteBases.has(name.slice(0,-5)))continue;
    active.push(name);
  }
  return active;
}

async function discoverBuckets(directory,scope,buckets){
  if(scope!=='all'){
    if(Array.isArray(buckets)&&buckets.length===1&&buckets[0]?.dir===scope&&Array.isArray(buckets[0].files)){
      return buckets;
    }
    let files=[];
    try{files=await readdir(join(directory,scope));}catch(e){if(e.code!=='ENOENT')throw e;}
    return [{dir:scope,files}];
  }
  if(Array.isArray(buckets)&&buckets.length>0&&typeof buckets[0]==='object'&&Array.isArray(buckets[0].files)){
    return buckets;
  }
  const names=Array.isArray(buckets)?buckets:await (async()=>{
    try{return await readdir(directory);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  })();
  const out=[];
  for(const name of names){
    if(!HASH.test(name))continue;
    try{
      const info=await lstat(join(directory,name));
      if(info.isSymbolicLink()||!info.isDirectory())continue;
      const files=await readdir(join(directory,name));
      out.push({dir:name,files});
    }catch{}
  }
  return out;
}

export async function indexExists(directory){
  try{return (await lstat(join(directory,INDEX_FILENAME))).isFile();}catch{return false;}
}

async function syncActiveFilesIntoDb(db,{activeMap,allBuckets,accountsFilter=null,resolveDay,readRecord=null,dirtyFiles=null,onCheck=null,yieldEveryMs=0}){
  const deleteRowsBySource=db.prepare('DELETE FROM source_rows WHERE source_id=?');
  const deleteFileBySource=db.prepare('DELETE FROM source_files WHERE source_id=?');
  const insertFile=db.prepare(
    'INSERT INTO source_files(account,filename,size,mtime_ns,ctime_ns,ino,unreadable,row_count,is_sqlite) VALUES(?,?,?,?,?,?,?,?,?)'
  );
  const updateFile=db.prepare(
    'UPDATE source_files SET size=?,mtime_ns=?,ctime_ns=?,ino=?,unreadable=?,row_count=?,is_sqlite=? WHERE source_id=?'
  );
  const renameFile=db.prepare(
    'UPDATE source_files SET filename=?,size=?,mtime_ns=?,ctime_ns=?,ino=?,unreadable=0,row_count=?,is_sqlite=? WHERE source_id=?'
  );
  const upsertRow=db.prepare(
    'INSERT INTO source_rows(source_id,account,request_id,at,day,model,uncached,cache_read,cache_write,output,total,partial) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(source_id,request_id) DO UPDATE SET ' +
    'at=excluded.at,day=excluded.day,model=excluded.model,uncached=excluded.uncached,cache_read=excluded.cache_read,' +
    'cache_write=excluded.cache_write,output=excluded.output,total=excluded.total,partial=excluded.partial ' +
    'WHERE excluded.total>source_rows.total'
  );

  // Sweep any leftover staging rows from a previously terminated worker.
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec("DELETE FROM source_rows WHERE source_id IN (SELECT source_id FROM source_files WHERE filename LIKE '.staging:%');");
    db.exec("DELETE FROM source_files WHERE filename LIKE '.staging:%';");
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}

  // Load tracked source files for the scanned scope.
  let existingRows;
  if(allBuckets){
    existingRows=db.prepare('SELECT source_id,account,filename,size,mtime_ns,ctime_ns,ino,unreadable,row_count,is_sqlite FROM source_files').all();
  }else if(Array.isArray(accountsFilter)&&accountsFilter.length>1){
    const ph=accountsFilter.map(()=>'?').join(',');
    existingRows=db.prepare(`SELECT source_id,account,filename,size,mtime_ns,ctime_ns,ino,unreadable,row_count,is_sqlite FROM source_files WHERE account IN (${ph})`).all(...accountsFilter);
  }else if(Array.isArray(accountsFilter)&&accountsFilter.length===1){
    existingRows=db.prepare('SELECT source_id,account,filename,size,mtime_ns,ctime_ns,ino,unreadable,row_count,is_sqlite FROM source_files WHERE account=?').all(accountsFilter[0]);
  }else{
    existingRows=[];
  }

  const existingMap=new Map();
  const removedIds=[];
  const touchedAccounts=new Set();
  for(const row of existingRows){
    const key=`${row.account}/${row.filename}`;
    if(!activeMap.has(key)){
      removedIds.push(row.source_id);
      touchedAccounts.add(row.account);
    }else{
      existingMap.set(key,row);
    }
  }

  if(removedIds.length){
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const sid of removedIds){
        deleteRowsBySource.run(sid);
        deleteFileBySource.run(sid);
      }
      db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
  }

  // For a cold bulk build (>16 files on an empty index), defer secondary index creation
  // until after sequential inserts to avoid random SHA-256 B-tree page thrashing.
  const bulkBuild=existingRows.length===0&&activeMap.size>16&&db.prepare('SELECT 1 FROM source_files LIMIT 1').get()===undefined;
  if(bulkBuild){
    dropRowIndexes(db);
  }

  const markUnreadable=(existing,item,statSig)=>{
    touchedAccounts.add(item.account);
    db.exec('BEGIN IMMEDIATE');
    try{
      if(existing){
        deleteRowsBySource.run(existing.source_id);
        updateFile.run(statSig.size,statSig.mtimeNs,statSig.ctimeNs,statSig.ino,1,0,item.isSqlite,existing.source_id);
      }else{
        insertFile.run(item.account,item.filename,statSig.size,statSig.mtimeNs,statSig.ctimeNs,statSig.ino,1,0,item.isSqlite);
      }
      db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
  };

  const insertRowRecord=(sourceId,account,row)=>{
    const total=rowTotal(row);
    const day=row.at===null?null:resolveDay(row.at);
    upsertRow.run(
      sourceId,account,row.id,row.at,day,row.model,
      row.uncached??0,row.cacheRead??0,row.cacheWrite??0,row.output??0,
      total,row.partial?1:0
    );
  };

  let lastYield=Date.now();
  try{
  for(const [key,item] of activeMap){
    onCheck?.();
    if(yieldEveryMs>0&&Date.now()-lastYield>=yieldEveryMs){
      await yieldToEventLoop();
      onCheck?.();
      lastYield=Date.now();
    }

    // Capture pre-read lstat so concurrent modifications during read always invalidate on next summary.
    let info;
    try{
      info=await lstat(item.fullPath,{bigint:true});
    }catch(e){
      if(e.code==='ENOENT'){
        const existing=existingMap.get(key);
        if(existing){
          touchedAccounts.add(item.account);
          db.exec('BEGIN IMMEDIATE');
          try{deleteRowsBySource.run(existing.source_id);deleteFileBySource.run(existing.source_id);db.exec('COMMIT');}
          catch(err){try{db.exec('ROLLBACK');}catch{}throw err;}
        }
        continue;
      }
      markUnreadable(existingMap.get(key),item,{size:'-1',mtimeNs:'0',ctimeNs:'0',ino:'0'});
      continue;
    }

    const statSig={
      size:String(info.size),
      mtimeNs:String(info.mtimeNs),
      ctimeNs:String(info.ctimeNs),
      ino:String(info.ino),
    };
    const existing=existingMap.get(key);
    const forcedDirty=Boolean(dirtyFiles?.has(key));
    if(
      !forcedDirty&&existing&&
      existing.size===statSig.size&&
      existing.mtime_ns===statSig.mtimeNs&&
      existing.ctime_ns===statSig.ctimeNs&&
      existing.ino===statSig.ino
    ){
      continue;
    }

    if(info.isSymbolicLink()||!info.isFile()||info.size>BigInt(MAX_SOURCE_BYTES)){
      markUnreadable(existing,item,statSig);
      continue;
    }

    touchedAccounts.add(item.account);
    try{
      if(!item.isSqlite&&info.size<=BigInt(DIRECT_JSON_MAX_BYTES)&&typeof readRecord==='function'){
        // Small JSON path: uses readRecord (preserving ledger.readSummaryRecord hooks), no open SQLite txn across await.
        const text=await readRecord(item.fullPath);
        onCheck?.();
        const record=JSON.parse(text);
        if(record?.schema!==1||record.account!==item.account||!Array.isArray(record.records)||!record.records.every(validRow)){
          throw Error('Invalid usage ledger');
        }
        db.exec('BEGIN IMMEDIATE');
        try{
          let sourceId;
          if(existing){
            sourceId=existing.source_id;
            deleteRowsBySource.run(sourceId);
          }else{
            sourceId=Number(insertFile.run(item.account,item.filename,statSig.size,statSig.mtimeNs,statSig.ctimeNs,statSig.ino,0,0,0).lastInsertRowid);
          }
          for(const row of record.records)insertRowRecord(sourceId,item.account,row);
          updateFile.run(statSig.size,statSig.mtimeNs,statSig.ctimeNs,statSig.ino,0,record.records.length,0,sourceId);
          db.exec('COMMIT');
        }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
      }else if(!item.isSqlite){
        // Large JSON path: stream in 16 KiB chunks with bounded 512-row staging flushes; never parses whole file into V8.
        const stagingName=`.staging:${randomUUID()}`;
        let stagingId=null;
        db.exec('BEGIN IMMEDIATE');
        try{
          stagingId=Number(insertFile.run(item.account,stagingName,statSig.size,statSig.mtimeNs,statSig.ctimeNs,statSig.ino,1,0,0).lastInsertRowid);
          db.exec('COMMIT');
        }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}

        let batch=[];
        let count=0;
        const flushBatch=()=>{
          if(!batch.length)return;
          db.exec('BEGIN IMMEDIATE');
          try{
            for(const row of batch)insertRowRecord(stagingId,item.account,row);
            db.exec('COMMIT');
          }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
          batch=[];
        };
        try{
          const fields=Object.fromEntries(['id','at','model',...KEYS,'partial','timeBasis'].map(k=>[k,'scalar']));
          const parser=new TrajectoryJson({
            projection:{schema:'scalar',account:'scalar',records:{'*':fields}},
            recordKeys:['records'],
            onRecord:(kind,i,row)=>{
              onCheck?.();
              if(!validRow(row))throw Error('Invalid usage record');
              count++;
              batch.push(row);
              if(batch.length>=STREAM_BATCH_SIZE)flushBatch();
            },
          });
          for await(const chunk of createReadStream(item.fullPath,{encoding:'utf8',highWaterMark:16384})){
            onCheck?.();
            parser.write(chunk);
          }
          const value=parser.end();
          if(value.schema!==1||value.account!==item.account||!Array.isArray(value.records)){
            throw Error('Invalid usage account');
          }
          flushBatch();
          // Atomically swap staging source_id into live filename.
          db.exec('BEGIN IMMEDIATE');
          try{
            if(existing){
              deleteRowsBySource.run(existing.source_id);
              deleteFileBySource.run(existing.source_id);
            }
            renameFile.run(item.filename,statSig.size,statSig.mtimeNs,statSig.ctimeNs,statSig.ino,count,0,stagingId);
            db.exec('COMMIT');
          }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
        }catch(e){
          db.exec('BEGIN IMMEDIATE');
          try{
            deleteRowsBySource.run(stagingId);
            deleteFileBySource.run(stagingId);
            db.exec('COMMIT');
          }catch{try{db.exec('ROLLBACK');}catch{}}
          throw e;
        }
      }else{
        // SQLite conversation ledger: stream synchronously via cursor directly into indexDb.
        const srcDb=new DatabaseSync(item.fullPath,{readOnly:true});
        try{
          if(srcDb.prepare('SELECT account FROM meta').get()?.account!==item.account){
            throw Error('Invalid usage account');
          }
          db.exec('BEGIN IMMEDIATE');
          try{
            let sourceId;
            if(existing){
              sourceId=existing.source_id;
              deleteRowsBySource.run(sourceId);
            }else{
              sourceId=Number(insertFile.run(item.account,item.filename,statSig.size,statSig.mtimeNs,statSig.ctimeNs,statSig.ino,0,0,1).lastInsertRowid);
            }
            let count=0;
            for(const r of srcDb.prepare('SELECT j FROM records ORDER BY rowid').iterate()){
              onCheck?.();
              const value=JSON.parse(r.j);
              if(!validRow(value))throw Error('Invalid usage record');
              insertRowRecord(sourceId,item.account,value);
              count++;
            }
            updateFile.run(statSig.size,statSig.mtimeNs,statSig.ctimeNs,statSig.ino,0,count,1,sourceId);
            db.exec('COMMIT');
          }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
        }finally{
          srcDb.close();
        }
      }
    }catch(error){
      if(isCancelError(error))throw error;
      markUnreadable(existing,item,statSig);
    }
  }
  }finally{
    if(bulkBuild)await createRowIndexesCooperative(db,{yieldEveryMs,onCheck});
  }

  if(touchedAccounts.size){
    const delCache=db.prepare('DELETE FROM scope_summary_cache WHERE scope=?');
    db.exec('BEGIN IMMEDIATE');
    try{
      delCache.run('all');
      for(const acct of touchedAccounts)delCache.run(acct);
      db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
  }
}

export async function findForeignRequestIds({
  directory,
  scope,
  localScope='',
  requestIds=[],
  timeZone='Asia/Shanghai',
  readRecord=null,
  dirtyFiles=null,
  onCheck=null,
  yieldEveryMs=0,
  busyTimeoutMs=250,
}={}){
  const foreign=new Set();
  if(!directory||!scope||scope===localScope||!Array.isArray(requestIds)||!requestIds.length)return foreign;
  const uniqueIds=[...new Set(requestIds.filter(id=>HASH.test(id)))];
  if(!uniqueIds.length)return foreign;
  onCheck?.();
  const buckets=await discoverBuckets(directory,'all',null);
  onCheck?.();
  const otherBuckets=buckets.filter(b=>b.dir!==scope&&b.dir!==localScope&&activeFilesForBucket(b.files).length>0);
  if(!otherBuckets.length)return foreign;

  const activeMap=new Map();
  const otherAccounts=[];
  for(const entry of otherBuckets){
    otherAccounts.push(entry.dir);
    for(const filename of activeFilesForBucket(entry.files)){
      activeMap.set(`${entry.dir}/${filename}`,{
        account:entry.dir,
        filename,
        fullPath:join(directory,entry.dir,filename),
        isSqlite:filename.endsWith('.sqlite')?1:0,
      });
    }
  }

  const db=await openIndexDb(directory,timeZone,{busyTimeoutMs});
  try{
    await syncActiveFilesIntoDb(db,{
      activeMap,
      allBuckets:false,
      accountsFilter:otherAccounts,
      resolveDay:createDateKeyResolver(timeZone),
      readRecord,
      dirtyFiles,
      onCheck,
      yieldEveryMs,
    });
    const CHUNK=400;
    for(let i=0;i<uniqueIds.length;i+=CHUNK){
      onCheck?.();
      const slice=uniqueIds.slice(i,i+CHUNK);
      const ph=slice.map(()=>'?').join(',');
      const stmt=db.prepare(
        `SELECT DISTINCT request_id FROM source_rows WHERE account != ? AND account != ? AND request_id IN (${ph})`
      );
      for(const row of stmt.all(scope,localScope,...slice)){
        foreign.add(row.request_id);
      }
    }
  }finally{
    db.close();
  }
  return foreign;
}

export async function syncAndSummarizeIndex({
  directory,
  scope,
  buckets=null,
  now=Date.now(),
  timeZone='Asia/Shanghai',
  source='desktop-local',
  localScope='',
  quotaAccount=null,
  quotaGroups=null,
  quotaWindowSpecs=null,
  classifyQuotaGroupId=null,
  readRecord=null,
  dirtyFiles=null,
  onCheck=null,
  yieldEveryMs=0,
  busyTimeoutMs=yieldEveryMs>0?250:5000,
}){
  const allBuckets=scope==='all';
  const specs=Array.isArray(quotaWindowSpecs)?quotaWindowSpecs:[];
  const groupInfos=Array.isArray(quotaGroups)?quotaGroups:[];
  const resolveDay=createDateKeyResolver(timeZone);
  const today=resolveDay(now);

  onCheck?.();
  const bucketEntries=await discoverBuckets(directory,scope,buckets);
  onCheck?.();

  // Build active source file list across scanned buckets.
  const activeMap=new Map(); // `${account}/${filename}` -> { account, filename, fullPath, isSqlite }
  for(const entry of bucketEntries){
    for(const filename of activeFilesForBucket(entry.files)){
      activeMap.set(`${entry.dir}/${filename}`,{
        account:entry.dir,
        filename,
        fullPath:join(directory,entry.dir,filename),
        isSqlite:filename.endsWith('.sqlite')?1:0,
      });
    }
  }

  // Avoid creating an index DB on disk for empty/nonexistent directories.
  if(activeMap.size===0&&!(await indexExists(directory))){
    return emptySummary({allBuckets,scope,timeZone,today,now,source,hasSpecs:specs.length>0});
  }

  const db=await openIndexDb(directory,timeZone,{busyTimeoutMs});
  try{
    await syncActiveFilesIntoDb(db,{
      activeMap,
      allBuckets,
      accountsFilter:allBuckets?null:[scope],
      resolveDay,
      readRecord,
      dirtyFiles,
      onCheck,
      yieldEveryMs,
    });

    onCheck?.();
    if(yieldEveryMs>0){
      await yieldToEventLoop();
      onCheck?.();
    }

    const cachedAggRow=db.prepare('SELECT payload FROM scope_summary_cache WHERE scope=? AND time_zone=?').get(scope,timeZone);
    let days,models,unknownTokens,unknownRequests,partialRequests,totalRequests,unreadable,accountsCount;
    if(cachedAggRow){
      const parsed=JSON.parse(cachedAggRow.payload);
      days=parsed.days;
      models=parsed.models;
      unknownTokens=parsed.unknownTokens;
      unknownRequests=parsed.unknownRequests;
      partialRequests=parsed.partialRequests;
      totalRequests=parsed.totalRequests;
      unreadable=parsed.unreadable;
      accountsCount=parsed.accountsCount;
    }else{
      // Aggregate deduplicated rows in SQLite (O(1) memory in V8).
      const aggSql=allBuckets
        ? `WITH winners AS (
             SELECT request_id, day, model, uncached, cache_read, cache_write, output, total, partial,
                    ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY total DESC, source_id ASC) AS rn
             FROM source_rows
           )
           SELECT day, model,
                  SUM(uncached) AS uncached,
                  SUM(cache_read) AS cacheRead,
                  SUM(cache_write) AS cacheWrite,
                  SUM(output) AS output,
                  SUM(total) AS total,
                  COUNT(*) AS requests,
                  SUM(partial) AS partialRequests
           FROM winners
           WHERE rn = 1
           GROUP BY day, model
           ORDER BY day, model`
        : `WITH winners AS (
             SELECT request_id, day, model, uncached, cache_read, cache_write, output, total, partial,
                    ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY total DESC, source_id ASC) AS rn
             FROM source_rows
             WHERE account = ?
           )
           SELECT day, model,
                  SUM(uncached) AS uncached,
                  SUM(cache_read) AS cacheRead,
                  SUM(cache_write) AS cacheWrite,
                  SUM(output) AS output,
                  SUM(total) AS total,
                  COUNT(*) AS requests,
                  SUM(partial) AS partialRequests
           FROM winners
           WHERE rn = 1
           GROUP BY day, model
           ORDER BY day, model`;

      const aggStmt=db.prepare(aggSql);
      const iter=allBuckets?aggStmt.iterate():aggStmt.iterate(scope);

      days=[];
      const modelSet=new Set();
      let usedBytes=0;
      unknownTokens=0;unknownRequests=0;partialRequests=0;totalRequests=0;
      for(const row of iter){
        onCheck?.();
        modelSet.add(row.model);
        partialRequests+=row.partialRequests;
        totalRequests+=row.requests;
        if(row.day===null){
          unknownTokens+=row.total;
          unknownRequests+=row.requests;
          continue;
        }
        const values={
          uncached:row.uncached,
          cacheRead:row.cacheRead,
          cacheWrite:row.cacheWrite,
          output:row.output,
          total:row.total,
          requests:row.requests,
        };
        usedBytes+=Buffer.byteLength(row.day)+Buffer.byteLength(row.model)+96;
        if(usedBytes>RESULT_BUDGET_BYTES)throw Error('Usage summary exceeds result budget');
        let day=days.at(-1);
        if(day?.date!==row.day){
          day={date:row.day,models:{}};
          days.push(day);
        }
        Object.defineProperty(day.models,row.model,{value:values,enumerable:true,configurable:true,writable:true});
      }

      models=[...modelSet].sort();
      for(const m of models){
        usedBytes+=Buffer.byteLength(m);
        if(usedBytes>RESULT_BUDGET_BYTES)throw Error('Usage summary exceeds result budget');
      }

      unreadable=allBuckets
        ? db.prepare('SELECT COUNT(*) AS n FROM source_files WHERE unreadable=1').get().n
        : db.prepare('SELECT COUNT(*) AS n FROM source_files WHERE account=? AND unreadable=1').get(scope).n;

      accountsCount=allBuckets
        ? db.prepare('SELECT COUNT(DISTINCT account) AS n FROM source_files WHERE unreadable=0 AND account!=? AND (row_count>0 OR is_sqlite=1)').get(localScope).n
        : undefined;

      const payload=JSON.stringify({days,models,unknownTokens,unknownRequests,partialRequests,totalRequests,unreadable,accountsCount});
      if(Buffer.byteLength(payload)<=RESULT_BUDGET_BYTES){
        db.exec('BEGIN IMMEDIATE');
        try{
          db.prepare('INSERT INTO scope_summary_cache(scope,time_zone,payload) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET time_zone=excluded.time_zone,payload=excluded.payload').run(scope,timeZone,payload);
          db.exec('COMMIT');
        }catch{try{db.exec('ROLLBACK');}catch{}}
      }
    }

    let quotaWindowCounts;
    if(specs.length){
      if(yieldEveryMs>0){
        await yieldToEventLoop();
        onCheck?.();
      }
      quotaWindowCounts={};
      if(quotaAccount&&typeof classifyQuotaGroupId==='function'){
        let minStart=Infinity,maxEnd=-Infinity;
        for(const s of specs){
          if(s.startAt<minStart)minStart=s.startAt;
          if(s.endAt>maxEnd)maxEnd=s.endAt;
        }
        if(Number.isFinite(minStart)&&Number.isFinite(maxEnd)){
          const modelAliases=pricing.buildShortAliases(models);
          const winStmt=allBuckets
            ? db.prepare(`
                WITH winners AS (
                  SELECT s.request_id, s.at, s.day, s.model, s.uncached, s.cache_read, s.cache_write, s.output, s.total,
                         ROW_NUMBER() OVER (PARTITION BY s.request_id ORDER BY s.total DESC, s.source_id ASC) AS rn
                  FROM source_rows s
                  WHERE s.request_id IN (
                    SELECT DISTINCT r.request_id
                    FROM source_rows r
                    WHERE r.at IS NOT NULL AND r.at >= ? AND r.at <= ?
                      AND EXISTS (
                        SELECT 1 FROM source_rows q
                        WHERE q.account = ? AND q.request_id = r.request_id
                      )
                  )
                )
                SELECT at, day, model, uncached, cache_read, cache_write, output, total
                FROM winners
                WHERE rn = 1 AND at IS NOT NULL AND at >= ? AND at <= ?
              `)
            : (scope===quotaAccount
              ? db.prepare(`
                  WITH winners AS (
                    SELECT s.request_id, s.at, s.day, s.model, s.uncached, s.cache_read, s.cache_write, s.output, s.total,
                           ROW_NUMBER() OVER (PARTITION BY s.request_id ORDER BY s.total DESC, s.source_id ASC) AS rn
                    FROM source_rows s
                    WHERE s.account = ?
                      AND s.request_id IN (
                        SELECT DISTINCT request_id
                        FROM source_rows
                        WHERE account = ? AND at IS NOT NULL AND at >= ? AND at <= ?
                      )
                  )
                  SELECT at, day, model, uncached, cache_read, cache_write, output, total
                  FROM winners
                  WHERE rn = 1 AND at IS NOT NULL AND at >= ? AND at <= ?
                `)
              : null);

          if(winStmt){
            const winIter=allBuckets
              ? winStmt.iterate(minStart,maxEnd,quotaAccount,minStart,maxEnd)
              : winStmt.iterate(scope,scope,minStart,maxEnd,minStart,maxEnd);
            for(const r of winIter){
              onCheck?.();
              const gid=classifyQuotaGroupId(groupInfos,r.model);
              const day=r.day||resolveDay(r.at)||'';
              const cost=pricing.requestCostUsd(r,day,modelAliases);
              for(const spec of specs){
                if(spec.groupId===gid&&r.at>=spec.startAt&&r.at<=spec.endAt){
                  const item=quotaWindowCounts[spec.id]||{observedTokens:0,observedCostUsd:0,pricedTokens:0,requests:0};
                  item.observedTokens+=r.total;
                  if(cost!==null){
                    item.observedCostUsd+=cost;
                    item.pricedTokens+=r.total;
                  }
                  item.requests++;
                  quotaWindowCounts[spec.id]=item;
                }
              }
            }
          }
        }
      }
    }

    const sumDay=d=>Object.values(d.models).reduce((n,r)=>n+r.total,0);
    const weekStartDate=indexWeekStart(today);
    const monthPrefix=today.slice(0,7);
    let todayTokens=0,weekTokens=0,monthTokens=0,datedTokens=0;
    for(const d of days){
      const t=sumDay(d);
      datedTokens+=t;
      if(d.date===today)todayTokens+=t;
      if(d.date>=weekStartDate&&d.date<=today)weekTokens+=t;
      if(d.date.slice(0,7)===monthPrefix&&d.date<=today)monthTokens+=t;
    }

    return {
      accountKey:allBuckets?'all-local':scope,
      timeZone,
      today,
      days,
      models,
      todayTokens,
      weekTokens,
      monthTokens,
      totalTokens:datedTokens+unknownTokens,
      unknownTokens,
      unknownRequests,
      partialRequests,
      unreadableFiles:unreadable,
      requests:totalRequests,
      firstDate:days[0]?.date||null,
      updatedAt:new Date(now).toISOString(),
      source,
      ...(allBuckets?{accountsCount}:{}),
      ...(specs.length?{quotaWindowCounts}:{}),
    };
  }finally{
    db.close();
  }
}
