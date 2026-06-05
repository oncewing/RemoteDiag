"""
빌드 전처리 스크립트 — build_agent.bat 에서 호출.
EXPIRE_DATE 주입 후 _build_agent.py 생성.
"""
import calendar
import datetime
import pathlib
import re
import shutil
import sys

SRC  = pathlib.Path("woorinet_remote_diag_agent.py")
DEST = pathlib.Path("_build_agent.py")

src = SRC.read_text("utf-8")

m = re.search(r'EXPIRE_DATE\s*=\s*"([^"]*)"', src)
if not m:
    shutil.copy(SRC, DEST)
    print("[inject] EXPIRE_DATE pattern not found, using source as-is")
    sys.exit(0)

val = m.group(1).strip()
if val:
    expire = datetime.date.fromisoformat(val)
    print(f"[inject] EXPIRE_DATE (specified): {expire.isoformat()}")
else:
    d  = datetime.date.today()
    mn = d.month % 12 + 1
    yr = d.year + d.month // 12
    expire = datetime.date(yr, mn, min(d.day, calendar.monthrange(yr, mn)[1]))
    print(f"[inject] EXPIRE_DATE (auto build+1month): {expire.isoformat()}")

repl   = f'EXPIRE_DATE        = "{expire.isoformat()}"'
result = re.sub(r'EXPIRE_DATE\s*=\s*"[^"]*"', repl, src)
DEST.write_text(result, "utf-8")
