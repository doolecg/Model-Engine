FROM node:22-slim

# git for the agents' work, ca-certificates for HTTPS to the API
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# dependencies first so the layer caches (npm ci picks the Linux SDK binary)
COPY .claude/live/package.json .claude/live/package-lock.json .claude/live/
RUN npm ci --omit=dev --prefix .claude/live

COPY .claude .claude
COPY CLAUDE.md ./

ENV MODEL_ENGINE_HOST=0.0.0.0 \
    MODEL_ENGINE_PORT=4777 \
    MODEL_ENGINE_STORE=/data/projects.json

# non-root: Claude Code refuses some modes as root
RUN mkdir -p /data /workspace && chown node:node /data /workspace
USER node

VOLUME ["/data"]
EXPOSE 4777

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.MODEL_ENGINE_PORT+'/about').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node",".claude/live/server.js"]
