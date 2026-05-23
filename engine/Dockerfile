# ModPilot Investigation Engine — HuggingFace Spaces Docker image.
# HF Spaces requires: listen on port 7860, run as uid 1000.

FROM python:3.11-slim

RUN useradd -m -u 1000 user
ENV PATH="/home/user/.local/bin:/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_LINK_MODE=copy

RUN mkdir -p /app && chown user:user /app
WORKDIR /app

USER user

# Install uv in the user-local bin dir so the venv it creates is user-owned.
RUN pip install --user --no-cache-dir uv==0.5.11

# Layer-cache: deps first, source second.
COPY --chown=user:user pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY --chown=user:user . /app

EXPOSE 7860

# Apply any pending Alembic revisions on boot, then serve. Failures fail
# the container so HF surfaces the error in its build logs.
CMD ["sh", "-c", "alembic upgrade head && uvicorn api.main:app --host 0.0.0.0 --port 7860"]
