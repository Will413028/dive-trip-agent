# Deposits demo API / worker image. Build from the repository root:
#   docker build -f deploy/deposits-demo/backend.Dockerfile -t dive-deposits-backend .
FROM ghcr.io/astral-sh/uv:0.7.2 AS uv

FROM python:3.13.13-slim-bookworm
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock backend/
RUN uv sync --frozen --no-dev --project backend --no-install-project
COPY backend/src backend/src
COPY migrations migrations
RUN uv sync --frozen --no-dev --project backend \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin deposits
USER 10001
ENTRYPOINT ["/app/backend/.venv/bin/python", "-m", "dive_trip.bootstrap.deposits_runtime"]
