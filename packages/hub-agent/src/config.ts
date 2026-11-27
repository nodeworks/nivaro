/**
 * Hub agent configuration, read once at start from HUB_AGENT_* settings.
 *
 * Secrets (token, HMAC key, TLS key, volume options, registry auth) are only
 * ever read from files. A ConfigError carries a code and nothing else: no
 * value, no path, so a failed start never prints a secret.
 */

import { createHash } from 'node:crypto'
import { parsePinned } from './image-ref.js'
import { operatorPrefixConflict } from './spec.js'
import { isNfsOpts, nfsExport, PIN_LABEL_PART_RE, redisVolumeDefault } from './volumes.js'

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
  /** The uploads volumes' driver and options. An NFS `device` here is the export ROOT (0.2.3). */
  volumeDriver: string
  volumeOpts: Record<string, string>
  /**
   * HUB_AGENT_REDIS_VOLUME_DRIVER / _OPTS_FILE (0.2.3): bundled Redis's volume. Default: the
   * uploads driver and options, except `local` with none when those mount NFS (Redis never on
   * NFS). NFS options are refused here (REDIS_VOLUME_OPTS_BAD).
   */
  redisVolumeDriver: string
  redisVolumeOpts: Record<string, string>
  /**
   * HUB_AGENT_VOLUME_EXPORT_MOUNT (0.2.3): where the agent's own container sees the NFS export
   * root, so it can check (and make) each stack's folder before a deploy. null = not mounted:
   * a stack on the export is refused (EXPORT_MOUNT_MISSING) rather than deployed blind.
   */
  exportMount: string | null
  /**
   * HUB_AGENT_REDIS_PIN_LABEL (0.2.3, `key=value`): bundled Redis runs only on nodes carrying
   * that node label. null = not pinned (default).
   */
  redisPinLabel: { key: string; value: string } | null
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
  /**
   * HUB_AGENT_CA_BUNDLE_FILE: extra trusted CA certificates (PEM) every app service of every stack
   * gets as a swarm secret + NODE_EXTRA_CA_CERTS, so the app can call a Hub whose certificate a
   * company CA signed. `sha256` = hex of `pem` (names the secret, part of the stack hash). null =
   * not set: stacks render and hash exactly as before.
   */
  caBundle: { pem: string; sha256: string } | null
  /**
   * HUB_AGENT_TRAEFIK_DYNAMIC_DIR (0.2.5): the folder (as the agent's container sees it) Traefik's
   * file provider watches. The agent writes one `nvh-<stack>.yml` there for each stack that
   * carries `edge_tls` (its own certificate). null = not set: a stack with edge_tls is refused
   * (TLS_NOT_CONFIGURED). Traefik edge only (else TRAEFIK_DYNAMIC_DIR_BAD).
   */
  traefikDynamicDir: string | null
}

export const MIN_TOKEN_LENGTH = 32
export const MIN_TOKEN_DISTINCT_CHARS = 8
export const DEFAULT_LISTEN = '127.0.0.1:7480'
export const DEFAULT_SOCKET = '/var/run/docker.sock'
export const DEFAULT_EXTENSIONS_ROOT = '/var/lib/nivaro-hub-agent/extensions'
/** HUB_AGENT_CA_BUNDLE_FILE size cap (a few hundred certificates). */
export const CA_BUNDLE_MAX_BYTES = 256 * 1024
const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/
/** Any private key block (PRIVATE KEY, RSA/EC/ENCRYPTED PRIVATE KEY): never handed to an app. */
const PRIVATE_KEY_RE = /PRIVATE KEY/

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

/**
 * NFS options naming the server in the device (`nas01:/volume1`, the `mount -t nfs` form) become
 * Docker's form: `device: ":/volume1"` with `addr=nas01` in `o` (0.2.3). An `addr=` in `o` that
 * names another host is ambiguous: VOLUME_OPTS_BAD. Other options are returned as they are.
 */
export function normaliseNfsDevice(opts: Record<string, string>): Record<string, string> {
  if (!isNfsOpts(opts) || typeof opts.device !== 'string') return opts
  const m = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):(\/.*)$/.exec(opts.device)
  if (!m) return opts
  const host = m[1].replace(/^\[|\]$/g, '')
  const parts = String(opts.o ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const addr = parts.find((x) => /^addr=/i.test(x))
  if (addr && addr.slice(5).toLowerCase() !== host.toLowerCase())
    throw new ConfigError('VOLUME_OPTS_BAD')
  return {
    ...opts,
    o: addr ? parts.join(',') : [`addr=${host}`, ...parts].join(','),
    device: `:${m[2]}`
  }
}

/**
 * HUB_AGENT_CA_BUNDLE_FILE: read once, ≤ CA_BUNDLE_MAX_BYTES, at least one whole CERTIFICATE
 * block and no private key. Anything else is CA_BUNDLE_BAD (code only, never the contents).
 */
function readCaBundle(readFile: ReadFile, path: string | undefined): AgentConfig['caBundle'] {
  if (!path?.trim()) return null
  let raw: string
  try {
    raw = readFile(path.trim())
  } catch {
    throw new ConfigError('CA_BUNDLE_BAD')
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > CA_BUNDLE_MAX_BYTES)
    throw new ConfigError('CA_BUNDLE_BAD')
  const pem = `${raw.trim()}\n`
  if (!CERT_BLOCK_RE.test(pem) || PRIVATE_KEY_RE.test(pem)) throw new ConfigError('CA_BUNDLE_BAD')
  return { pem, sha256: createHash('sha256').update(pem).digest('hex') }
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
    volumeOpts = normaliseNfsDevice(optsRaw as Record<string, string>)
    if (!volumeOptsSafe(volumeOpts)) throw new ConfigError('VOLUME_OPTS_BAD')
    // NFS through Docker's local driver needs `device: ":/<export>"` (0.2.3): without one every
    // stack would share whatever the mount lands on, so it is refused, not guessed.
    if (volumeDriver === 'local' && isNfsOpts(volumeOpts) && nfsExport({ volumeOpts }) === null)
      throw new ConfigError('VOLUME_OPTS_BAD')
  }

  // Bundled Redis (0.2.3): its own driver and options, never NFS.
  let redis = redisVolumeDefault(volumeDriver, volumeOpts)
  const redisDriverRaw = env.HUB_AGENT_REDIS_VOLUME_DRIVER?.trim()
  const redisOptsRaw = readJson(
    readFile,
    env.HUB_AGENT_REDIS_VOLUME_OPTS_FILE,
    'REDIS_VOLUME_OPTS_BAD'
  )
  if (redisDriverRaw || redisOptsRaw !== undefined) {
    let opts: Record<string, string> = {}
    if (redisOptsRaw !== undefined) {
      if (
        !isPlainObject(redisOptsRaw) ||
        Object.values(redisOptsRaw).some((v) => typeof v !== 'string')
      ) {
        throw new ConfigError('REDIS_VOLUME_OPTS_BAD')
      }
      opts = redisOptsRaw as Record<string, string>
    }
    if (!volumeOptsSafe(opts) || isNfsOpts(opts)) throw new ConfigError('REDIS_VOLUME_OPTS_BAD')
    redis = { driver: redisDriverRaw || 'local', opts }
  }

  // The export root as the agent sees it: only with an NFS export, absolute, no `..`.
  const exportMountRaw = env.HUB_AGENT_VOLUME_EXPORT_MOUNT?.trim() || null
  if (exportMountRaw !== null) {
    if (!extensionRootOk(exportMountRaw)) throw new ConfigError('VOLUME_EXPORT_MOUNT_BAD')
    if (nfsExport({ volumeOpts }) === null) throw new ConfigError('VOLUME_EXPORT_MOUNT_BAD')
  }
  const exportMount = exportMountRaw ? exportMountRaw.replace(/\/+$/, '') : null

  let redisPinLabel: AgentConfig['redisPinLabel'] = null
  const pinRaw = env.HUB_AGENT_REDIS_PIN_LABEL?.trim()
  if (pinRaw) {
    const eq = pinRaw.indexOf('=')
    const key = eq > 0 ? pinRaw.slice(0, eq) : ''
    const value = eq > 0 ? pinRaw.slice(eq + 1) : ''
    if (!PIN_LABEL_PART_RE.test(key) || !PIN_LABEL_PART_RE.test(value))
      throw new ConfigError('REDIS_PIN_LABEL_BAD')
    redisPinLabel = { key, value }
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

  const caBundle = readCaBundle(readFile, env.HUB_AGENT_CA_BUNDLE_FILE)

  // 0.2.5: where Traefik's file provider reads stack certificates. Absolute, no `.`/`..`, at
  // least two segments (never `/` or `/etc`), traefik edge only.
  const dynamicRaw = env.HUB_AGENT_TRAEFIK_DYNAMIC_DIR?.trim() || null
  if (dynamicRaw !== null && (edge !== 'traefik' || !extensionRootOk(dynamicRaw)))
    throw new ConfigError('TRAEFIK_DYNAMIC_DIR_BAD')
  const traefikDynamicDir = dynamicRaw ? dynamicRaw.replace(/\/+$/, '') : null

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
    redisVolumeDriver: redis.driver,
    redisVolumeOpts: redis.opts,
    exportMount,
    redisPinLabel,
    extensionsRoot,
    extensionsHostRoot,
    extensionsShared,
    registryAuth,
    envPrefixes,
    caBundle,
    traefikDynamicDir
  }
}
