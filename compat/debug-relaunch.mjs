import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformPaths } from './platform.mjs';

export const DEBUG_ARGS = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
export const DEFAULT_AUTO_COOLDOWN_MS = 60000;
export const DEFAULT_AUTO_MIN_INTERVAL_MS = 5000;
export const DEFAULT_MAX_AUTO_ATTEMPTS = 2;
export const DEFAULT_MANUAL_DEBOUNCE_MS = 5000;

const HELPER_OR_NON_MAIN = /(?:--type=|--import=|--headless(?:\s|=|$)|language_server|chrome_crashpad_handler|Antigravity Helper|debug-relaunch-worker\.mjs|sidecars[\\/]+panel[\\/]+main\.mjs)/i;
const REMOTE_DEBUG_PORT_FLAG = /(?:^|\s)--remote-debugging-port(?:=|\s+)\d+(?:\s|$)/;
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'debug-relaunch-worker.mjs');

const scheduleQueues = new Map();

function hasRemoteDebugFlag(commandLine) {
  return REMOTE_DEBUG_PORT_FLAG.test(String(commandLine || ''));
}

function readSettingsAppResources({ platform, home, env }) {
  try {
    const { settings } = platformPaths({ platform, home, env });
    const parsed = JSON.parse(readFileSync(settings, 'utf8').replace(/^\uFEFF/, ''));
    return typeof parsed?.appResources === 'string' && parsed.appResources.trim()
      ? parsed.appResources.trim()
      : null;
  } catch {
    return null;
  }
}

function pathHelper(platform) {
  return platform === 'win32' ? win32 : posix;
}

function candidateResourcesRoots({ platform, home, env, appResources }) {
  const p = pathHelper(platform);
  const roots = [];
  const push = value => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed && !roots.includes(trimmed)) roots.push(trimmed);
  };
  push(appResources);
  push(env?.AG_PULSE_APP_RESOURCES);
  push(readSettingsAppResources({ platform, home, env }));
  if (typeof env?.ANTIGRAVITY_AGENTAPI_EXE === 'string' && env.ANTIGRAVITY_AGENTAPI_EXE.trim()) {
    push(p.dirname(p.dirname(env.ANTIGRAVITY_AGENTAPI_EXE.trim())));
  }
  if (platform === 'darwin') {
    push('/Applications/Antigravity.app/Contents/Resources');
    push(p.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources'));
  } else if (platform === 'win32') {
    const local = env?.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    const progFiles = env?.ProgramFiles || 'C:\\Program Files';
    push(p.join(local, 'Programs', 'antigravity', 'resources'));
    push(p.join(progFiles, 'Antigravity', 'resources'));
  } else if (platform === 'linux') {
    push('/opt/Antigravity/resources');
    push('/opt/antigravity/resources');
    push('/usr/share/antigravity/resources');
  }
  return roots;
}

function resolveTargetFromResources(resourcesRoot, platform, existsSyncImpl) {
  const p = pathHelper(platform);
  if (platform === 'darwin') {
    let bundle = null;
    let resDir = resourcesRoot;
    if (resourcesRoot.endsWith('.app')) {
      bundle = resourcesRoot;
      resDir = p.join(bundle, 'Contents', 'Resources');
    } else if (p.basename(resourcesRoot) === 'Resources') {
      bundle = p.dirname(p.dirname(resourcesRoot));
    }
    if (!bundle || !bundle.endsWith('.app')) return null;
    const exe = p.join(bundle, 'Contents', 'MacOS', 'Antigravity');
    if (existsSyncImpl(exe) || existsSyncImpl(p.join(bundle, 'Contents', 'Info.plist'))) {
      return { targetPath: bundle, executablePath: exe, appResources: resDir };
    }
    return null;
  }
  if (platform === 'win32') {
    const root = p.dirname(resourcesRoot);
    for (const name of ['Antigravity.exe', 'antigravity.exe']) {
      const exe = p.join(root, name);
      if (existsSyncImpl(exe)) return { targetPath: exe, executablePath: exe, appResources: resourcesRoot };
    }
    return null;
  }
  if (platform === 'linux') {
    const root = p.dirname(resourcesRoot);
    for (const name of ['antigravity', 'Antigravity']) {
      const exe = p.join(root, name);
      if (existsSyncImpl(exe)) return { targetPath: exe, executablePath: exe, appResources: resourcesRoot };
    }
    return null;
  }
  return null;
}

function resolveTargetFromProcesses(processes, platform, existsSyncImpl) {
  const p = pathHelper(platform);
  for (const proc of processes) {
    if (platform === 'darwin' && proc.bundle && proc.bundle.endsWith('.app')) {
      const exe = p.join(proc.bundle, 'Contents', 'MacOS', 'Antigravity');
      if (existsSyncImpl(exe) || existsSyncImpl(p.join(proc.bundle, 'Contents', 'Info.plist'))) {
        return {
          targetPath: proc.bundle,
          executablePath: exe,
          appResources: p.join(proc.bundle, 'Contents', 'Resources'),
        };
      }
    }
    if ((platform === 'linux' || platform === 'win32') && proc.executable && existsSyncImpl(proc.executable)) {
      return {
        targetPath: proc.executable,
        executablePath: proc.executable,
        appResources: p.join(p.dirname(proc.executable), 'resources'),
      };
    }
  }
  return null;
}

async function invokeExecFile(execFileImpl, file, args, options = {}) {
  if (execFileImpl !== execFile && execFileImpl.length < 4) {
    const result = await execFileImpl(file, args, options);
    return { stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? '') };
  }
  return new Promise((resolvePromise, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function runPs(execFileImpl, args) {
  try {
    return await invokeExecFile(execFileImpl, 'ps', args, { timeout: 5000, maxBuffer: 4194304 });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return await invokeExecFile(execFileImpl, '/bin/ps', args, { timeout: 5000, maxBuffer: 4194304 });
    }
    throw error;
  }
}

export function parseDesktopProcesses(output, platform) {
  const rows = [];
  if (platform === 'win32') {
    const cleaned = String(output || '').replace(/^\uFEFF/, '').trim();
    if (!cleaned || cleaned === 'null') return rows;
    const parsed = JSON.parse(cleaned);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      const pid = Number(item?.ProcessId);
      if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) continue;
      const commandLine = String(item?.CommandLine || '');
      const executable = typeof item?.ExecutablePath === 'string' && item.ExecutablePath.trim()
        ? item.ExecutablePath.trim()
        : null;
      if (HELPER_OR_NON_MAIN.test(commandLine)) continue;
      if (executable && !/[\\/]antigravity\.exe$/i.test(executable)) continue;
      if (!executable && !/(?:^|["'\s\\/])antigravity\.exe(?:["'\s]|$)/i.test(commandLine)) continue;
      rows.push({ pid, commandLine, executable });
    }
    return rows;
  }

  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = match[2].trim();
    if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) continue;
    if (HELPER_OR_NON_MAIN.test(commandLine)) continue;
    if (platform === 'darwin') {
      const appMatch = commandLine.match(/^["']?(\/[^\n"']*?\.app)\/Contents\/MacOS\/Antigravity(?:\s|["']|$)/);
      if (!appMatch || appMatch[1].includes(' /')) continue;
      rows.push({
        pid,
        commandLine,
        bundle: appMatch[1],
        executable: `${appMatch[1]}/Contents/MacOS/Antigravity`,
      });
    } else if (platform === 'linux') {
      const exeMatch = commandLine.match(/^["']?((?:\/[^\n"']*\/)?[Aa]ntigravity)(?:\s|["']|$)/);
      if (!exeMatch || exeMatch[1].includes(' /')) continue;
      rows.push({
        pid,
        commandLine,
        executable: exeMatch[1],
      });
    }
  }
  return rows;
}

export async function inspectHostDebugState({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  appResources,
  execFileImpl = execFile,
  existsSyncImpl = existsSync,
} = {}) {
  let processes = [];
  let inspectionFailed = false;
  try {
    if (platform === 'darwin') {
      const { stdout } = await runPs(execFileImpl, ['axo', 'pid=,command=']);
      processes = parseDesktopProcesses(stdout, 'darwin');
    } else if (platform === 'linux') {
      const { stdout } = await runPs(execFileImpl, ['-eo', 'pid=,args=']);
      processes = parseDesktopProcesses(stdout, 'linux');
    } else if (platform === 'win32') {
      const script = "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe' OR Name='antigravity.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
      const { stdout } = await invokeExecFile(
        execFileImpl,
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 8000, maxBuffer: 1048576 },
      );
      processes = parseDesktopProcesses(stdout, 'win32');
    } else {
      inspectionFailed = true;
    }
  } catch {
    inspectionFailed = true;
  }

  let resolved = null;
  for (const root of candidateResourcesRoots({ platform, home, env, appResources })) {
    resolved = resolveTargetFromResources(root, platform, existsSyncImpl);
    if (resolved) break;
  }
  if (!resolved) {
    resolved = resolveTargetFromProcesses(processes, platform, existsSyncImpl);
  }

  const pids = [...new Set(processes.map(proc => proc.pid))].sort((a, b) => a - b);
  return {
    platform,
    hostRunning: pids.length > 0,
    pids,
    hasDebugFlag: processes.some(proc => hasRemoteDebugFlag(proc.commandLine)),
    targetPath: resolved?.targetPath || null,
    executablePath: resolved?.executablePath || null,
    appResources: resolved?.appResources || null,
    ...(inspectionFailed ? { inspectionFailed: true } : {}),
  };
}

async function readGuard(guardFile) {
  try {
    const parsed = JSON.parse((await readFile(guardFile, 'utf8')).replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeGuard(guardFile, data) {
  await mkdir(dirname(guardFile), { recursive: true });
  const temporary = `${guardFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, guardFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

function samePidSet(currentPids, guardPids) {
  if (!currentPids.length || !Array.isArray(guardPids) || !guardPids.length) return false;
  const seen = new Set(guardPids);
  return currentPids.every(pid => seen.has(pid));
}

async function runSerializedSchedule(dataDir, fn) {
  const key = dataDir || '__default__';
  const previous = scheduleQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  scheduleQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (scheduleQueues.get(key) === next) scheduleQueues.delete(key);
  }
}

export async function scheduleHostRelaunch({
  dataDir = platformPaths().data,
  platform = process.platform,
  home = homedir(),
  env = process.env,
  appResources,
  reason = 'manual',
  cooldownMs = DEFAULT_AUTO_COOLDOWN_MS,
  minAutoIntervalMs = DEFAULT_AUTO_MIN_INTERVAL_MS,
  maxAutoAttempts = DEFAULT_MAX_AUTO_ATTEMPTS,
  debounceMs = DEFAULT_MANUAL_DEBOUNCE_MS,
  spawnImpl = spawn,
  execFileImpl = execFile,
  existsSyncImpl = existsSync,
  now = Date.now,
} = {}) {
  const normalizedReason = reason === 'auto' ? 'auto' : 'manual';
  return runSerializedSchedule(dataDir, async () => {
    const state = await inspectHostDebugState({
      platform,
      home,
      env,
      appResources,
      execFileImpl,
      existsSyncImpl,
    });
    if (state.inspectionFailed) {
      return { scheduled: false, reason: 'inspection-failed', state };
    }
    if (!state.targetPath) {
      return { scheduled: false, reason: 'target-not-found', state };
    }
    if (normalizedReason === 'auto') {
      if (!state.hostRunning) return { scheduled: false, reason: 'host-not-running', state };
      if (state.hasDebugFlag) return { scheduled: false, reason: 'debug-flag-present', state };
    }

    const guardFile = join(dataDir, 'debug-relaunch-guard.json');
    const guard = await readGuard(guardFile);
    const currentNow = now();
    const hasLastAt = typeof guard.lastAt === 'number' && Number.isFinite(guard.lastAt);
    const elapsed = hasLastAt && currentNow >= guard.lastAt ? currentNow - guard.lastAt : Infinity;
    const rawHistory = Array.isArray(guard.history)
      ? guard.history
      : (hasLastAt && guard.lastReason !== 'manual' ? [guard.lastAt] : []);
    const recentHistory = rawHistory.filter(
      ts => typeof ts === 'number' && Number.isFinite(ts) && currentNow >= ts && currentNow - ts < cooldownMs,
    );

    if (normalizedReason === 'auto') {
      if (samePidSet(state.pids, guard.pids)) {
        return { scheduled: false, reason: elapsed < cooldownMs ? 'cooldown' : 'already-scheduled-for-pids', state };
      }
      if (elapsed < minAutoIntervalMs || recentHistory.length >= maxAutoAttempts) {
        return { scheduled: false, reason: 'cooldown', state };
      }
    } else if (elapsed < debounceMs) {
      return { scheduled: false, reason: 'debounced', state };
    }

    const payload = {
      platform,
      pids: state.pids,
      targetPath: state.targetPath,
      executablePath: state.executablePath,
      debugArgs: [...DEBUG_ARGS],
      reason: normalizedReason,
    };

    await writeGuard(guardFile, {
      lastAt: currentNow,
      lastReason: normalizedReason,
      pids: state.pids,
      history: normalizedReason === 'auto' ? [...recentHistory, currentNow] : recentHistory,
    });

    const workerEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawnImpl(process.execPath, [WORKER_PATH, JSON.stringify(payload)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: workerEnv,
    });
    child?.on?.('error', () => {});
    child?.unref?.();

    return {
      scheduled: true,
      reason: normalizedReason,
      pids: state.pids,
      targetPath: state.targetPath,
      state,
    };
  });
}
