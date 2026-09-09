FROM python:3.12-slim-bookworm

ARG DEBIAN_MIRROR=https://mirrors.aliyun.com/debian
ARG PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN sed -i "s#http://deb.debian.org/debian#${DEBIAN_MIRROR}#g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       libreoffice-writer libreoffice-calc libreoffice-impress \
       poppler-utils fonts-noto-cjk fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --index-url "${PYPI_INDEX_URL}" \
    python-docx==1.2.0 lxml==5.4.0 openpyxl==3.1.5 \
    python-pptx==1.0.2 Pillow==11.2.1 pypinyin==0.55.0 \
    numpy==2.3.2 pandas==2.3.2

ARG COWORK_BENCH_RUNTIME_REVISION=unknown
LABEL io.harness-rsi.runtime="cowork-bench-docker-v1" \
      io.harness-rsi.cowork-bench-runtime-revision="${COWORK_BENCH_RUNTIME_REVISION}"

COPY docker/cowork-bench/run-verifier.py /opt/harness-rsi/run-cowork-bench-verifier.py
ENTRYPOINT []
