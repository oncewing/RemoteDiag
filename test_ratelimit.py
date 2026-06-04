#!/usr/bin/env python3
"""
토큰 브루트포스 Rate Limit 테스트
실행: python test_ratelimit.py [서버IP] [포트]
예)  python test_ratelimit.py 10.1.255.254 3004
"""

import sys
import time
import socketio

SERVER_IP   = sys.argv[1] if len(sys.argv) > 1 else "10.1.255.254"
SERVER_PORT = sys.argv[2] if len(sys.argv) > 2 else "3004"
BASE_URL    = f"http://{SERVER_IP}:{SERVER_PORT}"


def try_code(code: str) -> dict:
    """서버에 agent_hello 전송 후 응답 반환."""
    sio = socketio.SimpleClient()
    try:
        sio.connect(BASE_URL, socketio_path="/socket.io", transports=["websocket"])
        sio.emit("agent_hello", {"code": code})
        event = sio.receive(timeout=3)
        if event:
            return {"event": event[0], "data": event[1] if len(event) > 1 else {}}
        return {"event": "timeout", "data": {}}
    except Exception as e:
        return {"event": "error", "data": {"reason": str(e)}}
    finally:
        try:
            sio.disconnect()
        except Exception:
            pass


def main():
    print(f"\n{'='*52}")
    print(f"  Rate Limit 테스트  |  {BASE_URL}")
    print(f"  설정: 5회 실패 → 5분 차단")
    print(f"{'='*52}\n")

    for i in range(1, 10):
        code = f"FAKE-TEST-{i:04d}"
        t0   = time.time()
        res  = try_code(code)
        elapsed = time.time() - t0

        event  = res["event"]
        reason = res["data"].get("reason", "") if isinstance(res["data"], dict) else ""

        if event == "agent_accepted":
            status = "\033[32m승인\033[0m"
        elif "차단" in reason:
            status = "\033[31m차단됨\033[0m"
        elif event == "agent_rejected":
            status = "\033[33m거절\033[0m"
        else:
            status = f"\033[90m{event}\033[0m"

        print(f"  [{i:02d}] {code}  →  {status}  ({elapsed:.2f}s)")
        if reason:
            print(f"        └ {reason}")

        if "차단" in reason:
            print(f"\n  \033[32m[PASS]\033[0m IP 차단 정상 동작 확인 ({i}번째 시도에서 차단)\n")
            break

        time.sleep(0.2)
    else:
        print(f"\n  \033[31m[FAIL]\033[0m 9회 시도 후에도 차단되지 않음\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n  중단됨.\n")
    except Exception as e:
        print(f"\n  연결 실패: {e}\n")
