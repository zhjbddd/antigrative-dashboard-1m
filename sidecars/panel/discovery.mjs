import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';

const exec = promisify(execFile);
const languageServer = command => /(?:^|[\/\\])language_server(?:_(?:linux|macos|darwin)(?:_(?:x64|arm64))?)?(?:\.exe)?(?:\s|$)/.test(command);
const DAEMON_DISCOVERY_FILE = /^(?:ls|hub)_[^/\\]+\.json$/i;

export function isRemoteHubCommand(commandLine) {
  const cmd = String(commandLine || '');
  return /(?:^|\s)--workspace_id(?:=|\s+)["']?[^"'\s]*ssh\b/i.test(cmd)
    || /[\/\\]\.antigravity-hub-server[\/\\]/i.test(cmd);
}

export function httpLogPorts(log) {
  const ports=new Set();
  for(const match of log.matchAll(/listening on random port at (\d+) for HTTP(?:\s|$)/g)){
    const port=Number(match[1]);if(port<1||port>65535)continue;
    // Keep the most recent occurrence first without retaining complete logs.
    ports.delete(port);ports.add(port);
  }
  return [...ports].reverse();
}

export async function readLogTail(file, encoding = 'utf8', { chunkBytes = 256 * 1024, maxScanBytes = 64 * 1024 * 1024 } = {}) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= 0) return '';
    if (size <= chunkBytes) {
      const buf = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buf, offset, size - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buf.subarray(0, offset).toString(encoding);
    }
    const buf = Buffer.allocUnsafe(chunkBytes);
    const overlap = 128;
    const found = [];
    let scanned = 0, end = size, extraAfterMatch = 0;
    while (end > 0 && scanned < maxScanBytes && found.length < 8) {
      const hadMatch = found.length > 0;
      const start = Math.max(0, end - chunkBytes), len = end - start;
      let readTotal = 0;
      while (readTotal < len) {
        const { bytesRead } = await handle.read(buf, readTotal, len - readTotal, start + readTotal);
        if (!bytesRead) break;
        readTotal += bytesRead;
      }
      if (!readTotal) break;
      const ports = httpLogPorts(buf.subarray(0, readTotal).toString(encoding));
      for (const p of ports) if (!found.includes(p)) found.push(p);
      if (hadMatch) extraAfterMatch++;
      if ((found.length > 0 && extraAfterMatch >= 1) || start === 0) break;
      scanned += readTotal;
      end = start + Math.min(overlap, readTotal - 1);
    }
    if (!found.length) return '';
    return [...found].reverse().map(p => `listening on random port at ${p} for HTTP\n`).join('');
  } finally {
    await handle.close();
  }
}

export function parsePs(text, uid) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== uid || !languageServer(match[3]) || !/--standalone\b/.test(match[3])) return [];
    return [{ ProcessId:Number(match[1]), CommandLine:match[3] }];
  });
}

export function parseLsof(text) {
  // Machine-readable fields: p (PID), n (socket name). Never parse human columns.
  let pid = null; const ports = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); if (!ports.has(pid)) ports.set(pid,[]); }
    const port = line[0] === 'n' && line.match(/:(\d+)(?:\s|$)/)?.[1];
    if (pid && port) ports.get(pid).push(Number(port));
  }
  return ports;
}

export function parseProcNet(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A' || !/^\d+$/.test(fields[9] || '')) return [];
    const hex = fields[1]?.split(':')[1];
    const port = /^[0-9A-F]{4}$/i.test(hex || '') ? parseInt(hex,16) : 0;
    return port > 0 ? [{inode:fields[9],port}] : [];
  });
}

const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535;
export function isProcessAlive(pid) {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}
export function discoveryCommandError(error, { timedOut = '读取 Antigravity 进程信息超时', failed = '无法读取 Antigravity 进程信息' } = {}) {
  const isTimeout = Boolean(error?.killed || error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM');
  return new Error(isTimeout ? timedOut : failed);
}
const address = value => typeof value === 'string' ? value.toLowerCase().replace(/^\[|\]$/g,'') : '';
const localAddress = value => ['127.0.0.1','0.0.0.0','::1','::','0:0:0:0:0:0:0:1','0:0:0:0:0:0:0:0','localhost'].includes(address(value));
const unspecifiedAddress = value => ['0.0.0.0','::','0:0:0:0:0:0:0:0','*'].includes(address(value));
const endpoint = value => {
  const match=String(value).match(/^(\[[^\]]+\]|[^:\s]+):(\d+|\*)$/);
  return match ? {address:match[1],port:match[2]} : null;
};
const integer = value => typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;

// Read Antigravity 2.34.0+ daemon discovery files (~/.gemini/antigravity/daemon/{ls,hub}_*.json).
// Never follow symlinks, bound scanned entries and file sizes, and require same-UID ownership on POSIX.
// Callers must still pair each record with a live PID and verified listening socket.
export async function discoverDaemonFiles(daemonDir, {
  list = readdir,
  fileStat = lstat,
  read = readFile,
  uid = process.getuid?.(),
  maxScan = 4096,
  maxFiles = 256,
  maxBytes = 16384,
} = {}) {
  if (!daemonDir || typeof daemonDir !== 'string') return [];
  try {
    const dirInfo = await fileStat(daemonDir);
    if (dirInfo.isSymbolicLink?.() || !dirInfo.isDirectory?.()) return [];
  } catch {
    return [];
  }
  let entries;
  try {
    entries = await list(daemonDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !DAEMON_DISCOVERY_FILE.test(name)) continue;
    if (typeof entry !== 'string' && (entry.isSymbolicLink?.() || (typeof entry.isFile === 'function' && !entry.isFile()))) continue;
    candidates.push(name);
    if (candidates.length >= maxScan) break;
  }
  if (!candidates.length) return [];
  const statResults = [];
  for (let i = 0; i < candidates.length; i += 64) {
    const batch = await Promise.all(candidates.slice(i, i + 64).map(async name => {
      const full = join(daemonDir, name);
      try {
        const info = await fileStat(full);
        if (info.isSymbolicLink?.() || !info.isFile?.()) return null;
        if (!(info.size > 0 && info.size <= maxBytes)) return null;
        if (typeof uid === 'number' && typeof info.uid === 'number' && info.uid !== uid) return null;
        return { name, full, mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0 };
      } catch {
        return null;
      }
    }));
    for (const item of batch) if (item) statResults.push(item);
  }
  statResults.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const selected = statResults.slice(0, maxFiles);
  const records = [];
  for (let i = 0; i < selected.length; i += 32) {
    const batch = await Promise.all(selected.slice(i, i + 32).map(async item => {
      try {
        const raw = await read(item.full, 'utf8');
        if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxBytes) return null;
        const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const pid = integer(data.pid);
        if (!validPid(pid)) return null;
        const rawHttp = integer(data.httpPort ?? data.http_port);
        const rawHttps = integer(data.httpsPort ?? data.https_port);
        const httpPort = validPort(rawHttp) ? rawHttp : null;
        const httpsPort = validPort(rawHttps) ? rawHttps : null;
        if (httpPort === null && httpsPort === null) return null;
        const rawToken = data.csrfToken ?? data.csrf_token;
        const csrfToken = typeof rawToken === 'string' ? rawToken.trim() : '';
        if (!csrfToken || csrfToken.length > 512) return null;
        const rawVer = data.lsVersion ?? data.ls_version;
        const lsVersion = typeof rawVer === 'string' && rawVer.trim() ? rawVer.trim().slice(0, 64) : null;
        return { pid, httpPort, httpsPort, csrfToken, lsVersion, file: item.name, modifiedAt: item.mtimeMs };
      } catch {
        return null;
      }
    }));
    for (const rec of batch) if (rec) records.push(rec);
  }
  return records;
}

function netstatSnapshot(text) {
  const ports=new Map(),rejectedPids=new Set();
  for(const line of text.split(/\r?\n/)) {
    const match=line.match(/^\s*TCP\s+(\S+)\s+(\S+)\s+(?:LISTENING|LISTEN|侦听|监听)\s+(\d+)\s*$/i);
    if(!match)continue;
    const local=endpoint(match[1]),remote=endpoint(match[2]),pid=Number(match[3]);
    if(!validPid(pid))continue;
    const port=Number(local?.port);
    // TUN drivers can label outbound fake-IP connections LISTENING. A
    // non-local endpoint must not suppress the PID-verified CIM fallback.
    if(!local||!remote||!localAddress(local.address)||!validPort(port)
      ||!unspecifiedAddress(remote.address)||!(remote.port==='0'||remote.address==='*'&&remote.port==='*')){
      rejectedPids.add(pid);continue;
    }
    if(!ports.has(pid))ports.set(pid,new Set());ports.get(pid).add(port);
  }
  return {ports:new Map([...ports].map(([pid,values])=>[pid,[...values]])),rejectedPids};
}

export function parseNetstat(text) { return netstatSnapshot(text).ports; }

// A blank CIM state is not evidence that a socket listens. Test only the
// known HTTP/CDP target, without sending credentials, HTTP bytes or DNS queries.
export function probeLoopbackPort(port,{timeoutMs=400,signal,connect=createConnection}={}) {
  if(!validPort(port)||!Number.isFinite(timeoutMs)||timeoutMs<=0||signal?.aborted)return Promise.resolve(false);
  return new Promise(resolve=>{
    let socket,timer,settled=false;
    const finish=ok=>{
      if(settled)return;settled=true;clearTimeout(timer);
      signal?.removeEventListener('abort',aborted);
      socket?.destroy();resolve(ok);
    };
    const aborted=()=>finish(false);
    // Keep the timer referenced so a caller awaiting only this probe still
    // receives a result. The socket itself cannot keep the process alive.
    timer=setTimeout(()=>finish(false),Math.min(400,timeoutMs));
    signal?.addEventListener('abort',aborted,{once:true});
    try{
      socket=connect({host:'127.0.0.1',port,family:4});
      socket.once('error',()=>finish(false));
      socket.once('connect',()=>finish(true));
      socket.once('close',()=>finish(false));
      socket.unref?.();
      if(settled)socket.destroy();
    }catch{finish(false);}
  });
}

async function boundedProbe(probe,port,timeoutMs){
  const controller=new AbortController();let timer;
  try{
    return await Promise.race([
      Promise.resolve().then(()=>probe(port,{timeoutMs,signal:controller.signal})).then(value=>value===true,()=>false),
      new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(false);},timeoutMs);}),
    ]);
  }finally{clearTimeout(timer);controller.abort();}
}

export async function discoverWindowsPorts(pids,{run=exec,expectedPorts=new Map(),probe=probeLoopbackPort}={}) {
  const wanted=new Set(pids.filter(validPid));
  if(!wanted.size)return new Map();
  // Logs may contain many historical port hints. Resolve the preferred target
  // once per PID, not once for every socket in the bounded CIM response.
  const preferred=new Map();
  for(const pid of wanted){for(const port of expectedPorts.get(pid)||[]){if(validPort(port)){preferred.set(pid,port);break;}}}
  const {stdout}=await run('netstat.exe',['-ano','-p','tcp'],{windowsHide:true,timeout:4000,maxBuffer:4194304}).catch(()=>({stdout:''}));
  const snapshot=netstatSnapshot(stdout);
  const ports=new Map([...snapshot.ports].filter(([pid])=>wanted.has(pid)));
  const missing=[...wanted].filter(pid=>{
    const found=ports.get(pid)||[],expected=preferred.get(pid);
    // Hints are newest/preferred first. An older HTTP port may have been
    // reused for gRPC; it cannot suppress recovery of the current HTTP port.
    if(expected!==undefined)return !found.includes(expected);
    return !found.length||snapshot.rejectedPids.has(pid);
  });
  if(!missing.length)return ports;
  // Query all affected PIDs once, including sockets with the TUN-reported
  // nonstandard State 0. Do not accept every remote-port-zero socket: Closed
  // and Bound are not listeners. Preserve all fields for JS validation.
  // An exited/no-socket PID must not discard results for the remaining PIDs.
  const script=`$pulsePids = @(${missing.join(',')}); Get-NetTCPConnection -OwningProcess $pulsePids -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort,State | ConvertTo-Json -Compress`;
  try {
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:8000,maxBuffer:1048576});
    const parsed=stdout.replace(/^\uFEFF/,'').trim();
    const value=parsed?JSON.parse(parsed):[],allowed=new Set(missing),uncertain=new Map();
    for(const row of Array.isArray(value)?value:[value]){
      const pid=integer(row?.OwningProcess),port=integer(row?.LocalPort),state=row?.State;
      const listen=state===2||state==='2'||typeof state==='string'&&/^listen$/i.test(state);
      const tunUnknown=state===0||state==='0';
      if(!allowed.has(pid)||!validPort(port)||!localAddress(row?.LocalAddress)
        ||!unspecifiedAddress(row?.RemoteAddress)||integer(row?.RemotePort)!==0)continue;
      if(!(listen||tunUnknown)){
        // Only explicit null/empty states qualify. Missing fields, Closed,
        // Bound and other states remain invalid even if the port is reachable.
        // Restrict probes to the newest/preferred target, one per PID and four
        // per discovery pass. Do not scan unrelated or historical ports.
        if(Object.hasOwn(row,'State')&&(state===null||state==='')&&port===preferred.get(pid)
          &&uncertain.size<4&&!uncertain.has(pid))uncertain.set(pid,port);
        continue;
      }
      if(!ports.has(pid))ports.set(pid,[]);if(!ports.get(pid).includes(port))ports.get(pid).push(port);
    }
    const deadline=performance.now()+1500;
    for(const [pid,port] of uncertain){
      if(ports.get(pid)?.includes(port))continue;
      const timeoutMs=Math.min(400,Math.floor(deadline-performance.now()));
      if(timeoutMs<=0)break;
      if(await boundedProbe(probe,port,timeoutMs)){
        if(!ports.has(pid))ports.set(pid,[]);ports.get(pid).push(port);
      }
    }
  } catch { /* Keep valid native listeners; retry via the client's existing backoff. */ }
  return ports;
}

export async function linuxPorts(pid, { proc = '/proc' } = {}) {
  const { readlink } = await import('node:fs/promises');
  const inodes = new Set();
  for (const fd of await readdir(join(proc,String(pid),'fd'))) {
    try { const link = await readlink(join(proc,String(pid),'fd',fd)); const m=link.match(/^socket:\[(\d+)\]$/); if(m)inodes.add(m[1]); } catch { /* Closed FD. */ }
  }
  const rows = [];
  for (const name of ['tcp','tcp6']) {
    try { rows.push(...parseProcNet(await readFile(join(proc,String(pid),'net',name),'utf8'))); } catch { /* IPv6 may be disabled. */ }
  }
  return [...new Set(rows.filter(row=>inodes.has(row.inode)).map(row=>row.port))];
}

export async function discoverProcesses({ platform = process.platform, run = exec, uid = process.getuid?.(), proc = '/proc', expectedPorts = [] } = {}) {
  if (platform === 'win32') {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Where-Object { $_.CommandLine -match '(?:^|\\s)--standalone(?:\\s|=|$)' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    let stdout;
    try {
      ({ stdout } = await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:8000,maxBuffer:1048576}));
    } catch (error) {
      throw discoveryCommandError(error);
    }
    let parsed;
    try {
      parsed=stdout.trim()?JSON.parse(stdout.replace(/^\uFEFF/,'')):[];
    } catch {
      throw new Error('无法读取 Antigravity 进程信息');
    }
    const rows=(Array.isArray(parsed)?parsed:[parsed]).filter(row=>Number.isSafeInteger(row?.ProcessId)&&row.ProcessId>0&&/(?:^|\s)--standalone(?:\s|=|$)/.test(row.CommandLine||''));
    if(!rows.length)return [];
    const ports=await discoverWindowsPorts(rows.map(row=>row.ProcessId),{run,
      expectedPorts:new Map(rows.map(row=>[row.ProcessId,expectedPorts]))});
    return rows.map(row=>({...row,Ports:ports.get(row.ProcessId)||[]}));
  }
  if (platform === 'darwin') {
    let stdout;
    try {
      ({ stdout } = await run('/bin/ps',['-ww','-axo','pid=,uid=,args='],{timeout:8000,maxBuffer:4194304}));
    } catch (error) {
      throw discoveryCommandError(error);
    }
    const rows=parsePs(stdout,uid);
    if(!rows.length)return [];
    const {stdout:sockets}=await run('/usr/sbin/lsof',['-nP','-a','-p',rows.map(r=>r.ProcessId).join(','),'-iTCP','-sTCP:LISTEN','-Fpn'],{timeout:8000,maxBuffer:1048576}).catch(error=>{if(error.code===1)return {stdout:error.stdout||''};throw discoveryCommandError(error);});
    const ports=parseLsof(sockets);
    return rows.map(row=>({...row,Ports:ports.get(row.ProcessId)||[]}));
  }
  if (platform === 'linux') {
    const rows=[];
    for(const pid of (await readdir(proc)).filter(p=>/^\d+$/.test(p))) {
      try {
        const status=await readFile(join(proc,pid,'status'),'utf8');
        if(Number(status.match(/^Uid:\s+(\d+)/m)?.[1])!==uid)continue;
        const command=(await readFile(join(proc,pid,'cmdline'),'utf8')).split('\0').filter(Boolean).join(' ');
        if(!languageServer(command)||!/--standalone\b/.test(command))continue;
        rows.push({ProcessId:Number(pid),CommandLine:command,Ports:await linuxPorts(pid,{proc})});
      } catch { /* Processes can exit during discovery; inaccessible processes are not candidates. */ }
    }
    return rows;
  }
  throw new Error('Supported platforms: Windows, Linux, macOS');
}
