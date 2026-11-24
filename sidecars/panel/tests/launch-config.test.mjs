import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import {
  DESKTOP_MANAGED_MARKER,
  MACOS_LAUNCHER_NAME,
  MACOS_MANAGED_PLIST_KEY,
  ensureDesktopLaunchConfig,
  inspectDesktopLaunch,
  inspectHostArchive,
  isAntigravityDesktopShortcut,
  mergeDebugArguments,
  mergeDesktopEntry,
  parseLnkBuffer,
  toAsciiJson,
} from '../../../compat/launch-config.mjs';
import { RuntimeUi } from '../../../compat/runtime-ui.mjs';

function buildAsar(filesMap) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  const insert = (tree, parts, data) => {
    if (parts.length === 1) {
      chunks.push(data);
      tree[parts[0]] = { size: data.length, offset: String(offset) };
      offset += data.length;
      return;
    }
    tree[parts[0]] ??= { files: {} };
    insert(tree[parts[0]].files, parts.slice(1), data);
  };
  for (const [rel, buf] of Object.entries(filesMap)) insert(header.files, rel.split('/'), buf);
  const raw = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (raw.length % 4)) % 4;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + raw.length + pad, 4);
  head.writeUInt32LE(4 + raw.length + pad, 8);
  head.writeUInt32LE(raw.length, 12);
  return Buffer.concat([head, raw, Buffer.alloc(pad), ...chunks]);
}

function buildLnk(target, args = '', icon = '') {
  let flags = 0x02 | 0x80;
  if (args) flags |= 0x20;
  if (icon) flags |= 0x40;
  const hdr = Buffer.alloc(76);
  hdr.writeUInt32LE(0x4c, 0);
  hdr.writeUInt32LE(flags, 0x14);

  const ansi = Buffer.from(target + '\0', 'latin1');
  const uni = Buffer.from(target + '\0', 'utf16le');
  const infoHdrLen = 0x24;
  const lbOff = infoHdrLen;
  const ubOff = lbOff + ansi.length;
  const infoLen = ubOff + uni.length;
  const infoHdr = Buffer.alloc(36);
  infoHdr.writeUInt32LE(infoLen, 0);
  infoHdr.writeUInt32LE(infoHdrLen, 4);
  infoHdr.writeUInt32LE(0x01, 8);
  infoHdr.writeUInt32LE(lbOff, 16);
  infoHdr.writeUInt32LE(ubOff, 28);

  const strParts = [];
  for (const [flag, val] of [[0x20, args], [0x40, icon]]) {
    if (flags & flag) {
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16LE(val.length, 0);
      strParts.push(lenBuf, Buffer.from(val, 'utf16le'));
    }
  }
  return Buffer.concat([hdr, infoHdr, ansi, uni, ...strParts]);
}

test('inspectHostArchive detects 2.32.2 vs 2.33.0 and refreshes cache on mtime/size change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-pulse-asar-'));
  try {
    const asar = join(dir, 'app.asar');
    await writeFile(asar, buildAsar({
      'package.json': Buffer.from(JSON.stringify({ version: '2.32.2' })),
      'dist/main.js': Buffer.from("app.commandLine.appendSwitch('remote-debugging-port', '0');"),
    }));
    assert.deepEqual(await inspectHostArchive(dir), { version: '2.32.2', requiresDebugFlag: false });

    await writeFile(asar, buildAsar({
      'package.json': Buffer.from(JSON.stringify({ version: '2.33.0' })),
      'dist/main.js': Buffer.from("if (!app.commandLine.hasSwitch('remote-debugging-port')) { removeStaleActivePortFile(p); }"),
    }));
    const future = new Date(Date.now() + 5000);
    await utimes(asar, future, future);
    assert.deepEqual(await inspectHostArchive(dir), { version: '2.33.0', requiresDebugFlag: true });
    assert.deepEqual(await inspectHostArchive(join(dir, 'missing.asar')), { version: null, requiresDebugFlag: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseLnkBuffer, shortcut filter and argument merging match Desktop shortcuts only', () => {
  const buf = buildLnk('C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe', '--flag=1');
  const parsed = parseLnkBuffer(buf);
  assert.equal(parsed.target, 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe');
  assert.equal(parsed.args, '--flag=1');
  assert.equal(isAntigravityDesktopShortcut('C:\\Users\\demo\\Desktop\\Antigravity.lnk', parsed), true);
  assert.equal(isAntigravityDesktopShortcut('C:\\Users\\demo\\Desktop\\Antigravity.lnk', {
    target: 'C:\\Tools\\AntigravityProxy.exe', args: '', icon: 'C:\\Apps\\Antigravity.exe',
  }), true);
  assert.equal(isAntigravityDesktopShortcut('C:\\Users\\demo\\Desktop\\Antigravity IDE - Dashboard Preview.lnk', {
    target: 'C:\\Tools\\AntigravityProxy.exe', args: '--ide', icon: 'D:\\IDE\\Antigravity IDE.exe',
  }), false);
  assert.equal(isAntigravityDesktopShortcut('C:\\Users\\demo\\Desktop\\Antigravity (代理).lnk', {
    target: 'C:\\Users\\demo\\.antigravity-proxy\\AntigravityLauncher.exe', args: '', icon: 'C:\\Apps\\Antigravity.exe',
  }), true);
  assert.equal(isAntigravityDesktopShortcut('C:\\Users\\demo\\Desktop\\Antigravity (Proxy).lnk', {
    target: 'C:\\Users\\demo\\.antigravity-proxy\\AntigravityLauncher.exe', args: '', icon: 'C:\\Apps\\Antigravity.exe,0',
  }), true);
  assert.equal(isAntigravityDesktopShortcut('C:\\Users\\demo\\Desktop\\Antigravity (Прокси).lnk', {
    target: 'C:\\Users\\demo\\.antigravity-proxy\\AntigravityLauncher.exe', args: '', icon: '',
  }), true);
  assert.equal(isAntigravityDesktopShortcut('C:\\Users\\demo\\Desktop\\Antigravity (代理).lnk', {
    target: 'C:\\Users\\demo\\.antigravity-proxy\\AntigravityLauncher.exe', args: '', icon: 'D:\\IDE\\Antigravity IDE.exe',
  }), false);
  assert.equal(isAntigravityDesktopShortcut('C:\\Users\\demo\\Desktop\\Antigravity (Proxy).lnk', {
    target: 'C:\\Users\\demo\\.antigravity-proxy\\AntigravityLauncher.exe', args: '--ide', icon: 'C:\\Apps\\Antigravity.exe',
  }), false);
  assert.equal(isAntigravityDesktopShortcut('C:\\Users\\demo\\Desktop\\Unrelated.lnk', {
    target: 'C:\\Users\\demo\\.antigravity-proxy\\AntigravityLauncher.exe', args: '', icon: '',
  }), false);

  const merged = mergeDebugArguments('--foo -- bar');
  assert.deepEqual(merged.added, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']);
  assert.equal(merged.args, '--foo --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 -- bar');
  assert.deepEqual(mergeDebugArguments(merged.args), { args: merged.args, added: [] });
});

test('ensureDesktopLaunchConfig uses zero-subprocess fast path and self-heals overwritten shortcuts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ag-pulse-win-'));
  try {
    const desktop = join(home, 'Desktop');
    const settingsPath = join(home, 'Local', 'settings.json');
    await mkdir(desktop, { recursive: true });
    const lnk = join(desktop, 'Antigravity.lnk');
    await writeFile(lnk, buildLnk('C:\\Apps\\Antigravity.exe', '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1'));

    let psCalls = 0;
    const execPowerShell = async updates => {
      psCalls++;
      for (const item of updates) {
        const info = parseLnkBuffer(await readFile(item.path));
        await writeFile(item.path, buildLnk(info.target, item.args, info.icon || ''));
      }
    };

    const fast = await ensureDesktopLaunchConfig({ platform: 'win32', home, env: {}, settingsPath, execPowerShell });
    assert.deepEqual(fast, { configured: true, repaired: false, supported: true, entrypoints: [lnk] });
    assert.equal(psCalls, 0);

    // Simulate Antigravity installer overwriting shortcut args back to empty.
    await writeFile(lnk, buildLnk('C:\\Apps\\Antigravity.exe', ''));
    const repaired = await ensureDesktopLaunchConfig({ platform: 'win32', home, env: {}, settingsPath, execPowerShell });
    assert.deepEqual(repaired, { configured: true, repaired: true, supported: true, entrypoints: [lnk] });
    assert.equal(psCalls, 1);
    assert.equal(parseLnkBuffer(await readFile(lnk)).args, '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1');
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(saved.managedLaunch.windowsShortcuts[lnk], ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('ensureDesktopLaunchConfig configures Linux desktop file without overwriting unmanaged user files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-pulse-linux-'));
  try {
    const home = join(dir, 'home');
    const sysApps = join(dir, 'sys');
    await mkdir(sysApps, { recursive: true });
    await writeFile(join(sysApps, 'antigravity.desktop'), '[Desktop Entry]\nName=Antigravity\nExec=/opt/Antigravity/antigravity %F\n');
    const repaired = await ensureDesktopLaunchConfig({ platform: 'linux', home, env: {}, systemDirs: [sysApps] });
    assert.equal(repaired.configured, true);
    assert.equal(repaired.repaired, true);
    const userFile = join(home, '.local', 'share', 'applications', 'antigravity.desktop');
    const text = await readFile(userFile, 'utf8');
    assert.ok(text.includes('Exec=/opt/Antigravity/antigravity --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 %F'));
    assert.ok(text.includes(DESKTOP_MANAGED_MARKER));
    assert.equal((await inspectDesktopLaunch({ platform: 'linux', home, env: {} })).configured, true);

    assert.equal(mergeDesktopEntry('[Desktop Entry]\nExec=/bin/ag --remote-debugging-port=0 %U\n').includes(DESKTOP_MANAGED_MARKER), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureDesktopLaunchConfig creates and self-heals macOS launcher app without overwriting unmanaged apps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-pulse-macos-'));
  try {
    const home = join(dir, 'home');
    const sysApps = join(dir, 'Applications');
    const targetApp = join(sysApps, 'Antigravity.app');
    const settingsPath = join(home, 'Library', 'Application Support', 'AntigravityPulse', 'settings.json');
    await mkdir(join(targetApp, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(targetApp, 'Contents', 'Resources'), { recursive: true });
    await writeFile(join(targetApp, 'Contents', 'MacOS', 'Antigravity'), 'bin');
    await writeFile(join(targetApp, 'Contents', 'Resources', 'app.asar'), 'asar');
    await writeFile(join(targetApp, 'Contents', 'Resources', 'electron.icns'), 'ICNS');

    const created = await ensureDesktopLaunchConfig({
      platform: 'darwin',
      home,
      env: {},
      settingsPath,
      appResources: join(targetApp, 'Contents', 'Resources'),
      profile: join(home, 'Library', 'Application Support', 'Antigravity'),
      systemAppDirs: [sysApps],
    });
    const bundle = join(home, 'Applications', MACOS_LAUNCHER_NAME);
    assert.deepEqual(created, { configured: true, repaired: true, supported: true, entrypoints: [bundle] });
    const plist = await readFile(join(bundle, 'Contents', 'Info.plist'), 'utf8');
    const script = await readFile(join(bundle, 'Contents', 'MacOS', 'launcher'), 'utf8');
    assert.ok(plist.includes(MACOS_MANAGED_PLIST_KEY));
    assert.ok(plist.includes('<key>LSUIElement</key>'));
    assert.ok(script.includes(DESKTOP_MANAGED_MARKER));
    assert.ok(script.includes('--remote-debugging-port=0 --remote-debugging-address=127.0.0.1'));
    assert.equal(await readFile(join(bundle, 'Contents', 'Resources', 'app.icns'), 'utf8'), 'ICNS');
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(saved.managedLaunch.macosLauncherApp, bundle);

    // Fast path when already configured.
    const fast = await ensureDesktopLaunchConfig({ platform: 'darwin', home, env: {}, settingsPath, systemAppDirs: [sysApps] });
    assert.deepEqual(fast, { configured: true, repaired: false, supported: true, entrypoints: [bundle] });
    assert.equal((await inspectDesktopLaunch({ platform: 'darwin', home, env: {} })).configured, true);

    // Unmanaged bundle with same name must not be overwritten.
    await rm(bundle, { recursive: true, force: true });
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(join(bundle, 'Contents', 'Info.plist'), '<plist><dict/></plist>');
    await writeFile(join(bundle, 'Contents', 'MacOS', 'launcher'), '#!/bin/sh\necho custom\n');
    const unmanaged = await ensureDesktopLaunchConfig({ platform: 'darwin', home, env: {}, systemAppDirs: [sysApps] });
    assert.deepEqual(unmanaged, { configured: false, repaired: false, supported: true, entrypoints: [bundle] });
    assert.equal(await readFile(join(bundle, 'Contents', 'MacOS', 'launcher'), 'utf8'), '#!/bin/sh\necho custom\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RuntimeUi surfaces debug-port-disabled diagnosis on ENOENT and clears it upon target recovery', async () => {
  let failDiscovery = true;
  const ui = new RuntimeUi({
    snapshot: async () => ({ connection: 'live', groups: [], speed: null }),
    source: 'safe-widget',
    discover: async () => {
      if (failDiscovery) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [];
    },
    diagnoseError: async error => error.code === 'ENOENT'
      ? { reason: 'debug-port-disabled', hostVersion: '2.33.0', launchConfigured: true, message: 'Configured; restart host' }
      : null,
  });

  await ui.tick();
  assert.equal(ui.health.state, 'reconnecting');
  assert.equal(ui.health.reason, 'debug-port-disabled');
  assert.equal(ui.health.hostVersion, '2.33.0');
  assert.equal(ui.health.launchConfigured, true);

  failDiscovery = false;
  await ui.tick();
  assert.equal(ui.health.state, 'waiting');
  assert.equal('reason' in ui.health, false);
  assert.equal('hostVersion' in ui.health, false);
  assert.equal('launchConfigured' in ui.health, false);
  await ui.stop();
});

test('RuntimeUi gracefully degrades to unavailable with backoff in remote SSH/WSL hubs and recovers cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-pulse-remote-hub-'));
  try {
    let failDiscovery = true;
    const ui = new RuntimeUi({
      dataDir: dir,
      interval: 50,
      snapshot: async () => ({ connection: 'live', groups: [], speed: null }),
      source: 'safe-widget',
      discover: async () => {
        if (failDiscovery) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return [];
      },
      diagnoseError: async error => error.code === 'ENOENT'
        ? { state: 'unavailable', reason: 'remote-hub', message: 'Remote SSH/WSL hub' }
        : null,
    });

    await ui.tick();
    assert.equal(ui.health.state, 'unavailable');
    assert.equal(ui.health.reason, 'remote-hub');
    assert.ok(ui.nextTickAt > Date.now() + 30000, 'unavailable state should back off polling');
    const savedFirst = JSON.parse(await readFile(join(dir, 'integration-state.json'), 'utf8'));
    assert.equal(savedFirst.state, 'unavailable');
    assert.equal(savedFirst.reason, 'remote-hub');

    // Repeated unchanged unavailable ticks do not rewrite integration-state.json needlessly.
    await ui.tick();
    const savedSecond = JSON.parse(await readFile(join(dir, 'integration-state.json'), 'utf8'));
    assert.equal(savedSecond.checkedAt, savedFirst.checkedAt);

    // If targets appear later, backoff and remote-hub reason clear immediately.
    failDiscovery = false;
    await ui.tick();
    assert.equal(ui.health.state, 'waiting');
    assert.equal(ui.nextTickAt, 0);
    assert.equal('reason' in ui.health, false);
    await ui.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureDesktopLaunchConfig discovers and repairs Windows shortcuts on redirected Desktop and OneDrive Desktop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ag-pulse-win-redirect-'));
  try {
    const home = join(root, 'C_Users_demo');
    const redirectedDesktop = join(root, 'D_Users_demo', 'Desktop');
    const oneDriveRoot = join(root, 'OneDrive');
    const oneDriveDesktop = join(oneDriveRoot, 'Desktop');
    const programs = join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const settingsPath = join(root, 'Local', 'settings.json');
    await Promise.all([
      mkdir(join(home, 'Desktop'), { recursive: true }),
      mkdir(redirectedDesktop, { recursive: true }),
      mkdir(oneDriveDesktop, { recursive: true }),
      mkdir(programs, { recursive: true }),
    ]);

    const redirLnk = join(redirectedDesktop, 'Antigravity.lnk');
    const odLnk = join(oneDriveDesktop, 'Antigravity.lnk');
    const startLnk = join(programs, 'Antigravity.lnk');
    await writeFile(redirLnk, buildLnk('C:\\Apps\\Antigravity.exe', ''));
    await writeFile(odLnk, buildLnk('C:\\Apps\\Antigravity.exe', ''));
    await writeFile(startLnk, buildLnk('C:\\Apps\\Antigravity.exe', '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1'));

    const updatesSeen = [];
    const execPowerShell = async updates => {
      updatesSeen.push(...updates);
      for (const item of updates) {
        const info = parseLnkBuffer(await readFile(item.path));
        await writeFile(item.path, buildLnk(info.target, item.args, info.icon || ''));
      }
    };

    const env = { CUSTOM_DISK: join(root, 'D_Users_demo'), OneDrive: oneDriveRoot };
    const resolveKnownFolders = async () => ({ desktop: '%CUSTOM_DISK%\\Desktop' });

    const before = await inspectDesktopLaunch({ platform: 'win32', home, env, resolveKnownFolders });
    assert.equal(before.configured, false);
    assert.deepEqual(new Set(before.entrypoints), new Set([redirLnk, odLnk, startLnk]));

    const repaired = await ensureDesktopLaunchConfig({
      platform: 'win32', home, env, settingsPath, execPowerShell, resolveKnownFolders,
    });
    assert.equal(repaired.configured, true);
    assert.equal(repaired.repaired, true);
    assert.deepEqual(new Set(repaired.entrypoints), new Set([redirLnk, odLnk, startLnk]));
    assert.deepEqual(new Set(updatesSeen.map(u => u.path)), new Set([redirLnk, odLnk]));
    assert.equal(parseLnkBuffer(await readFile(redirLnk)).args, '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1');
    assert.equal(parseLnkBuffer(await readFile(odLnk)).args, '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1');

    const after = await inspectDesktopLaunch({ platform: 'win32', home, env, resolveKnownFolders });
    assert.equal(after.configured, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('toAsciiJson escapes non-ASCII shortcut paths cleanly for Windows PowerShell stdin', () => {
  const payload = [
    { path: 'D:\\Users\\张三\\桌面\\Antigravity (代理).lnk', args: '--remote-debugging-port=0' },
    { path: 'C:\\Users\\Тест\\Desktop\\Antigravity (Прокси).lnk', args: '--remote-debugging-port=0' },
  ];
  const serialized = toAsciiJson(payload);
  assert.equal(/[^\x00-\x7f]/.test(serialized), false, 'serialized payload must be strictly pure ASCII');
  assert.deepEqual(JSON.parse(serialized), payload);
});

test('defaultExecPowerShell updates real Windows shortcuts under Chinese folders and filenames', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ag-pulse-cn-lnk-'));
  try {
    const home = join(root, '用户');
    const cnDesktop = join(home, '桌面');
    const settingsPath = join(root, 'settings.json');
    await mkdir(cnDesktop, { recursive: true });
    const lnkCn = join(cnDesktop, 'Antigravity (代理).lnk');
    const lnkRu = join(cnDesktop, 'Antigravity (Прокси).lnk');
    const fakeExe = join(root, 'AntigravityLauncher.exe');
    await writeFile(fakeExe, '');

    // Create real Windows .lnk files via WScript.Shell (staged via ASCII temp path so creation
    // works even on en-US CP1252 Windows runners where WshShortcut.Save() rejects non-ACP paths).
    const createScript = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
      '$items = [Console]::In.ReadToEnd() | ConvertFrom-Json',
      '$ws = New-Object -ComObject WScript.Shell',
      'foreach ($it in @($items)) {',
      '  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ag-lnk-init-" + [guid]::NewGuid().ToString("N") + ".lnk")',
      '  try {',
      '    $s = $ws.CreateShortcut($tmp)',
      '    $s.TargetPath = [string]$it.target',
      '    $s.Arguments = ""',
      '    $s.Save()',
      '    Copy-Item -LiteralPath $tmp -Destination $it.path -Force',
      '  } finally {',
      '    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue',
      '  }',
      '}',
    ].join('\n');
    await new Promise((resolve, reject) => {
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(createScript, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15000 }, err => (err ? reject(err) : resolve()));
      child.stdin.end(toAsciiJson([{ path: lnkCn, target: fakeExe }, { path: lnkRu, target: fakeExe }]), 'ascii');
    });

    const resolveKnownFolders = async () => ({ desktop: cnDesktop });
    const repaired = await ensureDesktopLaunchConfig({ platform: 'win32', home, env: {}, settingsPath, resolveKnownFolders });
    assert.equal(repaired.configured, true, 'real PowerShell update must succeed for Chinese/Unicode shortcut paths');
    assert.equal(repaired.repaired, true);
    assert.equal(parseLnkBuffer(await readFile(lnkCn)).args, '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1');
    assert.equal(parseLnkBuffer(await readFile(lnkRu)).args, '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
