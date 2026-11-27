// Hub creation targets (phase 3): where a new app is created — a GitLab namespace, the template
// its deploy repository is forked from, the deploy host and how hostnames are made. The GitLab
// token is sealed (secrets.ts) and only ever answered as the mask. Kind `gitlab` only in this
// phase; a `docker` kind belongs in this same table later.
//
// Gap G-A (Hub providers): a GitLab target may name a `gitlab` provider connection
// (`connection_id`, migration 583) instead of holding its own token. Such a row stores no token
// and no GitLab address: getTargetRow fills both from the connection (its base URL, and a fresh
// sealed copy of its token), so every caller (creation, sync, move, promote checks) works as for
// a target with its own token. connection-targets.ts decides which targets (and so which created
// apps' drivers) follow a connection.

import { createHmac } from 'node:crypto'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import type { GitCtx } from '../../gitlab-client.js'
import type { Validation } from '../drivers.js'
import { GitlabWriteError } from '../gitlab-write.js'
import { baseOf as gitlabBaseOf } from '../providers/gitlab/client.js'
import {
  HUB_MASK,
  HubSecretError,
  maskSecret,
  nextSecret,
  openSecret,
  sealSecret
} from '../secrets.js'
import { dnsSuffix, httpAllowed, route53ConfigProblem, zoneResourceIdOf } from './dns.js'
import {
  currentUser,
  groupAccessLevel,
  namespaceExists,
  projectExists
} from './gitlab-provision.js'

/** GitLab access level a target's token needs on its namespace (Maintainer). */
const MAINTAINER = 40

export interface HubTargetConfig {
  api: string
  namespace: string
  template_project: string
  /** Tag or commit sha of template_project that app repositories include the deploy job from. */
  template_ref: string
  pin_file: string
  deploy_job: string
  deploy_host: string
  /** known_hosts lines of the swarm manager: the deploy job refuses any other host key. */
  manager_known_hosts: string
  proxy_network: string
  /** route53 (Task 11a): the Hub makes each name's record in the hosted zone below. */
  dns_mode: 'automatic' | 'manual' | 'route53' | 'cloudflare'
  /** route53: the managed `aws.route53_zone` resource (nivaro_hub_resources.id). */
  dns_zone_resource_id?: number | null
  wildcard_domain: string | null
  edge_address: string | null
  scheme: 'https' | 'http'
  port: number | null
  cert_note: string | null
  /**
   * Ruling P6-35: the Traefik on this target's swarm. It picks the created app's ONE network
   * label (3 = traefik.swarm.network, 2 = traefik.docker.network; v3 skips a service with both).
   * Absent on targets saved before it: 3.
   */
  traefik_version?: 2 | 3
}

/** The `gitlab` connection a target uses, as read with the target (never its token). */
export interface TargetConnectionInfo {
  id: number
  name: string
  /** Why the connection cannot serve the target now (gone, disabled, no token…), else null. */
  problem: string | null
}

/**
 * A target as stored: config parsed, token still sealed. A target that uses a connection
 * (`connection_id`) is read with the connection's address in `config.api` and a sealed copy of
 * its token in `secret` (getTargetRow), or `secret` null and `connection.problem` set.
 */
export interface HubTargetRow {
  id: number
  kind: 'gitlab'
  name: string
  config: HubTargetConfig
  secret: string | null
  /** The `gitlab` provider connection whose address and token the target uses (G-A). */
  connection_id?: number | null
  connection?: TargetConnectionInfo | null
}

/** A target as the API shows it: the token is only ever the mask. */
export interface HubTarget {
  id: number
  kind: 'gitlab'
  name: string
  config: HubTargetConfig
  /** The mask when the target holds its own token; null for a target that uses a connection. */
  secret: string | null
  connection_id: number | null
  connection: TargetConnectionInfo | null
}

export type TargetFields = Omit<HubTargetRow, 'id' | 'connection'>

/** What validateTargetInput needs of the connection a target names (routes read it). */
export interface TargetConnectionInput {
  id: number
  name: string
  provider: string
  config: Record<string, unknown>
}

export interface TargetCheck {
  id: 'connection' | 'token' | 'namespace' | 'template'
  ok: boolean
  text: string
}

const CONFIG_KEYS = [
  'api',
  'namespace',
  'template_project',
  'template_ref',
  'pin_file',
  'deploy_job',
  'deploy_host',
  'manager_known_hosts',
  'proxy_network',
  'dns_mode',
  'wildcard_domain',
  'edge_address',
  'scheme',
  'port',
  'cert_note',
  'traefik_version',
  'dns_zone_resource_id'
] as const

const DEFAULTS = {
  pin_file: '.hub/nivaro-version',
  deploy_job: 'deploy',
  proxy_network: 'proxy',
  scheme: 'https'
} as const

/** A GitLab project / namespace path (or numeric id). */
const GITLAB_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
/** `host`, `user@host`, `host:port` — never a leading `-` (it would read as an ssh option). */
const DEPLOY_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9.-]+)?(:\d+)?$/

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message }
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

function validApiUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  // A token-bearing base URL carries no credentials, query or fragment.
  if (u.username || u.password || u.search || u.hash) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && isLocalHost(u.hostname)
}

/** A GitLab address as targets and drivers compare it: no /api/v4, no trailing slash, lower case. */
function apiBase(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\/api\/v4$/, '')
    .replace(/\/+$/, '')
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return raw
  }
}

/**
 * A pinned ref of the template: a full 40-hex commit sha, or a version tag
 * (`^v?\d{1,9}(\.\d+){0,3}([-.][a-z0-9]+)?$`: v1, v1.2.0, 2.0.0-rc1). Anything a branch could
 * be named is refused: the deploy job must not change under an app. The major number is what the
 * manager's stack file must carry (nivaro-hub-stack-major); it has at most 9 digits, as deploy.sh
 * reads it (`v?[0-9]{1,9}…`), so a ref the Hub accepts is never one the deploy job refuses.
 */
export function validTemplateRef(v: unknown): v is string {
  return typeof v === 'string' && /^([0-9a-f]{40}|v?\d{1,9}(\.\d+){0,3}([-.][a-z0-9]+)?)$/.test(v)
}

/** Does one known_hosts host pattern (`host`, `[host]:port`, `*`/`?` wildcards) match `name`? */
function hostPatternMatches(pattern: string, name: string): boolean {
  let re = ''
  for (const ch of pattern.toLowerCase()) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(name)
}

/**
 * Whether normalised known_hosts lines (parseKnownHosts) hold a usable key for `deployHost`
 * (`host`, `user@host`, `host:port`): ssh looks the host up as `host` on port 22 and as
 * `[host]:port` otherwise. Plain, wildcard (`*`, `?`, `!` negation) and hashed `|1|salt|hash`
 * entries count, `@cert-authority` too; `@revoked` lines never do.
 */
export function knownHostsCover(knownHosts: string, deployHost: string): boolean {
  const m = /^(?:[^@]+@)?([^:@]+)(?::(\d+))?$/.exec(deployHost)
  if (!m) return false
  const host = m[1].toLowerCase()
  const port = m[2] ? Number(m[2]) : 22
  const name = port === 22 ? host : `[${host}]:${port}`
  for (const line of knownHosts.split('\n')) {
    const parts = line.trim().split(' ')
    if (parts[0] === '@revoked') continue
    if (parts[0] === '@cert-authority') parts.shift()
    const hosts = parts[0]
    if (!hosts) continue
    if (hosts.startsWith('|1|')) {
      const [, , salt, hash] = hosts.split('|')
      const mac = createHmac('sha1', Buffer.from(salt ?? '', 'base64'))
        .update(name)
        .digest('base64')
      if (mac === hash) return true
      continue
    }
    let hit = false
    let negated = false
    for (const p of hosts.split(',')) {
      if (p.startsWith('!')) {
        if (hostPatternMatches(p.slice(1), name)) negated = true
      } else if (hostPatternMatches(p, name)) hit = true
    }
    if (hit && !negated) return true
  }
  return false
}

const KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com'
])
/** Host patterns (`host`, `[host]:port`, comma lists, `*`/`?` wildcards) or a hashed `|1|salt|hash`. */
const KH_HOSTS = /^(\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+|[A-Za-z0-9.:*?![\]_,-]+)$/
const KH_KEY = /^[A-Za-z0-9+/]{16,}={0,2}$/

/**
 * ssh known_hosts text: `[@cert-authority|@revoked] <hosts> <key type> <base64 key> [comment]`
 * lines only (blank and `#` lines dropped). Answers the normalised lines (single spaces, no
 * comments), or null when any line is something else, there is none, or it is too long.
 */
export function parseKnownHosts(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 16_000) return null
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const parts = t.split(/[ \t]+/)
    const marker = parts[0].startsWith('@') ? parts.shift() : null
    if (marker && marker !== '@cert-authority' && marker !== '@revoked') return null
    const [hosts, type, key] = parts
    if (!hosts || !type || !key) return null
    if (!KH_HOSTS.test(hosts) || hosts.startsWith('-') || !KEY_TYPES.has(type) || !KH_KEY.test(key))
      return null
    out.push([marker, hosts, type, key].filter(Boolean).join(' '))
  }
  if (!out.length || out.length > 50) return null
  return out.join('\n')
}

function optText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t.length > max) return undefined
  return t || null
}

/** The GitLab address a `gitlab` connection calls (origin + path prefix), or null. */
export function connectionApi(config: Record<string, unknown>): string | null {
  const b = gitlabBaseOf(config)
  return b ? `${b.origin}${b.prefix}` : null
}

/** The group a `gitlab` connection is pinned to (lower-cased full path), or ''. */
export function connectionGroup(config: Record<string, unknown>): string {
  return String(config.groupPath ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
}

/**
 * Why a target's namespace or template lies outside the group its connection is pinned to, or
 * null. The connection only reaches inside its group (gitlab provider), so a target that uses it
 * keeps both there; a template named by numeric id cannot be judged and is refused.
 */
export function outsideConnectionGroup(
  config: Pick<HubTargetConfig, 'namespace' | 'template_project'>,
  group: string
): string | null {
  const inside = (p: unknown, allowEqual: boolean) => {
    if (typeof p !== 'string' || !group) return false
    const v = p.trim().toLowerCase()
    return (allowEqual && v === group) || v.startsWith(`${group}/`)
  }
  if (!inside(config.namespace, true))
    return `The namespace ${String(config.namespace ?? '')} is outside the group ${group || '(none)'} the connection is pinned to.`
  if (!inside(config.template_project, false))
    return `The template project must be a path inside the group ${group || '(none)'} the connection is pinned to.`
  return null
}

/**
 * `connection`: the connection the request (or the stored target) names, read by the caller —
 * required when the target uses one. A target that uses a connection never holds a token or an
 * address of its own; one that stops using it must be given its own token in the same request.
 */
export function validateTargetInput(
  body: Record<string, unknown>,
  existing?: HubTargetRow,
  connection?: TargetConnectionInput | null
): Validation<TargetFields> {
  const kind = body.kind ?? existing?.kind
  if (kind !== 'gitlab') return fail('BAD_KIND', 'Target kind must be gitlab.')

  // Which credential the target uses: `connection_id` in the body decides (null = its own
  // token); absent keeps what the stored target does.
  const connRaw =
    body.connection_id !== undefined ? body.connection_id : (existing?.connection_id ?? null)
  if (
    connRaw !== null &&
    (typeof connRaw !== 'number' || !Number.isSafeInteger(connRaw) || connRaw < 1)
  )
    return fail(
      'BAD_TARGET_CONNECTION',
      'connection_id must name a GitLab connection (or be null).'
    )
  const connectionId = connRaw as number | null
  let connApi: string | null = null
  let connGroup = ''
  if (connectionId !== null) {
    if (!connection || connection.id !== connectionId || connection.provider !== 'gitlab')
      return fail('BAD_TARGET_CONNECTION', 'connection_id must name a GitLab connection.')
    connApi = connectionApi(connection.config)
    connGroup = connectionGroup(connection.config)
    if (!connApi)
      return fail(
        'BAD_TARGET_CONNECTION',
        `The connection ${connection.name} has no usable GitLab address.`
      )
    if (!connGroup)
      return fail(
        'BAD_TARGET_CONNECTION',
        `The connection ${connection.name} is pinned to no group.`
      )
    if (typeof body.secret === 'string' && body.secret !== '' && body.secret !== HUB_MASK)
      return fail(
        'BAD_SECRET',
        'A target that uses a connection keeps no token of its own: change the token on the connection.'
      )
  }

  const name = body.name !== undefined ? body.name : existing?.name
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200)
    return fail('BAD_NAME', 'A target needs a name (at most 200 characters).')

  const incoming = body.config ?? {}
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    return fail('BAD_CONFIG', 'Target config must be an object.')
  }
  const inc = incoming as Record<string, unknown>
  for (const k of Object.keys(inc)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) {
      return fail('BAD_CONFIG', `Unknown config key: ${k}.`)
    }
  }
  const prev = (existing?.config ?? {}) as Partial<Record<string, unknown>>
  const pick = (k: (typeof CONFIG_KEYS)[number]) => (k in inc ? inc[k] : prev[k])
  if (connApi !== null) {
    // The address is the connection's: an address sent here must be that same one.
    const sent = inc.api
    if (typeof sent === 'string' && sent.trim() && originOf(sent.trim()) !== originOf(connApi))
      return fail(
        'BAD_CONFIG',
        'A target that uses a connection takes its GitLab address from the connection.'
      )
  }

  const required: Record<string, string> = {}
  for (const k of [
    ...(connApi !== null ? [] : (['api'] as const)),
    'namespace',
    'template_project',
    'template_ref',
    'deploy_host'
  ] as const) {
    const v = pick(k)
    if (typeof v !== 'string' || !v.trim()) return fail('BAD_CONFIG', `Config ${k} is required.`)
    required[k] = v.trim()
  }
  if (connApi !== null) required.api = connApi
  else if (!validApiUrl(required.api)) {
    return fail('BAD_CONFIG', 'Config api must be an https URL (http only for localhost).')
  }
  if (!GITLAB_PATH.test(required.namespace) || required.namespace.length > 255)
    return fail('BAD_CONFIG', 'Config namespace must be a GitLab group or user path.')
  if (!GITLAB_PATH.test(required.template_project) || required.template_project.length > 255)
    return fail('BAD_CONFIG', 'Config template_project must be a GitLab project path or id.')
  if (!DEPLOY_HOST.test(required.deploy_host) || required.deploy_host.length > 253)
    return fail('BAD_CONFIG', 'Config deploy_host must be host, user@host or host:port.')
  if (!validTemplateRef(required.template_ref))
    return fail(
      'BAD_CONFIG',
      'Config template_ref must be a version tag (v1.2.0) or a full commit sha of the template.'
    )
  const knownHosts = parseKnownHosts(pick('manager_known_hosts'))
  if (!knownHosts)
    return fail(
      'BAD_CONFIG',
      "Config manager_known_hosts must be the manager's ssh known_hosts lines (ssh-keyscan <host>)."
    )
  if (!knownHostsCover(knownHosts, required.deploy_host))
    return fail(
      'BAD_CONFIG',
      'Config manager_known_hosts has no key for the deploy host ([host]:port when not port 22).'
    )

  const withDefault = (k: keyof typeof DEFAULTS): unknown => {
    const v = pick(k)
    return v === undefined || v === null || v === '' ? DEFAULTS[k] : v
  }
  const pinFile = withDefault('pin_file')
  if (
    typeof pinFile !== 'string' ||
    pinFile.startsWith('/') ||
    pinFile.split('/').some((seg) => !seg || seg === '.' || seg === '..') ||
    pinFile.length > 255
  )
    return fail('BAD_CONFIG', 'Config pin_file must be a path inside the repository.')
  const deployJob = withDefault('deploy_job')
  if (typeof deployJob !== 'string' || !deployJob.trim() || deployJob.length > 255)
    return fail('BAD_CONFIG', 'Config deploy_job must be a job name.')
  const proxyNetwork = withDefault('proxy_network')
  if (typeof proxyNetwork !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(proxyNetwork))
    return fail('BAD_CONFIG', 'Config proxy_network must be a Docker network name.')

  const dnsMode = pick('dns_mode')
  if (
    dnsMode !== 'automatic' &&
    dnsMode !== 'manual' &&
    dnsMode !== 'route53' &&
    dnsMode !== 'cloudflare'
  )
    return fail('BAD_CONFIG', 'Config dns_mode must be automatic, manual, route53 or cloudflare.')
  const scheme = withDefault('scheme')
  if (scheme !== 'https' && scheme !== 'http')
    return fail('BAD_CONFIG', 'Config scheme must be https or http.')

  const portRaw = pick('port')
  let port: number | null = null
  if (portRaw !== undefined && portRaw !== null && portRaw !== '') {
    if (typeof portRaw !== 'number' || !Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535)
      return fail('BAD_CONFIG', 'Config port must be a whole number from 1 to 65535.')
    port = portRaw
  }
  const edge = optText(pick('edge_address'), 253)
  if (edge === undefined) return fail('BAD_CONFIG', 'Config edge_address must be short text.')
  const certNote = optText(pick('cert_note'), 1000)
  if (certNote === undefined) return fail('BAD_CONFIG', 'Config cert_note must be short text.')

  const tvRaw = pick('traefik_version')
  const traefikVersion = tvRaw === undefined || tvRaw === null || tvRaw === '' ? 3 : tvRaw
  if (traefikVersion !== 2 && traefikVersion !== 3)
    return fail('BAD_CONFIG', 'Config traefik_version must be 2 or 3.')

  const wildRaw = pick('wildcard_domain')
  let wildcard: string | null = null
  if (wildRaw !== undefined && wildRaw !== null && wildRaw !== '') {
    wildcard = typeof wildRaw === 'string' ? dnsSuffix(wildRaw) : null
    if (!wildcard)
      return fail('BAD_WILDCARD', 'The wildcard domain must be a DNS name like apps.example.com.')
  }
  if (dnsMode === 'automatic' && !wildcard)
    return fail('BAD_WILDCARD', 'Automatic names need a wildcard domain like apps.example.com.')
  const zoneId = zoneResourceIdOf(pick('dns_zone_resource_id'))
  if (zoneId === undefined)
    return fail(
      'BAD_CONFIG',
      'Config dns_zone_resource_id must name a managed Route 53 hosted zone.'
    )
  const r53 = route53ConfigProblem({
    dns_mode: dnsMode,
    dns_zone_resource_id: zoneId,
    wildcard_domain: wildcard,
    edge
  })
  if (r53) return fail('BAD_CONFIG', r53)
  if (scheme === 'http' && !httpAllowed(wildcard))
    return fail(
      'BAD_SCHEME',
      'Plain http is only allowed when the wildcard domain is localhost or ends in .test.'
    )

  if (body.secret !== undefined && body.secret !== null && typeof body.secret !== 'string') {
    return fail('BAD_SECRET', 'The token must be text.')
  }
  if (connectionId !== null) {
    const outside = outsideConnectionGroup(
      { namespace: required.namespace, template_project: required.template_project },
      connGroup
    )
    if (outside) return fail('BAD_CONFIG', outside)
  }
  // A target leaving its connection keeps nothing of it: its own token is typed in now.
  const leaving = connectionId === null && existing?.connection_id != null
  if (leaving && (typeof body.secret !== 'string' || !body.secret || body.secret === HUB_MASK))
    return fail(
      'SECRET_REQUIRED',
      "Enter the target's own token when it stops using the connection"
    )
  const stored = leaving ? null : (existing?.secret ?? null)
  // Absent = keep on update (nextSecret reads undefined as clear).
  const secret =
    connectionId !== null
      ? null
      : body.secret === undefined && existing
        ? stored
        : nextSecret(body.secret, stored)
  if (
    connectionId === null &&
    !leaving &&
    existing &&
    stored &&
    secret === stored &&
    (originOf(required.api) !== originOf(existing.config.api) ||
      required.namespace !== existing.config.namespace)
  ) {
    return fail(
      'SECRET_REQUIRED',
      'Enter the token again when the GitLab address or namespace changes'
    )
  }

  const config: HubTargetConfig = {
    api: required.api,
    namespace: required.namespace,
    template_project: required.template_project,
    template_ref: required.template_ref,
    pin_file: pinFile,
    deploy_job: deployJob.trim(),
    deploy_host: required.deploy_host,
    manager_known_hosts: knownHosts,
    proxy_network: proxyNetwork,
    dns_mode: dnsMode,
    wildcard_domain: wildcard,
    edge_address: edge,
    scheme,
    port,
    cert_note: certNote,
    traefik_version: traefikVersion,
    ...(dnsMode === 'route53' || dnsMode === 'cloudflare' ? { dns_zone_resource_id: zoneId } : {})
  }
  return {
    ok: true,
    row: { kind: 'gitlab', name: name.trim(), config, secret, connection_id: connectionId }
  }
}

export function publicTarget(row: HubTargetRow): HubTarget {
  const connected = row.connection_id != null
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: row.config,
    // A target that uses a connection holds no token: never a mask for the connection's copy.
    secret: connected ? null : maskSecret(row.secret),
    connection_id: connected ? Number(row.connection_id) : null,
    connection:
      connected && row.connection
        ? { id: row.connection.id, name: row.connection.name, problem: row.connection.problem }
        : null
  }
}

export class TargetMisconfiguredError extends Error {
  code = 'TARGET_MISCONFIGURED'
  constructor(message: string) {
    super(message)
    this.name = 'TargetMisconfiguredError'
  }
}

/**
 * GitCtx for the GitLab clients: `base` is the host (the client adds /api/v4), `project` the
 * given one (default: the template). Opens the sealed token (HubSecretError when unreadable).
 */
export function targetCtx(row: HubTargetRow, project?: string): GitCtx {
  if (!row.config || typeof row.config.api !== 'string' || !row.config.api.trim()) {
    throw new TargetMisconfiguredError('The target has no GitLab address configured.')
  }
  const base = row.config.api.replace(/\/+$/, '').replace(/\/api\/v4$/, '')
  return {
    provider: 'gitlab',
    base,
    project: project ?? row.config.template_project,
    token: openSecret(row.secret),
    ref: null
  }
}

function parseConfig(raw: unknown): HubTargetConfig {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = raw ? JSON.parse(raw) : {}
    } catch {
      v = {}
    }
  }
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as HubTargetConfig
}

/** A stored row, unresolved: a target that uses a connection has no address and no token yet. */
export function toTargetRow(r: Record<string, unknown>): HubTargetRow {
  const conn = r.connection_id == null ? null : Number(r.connection_id)
  const connectionId = conn !== null && Number.isSafeInteger(conn) && conn > 0 ? conn : null
  return {
    id: Number(r.id),
    kind: r.kind as 'gitlab',
    name: String(r.name),
    config: parseConfig(r.config),
    secret: connectionId !== null ? null : ((r.secret as string | null) ?? null),
    connection_id: connectionId
  }
}

const toRow = toTargetRow
const CONNECTIONS_TABLE = 'nivaro_hub_connections'

/**
 * Fills a target that uses a connection from the connection: `config.api` = its address,
 * `secret` = a fresh sealed copy of its token (`open`: only when the target is about to call
 * GitLab), `connection` = name and problem. A connection that is gone, not a GitLab one,
 * disabled, has no usable address or token, or no longer covers the target's namespace leaves
 * `secret` null and says why. A target with its own token is answered as it is.
 */
export async function resolveTargetConnection(
  row: HubTargetRow,
  opts: { open: boolean }
): Promise<HubTargetRow> {
  if (row.connection_id == null) return row
  const id = row.connection_id
  const out = (
    problem: string | null,
    name: string,
    api: string,
    secret: string | null
  ): HubTargetRow => ({
    ...row,
    config: { ...row.config, api },
    secret: problem ? null : secret,
    connection: { id, name, problem }
  })
  const c = (await db(CONNECTIONS_TABLE)
    .where({ id })
    .first('provider', 'name', 'status', 'config')) as
    | { provider: string; name: string; status: string; config: unknown }
    | undefined
  if (!c) return out('Its GitLab connection is gone: pick another one on the target.', '', '', null)
  const name = String(c.name ?? '')
  if (c.provider !== 'gitlab')
    return out('It names a connection that is not a GitLab one.', name, '', null)
  const config = parseConfig(c.config) as unknown as Record<string, unknown>
  const api = connectionApi(config)
  if (!api) return out(`The connection ${name} has no usable GitLab address.`, name, '', null)
  if (c.status === 'disabled') return out(`The connection ${name} is disabled.`, name, api, null)
  const outside = outsideConnectionGroup(row.config, connectionGroup(config))
  if (outside) return out(outside, name, api, null)
  if (!opts.open) return out(null, name, api, null)
  let token: string | undefined
  try {
    // Dynamic: the providers store sits on a module cycle with the creation steps.
    const { openConnectionSecrets } = await import('../providers/store.js')
    token = (await openConnectionSecrets({ id })).token
  } catch {
    return out(
      `The connection ${name}'s token cannot be read (check ENCRYPTION_KEY).`,
      name,
      api,
      null
    )
  }
  if (!token) return out(`The connection ${name} has no access token.`, name, api, null)
  return out(null, name, api, sealSecret(token))
}

/**
 * What a target save hands syncTargetApps so created apps' drivers follow the token (P3-32):
 * the previous sealed token when the token changed, and the previous address (the drivers move
 * with it). A target with its own token on both sides compares the stored sealed values as
 * before; one that uses a connection on either side compares the opened tokens (its sealed
 * copy is made afresh on every read). Nothing to follow = `previousSecret: null`.
 */
export function tokenFollowFrom(
  before: HubTargetRow,
  after: HubTargetRow
): { previousSecret: string | null; previousApi?: string } {
  if (!before.secret) return { previousSecret: null }
  const viaConnection = before.connection_id != null || after.connection_id != null
  let changed: boolean
  if (!viaConnection) changed = before.secret !== after.secret
  else {
    try {
      changed = openSecret(before.secret) !== openSecret(after.secret)
    } catch {
      changed = true
    }
  }
  const moved = apiBase(before.config.api) !== apiBase(after.config.api)
  if (!changed && !moved) return { previousSecret: null }
  // A target with its own token at the same address keeps the P3-32 shape (token only).
  return viaConnection || moved
    ? { previousSecret: before.secret, previousApi: before.config.api }
    : { previousSecret: before.secret }
}

/**
 * The connection a target create / PATCH would use (the body's `connection_id`, else the stored
 * target's), for validateTargetInput: never its secret. Null when it names none or none exists.
 */
export async function targetConnectionFor(
  body: Record<string, unknown>,
  existing?: HubTargetRow | null
): Promise<TargetConnectionInput | null> {
  const raw = body.connection_id !== undefined ? body.connection_id : existing?.connection_id
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) return null
  const c = (await db(CONNECTIONS_TABLE).where({ id: raw }).first('provider', 'name', 'config')) as
    | { provider: string; name: string; config: unknown }
    | undefined
  if (!c) return null
  return {
    id: raw,
    name: String(c.name ?? ''),
    provider: String(c.provider),
    config: parseConfig(c.config) as unknown as Record<string, unknown>
  }
}

const now = () => new Date()

/**
 * GitLab targets only (Task 11a: kind `github` rows are github-target.ts's). A target that uses
 * a connection carries the connection's address and name, never its token (a list never opens
 * a secret).
 */
export async function listTargets(): Promise<HubTargetRow[]> {
  const rows = (await db('nivaro_hub_targets')
    .where({ kind: 'gitlab' })
    .select('*')
    .orderBy('id')) as Record<string, unknown>[]
  return Promise.all(rows.map((r) => resolveTargetConnection(toRow(r), { open: false })))
}

/** One GitLab target, ready to call GitLab: a connection's token is opened and sealed afresh. */
export async function getTargetRow(id: number): Promise<HubTargetRow | null> {
  const r = (await db('nivaro_hub_targets').where({ id, kind: 'gitlab' }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? resolveTargetConnection(toRow(r), { open: true }) : null
}

/** What a target row stores: a target that uses a connection keeps no address and no token. */
function storedTarget(row: TargetFields): Record<string, unknown> {
  const connected = row.connection_id != null
  const { api: _api, ...rest } = row.config
  return {
    kind: row.kind,
    name: row.name,
    config: JSON.stringify(connected ? rest : row.config),
    secret: connected ? null : row.secret,
    // Written only when in use (a database before migration 583 has no such column).
    ...(connected ? { connection_id: row.connection_id } : {})
  }
}

export async function createTarget(row: TargetFields): Promise<HubTargetRow> {
  const id = await insertReturningId(db, 'nivaro_hub_targets', {
    ...storedTarget(row),
    created_at: now(),
    updated_at: now()
  })
  return { id: Number(id), ...row }
}

/** `clearConnection`: the stored target used a connection and now keeps its own token. */
export async function updateTarget(
  id: number,
  patch: TargetFields,
  opts: { clearConnection?: boolean } = {}
): Promise<HubTargetRow | null> {
  const n = await db('nivaro_hub_targets')
    .where({ id })
    .update({
      ...storedTarget(patch),
      ...(opts.clearConnection && patch.connection_id == null ? { connection_id: null } : {}),
      updated_at: now()
    })
  if (!n) return null
  return { id, ...patch }
}

/** Deletes a target; IN_USE while an app names it (apps.target_id). */
export async function deleteTarget(
  id: number
): Promise<{ ok: true } | { ok: false; code: 'IN_USE' | 'NOT_FOUND' }> {
  return db.transaction(async (trx) => {
    if (!(await trx('nivaro_hub_targets').where({ id }).first('id')))
      return { ok: false, code: 'NOT_FOUND' as const }
    if (await trx('nivaro_hub_apps').where({ target_id: id }).first('id'))
      return { ok: false, code: 'IN_USE' as const }
    await trx('nivaro_hub_targets').where({ id }).del()
    return { ok: true as const }
  })
}

/** Plain text for a failed GitLab check: the code's meaning, never GitLab's answer. */
function why(err: unknown): string {
  if (err instanceof HubSecretError) return 'The saved token cannot be read (check ENCRYPTION_KEY)'
  if (err instanceof GitlabWriteError) {
    switch (err.code) {
      case 'GITLAB_NO_TOKEN':
        return 'No token saved'
      case 'GITLAB_UNAUTHORIZED':
        return 'GitLab refused the token (wrong, expired or revoked)'
      case 'GITLAB_FORBIDDEN':
        return 'GitLab refused: the token lacks the api scope or the role'
      case 'FETCH_REDIRECT':
        return 'GitLab redirected the call (check the address); refused'
      case 'GITLAB_UNREACHABLE':
        return 'GitLab did not answer'
      default:
        return `GitLab refused the call${err.status ? ` (${err.status})` : ''}`
    }
  }
  return 'The check failed'
}

/**
 * The target's Test button: does the token work, does the namespace exist, can the token see
 * the template? Read-only; each check says what failed. A failed token skips the other two.
 */
export async function testTarget(id: number): Promise<{ ok: boolean; checks: TargetCheck[] }> {
  const row = await getTargetRow(id)
  if (!row) {
    return { ok: false, checks: [{ id: 'token', ok: false, text: 'Target not found' }] }
  }
  const checks: TargetCheck[] = []
  if (row.connection_id != null) {
    const problem = row.connection?.problem ?? null
    checks.push(
      problem
        ? { id: 'connection', ok: false, text: problem }
        : {
            id: 'connection',
            ok: true,
            text: `Uses the connection ${row.connection?.name || `#${row.connection_id}`}`
          }
    )
    if (problem) {
      for (const id of ['token', 'namespace', 'template'] as const)
        checks.push({ id, ok: false, text: 'Skipped: the connection cannot be used' })
      return { ok: false, checks }
    }
  }
  let ctx: GitCtx
  try {
    ctx = targetCtx(row)
  } catch (err) {
    const text =
      err instanceof TargetMisconfiguredError ? 'The target has no GitLab address' : why(err)
    return {
      ok: false,
      checks: [
        ...checks,
        { id: 'token', ok: false, text },
        { id: 'namespace', ok: false, text: 'Skipped: the token does not work' },
        { id: 'template', ok: false, text: 'Skipped: the token does not work' }
      ]
    }
  }

  let me: { id: number; username: string }
  try {
    me = await currentUser(ctx)
    checks.push({ id: 'token', ok: true, text: `Token works (signed in as ${me.username})` })
  } catch (err) {
    checks.push({ id: 'token', ok: false, text: why(err) })
    checks.push({ id: 'namespace', ok: false, text: 'Skipped: the token does not work' })
    checks.push({ id: 'template', ok: false, text: 'Skipped: the token does not work' })
    return { ok: false, checks }
  }

  const { namespace, template_project: template } = row.config
  try {
    const ns = await namespaceExists(ctx, namespace)
    if (!ns) {
      checks.push({
        id: 'namespace',
        ok: false,
        text: `Namespace ${namespace} not found (or the token cannot see it)`
      })
    } else if (ns.kind === 'user') {
      checks.push(
        ns.full_path === me.username
          ? { id: 'namespace', ok: true, text: `Namespace ${namespace} is the token user's own` }
          : {
              id: 'namespace',
              ok: false,
              text: `Namespace ${namespace} belongs to another user; new projects cannot go there`
            }
      )
    } else {
      const level = await groupAccessLevel(ctx, ns.full_path, me.id)
      checks.push(
        level != null && level >= MAINTAINER
          ? {
              id: 'namespace',
              ok: true,
              text: `Namespace ${namespace} found (Maintainer or above)`
            }
          : {
              id: 'namespace',
              ok: false,
              text: `Namespace ${namespace} found, but the token user is not a Maintainer there`
            }
      )
    }
  } catch (err) {
    checks.push({ id: 'namespace', ok: false, text: `Namespace ${namespace}: ${why(err)}` })
  }

  try {
    const p = await projectExists(ctx, template)
    checks.push(
      p
        ? { id: 'template', ok: true, text: `Template ${p.path_with_namespace || template} found` }
        : {
            id: 'template',
            ok: false,
            text: `Template project ${template} not found (or the token cannot see it)`
          }
    )
  } catch (err) {
    checks.push({ id: 'template', ok: false, text: `Template ${template}: ${why(err)}` })
  }

  return { ok: checks.every((c) => c.ok), checks }
}
