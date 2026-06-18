#!/usr/bin/env python3
"""
RemoteDiag 접속 코드 관리  (텍스트 메뉴)
실행: python manage_tokens.py
"""

import datetime
import json
import os
import random
import sys
import urllib.request
import urllib.error
from pathlib import Path

TOKENS_FILE = Path(__file__).parent / "tokens.json"
_CHARS = "0123456789"

ALL_PERMISSIONS = ["adb-shell", "adb-info", "at", "logs", "kmsg", "diag", "guide"]
PERM_LABELS = {
    "adb-shell": "ADB Shell",
    "adb-info":  "디바이스 정보",
    "at":        "AT 명령",
    "logs":      "로그 수집",
    "kmsg":      "커널 로그",
    "diag":      "자동점검",
    "guide":     "가이드",
}

# ── 저장소 ──────────────────────────────────────────────────────────────

def _load() -> dict:
    try:
        return json.loads(TOKENS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as e:
        _err(f"tokens.json 읽기 실패: {e}")
        return {}

def _save(tokens: dict):
    TOKENS_FILE.write_text(
        json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8"
    )

def _gen_code() -> str:
    return "".join(random.choices(_CHARS, k=7))

# ── 출력 헬퍼 ───────────────────────────────────────────────────────────

SEP  = "=" * 52
SEP2 = "-" * 52

def _clear():
    os.system("cls" if os.name == "nt" else "clear")

def _header(title: str):
    print(SEP)
    print(f"   RemoteDiag  |  {title}")
    print(SEP)

def _err(msg: str):
    print(f"\n  [오류] {msg}")

def _ok(msg: str):
    print(f"\n  [완료] {msg}")

def _pause():
    input("\n  Enter 키를 누르면 계속합니다...")

# ── 토큰 상태 ───────────────────────────────────────────────────────────

def _status(info: dict) -> str:
    if info.get("used"):
        return "사용완료"
    if info.get("in_use"):
        return "사용중  "
    try:
        if datetime.date.today() > datetime.date.fromisoformat(info["expiry"]):
            return "기간만료"
    except Exception:
        pass
    return "미사용  "

def _status_color(status: str) -> str:
    colors = {
        "미사용  ": "\033[32m",   # 초록
        "사용중  ": "\033[33m",   # 노랑
        "사용완료": "\033[90m",   # 회색
        "시간초과": "\033[90m",   # 회색
        "기간만료": "\033[31m",   # 빨강
    }
    reset = "\033[0m"
    c = colors.get(status, "")
    return f"{c}{status}{reset}" if c else status

# ── 화면: 목록 ──────────────────────────────────────────────────────────

def _show_list(tokens: dict, title="코드 목록"):
    _clear()
    _header(title)
    if not tokens:
        print("\n  등록된 접속 코드가 없습니다.")
        return
    print(f"  {'코드':<16}  {'만료일':<12}  {'시간':>6}  {'횟수':<6}  {'상태':<8}  메모")
    print(f"  {SEP2}")
    for code, info in sorted(tokens.items()):
        st      = _status(info)
        note    = info.get("note", "")
        expiry  = "무기한     " if info["expiry"] == "9999-12-31" else info["expiry"]
        minutes = "무기한" if info["max_minutes"] >= 999999 else f"{info['max_minutes']:>4}분"
        if info.get("unlimited_uses"):
            uses = "무제한"
        else:
            max_u   = info.get("max_uses", 1)
            used_u  = info.get("use_count", 0)
            uses    = f"{used_u}/{max_u}회"
        perms    = info.get("permissions", ALL_PERMISSIONS)
        perm_str = "전체" if len(perms) >= len(ALL_PERMISSIONS) else ", ".join(perms)
        print(f"  {code:<16}  {expiry:<12}  {minutes:>6}  {uses:<6}  "
              f"{_status_color(st)}  {note}")
        print(f"  {'':16}  권한: {perm_str}")
    print()

# ── 메뉴: 코드 생성 ─────────────────────────────────────────────────────

def menu_create():
    _clear()
    _header("접속 코드 생성")
    print()

    # 만료일
    while True:
        val = input("  만료일 (YYYY-MM-DD, 무기한: Enter): ").strip()
        if not val:
            expiry = datetime.date.fromisoformat("9999-12-31")
            break
        try:
            expiry = datetime.date.fromisoformat(val)
            if expiry < datetime.date.today():
                print("  [경고] 오늘보다 이전 날짜입니다. 계속하시겠습니까? (y/N): ", end="")
                if input().strip().lower() != "y":
                    continue
            break
        except ValueError:
            _err("날짜 형식이 올바르지 않습니다. (예: 2026-06-30)")

    # 세션 시간
    while True:
        val = input("  세션 시간(분) [무기한: Enter]: ").strip()
        if not val:
            minutes = 999999
            break
        try:
            minutes = int(val)
            if minutes <= 0:
                raise ValueError
            break
        except ValueError:
            _err("양의 정수를 입력하세요.")

    # 사용 횟수
    while True:
        val = input("  사용 횟수 제한 [무제한: Enter / 횟수 입력]: ").strip()
        if not val:
            max_uses = 0
            break
        try:
            max_uses = int(val)
            if max_uses <= 0:
                raise ValueError
            break
        except ValueError:
            _err("양의 정수를 입력하세요.")
    unlimited_uses = (max_uses == 0)

    # 메모
    note = input("  메모 (사용자명 등): ").strip()

    # 권한
    print()
    print("  권한 설정:")
    for i, (perm, label) in enumerate(PERM_LABELS.items(), 1):
        print(f"    {i}. {perm:<12} {label}")
    val = input("\n  부여할 권한 번호 (전체: Enter, 예: 1,2,3): ").strip()
    if not val:
        permissions = list(ALL_PERMISSIONS)
    else:
        perm_keys = list(PERM_LABELS.keys())
        permissions = []
        for s in val.split(","):
            s = s.strip()
            try:
                idx = int(s) - 1
                if 0 <= idx < len(perm_keys):
                    permissions.append(perm_keys[idx])
            except ValueError:
                pass
        if not permissions:
            permissions = list(ALL_PERMISSIONS)

    # 생성
    tokens = _load()
    code = _gen_code()
    while code in tokens:
        code = _gen_code()

    tokens[code] = {
        "created":        datetime.date.today().isoformat(),
        "expiry":         expiry.isoformat(),
        "max_minutes":    minutes,
        "max_uses":       max_uses,
        "unlimited_uses": unlimited_uses,
        "use_count":      0,
        "in_use":         False,
        "note":           note,
        "permissions":    permissions,
        "used":           False,
        "first_used_at":  None,
        "expires_at":     None,
        "used_by_ip":     None,
    }
    _save(tokens)

    print()
    print(SEP)
    print("   접속 코드 생성 완료")
    print(SEP)
    expiry_str  = "무기한" if expiry.isoformat() == "9999-12-31" else expiry.isoformat()
    minutes_str = "무기한" if minutes >= 999999 else f"{minutes}분"
    uses_str    = "무제한" if unlimited_uses else f"{max_uses}회"
    print(f"   코드      :  {code}")
    print(f"   만료일    :  {expiry_str}")
    print(f"   세션 시간  :  {minutes_str}")
    print(f"   사용 횟수  :  {uses_str}")
    if note:
        print(f"   메모      :  {note}")
    perm_str = "전체" if len(permissions) >= len(ALL_PERMISSIONS) else ", ".join(permissions)
    print(f"   권한      :  {perm_str}")
    print(SEP)
    print()
    print("   이 코드를 사용자에게 전달하세요.")
    _pause()

# ── 메뉴: 코드 목록 ─────────────────────────────────────────────────────

def menu_list():
    tokens = _load()
    _show_list(tokens)
    _pause()

# ── 메뉴: 코드 폐기 ─────────────────────────────────────────────────────

def menu_revoke():
    tokens = _load()
    _show_list(tokens, "코드 폐기")
    if not tokens:
        _pause()
        return

    print()
    code = input("  폐기할 코드 (취소: Enter): ").strip().upper()
    if not code:
        return

    if code not in tokens:
        _err(f"코드를 찾을 수 없습니다: {code}")
        _pause()
        return

    if tokens[code].get("used"):
        _err("이미 폐기된 코드입니다.")
        _pause()
        return

    tokens[code]["used"] = True
    _save(tokens)
    _ok(f"코드 폐기 완료: {code}")
    _pause()

# ── 메뉴: 코드 삭제 ─────────────────────────────────────────────────────

def menu_delete():
    tokens = _load()
    _show_list(tokens, "코드 삭제")
    if not tokens:
        _pause()
        return

    print()
    code = input("  삭제할 코드 (취소: Enter): ").strip().upper()
    if not code:
        return

    if code not in tokens:
        _err(f"코드를 찾을 수 없습니다: {code}")
        _pause()
        return

    confirm = input(f"  '{code}' 를 완전히 삭제하시겠습니까? (y/N): ").strip().lower()
    if confirm != "y":
        print("  취소되었습니다.")
        _pause()
        return

    del tokens[code]
    _save(tokens)
    _ok(f"코드 삭제 완료: {code}")
    _pause()

# ── 메뉴: 사용 중 잠금 해제 ─────────────────────────────────────────────

def menu_unlock():
    tokens = _load()
    locked = {c: i for c, i in tokens.items() if i.get("in_use")}

    _clear()
    _header("사용 중 잠금 해제")
    if not locked:
        print("\n  사용 중(in_use) 상태인 코드가 없습니다.")
        _pause()
        return

    _show_list(locked, f"사용 중 코드 ({len(locked)}건)")
    print()
    code = input("  해제할 코드 (전체: Enter): ").strip().upper()

    if not code:
        confirm = input(f"  {len(locked)}개 코드를 모두 해제하시겠습니까? (y/N): ").strip().lower()
        if confirm != "y":
            print("  취소되었습니다.")
            _pause()
            return
        for c in locked:
            tokens[c]["in_use"]        = False
            tokens[c]["first_used_at"] = None
            tokens[c]["expires_at"]    = None
        _save(tokens)
        _ok(f"{len(locked)}개 코드 잠금 해제 완료.")
    else:
        if code not in locked:
            _err(f"사용 중 코드를 찾을 수 없습니다: {code}")
            _pause()
            return
        tokens[code]["in_use"]        = False
        tokens[code]["first_used_at"] = None
        tokens[code]["expires_at"]    = None
        _save(tokens)
        _ok(f"잠금 해제 완료: {code}")
    _pause()


# ── 만료/소진 판정 ──────────────────────────────────────────────────────

def _is_unusable(info: dict) -> bool:
    """사용 불가 코드 판정: 사용완료 · 기간만료 · 사용횟수 소진."""
    if info.get("used"):
        return True
    try:
        if datetime.date.today() > datetime.date.fromisoformat(info["expiry"]):
            return True
    except Exception:
        pass
    if not info.get("unlimited_uses"):
        max_uses  = info.get("max_uses", 1)
        use_count = info.get("use_count", 0)
        if use_count >= max_uses:
            return True
    return False

# ── 메뉴: 권한 변경 ─────────────────────────────────────────────────────

def menu_change_permissions():
    tokens = _load()
    _show_list(tokens, "권한 변경")
    if not tokens:
        _pause()
        return

    print()
    code = input("  권한을 변경할 코드 (취소: Enter): ").strip().upper()
    if not code:
        return

    if code not in tokens:
        _err(f"코드를 찾을 수 없습니다: {code}")
        _pause()
        return

    current = tokens[code].get("permissions", ALL_PERMISSIONS)
    current_str = "전체" if len(current) >= len(ALL_PERMISSIONS) else ", ".join(current)
    print(f"\n  현재 권한: {current_str}")
    print()
    print("  권한 목록:")
    for i, (perm, label) in enumerate(PERM_LABELS.items(), 1):
        mark = "✓" if perm in current else " "
        print(f"    {i}. [{mark}] {perm:<12} {label}")

    val = input("\n  부여할 권한 번호 (전체: Enter, 예: 1,2,3): ").strip()
    if not val:
        permissions = list(ALL_PERMISSIONS)
    else:
        perm_keys = list(PERM_LABELS.keys())
        permissions = []
        for s in val.split(","):
            s = s.strip()
            try:
                idx = int(s) - 1
                if 0 <= idx < len(perm_keys):
                    permissions.append(perm_keys[idx])
            except ValueError:
                pass
        if not permissions:
            _err("유효한 번호를 입력하세요.")
            _pause()
            return

    tokens[code]["permissions"] = permissions
    _save(tokens)
    perm_str = "전체" if len(permissions) >= len(ALL_PERMISSIONS) else ", ".join(permissions)
    _ok(f"권한 변경 완료: {code} → {perm_str}")
    _pause()


# ── 메뉴: 만료·소진 코드 일괄 삭제 ─────────────────────────────────────

def menu_purge():
    tokens = _load()
    targets = {code: info for code, info in tokens.items() if _is_unusable(info)}

    _clear()
    _header("만료·소진 코드 일괄 삭제")
    if not targets:
        print("\n  삭제 대상 코드가 없습니다.")
        _pause()
        return

    _show_list(targets, f"삭제 대상 ({len(targets)}건)")
    confirm = input(f"  위 {len(targets)}개 코드를 모두 삭제하시겠습니까? (y/N): ").strip().lower()
    if confirm != "y":
        print("  취소되었습니다.")
        _pause()
        return

    for code in targets:
        del tokens[code]
    _save(tokens)
    _ok(f"{len(targets)}개 코드 삭제 완료.")
    _pause()

# ── 메뉴: 전체 삭제 ─────────────────────────────────────────────────────

def menu_delete_all():
    tokens = _load()
    _clear()
    _header("전체 삭제")
    if not tokens:
        print("\n  등록된 접속 코드가 없습니다.")
        _pause()
        return

    _show_list(tokens, f"전체 목록 ({len(tokens)}건)")
    confirm = input(f"  전체 {len(tokens)}개 코드를 모두 삭제하시겠습니까? (y/N): ").strip().lower()
    if confirm != "y":
        print("  취소되었습니다.")
        _pause()
        return

    confirm2 = input("  정말 삭제합니다. 다시 한번 확인 (yes 입력): ").strip().lower()
    if confirm2 != "yes":
        print("  취소되었습니다.")
        _pause()
        return

    count = len(tokens)
    _save({})
    _ok(f"전체 {count}개 코드 삭제 완료.")
    _pause()

# ── 메뉴: 연결 강제 종료 ────────────────────────────────────────────────

def menu_kick():
    tokens = _load_tokens()
    active = {code: info for code, info in tokens.items() if info.get("in_use")}
    _show_list(active, "연결 강제 종료 (현재 연결 중인 코드)")

    if not active:
        print("\n  현재 연결 중인 세션이 없습니다.")
        input("\n  Enter 키를 누르면 돌아갑니다.")
        return

    code = input("  종료할 코드 (취소: Enter): ").strip().upper()
    if not code:
        return
    if code not in active:
        _err("해당 코드는 현재 연결 중이 아닙니다.")
        input("  Enter 키를 누르면 돌아갑니다.")
        return

    confirm = input(f"  코드 [{code}] 연결을 강제 종료합니다. 계속하시겠습니까? (y/N): ").strip().lower()
    if confirm != "y":
        print("  취소했습니다.")
        return

    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:3004/api/admin/kick/{code}",
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read())
        if result.get("ok"):
            _ok(f"코드 [{code}] 강제 종료 완료.")
        else:
            _err(f"실패: {result.get('error', '알 수 없는 오류')}")
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
        _err(f"실패: {body.get('error', str(e))}")
    except Exception as e:
        _err(f"서버 연결 오류: {e}")

    input("  Enter 키를 누르면 돌아갑니다.")


# ── 메인 메뉴 ───────────────────────────────────────────────────────────

def main():
    while True:
        _clear()
        _header("접속 코드 관리")
        print()
        print("   1.  코드 생성")
        print("   2.  코드 목록 조회")
        print("   3.  권한 변경")
        print("   4.  코드 폐기           (재사용 불가 처리)")
        print("   5.  코드 삭제           (목록에서 완전 삭제)")
        print("   6.  만료·소진 일괄 삭제  (사용 불가 코드 정리)")
        print("   7.  전체 삭제")
        print("   8.  사용 중 잠금 해제   (비정상 종료 후 복구)")
        print("   9.  연결 강제 종료      (현재 연결 중인 세션 끊기)")
        print()
        print("   0.  종료")
        print(SEP)
        choice = input("   선택 > ").strip()

        if   choice == "1": menu_create()
        elif choice == "2": menu_list()
        elif choice == "3": menu_change_permissions()
        elif choice == "4": menu_revoke()
        elif choice == "5": menu_delete()
        elif choice == "6": menu_purge()
        elif choice == "7": menu_delete_all()
        elif choice == "8": menu_unlock()
        elif choice == "9": menu_kick()
        elif choice == "0":
            _clear()
            print("\n  종료합니다.\n")
            sys.exit(0)
        else:
            print("  잘못된 선택입니다.")

if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\n\n  종료합니다.\n")
        sys.exit(0)
