FROM python:3.11-slim

WORKDIR /app

# 의존성 먼저 설치 (캐시 활용)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 소스 복사
COPY server.py config.py generate_cert.py manage_tokens.py ./
COPY static/ ./static/

# 업로드 디렉토리 생성
RUN mkdir -p uploads certs

EXPOSE 3004

CMD ["python3", "server.py"]
