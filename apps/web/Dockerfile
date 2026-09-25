# syntax=docker/dockerfile:1.7
# docker build -f apps/web/Dockerfile .
# Override to use a registry mirror or pull-through cache.
ARG NODE_IMAGE=node:22-alpine

# ---- build (native arch; the standalone output is portable JS, images are unoptimized so no sharp)
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
RUN corepack enable && pnpm config set store-dir /pnpm/store --global
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@openglass/web..."
COPY apps/web apps/web
COPY docs docs
# Served as static files so /docs/SPEC.md and /docs/openapi.yaml are live, not just
# referenced by skill.md/llms-full.txt — those files must exist at the source of truth
# (docs/) and get copied here, not duplicated by hand.
RUN mkdir -p apps/web/public/docs && cp docs/SPEC.md docs/openapi.yaml apps/web/public/docs/
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @openglass/web build && mkdir -p /empty-cache

# ---- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3002
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# Next writes its cache at runtime; everything else stays root-owned. (COPY, not RUN,
# so the arm64 runtime stage needs no emulation when built on amd64.)
COPY --from=build --chown=node:node /empty-cache ./apps/web/.next/cache
USER node
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
