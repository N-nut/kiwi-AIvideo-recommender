FROM python:3.13.9-slim
WORKDIR /app
ENV KIWI_PROJECT_ROOT=/app
COPY backend/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir -r requirements.lock
COPY backend /app/backend
COPY data /app/data
RUN pip install --no-deps /app/backend && useradd --create-home kiwi && chown -R kiwi:kiwi /app
USER kiwi
EXPOSE 8000
CMD ["sh", "-c", "alembic -c backend/alembic.ini upgrade head && python -m kiwi import && uvicorn kiwi.main:app --host 0.0.0.0 --port 8000 --no-proxy-headers"]
