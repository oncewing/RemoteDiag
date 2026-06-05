#!/usr/bin/env python3
"""
RemoteDiag Agent - Windows side
단말기가 연결된 Windows PC에서 실행. 서버에 WebSocket으로 연결하여 명령 수행.
"""

import datetime
import os
import platform
import re
import shlex
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

import serial
import serial.tools.list_ports
import socketio as sio_module

# ── 빌드 시 설정값 ───────────────────────────────────────────────────
SERVER_URL         = "wss://support.woori-net.com"   # 빌드 시 서버 주소 고정 (nginx SSL)
SERVER_SOCKET_PATH = "/remotediag/socket.io"
EXPIRE_DATE        = ""          # 비워두면 빌드 시 자동으로 빌드일+1개월 적용

ACCESS_CODE = ""   # 실행 시 사용자 입력

ADB_PATH = "adb"
AT_TIMEOUT = 5
AT_BAUDRATE = 115200

SRSD_PORT    = 5002        # SRSD daemon UDP 포트
SRSD_CMD_AT    = 2
SRSD_CMD_SHELL = 102
_SRSD_PROVIDER = b'woorinet\x00\x00\x00\x00\x00\x00\x00\x00'  # 16 bytes

_serial_conns = {}
_serial_lock = threading.Lock()

_logcat_stop: threading.Event | None = None
_logcat_thread: threading.Thread | None = None

_log_stop: threading.Event | None = None
_log_thread: threading.Thread | None = None

_kmsg_stop: threading.Event | None = None
_kmsg_thread: threading.Thread | None = None

_shutdown = threading.Event()
_session_end_time: float = 0.0
_countdown_stop: threading.Event | None = None

sio = sio_module.Client(ssl_verify=True, reconnection=False)


# ── 만료일 검사 (네트워크 시간 기준) ────────────────────────────────

_NTP_DELTA = 2208988800   # 1900-01-01 ~ 1970-01-01 초 차이

def _get_ntp_time(host: str, timeout: int = 5) -> datetime.date | None:
    """NTP 서버에서 현재 날짜 취득 (외부 라이브러리 불필요)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(b"\x1b" + 47 * b"\0", (host, 123))
            msg, _ = s.recvfrom(1024)
        t = struct.unpack("!12I", msg)[10] - _NTP_DELTA
        return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).date()
    except Exception:
        return None


def _get_http_time() -> datetime.date | None:
    """HTTPS 응답의 Date 헤더로 현재 날짜 취득 (NTP 실패 시 폴백)."""
    import calendar
    from email.utils import parsedate
    import urllib.request
    for url in ("https://www.google.com", "https://www.cloudflare.com"):
        try:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=7) as r:
                date_str = r.headers.get("Date", "")
                t = calendar.timegm(parsedate(date_str))
                return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).date()
        except Exception:
            continue
    return None


def _check_expiry():
    """네트워크 시간 기준으로 만료일 검사.
    - EXPIRE_DATE 가 비어 있으면 빌드 배트에서 주입되지 않은 개발 실행으로 간주, 검사 생략.
    - 만료됐거나 시간 서버에 연결할 수 없으면 프로그램 종료.
    """
    if not EXPIRE_DATE:
        print("[agent] 만료일 미설정 — 개발 모드로 실행 (만료 검사 생략)")
        return

    _NTP_HOSTS = [
        "pool.ntp.org",
        "time.google.com",
        "time.cloudflare.com",
        "time.windows.com",
    ]
    print("[agent] 시간 서버 확인 중...")
    today = None
    for host in _NTP_HOSTS:
        today = _get_ntp_time(host)
        if today:
            break

    if today is None:
        today = _get_http_time()

    if today is None:
        print("[오류] 시간 서버에 연결할 수 없습니다. 실행이 불가합니다.")
        sys.exit(1)

    expire = datetime.date.fromisoformat(EXPIRE_DATE)
    if today > expire:
        print(f"[오류] 이 버전은 {EXPIRE_DATE}에 만료되었습니다.")
        print("       새 버전을 다운로드하세요.")
        sys.exit(1)

    remaining = (expire - today).days
    if remaining <= 30:
        print(f"[agent] 현재 날짜  : {today}  /  사용 만료일: {EXPIRE_DATE}  ※ {remaining}일 후 만료됩니다.")
    else:
        print(f"[agent] 현재 날짜  : {today}  /  사용 만료일: {EXPIRE_DATE}")


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
        "code":     ACCESS_CODE,
        "platform": platform.system(),
        "node":     platform.node(),
        "python":   platform.python_version(),
        "ip":       socket.gethostbyname(socket.gethostname()),
    })

@sio.event
def disconnect():
    print("[agent] 서버 연결 끊김.")

@sio.event
def connect_error(data):
    msg = data.get("message", data) if isinstance(data, dict) else data
    print(f"[agent] 연결 오류: {msg}")

def _start_countdown(remaining_sec: int):
    """세션 남은 시간 주기적 표시.
    10분 초과  : 10분 단위 표시
    10분 ~ 1분 : 1분 단위 표시
    1분 ~ 10초 : 10초 단위 표시
    10초 이하  : 초 단위 표시
    """
    global _session_end_time, _countdown_stop

    # 이전 카운트다운 스레드 중단 (재접속 시 중복 방지)
    if _countdown_stop:
        _countdown_stop.set()

    stop = threading.Event()
    _countdown_stop = stop
    _session_end_time = time.time() + remaining_sec

    def _fmt(rem: int) -> str:
        if rem >= 60:
            return f"{(rem + 59) // 60}분"   # 올림: 11분59초 → 12분, 11분00초 → 11분
        return f"{rem}초"

    def _interval(rem: int) -> int:
        """다음 출력까지 대기할 초."""
        if rem > 600:          # 10분 초과 → 다음 10분 경계까지
            return rem % 600 or 600
        elif rem > 60:         # 10분 ~ 1분 → 다음 분 경계까지
            return rem % 60 or 60
        elif rem > 10:         # 1분 ~ 10초 → 다음 10초 경계까지
            return rem % 10 or 10
        else:                  # 10초 이하 → 1초씩
            return 1

    def _run():
        last_display = ""
        while not _shutdown.is_set() and not stop.is_set() and sio.connected:
            rem = int(_session_end_time - time.time())
            if rem <= 0:
                break
            msg = _fmt(rem)
            if msg != last_display:
                print(f"[agent] 세션 만료까지: {msg}")
                last_display = msg
            # 짧은 간격으로 쪼개서 대기 — stop 이벤트 빠르게 감지
            wait = _interval(rem)
            for _ in range(wait):
                if stop.is_set() or _shutdown.is_set():
                    return
                time.sleep(1)

    threading.Thread(target=_run, daemon=True).start()


@sio.on("agent_accepted")
def on_agent_accepted(data):
    minutes = data.get("expires_in_minutes", 0)
    expiry  = data.get("expiry_date", "")
    UNLIMITED = 99999
    if minutes >= UNLIMITED:
        print(f"[agent] 접속 승인  —  세션: 무제한  /  사용 만료일: {expiry}")
    else:
        print(f"[agent] 접속 승인  —  세션: {minutes}분  /  사용 만료일: {expiry}")
        _start_countdown(minutes * 60)
    # 승인 확인 후 기기·포트 정보 전송 (connect()에서 호출 시 거부 직후 disconnect로 예외 발생 방지)
    try:
        _push_devices()
        _push_ports()
    except Exception:
        pass

@sio.on("agent_rejected")
def on_agent_rejected(data):
    reason = data.get("reason", "알 수 없는 오류")
    print()
    print("=" * 50)
    print("  접속 거부")
    print(f"  {reason}")
    print("=" * 50)
    _shutdown.set()

@sio.on("agent_kicked")
def on_agent_kicked(data):
    reason = data.get("reason", "세션이 종료되었습니다.")
    print()
    print("=" * 50)
    print("  세션 종료")
    print(f"  {reason}")
    print("=" * 50)
    _shutdown.set()


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

        elif cmd_type == "at_match_device":
            result.update(_at_match_device(data["port"]))

        elif cmd_type == "srsd_at":
            result.update(_srsd_at(
                data["ip"], int(data.get("port", SRSD_PORT)),
                data["command"], float(data.get("timeout", 10))))

        elif cmd_type == "srsd_shell":
            result.update(_srsd_shell(
                data["ip"], int(data.get("port", SRSD_PORT)),
                data["command"], float(data.get("timeout", 30))))

        elif cmd_type == "srsd_discover":
            ips = _srsd_discover(int(data.get("port", SRSD_PORT)))
            result["data"]    = ips
            result["success"] = True

        elif cmd_type == "srsd_log_upload":
            t = threading.Thread(
                target=_do_log_upload,
                kwargs={
                    "serial":    "",
                    "port":      "",
                    "browser_sid": browser_sid,
                    "srsd_ip":   data["ip"],
                    "srsd_port": int(data.get("port", SRSD_PORT)),
                },
                daemon=True,
            )
            t.start()
            result["success"] = True
            result["message"] = "로그 수집 시작됨"

        elif cmd_type == "log_upload":
            t = threading.Thread(
                target=_do_log_upload,
                args=(data["serial"], data.get("port", ""), browser_sid),
                daemon=True,
            )
            t.start()
            result["success"] = True
            result["message"] = "로그 수집 시작됨"

        elif cmd_type == "kmsg_upload":
            t = threading.Thread(
                target=_do_kmsg_upload,
                args=(data["serial"], browser_sid),
                daemon=True,
            )
            t.start()
            result["success"] = True
            result["message"] = "kmsg 수집 시작됨"

        elif cmd_type == "srsd_kmsg_upload":
            t = threading.Thread(
                target=_do_kmsg_upload,
                kwargs={
                    "serial":      "",
                    "browser_sid": browser_sid,
                    "srsd_ip":     data["ip"],
                    "srsd_port":   int(data.get("port", SRSD_PORT)),
                },
                daemon=True,
            )
            t.start()
            result["success"] = True
            result["message"] = "kmsg 수집 시작됨"

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
        response = "\n".join(lines) or "(응답 없음)"
        return {"success": True, "response": response}
    except Exception as e:
        print(f"[AT] {port} 오류: {e}")
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


# ── Port ↔ Device IMEI 매칭 ─────────────────────────────────────────

def _at_match_device(port: str) -> dict:
    """AT 포트의 IMEI(AT+CGSN)와 ADB 단말기의 IMEI(cat /var/tmp/imei)를 비교하여 매칭."""
    # 1. AT+CGSN으로 IMEI 획득
    r = _at_send(port, "AT+CGSN", timeout=5)
    m = re.search(r'\d{14,15}', r.get("response", ""))
    if not m:
        print(f"[agent] {port} IMEI 조회 실패")
        return {"success": False, "error": "AT+CGSN IMEI 조회 실패", "serial": None}
    at_imei = m.group()

    # 2. 연결된 ADB 단말기 IMEI와 비교
    devices = _adb_devices()
    print(f"[agent] {port} IMEI={at_imei} / ADB 단말기 {len(devices)}개 확인 중...")
    for device in devices:
        if device.get("status") != "device":
            continue
        r2 = _adb_shell(device["serial"], "cat /var/tmp/imei", timeout=5)
        adb_imei = r2.get("stdout", "").strip()
        if adb_imei and adb_imei == at_imei:
            print(f"[agent] 매칭 성공: {port} ↔ {device['serial']} (IMEI: {at_imei})")
            return {"success": True, "serial": device["serial"], "imei": at_imei}

    print(f"[agent] {port} 매칭 실패 (ADB 단말기 없음)")
    return {"success": False, "error": "매칭 단말기 없음",
            "serial": None, "imei": at_imei}


# ── SRSD 네트워크 프로토콜 ───────────────────────────────────────────
#
# Frame 구조:
#   [4] frame_length  [16] provider  [16] secure  [2] command  [4] payload_size
#   [n] payload  [2] crc16
# Header 합계 42 bytes.  frame_length = 42 + payload_size + 2.
# CRC16 범위: frame_length ~ payload 전체.


def _srsd_secure() -> bytes:
    """고정 Secure Code — 16 bytes (null padding)."""
    return b"W35337396126969\x00"


def _srsd_crc16(data: bytes) -> bytes:
    """C GenCRC16 함수와 동일한 CRC16 계산 (little-endian 2 bytes 반환)."""
    if not data:
        return bytes([ord("0"), ord("0")])
    wCRC = 0xFFFF
    for byte in data:
        ch = (byte ^ (wCRC & 0xFF)) & 0xFF
        ch = (ch ^ ((ch << 4) & 0xFF)) & 0xFF
        wCRC = ((wCRC >> 8) ^
                ((ch << 8) & 0xFFFF) ^
                ((ch << 3) & 0xFFFF) ^
                (ch >> 4)) & 0xFFFF
    wCRC = (~wCRC) & 0xFFFF
    return bytes([wCRC & 0xFF, (wCRC >> 8) & 0xFF])


def _srsd_build_frame(command: int, payload: bytes) -> bytes:
    """SRSD 요청 프레임 생성."""
    payload_size = len(payload)
    frame_length = 42 + payload_size + 2
    header = (struct.pack("<I", frame_length) +
               _SRSD_PROVIDER +
               _srsd_secure() +
               struct.pack("<H", command) +
               struct.pack("<I", payload_size))
    crc = _srsd_crc16(header + payload)
    return header + payload + crc


def _srsd_send_recv(ip: str, port: int, command: int,
                    payload: bytes, timeout: float = 10.0) -> bytes:
    """UDP 소켓으로 SRSD 프레임을 전송하고 응답을 수신.
    응답이 여러 UDP 패킷으로 분할될 수 있으므로 frame_length 기준으로 누적 수신."""
    frame = _srsd_build_frame(command, payload)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.sendto(frame, (ip, port))
        resp     = b""
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                chunk, _ = sock.recvfrom(65535)
                resp += chunk
                # 응답 헤더의 frame_length 에 도달하면 수신 완료
                if len(resp) >= 4:
                    expected = struct.unpack("<I", resp[:4])[0]
                    if len(resp) >= expected:
                        break
            except socket.timeout:
                break
        return resp
    finally:
        sock.close()


_SRSD_ERRORS = {
    "PROVIDER ERROR", "SECURE CODE ERROR", "CRC ERROR",
    "UNSUPPORTED", "INVALID ARGUMENT", "INTERNAL ERROR",
}

def _srsd_parse(data: bytes, cmd_type: str) -> dict:
    """응답 프레임 payload 추출 및 SRSD 오류 판별."""
    if len(data) < 42:
        return {"success": False,
                "error": f"응답 데이터 부족 ({len(data)} bytes)",
                "response": "", "stdout": "", "stderr": ""}
    try:
        payload_size = struct.unpack("<I", data[38:42])[0]
        text = data[42:42 + payload_size].decode("utf-8", errors="replace").strip()

        # SRSD 데몬 오류 응답 확인
        if text in _SRSD_ERRORS:
            return {"success": False, "error": text,
                    "response": text, "stdout": "", "stderr": text}

        if cmd_type == "at":
            return {"success": True, "response": text}
        return {"success": True, "stdout": text, "stderr": ""}
    except Exception as e:
        return {"success": False, "error": str(e),
                "response": "", "stdout": "", "stderr": ""}


def _srsd_at(ip: str, port: int, command: str, timeout: float = 10.0) -> dict:
    """SRSD 네트워크를 통해 AT 명령을 전송하고 응답을 반환."""
    payload = command.strip().encode("ascii")
    try:
        resp = _srsd_send_recv(ip, port, SRSD_CMD_AT, payload, timeout)
        return _srsd_parse(resp, "at")
    except socket.timeout:
        return {"success": False, "error": "응답 시간 초과", "response": ""}
    except ConnectionRefusedError:
        return {"success": False, "error": f"{ip}:{port} 연결 거부됨", "response": ""}
    except OSError as e:
        return {"success": False, "error": str(e), "response": ""}


def _srsd_shell(ip: str, port: int, command: str, timeout: float = 30.0) -> dict:
    """SRSD 네트워크를 통해 Shell 명령을 전송하고 출력을 반환."""
    payload = command.strip().encode("utf-8")
    try:
        resp = _srsd_send_recv(ip, port, SRSD_CMD_SHELL, payload, timeout)
        return _srsd_parse(resp, "shell")
    except socket.timeout:
        return {"success": False, "error": "응답 시간 초과", "stdout": "", "stderr": ""}
    except ConnectionRefusedError:
        return {"success": False, "error": f"{ip}:{port} 연결 거부됨", "stdout": "", "stderr": ""}
    except OSError as e:
        return {"success": False, "error": str(e), "stdout": "", "stderr": ""}


def _srsd_discover(port: int) -> list:
    """로컬 네트워크 인터페이스를 분석하여 응답하는 단말기 IP 목록을 병렬로 탐색."""
    candidates: set[str] = set()

    try:
        # ipconfig /all — 바이트로 수신 후 CP949(한글 Windows) → UTF-8 순으로 디코딩
        raw = subprocess.run(
            ["ipconfig", "/all"], capture_output=True, timeout=10
        ).stdout
        for enc in ("cp949", "utf-8"):
            try:
                out = raw.decode(enc)
                break
            except Exception:
                out = raw.decode("utf-8", errors="replace")

        # 게이트웨이 주소 (영문 / 한글)
        for pat in [r"Default Gateway[^:]*:\s*([\d.]+)",
                    r"기본 게이트웨이[^:]*:\s*([\d.]+)"]:
            for m in re.finditer(pat, out):
                gw = m.group(1).strip()
                if gw and gw != "0.0.0.0":
                    candidates.add(gw)

        # 로컬 IPv4 → 같은 /24 서브넷의 .1 주소 추가 (영문 / 한글)
        for pat in [r"IPv4 Address[^:]*:\s*([\d.]+)",
                    r"IPv4 주소[^:]*:\s*([\d.]+)"]:
            for m in re.finditer(pat, out):
                ip = m.group(1).strip().split("(")[0].strip()
                if ip and not ip.startswith("127.") and ip.count(".") == 3:
                    prefix = ".".join(ip.split(".")[:3])
                    candidates.add(prefix + ".1")
                    candidates.add(prefix + ".2")
    except Exception as e:
        print(f"[agent] 탐색 ipconfig 오류: {e}")

    if not candidates:
        print("[agent] 탐색: 후보 IP 없음")
        return []

    print(f"[agent] 탐색 후보: {sorted(candidates)}")

    found: list[str] = []
    lock = threading.Lock()

    def _probe(ip: str):
        r = _srsd_at(ip, port, "AT", timeout=2.0)
        # 에러 문자열이 없는 정상 응답이면 단말기로 판정
        if r.get("success"):
            with lock:
                found.append(ip)
            print(f"[agent] 단말기 발견: {ip}:{port}  응답={r.get('response','')!r}")
        else:
            print(f"[agent] 무응답: {ip}:{port}  오류={r.get('error','')}")

    threads = [threading.Thread(target=_probe, args=(ip,), daemon=True)
               for ip in candidates]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    return found


# ── Log upload ───────────────────────────────────────────────────────

def _do_log_upload(serial: str, port: str, browser_sid: str,
                   srsd_ip: str = "", srsd_port: int = SRSD_PORT):
    """백그라운드: dmesg / /data/logs/* / /var/log/messages 수집 후 서버로 전송.
    srsd_ip 가 있으면 SRSD 네트워크 경로, 없으면 ADB 경로를 사용."""
    if srsd_ip:
        def _shell(cmd, timeout=60): return _srsd_shell(srsd_ip, srsd_port, cmd, timeout)
        device_id = srsd_ip
    else:
        def _shell(cmd, timeout=60): return _adb_shell(serial, cmd, timeout)
        device_id = serial

    files  = {}
    errors = []

    # 0. 전화번호 / IMEI 취득
    r = _shell("cat /var/tmp/phone_number", timeout=5)
    phone = r.get("stdout", "").strip().replace("+", "").replace("-", "").replace(" ", "") \
            if r["success"] else ""
    if not phone:
        phone = "unknown"

    r = _shell("cat /var/tmp/imei", timeout=5)
    imei = r.get("stdout", "").strip() if r["success"] else ""
    if not imei:
        imei = "unknown"

    print(f"[agent] log_upload: 전화번호={phone}  IMEI={imei}  경로={'SRSD' if srsd_ip else 'ADB'}")

    # 1. dmesg
    print("[agent] log_upload: dmesg 수집 중...")
    r = _shell("dmesg", timeout=60)
    if r["success"]:
        files["dmesg.log"] = r["stdout"]
    else:
        errors.append("dmesg: " + r.get("stderr", "실패"))

    # 2. /data/logs/ 파일 목록 (재귀, 최대 깊이 3)
    print("[agent] log_upload: /data/logs 수집 중...")
    r = _shell("find /data/logs -maxdepth 3 -type f 2>/dev/null", timeout=15)
    if r["success"]:
        for fpath in r["stdout"].splitlines():
            fpath = fpath.strip()
            if not fpath:
                continue
            rel = fpath.lstrip("/").replace("/", "_")
            r2 = _shell(f"cat '{fpath}'", timeout=60)
            if r2["success"]:
                files[f"data_logs/{rel}"] = r2["stdout"]
            else:
                errors.append(f"{fpath}: " + r2.get("stderr", "실패"))
    else:
        errors.append("/data/logs: " + r.get("stderr", "목록 조회 실패"))

    # 3. /var/log/messages (최근 20000줄 제한)
    print("[agent] log_upload: /var/log/messages 수집 중...")
    r = _shell("tail -n 20000 /var/log/messages", timeout=60)
    if r["success"]:
        files["var_log_messages.log"] = r["stdout"]
    else:
        errors.append("/var/log/messages: " + r.get("stderr", "실패"))

    print(f"[agent] log_upload: {len(files)}개 파일 수집 완료, 서버 전송 중...")
    sio.emit("log_upload_data", {
        "browser_sid": browser_sid,
        "device":      device_id,
        "phone":       phone,
        "imei":        imei,
        "files":       files,
        "errors":      errors,
    })


def _do_kmsg_upload(serial: str, browser_sid: str,
                    srsd_ip: str = "", srsd_port: int = SRSD_PORT):
    """백그라운드: dmesg(kmsg)만 수집 후 서버로 전송."""
    if srsd_ip:
        def _shell(cmd, timeout=60): return _srsd_shell(srsd_ip, srsd_port, cmd, timeout)
        device_id = srsd_ip
    else:
        def _shell(cmd, timeout=60): return _adb_shell(serial, cmd, timeout)
        device_id = serial

    files  = {}
    errors = []

    # 전화번호 / IMEI 취득
    r = _shell("cat /var/tmp/phone_number", timeout=5)
    phone = r.get("stdout", "").strip().replace("+", "").replace("-", "").replace(" ", "") \
            if r["success"] else "unknown"
    if not phone:
        phone = "unknown"

    r = _shell("cat /var/tmp/imei", timeout=5)
    imei = r.get("stdout", "").strip() if r["success"] else "unknown"
    if not imei:
        imei = "unknown"

    print(f"[agent] kmsg_upload: 전화번호={phone}  IMEI={imei}")

    # dmesg 수집
    print("[agent] kmsg_upload: dmesg 수집 중...")
    r = _shell("dmesg", timeout=60)
    if r["success"]:
        files["kmsg.log"] = r["stdout"]
    else:
        errors.append("dmesg: " + r.get("stderr", "실패"))

    print(f"[agent] kmsg_upload: 서버 전송 중...")
    sio.emit("log_upload_data", {
        "browser_sid": browser_sid,
        "device":      device_id,
        "phone":       phone,
        "imei":        imei,
        "files":       files,
        "errors":      errors,
    })


# ── Main ─────────────────────────────────────────────────────────────

def main():
    global ACCESS_CODE
    _setup_signals()
    _check_expiry()

    print("=" * 50)
    print("  RemoteDiag Agent")
    print("=" * 50)
    print()
    print("  관리자에게 발급받은 접속 코드를 입력하세요.")
    print("  예) AB12-CD34-EF56")
    print()
    try:
        ACCESS_CODE = input("  접속 코드: ").strip().upper()
    except (EOFError, KeyboardInterrupt):
        return

    if not ACCESS_CODE:
        print("\n[agent] 접속 코드가 입력되지 않았습니다. 종료합니다.")
        return

    print()

    while not _shutdown.is_set():
        try:
            if sio.connected:
                sio.disconnect()
        except Exception:
            pass
        try:
            print(f"[agent] 서버 연결 중: {SERVER_URL}")
            sio.connect(SERVER_URL, transports=["websocket"],
                        socketio_path=SERVER_SOCKET_PATH)
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
