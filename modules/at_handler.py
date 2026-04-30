"""AT command handler via serial port."""

import threading
import time
import serial
import serial.tools.list_ports
from config import AT_DEFAULT_BAUDRATE, AT_TIMEOUT


_connections: dict[str, serial.Serial] = {}
_lock = threading.Lock()


def list_ports() -> list:
    ports = []
    for p in serial.tools.list_ports.comports():
        ports.append({
            "port": p.device,
            "description": p.description,
            "hwid": p.hwid,
        })
    return sorted(ports, key=lambda x: x["port"])


def open_port(port: str, baudrate: int = AT_DEFAULT_BAUDRATE) -> dict:
    with _lock:
        if port in _connections and _connections[port].is_open:
            return {"success": True, "message": f"{port} 이미 열려있음"}
        try:
            ser = serial.Serial(
                port=port,
                baudrate=baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=AT_TIMEOUT,
                xonxoff=False,
                rtscts=False,
            )
            _connections[port] = ser
            return {"success": True, "message": f"{port} 연결됨 ({baudrate} bps)"}
        except Exception as e:
            return {"success": False, "message": str(e)}


def close_port(port: str) -> dict:
    with _lock:
        if port in _connections:
            try:
                _connections[port].close()
                del _connections[port]
                return {"success": True, "message": f"{port} 닫힘"}
            except Exception as e:
                return {"success": False, "message": str(e)}
        return {"success": False, "message": f"{port} 열려있지 않음"}


def get_open_ports() -> list:
    with _lock:
        return [p for p, s in _connections.items() if s.is_open]


def send_command(port: str, command: str, timeout: float = AT_TIMEOUT) -> dict:
    with _lock:
        if port not in _connections or not _connections[port].is_open:
            return {"success": False, "response": f"{port} 포트가 열려있지 않습니다."}
        ser = _connections[port]

    try:
        ser.reset_input_buffer()
        cmd_bytes = (command.strip() + "\r\n").encode("utf-8")
        ser.write(cmd_bytes)

        deadline = time.time() + timeout
        response_lines = []
        while time.time() < deadline:
            if ser.in_waiting:
                line = ser.readline().decode("utf-8", errors="replace").strip()
                if line:
                    response_lines.append(line)
                    if line in ("OK", "ERROR", "NO CARRIER", "NO DIALTONE", "BUSY") or line.startswith("+CME ERROR") or line.startswith("+CMS ERROR"):
                        break
            else:
                time.sleep(0.01)

        return {"success": True, "response": "\n".join(response_lines) if response_lines else "(응답 없음)"}
    except Exception as e:
        return {"success": False, "response": str(e)}


def close_all():
    with _lock:
        for ser in _connections.values():
            try:
                ser.close()
            except Exception:
                pass
        _connections.clear()
