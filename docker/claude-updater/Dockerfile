FROM node:24-bookworm-slim
ARG CLAUDE_VERSION=2.1.260
ARG DEBIAN_MIRROR=deb.debian.org
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --registry=${NPM_REGISTRY} @anthropic-ai/claude-code@${CLAUDE_VERSION}
LABEL io.harness-rsi.claude-version="${CLAUDE_VERSION}"
COPY controller/src/model-gateway.mjs /opt/harness-rsi/model-gateway.mjs
COPY docker/claude-updater/run.mjs /opt/harness-rsi/run.mjs
ENTRYPOINT ["node", "/opt/harness-rsi/run.mjs"]
