import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { MetricsStore } from './store.mjs';
import { DesktopUsage } from './usage.mjs';
import { loadSidecarSdk } from './sdk.mjs';
import { RuntimeUi, makeRendererSource } from '../../compat/runtime-ui.mjs';
import { agentExecutables, platformPaths } from '../../compat/platform.mjs';
import { inspectHostArchive, inspectDesktopLaunch, ensureDesktopLaunchConfig } from '../../compat/launch-config.mjs';
import { PreferencesStore } from '../../compat/preferences.mjs';
import { SidecarOwner } from '../../compat/sidecar-owner.mjs';
import { readHostTheme } from '../../compat/host-theme.mjs';
import { panelAppSource,panelPageSource } from './panel-source.mjs';
import { AppUpdater, releaseRuntimeDirectory } from './updater.mjs';
import { scheduleHostRelaunch } from '../../compat/debug-relaunch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The host starts this sidecar in sidecars/panel. Windows holds the process's
// current directory open; release that handle before an update renames sidecars.
try { releaseRuntimeDirectory(join(HERE,'..','..')); } catch {}
const createTheme=createRequire(import.meta.url)('../../compat/theme.cjs');
const themeCss=()=>createTheme().css(':root');
const paths=platformPaths();
const ownership=process.env.ANTIGRAVITY_SIDECAR_WEB_PORT?new SidecarOwner(paths.data):null;
let settingsCache={},settingsAt=-Infinity;
const owns=()=>(!ownership||ownership.owns())&&settingsCache.enabled!==false;
const store = new MetricsStore(undefined,{owns});
const usage=new DesktopUsage(store,undefined,{host:'app',owns});
store.onTrajectory=async(scope,id,raw,options={})=>{
  const {isCurrent=()=>true}=options;
  if(isCurrent()!==true)return;
  if((!ownership||await ownership.isOwner())&&isCurrent()===true)return usage.ingestLive(scope,id,raw,{...options,isCurrent});
};
store.onBackgroundResult=(scope,id,file,options)=>usage.ingestDisk(scope,id,file,options);
const preferences=new PreferencesStore();
const updater=new AppUpdater({pluginDir:join(HERE,'..','..'),dataDir:paths.data});
let liveComposerModel = null;
const metrics = async input => {
  if(ownership&&!await ownership.isOwner())throw Error('Sidecar ownership changed');
  runtimeSettings();
  const prefs=await preferences.snapshot();
  const hostTheme=await readHostTheme(),liveTheme=integration.rendererTheme;
  const theme=(liveTheme?.fontFamily||liveTheme?.monoFontFamily)?{...liveTheme,...hostTheme}:hostTheme;
  const update = typeof updater?.passiveSummary==='function' ? updater.passiveSummary() : { available: false, latestVersion: null };
  if(input?.usageOnly===true){
    if(!store.serverPid&&!store.identity){try{await store.snapshot({conversationId:null,force:false,selectLatest:false});}catch{}}
    const requestedScope=(input.usageScope==='local'||input.usageScope==='account')?input.usageScope:(prefs?.usageScope||'local');
    return {connection:store.quota?'live':'stale',groups:store.quota||[],speed:null,usage:await usage.snapshot({sync:false,scope:requestedScope,groups:store.quota}),preferences:prefs,theme,integration:integration.health,update};
  }
  const base=await store.snapshot(input);if(input?.usageSync===true)void usage.sync(true);
  return {...base,...(liveComposerModel?{composerModel:liveComposerModel}:{}),usage:await usage.snapshot({sync:input?.usageSync===true,scope:prefs?.usageScope||'local',groups:base.groups}),preferences:prefs,theme,integration:integration.health,update};
};
const usageSource=()=>{const s=readFileSync(join(HERE,'..','..','compat','usage-ui.cjs'),'utf8');return `window.__agPulseUsageFactory=(${s.slice(s.indexOf('module.exports = ')+17).trim().replace(/;$/,'')});`;};
const updateSource=()=>{const s=readFileSync(join(HERE,'..','..','compat','update-ui.cjs'),'utf8');return `window.__agPulseUpdateFactory=(${s.slice(s.indexOf('module.exports = ')+17).trim().replace(/;$/,'')});`;};
const staticFiles = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/format.mjs': ['format.mjs', 'text/javascript'] };
const inlineSource=()=>{
  const file=readFileSync(join(HERE,'..','..','compat','inline-widget.cjs'),'utf8');
  const i18n=readFileSync(join(HERE,'..','..','compat','i18n.cjs'),'utf8');
  const theme=readFileSync(join(HERE,'..','..','compat','theme.cjs'),'utf8');
  const extract=s=>s.slice(s.indexOf('module.exports = ')+'module.exports = '.length).trim().replace(/;$/,'');
  return updateSource()+usageSource()+`window.__agPulseI18nFactory=(${extract(i18n)});window.__agPulseThemeFactory=(${extract(theme)});(${extract(file)})();`;
};
const i18nModule=()=>{const s=readFileSync(join(HERE,'..','..','compat','i18n.cjs'),'utf8');return 'export const createI18n='+s.slice(s.indexOf('module.exports = ')+'module.exports = '.length);};
const themeModule=()=>{const s=readFileSync(join(HERE,'..','..','compat','theme.cjs'),'utf8');return 'export const createTheme='+s.slice(s.indexOf('module.exports = ')+'module.exports = '.length);};
const runtimeSettings = () => {
  if(Date.now()-settingsAt<1000)return settingsCache;
  let settings = {};
  try { settings = JSON.parse(readFileSync(paths.settings,'utf8').replace(/^\uFEFF/,'')); } catch {}
  try { if (JSON.parse(readFileSync(paths.pluginConfig,'utf8').replace(/^\uFEFF/,'')).plugins?.['antigravity-pulse']?.enabled === false) settings.enabled = false; } catch {}
  settingsCache=settings;settingsAt=Date.now();return settings;
};
const sidecarStartedAt = Date.now();
let autoRelaunchTriggered = false;
let missingPortTicks = 0, lastLaunchRepairAt = 0, cachedLaunch = null;
const resolveHostResources = () => {
  const s = runtimeSettings();
  if (typeof s.appResources === 'string' && s.appResources) return s.appResources;
  try {
    for (const exe of agentExecutables()) {
      const res = dirname(dirname(exe));
      if (existsSync(join(res, 'app.asar'))) return res;
    }
  } catch {}
  return null;
};
const syncLaunchConfig = async (force = false) => {
  const s = runtimeSettings();
  if (!owns() || s.enabled === false || s.inline === false || s.mode === 'legacy' || s.autoConfigureLaunch === false) {
    return inspectDesktopLaunch();
  }
  if (force || !cachedLaunch || Date.now() - lastLaunchRepairAt >= 60000) {
    lastLaunchRepairAt = Date.now();
    cachedLaunch = await ensureDesktopLaunchConfig({ settingsPath: paths.settings });
  }
  return cachedLaunch;
};
const integration = new RuntimeUi({
  // Composer identity is authoritative. Unknown/new inline inputs request quota
  // only; SDK/HTTP panels keep the store's automatic most-recent selection.
  snapshot: input => {
    if (input && Object.hasOwn(input, 'composerModel')) liveComposerModel = input.composerModel || null;
    return metrics({...input,selectLatest:false});
  },
  preferences,
  updater,
  owner:ownership?.token,owns:()=>ownership?ownership.isOwner():true,
  source: makeRendererSource(readFileSync(join(HERE,'..','..','compat','i18n.cjs'),'utf8'),readFileSync(join(HERE,'..','..','compat','inline-widget.cjs'),'utf8'),readFileSync(join(HERE,'..','..','compat','theme.cjs'),'utf8'),ownership?.token,ownership?.startedAt,updateSource()+usageSource()),
  dataDir: paths.data,
  enabled: () => { const s = runtimeSettings(); return s.enabled !== false && s.inline !== false && s.mode !== 'legacy'; },
  onTargets: () => { missingPortTicks = 0; },
  diagnoseError: async error => {
    if (error?.code !== 'ENOENT') { missingPortTicks = 0; return null; }
    missingPortTicks++;
    const host = await inspectHostArchive(resolveHostResources());
    const launch = await syncLaunchConfig();
    if (host.requiresDebugFlag || (missingPortTicks >= 2 && store.serverPid)) {
      const configured = Boolean(launch?.configured);
      return {
        reason: 'debug-port-disabled',
        ...(host.version ? { hostVersion: host.version } : {}),
        launchConfigured: configured,
        message: configured
          ? 'Host started without --remote-debugging-port=0; launch shortcuts are configured—fully quit and reopen Antigravity (or run python manage.py launch).'
          : 'Antigravity 2.33+ requires --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 (or python3 manage.py launch) for the inline widget.',
      };
    }
    return null;
  },
  onMissingDebugPort: async () => {
    if (autoRelaunchTriggered) return;
    if (Date.now() - sidecarStartedAt > 20000) return;
    if (ownership && !await ownership.isOwner()) return;
    const prefs = await preferences.snapshot();
    if (!prefs || prefs.error || prefs.autoRelaunchDebug === false) return;
    const result = await relaunchHost('auto');
    if (result?.scheduled) autoRelaunchTriggered = true;
  },
});

const relaunchHost = async reason => {
  if (ownership && !await ownership.isOwner()) return { scheduled: false, reason: 'not-owner' };
  return scheduleHostRelaunch({
    dataDir: paths.data,
    appResources: runtimeSettings().appResources,
    reason,
  });
};

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp, Response } = await loadSidecarSdk();
  if(!await ownership.claim())process.exit(0);
  void syncLaunchConfig(true).catch(() => {});
  const app = new SidecarApp();
  for (const [path, [file, type]] of Object.entries(staticFiles)) app.api(path, () => new Response(path==='/'?panelPageSource():readFileSync(join(HERE, file), 'utf8'), { contentType: type,headers:{'Cache-Control':'no-store'} }), 'GET');
  app.page('/app.js',()=>new Response(panelAppSource(),{contentType:'application/javascript',headers:{'Cache-Control':'no-store'}}));
  app.page('/i18n.js',i18nModule);
  app.page('/theme.js',themeModule);
  app.api('/theme.css',()=>new Response(themeCss(),{contentType:'text/css'}),'GET');
  app.api('/api/metrics', data => metrics({ conversationId: data.conversationId || null, force: data.force === true || data.force === '1', quotaRefresh: data.quotaRefresh === true || data.quotaRefresh === '1', ...(data.usageOnly === true || data.usageOnly === '1' ? { usageOnly: true } : {}), ...(data.usageScope === 'local' || data.usageScope === 'account' ? { usageScope: data.usageScope } : {}) }), 'GET');
  app.api('/api/integration', () => integration.health, 'GET');
  app.api('/api/preferences',()=>preferences.snapshot(),'GET');
  app.api('/api/preferences',async data=>{try{return await preferences.set(data);}catch{return new Response(JSON.stringify({error:'Language preference could not be saved'}),{status:400,contentType:'application/json'});}},'POST');
  app.api('/api/relaunch-debug',async()=>{
    if(ownership&&!await ownership.isOwner())return new Response(JSON.stringify({error:'Sidecar ownership changed'}),{status:403,contentType:'application/json'});
    try{return await relaunchHost('manual');}
    catch{return new Response(JSON.stringify({error:'Relaunch failed'}),{status:500,contentType:'application/json'});}
  },'POST');
  app.run();
  integration.start();
  const passiveUpdateBoot=setTimeout(()=>{if(owns()&&typeof updater?.checkPassive==='function')void updater.checkPassive().catch(()=>{});},4000);passiveUpdateBoot.unref?.();
  const passiveUpdateTimer=setInterval(()=>{if(owns()&&typeof updater?.checkPassive==='function')void updater.checkPassive().catch(()=>{});},6*60*60*1000);passiveUpdateTimer.unref?.();
  const shutdown=async()=>{
    clearTimeout(passiveUpdateBoot);clearInterval(passiveUpdateTimer);
    usage.dispose();store.dispose();
    const exitTimer=setTimeout(()=>process.exit(0),2000);exitTimer.unref();
    await integration.stop();ownership.stop();process.exit(0);
  };
  ownership.watch(shutdown);
  updater.onReload=()=>void shutdown();
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => {
    void shutdown();
  });
} else {
  // A dependency-free local preview uses the same collector and frontend.
  const port = Number(process.env.AG_PULSE_PORT || 17891);
  const server = createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === '/api/preferences') {
      const sameOrigin=req.headers.origin===`http://${host}`;
      if(req.headers.origin&&!sameOrigin){res.writeHead(403);res.end();return;}
      res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');
      if(req.method==='GET'){res.end(JSON.stringify(await preferences.snapshot()));return;}
      if(req.method==='POST'&&sameOrigin&&String(req.headers['content-type']).startsWith('application/json')){
        let body='';
        try {for await(const chunk of req){body+=chunk;if(body.length>1024)throw new Error('Preference payload too large');}
          res.end(JSON.stringify(await preferences.set(JSON.parse(body))));
        }catch{res.writeHead(400);res.end(JSON.stringify({error:'Language preference could not be saved'}));}
        return;
      }
      res.writeHead(405);res.end();return;
    }
    if (url.pathname === '/api/relaunch-debug') {
      const sameOrigin = req.headers.origin === `http://${host}`;
      if (req.headers.origin && !sameOrigin) { res.writeHead(403); res.end(); return; }
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'POST' && sameOrigin) {
        try { res.end(JSON.stringify(await relaunchHost('manual'))); }
        catch { res.writeHead(500); res.end(JSON.stringify({ error: 'Relaunch failed' })); }
        return;
      }
      res.writeHead(405); res.end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/api/metrics') {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403); res.end(); return; }
      try { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); const scopeParam = url.searchParams.get('usageScope'); res.end(JSON.stringify(await metrics({ conversationId: url.searchParams.get('conversationId'), force: url.searchParams.get('force') === '1', quotaRefresh: url.searchParams.get('quotaRefresh') === '1', ...(url.searchParams.get('usageOnly') === '1' ? { usageOnly: true } : {}), ...(scopeParam === 'local' || scopeParam === 'account' ? { usageScope: scopeParam } : {}) }))); }
      catch { res.writeHead(500); res.end('{"error":"数据暂时不可用"}'); }
      return;
    }
    if (url.pathname === '/api/integration') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(integration.health)); return; }
    if (url.pathname === '/preload.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('// Standalone preview: no host bridge.'); return; }
    if(url.pathname==='/i18n.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(i18nModule());return;}
    if(url.pathname==='/theme.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(themeModule());return;}
    if(url.pathname==='/theme.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});res.end(themeCss());return;}
    if(url.pathname==='/inline-widget.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(inlineSource());return;}
    if(url.pathname==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(panelAppSource());return;}
    if(url.pathname.startsWith('/toolbar-preview')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(readFileSync(join(HERE,'toolbar-preview.html')));return;}
    const file = staticFiles[url.pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(url.pathname==='/'?panelPageSource():readFileSync(join(HERE, file[0])));
  });
  server.listen(port, '127.0.0.1', () => console.log(`Antigrative Dashboard: http://127.0.0.1:${port}`));
}
