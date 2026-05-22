# ── Stage 1: build the React frontend ────────────────────────────────────
FROM node:20-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


# ── Stage 2: Python runtime ───────────────────────────────────────────────
FROM python:3.11-slim
WORKDIR /app

COPY pyproject.toml ./
COPY src/ src/
RUN pip install --no-cache-dir .

COPY --from=frontend-build /build/dist ./frontend/dist

EXPOSE 8000

CMD ["rt-platform", "-c", "config.toml"]
