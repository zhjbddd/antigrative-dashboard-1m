"""User-owned desktop launch configuration and host archive inspection."""
import base64
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shlex
import shutil
import stat
import struct
import subprocess
import sys
import time
from xml.sax.saxutils import escape as xml_escape

DEBUG_PORT_FLAG = '--remote-debugging-port=0'
DEBUG_ADDRESS_FLAG = '--remote-debugging-address=127.0.0.1'
DEBUG_ARGS = (DEBUG_PORT_FLAG, DEBUG_ADDRESS_FLAG)
DESKTOP_MANAGED_MARKER = 'X-Antigravity-Pulse-Managed=true'
MACOS_LAUNCHER_NAME = 'Antigravity (Dashboard).app'
MACOS_LAUNCHER_BUNDLE_ID = 'io.github.attack030130.antigrative-dashboard.launcher'
MACOS_MANAGED_PLIST_KEY = 'XAntigravityPulseManaged'


def is_link(path):
    """Return True if path is a symlink or Windows reparse point."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    reparse = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)
    return bool(os.name == 'nt' and reparse and (getattr(st, 'st_file_attributes', 0) & reparse))


def inspect_host_archive(app_asar):
    """Read host version and whether app.asar makes --remote-debugging-port opt-in."""
    path = Path(app_asar)
    if path.is_dir():
        path = path / 'app.asar'
    if is_link(path) or not path.is_file():
        return {'version': None, 'requiresDebugFlag': False}
    try:
        with path.open('rb') as handle:
            head = handle.read(16)
            if len(head) < 16:
                return {'version': None, 'requiresDebugFlag': False}
            pickle_size, header_size, _, json_size = struct.unpack('<4I', head)
            if pickle_size != 4 or not (0 < json_size <= 16 * 1024 * 1024):
                return {'version': None, 'requiresDebugFlag': False}
            raw_header = handle.read(json_size)
            if len(raw_header) != json_size:
                return {'version': None, 'requiresDebugFlag': False}
            header = json.loads(raw_header.decode('utf-8'))
            base = 8 + header_size

            def read_entry(entry, limit):
                if not isinstance(entry, dict) or entry.get('unpacked'):
                    return None
                size = entry.get('size')
                offset = entry.get('offset')
                if not isinstance(size, int) or size < 0 or size > limit:
                    return None
                handle.seek(base + int(offset))
                data = handle.read(size)
                return data if len(data) == size else None

            files = header.get('files', {})
            pkg_raw = read_entry(files.get('package.json'), 65536)
            version = None
            if pkg_raw is not None:
                pkg = json.loads(pkg_raw.decode('utf-8'))
                if isinstance(pkg.get('version'), str) and pkg['version'].strip():
                    version = pkg['version'].strip()

            dist_files = (files.get('dist') or {}).get('files') or {}
            main_raw = read_entry(dist_files.get('main.js'), 1048576)
            requires_debug = False
            if main_raw is not None:
                main_js = main_raw.decode('utf-8', errors='replace')
                has_opt_in = (
                    "hasSwitch('remote-debugging-port')" in main_js
                    or 'hasSwitch("remote-debugging-port")' in main_js
                    or 'removeStaleActivePortFile' in main_js
                )
                sets_default = (
                    "appendSwitch('remote-debugging-port'" in main_js
                    or 'appendSwitch("remote-debugging-port"' in main_js
                )
                requires_debug = has_opt_in and not sets_default
            return {'version': version, 'requiresDebugFlag': bool(requires_debug)}
    except (OSError, ValueError, struct.error, KeyError, TypeError):
        return {'version': None, 'requiresDebugFlag': False}


def desktop_executable(app_asar, platform=None, env=None):
    """Resolve the installed Antigravity desktop executable beside resources/app.asar."""
    platform = platform or sys.platform
    env = os.environ if env is None else env
    path = Path(app_asar)
    resources = path if path.is_dir() else path.parent
    if platform == 'win32':
        candidates = [resources.parent / 'Antigravity.exe']
    elif platform == 'darwin':
        candidates = [resources.parent / 'MacOS' / 'Antigravity']
    elif platform.startswith('linux'):
        candidates = [resources.parent / 'antigravity', resources.parent / 'Antigravity']
        which = shutil.which('antigravity', path=env.get('PATH', ''))
        if which:
            candidates.append(Path(which))
    else:
        candidates = []
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def parse_lnk(path):
    """Parse target, arguments, working dir and icon from an MS-SHLLINK (.lnk) file."""
    path = Path(path)
    if is_link(path) or not path.is_file():
        return None
    try:
        if path.stat().st_size > 1048576:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if len(data) < 76 or struct.unpack_from('<I', data, 0)[0] != 0x4C:
        return None
    flags = struct.unpack_from('<I', data, 0x14)[0]
    unicode_str = bool(flags & 0x80)
    pos = 76
    if flags & 0x01:
        if pos + 2 > len(data):
            return None
        id_len = struct.unpack_from('<H', data, pos)[0]
        pos += 2 + id_len
    if pos > len(data):
        return None
    target = None
    ansi_encoding = 'mbcs' if os.name == 'nt' else 'latin1'
    if flags & 0x02:
        if pos + 12 > len(data):
            return None
        info_len, info_hdr_len, info_flags = struct.unpack_from('<III', data, pos)
        if info_len < 12 or pos + info_len > len(data):
            return None
        if info_flags & 0x01 and info_len >= 20:
            lb_off = struct.unpack_from('<I', data, pos + 16)[0]
            if 0 < lb_off < info_len:
                end = data.find(b'\x00', pos + lb_off, pos + info_len)
                if end == -1:
                    end = pos + info_len
                target = data[pos + lb_off:end].decode(ansi_encoding, errors='replace')
            if info_hdr_len >= 0x24 and info_len >= 32:
                ub_off = struct.unpack_from('<I', data, pos + 28)[0]
                if 0 < ub_off < info_len:
                    raw = data[pos + ub_off:pos + info_len]
                    uend = next((i for i in range(0, len(raw) - 1, 2) if raw[i] == 0 and raw[i + 1] == 0), len(raw))
                    target = raw[:uend].decode('utf-16le', errors='replace')
        pos += info_len
    strings = {}
    for flag, key in ((0x04, 'name'), (0x08, 'rel'), (0x10, 'workdir'), (0x20, 'args'), (0x40, 'icon')):
        if flags & flag:
            if pos + 2 > len(data):
                return None
            count = struct.unpack_from('<H', data, pos)[0]
            pos += 2
            byte_len = count * (2 if unicode_str else 1)
            if pos + byte_len > len(data):
                return None
            encoding = 'utf-16le' if unicode_str else ansi_encoding
            strings[key] = data[pos:pos + byte_len].decode(encoding, errors='replace')
            pos += byte_len
    return {'target': target, **strings}


def _tokenize_args(args_text):
    return re.findall(r'"[^"]*"|\S+', args_text or '')


def has_debug_flags(args_text):
    """Return (has_port, has_address) for parsed CLI arguments."""
    clean = [token.strip('"\'') for token in _tokenize_args(args_text)]
    has_port = any(item == '--remote-debugging-port' or item.startswith('--remote-debugging-port=') for item in clean)
    has_address = any(item == '--remote-debugging-address' or item.startswith('--remote-debugging-address=') for item in clean)
    return has_port, has_address


_PROXY_LAUNCHER_TARGETS = frozenset({'antigravityproxy.exe', 'antigravitylauncher.exe'})
_PROXY_DESKTOP_SHORTCUT_NAMES = frozenset({
    'antigravity.lnk',
    'antigravity (proxy).lnk',
    'antigravity (代理).lnk',
    'antigravity (прокси).lnk',
})


def is_antigravity_desktop_shortcut(shortcut_path, info):
    """Match Antigravity Desktop shortcuts while excluding Antigravity IDE shortcuts."""
    if not info or not info.get('target'):
        return False
    tokens = [token.strip('"\'').lower() for token in _tokenize_args(info.get('args', ''))]
    if any(token == '--ide' or token.startswith('--ide=') for token in tokens):
        return False
    target_name = PureWindowsPath(info['target']).name.lower()
    if target_name == 'antigravity.exe':
        return True
    if target_name in _PROXY_LAUNCHER_TARGETS:
        shortcut_name = PureWindowsPath(str(shortcut_path)).name.lower()
        raw_icon = re.sub(r',-?\d+\s*$', '', str(info.get('icon') or ''))
        icon_name = PureWindowsPath(raw_icon).name.lower() if raw_icon else ''
        if icon_name == 'antigravity.exe':
            return True
        if icon_name == 'antigravity ide.exe':
            return False
        return shortcut_name in _PROXY_DESKTOP_SHORTCUT_NAMES
    return False


def merge_debug_arguments(args_text):
    """Add missing loopback CDP flags without clobbering existing args or '--'."""
    tokens = _tokenize_args(args_text)
    clean = [token.strip('"\'') for token in tokens]
    has_port, has_address = has_debug_flags(args_text)
    added = []
    if not has_port:
        added.append(DEBUG_PORT_FLAG)
    if not has_address:
        added.append(DEBUG_ADDRESS_FLAG)
    if not added:
        return args_text or '', []
    if '--' in clean:
        idx = clean.index('--')
        updated = tokens[:idx] + added + tokens[idx:]
    else:
        updated = tokens + added
    return ' '.join(updated), added


def strip_debug_arguments(args_text, remove_flags=DEBUG_ARGS):
    """Remove only the specified flags from a shortcut argument string."""
    targets = set(remove_flags)
    kept = [token for token in _tokenize_args(args_text) if token.strip('"\'') not in targets]
    return ' '.join(kept)


_WINDOWS_KNOWN_FOLDER_IDS = {
    'Desktop': '{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}',
    'Programs': '{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}',
}


def _expand_windows_env(value, env):
    """Expand %VAR% references case-insensitively against env."""
    if not isinstance(value, str) or not value.strip():
        return None
    mapping = {str(k).upper(): str(v) for k, v in (env or {}).items() if v is not None}

    def replace(match):
        name = match.group(1).upper()
        return mapping.get(name, match.group(0))

    expanded = re.sub(r'%([^%]+)%', replace, value.strip())
    if not expanded or re.search(r'%[^%]+%', expanded):
        return None
    if os.name != 'nt' and expanded.startswith('/'):
        expanded = expanded.replace('\\', '/')
    return expanded


def _resolve_windows_known_folder(folder_name, env=None):
    """Query Windows Known Folder API (zero subprocess) with registry fallback."""
    if os.name != 'nt':
        return None
    folder_id = _WINDOWS_KNOWN_FOLDER_IDS.get(folder_name)
    if folder_id:
        try:
            import ctypes
            import uuid

            shell32 = ctypes.windll.shell32
            ole32 = ctypes.windll.ole32
            guid_buf = (ctypes.c_ubyte * 16).from_buffer_copy(uuid.UUID(folder_id).bytes_le)
            path_ptr = ctypes.c_void_p()
            shell32.SHGetKnownFolderPath.argtypes = [
                ctypes.c_void_p,
                ctypes.c_uint32,
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_void_p),
            ]
            shell32.SHGetKnownFolderPath.restype = ctypes.c_long
            ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
            ole32.CoTaskMemFree.restype = None
            hr = shell32.SHGetKnownFolderPath(ctypes.byref(guid_buf), 0, None, ctypes.byref(path_ptr))
            try:
                if hr == 0 and path_ptr.value:
                    value = ctypes.wstring_at(path_ptr.value).strip()
                    if value:
                        return Path(value)
            finally:
                if path_ptr.value:
                    ole32.CoTaskMemFree(path_ptr)
        except Exception:
            pass
    try:
        import winreg

        for subkey in (
            r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders',
            r'Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders',
        ):
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, subkey) as key:
                    raw, _ = winreg.QueryValueEx(key, folder_name)
                expanded = _expand_windows_env(raw, env if env is not None else os.environ)
                if expanded:
                    return Path(expanded)
            except OSError:
                continue
    except Exception:
        pass
    return None


def _windows_shortcut_roots(home, env, known_folder_resolver=None):
    home = Path(home) if home is not None else Path.home()
    explicit_env = env is not None and env is not os.environ
    env = os.environ if env is None else env
    is_real_home = home.resolve() == Path.home().resolve()
    appdata = Path(env['APPDATA']) if (is_real_home and env.get('APPDATA')) else (home / 'AppData' / 'Roaming')
    resolver = known_folder_resolver if known_folder_resolver is not None else (
        (lambda name: _resolve_windows_known_folder(name, env)) if (is_real_home and os.name == 'nt') else None
    )

    def resolve_folder(name):
        if resolver is None:
            return None
        try:
            value = resolver(name)
        except Exception:
            return None
        if isinstance(value, Path):
            return value if str(value).strip() else None
        if isinstance(value, str) and value.strip():
            expanded = _expand_windows_env(value, env)
            return Path(expanded) if expanded else None
        return None

    candidates = []
    desktop_known = resolve_folder('Desktop')
    if desktop_known is not None:
        candidates.append(desktop_known)
    if is_real_home or explicit_env:
        for key in ('OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'):
            od = env.get(key)
            if isinstance(od, str) and od.strip():
                candidates.append(Path(od.strip()) / 'Desktop')
    candidates.append(home / 'Desktop')

    programs_known = resolve_folder('Programs')
    if programs_known is not None:
        candidates.append(programs_known)
    candidates.append(appdata / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs')
    candidates.append(appdata / 'Microsoft' / 'Internet Explorer' / 'Quick Launch' / 'User Pinned' / 'TaskBar')

    roots = []
    seen = set()
    for path in candidates:
        raw = str(path).strip()
        if not raw:
            continue
        norm = raw.rstrip('\\/')
        if len(norm) == 2 and norm[1] == ':':
            norm += '\\'
        key = norm.casefold()
        if key not in seen:
            seen.add(key)
            roots.append(path)
    return roots


def _iter_lnk_files(roots):
    seen = set()
    for root in roots:
        if not root.is_dir() or is_link(root):
            continue
        for current, dirs, files in os.walk(root):
            current_path = Path(current)
            dirs[:] = [d for d in sorted(dirs) if not is_link(current_path / d)]
            for filename in sorted(files):
                if not filename.lower().endswith('.lnk'):
                    continue
                candidate = current_path / filename
                if is_link(candidate):
                    continue
                key = str(candidate).casefold()
                if key not in seen:
                    seen.add(key)
                    yield candidate


def write_windows_shortcut_args(updates, runner=subprocess.run):
    """Update .lnk Arguments in-place via WScript.Shell without creating a window."""
    if not updates:
        return
    script = (
        "$ErrorActionPreference = 'Stop'\n"
        "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)\n"
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n"
        "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json\n"
        "$ws = New-Object -ComObject WScript.Shell\n"
        "foreach ($u in @($payload)) {\n"
        "  $item = Get-Item -LiteralPath $u.path\n"
        "  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked shortcut' }\n"
        "  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ag-lnk-' + [guid]::NewGuid().ToString('N') + '.lnk')\n"
        "  try {\n"
        "    Copy-Item -LiteralPath $u.path -Destination $tmp -Force\n"
        "    $s = $ws.CreateShortcut($tmp)\n"
        "    $s.Arguments = [string]$u.args\n"
        "    $s.Save()\n"
        "    Copy-Item -LiteralPath $tmp -Destination $u.path -Force\n"
        "  } finally {\n"
        "    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue\n"
        "  }\n"
        "}\n"
    )
    encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
    kwargs = {'input': json.dumps(updates, ensure_ascii=True), 'text': True, 'encoding': 'utf-8', 'timeout': 15, 'check': True}
    if os.name == 'nt':
        kwargs['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    runner(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], **kwargs)


def merge_desktop_entry(text):
    """Inject loopback debugging flags into a Linux .desktop entry."""
    lines = text.splitlines()
    out = []
    has_marker = any(line.strip() == DESKTOP_MANAGED_MARKER for line in lines)
    in_entry = False
    marker_written = has_marker
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            if in_entry and not marker_written:
                out.append(DESKTOP_MANAGED_MARKER)
                marker_written = True
            in_entry = (stripped == '[Desktop Entry]')
            out.append(line)
            continue
        match = re.match(r'^(\s*Exec\s*=\s*)(.+)$', line)
        if match:
            prefix, rhs = match.group(1), match.group(2).rstrip()
            if '--remote-debugging-port' not in rhs:
                field = re.search(r'(\s+%[fFuUdDnNickvm])', rhs)
                flags = f'{DEBUG_PORT_FLAG} {DEBUG_ADDRESS_FLAG}'
                if field:
                    rhs = rhs[:field.start()] + ' ' + flags + rhs[field.start():]
                else:
                    rhs = f'{rhs} {flags}'
            out.append(prefix + rhs)
            continue
        out.append(line)
    if in_entry and not marker_written:
        out.append(DESKTOP_MANAGED_MARKER)
    return '\n'.join(out) + '\n'


def _linux_desktop_paths(home, local, env, system_dirs=None):
    home = Path(home) if home is not None else Path.home()
    env = os.environ if env is None else env
    is_real_home = home.resolve() == Path.home().resolve()
    data_home = (
        Path(env['XDG_DATA_HOME'])
        if (is_real_home and env.get('XDG_DATA_HOME'))
        else (Path(local) if local is not None else home / '.local' / 'share')
    )
    user_file = data_home / 'applications' / 'antigravity.desktop'
    sys_roots = system_dirs if system_dirs is not None else (
        Path('/usr/share/applications'),
        Path('/usr/local/share/applications'),
    )
    return user_file, [root / 'antigravity.desktop' for root in sys_roots]


def _atomic_write_text(path, text, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(text, encoding='utf-8', newline='\n')
    if mode is not None:
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
    os.replace(tmp, path)


def macos_app_bundle(path_like):
    """Resolve the enclosing *.app bundle directory from app.asar, resources dir, executable, or bundle."""
    if not path_like:
        return None
    path = Path(path_like)
    for candidate in (path, *path.parents):
        if candidate.name.lower().endswith('.app'):
            return candidate
    return None


def _macos_launcher_bundle(home):
    home = Path(home) if home is not None else Path.home()
    return home / 'Applications' / MACOS_LAUNCHER_NAME


def _macos_target_app(app_asar=None, home=None, env=None, system_app_dirs=None):
    home = Path(home) if home is not None else Path.home()
    env = os.environ if env is None else env
    candidates = []
    if app_asar:
        bundle = macos_app_bundle(app_asar)
        if bundle is not None:
            candidates.append(bundle)
    if env.get('AG_PULSE_APP_ASAR'):
        bundle = macos_app_bundle(Path(env['AG_PULSE_APP_ASAR']).expanduser())
        if bundle is not None:
            candidates.append(bundle)
    roots = list(system_app_dirs) if system_app_dirs is not None else [Path('/Applications'), home / 'Applications']
    for root in roots:
        candidates.append(Path(root) / 'Antigravity.app')
    seen = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if not is_link(candidate) and candidate.is_dir():
            exe = candidate / 'Contents' / 'MacOS' / 'Antigravity'
            asar = candidate / 'Contents' / 'Resources' / 'app.asar'
            if (exe.is_file() and not is_link(exe)) or (asar.is_file() and not is_link(asar)):
                return candidate
    return None


def _macos_icon_source(target_app):
    resources = Path(target_app) / 'Contents' / 'Resources'
    if is_link(resources) or not resources.is_dir():
        return None
    for preferred in ('electron.icns', 'Antigravity.icns', 'app.icns', 'icon.icns'):
        candidate = resources / preferred
        if not is_link(candidate) and candidate.is_file():
            return candidate
    try:
        for entry in sorted(resources.iterdir()):
            if entry.suffix.lower() == '.icns' and not is_link(entry) and entry.is_file():
                return entry
    except OSError:
        return None
    return None


def render_macos_launcher_plist(icon_name=None):
    """Render minimal Info.plist for the user-owned macOS loopback launcher wrapper."""
    icon_block = f'  <key>CFBundleIconFile</key>\n  <string>{xml_escape(icon_name)}</string>\n' if icon_name else ''
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0">\n'
        '<dict>\n'
        '  <key>CFBundleDevelopmentRegion</key>\n'
        '  <string>en</string>\n'
        '  <key>CFBundleDisplayName</key>\n'
        '  <string>Antigravity (Dashboard)</string>\n'
        '  <key>CFBundleExecutable</key>\n'
        '  <string>launcher</string>\n'
        '  <key>CFBundleIdentifier</key>\n'
        f'  <string>{MACOS_LAUNCHER_BUNDLE_ID}</string>\n'
        f'{icon_block}'
        '  <key>CFBundleInfoDictionaryVersion</key>\n'
        '  <string>6.0</string>\n'
        '  <key>CFBundleName</key>\n'
        '  <string>Antigravity (Dashboard)</string>\n'
        '  <key>CFBundlePackageType</key>\n'
        '  <string>APPL</string>\n'
        '  <key>CFBundleShortVersionString</key>\n'
        '  <string>1.0</string>\n'
        '  <key>LSUIElement</key>\n'
        '  <true/>\n'
        f'  <key>{MACOS_MANAGED_PLIST_KEY}</key>\n'
        '  <true/>\n'
        '</dict>\n'
        '</plist>\n'
    )


def render_macos_launcher_script(target_app, profile_dir=None):
    """Render a POSIX launcher script that starts Antigravity.app with loopback CDP flags."""
    app_str = Path(target_app).as_posix()
    profile_line = (
        f'PROFILE_DIR={shlex.quote(Path(profile_dir).as_posix())}'
        if profile_dir is not None
        else 'PROFILE_DIR="${AG_PULSE_PROFILE:-$HOME/Library/Application Support/Antigravity}"'
    )
    return '\n'.join([
        '#!/bin/sh',
        f'# {DESKTOP_MANAGED_MARKER}',
        'set -eu',
        'unset ELECTRON_RUN_AS_NODE',
        f'APP_BUNDLE={shlex.quote(app_str)}',
        profile_line,
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
        f'exec /usr/bin/open -a "$APP_BUNDLE" --args {DEBUG_PORT_FLAG} {DEBUG_ADDRESS_FLAG} "$@"',
        '',
    ])


def _is_managed_macos_launcher(bundle_path):
    bundle = Path(bundle_path)
    if is_link(bundle) or not bundle.is_dir():
        return False
    plist = bundle / 'Contents' / 'Info.plist'
    launcher = bundle / 'Contents' / 'MacOS' / 'launcher'
    if is_link(plist) or is_link(launcher):
        return False
    try:
        if launcher.is_file() and DESKTOP_MANAGED_MARKER in launcher.read_text(encoding='utf-8', errors='replace'):
            return True
        if plist.is_file() and MACOS_MANAGED_PLIST_KEY in plist.read_text(encoding='utf-8', errors='replace'):
            return True
    except OSError:
        return False
    return False


def has_active_debug_port(profile):
    """Return True when <profile>/DevToolsActivePort exists and starts with a valid port."""
    if not profile:
        return False
    port_file = Path(profile) / 'DevToolsActivePort'
    if is_link(port_file) or not port_file.is_file():
        return False
    try:
        if port_file.stat().st_size > 1024:
            return False
        first = port_file.read_text(encoding='utf-8', errors='replace').splitlines()[:1]
        if not first:
            return False
        port = int(first[0].strip())
        return 1 <= port <= 65535
    except (OSError, ValueError):
        return False


def parse_macos_desktop_pids(ps_output, executable, uid=None):
    """Extract main-process PIDs matching the Antigravity desktop binary on macOS."""
    exe_str = Path(executable).as_posix()
    pids = []
    for line in (ps_output or '').splitlines():
        match = re.match(r'^\s*(\d+)\s+(\d+)\s+(.+)$', line)
        if not match:
            continue
        pid, proc_uid, cmd = int(match.group(1)), int(match.group(2)), match.group(3)
        if uid is not None and proc_uid != uid:
            continue
        if exe_str not in cmd or 'Helper' in cmd:
            continue
        if re.search(r'(?:^|\s)--type=', cmd):
            continue
        if pid not in pids:
            pids.append(pid)
    return pids


def running_desktop_pids(executable, platform=None, runner=subprocess.run, uid=None):
    """Return running main-process PIDs for Antigravity Desktop on macOS (empty elsewhere)."""
    platform = platform or sys.platform
    if platform != 'darwin' or not executable:
        return []
    if uid is None and hasattr(os, 'getuid'):
        uid = os.getuid()
    try:
        proc = runner(['/bin/ps', '-ww', '-axo', 'pid=,uid=,args='], capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    return parse_macos_desktop_pids(proc.stdout, executable, uid=uid)


def quit_macos_app(app_bundle, executable, runner=subprocess.run, sleep=time.sleep, timeout=10.0, uid=None):
    """Gracefully ask macOS Antigravity.app to quit and wait for the main process to exit."""
    script = 'on run argv\n  tell application (item 1 of argv) to quit\nend run\n'
    try:
        runner(['/usr/bin/osascript', '-', str(app_bundle)], input=script, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    deadline = time.monotonic() + max(0.5, float(timeout))
    while True:
        if not running_desktop_pids(executable, platform='darwin', runner=runner, uid=uid):
            return True
        if time.monotonic() >= deadline:
            return False
        sleep(0.25)


def build_launch_command(executable, workspace=None, platform=None, use_open=True, open_binary='/usr/bin/open'):
    """Build the argv list for launching Antigravity Desktop with loopback debugging flags."""
    platform = platform or sys.platform
    extra = [str(Path(workspace).expanduser().resolve())] if workspace is not None else []
    if platform == 'darwin' and use_open:
        bundle = macos_app_bundle(executable)
        if bundle is not None and (open_binary is True or (isinstance(open_binary, (str, Path)) and Path(open_binary).is_file())):
            open_exe = '/usr/bin/open' if open_binary is True else str(open_binary)
            return [open_exe, '-a', str(bundle), '--args', *DEBUG_ARGS, *extra]
    return [str(executable), *DEBUG_ARGS, *extra]


def inspect_desktop_launch(platform=None, home=None, local=None, env=None, known_folder_resolver=None):
    """Inspect whether user launch entry points supply the loopback CDP flags."""
    platform = platform or sys.platform
    home = Path(home) if home is not None else Path.home()
    env = os.environ if env is None else env
    if platform == 'win32':
        found = []
        all_ready = True
        for lnk in _iter_lnk_files(_windows_shortcut_roots(home, env, known_folder_resolver=known_folder_resolver)):
            info = parse_lnk(lnk)
            if not is_antigravity_desktop_shortcut(lnk, info):
                continue
            found.append(str(lnk))
            has_port, has_addr = has_debug_flags(info.get('args', ''))
            if not (has_port and has_addr):
                all_ready = False
        return {'configured': bool(found) and all_ready, 'supported': True, 'entrypoints': found}
    if platform.startswith('linux'):
        user_file, _ = _linux_desktop_paths(home, local, env)
        if is_link(user_file) or not user_file.is_file():
            return {'configured': False, 'supported': True, 'entrypoints': []}
        try:
            content = user_file.read_text(encoding='utf-8', errors='replace')
        except OSError:
            return {'configured': False, 'supported': True, 'entrypoints': []}
        exec_lines = [line for line in content.splitlines() if re.match(r'^\s*Exec\s*=', line)]
        configured = bool(exec_lines) and all('--remote-debugging-port' in line for line in exec_lines)
        return {'configured': configured, 'supported': True, 'entrypoints': [str(user_file)]}
    if platform == 'darwin':
        bundle = _macos_launcher_bundle(home)
        launcher = bundle / 'Contents' / 'MacOS' / 'launcher'
        plist = bundle / 'Contents' / 'Info.plist'
        if is_link(bundle.parent) or is_link(bundle) or is_link(launcher) or is_link(plist):
            return {'configured': False, 'supported': True, 'entrypoints': []}
        if not launcher.is_file() or not plist.is_file():
            return {'configured': False, 'supported': True, 'entrypoints': []}
        try:
            script = launcher.read_text(encoding='utf-8', errors='replace')
        except OSError:
            return {'configured': False, 'supported': True, 'entrypoints': []}
        configured = '--remote-debugging-port' in script and '--remote-debugging-address' in script
        return {'configured': configured, 'supported': True, 'entrypoints': [str(bundle)]}
    return {'configured': False, 'supported': False, 'entrypoints': []}


def configure_desktop_launch(platform=None, home=None, local=None, env=None, managed=None,
                             shortcut_writer=write_windows_shortcut_args, system_desktop_dirs=None,
                             app_asar=None, profile=None, system_app_dirs=None, known_folder_resolver=None):
    """Add loopback debugging flags to user-owned Antigravity Desktop entry points."""
    platform = platform or sys.platform
    home = Path(home) if home is not None else Path.home()
    env = os.environ if env is None else env
    managed_state = dict(managed) if isinstance(managed, dict) else {}

    if platform == 'win32':
        tracked = dict(managed_state.get('windowsShortcuts') or {})
        updates = []
        entrypoints = []
        for lnk in _iter_lnk_files(_windows_shortcut_roots(home, env, known_folder_resolver=known_folder_resolver)):
            info = parse_lnk(lnk)
            if not is_antigravity_desktop_shortcut(lnk, info):
                continue
            key = str(lnk)
            entrypoints.append(key)
            new_args, added = merge_debug_arguments(info.get('args', ''))
            if added:
                updates.append({'path': key, 'args': new_args})
                existing = [flag for flag in tracked.get(key, []) if flag in DEBUG_ARGS]
                for flag in added:
                    if flag not in existing:
                        existing.append(flag)
                tracked[key] = existing
        shortcut_writer(updates)
        if tracked:
            managed_state['windowsShortcuts'] = tracked
        return {'configured': bool(entrypoints), 'supported': True, 'entrypoints': entrypoints}, managed_state

    if platform.startswith('linux'):
        user_file, sys_candidates = _linux_desktop_paths(home, local, env, system_desktop_dirs)
        if is_link(user_file) or is_link(user_file.parent):
            return {'configured': False, 'supported': True, 'entrypoints': []}, managed_state
        source = None
        if user_file.is_file():
            existing_text = user_file.read_text(encoding='utf-8', errors='replace')
            if DESKTOP_MANAGED_MARKER not in existing_text:
                exec_lines = [line for line in existing_text.splitlines() if re.match(r'^\s*Exec\s*=', line)]
                configured = bool(exec_lines) and all('--remote-debugging-port' in line for line in exec_lines)
                return {'configured': configured, 'supported': True, 'entrypoints': [str(user_file)]}, managed_state
            source = existing_text
        else:
            sys_file = next((c for c in sys_candidates if c.is_file() and not is_link(c)), None)
            if sys_file is not None:
                source = sys_file.read_text(encoding='utf-8', errors='replace')
        if source is None:
            return {'configured': False, 'supported': True, 'entrypoints': []}, managed_state
        updated = merge_desktop_entry(source)
        _atomic_write_text(user_file, updated)
        managed_state['linuxDesktopFile'] = str(user_file)
        return {'configured': True, 'supported': True, 'entrypoints': [str(user_file)]}, managed_state

    if platform == 'darwin':
        bundle = _macos_launcher_bundle(home)
        if is_link(bundle.parent) or is_link(bundle):
            return {'configured': False, 'supported': True, 'entrypoints': []}, managed_state
        if bundle.exists() and not _is_managed_macos_launcher(bundle):
            launcher = bundle / 'Contents' / 'MacOS' / 'launcher'
            configured = False
            if not is_link(launcher) and launcher.is_file():
                try:
                    script = launcher.read_text(encoding='utf-8', errors='replace')
                    configured = '--remote-debugging-port' in script and '--remote-debugging-address' in script
                except OSError:
                    configured = False
            return {'configured': configured, 'supported': True, 'entrypoints': [str(bundle)]}, managed_state
        target_app = _macos_target_app(app_asar=app_asar, home=home, env=env, system_app_dirs=system_app_dirs)
        if target_app is None:
            return {'configured': False, 'supported': True, 'entrypoints': []}, managed_state
        contents = bundle / 'Contents'
        macos_dir = contents / 'MacOS'
        resources_dir = contents / 'Resources'
        if any(is_link(p) for p in (contents, macos_dir, resources_dir)):
            return {'configured': False, 'supported': True, 'entrypoints': []}, managed_state
        icon_src = _macos_icon_source(target_app)
        icon_name = None
        if icon_src is not None:
            resources_dir.mkdir(parents=True, exist_ok=True)
            icon_dst = resources_dir / 'app.icns'
            if not is_link(icon_dst):
                shutil.copy2(icon_src, icon_dst)
                icon_name = 'app.icns'
        _atomic_write_text(contents / 'Info.plist', render_macos_launcher_plist(icon_name=icon_name), mode=0o644)
        _atomic_write_text(macos_dir / 'launcher', render_macos_launcher_script(target_app, profile_dir=profile), mode=0o755)
        managed_state['macosLauncherApp'] = str(bundle)
        return {'configured': True, 'supported': True, 'entrypoints': [str(bundle)]}, managed_state

    return {'configured': False, 'supported': False, 'entrypoints': []}, managed_state


def remove_desktop_launch(platform=None, home=None, local=None, env=None, managed=None,
                          shortcut_writer=write_windows_shortcut_args, system_desktop_dirs=None):
    """Revert only launch entry point changes recorded by Antigrative Dashboard."""
    platform = platform or sys.platform
    home = Path(home) if home is not None else Path.home()
    env = os.environ if env is None else env
    managed_state = dict(managed) if isinstance(managed, dict) else {}

    if platform == 'win32':
        tracked = managed_state.get('windowsShortcuts')
        if isinstance(tracked, dict):
            updates = []
            for lnk_str, flags in tracked.items():
                lnk = Path(lnk_str)
                if not isinstance(flags, list) or is_link(lnk) or not lnk.is_file():
                    continue
                info = parse_lnk(lnk)
                if not is_antigravity_desktop_shortcut(lnk, info):
                    continue
                stripped = strip_debug_arguments(info.get('args', ''), [f for f in flags if f in DEBUG_ARGS])
                if stripped != (info.get('args') or ''):
                    updates.append({'path': lnk_str, 'args': stripped})
            shortcut_writer(updates)
            managed_state.pop('windowsShortcuts', None)
        return managed_state

    if platform.startswith('linux'):
        user_file, _ = _linux_desktop_paths(home, local, env, system_desktop_dirs)
        target = Path(managed_state.get('linuxDesktopFile') or user_file)
        if not is_link(target) and target.is_file():
            try:
                content = target.read_text(encoding='utf-8', errors='replace')
                if DESKTOP_MANAGED_MARKER in content:
                    target.unlink()
            except OSError:
                pass
        managed_state.pop('linuxDesktopFile', None)
        return managed_state

    if platform == 'darwin':
        default_bundle = _macos_launcher_bundle(home)
        target = Path(managed_state.get('macosLauncherApp') or default_bundle)
        expected_parent = default_bundle.parent.resolve() if default_bundle.parent.exists() else default_bundle.parent
        try:
            target_parent = target.parent.resolve() if target.parent.exists() else target.parent
        except OSError:
            target_parent = target.parent
        if (not is_link(target) and target.is_dir() and target.name == MACOS_LAUNCHER_NAME
                and target_parent == expected_parent and _is_managed_macos_launcher(target)):
            try:
                shutil.rmtree(target)
            except OSError:
                pass
        managed_state.pop('macosLauncherApp', None)
        return managed_state

    return managed_state


def _cli_main(argv=None):
    import argparse
    import importlib.util

    parser = argparse.ArgumentParser(description='Antigrative Dashboard standalone launcher helper')
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('launch', help='Launch Antigravity Desktop with loopback debugging flags')
    p.add_argument('--exe', type=Path, help='Path to the Antigravity Desktop executable')
    p.add_argument('--workspace', type=Path, help='Optional workspace path to open')
    p.add_argument('--app-path', type=Path, help='Path to resources/app.asar for a custom installation')
    p.add_argument('--restart', action='store_true', help='Gracefully quit a running macOS instance without debug port before relaunching')
    args = parser.parse_args(argv)

    spec = importlib.util.spec_from_file_location('pulse_paths_cli', Path(__file__).with_name('platform_paths.py'))
    paths_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(paths_mod)
    paths = paths_mod.platform_paths()
    settings = {}
    if paths['settings'].is_file():
        try:
            settings = json.loads(paths['settings'].read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            settings = {}
    app_asar = args.app_path.expanduser().resolve() if args.app_path else paths['app']
    if not args.app_path and not app_asar.is_file() and isinstance(settings.get('appResources'), str):
        candidate = Path(settings['appResources']).expanduser() / 'app.asar'
        if candidate.is_file():
            app_asar = candidate
    profile = (
        Path(os.environ['AG_PULSE_PROFILE']).expanduser()
        if os.environ.get('AG_PULSE_PROFILE')
        else (Path(settings['profile']).expanduser() if isinstance(settings.get('profile'), str) and settings['profile'] else paths['profile'])
    )
    if args.exe is not None:
        executable = args.exe.expanduser().resolve()
        if not executable.is_file():
            raise RuntimeError(f'Antigravity desktop executable not found: {executable}')
    else:
        executable = desktop_executable(app_asar)
        if executable is None or not executable.is_file():
            raise RuntimeError('Antigravity desktop app not found. Use --exe or --app-path.')
    bundle = macos_app_bundle(executable) if sys.platform == 'darwin' else None
    if sys.platform == 'darwin':
        running = running_desktop_pids(executable, platform='darwin')
        if running:
            if has_active_debug_port(profile) and not args.restart:
                if args.workspace is not None and bundle is not None and Path('/usr/bin/open').is_file():
                    env = dict(os.environ)
                    env.pop('ELECTRON_RUN_AS_NODE', None)
                    subprocess.Popen(
                        ['/usr/bin/open', '-a', str(bundle), str(args.workspace.expanduser().resolve())],
                        env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                print('Antigravity is already running with remote debugging enabled.')
                return 0
            if not args.restart:
                raise RuntimeError(
                    'Antigravity is already running without remote debugging enabled. '
                    'Fully quit it first (Command+Q), or re-run with --restart.'
                )
            if bundle is None or not quit_macos_app(bundle, executable):
                raise RuntimeError('Antigravity did not finish quitting in time. Press Command+Q, then retry.')
    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    cmd = build_launch_command(executable, workspace=args.workspace, use_open=(args.exe is None))
    options = dict(env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if sys.platform == 'win32':
        options['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    else:
        options['start_new_session'] = True
    subprocess.Popen(cmd, **options)
    print('Launched Antigravity with loopback debugging flags:', bundle or executable)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(_cli_main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Antigrative Dashboard: {error}', file=sys.stderr)
        raise SystemExit(1)
