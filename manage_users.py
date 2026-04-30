#!/usr/bin/env python3
"""RemoteDiag 계정 관리 스크립트."""

import json
import sys
from pathlib import Path

from werkzeug.security import generate_password_hash

USERS_PATH = Path(__file__).parent / "users.json"

ALL_PERMISSIONS  = ["adb-shell", "adb-info", "at", "logs", "kmsg", "remote", "diag", "guide"]
BASE_PERMISSIONS = ["adb-info", "at", "diag", "guide"]

PERM_LABELS = {
    "adb-shell": "ADB Shell",
    "adb-info":  "디바이스 정보",
    "at":        "AT Command",
    "logs":      "Logs",
    "kmsg":      "kmsg",
    "remote":    "원격 제어",
    "diag":      "자동 점검",
    "guide":     "사용 가이드",
}


def _load():
    try:
        return json.loads(USERS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def _save(users):
    USERS_PATH.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")


def _print_users(users):
    if not users:
        print("  (계정 없음)")
        return
    for name, info in users.items():
        perms = ", ".join(info.get("permissions", []))
        print("  {:<16}  [{}]".format(name, perms))


def cmd_list():
    users = _load()
    print("\n=== 계정 목록 ===")
    _print_users(users)
    print()


def cmd_add():
    users = _load()
    print("\n=== 계정 추가 ===")
    username = input("사용자명: ").strip()
    if not username:
        print("오류: 사용자명을 입력하세요.")
        return
    if username in users:
        print("오류: '{}' 계정이 이미 존재합니다.".format(username))
        return

    password = input("비밀번호: ").strip()
    if not password:
        print("오류: 비밀번호를 입력하세요.")
        return

    print("\n권한 선택:")
    print("  1) 전체 권한  :", ", ".join(ALL_PERMISSIONS))
    print("  2) 기본 권한  :", ", ".join(BASE_PERMISSIONS))
    print("  3) 직접 선택")
    choice = input("선택 (1/2/3): ").strip()

    if choice == "1":
        permissions = ALL_PERMISSIONS[:]
    elif choice == "2":
        permissions = BASE_PERMISSIONS[:]
    elif choice == "3":
        print("부여할 권한을 입력하세요 (스페이스 구분):")
        for p, label in PERM_LABELS.items():
            print("  {} ({})".format(p, label))
        raw = input("> ").strip().split()
        permissions = [p for p in raw if p in ALL_PERMISSIONS]
        if not permissions:
            print("오류: 유효한 권한이 없습니다.")
            return
    else:
        print("오류: 올바른 선택이 아닙니다.")
        return

    users[username] = {
        "password_hash": generate_password_hash(password),
        "permissions":   permissions,
    }
    _save(users)
    print("\n완료: '{}' 계정이 추가됐습니다. 권한: {}\n".format(username, ", ".join(permissions)))


def cmd_delete():
    users = _load()
    print("\n=== 계정 삭제 ===")
    _print_users(users)
    username = input("\n삭제할 사용자명: ").strip()
    if username not in users:
        print("오류: '{}' 계정이 없습니다.".format(username))
        return
    confirm = input("'{}' 계정을 삭제합니까? (y/N): ".format(username)).strip().lower()
    if confirm != "y":
        print("취소됐습니다.")
        return
    del users[username]
    _save(users)
    print("완료: '{}' 계정이 삭제됐습니다.\n".format(username))


def cmd_passwd():
    users = _load()
    print("\n=== 비밀번호 변경 ===")
    _print_users(users)
    username = input("\n사용자명: ").strip()
    if username not in users:
        print("오류: '{}' 계정이 없습니다.".format(username))
        return
    password = input("새 비밀번호: ").strip()
    if not password:
        print("오류: 비밀번호를 입력하세요.")
        return
    users[username]["password_hash"] = generate_password_hash(password)
    _save(users)
    print("완료: '{}' 비밀번호가 변경됐습니다.\n".format(username))


def cmd_perms():
    users = _load()
    print("\n=== 권한 편집 ===")
    _print_users(users)
    username = input("\n사용자명: ").strip()
    if username not in users:
        print("오류: '{}' 계정이 없습니다.".format(username))
        return

    current = users[username].get("permissions", [])

    print("\n사용 가능한 권한:")
    for p in ALL_PERMISSIONS:
        print("  {:12}  {}".format(p, PERM_LABELS.get(p, p)))

    print("\n현재 권한: {}".format(", ".join(current) if current else "(없음)"))
    print("변경할 권한을 , 로 구분하여 입력하세요. (엔터만 누르면 현재 권한 유지)")

    prefill = ", ".join(current)
    try:
        raw = input("[{}]: ".format(prefill)).strip()
    except (EOFError, KeyboardInterrupt):
        print("\n취소됐습니다.")
        return

    if not raw:
        print("변경 없이 유지됩니다.\n")
        return

    tokens = [t.strip() for t in raw.split(",") if t.strip()]
    permissions = [p for p in tokens if p in ALL_PERMISSIONS]
    invalid = [p for p in tokens if p not in ALL_PERMISSIONS]

    if invalid:
        print("무시된 항목: {}".format(", ".join(invalid)))
    if not permissions:
        print("오류: 유효한 권한이 없습니다.")
        return

    # 정의된 순서 유지
    permissions = [p for p in ALL_PERMISSIONS if p in permissions]

    users[username]["permissions"] = permissions
    _save(users)
    print("완료: '{}' 권한이 변경됐습니다. → {}\n".format(
        username, ", ".join(permissions)))


def main():
    menu = [
        ("1", "계정 목록",     cmd_list),
        ("2", "계정 추가",     cmd_add),
        ("3", "계정 삭제",     cmd_delete),
        ("4", "비밀번호 변경", cmd_passwd),
        ("5", "권한 편집",     cmd_perms),
        ("q", "종료",          None),
    ]

    while True:
        print("=== RemoteDiag 계정 관리 ===")
        for key, label, _ in menu:
            print("  {}) {}".format(key, label))
        choice = input("선택: ").strip().lower()

        if choice == "q":
            break
        matched = [fn for key, _, fn in menu if key == choice and fn]
        if matched:
            matched[0]()
        else:
            print("올바른 메뉴를 선택하세요.\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n종료합니다.")
        sys.exit(0)
