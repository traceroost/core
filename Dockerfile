# ── Build stage ────────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@10

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY esbuild.js tsconfig.json ./
COPY src/ ./src/
COPY standalone/ ./standalone/
COPY media/src/ ./media/src/
COPY media/tsconfig.json ./media/
# media/dashboard.css isn't copied: it's build output (esbuild bundles media/src/styles), not a
# tracked file, and the build below generates it.
COPY media/help-mascot.png media/mascot.png ./media/

RUN node esbuild.js --production

# The server loads sql.js at runtime (OpenCode's SQLite database) via require.resolve, so ship
# the package's files next to the bundle, as main's Dockerfile does.
RUN mkdir -p /app/runtime_modules && cp -rL node_modules/sql.js /app/runtime_modules/sql.js

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

RUN addgroup -S agentlens && adduser -S agentlens -G agentlens

COPY --from=builder --chown=agentlens:agentlens /app/standalone/server.js ./standalone/server.js
COPY --from=builder --chown=agentlens:agentlens /app/media/dashboard.js   ./media/dashboard.js
COPY --from=builder --chown=agentlens:agentlens /app/media/dashboard.css  ./media/dashboard.css
COPY --from=builder --chown=agentlens:agentlens /app/media/help-mascot.png ./media/help-mascot.png
COPY --from=builder --chown=agentlens:agentlens /app/media/mascot.png     ./media/mascot.png
COPY --from=builder --chown=agentlens:agentlens /app/runtime_modules/     ./node_modules/
# server.js reads its version from ../package.json at startup.
COPY --from=builder --chown=agentlens:agentlens /app/package.json        ./package.json

RUN mkdir -p /data && chown agentlens:agentlens /data
VOLUME ["/data"]

USER agentlens

ENV OTLP_PORT=4318 \
    UI_PORT=3000 \
    DATA_DIR=/data \
    BIND_HOST=0.0.0.0

EXPOSE 4318 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "standalone/server.js"]
