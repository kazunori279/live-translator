FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /workspace

COPY pyproject.toml README.md ./
COPY app ./app
# The panel briefing is built from these at startup. They live outside app/ so
# they read as documents rather than code; panel_agent resolves them relative to
# its own location, which lands here.
COPY knowledge ./knowledge

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir .

WORKDIR /workspace/app

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
