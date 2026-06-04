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
                    logger=False, engineio_logger=False)

_agents        = {}   # agent_sid  -> {platform, node, python, ip}
_browser_auth  = {}   # browser_sid -> {username, permissions, ip}
_browser_agent = {}   # browser_sid -> agent_sid  (1:1 페어링)
_agent_browser = {}   # agent_sid  -> browser_sid (역방향)
_users_path  = Path(__file__).parent / "users.json"
_tokens_path = Path(__file__).parent / "tokens.json"
_agent_tokens = {}    # agent_sid -> code (활성 세션)

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
        Path(__file__).parent / "dist" / "woorinet_remote_diag_agent.exe",
        Path(__file__).parent / "woorinet_remote_diag_agent.exe",
    ]:
        if candidate.exists():
            data = candidate.read_bytes()
            return Response(data, mimetype="application/octet-stream",
                            headers={"Content-Disposition": "attachment; filename=woorinet_remote_diag_agent.exe"})
    abort(404)

@app.route("/api/server-info")
def server_info():
    exe_ready = (Path(__file__).parent / "dist" / "woorinet_remote_diag_agent.exe").exists() or \
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

    # 페어링 안 됐고 로그인된 상태면 같은 IP의 대기 에이전트와 연결
    if not agent_sid and username:
        agent_sid = _find_unpaired_agent(ip)
        if agent_sid:
            _pair(browser_sid, agent_sid)

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

    # 같은 IP의 대기 중인 로그인 브라우저가 있으면 즉시 페어링
    b_sid = _find_unpaired_browser(ip)
    if b_sid:
        _pair(b_sid, agent_sid)
        socketio.emit("agent_status", {"connected": True, "info": info}, room=b_sid)

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
    data["browser_sid"] = browser_sid
    socketio.emit("command", data, room=agent_sid)

@socketio.on("result")
def on_result(data):
    browser_sid = data.pop("browser_sid", None)
    if browser_sid:
        socketio.emit("result", data, room=browser_sid)

# ── Controller (remote_control.py) events ───────────────────────────

@socketio.on("controller_hello")
def on_controller_hello(_data=None):
    ctrl_sid = request.sid
    username    = session.get("username")
    permissions = session.get("permissions", [])

    # 로컬 직접 연결(127.0.0.1)은 인증 생략, 외부 연결은 remote 권한 필요
    client_ip = _client_ip()
    is_local  = client_ip in ("127.0.0.1", "::1", "localhost")

    if not is_local:
        if not username:
            emit("controller_error", {"message": "로그인이 필요합니다."})
            print("[server] Controller 거절 (미인증): {}".format(ctrl_sid[:8]))
            return
        if "remote" not in permissions:
            emit("controller_error", {"message": "remote 권한이 없습니다."})
            print("[server] Controller 거절 (권한 없음): {} ({})".format(ctrl_sid[:8], username))
            return

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
    _rc_active.add(b_sid)
    socketio.emit("remote_control_ack", {"active": True}, room=b_sid)
    print("[server] RC activated: ctrl={} browser={}".format(ctrl_sid[:8], b_sid[:8]))

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

    now      = datetime.datetime.now()
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

    socketio.start_background_task(_cleanup_failed_attempts)
    socketio.run(app, host=config.HOST, port=config.PORT,
                 use_reloader=False, log_output=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nServer stopped.")
