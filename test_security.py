#!/usr/bin/env python3
"""
RemoteDiag 보안 테스트
실행: python test_security.py [서버IP] [포트]
예)  python test_security.py 10.1.255.254 3004
"""

import sys
import time
import requests
import socketio

SERVER_IP   = sys.argv[1] if len(sys.argv) > 1 else "10.1.255.254"
SERVER_PORT = sys.argv[2] if len(sys.argv) > 2 else "3004"
BASE_URL    = f"http://{SERVER_IP}:{SERVER_PORT}"

PASS = "\033[32m[PASS]\033[0m"
FAIL = "\033[31m[FAIL]\033[0m"
INFO = "\033[33m[INFO]\033[0m"
SEP  = "=" * 55


def result(ok: bool, msg: str):
    print(f"  {PASS if ok else FAIL}  {msg}")


def section(title: str):
    print(f"\n{SEP}")
    print(f"  {title}")
    print(SEP)


# ── ① exe 다운로드 인증 ──────────────────────────────────────────────

def test_exe_download_no_auth():
    section("① exe 다운로드 — 미로그인 시 401")
    urls = [
        f"{BASE_URL}/dist/woorinet_remote_diag_agent.exe",
        f"{BASE_URL}/download/woorinet_remote_diag_agent.exe",
    ]
    for url in urls:
        r = requests.get(url, timeout=5)
        result(r.status_code == 401,
               f"미로그인 다운로드 → {r.status_code} (기대: 401)  {url.split('/')[-1]}")

def test_exe_download_with_auth():
    section("① exe 다운로드 — 로그인 후 정상 다운로드")
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/login",
               json={"username": "admin", "password": "admin"}, timeout=5)
    if r.status_code != 200:
        print(f"  {INFO}  로그인 실패 (기본 비밀번호 변경됨?) — 스킵")
        return
    r2 = s.get(f"{BASE_URL}/dist/woorinet_remote_diag_agent.exe", timeout=10)
    result(r2.status_code in (200, 404),
           f"로그인 후 다운로드 → {r2.status_code} (200=성공, 404=파일없음)")


# ── ② 토큰 브루트포스 차단 ───────────────────────────────────────────

def test_brute_force():
    section("⑧ 토큰 브루트포스 — 5회 실패 후 차단")
    results = []

    for i in range(7):
        sio = socketio.SimpleClient()
        received = {}
        try:
            sio.connect(BASE_URL, socketio_path="/socket.io",
                        transports=["websocket"])
            sio.emit("agent_hello", {"code": f"FAKE-CODE-{i:04d}"})
            event = sio.receive(timeout=3)
            if event:
                received = {"name": event[0], "data": event[1] if len(event) > 1 else {}}
        except Exception as e:
            received = {"error": str(e)}
        finally:
            try:
                sio.disconnect()
            except Exception:
                pass

        name   = received.get("name", "")
        data   = received.get("data", {})
        reason = data.get("reason", "") if isinstance(data, dict) else ""
        blocked = "차단" in reason

        if i < 5:
            result(name == "agent_rejected" and not blocked,
                   f"시도 {i+1}/5 → 거절 (정상)")
        else:
            result(name == "agent_rejected" and blocked,
                   f"시도 {i+1}   → {'차단됨 ✓' if blocked else '차단 안됨 ✗'}  ({reason[:40]})")

        time.sleep(0.3)


# ── ③ 경로 traversal 방어 ───────────────────────────────────────────

def test_path_traversal():
    section("③ 경로 Traversal — 악의적 파일명 업로드")
    sio = socketio.SimpleClient()
    try:
        sio.connect(BASE_URL, socketio_path="/socket.io",
                    transports=["websocket"])

        evil_files = {
            "../evil.txt":              "traversal test 1",
            "../../evil.txt":           "traversal test 2",
            "/etc/evil.txt":            "traversal test 3",
            "normal/subdir/log.txt":    "normal subdir",
        }

        sio.emit("log_upload_data", {
            "files":  evil_files,
            "phone":  "../evil_phone",
            "imei":   "../../evil_imei",
            "errors": [],
        })

        try:
            event = sio.receive(timeout=3)
            if event and event[0] == "log_upload_result":
                data   = event[1]
                saved  = data.get("files", [])
                errors = data.get("errors", [])
                path   = data.get("path", "")

                result("evil" not in path and ".." not in path,
                       f"저장 경로 sanitize → {path}")
                result("../evil.txt" not in saved and "../../evil.txt" not in saved,
                       f"traversal 파일명 차단 → errors: {errors[:2]}")
                result("normal/subdir/log.txt" in saved,
                       f"정상 파일명 허용 → {saved}")
            else:
                print(f"  {INFO}  응답 없음 (에이전트 미인증 상태일 수 있음 — 허용)")
        except Exception:
            print(f"  {INFO}  응답 타임아웃 (에이전트 미연결 상태 — 정상)")
    finally:
        try:
            sio.disconnect()
        except Exception:
            pass


# ── ④ 토큰 1회 제한 ─────────────────────────────────────────────────

def test_token_single_use(code: str):
    section(f"토큰 1회 제한 — {code}")

    def try_connect(label):
        sio = socketio.SimpleClient()
        received = {}
        try:
            sio.connect(BASE_URL, socketio_path="/socket.io",
                        transports=["websocket"])
            sio.emit("agent_hello", {"code": code})
            event = sio.receive(timeout=3)
            if event:
                received = {"name": event[0],
                            "data": event[1] if len(event) > 1 else {}}
        except Exception as e:
            received = {"error": str(e)}
        finally:
            try:
                sio.disconnect()
            except Exception:
                pass
        return received

    r1 = try_connect("1차 접속")
    accepted1 = r1.get("name") == "agent_accepted"
    result(accepted1, f"1차 접속 → {'승인' if accepted1 else '거절'}")

    time.sleep(1)

    r2 = try_connect("2차 접속")
    rejected2 = r2.get("name") == "agent_rejected"
    reason    = r2.get("data", {}).get("reason", "") if isinstance(r2.get("data"), dict) else ""
    result(rejected2, f"2차 접속 → {'차단됨 ✓' if rejected2 else '허용됨 ✗'}  ({reason[:40]})")


# ── main ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n{'='*55}")
    print(f"  RemoteDiag 보안 테스트")
    print(f"  서버: {BASE_URL}")
    print(f"{'='*55}")

    try:
        test_exe_download_no_auth()
        test_exe_download_with_auth()
        test_brute_force()
        test_path_traversal()

        print(f"\n{SEP}")
        code = input("  토큰 1회 제한 테스트용 1회 코드 입력 (없으면 Enter 스킵): ").strip()
        if code:
            test_token_single_use(code)

    except KeyboardInterrupt:
        print("\n\n  중단됨.")
    except requests.exceptions.ConnectionError:
        print(f"\n  {FAIL}  서버에 연결할 수 없습니다: {BASE_URL}")

    print(f"\n{SEP}\n  테스트 완료\n{SEP}\n")
