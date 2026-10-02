# syntax=docker/dockerfile:1.7
# Agent Checkup (apps/checkup). Same shape as docker/node-service.Dockerfile, plus the
# design tokens it serves from apps/web:
#   docker build -f apps/checkup/Dockerfile .
ARG NODE_IMAGE=node:22-alpine

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
RUN corepack enable && pnpm config set store-dir /pnpm/store --global
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY apps/checkup/package.json apps/checkup/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@openglass/checkup..."
COPY packages/db packages/db
COPY apps/checkup apps/checkup
COPY apps/web/app/tokens.css apps/web/app/tokens.css
RUN pnpm --filter "@openglass/checkup..." build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@openglass/checkup" deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3004
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3004
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
