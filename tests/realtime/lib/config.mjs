// Where the realtime CI stack lives. Every port comes from deploy/realtime-ci/rtci.env (the one
// place they are set); the running stack's mode and the seed's ids/tokens come from
// deploy/realtime-ci/.state/ (written by `rtci.sh up` and seed.mjs).
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const stackDir = resolve(repoRoot, 'deploy/realtime-ci')
export const stateDir = resolve(stackDir, '.state')

function readEnvFile(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const env = { ...readEnvFile(resolve(stackDir, 'rtci.env')), ...process.env }
const port = (k) => Number(env[k])
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null)

export const stack = readJson(resolve(stateDir, 'stack.json')) ?? { mode: 'tier' }

export const cfg = {
  mode: String(env.RTCI_MODE_OVERRIDE ?? stack.mode ?? 'tier'),
  image: stack.image ?? null,
  /** Traefik v3 (every suite's default entry) and v2.4 (`--v2` stacks). */
  base: `http://127.0.0.1:${port('RTCI_HTTP_PORT')}`,
  baseV2: `http://127.0.0.1:${port('RTCI_HTTP_V2_PORT')}`,
  toxi: `http://127.0.0.1:${port('RTCI_TOXI_PORT')}`,
  redisUrl: `redis://127.0.0.1:${port('RTCI_REDIS_PORT')}`,
  adminToken: env.RTCI_ADMIN_TOKEN,
  /** Every API process: its direct host port (bypasses Traefik + toxiproxy) and its proxies. */
  nodes: {
    'web-1': { port: port('RTCI_WEB1_PORT'), http: 'web1_http', redis: 'redis_web1', role: 'web' },
    'web-2': { port: port('RTCI_WEB2_PORT'), http: 'web2_http', redis: 'redis_web2', role: 'web' },
    'rt-1': { port: port('RTCI_RT1_PORT'), http: 'rt1_http', redis: 'redis_rt1', role: 'realtime' },
    'rt-2': { port: port('RTCI_RT2_PORT'), http: 'rt2_http', redis: 'redis_rt2', role: 'realtime' },
    worker: { port: port('RTCI_WORKER_PORT'), http: null, redis: 'redis_worker', role: 'worker' }
  }
}

/** The processes that hold sockets in this mode (tier: rt-*, single: web-*). */
export function socketNodes() {
  return cfg.mode === 'tier' ? ['rt-1', 'rt-2'] : ['web-1', 'web-2']
}

export function directUrl(node) {
  return `http://127.0.0.1:${cfg.nodes[node].port}`
}

export function loadSeed() {
  const seed = readJson(resolve(stateDir, 'seed.json'))
  if (!seed) throw new Error('No seed: run `deploy/realtime-ci/rtci.sh up` (or node tests/realtime/seed.mjs)')
  return seed
}

// Dependencies come from the workspace's own packages (pnpm install at the repo root), the same
// way scripts/realtime-load-test.mts resolves them — no package of its own.
const fromSdk = createRequire(resolve(repoRoot, 'packages/sdk/package.json'))
const fromApi = createRequire(resolve(repoRoot, 'api/package.json'))
export const { io } = fromSdk('socket.io-client')
export const Redis = fromApi('ioredis')
