FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Node is needed by yt-dlp for YouTube
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY requirements-cloud.txt .
RUN pip install --no-cache-dir -r requirements-cloud.txt
COPY backend backend
COPY frontend frontend
ENV PORT=8000 HOSTED=1 MAX_UPLOAD_MB=100 MAX_MINUTES=30
EXPOSE 8000
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]