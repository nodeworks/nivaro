/**
 * Hub agent entry point: load the configuration (exit 1 with the ConfigError
 * code only), check the Engine (API ≥ 1.44, this node is a swarm manager,
 * else exit 1 NOT_A_MANAGER) and serve the agent API.
 */
import { readFileSync, realpathSync } from 'node:fs'
import type http from 'node:http'
import type https from 'node:https'
import { fileURLToPath } from 'node:url'
import { type AgentConfig, ConfigError, loadAgentConfig, parseListen } from './config.js'
import { createEngine, type Engine, EngineError, type Transport } from './engine.js'
import { sweepUnpackContainers, sweepUnpackFolders } from './extensions.js'
import { makeHandlers } from './handlers.js'
import { createLog, type Log } from './log.js'
import { FIXED_REPLICA_ROLES, SCALE_CAPS } from './scale.js'
import { createServer, type HandlerResult, type Handlers } from './server.js'
import { createStorageProbe, type StorageProbe, storageOptionsFrom } from './storage.js'
import { isNfsOpts, nfsExport } from './volumes.js'

export const AGENT_VERSION = '0.2.5'
export const MIN_ENGINE_API = [1, 44] as const

export type StartResult =
  | { ok: true; server: http.Server | https.Server; cfg: AgentConfig; engine: Engine }
  | { ok: false; code: string }

/** clusterId: the swarm's id (GET /info Swarm.Cluster.ID), '' when the Engine does not say. */
export type EngineFacts = { engineApi: string; nodeId: string; clusterId?: string }

/** `1.45` ≥ `1.44`. Anything unreadable counts as too old. */
export function engineApiOk(version: unknown): boolean {
  const m = typeof version === 'string' ? /^(\d+)\.(\d+)$/.exec(version) : null
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > MIN_ENGINE_API[0] || (major === MIN_ENGINE_API[0] && minor >= MIN_ENGINE_API[1])
}

export async function checkEngine(
  engine: Engine
): Promise<{ ok: true; facts: EngineFacts } | { ok: false; code: string }> {
  try {
    const v = await engine.call<{ ApiVersion?: string }>('GET', '/version')
    if (v.status !== 200 || !engineApiOk(v.body?.ApiVersion))
      return { ok: false, code: 'ENGINE_TOO_OLD' }
    const info = await engine.call<{
      Swarm?: { ControlAvailable?: boolean; NodeID?: string; Cluster?: { ID?: unknown } }
    }>('GET', '/info')
    if (info.status !== 200 || info.body?.Swarm?.ControlAvailable !== true)
      return { ok: false, code: 'NOT_A_MANAGER' }
    return {
      ok: true,
      facts: {
        engineApi: v.body.ApiVersion as string,
        nodeId: info.body.Swarm.NodeID ?? '',
        clusterId: typeof info.body.Swarm.Cluster?.ID === 'string' ? info.body.Swarm.Cluster.ID : ''
      }
    }
  } catch (err) {
    return { ok: false, code: err instanceof EngineError ? err.code : 'ENGINE_UNREACHABLE' }
  }
}

/**
 * Health only; the stack routes answer 501. `startAgent` uses these unless a
 * caller passes `makeHandlers` — the real entry point (`run`) always does.
 */
/** How long a read of the swarm's node count is reused (health is polled). */
const NODES_TTL_MS = 30_000

export function baseHandlers(
  cfg: AgentConfig,
  facts: EngineFacts,
  engine?: Engine,
  // Enhancement 20: volume storage health (storage.ts), read-only; startAgent builds it from
  // the checked settings. Absent = not configured.
  storage: StorageProbe = createStorageProbe({ path: null, walk: false, kind: 'local' })
): Handlers {
  // P4-33: the node count, read live from GET /info (no new Engine path), cached briefly.
  // null = not read. With more than one node, `local` volumes are per node.
  let nodes: { at: number; n: number | null } | null = null
  const swarmNodes = async (): Promise<number | null> => {
    if (!engine) return null
    if (nodes && Date.now() - nodes.at < NODES_TTL_MS) return nodes.n
    let n: number | null = null
    try {
      const info = await engine.call<{ Swarm?: { Nodes?: unknown } }>('GET', '/info')
      const v = info.status === 200 ? info.body?.Swarm?.Nodes : null
      n = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
    } catch {
      n = null
    }
    nodes = { at: Date.now(), n }
    return n
  }
  const notYet = async (): Promise<HandlerResult> => ({
    status: 501,
    body: { error: 'Not implemented', code: 'NOT_IMPLEMENTED' }
  })
  return {
    health: async () => ({
      status: 200,
      body: {
        api: 1,
        agent_version: AGENT_VERSION,
        engine_api: facts.engineApi,
        swarm: { manager: true, node_id: facts.nodeId, nodes: await swarmNodes() },
        volume_driver: cfg.volumeDriver,
        // 0.2.3: uploads on an NFS export, one folder per stack (shared by every node), whether
        // the agent sees the export to check those folders, and bundled Redis's own driver.
        volume_nfs: nfsExport(cfg) !== null,
        export_mount: cfg.exportMount !== null,
        redis_volume_driver: cfg.redisVolumeDriver,
        // 0.2.3: bundled Redis runs only on nodes with this label (`key=value`); null = anywhere.
        redis_pin_label: cfg.redisPinLabel
          ? `${cfg.redisPinLabel.key}=${cfg.redisPinLabel.value}`
          : null,
        // 0.2.3 (hub gap sqlite, M5): the uploads volume is on network storage (NFS options).
        // SQLite's write-ahead log and file locks are not safe there; the Hub refuses SQLite apps.
        uploads_network: isNfsOpts(cfg.volumeOpts),
        images: cfg.images,
        host_suffixes: cfg.hostSuffixes,
        edge: cfg.edge,
        publish_ports: cfg.publishPorts,
        extensions_shared: cfg.extensionsShared,
        redis_bundled: cfg.redisImage !== null,
        env_prefixes: cfg.envPrefixes,
        // Final review M-7: which Traefik reads the labels (HUB_AGENT_TRAEFIK_VERSION), so the
        // Hub's plans refuse a host pattern on v2 before any apply.
        traefik_version: cfg.traefikVersion,
        // HUB_AGENT_CA_BUNDLE_FILE is set: app services trust its CAs. Never its contents.
        ca_bundle: cfg.caBundle !== null,
        // Enhancement 20: how full the volume storage is; the last reading, never waited on.
        storage: await storage.report(),
        // 0.2.4: POST /v1/stacks/:name/scale and the bounds it holds every role to.
        scale: { ...SCALE_CAPS, fixed_replica_roles: [...FIXED_REPLICA_ROLES] },
        // 0.2.5: HUB_AGENT_TRAEFIK_DYNAMIC_DIR is set, so a stack may carry its own certificate
        // (edge_tls). Never the folder's path.
        edge_tls: cfg.traefikDynamicDir !== null
      }
    }),
    listStacks: notYet,
    getStack: notYet,
    putStack: notYet,
    restartStack: notYet,
    scaleStack: notYet,
    leftovers: notYet,
    deleteStack: notYet
  }
}

export async function startAgent(opts: {
  env: NodeJS.ProcessEnv
  readFile: (p: string) => string
  transport?: Transport
  log?: Log
  makeHandlers?: (
    cfg: AgentConfig,
    engine: Engine,
    facts: EngineFacts,
    storage: StorageProbe
  ) => Handlers
}): Promise<StartResult> {
  let cfg: AgentConfig
  try {
    cfg = loadAgentConfig(opts.env, opts.readFile)
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, code: err.code }
    return { ok: false, code: 'CONFIG_ERROR' }
  }
  const storageOpts = storageOptionsFrom(opts.env, cfg.volumeOpts)
  if (!storageOpts.ok) return { ok: false, code: storageOpts.code }
  const storage = createStorageProbe(storageOpts.value)
  const engine = createEngine(cfg, opts.transport)
  const checked = await checkEngine(engine)
  if (!checked.ok) return checked
  const handlers = (opts.makeHandlers ?? ((c, e, f, st) => baseHandlers(c, f, e, st)))(
    cfg,
    engine,
    checked.facts,
    storage
  )
  const server = createServer(cfg, handlers, { log: opts.log })
  const { host, port } = parseListen(cfg.listen)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch {
    return { ok: false, code: 'LISTEN_FAILED' }
  }
  return { ok: true, server, cfg, engine }
}

async function run(): Promise<void> {
  const log = createLog()
  const r = await startAgent({
    env: process.env,
    readFile: (p) => readFileSync(p, 'utf8'),
    log,
    makeHandlers: (cfg, engine, facts, storage) =>
      makeHandlers(engine, cfg, {
        nodeId: facts.nodeId,
        clusterId: facts.clusterId ?? '',
        health: baseHandlers(cfg, facts, engine, storage).health,
        log
      })
  })
  if (!r.ok) {
    log({ t: new Date().toISOString(), level: 'fatal', code: r.code })
    process.exit(1)
  }
  // Unpack containers a crash left behind (never started; labelled; checked live before delete).
  void sweepUnpackContainers(r.engine, log)
  void sweepUnpackFolders(r.cfg, log)
  log({
    t: new Date().toISOString(),
    level: 'info',
    msg: 'listening',
    version: AGENT_VERSION,
    edge: r.cfg.edge
  })
  const stop = () => {
    r.server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

/** True when this file is the process entry point (symlinks resolved; `node dist/main` works too). */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false
  let self: string
  try {
    self = realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
  for (const candidate of [argv1, `${argv1}.js`]) {
    try {
      if (realpathSync(candidate) === self) return true
    } catch {
      // Not there under that name; try the next.
    }
  }
  return false
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  void run()
}
