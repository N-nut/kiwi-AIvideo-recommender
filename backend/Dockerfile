FROM node:24-bookworm-slim AS preview-runtime
WORKDIR /runtime
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM python:3.13.9-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV KIWI_PROJECT_ROOT=/app
COPY backend/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir -r requirements.lock
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY --from=preview-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=preview-runtime /runtime/node_modules /app/node_modules
RUN node /app/node_modules/playwright/cli.js install --with-deps chromium
COPY backend /app/backend
COPY data /app/data
RUN pip install --no-deps /app/backend && useradd --create-home kiwi && mkdir -p /media/previews && chown -R kiwi:kiwi /app /media
USER kiwi
EXPOSE 8000
CMD ["sh", "-c", "alembic -c backend/alembic.ini upgrade head && python -m kiwi import && uvicorn kiwi.main:app --host 0.0.0.0 --port 8000 --no-proxy-headers"]
