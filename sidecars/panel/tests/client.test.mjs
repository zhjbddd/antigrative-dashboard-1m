import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AntigravityClient,serverFromDiscovery,isRestrictedRpcError} from '../client.mjs';
import {discoverDaemonFiles,httpLogPorts,isRemoteHubCommand,readLogTail} from '../discovery.mjs';

// Synthetic RPC fixtures own every accepted socket. End them explicitly:
// HTTP keep-alive teardown must not hold the cross-platform test runner open.
const stopServer=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});

test('invalid projected JSON settles even when destroying a sent request emits no error',async t=>{
 const original=http.request;let destroyed=false;
 http.request=(_options,onResponse)=>{
  const req=new EventEmitter();req.setTimeout=()=>req;
  req.destroy=()=>{destroyed=true;req.emit('close');return req;};
  req.end=()=>queueMicrotask(()=>{
   const res=new EventEmitter();res.statusCode=200;res.setEncoding=()=>res;
   onResponse(res);res.emit('data','{broken');res.emit('end');
  });return req;
 };
 syncBuiltinESMExports();t.after(()=>{http.request=original;syncBuiltinESMExports();});
 const client=new AntigravityClient({now:()=>0});client.server={port:1234,csrf:'fixture',pid:42};
 let timer;
 try{await Promise.race([
  assert.rejects(client.call('GetCascadeTrajectory'),error=>error.message==='Antigravity 接口返回了无法解析的数据'),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Invalid stream left the RPC pending')),1000);})
 ]);}finally{clearTimeout(timer);}
 assert.equal(destroyed,true);
});
async function fixture(t){
 const state={scans:0,now:100000,status:404,body:'{}',requests:0};
 const server=createServer((req,res)=>{state.requests++;req.resume();res.writeHead(state.status,{'Content-Type':'application/json'});res.end(state.body);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>stopServer(server));
 state.port=server.address().port;state.pid=42;
 const client=new AntigravityClient({now:()=>state.now,paths:()=>({log:'fixture'}),readLog:async()=>`listening on random port at ${state.port} for HTTP\n`,
  processes:async()=>{state.scans++;return [{ProcessId:state.pid,CommandLine:'language_server --standalone --csrf_token=fixture',Ports:[state.port]}];}});
 return {client,state,server};
}

test('unavailable history and malformed RPC replies never invalidate a healthy endpoint',async t=>{
 const {client,state}=await fixture(t);
 const rejects=async(method,body)=>{
  let timer;
  try{await Promise.race([assert.rejects(client.call(method,body)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`RPC fixture stalled: status=${state.status}, requests=${state.requests}, method=${method}`)),10000);})]);}
  finally{clearTimeout(timer);}
 };
 for(const status of [400,404,409,429,500,503]){
  state.status=status;
  for(let i=0;i<3;i++)await rejects('GetCascadeTrajectory',{cascadeId:'missing'});
 }
 state.status=200;state.body='{broken';await rejects('GetCascadeTrajectory');
 state.body='{}';assert.deepEqual(await client.call('GetUserStatus'),{});
 assert.equal(state.scans,1,'Conversation/protocol failures must not spawn another process scan');
 assert.equal(state.requests,20,'Application failures are not blindly retried');
 assert.ok(client.server);
});

test('ordinary RPC JSON errors never expose a private response fragment',async t=>{
 const {client,state}=await fixture(t);state.status=200;state.body='{"private":"DO_NOT_DISCLOSE" invalid}';
 await assert.rejects(client.call('GetUserStatus'),error=>error.message==='Antigravity 接口返回了无法解析的数据');
 state.body='{}';assert.deepEqual(await client.call('GetUserStatus'),{});assert.equal(state.scans,1);
});

test('conversation-list RPC keeps delegation metadata while discarding embedded messages',async t=>{
 const {client,state}=await fixture(t);state.status=200;
 const root='11111111-1111-1111-1111-111111111111',child='22222222-2222-2222-2222-222222222222';
 state.body=JSON.stringify({trajectorySummaries:{[root]:{stepCount:4,status:'IDLE'},[child]:{
  stepCount:2,hasActiveChildren:true,trajectoryMetadata:{parentConversationId:root,rootConversationId:root,subagentSpec:{initialPrompt:'PRIVATE_PROMPT'}},
  latestNotifyUserStep:{message:'PRIVATE_REPLY'},waitingSteps:[{response:'PRIVATE_TOOL'}],
 }}});
 const result=await client.call('GetAllCascadeTrajectories',{excludeSubtrajectories:false});
 assert.equal(result.trajectorySummaries[child].trajectoryMetadata.parentConversationId,root);
 assert.equal(result.trajectorySummaries[child].hasActiveChildren,true);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|subagentSpec|waitingSteps|latestNotifyUserStep/);
});

test('cold-start discovery failures coalesce and back off while the backend starts',async()=>{
 let now=0,scans=0,ready=false;
 const client=new AntigravityClient({now:()=>now,paths:()=>({log:'fixture'}),readLog:async()=> 'listening on random port at 1234 for HTTP\n',
  processes:async()=>{scans++;return ready?[{ProcessId:42,CommandLine:'language_server --standalone --csrf_token=fixture',Ports:[1234]}]:[];}});
 await Promise.allSettled(Array.from({length:20},()=>client.discover()));assert.equal(scans,1);
 for(let i=0;i<20;i++)await assert.rejects(client.discover());assert.equal(scans,1);
 now=3000;await assert.rejects(client.discover());assert.equal(scans,2);
 now=4000;ready=true;await assert.rejects(client.discover());assert.equal(scans,2);
 now=9000;assert.equal((await client.discover()).pid,42);assert.equal(scans,3);
});

test('authorization failures have a cooldown, then rediscover without disabling the plugin',async t=>{
 const {client,state}=await fixture(t);state.status=401;
 for(let i=0;i<10;i++)await assert.rejects(client.call('GetUserStatus'));
 assert.equal(state.scans,1);assert.equal(state.requests,1);
 state.now+=3000;state.status=200;
 assert.deepEqual(await client.call('GetUserStatus'),{});assert.equal(state.scans,2);
});

test('a refused old port rediscovers a restarted backend once, without toggling the plugin',async t=>{
 const {client,state,server}=await fixture(t);state.status=200;
 await client.call('GetUserStatus');assert.equal(state.scans,1);
 await stopServer(server);
 const replacement=createServer((req,res)=>{req.resume();res.end('{}');});
 await new Promise(r=>replacement.listen(0,'127.0.0.1',r));t.after(()=>stopServer(replacement));
 state.port=replacement.address().port;state.pid=43;state.now+=3000;
 assert.deepEqual(await client.call('GetUserStatus'),{});
 assert.equal(client.server.pid,43);assert.equal(state.scans,2);
});

test('healthy HTTP 200 RPCs renew discovery lease past 15s while auth or socket errors still rediscover',async t=>{
 const {client,state,server}=await fixture(t);state.status=200;state.now=0;
 await client.call('GetUserStatus');assert.equal(state.scans,1);
 state.now=10000;await client.call('GetUserStatus');assert.equal(state.scans,1);
 state.now=20000;await client.call('GetUserStatus');assert.equal(state.scans,1,'Healthy call at 10s extended lease past 15s');
 state.now=30000;await client.call('GetUserStatus');assert.equal(state.scans,1);
 state.status=401;state.now=34000;
 await assert.rejects(client.call('GetUserStatus'));
 assert.equal(state.scans,2,'401 invalidates endpoint and triggers rediscovery');
 state.status=200;state.now=38000;
 await client.call('GetUserStatus');assert.equal(state.scans,3);
 await stopServer(server);
 const replacement=createServer((req,res)=>{req.resume();res.end('{}');});
 await new Promise(r=>replacement.listen(0,'127.0.0.1',r));t.after(()=>stopServer(replacement));
 state.port=replacement.address().port;state.pid=43;state.now=42000;
 assert.deepEqual(await client.call('GetUserStatus'),{});
 assert.equal(state.scans,4);assert.equal(client.server.pid,43);
});

test('readLogTail extracts newest HTTP port from >1 MiB logs both at tail and behind >512 KiB of noise',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ag-log-tail-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tailFile=join(dir,'tail.log');
 await writeFile(tailFile,'listening on random port at 1111 for HTTP\n'+'x'.repeat(1100*1024)+'\nlistening on random port at 2222 for HTTP\n');
 assert.equal(httpLogPorts(await readLogTail(tailFile,'utf8'))[0],2222);
 const headFile=join(dir,'head.log');
 await writeFile(headFile,'listening on random port at 3333 for HTTP\n'+'y'.repeat(700*1024)+'\n');
 assert.deepEqual(httpLogPorts(await readLogTail(headFile,'utf8')),[3333]);
});

test('idle lease expiry verifies live PID and loopback port without spawning PowerShell scans',async t=>{
 let scans=0,now=0,alive=true,probes=0;
 const server=createServer((req,res)=>{req.resume();res.end('{}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>stopServer(server));
 const port=server.address().port,pid=process.pid;
 const client=new AntigravityClient({
  now:()=>now,
  paths:()=>({log:'fixture'}),
  readLog:async()=>`listening on random port at ${port} for HTTP\n`,
  processes:async()=>{scans++;return [{ProcessId:pid,CommandLine:'language_server --standalone --csrf_token=fixture',Ports:[port]}];},
  pidAlive:value=>value===pid&&alive,
  probe:async(p,options)=>{probes++;return p===port&&options.timeoutMs<=400;},
 });
 assert.equal((await client.discover()).port,port);assert.equal(scans,1);assert.equal(probes,0);
 // Idle for 25s (>15s lease): liveness check renews lease without running processes().
 now=25000;
 assert.equal((await client.discover()).port,port);assert.equal(scans,1);assert.equal(probes,1);
 // Subsequent call inside the renewed 15s window needs neither probe nor scan.
 now=35000;
 assert.equal((await client.discover()).port,port);assert.equal(scans,1);assert.equal(probes,1);
 // When the cached PID exits, discovery immediately falls back to a full process scan.
 alive=false;now=60000;
 assert.equal((await client.discover()).port,port);assert.equal(scans,2);assert.equal(probes,1);
 // Explicit force=true always runs a full process scan.
 alive=true;now=61000;
 assert.equal((await client.discover(true)).port,port);assert.equal(scans,3);
});

test('2.34.0+ falls back to sidecar ANTIGRAVITY_CSRF_TOKEN when --csrf_token is absent from cmdline',async ()=>{
 const log='listening on random port at 50831 for HTTP\n';
 const rows=[{ProcessId:15732,CommandLine:'language_server.exe --standalone --override_ide_version 2.34.0 --enable_sidecars --read_host_bridge_token_from_stdin',Ports:[50830,50831]}];
 assert.throws(()=>serverFromDiscovery(log,rows,{env:{}}),/本地检测凭据/);
 const discovered=serverFromDiscovery(log,rows,{env:{ANTIGRAVITY_CSRF_TOKEN:'scoped-secret'}});
 assert.deepEqual(discovered,{port:50831,csrf:'scoped-secret',pid:15732});
 assert.equal(discovered.credentialSource,'sidecar-env');

 // Missing log falls back to loopback ANTIGRAVITY_LS_ADDRESS only when PID-owned and plain HTTP.
 const noLogClient=new AntigravityClient({
  paths:()=>({log:'missing.log',logCandidates:['missing.log']}),
  readLog:async()=>{throw Object.assign(new Error('ENOENT'),{code:'ENOENT'});},
  processes:async()=>rows,
  env:{ANTIGRAVITY_CSRF_TOKEN:'scoped-secret',ANTIGRAVITY_LS_ADDRESS:'http://127.0.0.1:50831'},
 });
 const envEndpoint=await noLogClient.discover();
 assert.deepEqual(envEndpoint,{port:50831,csrf:'scoped-secret',pid:15732});

 // Rejects non-loopback, HTTPS-only, and foreign-PID env addresses.
 for(const badAddr of ['http://192.168.1.5:50831','https://127.0.0.1:50830','127.0.0.1:9999']){
  const rejected=new AntigravityClient({
   paths:()=>({log:'missing.log',logCandidates:['missing.log']}),
   readLog:async()=>{throw Object.assign(new Error('ENOENT'),{code:'ENOENT'});},
   processes:async()=>rows,
   env:{ANTIGRAVITY_CSRF_TOKEN:'scoped-secret',ANTIGRAVITY_LS_ADDRESS:badAddr},
  });
  await assert.rejects(rejected.discover(),/语言服务日志/);
 }
});

test('verified sidecar-env endpoint treats single-RPC HTTP 403 as restricted without invalidating endpoint',async t=>{
 let scans=0,quotaStatus=200,userStatus=200,now=10000;
 const server=createServer((req,res)=>{
  req.resume();
  const isQuota=req.url.endsWith('/RetrieveUserQuotaSummary');
  res.writeHead(isQuota?quotaStatus:userStatus,{'Content-Type':'application/json'});
  res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>stopServer(server));
 const port=server.address().port;
 const client=new AntigravityClient({
  now:()=>now,
  paths:()=>({log:'fixture'}),
  readLog:async()=>`listening on random port at ${port} for HTTP\n`,
  processes:async()=>{scans++;return [{ProcessId:42,CommandLine:'language_server.exe --standalone --override_ide_version 2.34.0',Ports:[port]}];},
  env:{ANTIGRAVITY_CSRF_TOKEN:'sidecar-scoped'},
 });
 assert.deepEqual(await client.call('GetUserStatus'),{});
 assert.equal(scans,1);
 // Once verified, a 403 on another RPC is marked restricted and keeps the healthy endpoint.
 quotaStatus=403;
 await assert.rejects(client.call('RetrieveUserQuotaSummary'),err=>isRestrictedRpcError(err)&&err.status===403&&err.method==='RetrieveUserQuotaSummary');
 assert.equal(scans,1,'Single restricted RPC must not trigger process rescan');
 assert.ok(client.server,'Verified endpoint stays intact');
 // A 401 still invalidates the endpoint and rediscovers after cooldown.
 userStatus=401;now+=4000;
 await assert.rejects(client.call('GetUserStatus'),err=>err.status===401&&!isRestrictedRpcError(err));
 assert.equal(scans,2);
});

test('2.34.0+ daemon ls_*.json and hub_*.json discovery prefers unrestricted daemon token over scoped sidecar-env',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ag-daemon-disc-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 // Stale file for dead PID, mismatched port for live PID, corrupt JSON, and unrelated file must be ignored/filtered.
 await writeFile(join(dir,'hub_40001.json'),JSON.stringify({pid:99999,httpPort:40001,httpsPort:40000,lsVersion:'2.34.0',csrfToken:'stale-pid-token'}));
 await writeFile(join(dir,'ls_staleport.json'),JSON.stringify({pid:24680,httpPort:49999,httpsPort:49998,lsVersion:'2.34.0',csrfToken:'wrong-port-token'}));
 await writeFile(join(dir,'ls_corrupt.json'),'{not valid json');
 await writeFile(join(dir,'other.json'),JSON.stringify({pid:24680,httpPort:51234,csrfToken:'ignored-name'}));
 const liveFile=join(dir,'ls_abc123.json');
 await writeFile(liveFile,JSON.stringify({pid:24680,httpsPort:51233,httpPort:51234,lspPort:0,lsVersion:'2.34.0',csrfToken:'unrestricted-daemon-token'}));
 await utimes(liveFile,new Date(Date.now()+5000),new Date(Date.now()+5000));

 const parsedFiles=await discoverDaemonFiles(dir);
 assert.equal(parsedFiles[0].file,'ls_abc123.json');
 assert.equal(parsedFiles.some(f=>f.file==='other.json'||f.file==='ls_corrupt.json'),false);

 const sshCmd='/home/user/.antigravity-hub-server/bin/2.34.0-x64/language_server --standalone --subclient_type hub --https_server_port 0 --workspace_id agy-hub-ssh';
 assert.equal(isRemoteHubCommand(sshCmd),true);
 assert.equal(isRemoteHubCommand('language_server.exe --standalone --subclient_type hub'),false);

 const rows=[{ProcessId:24680,CommandLine:sshCmd,Ports:[51233,51234,4321]}];
 let seenExpected=null;
 const client=new AntigravityClient({
  paths:()=>({log:'missing.log',logCandidates:['missing.log'],daemonDir:dir}),
  readLog:async()=>{throw Object.assign(new Error('ENOENT'),{code:'ENOENT'});},
  pidAlive:pid=>pid===24680,
  processes:async opts=>{seenExpected=opts?.expectedPorts||[];return rows;},
  env:{ANTIGRAVITY_CSRF_TOKEN:'scoped-sidecar-token',ANTIGRAVITY_LS_ADDRESS:'http://127.0.0.1:51234'},
 });
 const endpoint=await client.discover();
 assert.deepEqual(endpoint,{port:51234,csrf:'unrestricted-daemon-token',pid:24680});
 assert.equal(endpoint.credentialSource,'daemon-file');
 assert.equal(endpoint.remoteHub,true);
 assert.ok(seenExpected.includes(51234),'Live daemon httpPort should be passed as expectedPort hint');

 // Desktop hub_*.json also works and overrides a stale log whose old HTTP port was reused by gRPC (4321).
 const hubDir=await mkdtemp(join(tmpdir(),'ag-hub-disc-'));t.after(()=>rm(hubDir,{recursive:true,force:true}));
 await writeFile(join(hubDir,'hub_51234.json'),JSON.stringify({pid:24680,httpsPort:51233,httpPort:51234,lsVersion:'2.35.0',csrfToken:'desktop-hub-token'}));
 const desktopClient=new AntigravityClient({
  paths:()=>({log:'stale.log',logCandidates:['stale.log'],daemonDir:hubDir}),
  readLog:async()=>'listening on random port at 4321 for HTTP\n',
  processes:async()=>[{ProcessId:24680,CommandLine:'language_server.exe --standalone --subclient_type hub --override_ide_version 2.35.0',Ports:[4321,51233,51234]}],
  env:{},
 });
 const desktopEndpoint=await desktopClient.discover();
 assert.deepEqual(desktopEndpoint,{port:51234,csrf:'desktop-hub-token',pid:24680});
 assert.equal(desktopEndpoint.credentialSource,'daemon-file');
 assert.equal(desktopEndpoint.remoteHub,false);

 // Multi-instance disambiguation uses ANTIGRAVITY_LS_ADDRESS when it uniquely matches one live standalone process.
 const multi=serverFromDiscovery('',[
  {ProcessId:100,CommandLine:sshCmd,Ports:[51000,51001]},
  {ProcessId:200,CommandLine:sshCmd,Ports:[52000,52001]},
 ],{
  env:{ANTIGRAVITY_LS_ADDRESS:'http://127.0.0.1:52001',ANTIGRAVITY_CSRF_TOKEN:'scoped'},
  daemonFiles:[{pid:200,httpPort:52001,httpsPort:52000,csrfToken:'hub-200-token'}],
 });
 assert.deepEqual(multi,{port:52001,csrf:'hub-200-token',pid:200});
 assert.equal(multi.credentialSource,'daemon-file');
});

test('sidecar-env self-heals to daemon-file on HTTP 403 once ls_*.json appears without extra process scans',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ag-daemon-upgrade-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let scans=0,now=10000;
 const server=createServer((req,res)=>{
  req.resume();
  const token=req.headers['x-codeium-csrf-token'];
  const isQuota=req.url.endsWith('/RetrieveUserQuotaSummary');
  const status=isQuota&&token==='scoped-token'?403:200;
  res.writeHead(status,{'Content-Type':'application/json'});
  res.end(JSON.stringify({ok:status===200,tokenSource:token}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>stopServer(server));
 const port=server.address().port;
 const client=new AntigravityClient({
  now:()=>now,
  paths:()=>({log:'fixture.log',logCandidates:['fixture.log'],daemonDir:dir}),
  readLog:async()=>`listening on random port at ${port} for HTTP\n`,
  processes:async()=>{scans++;return [{ProcessId:777,CommandLine:'/home/u/.antigravity-hub-server/bin/2.34.0-x64/language_server --standalone --workspace_id agy-hub-ssh',Ports:[port]}];},
  env:{ANTIGRAVITY_CSRF_TOKEN:'scoped-token'},
 });
 // Initially no daemon file exists -> falls back to sidecar-env.
 assert.equal((await client.call('GetUserStatus')).tokenSource,'scoped-token');
 assert.equal(client.server.credentialSource,'sidecar-env');
 assert.equal(scans,1);

 // Daemon discovery file is now written by LS; first 403 on restricted RPC upgrades transparently without rescanning processes.
 await writeFile(join(dir,'ls_late.json'),JSON.stringify({pid:777,httpPort:port,httpsPort:port+1,lsVersion:'2.34.0',csrfToken:'full-daemon-token'}));
 const quota=await client.call('RetrieveUserQuotaSummary');
 assert.deepEqual(quota,{ok:true,tokenSource:'full-daemon-token'});
 assert.equal(client.server.credentialSource,'daemon-file');
 assert.equal(scans,1,'Upgrading from daemon file must not trigger a process scan');
});
