# ─── Stage 1: base ───────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable pnpm

# ─── Stage 2: install all deps ───────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api/package.json ./api/
COPY admin/package.json ./admin/
COPY sdk/package.json ./sdk/
RUN pnpm install --frozen-lockfile

# ─── Stage 3: build ──────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/admin/node_modules ./admin/node_modules
COPY --from=deps /app/sdk/node_modules ./sdk/node_modules
COPY . .
# Build the SDK first in case admin imports from @nivaro/sdk
RUN pnpm --filter @nivaro/sdk build
RUN pnpm --filter @nivaro/admin build

# ─── Stage 4: nginx static server ────────────────────────────────────────────
FROM nginx:alpine AS runner
COPY --from=build /app/admin/dist /usr/share/nginx/html
COPY admin/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
