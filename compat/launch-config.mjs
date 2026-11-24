// User-owned desktop launch configuration and host archive inspection.
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';

export const DEBUG_PORT_FLAG = '--remote-debugging-port=0';
export const DEBUG_ADDRESS_FLAG = '--remote-debugging-address=127.0.0.1';
export const DEBUG_ARGS = [DEBUG_PORT_FLAG, DEBUG_ADDRESS_FLAG];
export const DESKTOP_MANAGED_MARKER = 'X-Antigravity-Pulse-Managed=true';
export const MACOS_LAUNCHER_NAME = 'Antigravity (Dashboard).app';
export const MACOS_LAUNCHER_BUNDLE_ID = 'io.github.attack030130.antigrative-dashboard.launcher';
export const MACOS_MANAGED_PLIST_KEY = 'XAntigravityPulseManaged';

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

const PROXY_LAUNCHER_TARGETS = new Set(['antigravityproxy.exe', 'antigravitylauncher.exe']);
const PROXY_DESKTOP_SHORTCUT_NAMES = new Set([
  'antigravity.lnk',
  'antigravity (proxy).lnk',
  'antigravity (代理).lnk',
  'antigravity (прокси).lnk',
]);

export function isAntigravityDesktopShortcut(shortcutPath, info) {
  if (!info || !info.target) return false;
  const tokens = tokenizeArgs(info.args || '').map(t => stripQuotes(t).toLowerCase());
  if (tokens.some(t => t === '--ide' || t.startsWith('--ide='))) return false;
  const targetName = win32.basename(info.target).toLowerCase();
  if (targetName === 'antigravity.exe') return true;
  if (PROXY_LAUNCHER_TARGETS.has(targetName)) {
    const lnkName = win32.basename(shortcutPath).toLowerCase();
    const rawIcon = info.icon ? String(info.icon).replace(/,-?\d+\s*$/, '') : '';
    const iconName = rawIcon ? win32.basename(rawIcon).toLowerCase() : '';
    if (iconName === 'antigravity.exe') return true;
    if (iconName === 'antigravity ide.exe') return false;
    return PROXY_DESKTOP_SHORTCUT_NAMES.has(lnkName);
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

const knownFoldersCache = new Map();
const KNOWN_FOLDERS_OK_TTL_MS = 5 * 60 * 1000;
const KNOWN_FOLDERS_ERR_TTL_MS = 60 * 1000;

function expandWindowsEnv(value, env = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const upper = new Map();
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === 'string') upper.set(k.toUpperCase(), v);
  }
  const expanded = value.trim().replace(/%([^%]+)%/g, (match, name) => upper.get(name.toUpperCase()) ?? match);
  if (!expanded || /%[^%]+%/.test(expanded)) return null;
  if (process.platform !== 'win32' && expanded.startsWith('/')) return expanded.replace(/\\/g, '/');
  return expanded;
}

function defaultResolveWindowsKnownFolders(home) {
  const cacheKey = resolve(home).toLowerCase();
  const cached = knownFoldersCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const script = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); @{desktop=[Environment]::GetFolderPath('Desktop');programs=[Environment]::GetFolderPath('Programs')} | ConvertTo-Json -Compress";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const promise = new Promise(resolvePromise => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 6000, maxBuffer: 65536 }, (error, stdout) => {
        if (error) {
          knownFoldersCache.set(cacheKey, { expiresAt: Date.now() + KNOWN_FOLDERS_ERR_TTL_MS, promise: Promise.resolve({}) });
          resolvePromise({});
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || '').replace(/^\uFEFF/, '').trim() || '{}');
          const result = {
            desktop: typeof parsed.desktop === 'string' && parsed.desktop.trim() ? parsed.desktop.trim() : null,
            programs: typeof parsed.programs === 'string' && parsed.programs.trim() ? parsed.programs.trim() : null,
          };
          knownFoldersCache.set(cacheKey, { expiresAt: Date.now() + KNOWN_FOLDERS_OK_TTL_MS, promise: Promise.resolve(result) });
          resolvePromise(result);
        } catch {
          knownFoldersCache.set(cacheKey, { expiresAt: Date.now() + KNOWN_FOLDERS_ERR_TTL_MS, promise: Promise.resolve({}) });
          resolvePromise({});
        }
      });
  });
  knownFoldersCache.set(cacheKey, { expiresAt: Date.now() + KNOWN_FOLDERS_OK_TTL_MS, promise });
  return promise;
}

async function windowsShortcutRoots({ home = homedir(), env = process.env, platform = process.platform, resolveKnownFolders } = {}) {
  const isRealHome = resolve(home) === resolve(homedir());
  const explicitEnv = env !== process.env;
  const appdata = isRealHome && env.APPDATA ? env.APPDATA : join(home, 'AppData', 'Roaming');
  let known = {};
  if (typeof resolveKnownFolders === 'function') {
    try { known = (await resolveKnownFolders({ home, env })) || {}; } catch { known = {}; }
  } else if (isRealHome && platform === 'win32' && process.platform === 'win32') {
    known = await defaultResolveWindowsKnownFolders(home);
  }

  const candidates = [];
  const pushResolved = raw => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const expanded = expandWindowsEnv(raw, env);
    if (expanded) candidates.push(expanded);
  };
  pushResolved(known?.desktop);
  if (isRealHome || explicitEnv) {
    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      if (typeof env?.[key] === 'string' && env[key].trim()) {
        candidates.push(join(env[key].trim(), 'Desktop'));
      }
    }
  }
  candidates.push(join(home, 'Desktop'));

  pushResolved(known?.programs);
  candidates.push(join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  candidates.push(join(appdata, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'));

  const roots = [];
  const seen = new Set();
  for (const dir of candidates) {
    let norm = String(dir).trim().replace(/[\\/]+$/, '');
    if (!norm) continue;
    if (/^[a-zA-Z]:$/.test(norm)) norm += '\\';
    const key = norm.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(dir);
    }
  }
  return roots;
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

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function macosAppBundle(pathLike) {
  if (!pathLike || typeof pathLike !== 'string') return null;
  let current = resolve(pathLike);
  while (true) {
    if (basename(current).toLowerCase().endsWith('.app')) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function macosLauncherBundle(home = homedir()) {
  return join(home, 'Applications', MACOS_LAUNCHER_NAME);
}

async function isRegularFile(filePath) {
  if (await isLink(filePath)) return false;
  try { return (await stat(filePath)).isFile(); } catch { return false; }
}

async function isRegularDir(dirPath) {
  if (await isLink(dirPath)) return false;
  try { return (await stat(dirPath)).isDirectory(); } catch { return false; }
}

async function macosTargetApp({ appResources, home = homedir(), env = process.env, systemAppDirs } = {}) {
  const candidates = [];
  const addFrom = value => {
    const bundle = macosAppBundle(value);
    if (bundle && !candidates.includes(bundle)) candidates.push(bundle);
  };
  if (appResources) addFrom(appResources);
  if (env.AG_PULSE_APP_ASAR) addFrom(env.AG_PULSE_APP_ASAR);
  const roots = systemAppDirs || ['/Applications', join(home, 'Applications')];
  for (const root of roots) addFrom(join(root, 'Antigravity.app'));
  for (const candidate of candidates) {
    if (!await isRegularDir(candidate)) continue;
    const exe = join(candidate, 'Contents', 'MacOS', 'Antigravity');
    const asar = join(candidate, 'Contents', 'Resources', 'app.asar');
    if (await isRegularFile(exe) || await isRegularFile(asar)) return candidate;
  }
  return null;
}

async function macosIconSource(targetApp) {
  const resources = join(targetApp, 'Contents', 'Resources');
  if (!await isRegularDir(resources)) return null;
  for (const preferred of ['electron.icns', 'Antigravity.icns', 'app.icns', 'icon.icns']) {
    const candidate = join(resources, preferred);
    if (await isRegularFile(candidate)) return candidate;
  }
  try {
    const entries = (await readdir(resources)).sort();
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.icns')) continue;
      const candidate = join(resources, entry);
      if (await isRegularFile(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export function renderMacosLauncherPlist(iconName = null) {
  const iconBlock = iconName ? `  <key>CFBundleIconFile</key>\n  <string>${xmlEscape(iconName)}</string>\n` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0">\n'
    + '<dict>\n'
    + '  <key>CFBundleDevelopmentRegion</key>\n'
    + '  <string>en</string>\n'
    + '  <key>CFBundleDisplayName</key>\n'
    + '  <string>Antigravity (Dashboard)</string>\n'
    + '  <key>CFBundleExecutable</key>\n'
    + '  <string>launcher</string>\n'
    + '  <key>CFBundleIdentifier</key>\n'
    + `  <string>${MACOS_LAUNCHER_BUNDLE_ID}</string>\n`
    + iconBlock
    + '  <key>CFBundleInfoDictionaryVersion</key>\n'
    + '  <string>6.0</string>\n'
    + '  <key>CFBundleName</key>\n'
    + '  <string>Antigravity (Dashboard)</string>\n'
    + '  <key>CFBundlePackageType</key>\n'
    + '  <string>APPL</string>\n'
    + '  <key>CFBundleShortVersionString</key>\n'
    + '  <string>1.0</string>\n'
    + '  <key>LSUIElement</key>\n'
    + '  <true/>\n'
    + `  <key>${MACOS_MANAGED_PLIST_KEY}</key>\n`
    + '  <true/>\n'
    + '</dict>\n'
    + '</plist>\n'
  );
}

export function renderMacosLauncherScript(targetApp, profileDir = null) {
  const posixApp = String(targetApp).replace(/\\/g, '/');
  const profileLine = profileDir
    ? `PROFILE_DIR=${shQuote(String(profileDir).replace(/\\/g, '/'))}`
    : 'PROFILE_DIR="${AG_PULSE_PROFILE:-$HOME/Library/Application Support/Antigravity}"';
  return [
    '#!/bin/sh',
    `# ${DESKTOP_MANAGED_MARKER}`,
    'set -eu',
    'unset ELECTRON_RUN_AS_NODE',
    `APP_BUNDLE=${shQuote(posixApp)}`,
    profileLine,
    'if [ ! -d "$APP_BUNDLE" ]; then',
    '  for candidate in "/Applications/Antigravity.app" "$HOME/Applications/Antigravity.app"; do',
    '    if [ -d "$candidate" ]; then',
    '      APP_BUNDLE="$candidate"',
    '      break',
    '    fi',
    '  done',
    'fi',
    'if [ ! -d "$APP_BUNDLE" ]; then',
    '  /usr/bin/osascript -e \'display dialog "Antigravity.app was not found." buttons {"OK"} default button 1 with title "Antigravity (Dashboard)"\' >/dev/null 2>&1 || true',
    '  exit 1',
    'fi',
    'EXE_PATH="$APP_BUNDLE/Contents/MacOS/Antigravity"',
    'is_running() {',
    '  /bin/ps -ww -axo pid=,uid=,args= 2>/dev/null | /usr/bin/awk -v uid="$(/usr/bin/id -u)" -v exe="$EXE_PATH" \'',
    '    $2 == uid && index($0, exe) > 0 && index($0, "Helper") == 0 && $0 !~ /(^|[[:space:]])--type=/ { found = 1; exit 0 }',
    '    END { exit(found ? 0 : 1) }',
    '  \'',
    '}',
    'has_debug_port() {',
    '  [ -f "$PROFILE_DIR/DevToolsActivePort" ] && [ ! -L "$PROFILE_DIR/DevToolsActivePort" ] || return 1',
    '  port="$(/usr/bin/head -n 1 "$PROFILE_DIR/DevToolsActivePort" 2>/dev/null | /usr/bin/tr -d \'\\r\\n\')"',
    '  case "$port" in',
    '    \'\'|*[!0-9]*) return 1 ;;',
    '    *) [ "$port" -ge 1 ] && [ "$port" -le 65535 ] ;;',
    '  esac',
    '}',
    'if is_running; then',
    '  if has_debug_port; then',
    '    exec /usr/bin/open -a "$APP_BUNDLE" "$@"',
    '  fi',
    '  if ! /usr/bin/osascript <<\'APPLESCRIPT\' >/dev/null 2>&1',
    'display dialog "Antigravity is already running without remote debugging enabled.\\n\\nQuit and relaunch Antigravity to enable the Antigrative Dashboard inline bar?" buttons {"Cancel", "Quit & Relaunch"} default button "Quit & Relaunch" with title "Antigravity (Dashboard)"',
    'APPLESCRIPT',
    '  then',
    '    exit 0',
    '  fi',
    '  /usr/bin/osascript - "$APP_BUNDLE" <<\'APPLESCRIPT\' >/dev/null 2>&1 || true',
    'on run argv',
    '  tell application (item 1 of argv) to quit',
    'end run',
    'APPLESCRIPT',
    '  tries=0',
    '  while is_running && [ "$tries" -lt 40 ]; do',
    '    /bin/sleep 0.25',
    '    tries=$((tries + 1))',
    '  done',
    '  if is_running; then',
    '    /usr/bin/osascript -e \'display dialog "Antigravity did not finish quitting. Press Command+Q to quit it, then open Antigravity (Dashboard) again." buttons {"OK"} default button 1 with title "Antigravity (Dashboard)"\' >/dev/null 2>&1 || true',
    '    exit 1',
    '  fi',
    'fi',
    `exec /usr/bin/open -a "$APP_BUNDLE" --args ${DEBUG_PORT_FLAG} ${DEBUG_ADDRESS_FLAG} "$@"`,
    '',
  ].join('\n');
}

async function isManagedMacosLauncher(bundle) {
  if (!await isRegularDir(bundle)) return false;
  const plist = join(bundle, 'Contents', 'Info.plist');
  const launcher = join(bundle, 'Contents', 'MacOS', 'launcher');
  if (await isLink(plist) || await isLink(launcher)) return false;
  try {
    const script = await readFile(launcher, 'utf8');
    if (script.includes(DESKTOP_MANAGED_MARKER)) return true;
  } catch {}
  try {
    const plistText = await readFile(plist, 'utf8');
    if (plistText.includes(MACOS_MANAGED_PLIST_KEY)) return true;
  } catch {}
  return false;
}

export async function inspectDesktopLaunch({ platform = process.platform, home = homedir(), env = process.env, resolveKnownFolders } = {}) {
  if (platform === 'win32') {
    const entrypoints = [];
    let allReady = true;
    for (const lnk of await iterLnkFiles(await windowsShortcutRoots({ home, env, platform, resolveKnownFolders }))) {
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
  if (platform === 'darwin') {
    const bundle = macosLauncherBundle(home);
    const launcher = join(bundle, 'Contents', 'MacOS', 'launcher');
    const plist = join(bundle, 'Contents', 'Info.plist');
    if (await isLink(dirname(bundle)) || await isLink(bundle) || await isLink(launcher) || await isLink(plist)) {
      return { configured: false, supported: true, entrypoints: [] };
    }
    if (!await isRegularFile(launcher) || !await isRegularFile(plist)) {
      return { configured: false, supported: true, entrypoints: [] };
    }
    try {
      const script = await readFile(launcher, 'utf8');
      const configured = script.includes('--remote-debugging-port') && script.includes('--remote-debugging-address');
      return { configured, supported: true, entrypoints: [bundle] };
    } catch {
      return { configured: false, supported: true, entrypoints: [] };
    }
  }
  return { configured: false, supported: false, entrypoints: [] };
}

export function toAsciiJson(value) {
  return JSON.stringify(value).replace(/[^\x00-\x7f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function defaultExecPowerShell(updates) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$ws = New-Object -ComObject WScript.Shell',
    'foreach ($u in @($payload)) {',
    '  $item = Get-Item -LiteralPath $u.path',
    "  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked shortcut' }",
    '  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ag-lnk-" + [guid]::NewGuid().ToString("N") + ".lnk")',
    '  try {',
    '    Copy-Item -LiteralPath $u.path -Destination $tmp -Force',
    '    $s = $ws.CreateShortcut($tmp)',
    '    $s.Arguments = [string]$u.args',
    '    $s.Save()',
    '    Copy-Item -LiteralPath $tmp -Destination $u.path -Force',
    '  } finally {',
    '    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue',
    '  }',
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15000 }, error => (error ? rejectPromise(error) : resolvePromise()));
    child.stdin.end(toAsciiJson(updates), 'ascii');
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
  resolveKnownFolders,
  systemDirs,
  appResources,
  profile,
  systemAppDirs,
} = {}) {
  const status = await inspectDesktopLaunch({ platform, home, env, resolveKnownFolders });
  if (status.configured) return { ...status, repaired: false };

  if (platform === 'win32') {
    const updates = [];
    const entrypoints = [];
    for (const lnk of await iterLnkFiles(await windowsShortcutRoots({ home, env, platform, resolveKnownFolders }))) {
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

  if (platform === 'darwin') {
    const bundle = macosLauncherBundle(home);
    if (await isLink(dirname(bundle)) || await isLink(bundle)) {
      return { configured: false, repaired: false, supported: true, entrypoints: [] };
    }
    let exists = false;
    try { await lstat(bundle); exists = true; } catch {}
    if (exists && !await isManagedMacosLauncher(bundle)) {
      const launcher = join(bundle, 'Contents', 'MacOS', 'launcher');
      let configured = false;
      if (await isRegularFile(launcher)) {
        try {
          const script = await readFile(launcher, 'utf8');
          configured = script.includes('--remote-debugging-port') && script.includes('--remote-debugging-address');
        } catch {}
      }
      return { configured, repaired: false, supported: true, entrypoints: [bundle] };
    }
    const targetApp = await macosTargetApp({ appResources, home, env, systemAppDirs });
    if (!targetApp) return { configured: false, repaired: false, supported: true, entrypoints: [] };
    const contents = join(bundle, 'Contents');
    const macosDir = join(contents, 'MacOS');
    const resourcesDir = join(contents, 'Resources');
    if (await isLink(contents) || await isLink(macosDir) || await isLink(resourcesDir)) {
      return { configured: false, repaired: false, supported: true, entrypoints: [] };
    }
    try {
      await mkdir(macosDir, { recursive: true });
      let iconName = null;
      const iconSrc = await macosIconSource(targetApp);
      if (iconSrc) {
        await mkdir(resourcesDir, { recursive: true });
        const iconDst = join(resourcesDir, 'app.icns');
        if (!await isLink(iconDst)) {
          await copyFile(iconSrc, iconDst);
          iconName = 'app.icns';
        }
      }
      const plistPath = join(contents, 'Info.plist');
      const plistTmp = `${plistPath}.${process.pid}.tmp`;
      await writeFile(plistTmp, renderMacosLauncherPlist(iconName), { encoding: 'utf8', mode: 0o644 });
      await rename(plistTmp, plistPath);

      const launcherPath = join(macosDir, 'launcher');
      const launcherTmp = `${launcherPath}.${process.pid}.tmp`;
      await writeFile(launcherTmp, renderMacosLauncherScript(targetApp, profile), { encoding: 'utf8', mode: 0o755 });
      await chmod(launcherTmp, 0o755).catch(() => {});
      await rename(launcherTmp, launcherPath);

      if (settingsPath) {
        let settings = {};
        try { settings = JSON.parse((await readFile(settingsPath, 'utf8')).replace(/^\uFEFF/, '')); } catch {}
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
        const managed = settings.managedLaunch && typeof settings.managedLaunch === 'object' ? { ...settings.managedLaunch } : {};
        managed.macosLauncherApp = bundle;
        settings.managedLaunch = managed;
        await atomicJsonWrite(settingsPath, settings).catch(() => {});
      }
      return { configured: true, repaired: true, supported: true, entrypoints: [bundle] };
    } catch {
      return { configured: false, repaired: false, supported: true, entrypoints: [] };
    }
  }

  return { configured: false, repaired: false, supported: false, entrypoints: [] };
}
