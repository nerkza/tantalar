# Tantalar v1 — single image (story 28): Node LTS + ffmpeg, SQLite default,
# PostgreSQL via config/secret. Build from the repo root:
#   docker build -t tantalar:v1 .
# Run (SQLite):
#   docker run -p 8790:8790 -v tantalar-data:/data tantalar:v1
# See docs/deploy.md for PostgreSQL mode and compose examples.

FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN pnpm --filter @tantalar/web run build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production \
    TANTALAR_CONFIG_FILE=/config/tantalar.yaml \
    TANTALAR_DATA_DIR=/data
COPY --from=build /app ./

COPY docker/entrypoint.sh /usr/local/bin/tantalar-entrypoint
RUN chmod +x /usr/local/bin/tantalar-entrypoint \
  && mkdir -p /data /config \
  && ln -s /data /app/data

EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:${TANTALAR_PORT:-8790}/healthz || exit 1

ENTRYPOINT ["tantalar-entrypoint"]
CMD ["server"]
