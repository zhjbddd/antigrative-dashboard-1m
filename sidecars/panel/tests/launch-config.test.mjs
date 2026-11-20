import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESKTOP_MANAGED_MARKER,
  ensureDesktopLaunchConfig,
  inspectDesktopLaunch,
  inspectHostArchive,
  isAntigravityDesktopShortcut,
  mergeDebugArguments,
  mergeDesktopEntry,
  parseLnkBuffer,
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
