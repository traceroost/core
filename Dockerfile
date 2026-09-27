# ── Build stage ────────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@10

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY esbuild.js tsconfig.json ./
COPY scripts/check-edition.mjs ./scripts/
COPY src/ ./src/
COPY standalone/ ./standalone/
COPY media/src/ ./media/src/
COPY media/tsconfig.json ./media/
COPY media/mascot.png ./media/
# dashboard.tsx imports packages/styles/src/pills.css (shared with traceroost-cloud) by relative
# path — esbuild needs it on disk even though it's not in any COPYed package.json's dependencies.
COPY packages/styles/ ./packages/styles/

# core (the default until TraceRoost Pro launches) builds with no org-link/upload code at all, and
# fails the image build if any reached a bundle; full includes it. See runbooks/RELEASING.md →
# "Editions". docker.yml passes the release's edition: `--build-arg EDITION=full`.
ARG EDITION=core
RUN node esbuild.js --production --edition=$EDITION \
 && node scripts/check-edition.mjs $EDITION --skip-manifest
# sql.js is bundled into server.js, but it locates its .wasm via require.resolve('sql.js') at
# runtime — ship a real (symlink-free) copy of the package so that lookup works in the image.
RUN mkdir -p /app/runtime_modules && cp -rL node_modules/sql.js /app/runtime_modules/sql.js

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app
ARG EDITION=core
LABEL org.traceroost.edition=$EDITION

RUN addgroup -S traceroost && adduser -S traceroost -G traceroost

COPY --from=builder --chown=traceroost:traceroost /app/standalone/server.js ./standalone/server.js
# Everything standalone/server.js serves from media/: /dashboard.js, /dashboard.css, /sidebar.js,
# /mascot.png (favicon).
COPY --from=builder --chown=traceroost:traceroost /app/media/dashboard.js   ./media/dashboard.js
COPY --from=builder --chown=traceroost:traceroost /app/media/dashboard.css  ./media/dashboard.css
COPY --from=builder --chown=traceroost:traceroost /app/media/sidebar.js     ./media/sidebar.js
COPY --from=builder --chown=traceroost:traceroost /app/media/mascot.png     ./media/mascot.png
COPY --from=builder --chown=traceroost:traceroost /app/runtime_modules/     ./node_modules/
COPY --from=builder --chown=traceroost:traceroost /app/package.json        ./package.json

RUN mkdir -p /data && chown traceroost:traceroost /data
VOLUME ["/data"]

USER traceroost

# HOME=/data puts ~/.traceroost/config.json — which holds the generated bearer token — on the
# volume, so the token survives container re-creation instead of changing (and 401-ing every
# configured agent) on each `docker run`. BIND_HOST=0.0.0.0 makes that token mandatory on all
# three ports; see README → Docker for how to read it and hand it to agents.
ENV OTLP_PORT=4318 \
    UI_PORT=3000 \
    MCP_PORT=4316 \
    DATA_DIR=/data \
    HOME=/data \
    BIND_HOST=0.0.0.0

EXPOSE 4318 3000 4316

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["sh", "-c", "wget -qO- \"http://localhost:${UI_PORT:-3000}/health\" || exit 1"]

CMD ["node", "standalone/server.js"]
