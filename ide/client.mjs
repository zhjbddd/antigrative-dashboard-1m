import {AntigravityClient} from '../sidecars/panel/client.mjs';
import {discoverDaemonFiles} from '../sidecars/panel/discovery.mjs';
import {platformPaths} from '../compat/platform.mjs';
import {discoverIdeProcesses,discoverIdeLogPorts,agyServer,ideServer,ideHubPort} from './discovery.mjs';
export class IdeClient extends AntigravityClient {
  constructor({profile,debugPort,processes=discoverIdeProcesses,logPorts=discoverIdeLogPorts,daemonDir,daemonFiles=discoverDaemonFiles,probe,pidAlive,now,env=process.env}={}){
    super({...(probe?{probe}:{}),...(pidAlive?{pidAlive}:{}),...(now?{now}:{}),daemonFiles,env});
    this.profile=profile;this.debugPort=debugPort;this.ideProcesses=processes;this.logPorts=logPorts;
    this.ideDaemonDir=daemonDir!==undefined?daemonDir:null;
  }
  async discoverNow(){
    this.server=null;this.verifiedServer=null;
    // Missing old-profile logs must not block a 2.6 hub. Logs are optional
    // discovery hints, not ownership or HTTP identity for an agy process.
    const expectedApiPorts=await this.logPorts(this.profile).catch(()=>[]);
    const row=await this.ideProcesses(this.debugPort(),{expectedApiPorts});
    const hub=agyServer(row),hubPort=hub?ideHubPort(row):null;
    const port=hub?(hubPort&&row.Ports.includes(hubPort)?hubPort:null)
      :ideServer(row)?expectedApiPorts.find(port=>row.Ports.includes(port)):null;
    if(!port)throw Error('Waiting for the IDE local API port');
    const cliCsrf=row.CommandLine.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1]||'';
    let daemonCsrf='';
    if(!cliCsrf){
      const dir=this.ideDaemonDir!==null?this.ideDaemonDir:platformPaths({env:this.env}).daemonDir;
      const records=dir?await this.daemonFiles(dir).catch(()=>[]):[];
      const match=(Array.isArray(records)?records:[]).find(item=>item&&item.pid===row.ProcessId&&item.httpPort===port&&typeof item.csrfToken==='string'&&item.csrfToken.trim());
      if(match)daemonCsrf=match.csrfToken.trim();
    }
    const envCsrf=typeof this.env?.ANTIGRAVITY_CSRF_TOKEN==='string'?this.env.ANTIGRAVITY_CSRF_TOKEN.trim():'';
    const csrf=cliCsrf||daemonCsrf||envCsrf;
    if(!csrf)throw Error('IDE local API credential unavailable');
    const server={port,csrf,pid:row.ProcessId};
    const credentialSource=cliCsrf?'cmdline':daemonCsrf?'daemon-file':'sidecar-env';
    Object.defineProperty(server,'credentialSource',{value:credentialSource,enumerable:false});
    this.server=server;this.discoveredAt=this.now();return this.server;
  }
}
