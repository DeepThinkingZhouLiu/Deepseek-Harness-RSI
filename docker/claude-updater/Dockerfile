FROM node:24-bookworm-slim
ARG CLAUDE_VERSION=2.1.260
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @anthropic-ai/claude-code@${CLAUDE_VERSION}
LABEL io.harness-rsi.claude-version="${CLAUDE_VERSION}"
COPY controller/src/model-gateway.mjs /opt/harness-rsi/model-gateway.mjs
COPY docker/claude-updater/run.mjs /opt/harness-rsi/run.mjs
ENTRYPOINT ["node", "/opt/harness-rsi/run.mjs"]
