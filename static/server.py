#!/usr/bin/env python3
"""RemoteDiag Server - WebSocket relay between browser and Windows agent."""

import eventlet
eventlet.monkey_patch()

import datetime
import json
import os
import sys
import socket
from datetime import timedelta
from functools import wraps
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from flask import Flask, send_from_directory, jsonify, request, Response, abort, session
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import generate_password_hash, check_password_hash

import config
import generate_cert

app = Flask(__name__, static_folder="static")
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "remotediag-secret-key-change-me")
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=24)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet",
                    logger=False, engineio_logger=False)

_agent_sid = None
_browser_auth = {}   # sid -> {username, permissions}
_users_path = Path(__file__).parent / "users.json"
_remote_control_active = False
_controller_sid    = None   # remote_control.py 연결 SID
_remote_client_sid = None   # 원격 제어 요청한 브라우저 SID

ALL_PERMISSIONS  = ["adb-shell", "adb-info", "at", "logs", "kmsg", "remote", "guide"]
BASE_PERMISSIONS = ["adb-info", "at", "guide"]


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

@app.route("/download/agent.exe")
def download_agent_exe():
    for candidate in [
        Path(__file__).parent / "dist" / "agent.exe",
        Path(__file__).parent / "agent.exe",
    ]:
        if candidate.exists():
            data = candidate.read_bytes()
            return Response(data, mimetype="application/octet-stream",
                            headers={"Content-Disposition": "attachment; filename=agent.exe"})
    abort(404)

@app.route("/api/server-info")
def server_info():
    exe_ready = (Path(__file__).parent / "dist" / "agent.exe").exists() or \
                (Path(__file__).parent / "agent.exe").exists()
    return jsonify({
        "ip":              _get_local_ip(),
        "port":            getattr(config, "PUBLIC_PORT", config.PORT),
        "agent_connected": _agent_sid is not None,
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
    global _agent_sid, _controller_sid, _remote_control_active
    sid = request.sid
    _browser_auth.pop(sid, None)
    if sid == _agent_sid:
        _agent_sid = None
        socketio.emit("agent_status", {"connected": False}, room="browsers")
        print("[server] Agent disconnected")
    elif sid == _controller_sid:
        _controller_sid = None
        if _remote_control_active:
            _remote_control_active = False
            socketio.emit("remote_control_ack",
                          {"active": False, "error": "원격 제어 서비스 연결 해제"},
                          room="browsers")
        print("[server] Controller disconnected")

@socketio.on("browser_hello")
def on_browser_hello(_data=None):
    join_room("browsers")
    # WebSocket 핸들러에서 session이 handshake 시점 것이라
    # HTTP 세션에서 직접 재확인
    username    = session.get("username")
    permissions = session.get("permissions", [])
    if username:
        _browser_auth[request.sid] = {
            "username":    username,
            "permissions": permissions,
        }
    else:
        _browser_auth.pop(request.sid, None)
    emit("agent_status", {
        "connected":   _agent_sid is not None,
        "username":    username,
        "permissions": permissions,
    })
    emit("remote_control_ack", {"active": _remote_control_active})

@socketio.on("agent_hello")
def on_agent_hello(data):
    global _agent_sid
    _agent_sid = request.sid
    info = data or {}
    print("[server] Agent connected: {}".format(info))
    socketio.emit("agent_status", {"connected": True, "info": info}, room="browsers")

@socketio.on("command")
def on_command(data):
    auth = _browser_auth.get(request.sid)
    if not auth:
        emit("result", {"id": data.get("id"), "success": False,
                        "error": "로그인이 필요합니다."})
        return
    if _agent_sid is None:
        emit("result", {"id": data.get("id"), "success": False,
                        "error": "에이전트가 연결되지 않았습니다."})
        return
    data["browser_sid"] = request.sid
    socketio.emit("command", data, room=_agent_sid)

@socketio.on("result")
def on_result(data):
    browser_sid = data.pop("browser_sid", None)
    if browser_sid:
        socketio.emit("result", data, room=browser_sid)

# ── Controller (remote_control.py) events ───────────────────────────

@socketio.on("controller_hello")
def on_controller_hello(_data=None):
    global _controller_sid
    _controller_sid = request.sid
    emit("controller_ready", {"ok": True})
    print("[server] Controller connected")

@socketio.on("controller_accept")
def on_controller_accept(_data=None):
    global _remote_control_active
    if request.sid != _controller_sid:
        return
    _remote_control_active = True
    socketio.emit("remote_control_ack", {"active": True}, room="browsers")
    print("[server] Remote control activated")

@socketio.on("controller_end")
def on_controller_end(_data=None):
    global _remote_control_active, _remote_client_sid
    if request.sid != _controller_sid:
        return
    _remote_control_active = False
    _remote_client_sid = None
    socketio.emit("remote_control_ack", {"active": False}, room="browsers")
    print("[server] Remote control ended by controller")

@socketio.on("controller_cmd")
def on_controller_cmd(data):
    if request.sid != _controller_sid:
        return
    if _remote_client_sid is None:
        emit("remote_result", {"success": False,
                               "error": "클라이언트가 연결되지 않았습니다.",
                               "id": data.get("id")})
        return
    socketio.emit("remote_cmd", data, room=_remote_client_sid)

# ── Browser remote control events ────────────────────────────────────

@socketio.on("remote_control_request")
def on_remote_control_request(_data=None):
    global _remote_client_sid
    auth = _browser_auth.get(request.sid)
    if not auth:
        emit("remote_control_ack", {"active": False, "error": "로그인 필요"})
        return
    if _controller_sid is None:
        emit("remote_control_ack",
             {"active": False,
              "error": "원격 제어 서비스가 실행 중이지 않습니다."})
        return
    _remote_client_sid = request.sid
    socketio.emit("remote_control_request",
                  {"username": auth["username"]}, room=_controller_sid)
    print("[server] Remote control request from: {}".format(auth["username"]))

@socketio.on("remote_result")
def on_remote_result(data):
    # 브라우저 클라이언트가 명령 실행 후 결과 전송
    socketio.emit("remote_control_result", data, room="browsers")
    if _controller_sid:
        socketio.emit("remote_result", data, room=_controller_sid)

@socketio.on("remote_control_end")
def on_remote_control_end(_data=None):
    global _remote_control_active, _remote_client_sid
    _remote_control_active = False
    _remote_client_sid = None
    socketio.emit("remote_control_ack", {"active": False}, room="browsers")
    if _controller_sid:
        socketio.emit("session_ended", {}, room=_controller_sid)
    print("[server] Remote control ended by browser")

@socketio.on("logcat_line")
def on_logcat_line(data):
    socketio.emit("logcat_line", data, room="browsers")

@socketio.on("log_line")
def on_log_line(data):
    socketio.emit("log_line", data, room="browsers")

@socketio.on("log_upload_data")
def on_log_upload_data(data):
    browser_sid = data.get("browser_sid")
    files       = data.get("files", {})
    phone       = data.get("phone", "unknown")
    errors      = list(data.get("errors", []))

    now      = datetime.datetime.now()
    ts_date  = now.strftime("%Y%m%d")
    ts_time  = now.strftime("%H%M%S")
    dir_name = "{}_{}_{}" .format(phone, ts_date, ts_time)
    save_dir = Path(__file__).parent / "uploads" / dir_name
    save_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    for filename, content in files.items():
        fpath = save_dir / filename
        try:
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
    socketio.emit("device_update", data, room="browsers")

@socketio.on("port_update")
def on_port_update(data):
    socketio.emit("port_update", data, room="browsers")


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
    if not generate_cert.generate():
        sys.exit(1)

    _init_users()

    local_ip    = _get_local_ip()
    public_port = getattr(config, "PUBLIC_PORT", config.PORT)
    print("\n" + "=" * 55)
    print("  RemoteDiag Server")
    print("=" * 55)
    print("  Web UI : https://{}:{}".format(local_ip, public_port))
    print("  Agent  : agent.exe  (Windows PC에서 실행)")
    print("  Flask  : http://{}:{}  (internal)".format(config.HOST, config.PORT))
    print("=" * 55 + "\n")

    socketio.run(app, host=config.HOST, port=config.PORT,
                 use_reloader=False, log_output=False)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nServer stopped.")
