// A validated StackSpec → swarm service specs (Engine API ServiceSpec).
// Pure: no I/O. The agent's stack operations create the network, secrets and
// extension folders first and pass their ids / paths in `ctx`.
//
// What a rendered service can never hold: Privileged, CapabilityAdd, host
// networking, a bind mount other than a read-only extension folder under the
// agent's extension root, or a published port other than web's in publish
// mode. Nothing in the spec can ask for them — the schema is closed — and the
// renderer never writes them.
import { posix } from 'node:path'
import {
  isStackName,
  LABEL_HOSTS,
  LABEL_ROLE,
  LABEL_SPEC_HASH,
  ownershipLabels,
  redisVolume,
  serviceName,
  uploadsVolume
} from './names.js'
import type { Role, StackSpec } from './spec.js'

/** The part of AgentConfig rendering reads (a full AgentConfig satisfies it). */
export type RenderConfig = {
  edge: 'traefik' | 'publish'
  edgeNetwork: string
  /** 3 when absent (the agent's default): see AgentConfig.traefikVersion. */
  traefikVersion?: 2 | 3
  entrypoints: readonly string[]
  certResolver?: string | null
  extensionsShared: boolean
  extensionsHostRoot: string
  volumeDriver: string
  volumeOpts?: Record<string, string> | null
  redisImage: string | null
}

export type RenderContext = {
  hash: string
  secretIds: Record<string, { id: string; name: string }>
  extensionPaths: Record<string, string>
  agentNodeId: string
  network: string
  /**
   * The agent's CA bundle secret for this stack (HUB_AGENT_CA_BUNDLE_FILE, names.caBundleSecretName).
   * Absent = no bundle: the rendered services are exactly what they were before the option.
   */
  caBundle?: { id: string; name: string }
}

export type EngineMount =
  | {
      Type: 'volume'
      Source: string
      Target: string
      VolumeOptions: {
        Labels: Record<string, string>
        DriverConfig: { Name: string; Options: Record<string, string> }
      }
    }
  | { Type: 'bind'; Source: string; Target: string; ReadOnly: true }

export type EngineSecretRef = {
  SecretID: string
  SecretName: string
  File: { Name: string; UID: string; GID: string; Mode: number }
}

export type EngineServiceSpec = {
  Name: string
  Labels: Record<string, string>
  TaskTemplate: {
    ContainerSpec: {
      Image: string
      Env: string[]
      Labels: Record<string, string>
      Secrets: EngineSecretRef[]
      Mounts: EngineMount[]
    }
    Resources: { Limits?: { NanoCPUs?: number; MemoryBytes?: number } }
    RestartPolicy: { Condition: 'any' }
    Placement?: { Constraints: string[] }
    Networks: Array<{ Target: string }>
  }
  Mode: { Replicated: { Replicas: number } }
  UpdateConfig: {
    Parallelism: number
    Delay: number
    Order: 'start-first'
    FailureAction: 'rollback'
    Monitor: number
  }
  RollbackConfig: { Parallelism: number; Order: 'start-first' }
  EndpointSpec?: { Ports: Array<{ TargetPort: number; PublishedPort: number }> }
}

/** The port Nivaro serves on inside the container. */
export const APP_PORT = 3055
export const UPLOADS_PATH = '/app/uploads'
export const EXTENSIONS_PATH = '/app/api/extensions'
/** Where swarm mounts a service's secrets. */
export const SECRETS_PATH = '/run/secrets'
/**
 * The env the agent sets to its CA bundle file on every app service. It is NOT in
 * AGENT_SET_ENV_KEYS (the Hub mirrors that list): a spec never reaches it because the NODE_*
 * deny rule (spec.ts forbiddenEnvKey) refuses it as env and as a secret; only the agent's own
 * configuration (HUB_AGENT_CA_BUNDLE_FILE) puts it here.
 */
export const CA_BUNDLE_ENV = 'NODE_EXTRA_CA_CERTS'

/**
 * Owner of the secret files under /run/secrets. The image's entrypoint steps
 * down from root to uid 1000 before Node starts, so the files belong to uid
 * 1000 (mode 0400): a root-owned 0400 file could not be read by the server.
 */
export const SECRET_FILE_OWNER = { UID: '1000', GID: '1000', Mode: 0o400 } as const

const UPDATE_CONFIG = {
  Parallelism: 1,
  Delay: 10e9,
  Order: 'start-first',
  FailureAction: 'rollback',
  Monitor: 60e9
} as const
const ROLLBACK_CONFIG = { Parallelism: 1, Order: 'start-first' } as const

const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

/** A host path for an extension bind: absolute, normalized, strictly under the root. */
function extensionSource(root: string, path: string): string {
  const normRoot = posix.normalize(root).replace(/\/+$/, '')
  if (!posix.isAbsolute(normRoot) || normRoot === '' || normRoot === '/') {
    throw new Error('renderServices: extension root must be an absolute folder')
  }
  if (typeof path !== 'string' || !posix.isAbsolute(path) || path.includes('\0')) {
    throw new Error('renderServices: extension path must be absolute')
  }
  const norm = posix.normalize(path)
  if (norm !== path.replace(/\/+$/, '') || !norm.startsWith(`${normRoot}/`)) {
    throw new Error('renderServices: extension path outside the extension root')
  }
  return norm
}

/**
 * Traefik router/service names. `_` separates the parts because a stack name
 * cannot hold one, so no two stacks (or roles) share a name: with `-`, stack
 * `x` realtime and stack `x-rt` web were both `nvh-x-rt`. Traefik takes any
 * characters but `.` and `@` in a label-defined router name.
 * The realtime router carries no explicit priority: its rule is the web rule
 * plus `&& PathPrefix(...)`, always longer, and Traefik ranks by rule length.
 */
/**
 * Paths the realtime role serves when web runs SOCKETS=off (`large`): Socket.io, graphql-ws and
 * the SSE streams. The twin of the API's REALTIME_PROXY_PATHS (services/process-role.ts) and of
 * deploy/realtime/docker-compose.yml; an API guard test compares them.
 */
export const REALTIME_PATHS: readonly string[] = [
  '/socket.io/',
  '/api/graphql-ws',
  '/api/graphql/stream',
  '/api/events/stream',
  '/api/events/views/:id/stream'
]

/** One path as a Traefik v3 matcher (a `:param` segment = one non-empty segment). */
function pathMatcher(path: string): string {
  if (path.endsWith('/')) return `PathPrefix(\`${path}\`)`
  if (!path.includes('/:')) return `Path(\`${path}\`)`
  const re = path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return `PathRegexp(\`^${re}$\`)`
}

/** The realtime router's path part: every REALTIME_PATHS entry, OR'd. */
export const realtimePathRule = (): string => `(${REALTIME_PATHS.map(pathMatcher).join(' || ')})`

export const webRouterName = (stack: string) => `nvh_web_${stack}`
export const realtimeRouterName = (stack: string) => `nvh_rt_${stack}`
/** A shared deployment's catch-all router (phase 6); it serves through the web service. */
export const patternRouterName = (stack: string) => `nvh_pat_${stack}`
/** A shared deployment's catch-all for the live paths (0.2.2); it serves through realtime. */
export const realtimePatternRouterName = (stack: string) => `nvh_rtpat_${stack}`

/** `*.<name>`, <name> a lowercase DNS name of ≥ 2 labels (the validator also checks suffixes). */
const HOST_PATTERN_RE =
  /^\*\.(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * The pattern router's rule: Traefik v3 HostRegexp syntax (a Go regexp; v2 used `{name:re}`
 * templates and would read this differently — shared deployments need Traefik v3). One DNS
 * label in front of the escaped name, anchored both ends: `*.apps.corp` matches `x.apps.corp`,
 * never `a.b.apps.corp` or `x.apps.corp.evil.com`.
 */
export function patternRule(pattern: string): string {
  const name = pattern.slice(2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `HostRegexp(\`^[a-z0-9-]+\\.${name}$\`)`
}

function traefikLabels(
  stack: string,
  role: Role,
  hostnames: string[],
  pattern: string | undefined,
  cfg: RenderConfig
): Record<string, string> {
  if (cfg.edge !== 'traefik' || (hostnames.length === 0 && !pattern)) return {}
  const hosts = hostnames.map((h) => `Host(\`${h}\`)`).join(' || ')
  const tls = (router: string): Record<string, string> => {
    const out: Record<string, string> = {
      [`traefik.http.routers.${router}.entrypoints`]: cfg.entrypoints.join(','),
      [`traefik.http.routers.${router}.tls`]: 'true'
    }
    if (cfg.certResolver) out[`traefik.http.routers.${router}.tls.certresolver`] = cfg.certResolver
    return out
  }
  // Exactly one provider spelling (ruling P6-34): Traefik v3 skips a service carrying both
  // ("both Docker and Swarm labels are defined"). v3 reads swarm services through its swarm
  // provider; v2's docker provider (swarm mode) reads the docker one.
  const base = {
    'traefik.enable': 'true',
    [cfg.traefikVersion === 2 ? 'traefik.docker.network' : 'traefik.swarm.network']: cfg.edgeNetwork
  }
  if (role === 'web' || role === 'all') {
    const r = webRouterName(stack)
    const out: Record<string, string> = {
      ...base,
      [`traefik.http.services.${r}.loadbalancer.server.port`]: String(APP_PORT)
    }
    if (hostnames.length > 0) {
      Object.assign(out, {
        [`traefik.http.routers.${r}.rule`]: hosts,
        ...tls(r),
        [`traefik.http.routers.${r}.service`]: r
      })
    }
    if (pattern) {
      // priority=1: any Host() router (Traefik ranks by rule length, always > 1 here) beats it,
      // so an app with its own name on another stack keeps that name.
      const p = patternRouterName(stack)
      Object.assign(out, {
        [`traefik.http.routers.${p}.rule`]: patternRule(pattern),
        [`traefik.http.routers.${p}.priority`]: '1',
        ...tls(p),
        [`traefik.http.routers.${p}.service`]: r
      })
      // HostRegexp gives ACME no name to ask for: a wildcard certificate (DNS challenge on the
      // resolver) covers every name the pattern matches.
      if (cfg.certResolver) out[`traefik.http.routers.${p}.tls.domains[0].main`] = pattern
    }
    return out
  }
  if (role === 'realtime') {
    const r = realtimeRouterName(stack)
    const lb = `traefik.http.services.${r}.loadbalancer`
    // Label order as before 0.2.2 for an app stack (routers, then the service).
    const out: Record<string, string> = { ...base }
    if (hostnames.length > 0)
      Object.assign(out, {
        [`traefik.http.routers.${r}.rule`]: `(${hosts}) && ${realtimePathRule()}`,
        ...tls(r),
        [`traefik.http.routers.${r}.service`]: r
      })
    Object.assign(out, {
      [`${lb}.server.port`]: String(APP_PORT),
      [`${lb}.sticky.cookie`]: 'true',
      [`${lb}.sticky.cookie.name`]: 'nvh_rt',
      [`${lb}.sticky.cookie.secure`]: 'true',
      [`${lb}.sticky.cookie.httponly`]: 'true'
    })
    if (pattern) {
      // A shared deployment's names under its pattern: the pattern router's live paths.
      // priority=2 beats the web pattern router (1) and, like it, loses to any Host() router
      // (ranked by rule length), so an app with its own name on another stack keeps that name.
      const p = realtimePatternRouterName(stack)
      Object.assign(out, {
        [`traefik.http.routers.${p}.rule`]: `${patternRule(pattern)} && ${realtimePathRule()}`,
        [`traefik.http.routers.${p}.priority`]: '2',
        ...tls(p),
        [`traefik.http.routers.${p}.service`]: r
      })
      // As the web pattern router: the wildcard name to ask the resolver for.
      if (cfg.certResolver) out[`traefik.http.routers.${p}.tls.domains[0].main`] = pattern
    }
    return out
  }
  return {}
}

function envList(entries: Map<string, string>): string[] {
  return [...entries].map(([k, v]) => `${k}=${v}`)
}

export function renderServices(
  stack: string,
  spec: StackSpec,
  cfg: RenderConfig,
  ctx: RenderContext
): EngineServiceSpec[] {
  if (!isStackName(stack)) throw new Error('renderServices: bad stack name')
  for (const h of spec.hostnames) {
    if (!HOSTNAME_RE.test(h)) throw new Error('renderServices: bad hostname')
  }
  if (spec.host_pattern !== undefined) {
    if (!('shared' in spec.owner)) throw new Error('renderServices: a pattern needs a shared owner')
    if (!HOST_PATTERN_RE.test(spec.host_pattern)) {
      throw new Error('renderServices: bad host pattern')
    }
  }
  const bundled = spec.redis === 'bundled'
  if (bundled && !cfg.redisImage) throw new Error('renderServices: no redis image configured')

  const owner = ownershipLabels(stack, spec)
  const labelsFor = (role: string) => ({
    ...owner,
    [LABEL_SPEC_HASH]: ctx.hash,
    [LABEL_ROLE]: role
  })
  const volumeMount = (source: string, target: string): EngineMount => ({
    Type: 'volume',
    Source: source,
    Target: target,
    VolumeOptions: {
      Labels: { ...owner },
      DriverConfig: { Name: cfg.volumeDriver, Options: { ...(cfg.volumeOpts ?? {}) } }
    }
  })

  const secrets: EngineSecretRef[] = Object.keys(spec.secrets)
    .sort()
    .map((key) => {
      const ref = ctx.secretIds[key]
      if (!ref) throw new Error('renderServices: a secret has no swarm secret')
      return {
        SecretID: ref.id,
        SecretName: ref.name,
        File: {
          Name: key,
          UID: SECRET_FILE_OWNER.UID,
          GID: SECRET_FILE_OWNER.GID,
          Mode: SECRET_FILE_OWNER.Mode
        }
      }
    })

  // The agent's CA bundle (app services only; never Redis, never an unpack container).
  const ca = ctx.caBundle
  if (ca && (!ca.name.startsWith(`nvh_${stack}_`) || ca.name.includes('/'))) {
    throw new Error('renderServices: bad CA bundle secret')
  }
  const caRef: EngineSecretRef | null = ca
    ? {
        SecretID: ca.id,
        SecretName: ca.name,
        File: {
          Name: ca.name,
          UID: SECRET_FILE_OWNER.UID,
          GID: SECRET_FILE_OWNER.GID,
          Mode: SECRET_FILE_OWNER.Mode
        }
      }
    : null

  const extIds = Object.keys(spec.extensions).sort()
  const extMounts: EngineMount[] = extIds.map((id) => {
    if (!EXTENSION_ID_RE.test(id)) throw new Error('renderServices: bad extension id')
    const path = ctx.extensionPaths[id]
    if (path === undefined) throw new Error('renderServices: an extension has no prepared folder')
    return {
      Type: 'bind',
      Source: extensionSource(cfg.extensionsHostRoot, path),
      Target: `${EXTENSIONS_PATH}/${id}`,
      ReadOnly: true
    }
  })
  const pinToAgent = extIds.length > 0 && !cfg.extensionsShared

  const services: EngineServiceSpec[] = spec.roles.map((r) => {
    const env = new Map<string, string>()
    for (const k of Object.keys(spec.env).sort()) env.set(k, spec.env[k])
    // Every key set from here on is in AGENT_SET_ENV_KEYS (spec.ts), which the
    // validator refuses from the spec; render.test.ts holds the two together.
    for (const [k, v] of Object.entries(r.env ?? {})) env.set(k, v)
    if (r.role !== 'all') env.set('NIVARO_ROLE', r.role)
    else env.delete('NIVARO_ROLE')
    if (bundled) env.set('REDIS_URL', `redis://${serviceName(stack, 'redis')}:6379`)
    env.set('STORAGE_LOCAL_ROOT', UPLOADS_PATH)
    if (caRef) env.set(CA_BUNDLE_ENV, `${SECRETS_PATH}/${caRef.File.Name}`)

    const limits: { NanoCPUs?: number; MemoryBytes?: number } = {}
    if (r.cpus !== undefined) limits.NanoCPUs = Math.round(r.cpus * 1e9)
    if (r.memory_mb !== undefined) limits.MemoryBytes = r.memory_mb * 1024 * 1024

    const onEdge =
      cfg.edge === 'traefik' && (r.role === 'web' || r.role === 'all' || r.role === 'realtime')
    const labels = labelsFor(r.role)
    const svc: EngineServiceSpec = {
      Name: serviceName(stack, r.role),
      Labels: {
        ...labels,
        ...traefikLabels(stack, r.role, spec.hostnames, spec.host_pattern, cfg),
        // The host claim the template's forced command reads (LABEL_HOSTS), on the service that
        // serves the names, whatever the edge.
        ...((r.role === 'web' || r.role === 'all') && spec.hostnames.length > 0
          ? { [LABEL_HOSTS]: spec.hostnames.join(',') }
          : {})
      },
      TaskTemplate: {
        ContainerSpec: {
          Image: spec.image,
          Env: envList(env),
          Labels: { ...labels },
          Secrets: [...secrets, ...(caRef ? [caRef] : [])].map((s) => ({
            ...s,
            File: { ...s.File }
          })),
          Mounts: [
            volumeMount(uploadsVolume(stack), UPLOADS_PATH),
            ...extMounts.map((m) => ({ ...m }))
          ]
        },
        Resources: Object.keys(limits).length > 0 ? { Limits: limits } : {},
        RestartPolicy: { Condition: 'any' },
        Networks: onEdge
          ? [{ Target: ctx.network }, { Target: cfg.edgeNetwork }]
          : [{ Target: ctx.network }]
      },
      Mode: { Replicated: { Replicas: r.replicas } },
      UpdateConfig: { ...UPDATE_CONFIG },
      RollbackConfig: { ...ROLLBACK_CONFIG }
    }
    if (pinToAgent) svc.TaskTemplate.Placement = { Constraints: [`node.id==${ctx.agentNodeId}`] }
    if (
      cfg.edge === 'publish' &&
      (r.role === 'web' || r.role === 'all') &&
      spec.publish_port !== undefined
    ) {
      svc.EndpointSpec = { Ports: [{ TargetPort: APP_PORT, PublishedPort: spec.publish_port }] }
    }
    return svc
  })

  if (bundled) {
    const labels = labelsFor('redis')
    services.push({
      Name: serviceName(stack, 'redis'),
      Labels: { ...labels },
      TaskTemplate: {
        ContainerSpec: {
          Image: cfg.redisImage as string,
          Env: [],
          Labels: { ...labels },
          Secrets: [],
          Mounts: [volumeMount(redisVolume(stack), '/data')]
        },
        Resources: {},
        RestartPolicy: { Condition: 'any' },
        Networks: [{ Target: ctx.network }]
      },
      Mode: { Replicated: { Replicas: 1 } },
      UpdateConfig: { ...UPDATE_CONFIG },
      RollbackConfig: { ...ROLLBACK_CONFIG }
    })
  }
  return services
}
