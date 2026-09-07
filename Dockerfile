# Tantalar — single image (story 28): Node LTS + ffmpeg, SQLite default,
# PostgreSQL via config/secret. Build from the repo root:
#   docker build --build-arg TANTALAR_BUILD_VERSION=<version> -t tantalar:<version> .
# Run (SQLite):
#   docker run -p 8790:8790 -v tantalar-data:/data tantalar:<version>
# See docs/deploy.md for PostgreSQL mode and compose examples.

ARG TANTALAR_BUILD_VERSION=0.0.1-alpha.0
ARG TANTALAR_BUILD_REVISION=""
ARG TANTALAR_BUILD_DATE=""

FROM node:22-bookworm-slim AS build
ARG TANTALAR_BUILD_VERSION
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
COPY scripts ./scripts
COPY Dockerfile README.md ./
COPY docker/compose.sqlite.yml docker/compose.postgres.yml ./docker/
COPY docs/release.md docs/deploy.md ./docs/
RUN node scripts/version.mjs assert "$TANTALAR_BUILD_VERSION"
RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN pnpm --filter @tantalar/web run build
RUN CI=true pnpm install --prod --frozen-lockfile

FROM node:22-bookworm-slim
ARG TANTALAR_BUILD_VERSION
ARG TANTALAR_BUILD_REVISION
ARG TANTALAR_BUILD_DATE
LABEL org.opencontainers.image.title="Tantalar" \
      org.opencontainers.image.version="$TANTALAR_BUILD_VERSION" \
      org.opencontainers.image.revision="$TANTALAR_BUILD_REVISION" \
      org.opencontainers.image.created="$TANTALAR_BUILD_DATE" \
      org.opencontainers.image.source="https://github.com/nerkza/tantalar"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production \
    TANTALAR_CONFIG_FILE=/config/tantalar.yaml \
    TANTALAR_DATA_DIR=/data \
    TANTALAR_BUILD_VERSION=$TANTALAR_BUILD_VERSION \
    TANTALAR_BUILD_COMMIT=$TANTALAR_BUILD_REVISION \
    TANTALAR_BUILD_DATE=$TANTALAR_BUILD_DATE
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
