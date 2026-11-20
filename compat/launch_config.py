"""User-owned desktop launch configuration and host archive inspection."""
import base64
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat
import struct
import subprocess
import sys

DEBUG_PORT_FLAG = '--remote-debugging-port=0'
DEBUG_ADDRESS_FLAG = '--remote-debugging-address=127.0.0.1'
DEBUG_ARGS = (DEBUG_PORT_FLAG, DEBUG_ADDRESS_FLAG)
DESKTOP_MANAGED_MARKER = 'X-Antigravity-Pulse-Managed=true'


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
    if target_name == 'antigravityproxy.exe':
        shortcut_name = Path(shortcut_path).name.lower()
        icon_name = PureWindowsPath(info.get('icon') or '').name.lower()
        return shortcut_name == 'antigravity.lnk' or icon_name == 'antigravity.exe'
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


def _windows_shortcut_roots(home, env):
    home = Path(home) if home is not None else Path.home()
    env = os.environ if env is None else env
    is_real_home = home.resolve() == Path.home().resolve()
    appdata = Path(env['APPDATA']) if (is_real_home and env.get('APPDATA')) else (home / 'AppData' / 'Roaming')
    return [
        home / 'Desktop',
        appdata / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs',
        appdata / 'Microsoft' / 'Internet Explorer' / 'Quick Launch' / 'User Pinned' / 'TaskBar',
    ]


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
        "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json\n"
        "$ws = New-Object -ComObject WScript.Shell\n"
        "foreach ($u in @($payload)) {\n"
        "  $item = Get-Item -LiteralPath $u.path\n"
        "  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked shortcut' }\n"
        "  $s = $ws.CreateShortcut($u.path)\n"
        "  $s.Arguments = [string]$u.args\n"
        "  $s.Save()\n"
        "}\n"
    )
    encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
    kwargs = {'input': json.dumps(updates), 'text': True, 'encoding': 'utf-8', 'timeout': 15, 'check': True}
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


def _atomic_write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, path)


def inspect_desktop_launch(platform=None, home=None, local=None, env=None):
    """Inspect whether user launch entry points supply the loopback CDP flags."""
    platform = platform or sys.platform
    home = Path(home) if home is not None else Path.home()
    env = os.environ if env is None else env
    if platform == 'win32':
        found = []
        all_ready = True
        for lnk in _iter_lnk_files(_windows_shortcut_roots(home, env)):
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
    return {'configured': False, 'supported': False, 'entrypoints': []}


def configure_desktop_launch(platform=None, home=None, local=None, env=None, managed=None,
                             shortcut_writer=write_windows_shortcut_args, system_desktop_dirs=None):
    """Add loopback debugging flags to user-owned Antigravity Desktop entry points."""
    platform = platform or sys.platform
    home = Path(home) if home is not None else Path.home()
    env = os.environ if env is None else env
    managed_state = dict(managed) if isinstance(managed, dict) else {}

    if platform == 'win32':
        tracked = dict(managed_state.get('windowsShortcuts') or {})
        updates = []
        entrypoints = []
        for lnk in _iter_lnk_files(_windows_shortcut_roots(home, env)):
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

    return managed_state
