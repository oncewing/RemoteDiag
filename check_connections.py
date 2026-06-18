#!/usr/bin/env python3
"""RemoteDiag 현재 연결 상태 확인 도구."""

import json
import sys
import urllib.request
import urllib.error
from datetime import datetime

PORT = 3004
URL  = f"http://127.0.0.1:{PORT}/api/admin/connections"

RESET  = "\033[0m"
BOLD   = "\033[1m"
GREEN  = "\033[92m"
YELLOW = "\033[93m"
RED    = "\033[91m"
CYAN   = "\033[96m"
DIM    = "\033[2m"

def color(text, c): return f"{c}{text}{RESET}"

def main():
    try:
        with urllib.request.urlopen(URL, timeout=3) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError:
        print(color(f"  서버에 연결할 수 없습니다. (포트 {PORT})", RED))
        print(color("  서버가 실행 중인지 확인하세요.", DIM))
        sys.exit(1)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    print()
    print(color("=" * 58, BOLD))
    print(color("  RemoteDiag 연결 상태", BOLD))
    print(color(f"  {now_str}", DIM))
    print(color("=" * 58, BOLD))

    agents        = data.get("agents", [])
    total_agents  = data.get("total_agents", 0)
    total_browsers= data.get("total_browsers", 0)
    total_pending = data.get("total_pending", 0)

    print(f"\n  에이전트: {color(str(total_agents), GREEN if total_agents else DIM)}  "
          f"브라우저: {color(str(total_browsers), CYAN)}  "
          f"대기: {color(str(total_pending), YELLOW if total_pending else DIM)}")
    print()

    if not agents:
        print(color("  연결된 에이전트가 없습니다.", DIM))
    else:
        for i, ag in enumerate(agents, 1):
            code         = ag.get("code", "-")
            ip           = ag.get("ip", "-")
            platform     = ag.get("platform", "-")
            version      = ag.get("version", "-")
            allow_multi  = ag.get("allow_multi", False)
            browsers     = ag.get("browsers", 0)
            pending      = ag.get("pending", 0)
            remaining    = ag.get("remaining_min")
            expiry       = ag.get("expiry", "-")

            multi_str = color("허용", GREEN) if allow_multi else color("거부", DIM)

            if remaining is None:
                rem_str = color("무제한", DIM)
            elif remaining <= 10:
                rem_str = color(f"{remaining}분", RED)
            elif remaining <= 30:
                rem_str = color(f"{remaining}분", YELLOW)
            else:
                rem_str = color(f"{remaining}분", GREEN)

            print(color(f"  [{i}] 접속 코드: {code}", BOLD))
            print(f"      IP        : {ip}  ({platform}  v{version})")
            print(f"      다중 접속 : {multi_str}")
            print(f"      브라우저  : {color(str(browsers), CYAN)}개 연결"
                  + (f"  /  {color(str(pending), YELLOW)}개 대기" if pending else ""))
            print(f"      세션 잔여 : {rem_str}  (만료일: {expiry})")
            print()

    print(color("=" * 58, BOLD))
    print()

    # 자동 갱신 모드
    if "--watch" in sys.argv or "-w" in sys.argv:
        import time
        interval = 5
        print(color(f"  {interval}초마다 자동 갱신 중... (Ctrl+C 종료)\n", DIM))
        try:
            while True:
                time.sleep(interval)
                print("\033[2J\033[H", end="")  # 화면 지우기
                main.__wrapped__()
        except KeyboardInterrupt:
            print("\n  종료.\n")
            sys.exit(0)

main.__wrapped__ = main

if __name__ == "__main__":
    main()
