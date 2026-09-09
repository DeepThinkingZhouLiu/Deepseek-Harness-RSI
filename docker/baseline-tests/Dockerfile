FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 git bubblewrap util-linux \
    && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /repo
CMD ["node", "--test", "controller/test/cowork-baselines.test.mjs", "controller/test/updater-runner.test.mjs"]
