# Nivaro Hub agent image.
#
# Build (repo root as the context):
#   docker build -f deploy/hub-agent/Dockerfile -t nivaro-hub-agent:dev .
#
# The agent runs as root on purpose: it is the one process that reads and writes
# the Docker socket of a swarm manager, and the socket's access path is owned by
# root. Capabilities are dropped by the stack (cap_drop: ALL), which is enough.
# HEALTHCHECK is a TCP connect to the listen port: /v1/health needs the token.

FROM node:22-alpine AS base
RUN corepack enable pnpm

# ─── Build: the agent only, never the rest of the monorepo ───────────────────
FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/hub-agent/package.json ./packages/hub-agent/
RUN pnpm install --frozen-lockfile --filter @nivaro/hub-agent...
COPY tsconfig.base.json ./
COPY packages/hub-agent/tsconfig.json ./packages/hub-agent/
COPY packages/hub-agent/src ./packages/hub-agent/src
RUN pnpm --filter @nivaro/hub-agent build

# ─── A self-contained production tree (real node_modules, no workspace links) ─
FROM build AS prod
RUN pnpm --filter @nivaro/hub-agent deploy --legacy --prod /out

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=prod /out/node_modules ./node_modules
COPY --from=prod /out/package.json ./package.json
COPY --from=build /app/packages/hub-agent/dist ./dist
EXPOSE 7480
# 15 s timeout, 3 retries, 30 s start: a loaded host must not get the agent killed (P4-34).
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
