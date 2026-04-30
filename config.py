import os

HOST = "127.0.0.1"
PORT = 8000
PUBLIC_PORT = 8443
CERT_DIR = os.path.join(os.path.dirname(__file__), "certs")
CERT_FILE = os.path.join(CERT_DIR, "cert.pem")
KEY_FILE = os.path.join(CERT_DIR, "key.pem")

ADB_PATH = os.environ.get("ADB_PATH", "adb")
ADB_COMMAND_TIMEOUT = 30

AT_DEFAULT_BAUDRATE = 115200
AT_TIMEOUT = 5
