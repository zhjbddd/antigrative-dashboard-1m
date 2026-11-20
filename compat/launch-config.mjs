// User-owned desktop launch configuration and host archive inspection.
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';

export const DEBUG_PORT_FLAG = '--remote-debugging-port=0';
export const DEBUG_ADDRESS_FLAG = '--remote-debugging-address=127.0.0.1';
export const DEBUG_ARGS = [DEBUG_PORT_FLAG, DEBUG_ADDRESS_FLAG];
export const DESKTOP_MANAGED_MARKER = 'X-Antigravity-Pulse-Managed=true';

const archiveCache = new Map();

async function isLink(targetPath) {
  try {
    const info = await lstat(targetPath);
    return info.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function inspectHostArchive(appResourcesOrAsar) {
  if (!appResourcesOrAsar || typeof appResourcesOrAsar !== 'string') {
    return { version: null, requiresDebugFlag: false };
  }
  let target = resolve(appResourcesOrAsar);
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, 'app.asar');
  } catch {
    return { version: null, requiresDebugFlag: false };
  }
  if (await isLink(target)) return { version: null, requiresDebugFlag: false };
  let fileStat;
  try {
    fileStat = await stat(target);
    if (!fileStat.isFile()) return { version: null, requiresDebugFlag: false };
  } catch {
    return { version: null, requiresDebugFlag: false };
  }
  const cached = archiveCache.get(target);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached.result;
  }
  let result = { version: null, requiresDebugFlag: false };
  let handle;
  try {
    handle = await open(target, 'r');
    const head = Buffer.alloc(16);
    const { bytesRead: headBytes } = await handle.read(head, 0, 16, 0);
    if (headBytes === 16) {
      const pickleSize = head.readUInt32LE(0);
      const headerSize = head.readUInt32LE(4);
      const jsonSize = head.readUInt32LE(12);
      if (pickleSize === 4 && jsonSize > 0 && jsonSize <= 16 * 1024 * 1024) {
        const rawHeader = Buffer.alloc(jsonSize);
        const { bytesRead: hdrBytes } = await handle.read(rawHeader, 0, jsonSize, 16);
        if (hdrBytes === jsonSize) {
          const header = JSON.parse(rawHeader.toString('utf8'));
          const base = 8 + headerSize;
          const readEntry = async (entry, limit) => {
            if (!entry || typeof entry !== 'object' || entry.unpacked) return null;
            const size = entry.size;
            if (!Number.isSafeInteger(size) || size < 0 || size > limit) return null;
            const buf = Buffer.alloc(size);
            const { bytesRead } = await handle.read(buf, 0, size, base + Number(entry.offset));
            return bytesRead === size ? buf : null;
          };
          const files = header.files || {};
          const pkgBuf = await readEntry(files['package.json'], 65536);
          let version = null;
          if (pkgBuf) {
            const pkg = JSON.parse(pkgBuf.toString('utf8'));
            if (typeof pkg.version === 'string' && pkg.version.trim()) version = pkg.version.trim();
          }
          const mainBuf = await readEntry(files.dist?.files?.['main.js'], 1048576);
          let requiresDebugFlag = false;
          if (mainBuf) {
            const mainJs = mainBuf.toString('utf8');
            const hasOptIn = mainJs.includes("hasSwitch('remote-debugging-port')")
              || mainJs.includes('hasSwitch("remote-debugging-port")')
              || mainJs.includes('removeStaleActivePortFile');
            const setsDefault = mainJs.includes("appendSwitch('remote-debugging-port'")
              || mainJs.includes('appendSwitch("remote-debugging-port"');
            requiresDebugFlag = hasOptIn && !setsDefault;
          }
          result = { version, requiresDebugFlag };
        }
      }
    }
  } catch {
    result = { version: null, requiresDebugFlag: false };
  } finally {
    await handle?.close().catch(() => {});
  }
  archiveCache.set(target, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, result });
  return result;
}

export function parseLnkBuffer(data) {
  if (!Buffer.isBuffer(data) || data.length < 76 || data.length > 1048576 || data.readUInt32LE(0) !== 0x4c) {
    return null;
  }
  const flags = data.readUInt32LE(0x14);
  const unicodeStr = Boolean(flags & 0x80);
  let pos = 76;
  if (flags & 0x01) {
    if (pos + 2 > data.length) return null;
    const idLen = data.readUInt16LE(pos);
    pos += 2 + idLen;
  }
  if (pos > data.length) return null;
  let target = null;
  if (flags & 0x02) {
    if (pos + 12 > data.length) return null;
    const infoLen = data.readUInt32LE(pos);
    const infoHdrLen = data.readUInt32LE(pos + 4);
    const infoFlags = data.readUInt32LE(pos + 8);
    if (infoLen < 12 || pos + infoLen > data.length) return null;
    if ((infoFlags & 0x01) && infoLen >= 20) {
      const lbOff = data.readUInt32LE(pos + 16);
      if (lbOff > 0 && lbOff < infoLen) {
        let end = data.indexOf(0, pos + lbOff);
        if (end === -1 || end > pos + infoLen) end = pos + infoLen;
        target = data.subarray(pos + lbOff, end).toString('latin1');
      }
      if (infoHdrLen >= 0x24 && infoLen >= 32) {
        const ubOff = data.readUInt32LE(pos + 28);
        if (ubOff > 0 && ubOff < infoLen) {
          const raw = data.subarray(pos + ubOff, pos + infoLen);
          let uend = raw.length;
          for (let i = 0; i + 1 < raw.length; i += 2) {
            if (raw[i] === 0 && raw[i + 1] === 0) { uend = i; break; }
          }
          target = raw.subarray(0, uend).toString('utf16le');
        }
      }
    }
    pos += infoLen;
  }
  const strings = {};
  for (const [flag, key] of [[0x04, 'name'], [0x08, 'rel'], [0x10, 'workdir'], [0x20, 'args'], [0x40, 'icon']]) {
    if (flags & flag) {
      if (pos + 2 > data.length) return null;
      const count = data.readUInt16LE(pos);
      pos += 2;
      const byteLen = count * (unicodeStr ? 2 : 1);
      if (pos + byteLen > data.length) return null;
      strings[key] = data.subarray(pos, pos + byteLen).toString(unicodeStr ? 'utf16le' : 'latin1');
      pos += byteLen;
    }
  }
  return { target, ...strings };
}

function tokenizeArgs(argsText) {
  return String(argsText || '').match(/"[^"]*"|\S+/g) || [];
}

function stripQuotes(token) {
  return token.replace(/^["']|["']$/g, '');
}

export function hasDebugFlags(argsText) {
  const clean = tokenizeArgs(argsText).map(stripQuotes);
  return {
    hasPort: clean.some(item => item === '--remote-debugging-port' || item.startsWith('--remote-debugging-port=')),
    hasAddress: clean.some(item => item === '--remote-debugging-address' || item.startsWith('--remote-debugging-address=')),
  };
}

export function isAntigravityDesktopShortcut(shortcutPath, info) {
  if (!info || !info.target) return false;
  const tokens = tokenizeArgs(info.args || '').map(t => stripQuotes(t).toLowerCase());
  if (tokens.some(t => t === '--ide' || t.startsWith('--ide='))) return false;
  const targetName = win32.basename(info.target).toLowerCase();
  if (targetName === 'antigravity.exe') return true;
  if (targetName === 'antigravityproxy.exe') {
    const lnkName = win32.basename(shortcutPath).toLowerCase();
    const iconName = info.icon ? win32.basename(info.icon).toLowerCase() : '';
    return lnkName === 'antigravity.lnk' || iconName === 'antigravity.exe';
  }
  return false;
}

export function mergeDebugArguments(argsText = '') {
  const tokens = tokenizeArgs(argsText);
  const clean = tokens.map(stripQuotes);
  const { hasPort, hasAddress } = hasDebugFlags(argsText);
  const added = [];
  if (!hasPort) added.push(DEBUG_PORT_FLAG);
  if (!hasAddress) added.push(DEBUG_ADDRESS_FLAG);
  if (!added.length) return { args: argsText || '', added: [] };
  const ddIndex = clean.indexOf('--');
  const next = ddIndex >= 0
    ? [...tokens.slice(0, ddIndex), ...added, ...tokens.slice(ddIndex)]
    : [...tokens, ...added];
  return { args: next.join(' '), added };
}

export function mergeDesktopEntry(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let inEntry = false;
  let markerWritten = lines.some(line => line.trim() === DESKTOP_MANAGED_MARKER);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inEntry && !markerWritten) {
        out.push(DESKTOP_MANAGED_MARKER);
        markerWritten = true;
      }
      inEntry = trimmed === '[Desktop Entry]';
      out.push(line);
      continue;
    }
    const execMatch = line.match(/^(\s*Exec\s*=\s*)(.+)$/);
    if (execMatch) {
      let rhs = execMatch[2].trimEnd();
      if (!rhs.includes('--remote-debugging-port')) {
        const field = rhs.match(/\s+%[fFuUdDnNickvm]/);
        const flags = `${DEBUG_PORT_FLAG} ${DEBUG_ADDRESS_FLAG}`;
        rhs = field
          ? `${rhs.slice(0, field.index)} ${flags}${rhs.slice(field.index)}`
          : `${rhs} ${flags}`;
      }
      out.push(execMatch[1] + rhs);
      continue;
    }
    out.push(line);
  }
  if (inEntry && !markerWritten) out.push(DESKTOP_MANAGED_MARKER);
  return out.join('\n') + '\n';
}

function windowsShortcutRoots({ home = homedir(), env = process.env } = {}) {
  const isRealHome = resolve(home) === resolve(homedir());
  const appdata = isRealHome && env.APPDATA ? env.APPDATA : join(home, 'AppData', 'Roaming');
  return [
    join(home, 'Desktop'),
    join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(appdata, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ];
}

async function iterLnkFiles(roots) {
  const results = [];
  const seen = new Set();
  const walk = async dir => {
    if (await isLink(dir)) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink() || await isLink(full)) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
        const key = full.toLowerCase();
        if (!seen.has(key)) { seen.add(key); results.push(full); }
      }
    }
  };
  for (const root of roots) await walk(root);
  return results;
}

function linuxDesktopPaths({ home = homedir(), env = process.env, systemDirs } = {}) {
  const isRealHome = resolve(home) === resolve(homedir());
  const dataHome = isRealHome && env.XDG_DATA_HOME ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  const sysRoots = systemDirs || ['/usr/share/applications', '/usr/local/share/applications'];
  return {
    userFile: join(dataHome, 'applications', 'antigravity.desktop'),
    sysCandidates: sysRoots.map(dir => join(dir, 'antigravity.desktop')),
  };
}

export async function inspectDesktopLaunch({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === 'win32') {
    const entrypoints = [];
    let allReady = true;
    for (const lnk of await iterLnkFiles(windowsShortcutRoots({ home, env }))) {
      try {
        const buf = await readFile(lnk);
        const info = parseLnkBuffer(buf);
        if (!isAntigravityDesktopShortcut(lnk, info)) continue;
        entrypoints.push(lnk);
        const { hasPort, hasAddress } = hasDebugFlags(info.args || '');
        if (!hasPort || !hasAddress) allReady = false;
      } catch {}
    }
    return { configured: entrypoints.length > 0 && allReady, supported: true, entrypoints };
  }
  if (platform === 'linux') {
    const { userFile } = linuxDesktopPaths({ home, env });
    if (await isLink(userFile)) return { configured: false, supported: true, entrypoints: [] };
    try {
      const content = await readFile(userFile, 'utf8');
      const execLines = content.split(/\r?\n/).filter(line => /^\s*Exec\s*=/.test(line));
      const configured = execLines.length > 0 && execLines.every(line => line.includes('--remote-debugging-port'));
      return { configured, supported: true, entrypoints: [userFile] };
    } catch {
      return { configured: false, supported: true, entrypoints: [] };
    }
  }
  return { configured: false, supported: false, entrypoints: [] };
}

function defaultExecPowerShell(updates) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$ws = New-Object -ComObject WScript.Shell',
    'foreach ($u in @($payload)) {',
    '  $item = Get-Item -LiteralPath $u.path',
    "  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked shortcut' }",
    '  $s = $ws.CreateShortcut($u.path)',
    '  $s.Arguments = [string]$u.args',
    '  $s.Save()',
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10000 }, error => (error ? rejectPromise(error) : resolvePromise()));
    child.stdin.end(JSON.stringify(updates), 'utf8');
  });
}

async function atomicJsonWrite(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, filePath);
}

async function recordManagedShortcuts(settingsPath, updates) {
  if (!settingsPath || !updates.length) return;
  let settings = {};
  try { settings = JSON.parse((await readFile(settingsPath, 'utf8')).replace(/^\uFEFF/, '')); } catch {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  const managed = settings.managedLaunch && typeof settings.managedLaunch === 'object' ? { ...settings.managedLaunch } : {};
  const tracked = managed.windowsShortcuts && typeof managed.windowsShortcuts === 'object' ? { ...managed.windowsShortcuts } : {};
  for (const item of updates) {
    const existing = Array.isArray(tracked[item.path]) ? tracked[item.path].filter(f => DEBUG_ARGS.includes(f)) : [];
    for (const flag of item.added) if (!existing.includes(flag)) existing.push(flag);
    tracked[item.path] = existing;
  }
  managed.windowsShortcuts = tracked;
  settings.managedLaunch = managed;
  await atomicJsonWrite(settingsPath, settings);
}

export async function ensureDesktopLaunchConfig({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  settingsPath,
  execPowerShell = defaultExecPowerShell,
  systemDirs,
} = {}) {
  const status = await inspectDesktopLaunch({ platform, home, env });
  if (status.configured) return { ...status, repaired: false };

  if (platform === 'win32') {
    const updates = [];
    const entrypoints = [];
    for (const lnk of await iterLnkFiles(windowsShortcutRoots({ home, env }))) {
      try {
        const info = parseLnkBuffer(await readFile(lnk));
        if (!isAntigravityDesktopShortcut(lnk, info)) continue;
        entrypoints.push(lnk);
        const merged = mergeDebugArguments(info.args || '');
        if (merged.added.length) updates.push({ path: lnk, args: merged.args, added: merged.added });
      } catch {}
    }
    if (!updates.length) return { configured: entrypoints.length > 0, repaired: false, supported: true, entrypoints };
    try {
      await execPowerShell(updates.map(({ path, args }) => ({ path, args })));
      await recordManagedShortcuts(settingsPath, updates).catch(() => {});
      return { configured: true, repaired: true, supported: true, entrypoints };
    } catch {
      return { configured: false, repaired: false, supported: true, entrypoints };
    }
  }

  if (platform === 'linux') {
    const { userFile, sysCandidates } = linuxDesktopPaths({ home, env, systemDirs });
    if (await isLink(userFile) || await isLink(dirname(userFile))) {
      return { configured: false, repaired: false, supported: true, entrypoints: [] };
    }
    let source = null;
    try {
      const existing = await readFile(userFile, 'utf8');
      if (!existing.includes(DESKTOP_MANAGED_MARKER)) {
        const execLines = existing.split(/\r?\n/).filter(line => /^\s*Exec\s*=/.test(line));
        const configured = execLines.length > 0 && execLines.every(line => line.includes('--remote-debugging-port'));
        return { configured, repaired: false, supported: true, entrypoints: [userFile] };
      }
      source = existing;
    } catch {
      for (const candidate of sysCandidates) {
        if (await isLink(candidate)) continue;
        try { source = await readFile(candidate, 'utf8'); break; } catch {}
      }
    }
    if (source === null) return { configured: false, repaired: false, supported: true, entrypoints: [] };
    const updated = mergeDesktopEntry(source);
    try {
      await mkdir(dirname(userFile), { recursive: true });
      const tmp = `${userFile}.${process.pid}.tmp`;
      await writeFile(tmp, updated, { encoding: 'utf8', mode: 0o644 });
      await rename(tmp, userFile);
      if (settingsPath) {
        let settings = {};
        try { settings = JSON.parse((await readFile(settingsPath, 'utf8')).replace(/^\uFEFF/, '')); } catch {}
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
        const managed = settings.managedLaunch && typeof settings.managedLaunch === 'object' ? { ...settings.managedLaunch } : {};
        managed.linuxDesktopFile = userFile;
        settings.managedLaunch = managed;
        await atomicJsonWrite(settingsPath, settings).catch(() => {});
      }
      return { configured: true, repaired: true, supported: true, entrypoints: [userFile] };
    } catch {
      return { configured: false, repaired: false, supported: true, entrypoints: [] };
    }
  }

  return { configured: false, repaired: false, supported: false, entrypoints: [] };
}
