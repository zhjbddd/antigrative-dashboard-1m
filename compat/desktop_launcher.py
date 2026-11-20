"""Cross-platform opt-in desktop debug launcher and lifecycle helpers."""
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import time

DEBUG_ARGS = ('--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1')
BUNDLE_ID = 'io.github.wycocoyu.agy-context-dashboard.launcher'
LINUX_MARKER = 'X-Antigravity-Pulse-Launcher=true'
WIN32_MARKER = 'REM AG_PULSE_LAUNCHER_V1'


def _normalize_platform(platform=None):
    plat = platform or sys.platform
    if plat.startswith('linux'):
        return 'linux'
    if plat in ('darwin', 'win32'):
        return plat
    raise RuntimeError('Supported platforms: Windows, Linux, macOS')


def _linked(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def _launcher_base(home: Path, local: Path, plat: str) -> Path:
    return Path(local) if plat == 'win32' else Path(home)


def _verify_safe_launcher_path(base: Path, target: Path):
    base = Path(base)
    target = Path(target)
    rel = target.relative_to(base)
    probe = base
    while probe != probe.parent:
        if _linked(probe):
            raise RuntimeError(f'Refusing symlink or junction at launcher base: {probe}')
        if probe.exists():
            if not probe.is_dir():
                raise RuntimeError(f'Launcher base must be a directory: {probe}')
            break
        probe = probe.parent
    resolved_base = base.resolve() if base.exists() else None
    cur = base
    for part in rel.parts[:-1]:
        cur = cur / part
        if _linked(cur):
            raise RuntimeError(f'Refusing symlink or junction along launcher path: {cur}')
        if cur.exists():
            if not cur.is_dir():
                raise RuntimeError(f'Expected directory along launcher path: {cur}')
            if resolved_base is not None and cur.resolve() != resolved_base / cur.relative_to(base):
                raise RuntimeError(f'Launcher path resolves outside base directory: {cur}')
    if _linked(target):
        raise RuntimeError(f'Refusing symlink or junction at launcher target: {target}')
    if target.exists() and resolved_base is not None and target.resolve() != resolved_base / rel:
        raise RuntimeError(f'Launcher target resolves outside base directory: {target}')
    if target.is_dir():
        for child in target.rglob('*'):
            if _linked(child):
                raise RuntimeError(f'Refusing symlink or junction inside launcher bundle: {child}')


def resolve_desktop_target(app_asar: Path, platform=None):
    plat = _normalize_platform(platform)
    app_path = Path(os.path.abspath(str(Path(app_asar).expanduser())))
    if plat == 'darwin':
        if len(app_path.parents) < 3 or app_path.parents[2].suffix != '.app':
            raise RuntimeError(f'Expected an Antigravity .app bundle containing {app_path}')
        bundle = app_path.parents[2]
        return {
            'platform': plat,
            'bundle': bundle,
            'executable': bundle / 'Contents' / 'MacOS' / 'Antigravity',
            'icon': bundle / 'Contents' / 'Resources' / 'icon.icns',
            'app_asar': app_path,
        }
    if len(app_path.parents) < 2:
        raise RuntimeError(f'Expected Antigravity resources/app.asar path, got {app_path}')
    root = app_path.parents[1]
    entries = set(os.listdir(root)) if root.is_dir() else set()
    if plat == 'win32':
        primary, fallback = root / 'Antigravity.exe', root / 'antigravity.exe'
    else:
        primary, fallback = root / 'antigravity', root / 'Antigravity'
    if primary.name in entries:
        executable = primary
    elif fallback.name in entries:
        executable = fallback
    else:
        executable = fallback if (not primary.is_file() and fallback.is_file()) else primary
    return {
        'platform': plat,
        'bundle': None,
        'executable': executable,
        'icon': None,
        'app_asar': app_path,
    }


def launcher_path(home: Path, local: Path, platform=None) -> Path:
    plat = _normalize_platform(platform)
    home = Path(home)
    local = Path(local)
    if plat == 'darwin':
        return home / 'Applications' / 'Antigravity (Debug).app'
    if plat == 'linux':
        return home / '.local' / 'share' / 'applications' / 'antigravity-pulse-debug.desktop'
    return local / 'AntigravityPulse' / 'Launch Antigravity (Debug).cmd'


def _has_ownership(target: Path, plat: str) -> bool:
    if not target.exists():
        return False
    if plat == 'darwin':
        if not target.is_dir():
            return False
        contents = target / 'Contents'
        plist_path = contents / 'Info.plist'
        if _linked(contents) or _linked(plist_path) or not plist_path.is_file():
            return False
        try:
            data = plistlib.loads(plist_path.read_bytes())
        except Exception:
            return False
        return isinstance(data, dict) and data.get('CFBundleIdentifier') == BUNDLE_ID
    if not target.is_file():
        return False
    try:
        text = target.read_text(encoding='utf-8-sig', errors='replace')
    except OSError:
        return False
    marker = LINUX_MARKER if plat == 'linux' else WIN32_MARKER
    return any(line.strip() == marker for line in text.splitlines())


def inspect_launcher(home: Path, local: Path, platform=None):
    plat = _normalize_platform(platform)
    target = launcher_path(home, local, plat)
    base = _launcher_base(home, local, plat)
    try:
        _verify_safe_launcher_path(base, target)
        installed = _has_ownership(target, plat)
    except (OSError, RuntimeError):
        installed = False
    return {'installed': bool(installed), 'path': str(target), 'platform': plat}


def _darwin_script(bundle: Path) -> str:
    quoted_bundle = shlex.quote(str(bundle))
    applescript_bundle = str(bundle).replace('\\', '\\\\').replace('"', '\\"')
    quit_script = shlex.quote(f'tell application "{applescript_bundle}" to quit')
    debug_flags = ' '.join(DEBUG_ARGS)
    return (
        '#!/bin/sh\n'
        'set -u\n'
        'unset ELECTRON_RUN_AS_NODE\n'
        "for _ag_var in $(env | awk -F= '/^ANTIGRAVITY_[A-Za-z0-9_]*=/ {print $1}'); do\n"
        '  unset "$_ag_var"\n'
        'done\n\n'
        f'BUNDLE={quoted_bundle}\n'
        'TARGET_EXE="$BUNDLE/Contents/MacOS/Antigravity"\n\n'
        'MATCHES=$(ps axo pid=,command= | awk -v exe="$TARGET_EXE" \'\n'
        '{\n'
        '  pid = $1\n'
        '  cmd = $0\n'
        '  sub(/^[ \\t]*[0-9]+[ \\t]+/, "", cmd)\n'
        '  if (substr(cmd, 1, length(exe)) == exe &&\n'
        '      (length(cmd) == length(exe) || substr(cmd, length(exe) + 1, 1) == " ") &&\n'
        '      index(cmd, "--type=") == 0) {\n'
        '    print pid (index(cmd, "--remote-debugging-port") > 0 ? " DEBUG" : " NODEBUG")\n'
        '  }\n'
        '}\')\n\n'
        'if [ -z "$MATCHES" ]; then\n'
        f'  exec open -a "$BUNDLE" --args {debug_flags} "$@"\n'
        'fi\n\n'
        'case "$MATCHES" in\n'
        '  *" DEBUG"*)\n'
        '    exec open -a "$BUNDLE"\n'
        '    ;;\n'
        'esac\n\n'
        'if ! osascript -e \'display dialog "Antigravity is already running without --remote-debugging-port.\\n\\nQuit and relaunch Antigravity with debugging enabled?" buttons {"Cancel", "Relaunch"} default button "Relaunch" with title "Antigravity (Debug)"\' >/dev/null 2>&1; then\n'
        '  exit 0\n'
        'fi\n\n'
        "PIDS=$(printf '%s\\n' \"$MATCHES\" | awk '{print $1}')\n"
        f'osascript -e {quit_script} >/dev/null 2>&1 || true\n\n'
        'ticks=0\n'
        'while [ "$ticks" -lt 50 ]; do\n'
        '  alive=""\n'
        '  for pid in $PIDS; do\n'
        '    if kill -0 "$pid" 2>/dev/null; then\n'
        '      alive="$alive $pid"\n'
        '    fi\n'
        '  done\n'
        '  if [ -z "$alive" ]; then\n'
        '    break\n'
        '  fi\n'
        '  if [ "$ticks" -eq 40 ]; then\n'
        '    for pid in $alive; do\n'
        '      kill -TERM "$pid" 2>/dev/null || true\n'
        '    done\n'
        '  fi\n'
        '  sleep 0.2\n'
        '  ticks=$((ticks + 1))\n'
        'done\n\n'
        'for pid in $PIDS; do\n'
        '  if kill -0 "$pid" 2>/dev/null; then\n'
        '    osascript -e \'display alert "Antigravity did not exit in time" message "Close Antigravity manually and try again." as warning\' >/dev/null 2>&1 || true\n'
        '    exit 1\n'
        '  fi\n'
        'done\n\n'
        'sleep 0.3\n'
        f'exec open -a "$BUNDLE" --args {debug_flags} "$@"\n'
    )


def _linux_desktop_entry(executable: Path) -> str:
    escaped_exe = str(executable).replace('\\', '\\\\').replace('"', '\\"')
    debug_flags = ' '.join(DEBUG_ARGS)
    return (
        '[Desktop Entry]\n'
        'Type=Application\n'
        'Name=Antigravity (Debug)\n'
        'Comment=Launch Antigravity with loopback remote debugging enabled\n'
        f'Exec="{escaped_exe}" {debug_flags} %U\n'
        'Icon=antigravity\n'
        'Terminal=false\n'
        'Categories=Development;IDE;\n'
        'StartupNotify=true\n'
        f'{LINUX_MARKER}\n'
    )


def _win32_cmd_script(executable: Path) -> str:
    exe_str = str(executable)
    if any(ch in exe_str for ch in '\r\n\x00"'):
        raise RuntimeError('Antigravity executable path contains unsupported control characters or quotes.')
    ps_exe = exe_str.replace("'", "''").replace('%', '%%')
    ps_args = ','.join(f"'{arg}'" for arg in DEBUG_ARGS)
    lines = [
        '@echo off',
        WIN32_MARKER,
        'set "ELECTRON_RUN_AS_NODE="',
        (
            'powershell.exe -NoProfile -WindowStyle Hidden -Command '
            f'"Start-Process -FilePath \'{ps_exe}\' -ArgumentList {ps_args} -WindowStyle Normal"'
        ),
    ]
    return '\r\n'.join(lines) + '\r\n'


def _win32_start_menu_shortcut(home: Path) -> Path:
    appdata = Path(os.environ['APPDATA']) if os.environ.get('APPDATA') else Path(home) / 'AppData' / 'Roaming'
    return appdata / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs' / 'Antigravity (Debug).lnk'


def _best_effort_win32_shortcut(home: Path, launcher_cmd: Path, executable: Path):
    if sys.platform != 'win32':
        return
    ps = shutil.which('powershell.exe') or shutil.which('powershell')
    if not ps:
        return
    try:
        shortcut = _win32_start_menu_shortcut(home)
        base = Path(os.environ['APPDATA']) if os.environ.get('APPDATA') else Path(home) / 'AppData' / 'Roaming'
        _verify_safe_launcher_path(base, shortcut)
        shortcut.parent.mkdir(parents=True, exist_ok=True)
        lit = lambda value: "'" + str(value).replace("'", "''") + "'"
        script = (
            '$ws = New-Object -ComObject WScript.Shell; '
            f'$sc = $ws.CreateShortcut({lit(shortcut)}); '
            f'$sc.TargetPath = {lit(launcher_cmd)}; '
            f'$sc.IconLocation = {lit(str(executable) + ",0")}; '
            '$sc.WindowStyle = 7; '
            '$sc.Description = \'Launch Antigravity with remote debugging enabled\'; '
            '$sc.Save()'
        )
        subprocess.run([ps, '-NoProfile', '-NonInteractive', '-Command', script],
                       capture_output=True, text=True, check=False, timeout=10)
    except Exception:
        pass


def install_launcher(home: Path, local: Path, app_asar: Path, platform=None):
    plat = _normalize_platform(platform)
    home, local = Path(home), Path(local)
    target_info = resolve_desktop_target(app_asar, platform=plat)
    if plat == 'darwin' and not target_info['bundle'].is_dir():
        raise RuntimeError(f"Antigravity bundle not found: {target_info['bundle']}")
    if not target_info['executable'].is_file():
        raise RuntimeError(f"Antigravity executable not found: {target_info['executable']}")

    dest = launcher_path(home, local, plat)
    base = _launcher_base(home, local, plat)
    _verify_safe_launcher_path(base, dest)
    if dest.exists() and not _has_ownership(dest, plat):
        raise RuntimeError(f'Existing launcher at {dest} is not owned by Antigrative Dashboard; refusing to overwrite it.')

    dest.parent.mkdir(parents=True, exist_ok=True)
    if plat == 'darwin':
        contents = dest / 'Contents'
        macos = contents / 'MacOS'
        resources = contents / 'Resources'
        macos.mkdir(parents=True, exist_ok=True)
        resources.mkdir(parents=True, exist_ok=True)

        plist = {
            'CFBundleIdentifier': BUNDLE_ID,
            'CFBundleName': 'Antigravity (Debug)',
            'CFBundleDisplayName': 'Antigravity (Debug)',
            'CFBundleExecutable': 'launcher',
            'CFBundlePackageType': 'APPL',
            'NSHighResolutionCapable': True,
        }
        icon_dest = resources / 'icon.icns'
        if target_info['icon'] and target_info['icon'].is_file():
            shutil.copy2(target_info['icon'], icon_dest)
            plist['CFBundleIconFile'] = 'icon.icns'
        elif icon_dest.exists() and not _linked(icon_dest):
            icon_dest.unlink()

        (contents / 'Info.plist').write_bytes(plistlib.dumps(plist))
        launcher_exec = macos / 'launcher'
        launcher_exec.write_text(_darwin_script(target_info['bundle']), encoding='utf-8')
        os.chmod(launcher_exec, 0o755)
        codesign = shutil.which('codesign')
        if codesign:
            try:
                subprocess.run([codesign, '--force', '--sign', '-', str(dest)],
                               capture_output=True, text=True, check=False)
            except OSError:
                pass
    elif plat == 'linux':
        dest.write_text(_linux_desktop_entry(target_info['executable']), encoding='utf-8')
        os.chmod(dest, 0o755)
    else:
        dest.write_bytes(_win32_cmd_script(target_info['executable']).encode('utf-8'))
        _best_effort_win32_shortcut(home, dest, target_info['executable'])

    return {'installed': True, 'path': str(dest), 'platform': plat}


def uninstall_launcher(home: Path, local: Path, platform=None):
    plat = _normalize_platform(platform)
    home, local = Path(home), Path(local)
    dest = launcher_path(home, local, plat)
    base = _launcher_base(home, local, plat)
    _verify_safe_launcher_path(base, dest)
    if not dest.exists():
        return {'removed': False, 'path': str(dest), 'platform': plat}
    if not _has_ownership(dest, plat):
        raise RuntimeError(f'Launcher at {dest} is not owned by Antigrative Dashboard; refusing to remove it.')
    if plat == 'darwin':
        shutil.rmtree(dest)
    else:
        dest.unlink()
    if plat == 'win32' and sys.platform == 'win32':
        try:
            shortcut = _win32_start_menu_shortcut(home)
            base_roaming = Path(os.environ['APPDATA']) if os.environ.get('APPDATA') else Path(home) / 'AppData' / 'Roaming'
            _verify_safe_launcher_path(base_roaming, shortcut)
            if shortcut.is_file():
                shortcut.unlink()
        except Exception:
            pass
    return {'removed': True, 'path': str(dest), 'platform': plat}


def _find_main_pids(target_info, plat: str, run_fn):
    exe_str = str(target_info['executable'])
    current_pid = os.getpid()
    if plat in ('darwin', 'linux'):
        res = run_fn(['ps', 'axo', 'pid=,command='], capture_output=True, text=True, check=False)
        if getattr(res, 'returncode', 0) != 0:
            return []
        candidates = {exe_str}
        try:
            candidates.add(str(target_info['executable'].resolve()))
        except OSError:
            pass
        pids = []
        for line in (getattr(res, 'stdout', '') or '').splitlines():
            stripped = line.lstrip()
            if not stripped:
                continue
            parts = stripped.split(None, 1)
            if len(parts) < 2 or not parts[0].isdigit():
                continue
            pid = int(parts[0])
            cmd = parts[1]
            if pid == current_pid or '--type=' in cmd:
                continue
            if any(cmd == c or cmd.startswith(c + ' ') for c in candidates):
                pids.append(pid)
        return pids

    ps_exe = exe_str.replace("'", "''")
    script = (
        f"$exe = '{ps_exe}'; "
        'Get-CimInstance Win32_Process | '
        'Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $exe) -and '
        '(-not $_.CommandLine -or $_.CommandLine -notlike \'*--type=*\') } | '
        'Select-Object -ExpandProperty ProcessId'
    )
    res = run_fn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                 capture_output=True, text=True, check=False)
    if getattr(res, 'returncode', 0) != 0:
        return []
    pids = []
    for line in (getattr(res, 'stdout', '') or '').splitlines():
        token = line.strip()
        if token.isdigit():
            pid = int(token)
            if pid != current_pid:
                pids.append(pid)
    return pids


def _pid_alive_posix(pid: int, kill_fn) -> bool:
    try:
        kill_fn(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _quit_and_wait(target_info, plat: str, run_fn, sleep_fn, kill_fn):
    pids = _find_main_pids(target_info, plat, run_fn)
    if not pids:
        return []

    if plat == 'darwin':
        applescript_bundle = str(target_info['bundle']).replace('\\', '\\\\').replace('"', '\\"')
        run_fn(['osascript', '-e', f'tell application "{applescript_bundle}" to quit'],
               capture_output=True, text=True, check=False)
    elif plat == 'linux':
        for pid in pids:
            try:
                kill_fn(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    else:
        for pid in pids:
            run_fn(['taskkill', '/PID', str(pid)], capture_output=True, text=True, check=False)

    remaining = list(pids)
    for tick in range(50):
        if plat in ('darwin', 'linux'):
            remaining = [pid for pid in remaining if _pid_alive_posix(pid, kill_fn)]
        else:
            current = set(_find_main_pids(target_info, plat, run_fn))
            remaining = [pid for pid in remaining if pid in current]
        if not remaining:
            sleep_fn(0.3)
            return pids
        if tick == 40:
            if plat == 'darwin':
                for pid in remaining:
                    try:
                        kill_fn(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            elif plat == 'win32':
                for pid in remaining:
                    run_fn(['taskkill', '/F', '/PID', str(pid)], capture_output=True, text=True, check=False)
        sleep_fn(0.2)

    if plat in ('darwin', 'linux'):
        remaining = [pid for pid in remaining if _pid_alive_posix(pid, kill_fn)]
    else:
        current = set(_find_main_pids(target_info, plat, run_fn))
        remaining = [pid for pid in remaining if pid in current]
    if remaining:
        raise RuntimeError(f'Timed out waiting for existing Antigravity process(es) to exit: {remaining}')
    sleep_fn(0.3)
    return pids


def launch_desktop(app_asar: Path, relaunch=False, extra_args=(), platform=None,
                   run_fn=None, popen_fn=None, sleep_fn=None, kill_fn=None, env=None):
    plat = _normalize_platform(platform)
    run_fn = run_fn or subprocess.run
    popen_fn = popen_fn or subprocess.Popen
    sleep_fn = sleep_fn or time.sleep
    kill_fn = kill_fn or os.kill

    target_info = resolve_desktop_target(app_asar, platform=plat)
    if plat == 'darwin' and not target_info['bundle'].is_dir():
        raise RuntimeError(f"Antigravity bundle not found: {target_info['bundle']}")
    if not target_info['executable'].is_file():
        raise RuntimeError(f"Antigravity executable not found: {target_info['executable']}")

    stopped_pids = _quit_and_wait(target_info, plat, run_fn, sleep_fn, kill_fn) if relaunch else []

    source_env = os.environ if env is None else env
    child_env = {
        key: value for key, value in source_env.items()
        if key != 'ELECTRON_RUN_AS_NODE' and not key.startswith('ANTIGRAVITY_')
    }
    cmd = [str(target_info['executable']), *DEBUG_ARGS, *map(str, extra_args)]
    popen_kwargs = {
        'stdin': subprocess.DEVNULL,
        'stdout': subprocess.DEVNULL,
        'stderr': subprocess.DEVNULL,
        'env': child_env,
    }
    if plat == 'win32':
        flags = getattr(subprocess, 'DETACHED_PROCESS', 0x00000008) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x00000200)
        popen_kwargs['creationflags'] = flags
    else:
        popen_kwargs['start_new_session'] = True

    process = popen_fn(cmd, **popen_kwargs)
    return {
        'launched': True,
        'platform': plat,
        'executable': str(target_info['executable']),
        'args': list(DEBUG_ARGS) + [str(a) for a in extra_args],
        'pid': getattr(process, 'pid', None),
        'relaunched': bool(stopped_pids),
        'stoppedPids': stopped_pids,
    }
