# Build from the monorepo root:  docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @wintek/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @wintek/shared build \
 && pnpm --filter @wintek/api build \
 && pnpm deploy --filter @wintek/api --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S wintek && adduser -S wintek -G wintek
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/migrations ./migrations
COPY --from=build /repo/apps/api/package.json ./
USER wintek
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/v1/system/live || exit 1
# Migrations take an advisory lock, so concurrent replicas starting together are safe.
CMD ["sh", "-c", "node dist/src/common/db/migrate.js && node dist/src/main.js"]
