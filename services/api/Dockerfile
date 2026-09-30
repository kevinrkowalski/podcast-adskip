FROM python:3.12-slim

WORKDIR /app

# curl for healthchecks; ffmpeg/ffprobe to chunk audio > OpenRouter multipart STT limit (~25 MB)
RUN apt-get update && apt-get install -y --no-install-recommends curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV DATABASE_PATH=/data/skip_maps.db
ENV CORS_ORIGINS=*
# OpenRouter is the primary backend; leave empty for stub/mock
ENV OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
ENV MAX_AUDIO_MB=25
VOLUME ["/data"]

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
