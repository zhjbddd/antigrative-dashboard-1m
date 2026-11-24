// User-owned paths, shared by the collector, SDK and both renderer adapters.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';

// Termux's Node reports 'android'; its user space follows Linux/XDG conventions.
export const hostPlatform = (platform = process.platform) => platform === 'android' ? 'linux' : platform;

function hubServerLogCandidates(home) {
  const dir = join(home, '.antigravity-hub-server', 'data');
  try {
    const dirInfo = lstatSync(dir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return [];
    const matched = [];
    for (const name of readdirSync(dir)) {
      if (!/^ls-[^/\\]+\.log$/i.test(name)) continue;
      const full = join(dir, name);
      try {
        const info = lstatSync(full);
        if (info.isSymbolicLink() || !info.isFile()) continue;
        matched.push({ full, mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0 });
      } catch {}
    }
    matched.sort((a, b) => b.mtimeMs - a.mtimeMs || b.full.localeCompare(a.full));
    return matched.slice(0, 16).map(item => item.full);
  } catch {
    return [];
  }
}

function hubServerExecutables(home) {
  const dir = join(home, '.antigravity-hub-server', 'bin');
  try {
    const dirInfo = lstatSync(dir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return [];
    const matched = [];
    for (const name of readdirSync(dir)) {
      const sub = join(dir, name);
      try {
        const subInfo = lstatSync(sub);
        if (subInfo.isSymbolicLink() || !subInfo.isDirectory()) continue;
        const candidate = join(sub, 'language_server');
        const exeInfo = lstatSync(candidate);
        if (exeInfo.isSymbolicLink() || !exeInfo.isFile()) continue;
        matched.push({ full: candidate, mtimeMs: Number.isFinite(exeInfo.mtimeMs) ? exeInfo.mtimeMs : 0 });
      } catch {}
    }
    matched.sort((a, b) => b.mtimeMs - a.mtimeMs || b.full.localeCompare(a.full));
    return matched.slice(0, 8).map(item => item.full);
  } catch {
    return [];
  }
}

export function isRemoteHeadlessHost({ env = process.env, platform = process.platform, server = null, hasLocalHostApp = false } = {}) {
  if (server?.remoteHub === true) return true;
  const host = hostPlatform(platform);
  if (host !== 'linux' || hasLocalHostApp) return false;
  const hasDisplay = Boolean(
    (typeof env?.DISPLAY === 'string' && env.DISPLAY.trim())
    || (typeof env?.WAYLAND_DISPLAY === 'string' && env.WAYLAND_DISPLAY.trim())
  );
  const isSsh = Boolean(
    (typeof env?.SSH_CONNECTION === 'string' && env.SSH_CONNECTION.trim())
    || (typeof env?.SSH_CLIENT === 'string' && env.SSH_CLIENT.trim())
    || (typeof env?.SSH_TTY === 'string' && env.SSH_TTY.trim())
  );
  const isWsl = Boolean(
    (typeof env?.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME.trim())
    || (typeof env?.WSL_INTEROP === 'string' && env.WSL_INTEROP.trim())
  );
  if (isSsh) return true;
  if (isWsl && !hasDisplay) return true;
  return !hasDisplay;
}

export function platformPaths({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  platform = hostPlatform(platform);
  let config, local;
  if (platform === 'win32') {
    config = env.APPDATA || join(home, 'AppData', 'Roaming');
    local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  } else if (platform === 'darwin') {
    config = local = join(home, 'Library', 'Application Support');
  } else if (platform === 'linux') {
    config = env.XDG_CONFIG_HOME || join(home, '.config');
    local = env.XDG_DATA_HOME || join(home, '.local', 'share');
  } else throw new Error('Supported platforms: Windows, Linux, macOS');
  const settings = join(local, 'AntigravityPulse', 'settings.json');
  let saved = {};
  try { saved=JSON.parse(readFileSync(settings,'utf8').replace(/^\uFEFF/,'')); } catch {}
  const profile = env.AG_PULSE_PROFILE || (typeof saved.profile === 'string' ? saved.profile : null) || join(config, 'Antigravity');
  const profileLog=join(profile,'logs','language_server.log');
  const log=env.AG_PULSE_LOG || (platform==='darwin'?join(home,'Library','Logs','Antigravity','language_server.log'):profileLog);
  const hubLogs = !env.AG_PULSE_LOG && (platform === 'linux' || platform === 'darwin') ? hubServerLogCandidates(home) : [];
  return {
    profile, log, logCandidates:env.AG_PULSE_LOG?[log]:[...new Set([log,profileLog,...(platform==='win32'?[join(home,'.gemini','antigravity','logs','language_server.log')]:[]),...hubLogs])],
    daemonDir: join(home, '.gemini', 'antigravity', 'daemon'),
    settings,
    pluginConfig: join(home, '.gemini', 'config', 'config.json'),
    data: env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(home, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-pulse', 'panel', 'data'),
  };
}

export function agentExecutables({ platform = process.platform, home = homedir(), env = process.env, arch = process.arch } = {}) {
  platform = hostPlatform(platform);
  if (env.ANTIGRAVITY_AGENTAPI_EXE) return [env.ANTIGRAVITY_AGENTAPI_EXE];
  const roots = platform === 'win32' ? [join(env.LOCALAPPDATA || join(home,'AppData','Local'),'Programs','antigravity','resources')]
    : platform === 'darwin' ? ['/Applications/Antigravity.app/Contents/Resources',join(home,'Applications','Antigravity.app','Contents','Resources')]
    : ['/opt/Antigravity/resources','/opt/antigravity/resources','/usr/share/antigravity/resources'];
  if (env.AG_PULSE_APP_RESOURCES) roots.unshift(env.AG_PULSE_APP_RESOURCES);
  try { const saved=JSON.parse(readFileSync(platformPaths({platform,home,env}).settings,'utf8').replace(/^\uFEFF/,''));if(typeof saved.appResources==='string')roots.unshift(saved.appResources); } catch {}
  const names = platform === 'win32' ? ['language_server.exe'] : ['language_server',`language_server_${platform === 'darwin' ? 'macos' : 'linux'}_${arch === 'arm64' ? 'arm' : 'x'}64`, `language_server_${platform === 'darwin' ? 'macos' : 'linux'}`];
  const desktopCandidates = roots.flatMap(root => names.map(name => join(root,'bin',name)));
  const hubCandidates = platform === 'linux' || platform === 'darwin' ? hubServerExecutables(home) : [];
  return [...new Set([...desktopCandidates, ...hubCandidates])];
}

export function installedAgentExecutable(options) {
  const candidates = agentExecutables(options);
  const file = candidates.find(candidate => existsSync(candidate));
  if (!file) throw new Error('Bundled language server not found; set ANTIGRAVITY_AGENTAPI_EXE to the installed host binary.');
  return file;
}
