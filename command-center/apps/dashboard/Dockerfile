# Build from the monorepo root:  docker build -f apps/dashboard/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter @wintek/dashboard...
COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard
# Production images always use the real API.
ENV VITE_DATA_SOURCE=api
RUN pnpm --filter @wintek/dashboard exec vite build

FROM nginx:1.27-alpine
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
COPY infra/nginx/wintek.conf /etc/nginx/conf.d/default.conf
EXPOSE 80 443
