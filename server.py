#!/usr/bin/env python3
"""RemoteDiag Server - WebSocket relay between browser and Windows agent."""

import eventlet
eventlet.monkey_patch()

import datetime
import json
import os
import sys
import socket
import time
from datetime import timedelta
from functools import wraps
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from flask import Flask, send_from_directory, jsonify, request, Response, abort, session
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import generate_password_hash, check_password_hash

import config

app = Flask(__name__, static_folder="static")
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "remotediag-secret-key-change-me")
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=24)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet",
                    logger=False, engineio_logger=False,
                    max_http_buffer_size=50 * 1024 * 1024,   # 50 MB
                    ping_timeout=120,                          # 2분 (대용량 전송 중 끊김 방지)
                    ping_interval=25)

_agents        = {}   # agent_sid  -> {platform, node, python, ip}
_browser_auth  = {}   # browser_sid -> {username, permissions, ip}
_browser_agent = {}   # browser_sid -> agent_sid  (1:1 페어링)
_agent_browser = {}   # agent_sid  -> browser_sid (역방향)
_users_path      = Path(__file__).parent / "users.json"
_tokens_path     = Path(__file__).parent / "tokens.json"
_rc_tokens_path  = Path(__file__).parent / "rc_tokens.json"
_agent_tokens    = {}    # agent_sid -> code (활성 세션)
_ctrl_rc_tokens  = {}    # ctrl_sid  -> rc_code (활성 RC 세션)
_pending_browser = {}    # code -> browser_sid (브라우저가 먼저 code 입력 시 대기)

# ── 브루트포스 방어 ───────────────────────────────────────────────────
_FAIL_MAX    = 5     # IP당 최대 실패 횟수
_BLOCK_SEC   = 300   # 차단 시간 (5분)
_FAIL_WINDOW = 600   # 실패 카운트 유효 시간 (10분)
_failed_attempts = {}  # ip -> {count, first_fail, blocked_until}

def _is_blocked(ip: str) -> bool:
    entry = _failed_attempts.get(ip)
    if not entry:
        return False
    return time.time() < entry.get("blocked_until", 0)

def _record_failure(ip: str):
    now   = time.time()
    entry = _failed_attempts.get(ip, {"count": 0, "first_fail": now, "blocked_until": 0})
    if now - entry.get("first_fail", now) > _FAIL_WINDOW:
        entry = {"count": 0, "first_fail": now, "blocked_until": 0}
    entry["count"] += 1
    if entry["count"] >= _FAIL_MAX:
        entry["blocked_until"] = now + _BLOCK_SEC
        print("[server] IP 차단: {} (실패 {}회, {}초)".format(ip, entry["count"], _BLOCK_SEC))
    _failed_attempts[ip] = entry

def _record_success(ip: str):
    _failed_attempts.pop(ip, None)

def _cleanup_failed_attempts():
    """만료된 차단 기록 주기적 정리 (메모리 누수 방지)."""
    import eventlet as _ev
    while True:
        _ev.sleep(3600)
        now     = time.time()
        expired = [ip for ip, e in _failed_attempts.items()
                   if now - e.get("first_fail", 0) > _FAIL_WINDOW * 2]
        for ip in expired:
            _failed_attempts.pop(ip, None)
        if expired:
            print("[server] 차단 기록 정리: {}건".format(len(expired)))


def _reset_in_use_on_start():
    """서버 시작 시 in_use 토큰 전체 초기화.
    비정상 종료·재시작 후 in_use=True 로 남은 토큰을 복구.
    """
    tokens = _load_tokens()
    changed = [c for c, i in tokens.items() if i.get("in_use")]
    for code in changed:
        tokens[code]["in_use"]        = False
        tokens[code]["first_used_at"] = None
        tokens[code]["expires_at"]    = None
    if changed:
        _save_tokens(tokens)
        print("[server] in_use 토큰 초기화: {}건 (서버 재시작)".format(len(changed)))

    rc_tokens = _load_rc_tokens()
    rc_changed = [c for c, i in rc_tokens.items() if i.get("in_use")]
    for code in rc_changed:
        rc_tokens[code]["in_use"] = False
    if rc_changed:
        _save_rc_tokens(rc_tokens)
        print("[server] RC in_use 토큰 초기화: {}건 (서버 재시작)".format(len(rc_changed)))


def _cleanup_orphaned_tokens():
    """실제 연결된 에이전트가 없는 in_use 토큰 주기적 정리 (1분마다)."""
    import eventlet as _ev
    while True:
        _ev.sleep(60)
        active_codes = set(_agent_tokens.values())
        tokens = _load_tokens()
        changed = [c for c, i in tokens.items()
                   if i.get("in_use") and c not in active_codes]
        for code in changed:
            tokens[code]["in_use"]        = False
            tokens[code]["first_used_at"] = None
            tokens[code]["expires_at"]    = None
        if changed:
            _save_tokens(tokens)
            print("[server] 고아 in_use 토큰 정리: {}건".format(len(changed)))

# ── 원격 제어 (멀티 세션) ─────────────────────────────────────────────
_controllers       = {}   # controller_sid -> {}
_controller_browser = {}  # controller_sid -> browser_sid
_browser_controller = {}  # browser_sid   -> controller_sid
_rc_active         = set()  # 현재 원격 제어 활성 브라우저 sid


def _delayed_disconnect(sid):
    """거절 메시지 전송 후 소켓 끊기 (0.5초 지연)."""
    import eventlet as _ev
    _ev.sleep(0.5)
    try:
        socketio.server.disconnect(sid)
    except Exception:
        pass


def _client_ip():
    """실제 클라이언트 IP 반환 (nginx X-Real-IP 우선)."""
    return (request.environ.get("HTTP_X_REAL_IP") or
            request.environ.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip() or
            request.remote_addr or "unknown")


def _pair(browser_sid, agent_sid):
    """브라우저 ↔ 에이전트 1:1 페어링 등록."""
    _browser_agent[browser_sid] = agent_sid
    _agent_browser[agent_sid]   = browser_sid
    b_ip = _browser_auth.get(browser_sid, {}).get("ip", "?")
    a_ip = _agents.get(agent_sid, {}).get("ip", "?")
    print("[server] 페어링: browser={}({}) ↔ agent={}({})".format(
        browser_sid[:8], b_ip, agent_sid[:8], a_ip))


def _unpair_browser(browser_sid):
    agent_sid = _browser_agent.pop(browser_sid, None)
    if agent_sid:
        _agent_browser.pop(agent_sid, None)


def _unpair_agent(agent_sid):
    browser_sid = _agent_browser.pop(agent_sid, None)
    if browser_sid:
        _browser_agent.pop(browser_sid, None)
    return browser_sid   # 페어링됐던 브라우저 SID 반환


def _find_unpaired_browser(ip):
    """미페어링 로그인 브라우저 SID 반환. 같은 IP 우선, 없으면 아무 브라우저."""
    fallback = None
    for b_sid, info in _browser_auth.items():
        if b_sid in _browser_agent:
            continue
        if info.get("ip") == ip:
            return b_sid          # 같은 IP → 즉시 반환
        if fallback is None:
            fallback = b_sid      # 다른 IP → 폴백 후보
    return fallback


def _find_unpaired_agent(ip):
    """미페어링 에이전트 SID 반환. 같은 IP 우선, 없으면 아무 에이전트."""
    fallback = None
    for a_sid, info in _agents.items():
        if a_sid in _agent_browser:
            continue
        if info.get("ip") == ip:
            return a_sid
        if fallback is None:
            fallback = a_sid
    return fallback

ALL_PERMISSIONS  = ["adb-shell", "adb-info", "at", "logs", "kmsg", "remote", "diag", "guide"]
BASE_PERMISSIONS = ["adb-info", "at", "diag", "guide"]


# -- Token management -------------------------------------------------

def _load_tokens() -> dict:
    try:
        return json.loads(_tokens_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


def _save_tokens(tokens: dict):
    _tokens_path.write_text(
        json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _burn_token(code: str, ip: str = ""):
    """세션 종료 처리.
    - in_use 해제, 세션 필드 초기화
    - unlimited_uses: 횟수 제한 없이 재사용 가능
    - max_uses > 0  : use_count 증가, 한도 도달 시 used=True
    """
    tokens = _load_tokens()
    if code not in tokens or tokens[code].get("used"):
        return

    # 세션 잠금 해제 및 세션 필드 초기화
    tokens[code]["in_use"]        = False
    tokens[code]["first_used_at"] = None
    tokens[code]["expires_at"]    = None

    if tokens[code].get("unlimited_uses"):
        _save_tokens(tokens)
        print("[server] 무제한 토큰 세션 초기화: {}".format(code))
        return

    max_uses  = tokens[code].get("max_uses", 1)
    use_count = tokens[code].get("use_count", 0) + 1
    tokens[code]["use_count"] = use_count
    if ip:
        tokens[code]["used_by_ip"] = ip

    if use_count >= max_uses:
        tokens[code]["used"] = True
        _save_tokens(tokens)
        print("[server] 토큰 소각: {} ({}/{}) (IP: {})".format(
            code, use_count, max_uses, ip or "-"))
    else:
        _save_tokens(tokens)
        print("[server] 토큰 세션 초기화: {} ({}/{}) (IP: {})".format(
            code, use_count, max_uses, ip or "-"))


def _session_timer(agent_sid: str, code: str, remaining_seconds: int):
    """remaining_seconds 경과 후 에이전트 강제 종료 + 토큰 소각."""
    import eventlet as _ev
    _ev.sleep(remaining_seconds)
    ip = _agents.get(agent_sid, {}).get("ip", "")
    _burn_token(code, ip)
    if agent_sid in _agents:
        minutes = remaining_seconds // 60
        socketio.emit("agent_kicked",
                      {"reason": "세션 시간({})분이 초과되었습니다.".format(minutes)},
                      room=agent_sid)
        _ev.sleep(0.5)
        try:
            socketio.server.disconnect(agent_sid)
        except Exception:
            pass
        print("[server] 세션 시간 초과 종료: {} (코드: {})".format(agent_sid[:8], code))


# -- RC Token management ----------------------------------------------

def _load_rc_tokens() -> dict:
    try:
        return json.loads(_rc_tokens_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}

def _save_rc_tokens(tokens: dict):
    _rc_tokens_path.write_text(
        json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8"
    )

def _burn_rc_token(code: str):
    """RC 세션 종료 처리: in_use 해제, use_count 증가."""
    tokens = _load_rc_tokens()
    if code not in tokens or tokens[code].get("used"):
        return
    tokens[code]["in_use"] = False
    if not tokens[code].get("unlimited_uses"):
        max_uses  = tokens[code].get("max_uses", 1)
        use_count = tokens[code].get("use_count", 0) + 1
        tokens[code]["use_count"] = use_count
        if use_count >= max_uses:
            tokens[code]["used"] = True
    _save_rc_tokens(tokens)
    print("[server] RC 토큰 세션 종료: {}".format(code))


# -- User management --------------------------------------------------

def _load_users() -> dict:
    try:
        return json.loads(_users_path.read_text(encoding="utf-8"))
    except Exception:
        return {}

def _save_users(users: dict):
    _users_path.write_text(
        json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8"
    )

def _init_users():
    if not _users_path.exists():
        users = {
            "admin": {
                "password_hash": generate_password_hash("admin"),
                "permissions": ALL_PERMISSIONS,
            },
            "user": {
                "password_hash": generate_password_hash("user"),
                "permissions": BASE_PERMISSIONS,
            },
        }
        _save_users(users)
        print("[server] users.json 생성 완료")
        print("         기본 계정: admin / admin  (전체 권한)")
        print("         기본 계정: user  / user   (디바이스 정보, AT Command, 가이드)")


# -- Auth API ---------------------------------------------------------

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    users = _load_users()
    user  = users.get(username)
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "사용자명 또는 비밀번호가 올바르지 않습니다."}), 401

    session.permanent = True
    session["username"]    = username
    session["permissions"] = user.get("permissions", BASE_PERMISSIONS)
    return jsonify({"username": username, "permissions": session["permissions"]})

@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})

@app.route("/api/me")
def api_me():
    username = session.get("username")
    if not username:
        return jsonify({"error": "로그인이 필요합니다."}), 401
    return jsonify({
        "username":    username,
        "permissions": session.get("permissions", BASE_PERMISSIONS),
    })


# -- Static & download ------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")

@app.route("/download/woorinet_remote_diag_agent.exe")
@app.route("/dist/woorinet_remote_diag_agent.exe")
def download_agent_exe():
    if not session.get("username"):
        abort(401)
    for candidate in [
        Path(__file__).parent / "dist_go" / "woorinet_remote_diag_agent.exe",
        Path(__file__).parent / "dist" / "woorinet_remote_diag_agent.exe",
        Path(__file__).parent / "woorinet_remote_diag_agent.exe",
    ]:
        if candidate.exists():
            data = candidate.read_bytes()
            return Response(data, mimetype="application/octet-stream",
                            headers={"Content-Disposition": "attachment; filename=woorinet_remote_diag_agent.exe"})
    abort(404)

@app.route("/api/log-upload", methods=["POST"])
def api_log_upload():
    """에이전트 → HTTP POST 로그 업로드 (WebSocket 우회)."""
    import zlib as _zlib

    # zlib 압축 해제
    try:
        raw  = _zlib.decompress(request.data)
        data = json.loads(raw.decode("utf-8"))
    except Exception as e:
        return jsonify({"success": False, "error": "payload 오류: {}".format(e)}), 400

    # 접속 코드 검증 — 현재 활성(in_use) 세션만 허용
    code  = str(data.get("code", "")).strip().upper()
    token = _load_tokens().get(code)
    if not token or token.get("used") or not token.get("in_use"):
        return jsonify({"success": False, "error": "인증 실패"}), 401

    browser_sid = data.get("browser_sid", "")
    files  = data.get("files", {})
    errors = list(data.get("errors", []))
    phone  = _SAFE_NAME_RE.sub("_", str(data.get("phone", "unknown")))[:32]
    imei   = _SAFE_NAME_RE.sub("_", str(data.get("imei",  "unknown")))[:20]

    now      = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    dir_name = "{}_{}_{}_{}".format(phone, imei, now.strftime("%Y%m%d"), now.strftime("%H%M%S"))
    save_dir = (Path(__file__).parent / "uploads" / dir_name).resolve()
    save_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    for filename, content in files.items():
        try:
            fpath = (save_dir / filename).resolve()
            if not str(fpath).startswith(str(save_dir)):
                errors.append("{}: 허용되지 않는 경로".format(filename))
                continue
            fpath.parent.mkdir(parents=True, exist_ok=True)
            fpath.write_text(content, encoding="utf-8", errors="replace")
            saved.append(filename)
        except Exception as e:
            errors.append("{}: {}".format(filename, str(e)))

    rel_path = str(save_dir.relative_to(Path(__file__).parent))
    print("[server] Log upload (HTTP): {}개 파일 저장 → {}".format(len(saved), rel_path))

    # 브라우저에 결과 통보 (WebSocket)
    if browser_sid:
        socketio.emit("log_upload_result", {
            "success": True,
            "path":    rel_path,
            "files":   saved,
            "count":   len(saved),
            "errors":  errors,
        }, room=browser_sid)

    return jsonify({"success": True, "path": rel_path,
                    "files": saved, "count": len(saved)})


@app.route("/api/server-info")
def server_info():
    exe_ready = (Path(__file__).parent / "dist_go" / "woorinet_remote_diag_agent.exe").exists() or \
                (Path(__file__).parent / "dist" / "woorinet_remote_diag_agent.exe").exists() or \
                (Path(__file__).parent / "woorinet_remote_diag_agent.exe").exists()
    return jsonify({
        "ip":              _get_local_ip(),
        "port":            getattr(config, "PUBLIC_PORT", config.PORT),
        "agent_connected": len(_agents) > 0,
        "exe_ready":       exe_ready,
    })

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)


# -- WebSocket --------------------------------------------------------

@socketio.on("connect")
def on_connect():
    pass

@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    _browser_auth.pop(sid, None)

    # ── 컨트롤러 끊김 ──────────────────────────────────────────────
    if sid in _controllers:
        del _controllers[sid]
        rc_code = _ctrl_rc_tokens.pop(sid, None)
        if rc_code:
            _burn_rc_token(rc_code)
        b_sid = _controller_browser.pop(sid, None)
        if b_sid:
            _browser_controller.pop(b_sid, None)
            _rc_active.discard(b_sid)
            socketio.emit("remote_control_ack",
                          {"active": False, "error": "원격 제어 서비스 연결 해제"},
                          room=b_sid)
        print("[server] Controller disconnected: {}".format(sid[:8]))
        return

    # ── 에이전트 끊김 ──────────────────────────────────────────────
    if sid in _agents:
        ip   = _agents[sid].get("ip", "")
        code = _agent_tokens.pop(sid, None)
        if code:
            _burn_token(code, ip)   # 1회 토큰 소각 / 무제한 토큰 세션 초기화
        b_sid = _unpair_agent(sid)
        del _agents[sid]
        if b_sid:
            socketio.emit("agent_status", {"connected": False}, room=b_sid)
        print("[server] Agent disconnected: {}".format(sid[:8]))
        return

    # ── 브라우저 끊김 ──────────────────────────────────────────────
    # 원격 제어 세션 정리
    ctrl_sid = _browser_controller.pop(sid, None)
    if ctrl_sid:
        _controller_browser.pop(ctrl_sid, None)
        socketio.emit("session_ended", {}, room=ctrl_sid)
    _rc_active.discard(sid)
    # 페어링 대기 정리
    pending_code = next((c for c, b in list(_pending_browser.items()) if b == sid), None)
    if pending_code:
        _pending_browser.pop(pending_code, None)
    # 에이전트 페어링 해제
    _unpair_browser(sid)

@socketio.on("browser_hello")
def on_browser_hello(_data=None):
    join_room("browsers")
    browser_sid = request.sid
    username    = session.get("username")
    permissions = session.get("permissions", [])
    ip          = _client_ip()

    if username:
        _browser_auth[browser_sid] = {"username": username, "permissions": permissions, "ip": ip}
    else:
        _browser_auth.pop(browser_sid, None)

    # 이미 페어링된 에이전트가 살아 있는지 확인
    agent_sid = _browser_agent.get(browser_sid)
    if agent_sid and agent_sid not in _agents:
        _unpair_browser(browser_sid)
        agent_sid = None

    # 자동 페어링 제거 — browser_pair 이벤트로 명시적 페어링

    emit("agent_status", {
        "connected":   agent_sid is not None,
        "info":        _agents.get(agent_sid, {}),
        "username":    username,
        "permissions": permissions,
    })
    emit("remote_control_ack", {"active": browser_sid in _rc_active})

@socketio.on("agent_hello")
def on_agent_hello(data):
    agent_sid = request.sid
    ip        = _client_ip()
    info      = dict(data or {})
    code      = info.pop("code", "").strip().upper()

    # ── 접속 코드 검증 ──────────────────────────────────────────────
    def _reject(reason, record_fail=True):
        emit("agent_rejected", {"reason": reason})
        print("[server] Agent 거절 ({}): {} / {}".format(reason[:20], agent_sid[:8], code or "-"))
        if record_fail:
            _record_failure(ip)
        socketio.start_background_task(_delayed_disconnect, agent_sid)

    # IP 차단 확인
    if _is_blocked(ip):
        remaining = int(_failed_attempts[ip]["blocked_until"] - time.time())
        _reject("너무 많은 시도로 차단되었습니다. {}초 후 재시도하세요.".format(remaining),
                record_fail=False)
        return

    if not code:
        _reject("접속 코드가 필요합니다.")
        return

    tokens = _load_tokens()
    token  = tokens.get(code)

    if not token:
        _reject("유효하지 않은 접속 코드입니다.")
        return

    if token.get("used"):
        _reject("이미 사용이 완료된 접속 코드입니다.")
        return

    # 사용 횟수 확인 (비무제한 토큰)
    if not token.get("unlimited_uses"):
        max_uses  = token.get("max_uses", 1)
        use_count = token.get("use_count", 0)
        if use_count >= max_uses:
            tokens[code]["used"] = True
            _save_tokens(tokens)
            _reject("이미 사용이 완료된 접속 코드입니다.")
            return

    # 동시 접속 차단 — 다른 agent가 이 토큰으로 현재 접속 중
    if token.get("in_use"):
        _reject("접속 코드가 현재 다른 기기에서 사용 중입니다.", record_fail=False)
        return

    # 만료일 확인
    try:
        if datetime.date.today() > datetime.date.fromisoformat(token["expiry"]):
            _reject("접속 코드 사용 기간이 만료되었습니다. (만료일: {})".format(token["expiry"]))
            return
    except Exception:
        pass

    max_minutes = token.get("max_minutes", 120)

    # 새 세션 시작
    now        = datetime.datetime.utcnow()
    expires_at = now + timedelta(minutes=max_minutes)
    tokens[code]["in_use"]        = True
    tokens[code]["first_used_at"] = now.isoformat()
    tokens[code]["expires_at"]    = expires_at.isoformat()
    tokens[code]["used_by_ip"]    = ip
    _save_tokens(tokens)
    remaining_sec = max_minutes * 60
    use_count = tokens[code].get("use_count", 0)
    max_uses  = tokens[code].get("max_uses", 0)
    uses_info = "무제한" if token.get("unlimited_uses") else "{}/{}회".format(use_count + 1, max_uses)
    print("[server] Agent 접속: {} (코드: {} 세션: {}분 사용: {})".format(
        agent_sid[:8], code, max_minutes, uses_info))

    # ── 접속 허용 ───────────────────────────────────────────────────
    _record_success(ip)   # 성공 시 실패 기록 초기화
    info["ip"] = ip
    _agents[agent_sid]       = info
    _agent_tokens[agent_sid] = code

    emit("agent_accepted", {
        "expires_in_minutes": remaining_sec // 60,
        "expiry_date":        token["expiry"],
    })

    # 세션 타이머 (시간 초과 시 자동 종료 + 소각)
    socketio.start_background_task(_session_timer, agent_sid, code, remaining_sec)

    # 브라우저가 먼저 code 입력하고 대기 중이면 즉시 페어링
    b_sid = _pending_browser.pop(code, None)
    if b_sid and b_sid in _browser_auth:
        _pair(b_sid, agent_sid)
        socketio.emit("agent_status",  {"connected": True, "info": info}, room=b_sid)
        socketio.emit("pair_result",   {"success": True, "connected": True, "info": info}, room=b_sid)
        print("[server] 대기 브라우저 즉시 페어링: {} ↔ {}".format(b_sid[:8], agent_sid[:8]))


# ── Shell 명령 거부 목록 ─────────────────────────────────────────────
# adb_shell / srsd_shell cmd_type에 한해 적용.
# 패턴은 명령 전체(소문자 변환 후)에 대해 검사.
import re as _re

_SHELL_DENYLIST: list[tuple[_re.Pattern, str]] = [
    # 파일 시스템 파괴
    (_re.compile(r"\brm\s+-[a-z]*r[a-z]*f[a-z]*\b|\brm\s+-[a-z]*f[a-z]*r"),
     "rm -rf 계열 명령은 허용되지 않습니다."),
    (_re.compile(r"\bmkfs\b"),
     "mkfs 명령은 허용되지 않습니다."),
    (_re.compile(r"\bdd\b.*\bif\s*="),
     "dd if= 명령은 허용되지 않습니다."),
    (_re.compile(r">\s*/dev/(?!null\b|zero\b)"),
     "/dev/ 블록 장치 쓰기는 허용되지 않습니다."),
    # 재부팅/전원 차단
    (_re.compile(r"\b(reboot|poweroff|shutdown|halt|init\s+0|init\s+6)\b"),
     "시스템 재부팅/종료 명령은 허용되지 않습니다."),
    # 네트워크 다운로드/터널
    (_re.compile(r"\b(wget|curl)\b.*(-O\b|--output\b|>\s*\S|\|\s*sh|\|\s*bash)"),
     "wget/curl 다운로드·파이프 실행은 허용되지 않습니다."),
    (_re.compile(r"\b(nc|ncat|netcat)\b"),
     "nc/netcat 명령은 허용되지 않습니다."),
    # 파이프 to 셸 실행
    (_re.compile(r"\|\s*(sh|bash|ash|dash|zsh|python3?|perl|ruby)\b"),
     "파이프를 통한 셸 실행은 허용되지 않습니다."),
    # eval / exec 계열
    (_re.compile(r"\beval\b"),
     "eval 명령은 허용되지 않습니다."),
    # base64 decode → 실행 조합
    (_re.compile(r"\bbase64\b.*-d.*\||\|\s*base64\b.*-d"),
     "base64 디코드 파이프 실행은 허용되지 않습니다."),
    # setuid/권한 남용
    (_re.compile(r"\bchmod\b.*([\+\s]s|4[0-7]{3})"),
     "setuid/setgid 권한 변경은 허용되지 않습니다."),
    # fork bomb
    (_re.compile(r":\s*\(\s*\)\s*\{"),
     "Fork bomb 패턴은 허용되지 않습니다."),
    # 민감 파일 수정
    (_re.compile(r">\s*/etc/(passwd|shadow|sudoers|crontab|hosts)\b"),
     "시스템 설정 파일 수정은 허용되지 않습니다."),
]

_SHELL_CMD_TYPES = {"adb_shell", "srsd_shell"}


def _check_denylist(cmd: str) -> str | None:
    """차단 규칙에 해당하면 오류 메시지 반환, 통과하면 None."""
    lower = cmd.lower()
    for pattern, msg in _SHELL_DENYLIST:
        if pattern.search(lower):
            return msg
    return None


@socketio.on("browser_pair")
def on_browser_pair(data):
    """브라우저가 접속 코드를 입력하여 에이전트와 명시적 페어링."""
    browser_sid = request.sid
    if not _browser_auth.get(browser_sid):
        emit("pair_result", {"success": False, "error": "로그인이 필요합니다."})
        return

    code = str((data or {}).get("code", "")).strip().upper()
    if not code:
        emit("pair_result", {"success": False, "error": "접속 코드를 입력하세요."})
        return

    # 이미 페어링된 경우
    if browser_sid in _browser_agent:
        emit("pair_result", {"success": False, "error": "이미 연결된 에이전트가 있습니다."})
        return

    # 토큰 유효성 검증
    tokens = _load_tokens()
    token  = tokens.get(code)
    if not token:
        emit("pair_result", {"success": False, "error": "유효하지 않은 접속 코드입니다."})
        return
    if token.get("used"):
        emit("pair_result", {"success": False, "error": "이미 사용이 완료된 접속 코드입니다."})
        return
    try:
        if datetime.date.today() > datetime.date.fromisoformat(token["expiry"]):
            emit("pair_result", {"success": False, "error": "만료된 접속 코드입니다."})
            return
    except Exception:
        pass

    # 이미 다른 브라우저가 이 코드로 대기 중인 경우
    if code in _pending_browser and _pending_browser[code] != browser_sid:
        emit("pair_result", {"success": False, "error": "해당 코드는 이미 다른 세션에서 대기 중입니다."})
        return

    # Agent가 이미 연결되어 있는지 확인
    agent_sid = next((sid for sid, c in _agent_tokens.items() if c == code), None)

    if agent_sid and agent_sid in _agents:
        # 즉시 페어링
        _pair(browser_sid, agent_sid)
        info = _agents[agent_sid]
        emit("pair_result", {"success": True, "connected": True, "info": info})
        socketio.emit("agent_status", {"connected": True, "info": info}, room=browser_sid)
        print("[server] Browser 즉시 페어링: {} ↔ {} (code: {})".format(
            browser_sid[:8], agent_sid[:8], code))
    else:
        # Agent 대기 등록
        _pending_browser[code] = browser_sid
        emit("pair_result", {"success": True, "waiting": True})
        print("[server] Browser 대기 등록: code={} browser={}".format(code, browser_sid[:8]))


@socketio.on("command")
def on_command(data):
    browser_sid = request.sid
    if not _browser_auth.get(browser_sid):
        emit("result", {"id": data.get("id"), "success": False,
                        "error": "로그인이 필요합니다."})
        return
    agent_sid = _browser_agent.get(browser_sid)
    if not agent_sid or agent_sid not in _agents:
        emit("result", {"id": data.get("id"), "success": False,
                        "error": "에이전트가 연결되지 않았습니다."})
        return

    # ── Denylist 검사 (adb_shell / srsd_shell) ──────────────────────
    cmd_type = str(data.get("cmd_type", ""))
    if cmd_type in _SHELL_CMD_TYPES:
        cmd_str = str(data.get("cmd", "") or data.get("command", "")).strip()
        blocked = _check_denylist(cmd_str)
        if blocked:
            username = _browser_auth[browser_sid].get("username", "?")
            print("[server] 명령 차단 [{}] ({}) : {}".format(
                cmd_type, username, cmd_str[:80]))
            emit("result", {"id": data.get("id"), "success": False,
                            "error": "[차단] {}".format(blocked)})
            return

    data["browser_sid"] = browser_sid
    socketio.emit("command", data, room=agent_sid)

@socketio.on("result")
def on_result(data):
    browser_sid = data.pop("browser_sid", None)
    if browser_sid:
        socketio.emit("result", data, room=browser_sid)

# ── Controller (remote_control.py) events ───────────────────────────

@socketio.on("controller_hello")
def on_controller_hello(data=None):
    ctrl_sid    = request.sid
    username    = session.get("username")
    permissions = session.get("permissions", [])
    client_ip   = _client_ip()
    is_local    = client_ip in ("127.0.0.1", "::1", "localhost")

    if not is_local:
        # ID/PW 로그인 + remote 권한 확인
        if not username:
            emit("controller_error", {"message": "로그인이 필요합니다."})
            print("[server] Controller 거절 (미인증): {}".format(ctrl_sid[:8]))
            return
        if "remote" not in permissions:
            emit("controller_error", {"message": "remote 권한이 없습니다."})
            print("[server] Controller 거절 (권한 없음): {} ({})".format(ctrl_sid[:8], username))
            return

        # RC 접속 코드 검증
        def _rc_reject(msg, record_fail=False):
            emit("controller_error", {"message": msg})
            if record_fail:
                _record_failure(client_ip)
            socketio.start_background_task(_delayed_disconnect, ctrl_sid)

        rc_code = str((data or {}).get("code", "")).strip().upper()
        if not rc_code:
            _rc_reject("RC 접속 코드가 필요합니다.")
            print("[server] Controller 거절 (RC 코드 없음): {}".format(ctrl_sid[:8]))
            return

        if _is_blocked(client_ip):
            remaining = int(_failed_attempts[client_ip]["blocked_until"] - time.time())
            _rc_reject("너무 많은 시도로 차단되었습니다. {}초 후 재시도하세요.".format(remaining))
            return

        rc_tokens = _load_rc_tokens()
        rc_token  = rc_tokens.get(rc_code)

        if not rc_token:
            _rc_reject("유효하지 않은 RC 접속 코드입니다.", record_fail=True)
            print("[server] Controller 거절 (RC 코드 불일치): {}".format(ctrl_sid[:8]))
            return
        if rc_token.get("used"):
            _rc_reject("이미 사용이 완료된 RC 접속 코드입니다.")
            return
        if rc_token.get("in_use"):
            _rc_reject("RC 접속 코드가 현재 다른 곳에서 사용 중입니다.")
            return
        try:
            if datetime.date.today() > datetime.date.fromisoformat(rc_token["expiry"]):
                _rc_reject("만료된 RC 접속 코드입니다.")
                return
        except Exception:
            pass

        # RC 토큰 활성화
        rc_tokens[rc_code]["in_use"] = True
        _save_rc_tokens(rc_tokens)
        _ctrl_rc_tokens[ctrl_sid] = rc_code
        _record_success(client_ip)
        print("[server] Controller RC 코드 확인: {} ({})".format(ctrl_sid[:8], rc_code))

    _controllers[ctrl_sid] = {"username": username or "local"}
    emit("controller_ready", {"ok": True})
    print("[server] Controller connected: {} ({})".format(ctrl_sid[:8], username or "local"))

@socketio.on("controller_accept")
def on_controller_accept(_data=None):
    ctrl_sid = request.sid
    if ctrl_sid not in _controllers:
        return
    b_sid = _controller_browser.get(ctrl_sid)
    if not b_sid:
        return

    # 이미 다른 RC가 해당 브라우저 세션을 활성화한 경우 거절
    if b_sid in _rc_active:
        emit("controller_error", {"message": "이미 다른 RC 세션이 활성화되었습니다."})
        _controller_browser.pop(ctrl_sid, None)
        _browser_controller.pop(b_sid, None)
        socketio.start_background_task(_delayed_disconnect, ctrl_sid)
        print("[server] RC 중복 수락 차단: ctrl={}".format(ctrl_sid[:8]))
        return

    _rc_active.add(b_sid)
    socketio.emit("remote_control_ack", {"active": True}, room=b_sid)
    print("[server] RC activated: ctrl={} browser={}".format(ctrl_sid[:8], b_sid[:8]))

    # 단말 기본 정보 요청 → agent
    agent_sid = _browser_agent.get(b_sid)
    if agent_sid and agent_sid in _agents:
        socketio.emit("get_device_info", {"ctrl_sid": ctrl_sid}, room=agent_sid)


@socketio.on("device_info")
def on_device_info(data):
    """agent → server → controller 단말 기본 정보 중계."""
    ctrl_sid = data.get("ctrl_sid")
    if ctrl_sid and ctrl_sid in _controllers:
        socketio.emit("device_info", data, room=ctrl_sid)

@socketio.on("controller_end")
def on_controller_end(_data=None):
    ctrl_sid = request.sid
    if ctrl_sid not in _controllers:
        return
    b_sid = _controller_browser.pop(ctrl_sid, None)
    if b_sid:
        _browser_controller.pop(b_sid, None)
        _rc_active.discard(b_sid)
        socketio.emit("remote_control_ack", {"active": False}, room=b_sid)
    print("[server] RC ended by controller: {}".format(ctrl_sid[:8]))

@socketio.on("controller_cmd")
def on_controller_cmd(data):
    ctrl_sid = request.sid
    if ctrl_sid not in _controllers:
        return
    b_sid = _controller_browser.get(ctrl_sid)
    if not b_sid:
        emit("remote_result", {"success": False,
                               "error": "클라이언트가 연결되지 않았습니다.",
                               "id": data.get("id")})
        return
    socketio.emit("remote_cmd", data, room=b_sid)

# ── Browser remote control events ────────────────────────────────────

@socketio.on("remote_control_request")
def on_remote_control_request(_data=None):
    browser_sid = request.sid
    auth = _browser_auth.get(browser_sid)
    if not auth:
        emit("remote_control_ack", {"active": False, "error": "로그인 필요"})
        return

    # 이미 요청 대기 중이거나 활성 세션인 경우 중복 요청 차단
    if browser_sid in _browser_controller or browser_sid in _rc_active:
        emit("remote_control_ack", {"active": False, "error": "이미 원격 제어 요청이 진행 중입니다."})
        return

    # 미페어링 컨트롤러 탐색
    ctrl_sid = next((c for c in _controllers if c not in _controller_browser), None)
    if ctrl_sid is None:
        emit("remote_control_ack",
             {"active": False, "error": "원격 제어 서비스가 실행 중이지 않습니다."})
        return

    _controller_browser[ctrl_sid] = browser_sid
    _browser_controller[browser_sid] = ctrl_sid
    socketio.emit("remote_control_request",
                  {"username": auth["username"]}, room=ctrl_sid)
    print("[server] RC request: {} -> ctrl={}".format(auth["username"], ctrl_sid[:8]))

@socketio.on("remote_result")
def on_remote_result(data):
    browser_sid = request.sid
    # 결과를 해당 브라우저의 UI에 반영
    socketio.emit("remote_control_result", data, room=browser_sid)
    # 페어링된 컨트롤러로 전달
    ctrl_sid = _browser_controller.get(browser_sid)
    if ctrl_sid:
        socketio.emit("remote_result", data, room=ctrl_sid)

@socketio.on("remote_control_end")
def on_remote_control_end(_data=None):
    browser_sid = request.sid
    ctrl_sid = _browser_controller.pop(browser_sid, None)
    if ctrl_sid:
        _controller_browser.pop(ctrl_sid, None)
        socketio.emit("session_ended", {}, room=ctrl_sid)
    _rc_active.discard(browser_sid)
    socketio.emit("remote_control_ack", {"active": False}, room=browser_sid)
    print("[server] RC ended by browser: {}".format(browser_sid[:8]))

@socketio.on("logcat_line")
def on_logcat_line(data):
    b = _agent_browser.get(request.sid)
    if b:
        socketio.emit("logcat_line", data, room=b)

@socketio.on("log_line")
def on_log_line(data):
    b = _agent_browser.get(request.sid)
    if b:
        socketio.emit("log_line", data, room=b)

_SAFE_NAME_RE = __import__("re").compile(r"[^\w\-.]")

@socketio.on("log_upload_data")
def on_log_upload_data(data):
    browser_sid = data.get("browser_sid")
    files       = data.get("files", {})
    errors      = list(data.get("errors", []))

    # phone/imei는 디렉토리 이름에 포함되므로 안전한 문자만 허용
    phone = _SAFE_NAME_RE.sub("_", str(data.get("phone", "unknown")))[:32]
    imei  = _SAFE_NAME_RE.sub("_", str(data.get("imei",  "unknown")))[:20]

    now      = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    ts_date  = now.strftime("%Y%m%d")
    ts_time  = now.strftime("%H%M%S")
    dir_name = "{}_{}_{}_{}" .format(phone, imei, ts_date, ts_time)
    save_dir = (Path(__file__).parent / "uploads" / dir_name).resolve()
    save_dir.mkdir(parents=True, exist_ok=True)

    uploads_root = (Path(__file__).parent / "uploads").resolve()

    saved = []
    for filename, content in files.items():
        try:
            fpath = (save_dir / filename).resolve()
            # uploads/ 하위인지 검증 — 경로 탈출 방어
            if not str(fpath).startswith(str(save_dir)):
                errors.append("{}: 허용되지 않는 경로".format(filename))
                continue
            fpath.parent.mkdir(parents=True, exist_ok=True)
            fpath.write_text(content, encoding="utf-8", errors="replace")
            saved.append(filename)
        except Exception as e:
            errors.append("{}: {}".format(filename, str(e)))

    rel_path = str(save_dir.relative_to(Path(__file__).parent))
    print("[server] Log upload: {}개 파일 저장 → {}".format(len(saved), rel_path))

    if browser_sid:
        socketio.emit("log_upload_result", {
            "success": True,
            "path":    rel_path,
            "files":   saved,
            "count":   len(saved),
            "errors":  errors,
        }, room=browser_sid)

@socketio.on("device_update")
def on_device_update(data):
    b = _agent_browser.get(request.sid)
    if b:
        socketio.emit("device_update", data, room=b)

@socketio.on("port_update")
def on_port_update(data):
    b = _agent_browser.get(request.sid)
    if b:
        socketio.emit("port_update", data, room=b)


# -- Helpers ----------------------------------------------------------

def _get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    _init_users()

    local_ip    = _get_local_ip()
    public_port = getattr(config, "PUBLIC_PORT", config.PORT)
    print("\n" + "=" * 55)
    print("  RemoteDiag Server")
    print("=" * 55)
    print("  Web UI : https://{}:{}".format(local_ip, public_port))
    print("  Agent  : woorinet_remote_diag_agent.exe  (Windows PC에서 실행)")
    print("  Flask  : http://{}:{}  (internal)".format(config.HOST, config.PORT))
    print("=" * 55 + "\n")

    _reset_in_use_on_start()
    socketio.start_background_task(_cleanup_failed_attempts)
    socketio.start_background_task(_cleanup_orphaned_tokens)
    socketio.run(app, host=config.HOST, port=config.PORT,
                 use_reloader=False, log_output=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nServer stopped.")
