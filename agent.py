#!/usr/bin/env python3
"""
RemoteDiag Agent - Windows side
단말기가 연결된 Windows PC에서 실행. 서버에 WebSocket으로 연결하여 명령 수행.
"""

import os
import platform
import shlex
import signal
import subprocess
import sys
import threading
import time

import serial
import serial.tools.list_ports
import socketio as sio_module

# ── 빌드 시 설정값 ───────────────────────────────────────────────────
SERVER_URL   = "wss://10.1.255.85:8443"   # 빌드 시 서버 주소 고정
EXPIRE_DATE  = "2026-05-30"               # 사용 기한 (YYYY-MM-DD)

ADB_PATH = "adb"
AT_TIMEOUT = 5
AT_BAUDRATE = 115200

_serial_conns = {}
_serial_lock = threading.Lock()

_logcat_stop: threading.Event | None = None
_logcat_thread: threading.Thread | None = None

_log_stop: threading.Event | None = None
_log_thread: threading.Thread | None = None

_kmsg_stop: threading.Event | None = None
_kmsg_thread: threading.Thread | None = None

_shutdown = threading.Event()

sio = sio_module.Client(ssl_verify=False, reconnection=False)


# ── Signal handling ──────────────────────────────────────────────────

def _setup_signals():
    def _handler(sig, frame):
        print("\n[agent] 종료 신호 수신. 종료 중...")
        _shutdown.set()
        try:
            sio.disconnect()
        except Exception:
            pass

    try:
        signal.signal(signal.SIGINT, _handler)
    except Exception:
        pass
    try:
        signal.signal(signal.SIGTERM, _handler)
    except Exception:
        pass
    if hasattr(signal, "SIGBREAK"):
        try:
            signal.signal(signal.SIGBREAK, _handler)
        except Exception:
            pass


# ── Connection events ────────────────────────────────────────────────

@sio.event
def connect():
    print(f"[agent] 서버 연결됨: {SERVER_URL}")
    sio.emit("agent_hello", {
        "platform": platform.system(),
        "node": platform.node(),
        "python": platform.python_version(),
    })
    _push_devices()
    _push_ports()

@sio.event
def disconnect():
    print("[agent] 서버 연결 끊김. 재연결 시도 중...")

@sio.event
def connect_error(data):
    print(f"[agent] 연결 오류: {data}")


# ── Command dispatcher ───────────────────────────────────────────────

@sio.on("command")
def on_command(data: dict):
    cmd_type = data.get("type", "")
    browser_sid = data.get("browser_sid")
    cmd_id = data.get("id")

    result: dict = {"id": cmd_id, "browser_sid": browser_sid, "success": False}

    try:
        if cmd_type == "adb_devices":
            result["data"] = _adb_devices()
            result["success"] = True

        elif cmd_type == "adb_shell":
            r = _adb_shell(data["serial"], data["command"])
            result.update(r)

        elif cmd_type == "adb_info":
            result["data"] = _adb_info(data["serial"])
            result["success"] = True

        elif cmd_type == "adb_command":
            r = _adb_run(["-s", data["serial"]] + shlex.split(data["command"]))
            result.update(r)

        elif cmd_type == "at_ports":
            result["data"] = _at_list_ports()
            result["open"] = _at_open_ports()
            result["success"] = True

        elif cmd_type == "at_open":
            result.update(_at_open(data["port"], int(data.get("baudrate", AT_BAUDRATE))))

        elif cmd_type == "at_close":
            result.update(_at_close(data["port"]))

        elif cmd_type == "at_command":
            result.update(_at_send(data["port"], data["command"],
                                   float(data.get("timeout", AT_TIMEOUT))))

        elif cmd_type == "logcat_start":
            _logcat_start(data["serial"], data.get("args", ""), browser_sid)
            result["success"] = True

        elif cmd_type == "logcat_stop":
            _logcat_stop_fn()
            result["success"] = True

        elif cmd_type == "log_start":
            _log_start(data["serial"], data["path"], browser_sid)
            result["success"] = True

        elif cmd_type == "log_stop":
            _log_stop_fn()
            result["success"] = True

        elif cmd_type == "log_get":
            r = _adb_shell(data["serial"], f"cat {data['path']}", timeout=60)
            result["data"] = r.get("stdout", "")
            result["success"] = r["success"]
            if not r["success"]:
                result["error"] = r.get("stderr", "파일을 읽을 수 없습니다.")

        elif cmd_type == "kmsg_start":
            _kmsg_start(data["serial"], browser_sid)
            result["success"] = True

        elif cmd_type == "kmsg_stop":
            _kmsg_stop_fn()
            result["success"] = True

        elif cmd_type == "kmsg_get":
            r = _adb_shell(data["serial"], "dmesg", timeout=30)
            result["data"] = r.get("stdout", "")
            result["success"] = r["success"]
            if not r["success"]:
                result["error"] = r.get("stderr", "kmsg를 읽을 수 없습니다.")

        elif cmd_type == "log_upload":
            t = threading.Thread(
                target=_do_log_upload,
                args=(data["serial"], data.get("port", ""), browser_sid),
                daemon=True,
            )
            t.start()
            result["success"] = True
            result["message"] = "로그 수집 시작됨"

        else:
            result["error"] = f"알 수 없는 명령: {cmd_type}"

    except Exception as e:
        result["error"] = str(e)

    sio.emit("result", result)


# ── ADB helpers ──────────────────────────────────────────────────────

def _adb_run(args: list, timeout: int = 30) -> dict:
    try:
        r = subprocess.run(
            [ADB_PATH] + args,
            capture_output=True,          # 바이너리 모드로 받아서 직접 정규화
            timeout=timeout,
        )
        # 바이트 레벨 줄바꿈 정규화 (순서 중요)
        # 파일의 \r\n + PTY onlcr 변환 → \r\r\n 발생
        # \r\r\n 을 먼저 처리하지 않으면 → \r\n → \n\n (이중 줄바꿈) 발생
        def _norm(b: bytes) -> str:
            return b.replace(b'\r\r\n', b'\n') \
                    .replace(b'\r\n', b'\n') \
                    .replace(b'\r', b'\n') \
                    .decode('utf-8', errors='replace')
        stdout = _norm(r.stdout)
        stderr = _norm(r.stderr)
        return {"success": r.returncode == 0, "stdout": stdout, "stderr": stderr}
    except FileNotFoundError:
        return {"success": False, "stdout": "", "stderr": "adb를 찾을 수 없습니다. PATH를 확인하세요."}
    except subprocess.TimeoutExpired:
        return {"success": False, "stdout": "", "stderr": f"타임아웃 ({timeout}s)"}
    except Exception as e:
        return {"success": False, "stdout": "", "stderr": str(e)}


def _adb_devices() -> list:
    r = _adb_run(["devices", "-l"])
    devices = []
    for line in r.get("stdout", "").splitlines()[1:]:
        line = line.strip()
        if not line or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) >= 2:
            devices.append({
                "serial": parts[0],
                "status": parts[1],
                "info": " ".join(parts[2:]),
            })
    return devices


def _adb_shell(serial: str, command: str, timeout: int = 30) -> dict:
    return _adb_run(["-s", serial, "shell"] + shlex.split(command), timeout=timeout)


def _adb_info(serial: str) -> dict:
    props = {
        "model":           "ro.product.model",
        "manufacturer":    "ro.product.manufacturer",
        "android_version": "ro.build.version.release",
        "sdk_version":     "ro.build.version.sdk",
        "build_id":        "ro.build.id",
        "serial_no":       "ro.serialno",
        "imei":            "persist.radio.imei",
        "baseband":        "gsm.version.baseband",
    }
    info = {"serial": serial}
    for key, prop in props.items():
        r = _adb_run(["-s", serial, "shell", "getprop", prop])
        info[key] = r["stdout"].strip() if r["success"] else ""
    return info


def _push_devices():
    sio.emit("device_update", {"list": _adb_devices()})


# ── AT / Serial helpers ──────────────────────────────────────────────

def _at_list_ports() -> list:
    port_map = {
        p.device: {"port": p.device, "description": p.description, "hwid": p.hwid}
        for p in serial.tools.list_ports.comports()
    }

    if platform.system() == "Windows":
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                 r"HARDWARE\DEVICEMAP\SERIALCOMM")
            i = 0
            while True:
                try:
                    name, value, _ = winreg.EnumValue(key, i)
                    if value not in port_map:
                        port_map[value] = {
                            "port": value,
                            "description": name.split("\\")[-1],
                            "hwid": "",
                        }
                    i += 1
                except OSError:
                    break
            winreg.CloseKey(key)
        except Exception:
            pass

        try:
            import subprocess as _sp
            ps = (
                'Get-WmiObject Win32_POTSModem | '
                'Select-Object AttachedTo,Description | '
                'ConvertTo-Json'
            )
            r = _sp.run(["powershell", "-NoProfile", "-Command", ps],
                        capture_output=True, text=True, timeout=5)
            if r.returncode == 0 and r.stdout.strip():
                import json as _json
                modems = _json.loads(r.stdout)
                if isinstance(modems, dict):
                    modems = [modems]
                for m in modems:
                    port = m.get("AttachedTo", "")
                    desc = m.get("Description", "Modem")
                    if port and port in port_map:
                        port_map[port]["description"] = desc
                    elif port:
                        port_map[port] = {"port": port, "description": desc, "hwid": ""}
        except Exception:
            pass

    def _port_num(p):
        try:
            return int(''.join(filter(str.isdigit, p["port"])))
        except Exception:
            return 0

    return sorted(port_map.values(), key=_port_num)


def _at_open_ports() -> list:
    with _serial_lock:
        return [p for p, s in _serial_conns.items() if s.is_open]


def _at_open(port: str, baudrate: int = AT_BAUDRATE) -> dict:
    with _serial_lock:
        if port in _serial_conns and _serial_conns[port].is_open:
            return {"success": True, "message": f"{port} 이미 열려있음"}
        try:
            ser = serial.Serial(port=port, baudrate=baudrate,
                                bytesize=serial.EIGHTBITS,
                                parity=serial.PARITY_NONE,
                                stopbits=serial.STOPBITS_ONE,
                                timeout=AT_TIMEOUT)
            _serial_conns[port] = ser
            return {"success": True, "message": f"{port} 연결됨 ({baudrate} bps)"}
        except Exception as e:
            return {"success": False, "message": str(e)}


def _at_close(port: str) -> dict:
    with _serial_lock:
        if port in _serial_conns:
            try:
                _serial_conns[port].close()
                del _serial_conns[port]
                return {"success": True, "message": f"{port} 닫힘"}
            except Exception as e:
                return {"success": False, "message": str(e)}
        return {"success": False, "message": f"{port} 열려있지 않음"}


def _at_send(port: str, command: str, timeout: float = AT_TIMEOUT) -> dict:
    with _serial_lock:
        ser = _serial_conns.get(port)
        if not ser or not ser.is_open:
            return {"success": False, "response": f"{port} 포트가 열려있지 않습니다."}
    try:
        ser.reset_input_buffer()
        ser.write((command.strip() + "\r\n").encode())
        deadline = time.time() + timeout
        lines = []
        while time.time() < deadline:
            if ser.in_waiting:
                line = ser.readline().decode("utf-8", errors="replace").strip()
                if line:
                    lines.append(line)
                    if line in ("OK", "ERROR", "NO CARRIER", "BUSY") \
                       or line.startswith("+CME ERROR") \
                       or line.startswith("+CMS ERROR"):
                        break
            else:
                time.sleep(0.01)
        return {"success": True, "response": "\n".join(lines) or "(응답 없음)"}
    except Exception as e:
        return {"success": False, "response": str(e)}


def _push_ports():
    sio.emit("port_update", {
        "ports": _at_list_ports(),
        "open": _at_open_ports(),
    })


# ── Logcat streaming ─────────────────────────────────────────────────

def _logcat_start(serial: str, args: str, browser_sid: str):
    global _logcat_stop, _logcat_thread
    _logcat_stop_fn()

    stop = threading.Event()
    _logcat_stop = stop

    def _run():
        cmd = [ADB_PATH, "-s", serial, "logcat"]
        if args:
            cmd += shlex.split(args)
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace")
            while not stop.is_set():
                line = proc.stdout.readline()
                if not line:
                    break
                sio.emit("logcat_line", {"line": line.rstrip()})
            proc.terminate()
        except Exception as e:
            sio.emit("logcat_line", {"line": f"[ERROR] {e}"})

    _logcat_thread = threading.Thread(target=_run, daemon=True)
    _logcat_thread.start()


def _logcat_stop_fn():
    global _logcat_stop
    if _logcat_stop:
        _logcat_stop.set()
        _logcat_stop = None


# ── Log file streaming ───────────────────────────────────────────────

def _log_start(serial: str, path: str, browser_sid: str):
    global _log_stop, _log_thread
    _log_stop_fn()

    stop = threading.Event()
    _log_stop = stop

    def _run():
        cmd = [ADB_PATH, "-s", serial, "shell", "tail", "-f", path]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace")
            while not stop.is_set():
                line = proc.stdout.readline()
                if not line:
                    break
                sio.emit("log_line", {"line": line.rstrip(), "source": "log"})
            proc.terminate()
        except Exception as e:
            sio.emit("log_line", {"line": f"[ERROR] {e}", "source": "log"})

    _log_thread = threading.Thread(target=_run, daemon=True)
    _log_thread.start()


def _log_stop_fn():
    global _log_stop
    if _log_stop:
        _log_stop.set()
        _log_stop = None


# ── kmsg streaming ───────────────────────────────────────────────────

def _kmsg_start(serial: str, browser_sid: str):
    global _kmsg_stop, _kmsg_thread
    _kmsg_stop_fn()

    stop = threading.Event()
    _kmsg_stop = stop

    def _run():
        cmd = [ADB_PATH, "-s", serial, "shell", "dmesg"]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace")
            while not stop.is_set():
                line = proc.stdout.readline()
                if not line:
                    break
                sio.emit("log_line", {"line": line.rstrip(), "source": "kmsg"})
            proc.terminate()
        except Exception as e:
            sio.emit("log_line", {"line": f"[ERROR] {e}", "source": "kmsg"})

    _kmsg_thread = threading.Thread(target=_run, daemon=True)
    _kmsg_thread.start()


def _kmsg_stop_fn():
    global _kmsg_stop
    if _kmsg_stop:
        _kmsg_stop.set()
        _kmsg_stop = None


# ── Log upload ───────────────────────────────────────────────────────

def _do_log_upload(serial: str, port: str, browser_sid: str):
    """백그라운드: dmesg / /data/logs/* / /var/log/messages 수집 후 서버로 전송."""
    files  = {}
    errors = []

    # 0. 전화번호 / IMEI 취득
    r = _adb_shell(serial, "cat /var/tmp/phone_number", timeout=5)
    phone = r.get("stdout", "").strip().replace("+", "").replace("-", "").replace(" ", "") \
            if r["success"] else ""
    if not phone:
        phone = "unknown"

    r = _adb_shell(serial, "cat /var/tmp/imei", timeout=5)
    imei = r.get("stdout", "").strip() if r["success"] else ""
    if not imei:
        imei = "unknown"

    print(f"[agent] log_upload: 전화번호={phone}  IMEI={imei}")

    # 1. dmesg
    print("[agent] log_upload: dmesg 수집 중...")
    r = _adb_shell(serial, "dmesg", timeout=60)
    if r["success"]:
        files["dmesg.log"] = r["stdout"]
    else:
        errors.append("dmesg: " + r.get("stderr", "실패"))

    # 2. /data/logs/ 파일 목록 (재귀, 최대 깊이 3)
    print("[agent] log_upload: /data/logs 수집 중...")
    r = _adb_shell(serial,
                   "find /data/logs -maxdepth 3 -type f 2>/dev/null",
                   timeout=15)
    if r["success"]:
        for fpath in r["stdout"].splitlines():
            fpath = fpath.strip()
            if not fpath:
                continue
            # /data/logs/sub/file → data_logs_sub_file
            rel = fpath.lstrip("/").replace("/", "_")
            r2 = _adb_shell(serial, f"cat '{fpath}'", timeout=60)
            if r2["success"]:
                files[f"data_logs/{rel}"] = r2["stdout"]
            else:
                errors.append(f"{fpath}: " + r2.get("stderr", "실패"))
    else:
        errors.append("/data/logs: " + r.get("stderr", "목록 조회 실패"))

    # 3. /var/log/messages
    print("[agent] log_upload: /var/log/messages 수집 중...")
    r = _adb_shell(serial, "cat /var/log/messages", timeout=60)
    if r["success"]:
        files["var_log_messages.log"] = r["stdout"]
    else:
        errors.append("/var/log/messages: " + r.get("stderr", "실패"))

    print(f"[agent] log_upload: {len(files)}개 파일 수집 완료, 서버 전송 중...")
    sio.emit("log_upload_data", {
        "browser_sid": browser_sid,
        "device":      serial,
        "phone":       phone,
        "imei":        imei,
        "files":       files,
        "errors":      errors,
    })


# ── 유효기간 확인 ────────────────────────────────────────────────────

def _check_expiry():
    """EXPIRE_DATE 를 지났으면 안내 후 종료."""
    import datetime as _dt
    try:
        expire = _dt.date.fromisoformat(EXPIRE_DATE)
    except Exception:
        return  # 날짜 파싱 실패 시 무시
    today = _dt.date.today()
    if today > expire:
        print("=" * 50)
        print("  RemoteDiag Agent")
        print("=" * 50)
        print()
        print(f"  ※ 사용 기한이 만료되었습니다.")
        print(f"     만료일: {EXPIRE_DATE}")
        print(f"     오늘  : {today}")
        print()
        print("  관리자에게 문의하세요.")
        print()
        try:
            input("  Enter 키를 누르면 종료합니다...")
        except Exception:
            pass
        sys.exit(0)


# ── Main ─────────────────────────────────────────────────────────────

def main():
    _check_expiry()
    _setup_signals()

    print("=" * 50)
    print("  RemoteDiag Agent")
    print("=" * 50)
    print(f"  서버  : {SERVER_URL}")
    print(f"  기한  : {EXPIRE_DATE}")
    print("=" * 50)
    print()

    while not _shutdown.is_set():
        try:
            if sio.connected:
                sio.disconnect()
        except Exception:
            pass
        try:
            print(f"[agent] 서버 연결 중: {SERVER_URL}")
            sio.connect(SERVER_URL, transports=["websocket"])
            while sio.connected and not _shutdown.is_set():
                time.sleep(0.3)
        except Exception as e:
            if _shutdown.is_set():
                break
            print(f"[agent] 연결 실패: {e}. 3초 후 재시도...")
            for _ in range(30):
                if _shutdown.is_set():
                    break
                time.sleep(0.1)

    try:
        if sio.connected:
            sio.disconnect()
    except Exception:
        pass
    print("[agent] 종료.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[오류] {e}")
    finally:
        if getattr(sys, "frozen", False):
            input("\nEnter 키를 누르면 닫힙니다.")
