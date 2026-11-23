/**
 * Hub agent configuration, read once at start from HUB_AGENT_* settings.
 *
 * Secrets (token, HMAC key, TLS key, volume options, registry auth) are only
 * ever read from files. A ConfigError carries a code and nothing else: no
 * value, no path, so a failed start never prints a secret.
 */

import { parsePinned } from './image-ref.js'
import { operatorPrefixConflict } from './spec.js'

export class ConfigError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'ConfigError'
    this.code = code
  }
}

export type AgentConfig = {
  token: string
  hmacKey: string
  listen: string
  tls?: { cert: string; key: string }
  socket: string
  /** Image repositories (no tag, no digest) a StackSpec may name. */
  images: string[]
  edge: 'traefik' | 'publish'
  edgeNetwork: string
  /**
   * HUB_AGENT_TRAEFIK_VERSION (ruling P6-34): which Traefik reads the labels. 3 (default) = the
   * swarm provider (`traefik.swarm.network`); 2 = the docker provider (`traefik.docker.network`).
   * Never both: Traefik v3 skips a service that carries both providers' labels.
   */
  traefikVersion: 2 | 3
  entrypoints: string[]
  certResolver?: string
  /** Lower-case, each starting with a dot. Empty in publish mode. */
  hostSuffixes: string[]
  publishPorts: [number, number] | null
  /** `<repo>[:<tag>]@sha256:<64 hex>` or null (bundled Redis not offered). */
  redisImage: string | null
  volumeDriver: string
  volumeOpts: Record<string, string>
  extensionsRoot: string
  extensionsHostRoot: string
  extensionsShared: boolean
  /** registry host → base64 `user:password`, from a docker config.json `auths`. */
  registryAuth: Record<string, string> | null
  /**
   * HUB_AGENT_ENV_PREFIXES (ruling P4-23): env key prefixes such as `EFP_` a stack may set on top
   * of the Nivaro app's known config keys. Default none.
   */
  envPrefixes: string[]
}

export const MIN_TOKEN_LENGTH = 32
export const MIN_TOKEN_DISTINCT_CHARS = 8
export const DEFAULT_LISTEN = '127.0.0.1:7480'
export const DEFAULT_SOCKET = '/var/run/docker.sock'
export const DEFAULT_EXTENSIONS_ROOT = '/var/lib/nivaro-hub-agent/extensions'

const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
const HOST =
  '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?'
/** An image repository: optional registry host[:port]/, then path components. No tag, no digest. */
export const REPO_RE = new RegExp(`^(?:${HOST}/)?${COMPONENT}(?:/${COMPONENT})*$`)
/** One HUB_AGENT_ENV_PREFIXES entry: upper-case segments, ends with `_` (`EFP_`, `EFP_OPS_`). */
export const ENV_PREFIX_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_$/
const SUFFIX_RE = /^\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

type ReadFile = (p: string) => string

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function readTrimmed(
  readFile: ReadFile,
  path: string | undefined,
  code: string
): string | undefined {
  if (!path?.trim()) return undefined
  try {
    return readFile(path.trim()).trim()
  } catch {
    throw new ConfigError(code)
  }
}

function readJson(readFile: ReadFile, path: string | undefined, code: string): unknown {
  const text = readTrimmed(readFile, path, code)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new ConfigError(code)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `host:port` or `[ipv6]:port`. Throws LISTEN_BAD. */
export function parseListen(listen: string): { host: string; port: number } {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\s[\]]+)):([0-9]{1,5})$/.exec(listen)
  const port = m ? Number(m[3]) : Number.NaN
  if (!m || !Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('LISTEN_BAD')
  return { host: m[1] ?? m[2], port }
}

/** Absolute, no `..`, and at least two path segments (never `/` or `/srv`). */
function extensionRootOk(v: string): boolean {
  const segments = v.split('/').filter(Boolean)
  return (
    v.startsWith('/') && !segments.includes('..') && !segments.includes('.') && segments.length >= 2
  )
}

function strongEnough(secret: string): boolean {
  return secret.length >= MIN_TOKEN_LENGTH && new Set(secret).size >= MIN_TOKEN_DISTINCT_CHARS
}

/** 127.0.0.0/8, ::1 and localhost. `0.0.0.0` and `::` are NOT loopback. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '::1' || /^127(?:\.[0-9]{1,3}){3}$/.test(h)
}

/** Volume driver options that would turn a volume into a bind of a host path. */
/**
 * Ruling P4-12. Driver options never bind a host path:
 * - `o` never carries `bind`, `rbind` or `remount`; `type` is never `none` or `bind`;
 * - `device` only for an NFS export: `type` nfs|nfs4, `device` `:/<path>` with no
 *   `..` segment, and `o` naming the server with `addr=<host>`.
 * Used by the config loader and again by the engine on /volumes/create.
 */
export function volumeOptsSafe(opts: Record<string, unknown>): boolean {
  if (Object.values(opts).some((v) => typeof v !== 'string')) return false
  const type = String(opts.type ?? '')
    .trim()
    .toLowerCase()
  const o = String(opts.o ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const keys = o.map((x) => x.split('=')[0].toLowerCase())
  if (keys.some((k) => k === 'bind' || k === 'rbind' || k === 'remount')) return false
  if (type === 'none' || type === 'bind' || type === 'rbind') return false
  if (!Object.hasOwn(opts, 'device')) return true
  const device = String(opts.device)
  if (type !== 'nfs' && type !== 'nfs4') return false
  if (
    !device.startsWith(':/') ||
    device
      .slice(1)
      .split('/')
      .some((s) => s === '..')
  )
    return false
  return o.some((x) => /^addr=[^=\s]+$/i.test(x))
}

export function loadAgentConfig(env: NodeJS.ProcessEnv, readFile: ReadFile): AgentConfig {
  const token = readTrimmed(readFile, env.HUB_AGENT_TOKEN_FILE, 'TOKEN_MISSING')
  if (!token || token.length < MIN_TOKEN_LENGTH) throw new ConfigError('TOKEN_MISSING')
  if (!strongEnough(token)) throw new ConfigError('TOKEN_WEAK')

  let hmacKey = token
  if (env.HUB_AGENT_HMAC_KEY_FILE?.trim()) {
    const k = readTrimmed(readFile, env.HUB_AGENT_HMAC_KEY_FILE, 'HMAC_KEY_BAD')
    if (!k || !strongEnough(k)) throw new ConfigError('HMAC_KEY_BAD')
    hmacKey = k
  }

  const listen = env.HUB_AGENT_LISTEN?.trim() || DEFAULT_LISTEN
  const listenHost = parseListen(listen).host

  const certFile = env.HUB_AGENT_TLS_CERT_FILE?.trim()
  const keyFile = env.HUB_AGENT_TLS_KEY_FILE?.trim()
  let tls: AgentConfig['tls']
  if (certFile || keyFile) {
    if (!certFile || !keyFile) throw new ConfigError('TLS_BAD')
    const cert = readTrimmed(readFile, certFile, 'TLS_BAD')
    const key = readTrimmed(readFile, keyFile, 'TLS_BAD')
    if (!cert || !key) throw new ConfigError('TLS_BAD')
    tls = { cert, key }
  }
  // The bearer token never crosses a network in clear text unless the operator says so.
  if (!tls && !isLoopbackHost(listenHost) && env.HUB_AGENT_INSECURE_HTTP?.trim() !== '1') {
    throw new ConfigError('INSECURE_LISTEN')
  }

  const socket = env.HUB_AGENT_DOCKER_SOCKET?.trim() || DEFAULT_SOCKET

  const images =
    env.HUB_AGENT_IMAGES === undefined ? ['nodeworks/nivaro'] : list(env.HUB_AGENT_IMAGES)
  if (images.length === 0 || images.some((i) => !REPO_RE.test(i)))
    throw new ConfigError('IMAGES_BAD')

  const edgeRaw = env.HUB_AGENT_EDGE?.trim() || 'traefik'
  if (edgeRaw !== 'traefik' && edgeRaw !== 'publish') throw new ConfigError('EDGE_BAD')
  const edge: AgentConfig['edge'] = edgeRaw

  const edgeNetwork = env.HUB_AGENT_EDGE_NETWORK?.trim() ?? ''
  const traefikRaw = env.HUB_AGENT_TRAEFIK_VERSION?.trim() || '3'
  if (traefikRaw !== '2' && traefikRaw !== '3') throw new ConfigError('TRAEFIK_VERSION_BAD')
  const traefikVersion: AgentConfig['traefikVersion'] = traefikRaw === '2' ? 2 : 3
  const entrypoints =
    env.HUB_AGENT_ENTRYPOINTS === undefined ? ['websecure'] : list(env.HUB_AGENT_ENTRYPOINTS)
  const certResolver = env.HUB_AGENT_CERT_RESOLVER?.trim() || undefined
  let hostSuffixes: string[] = []
  let publishPorts: AgentConfig['publishPorts'] = null

  if (edge === 'traefik') {
    if (!edgeNetwork) throw new ConfigError('EDGE_NETWORK_MISSING')
    hostSuffixes = list(env.HUB_AGENT_HOST_SUFFIXES).map((s) => {
      const lower = s.toLowerCase()
      return lower.startsWith('.') ? lower : `.${lower}`
    })
    if (hostSuffixes.length === 0 || hostSuffixes.some((s) => !SUFFIX_RE.test(s))) {
      throw new ConfigError('HOST_SUFFIXES_MISSING')
    }
  } else {
    const m = /^\s*([0-9]{1,5})\s*-\s*([0-9]{1,5})\s*$/.exec(env.HUB_AGENT_PUBLISH_PORTS ?? '')
    const lo = m ? Number(m[1]) : Number.NaN
    const hi = m ? Number(m[2]) : Number.NaN
    if (!m || lo < 1024 || hi > 65535 || lo > hi) throw new ConfigError('PUBLISH_PORTS_BAD')
    publishPorts = [lo, hi]
  }

  const redisRaw = env.HUB_AGENT_REDIS_IMAGE?.trim()
  let redisImage: string | null = null
  if (redisRaw) {
    // `<repo>[:<tag>]@sha256:<digest>` (P4-34): the digest pins it, a tag alone does not.
    const p = parsePinned(redisRaw)
    if (!p || !REPO_RE.test(p.repo)) throw new ConfigError('REDIS_IMAGE_NOT_PINNED')
    redisImage = redisRaw
  }

  const volumeDriver = env.HUB_AGENT_VOLUME_DRIVER?.trim() || 'local'
  const optsRaw = readJson(readFile, env.HUB_AGENT_VOLUME_OPTS_FILE, 'VOLUME_OPTS_BAD')
  let volumeOpts: Record<string, string> = {}
  if (optsRaw !== undefined) {
    if (!isPlainObject(optsRaw) || Object.values(optsRaw).some((v) => typeof v !== 'string')) {
      throw new ConfigError('VOLUME_OPTS_BAD')
    }
    volumeOpts = optsRaw as Record<string, string>
    if (!volumeOptsSafe(volumeOpts)) throw new ConfigError('VOLUME_OPTS_BAD')
  }

  const extensionsRoot = env.HUB_AGENT_EXTENSIONS_ROOT?.trim() || DEFAULT_EXTENSIONS_ROOT
  const extensionsHostRoot = env.HUB_AGENT_EXTENSIONS_HOST_ROOT?.trim() || extensionsRoot
  if (!extensionRootOk(extensionsRoot) || !extensionRootOk(extensionsHostRoot))
    throw new ConfigError('EXTENSIONS_ROOT_BAD')
  const extensionsShared = env.HUB_AGENT_EXTENSIONS_SHARED?.trim() === 'on'

  let registryAuth: AgentConfig['registryAuth'] = null
  const docker = readJson(readFile, env.HUB_AGENT_REGISTRY_AUTH_FILE, 'REGISTRY_AUTH_BAD')
  if (docker !== undefined) {
    if (!isPlainObject(docker) || !isPlainObject(docker.auths))
      throw new ConfigError('REGISTRY_AUTH_BAD')
    registryAuth = {}
    for (const [registry, entry] of Object.entries(docker.auths)) {
      if (!isPlainObject(entry) || typeof entry.auth !== 'string' || !entry.auth) {
        throw new ConfigError('REGISTRY_AUTH_BAD')
      }
      registryAuth[registry] = entry.auth
    }
  }

  const envPrefixes = [...new Set(list(env.HUB_AGENT_ENV_PREFIXES))]
  if (envPrefixes.some((p) => !ENV_PREFIX_RE.test(p))) throw new ConfigError('ENV_PREFIXES_BAD')
  // A prefix that overlaps a deny key or deny prefix (GTK_ vs GTK_PATH) is refused outright.
  if (envPrefixes.some(operatorPrefixConflict)) throw new ConfigError('ENV_PREFIX_DENIED')

  return {
    token,
    hmacKey,
    listen,
    ...(tls ? { tls } : {}),
    socket,
    images,
    edge,
    edgeNetwork,
    traefikVersion,
    entrypoints,
    ...(certResolver ? { certResolver } : {}),
    hostSuffixes,
    publishPorts,
    redisImage,
    volumeDriver,
    volumeOpts,
    extensionsRoot,
    extensionsHostRoot,
    extensionsShared,
    registryAuth,
    envPrefixes
  }
}
