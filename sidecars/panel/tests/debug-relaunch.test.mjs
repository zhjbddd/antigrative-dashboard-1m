import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEBUG_ARGS,
  inspectHostDebugState,
  parseDesktopProcesses,
  scheduleHostRelaunch,
} from '../../../compat/debug-relaunch.mjs';
import {
  parseWorkerPayload,
  runRelaunchWorker,
  stripHostEnv,
} from '../../../compat/debug-relaunch-worker.mjs';

test('inspectHostDebugState filters helpers/language_server and detects debug port across platforms', async () => {
  const dummyPs = [
    '  100 /Applications/Antigravity.app/Contents/MacOS/Antigravity',
    '  101 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --type=renderer',
    '  102 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --import=file:///sidecar_sdk/register_loader.js main.mjs',
    '  103 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone',
    '  104 /Applications/Antigravity.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --database=/tmp/cp',
    '  105 /usr/bin/caffeinate -i -s -w 100',
    '  106 zsh -c /Applications/Antigravity.app/Contents/MacOS/Antigravity',
    '  107 /bin/zsh -c /Applications/Antigravity.app/Contents/MacOS/Antigravity',
    '  108 /Applications/Antigravity.app/Contents/MacOS/Antigravity --headless --user-data-dir=/tmp/headless',
  ].join('\n');

  const macNoDebug = await inspectHostDebugState({
    platform: 'darwin',
    appResources: '/Applications/Antigravity.app/Contents/Resources',
    existsSyncImpl: p => p === '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
    execFileImpl: async (file, args) => {
      assert.equal(file, 'ps');
      assert.deepEqual(args, ['axo', 'pid=,command=']);
      return { stdout: dummyPs };
    },
  });
  assert.equal(macNoDebug.hostRunning, true);
  assert.deepEqual(macNoDebug.pids, [100]);
  assert.equal(macNoDebug.hasDebugFlag, false);
  assert.equal(macNoDebug.targetPath, '/Applications/Antigravity.app');

  const macWithDebug = await inspectHostDebugState({
    platform: 'darwin',
    appResources: '/Applications/Antigravity.app/Contents/Resources',
    existsSyncImpl: p => p === '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
    execFileImpl: async () => ({
      stdout: '  200 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0 --remote-debugging-address=127.0.0.1\n',
    }),
  });
  assert.equal(macWithDebug.hostRunning, true);
  assert.deepEqual(macWithDebug.pids, [200]);
  assert.equal(macWithDebug.hasDebugFlag, true);

  const linuxState = await inspectHostDebugState({
    platform: 'linux',
    appResources: '/opt/Antigravity/resources',
    existsSyncImpl: p => p === '/opt/Antigravity/antigravity',
    execFileImpl: async (file, args) => {
      assert.equal(file, 'ps');
      assert.deepEqual(args, ['-eo', 'pid=,args=']);
      return {
        stdout: [
          ' 301 /opt/Antigravity/antigravity --enable-features=Wayland',
          ' 302 /opt/Antigravity/antigravity --type=zygote',
          ' 303 /opt/Antigravity/antigravity --import=file:///register_loader.js main.mjs',
          ' 304 /opt/Antigravity/resources/bin/language_server --standalone',
        ].join('\n'),
      };
    },
  });
  assert.equal(linuxState.hostRunning, true);
  assert.deepEqual(linuxState.pids, [301]);
  assert.equal(linuxState.hasDebugFlag, false);
  assert.equal(linuxState.targetPath, '/opt/Antigravity/antigravity');

  const winState = await inspectHostDebugState({
    platform: 'win32',
    appResources: 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\resources',
    existsSyncImpl: p => p === 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
    execFileImpl: async (file, args, options) => {
      assert.equal(file, 'powershell.exe');
      assert.equal(options.windowsHide, true);
      assert.ok(args.at(-1).includes('Win32_Process'));
      return {
        stdout: '\uFEFF' + JSON.stringify([
          { ProcessId: 401, ExecutablePath: 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe', CommandLine: '"C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe"' },
          { ProcessId: 402, ExecutablePath: 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe', CommandLine: '"C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --type=gpu-process' },
          { ProcessId: 403, ExecutablePath: 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe', CommandLine: '"C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --import=file:///register_loader.js main.mjs' },
        ]),
      };
    },
  });
  assert.equal(winState.hostRunning, true);
  assert.deepEqual(winState.pids, [401]);
  assert.equal(winState.hasDebugFlag, false);
  assert.equal(winState.targetPath, 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe');
  assert.deepEqual(parseDesktopProcesses('null', 'win32'), []);
});

test('scheduleHostRelaunch enforces sliding 60s 2-try limit, >=5s interval, same-PID dedupe, 5s manual debounce, and ELECTRON_RUN_AS_NODE=1', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pulse-relaunch-guard-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  let currentNow = 100000;
  let psStdout = '';
  const spawns = [];
  const common = {
    dataDir,
    platform: 'darwin',
    appResources: '/Applications/Antigravity.app/Contents/Resources',
    existsSyncImpl: () => true,
    execFileImpl: async () => ({ stdout: psStdout }),
    spawnImpl: (file, args, options) => {
      const entry = { file, args, options, unreffed: false };
      spawns.push(entry);
      return { on() {}, unref() { entry.unreffed = true; } };
    },
    now: () => currentNow,
  };

  // Auto skips when host is not running
  psStdout = '';
  assert.equal((await scheduleHostRelaunch({ ...common, reason: 'auto' })).reason, 'host-not-running');
  assert.equal(spawns.length, 0);

  // Auto skips when debug flag is already present
  psStdout = ' 500 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0\n';
  assert.equal((await scheduleHostRelaunch({ ...common, reason: 'auto' })).reason, 'debug-flag-present');
  assert.equal(spawns.length, 0);

  // Auto schedules when hostRunning && !hasDebugFlag && targetPath
  psStdout = ' 500 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n';
  const first = await scheduleHostRelaunch({
    ...common,
    reason: 'auto',
    env: { PATH: '/usr/bin', ANTIGRAVITY_SIDECAR_WEB_PORT: '1234' },
  });
  assert.equal(first.scheduled, true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, process.execPath);
  assert.match(spawns[0].args[0], /debug-relaunch-worker\.mjs$/);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.stdio, 'ignore');
  assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(spawns[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawns[0].unreffed, true);

  const guard = JSON.parse(await readFile(join(dataDir, 'debug-relaunch-guard.json'), 'utf8'));
  assert.deepEqual(guard.pids, [500]);
  assert.deepEqual(guard.history, [100000]);

  // Same PID within 60000ms returns cooldown
  currentNow += 2000;
  assert.equal((await scheduleHostRelaunch({ ...common, reason: 'auto' })).reason, 'cooldown');
  assert.equal(spawns.length, 1);

  // Distinct PID within 5000ms minimum spacing returns cooldown
  psStdout = ' 550 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n';
  assert.equal((await scheduleHostRelaunch({ ...common, reason: 'auto' })).reason, 'cooldown');
  assert.equal(spawns.length, 1);

  // Distinct PID after >= 5000ms within 60000ms (e.g., immediate Restart to Update) is allowed as 2nd attempt
  currentNow += 18000; // currentNow = 120000 (20s after first)
  psStdout = ' 600 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n';
  const second = await scheduleHostRelaunch({ ...common, reason: 'auto' });
  assert.equal(second.scheduled, true);
  assert.equal(spawns.length, 2);

  // 3rd distinct PID within the same 60000ms window trips the circuit breaker
  currentNow += 10000; // currentNow = 130000 (30s after first)
  psStdout = ' 700 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n';
  assert.equal((await scheduleHostRelaunch({ ...common, reason: 'auto' })).reason, 'cooldown');
  assert.equal(spawns.length, 2);

  // Same PID 600 after 60000ms is still deduped
  currentNow += 55000; // currentNow = 185000 (65s after second)
  psStdout = ' 600 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n';
  assert.equal((await scheduleHostRelaunch({ ...common, reason: 'auto' })).reason, 'already-scheduled-for-pids');
  assert.equal(spawns.length, 2);

  // Once oldest entries expire out of 60000ms window, a distinct PID 700 is allowed again
  psStdout = ' 700 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n';
  assert.equal((await scheduleHostRelaunch({ ...common, reason: 'auto' })).scheduled, true);
  assert.equal(spawns.length, 3);

  // Manual debounce blocks within 5000ms, allows retry after 5000ms even for same PID 700
  currentNow += 2000;
  assert.equal((await scheduleHostRelaunch({ ...common, reason: 'manual' })).reason, 'debounced');
  assert.equal(spawns.length, 3);

  currentNow += 4000;
  assert.equal((await scheduleHostRelaunch({ ...common, reason: 'manual' })).scheduled, true);
  assert.equal(spawns.length, 4);
});

test('worker strips ELECTRON_RUN_AS_NODE and ANTIGRAVITY_* env, parses payloads, and handles quit/fallback/timeout', async () => {
  const cleaned = stripHostEnv({
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    ELECTRON_RUN_AS_NODE: '1',
    ANTIGRAVITY_SIDECAR_WEB_PORT: '9000',
    ANTIGRAVITY_CSRF_TOKEN: 'secret',
    antigravity_custom: 'x',
  });
  assert.deepEqual(cleaned, { PATH: '/usr/bin', HOME: '/tmp/home' });

  const sample = { platform: 'darwin', pids: [42], targetPath: '/Applications/Antigravity.app' };
  assert.equal(parseWorkerPayload([JSON.stringify(sample)]).targetPath, '/Applications/Antigravity.app');
  assert.equal(parseWorkerPayload(['--payload', JSON.stringify(sample)]).pids[0], 42);
  assert.equal(parseWorkerPayload([], { AG_PULSE_RELAUNCH_PAYLOAD: JSON.stringify(sample) }).pids[0], 42);
  assert.equal(parseWorkerPayload(['{bad-json}']), null);
  assert.equal(parseWorkerPayload([JSON.stringify({ targetPath: '/tmp/bad\nline' })]), null);

  // Darwin graceful quit + SIGTERM fallback at 8s + wait until 0 PIDs + 300ms delay + launch
  let clock = 0;
  const sleeps = [];
  const execCalls = [];
  const kills = [];
  const spawns = [];
  const macResult = await runRelaunchWorker(
    { platform: 'darwin', pids: [777], targetPath: '/Applications/Antigravity.app' },
    {
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1' },
      now: () => clock,
      sleepImpl: async ms => { sleeps.push(ms); clock += ms; },
      execFileImpl: async (file, args) => { execCalls.push({ file, args }); return { stdout: '' }; },
      killImpl: (pid, signal) => { kills.push({ pid, signal }); },
      isPidAliveImpl: () => clock < 8400,
      spawnImpl: (file, args, options) => {
        spawns.push({ file, args, options });
        return { on() {}, unref() {} };
      },
    },
  );
  assert.equal(macResult.launched, true);
  assert.deepEqual(execCalls, [{ file: 'osascript', args: ['-e', 'tell application "/Applications/Antigravity.app" to quit'] }]);
  assert.deepEqual(kills, [{ pid: 777, signal: 'SIGTERM' }]);
  assert.equal(sleeps.at(-1), 300);
  assert.equal(spawns[0].file, 'open');
  assert.deepEqual(spawns[0].args, ['-a', '/Applications/Antigravity.app', '--args', ...DEBUG_ARGS]);
  assert.equal(spawns[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(spawns[0].options.env.ANTIGRAVITY_LS_ADDRESS, undefined);

  // Quit timeout aborts launch if old PID never exits
  let timeoutClock = 0;
  let spawnedOnTimeout = false;
  const timeoutResult = await runRelaunchWorker(
    { platform: 'linux', pids: [888], targetPath: '/opt/Antigravity/antigravity' },
    {
      now: () => timeoutClock,
      sleepImpl: async ms => { timeoutClock += ms; },
      killImpl: () => {},
      isPidAliveImpl: () => true,
      spawnImpl: () => { spawnedOnTimeout = true; return { on() {}, unref() {} }; },
    },
  );
  assert.equal(timeoutResult.launched, false);
  assert.equal(timeoutResult.reason, 'quit-timeout');
  assert.deepEqual(timeoutResult.remainingPids, [888]);
  assert.equal(spawnedOnTimeout, false);

  // Win32 sends taskkill /PID and strips host env
  const winExecs = [];
  const winSpawns = [];
  let winAlive = true;
  const winResult = await runRelaunchWorker(
    { platform: 'win32', pids: [999], targetPath: 'C:\\Apps\\Antigravity\\Antigravity.exe' },
    {
      env: { SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', ANTIGRAVITY_CSRF_TOKEN: 'x' },
      sleepImpl: async () => { winAlive = false; },
      execFileImpl: async (file, args) => { winExecs.push({ file, args }); return { stdout: '' }; },
      isPidAliveImpl: () => winAlive,
      spawnImpl: (file, args, options) => { winSpawns.push({ file, args, options }); return { on() {}, unref() {} }; },
    },
  );
  assert.equal(winResult.launched, true);
  assert.deepEqual(winExecs, [{ file: 'taskkill', args: ['/PID', '999'] }]);
  assert.equal(winSpawns[0].file, 'C:\\Apps\\Antigravity\\Antigravity.exe');
  assert.deepEqual(winSpawns[0].args, DEBUG_ARGS);
  assert.equal(winSpawns[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(winSpawns[0].options.env.ANTIGRAVITY_CSRF_TOKEN, undefined);
});

test('real worker kills an isolated dummy node PID before spawning target with clean env', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-worker-real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outFile = join(dir, 'launched.json');
  const dummyLauncher = join(dir, 'dummy-app.mjs');
  await writeFile(
    dummyLauncher,
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(outFile)}, JSON.stringify({ argv: process.argv.slice(2), hasElectronRunAsNode: Object.hasOwn(process.env, 'ELECTRON_RUN_AS_NODE'), hasAntigravityEnv: Object.keys(process.env).some(k => k.startsWith('ANTIGRAVITY_')), pathEnv: process.env.PATH || null }));\n`,
    'utf8',
  );
  await chmod(dummyLauncher, 0o755);

  const dummyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
    stdio: 'ignore',
    detached: false,
  });
  t.after(() => { try { dummyChild.kill('SIGKILL'); } catch {} });
  await new Promise(resolve => setTimeout(resolve, 100));

  const workerFile = new URL('../../../compat/debug-relaunch-worker.mjs', import.meta.url).pathname;
  const payload = {
    platform: 'linux',
    pids: [dummyChild.pid],
    targetPath: dummyLauncher,
  };
  const childExit = new Promise(resolve => dummyChild.once('exit', resolve));
  const workerResult = await new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [workerFile, JSON.stringify(payload)], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ANTIGRAVITY_SIDECAR_WEB_PORT: '19999',
        ANTIGRAVITY_CSRF_TOKEN: 'secret-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    worker.stderr.on('data', chunk => { stderr += chunk; });
    worker.once('error', reject);
    worker.once('exit', code => resolve({ status: code, stderr }));
  });
  assert.equal(workerResult.status, 0, workerResult.stderr);
  await childExit;

  assert.throws(() => process.kill(dummyChild.pid, 0), /ESRCH/);

  const deadline = Date.now() + 5000;
  let launched = null;
  while (Date.now() < deadline) {
    try {
      launched = JSON.parse(await readFile(outFile, 'utf8'));
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  assert.ok(launched, 'dummy target launcher should have written output file');
  assert.deepEqual(launched.argv, DEBUG_ARGS);
  assert.equal(launched.hasElectronRunAsNode, false);
  assert.equal(launched.hasAntigravityEnv, false);
});
