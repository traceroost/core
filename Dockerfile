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
COPY media/dashboard.css media/help-mascot.png media/mascot.png ./media/

RUN node esbuild.js --production

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

RUN addgroup -S traceroost && adduser -S traceroost -G traceroost

COPY --from=builder --chown=traceroost:traceroost /app/standalone/server.js ./standalone/server.js
COPY --from=builder --chown=traceroost:traceroost /app/media/dashboard.js   ./media/dashboard.js
COPY --from=builder --chown=traceroost:traceroost /app/media/dashboard.css  ./media/dashboard.css
COPY --from=builder --chown=traceroost:traceroost /app/media/help-mascot.png ./media/help-mascot.png
COPY --from=builder --chown=traceroost:traceroost /app/media/mascot.png     ./media/mascot.png

RUN mkdir -p /data && chown traceroost:traceroost /data
VOLUME ["/data"]

USER traceroost

ENV OTLP_PORT=4318 \
    UI_PORT=3000 \
    DATA_DIR=/data \
    BIND_HOST=0.0.0.0

EXPOSE 4318 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "standalone/server.js"]
