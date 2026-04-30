"""ADB command handler."""

import subprocess
import threading
import shlex
from config import ADB_PATH, ADB_COMMAND_TIMEOUT


def _run(args: list, timeout: int = ADB_COMMAND_TIMEOUT) -> dict:
    try:
        result = subprocess.run(
            [ADB_PATH] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except FileNotFoundError:
        return {"success": False, "stdout": "", "stderr": "adb를 찾을 수 없습니다. PATH를 확인하세요.", "returncode": -1}
    except subprocess.TimeoutExpired:
        return {"success": False, "stdout": "", "stderr": f"명령 타임아웃 ({timeout}s)", "returncode": -1}
    except Exception as e:
        return {"success": False, "stdout": "", "stderr": str(e), "returncode": -1}


def get_devices() -> list:
    result = _run(["devices", "-l"])
    if not result["success"] and result["returncode"] == -1:
        return []
    devices = []
    for line in result["stdout"].splitlines()[1:]:
        line = line.strip()
        if not line or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) >= 2:
            serial = parts[0]
            status = parts[1]
            info = " ".join(parts[2:])
            devices.append({"serial": serial, "status": status, "info": info})
    return devices


def run_shell(serial: str, command: str) -> dict:
    args = ["-s", serial, "shell"] + shlex.split(command)
    return _run(args)


def run_command(serial: str, command: str) -> dict:
    """Run arbitrary adb command (not shell). Command string like 'logcat -d'"""
    parts = shlex.split(command)
    args = ["-s", serial] + parts
    return _run(args)


def get_device_info(serial: str) -> dict:
    props = {
        "model": "ro.product.model",
        "manufacturer": "ro.product.manufacturer",
        "android_version": "ro.build.version.release",
        "sdk_version": "ro.build.version.sdk",
        "build_id": "ro.build.id",
        "serial_no": "ro.serialno",
        "imei": "persist.radio.imei",
        "baseband": "gsm.version.baseband",
    }
    info = {"serial": serial}
    for key, prop in props.items():
        r = _run(["-s", serial, "shell", "getprop", prop])
        info[key] = r["stdout"].strip() if r["success"] else ""
    return info


def stream_logcat(serial: str, args: str, callback, stop_event: threading.Event):
    """Stream logcat output; calls callback(line) for each line."""
    cmd = [ADB_PATH, "-s", serial, "logcat"] + shlex.split(args) if args else [ADB_PATH, "-s", serial, "logcat"]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        while not stop_event.is_set():
            line = proc.stdout.readline()
            if not line:
                break
            callback(line.rstrip())
        proc.terminate()
    except Exception as e:
        callback(f"[ERROR] {e}")
