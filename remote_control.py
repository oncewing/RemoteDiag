#!/usr/bin/env python3
"""RemoteDiag 원격 제어 CLI.

접속 코드를 입력하면 해당 에이전트 세션에 원격 제어로 연결됩니다.

사용 예:
  python remote_control.py
  python remote_control.py --server https://support.woori-net.com
  python remote_control.py --local   # Docker 내부 직접 연결
"""

import sys
import argparse
import threading
import socketio

try:
    import readline  # 방향키·백스페이스 지원
except ImportError:
    pass

# ── 기본 설정 ─────────────────────────────────────────────────────────
DEFAULT_SERVER   = "https://support.woori-net.com"
DEFAULT_PATH     = "/remotediag"
LOCAL_SERVER     = "http://127.0.0.1:3004"
LOCAL_PATH       = ""

# ── 전역 상태 ─────────────────────────────────────────────────────────
sio = socketio.Client(logger=False, engineio_logger=False)

_ready_event       = threading.Event()
_request_event     = threading.Event()
_result_event      = threading.Event()
_device_info_event = threading.Event()
_session_active    = False
_ready_ok          = False
_req_username      = ""
_cmd_seq           = 0
_last_result       = {}


def _next_id():
    global _cmd_seq
    _cmd_seq += 1
    return "rc-{}".format(_cmd_seq)


# ── Socket events ──────────────────────────────────────────────────────

@sio.on("disconnect")
def on_disconnect():
    print("\n[원격 제어] 서버 연결 해제")
    _ready_event.set()
    _request_event.set()
    _result_event.set()


@sio.on("controller_ready")
def on_controller_ready(_data=None):
    global _ready_ok
    _ready_ok = True
    _ready_event.set()


@sio.on("controller_error")
def on_controller_error(data):
    global _ready_ok
    msg = data.get("message", str(data)) if isinstance(data, dict) else str(data)
    print("[오류] {}".format(msg))
    _ready_ok = False
    _ready_event.set()


@sio.on("remote_control_request")
def on_rc_request(data):
    global _req_username
    _req_username = data.get("code", data.get("username", "?"))
    _request_event.set()


@sio.on("session_ended")
def on_session_ended(_data=None):
    global _session_active
    _session_active = False
    _result_event.set()
    print("\n[알림] 클라이언트가 세션을 종료했습니다.")


@sio.on("device_info")
def on_device_info(data):
    imei  = data.get("imei",  "N/A")
    phone = data.get("phone", "N/A")
    note  = data.get("note",  "")
    print("─" * 50)
    print("  단말 기본 정보")
    print("─" * 50)
    if note:
        print("  {}".format(note))
    else:
        print("  IMEI    : {}".format(imei))
        print("  전화번호 : {}".format(phone))
    print("─" * 50)
    sys.stdout.flush()
    _device_info_event.set()


@sio.on("remote_result")
def on_remote_result(data):
    global _last_result
    _last_result = data

    if data.get("stdout"):
        sys.stdout.write(data["stdout"].replace("\r", "").rstrip() + "\n")
    if data.get("stderr"):
        sys.stdout.write("[stderr] " + data["stderr"].replace("\r", "").rstrip() + "\n")
    if data.get("response"):
        sys.stdout.write(data["response"].rstrip() + "\n")
    if not data.get("success") and data.get("error"):
        sys.stdout.write("[오류] " + str(data["error"]) + "\n")
    sys.stdout.flush()
    _result_event.set()


# ── Helpers ────────────────────────────────────────────────────────────

def _send(cmd_type, command, timeout=30):
    """명령을 브라우저 클라이언트로 전달하고 결과를 기다린다."""
    _result_event.clear()
    sio.emit("controller_cmd", {
        "type":    cmd_type,
        "command": command,
        "timeout": 10,
        "id":      _next_id(),
    })
    _result_event.wait(timeout=timeout)


# ── Control loop ───────────────────────────────────────────────────────

def run():
    global _session_active, _req_username

    while sio.connected:
        print("원격 제어 요청 대기 중... (Ctrl+C 로 종료)\n")
        _request_event.clear()
        while sio.connected and not _request_event.wait(timeout=0.5):
            pass

        if not sio.connected:
            break

        username = _req_username
        _req_username = ""
        if not username:
            continue

        print("\n" + "=" * 50)
        print("  원격 제어 요청 수신 (접속 코드: {})".format(username))
        print("=" * 50)

        try:
            answer = input("수락하시겠습니까? (y/N): ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            break

        if answer != "y":
            print("거절했습니다.\n")
            continue

        _device_info_event.clear()
        sio.emit("controller_accept", {})
        _session_active = True

        # 단말 기본 정보 수신 대기 (최대 5초)
        _device_info_event.wait(timeout=5)

        print("\n명령 입력 방법:")
        print("  AT 명령  : AT+CSQ  또는  +CSQ  (AT 접두사 자동 추가)")
        print("  Shell    : .sh ifconfig")
        print("  종료     : .exit\n")

        while _session_active and sio.connected:
            try:
                line = input("rc> ").strip()
            except (EOFError, KeyboardInterrupt):
                sio.emit("controller_end", {})
                _session_active = False
                break

            if not line:
                continue

            if line == ".exit":
                sio.emit("controller_end", {})
                _session_active = False
                print("원격 제어를 종료했습니다.\n")
                break

            elif line.startswith(".sh "):
                cmd = line[4:].strip()
                if cmd:
                    print("$ " + cmd)
                    _send("adb_shell", cmd, timeout=30)

            else:
                cmd = line if line.upper().startswith("AT") else "AT" + line
                print("> " + cmd)
                _send("at_command", cmd, timeout=15)

        _session_active = False
        print("[원격 제어] 다음 요청을 기다립니다...\n")


def main():
    parser = argparse.ArgumentParser(description="RemoteDiag 원격 제어 CLI")
    parser.add_argument("--server", default=DEFAULT_SERVER,
                        help="서버 URL (기본: {})".format(DEFAULT_SERVER))
    parser.add_argument("--path",   default=DEFAULT_PATH,
                        help="nginx 경로 접두사 (기본: {})".format(DEFAULT_PATH))
    parser.add_argument("--local",  action="store_true",
                        help="로컬 서버 직접 연결 — Docker 내부 실행용")
    args = parser.parse_args()

    if args.local:
        server_url  = LOCAL_SERVER
        socket_path = LOCAL_PATH + "/socket.io"
    else:
        server_url  = args.server
        socket_path = args.path + "/socket.io"

    print("=" * 50)
    print("  RemoteDiag 원격 제어")
    print("  서버: {}".format(server_url))
    print("=" * 50 + "\n")

    try:
        access_code = input("접속 코드: ").strip().upper()
        if not access_code:
            print("[오류] 접속 코드를 입력하세요.")
            sys.exit(1)
    except (EOFError, KeyboardInterrupt):
        sys.exit(0)

    try:
        print("\n서버에 연결 중...")
        conn_err = [None]

        def _do_connect():
            try:
                sio.connect(server_url, transports=["websocket"], socketio_path=socket_path)
            except Exception as e:
                conn_err[0] = e

        t = threading.Thread(target=_do_connect, daemon=True)
        t.start()
        t.join(timeout=10)

        if conn_err[0]:
            raise conn_err[0]
        if not sio.connected:
            print("[오류] 연결 시간 초과. 서버가 실행 중인지 확인하세요.")
            sys.exit(1)

        _ready_event.clear()
        sio.emit("controller_hello", {"code": access_code})

        if not _ready_event.wait(timeout=5):
            print("[오류] 서버 응답 없음.")
            sys.exit(1)

        if not _ready_ok or not sio.connected:
            sys.exit(1)

        print("서버 등록 완료. 원격 제어 요청 대기 중...\n")
        run()

    except KeyboardInterrupt:
        pass
    except Exception as e:
        print("[오류] {}".format(e))
        sys.exit(1)
    finally:
        if sio.connected:
            sio.disconnect()
        print("종료합니다.")


if __name__ == "__main__":
    main()
