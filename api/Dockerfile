# ─── Stage 1: base ───────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable pnpm

# ─── Stage 2: install all dependencies ─────────────────────────────────────── d
FROM base AS deps
WORKDIR /app
# Copy workspace manifests first so pnpm can resolve the workspace
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api/package.json ./api/
COPY admin/package.json ./admin/
COPY sdk/package.json ./sdk/
RUN pnpm install --frozen-lockfile

# ─── Stage 3: build ──────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
# git + bash required for cloud extension injection
RUN apk add --no-cache git bash
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY --from=deps /app/sdk/node_modules ./sdk/node_modules
COPY . .
# Build the SDK first (api may depend on it)
RUN pnpm --filter @nivaro/sdk build
# Inject cloud-only extensions before API build (fail-safe: exits 0 on any error).
# Set CLOUD_EXTENSIONS_REPO and CLOUD_EXTENSIONS_TOKEN as Railway service variables
# (Railway passes all service variables as build ARGs automatically).
ARG CLOUD_EXTENSIONS_REPO=""
ARG CLOUD_EXTENSIONS_TOKEN=""
RUN CLOUD_EXTENSIONS_REPO="$CLOUD_EXTENSIONS_REPO" \
    CLOUD_EXTENSIONS_TOKEN="$CLOUD_EXTENSIONS_TOKEN" \
    bash api/scripts/inject-cloud-extensions.sh
RUN pnpm --filter @nivaro/api build:ci

# ─── Stage 4: production runner ──────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# sharp requires native binaries — install libc compat for alpine
RUN apk add --no-cache libc6-compat

RUN corepack enable pnpm

# Copy workspace manifests for prod install
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api/package.json ./api/
COPY sdk/package.json ./sdk/
# Omit admin package.json — it is not needed at runtime

# Install production deps only
RUN pnpm install --frozen-lockfile --prod --filter @nivaro/api...

# Copy compiled output
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/sdk/dist ./sdk/dist
# Cloud extensions (injected from private repo during build — dir may not exist in OSS builds)
COPY --from=build /app/api/cloud-extensions ./api/cloud-extensions

# Copy runtime assets (mail templates, etc.)
COPY api/templates ./api/templates

# Uploads directory — will be mounted as a volume in compose
RUN mkdir -p /app/uploads

EXPOSE 3055
CMD ["node", "api/dist/index.js"]
