# syntax=docker/dockerfile:1.7
# Multi-stage image for the Node services (api, mcp, worker):
#   docker build -f docker/node-service.Dockerfile --build-arg APP=api --build-arg APP_PORT=3000 .
# Override to use a registry mirror or pull-through cache.
ARG NODE_IMAGE=node:22-alpine

# ---- build: runs on the builder's native arch. Output is plain JS and our prod
# dependencies are pure JS, so it's portable to the arm64 runtime without QEMU.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG APP
RUN test -n "$APP" || (echo "APP build arg is required" && false)
RUN corepack enable && pnpm config set store-dir /pnpm/store --global
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY apps/${APP}/package.json apps/${APP}/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@openglass/${APP}..."
COPY packages/db packages/db
COPY apps/${APP} apps/${APP}
RUN pnpm --filter "@openglass/${APP}..." build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@openglass/${APP}" deploy --legacy --prod /out

# ---- runtime
FROM ${NODE_IMAGE} AS runtime
ARG APP_PORT=3000
ENV NODE_ENV=production \
    PORT=${APP_PORT}
WORKDIR /app
# Files stay root-owned (read-only for the app user).
COPY --from=build /out ./
USER node
EXPOSE ${APP_PORT}
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
