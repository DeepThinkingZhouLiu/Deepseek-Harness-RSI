FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libreoffice-writer libreoffice-calc libreoffice-impress \
       poppler-utils fonts-noto-cjk fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir \
    python-docx==1.2.0 lxml==5.4.0 openpyxl==3.1.5 \
    python-pptx==1.0.2 Pillow==11.2.1

ARG COWORK_BENCH_RUNTIME_REVISION=unknown
LABEL io.harness-rsi.runtime="cowork-bench-docker-v1" \
      io.harness-rsi.cowork-bench-runtime-revision="${COWORK_BENCH_RUNTIME_REVISION}"

COPY docker/cowork-bench/run-verifier.py /opt/harness-rsi/run-cowork-bench-verifier.py
ENTRYPOINT []
