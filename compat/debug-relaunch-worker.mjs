import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const DEBUG_ARGS = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
export const DEFAULT_QUIT_TIMEOUT_MS = 10000;
export const DEFAULT_SIGTERM_FALLBACK_MS = 8000;
export const DEFAULT_POLL_INTERVAL_MS = 200;
export const DEFAULT_POST_EXIT_DELAY_MS = 300;

export function stripHostEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === 'ELECTRON_RUN_AS_NODE' || upper.startsWith('ANTIGRAVITY_')) continue;
    clean[key] = value;
  }
  return clean;
}

function normalizeWorkerPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const targetPath = typeof raw.targetPath === 'string' ? raw.targetPath.trim() : '';
  if (!targetPath || /[\0\r\n]/.test(targetPath)) return null;
  const platform = ['darwin', 'linux', 'win32'].includes(raw.platform) ? raw.platform : process.platform;
  const pids = [...new Set((Array.isArray(raw.pids) ? raw.pids : [])
    .map(Number)
    .filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid))];
  const debugArgs = Array.isArray(raw.debugArgs) && raw.debugArgs.length
    ? raw.debugArgs.map(arg => String(arg))
    : [...DEBUG_ARGS];
  return { platform, targetPath, pids, debugArgs };
}

export function parseWorkerPayload(argv = process.argv.slice(2), env = process.env) {
  let rawText = null;
  if (argv[0] === '--payload' && typeof argv[1] === 'string') {
    rawText = argv[1];
  } else if (typeof argv[0] === 'string' && argv[0].trim().startsWith('{')) {
    rawText = argv[0];
  } else if (typeof env?.AG_PULSE_RELAUNCH_PAYLOAD === 'string' && env.AG_PULSE_RELAUNCH_PAYLOAD.trim()) {
    rawText = env.AG_PULSE_RELAUNCH_PAYLOAD;
  }
  if (!rawText) return null;
  try {
    return normalizeWorkerPayload(JSON.parse(rawText));
  } catch {
    return null;
  }
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

function createPidChecker(killImpl, isPidAliveImpl) {
  if (typeof isPidAliveImpl === 'function') return isPidAliveImpl;
  return pid => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      killImpl(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  };
}

async function sendGracefulQuit({ platform, pids, targetPath, execFileImpl, killImpl }) {
  if (platform === 'darwin') {
    const escaped = targetPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await invokeExecFile(execFileImpl, 'osascript', ['-e', `tell application "${escaped}" to quit`], { timeout: 5000 }).catch(() => {});
    return;
  }
  if (platform === 'linux') {
    for (const pid of pids) {
      try { killImpl(pid, 'SIGTERM'); } catch {}
    }
    return;
  }
  if (platform === 'win32') {
    for (const pid of pids) {
      await invokeExecFile(execFileImpl, 'taskkill', ['/PID', String(pid)], { windowsHide: true, timeout: 5000 }).catch(() => {});
    }
  }
}

export async function runRelaunchWorker(rawPayload, deps = {}) {
  const payload = normalizeWorkerPayload(rawPayload);
  if (!payload) return { launched: false, reason: 'invalid-payload', remainingPids: [] };
  const {
    execFileImpl = execFile,
    spawnImpl = spawn,
    killImpl = (pid, signal) => process.kill(pid, signal),
    isPidAliveImpl = null,
    sleepImpl = ms => delay(ms),
    now = Date.now,
    env = process.env,
    quitTimeoutMs = DEFAULT_QUIT_TIMEOUT_MS,
    sigtermFallbackMs = DEFAULT_SIGTERM_FALLBACK_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    postExitDelayMs = DEFAULT_POST_EXIT_DELAY_MS,
  } = deps;
  const checkAlive = createPidChecker(killImpl, isPidAliveImpl);
  const { platform, pids, targetPath, debugArgs } = payload;

  if (pids.length > 0) {
    await sendGracefulQuit({ platform, pids, targetPath, execFileImpl, killImpl });
    const started = now();
    const maxTicks = Math.max(1, Math.ceil(quitTimeoutMs / Math.max(1, pollIntervalMs)));
    const sigtermTicks = Math.max(1, Math.ceil(sigtermFallbackMs / Math.max(1, pollIntervalMs)));
    let ticks = 0;
    let sigtermSent = false;
    let remaining = pids.filter(pid => checkAlive(pid));
    while (remaining.length > 0) {
      const elapsed = Math.max(0, now() - started);
      if (elapsed >= quitTimeoutMs || ticks >= maxTicks) {
        return { launched: false, reason: 'quit-timeout', remainingPids: remaining };
      }
      if (platform === 'darwin' && !sigtermSent && (elapsed >= sigtermFallbackMs || ticks >= sigtermTicks)) {
        sigtermSent = true;
        for (const pid of remaining) {
          try { killImpl(pid, 'SIGTERM'); } catch {}
        }
      }
      await sleepImpl(pollIntervalMs);
      ticks++;
      remaining = pids.filter(pid => checkAlive(pid));
    }
    if (postExitDelayMs > 0) {
      await sleepImpl(postExitDelayMs);
    }
  }

  const cleanEnv = stripHostEnv(env);
  const launchCommand = platform === 'darwin' ? 'open' : targetPath;
  const launchArgs = platform === 'darwin'
    ? ['-a', targetPath, '--args', ...debugArgs]
    : [...debugArgs];
  const child = spawnImpl(launchCommand, launchArgs, {
    detached: true,
    stdio: 'ignore',
    ...(platform === 'win32' ? { windowsHide: false } : {}),
    env: cleanEnv,
  });
  child?.on?.('error', () => {});
  child?.unref?.();
  return { launched: true, command: launchCommand, args: launchArgs, pidsCleared: pids };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  const payload = parseWorkerPayload(process.argv.slice(2), process.env);
  if (payload) {
    runRelaunchWorker(payload).catch(() => { process.exitCode = 1; });
  }
}
