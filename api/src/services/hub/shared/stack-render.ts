import type { StackSpec } from '../docker/agent-types.js'
import type { DockerDriverConfig } from '../docker/driver-config.js'
import { isAgentDnsName, MAX_STACK_HOSTNAMES, type StackEdge } from '../docker/render-spec.js'
import { agentAcceptsEnvKey, ENV_KEY_RE } from '../docker/stack-env.js'
import type { StackSize } from '../docker/templates.js'
import type { SharedDeployment } from './store.js'

/**
 * Nivaro Hub phase 6 (Task 5): the StackSpec of a Docker shared deployment — one process (or a
 * few replicas of it) serving every app the Hub lists for it. Pure: the run opens the token and
 * the deployment's secrets inside the call that sends the spec, and the answer is never logged or
 * stored (it carries them in plain text).
 *
 * What it holds:
 *  - owner `{shared: key}`, environment `shared` (preflight: the field is unspecified for shared).
 *  - ONE service, role `all` (no NIVARO_ROLE: every process serves, ticks crons through the
 *    leader lease and drains its own hand-offs), replicas small 1 / medium 2 / large 3. A shared
 *    deployment never runs a realtime role (the agent refuses ROLE_NOT_SHARED); a `web` role alone
 *    would leave exports, media and renders with nobody to drain them.
 *  - env: HUB_SHARED_DEPLOYMENT=<key> (the agent checks it equals owner.shared), HUB_URL,
 *    HUB_SHARED_EXTENSIONS (the allow-list, sorted), TRUST_PROXY=1 (behind the edge), its own
 *    REDIS_CHANNEL_PREFIX (a shared Redis never mixes it with another deployment's channels),
 *    NODE_ENV, MIGRATION_SAFE_MODE; COOKIE_SECURE=true on the traefik edge (TLS there). No DB_*:
 *    every app brings its own database through the Hub's list.
 *  - secrets: HUB_DEPLOYMENT_TOKEN (never env), SESSION_SECRET and ENCRYPTION_KEY (generated once
 *    by the run, kept sealed on the deployment row), REDIS_URL with external Redis.
 *  - routing (traefik edge): `host_pattern` plus the explicit names of placed apps that the
 *    pattern does not cover (≤ 10). Publish edge: no names, the settings' publish_port.
 *
 * Every key is checked against the agent's own rules before the spec leaves (the Hub's copy in
 * docker/stack-env.ts), with the two Hub-owned keys allowed only where a shared owner may carry
 * them; a spec the agent would refuse throws SharedRenderError with a code instead.
 */

export type SharedRenderCode =
  | 'HOSTNAME_INVALID'
  | 'TOO_MANY_HOSTNAMES'
  | 'NO_ROUTE'
  | 'PUBLISH_PORT_REQUIRED'
  | 'EXTENSION_UNPINNED'
  | 'REDIS_URL_MISSING'
  | 'HUB_URL_UNUSABLE'
  | 'KEY_REFUSED'
  | 'SECRETS_MISSING'

export class SharedRenderError extends Error {
  code: SharedRenderCode
  constructor(code: SharedRenderCode, message: string) {
    super(message)
    this.name = 'SharedRenderError'
    this.code = code
  }
}

/** The settings a shared deployment's `settings` JSON may hold for its stack. */
export interface SharedStackSettings {
  size: StackSize
  redis: 'bundled' | 'external'
  publish_port: number | null
  /** Deployment-wide plain variables (`settings.env`), e.g. a variable an extension needs. Every
   *  app on the deployment shares them: one process. Checked like a stack's plain settings. */
  env: Record<string, string>
}

/** The env keys the Hub sets on a shared stack itself: never taken from `settings.env`. */
export const SHARED_HUB_ENV_KEYS: readonly string[] = [
  'HUB_SHARED_DEPLOYMENT',
  'HUB_URL',
  'HUB_SHARED_EXTENSIONS',
  'TRUST_PROXY',
  'REDIS_CHANNEL_PREFIX',
  'NODE_ENV',
  'MIGRATION_SAFE_MODE',
  'COOKIE_SECURE'
]

/** Replicas of the one service, per size. */
export const SHARED_REPLICAS: Record<StackSize, number> = { small: 1, medium: 2, large: 3 }
/** Per replica: a shared process serves many apps. */
const SHARED_CPUS = 2
const SHARED_MEMORY_MB = 4096

/** The environment label of a shared stack (the agent's owner rule allows it). */
export const SHARED_STACK_ENVIRONMENT = 'shared'

/** The Hub-owned keys a shared owner carries (agent spec.ts SHARED_ENV_KEY / SHARED_SECRET_KEY). */
export const SHARED_ENV_KEY = 'HUB_SHARED_DEPLOYMENT'
export const SHARED_SECRET_KEY = 'HUB_DEPLOYMENT_TOKEN'

const PIN_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/
const PATTERN_RE = /^\*\.[a-z0-9-]+(\.[a-z0-9-]+)+$/

/** The stack settings of a deployment, with defaults (small, bundled Redis, no port). */
export function sharedStackSettings(
  shared: Pick<SharedDeployment, 'settings'>
): SharedStackSettings {
  const s = shared.settings ?? {}
  const size: StackSize =
    s.size === 'medium' || s.size === 'large' || s.size === 'small' ? s.size : 'small'
  const redis = s.redis === 'external' ? 'external' : 'bundled'
  const port = s.publish_port
  const env: Record<string, string> = {}
  const rawEnv = s.env
  if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv))
    for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>))
      if (typeof v === 'string') env[k] = v
  return {
    size,
    redis,
    publish_port: typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null,
    env
  }
}

/** The channel prefix a shared stack's processes use on Redis. */
export function sharedRedisPrefix(key: string): string {
  return `nvr-shared-${key}:`
}

/** True when `host` is one the pattern routes: exactly one label in front of the pattern's name. */
export function patternCovers(pattern: string | null, host: string): boolean {
  if (!pattern || !PATTERN_RE.test(pattern)) return false
  const base = pattern.slice(1) // '.apps.example.com'
  const h = host.toLowerCase()
  if (!h.endsWith(base)) return false
  const label = h.slice(0, h.length - base.length)
  return /^[a-z0-9-]+$/.test(label)
}

/**
 * The names placed apps answer on that the pattern does not cover, each once, lower-case, in the
 * order given. The renderer routes these with Host() rules beside the pattern.
 */
export function explicitHostsFor(names: Iterable<string>, pattern: string | null): string[] {
  const out: string[] = []
  for (const raw of names) {
    const h = String(raw ?? '')
      .trim()
      .toLowerCase()
    if (!h || out.includes(h) || patternCovers(pattern, h)) continue
    out.push(h)
  }
  return out
}

export interface RenderSharedInput {
  shared: SharedDeployment
  driver: DockerDriverConfig
  edge: StackEdge
  /** The deployment's opened secrets: SESSION_SECRET, ENCRYPTION_KEY (+ REDIS_URL when external). */
  secrets: Record<string, string>
  /** The deployment token, opened by the run. */
  token: string
  version: string
  /** <repo>@sha256:<64 hex> */
  image: string
  /** Extension id → <repo>@sha256:<64 hex>; every id of the allow-list needs one. */
  extensions: Record<string, string>
  /** The Hub's own origin the deployment calls (hubPublicOrigin()). */
  hubPublicUrl: string
  /** Names placed here that the pattern does not cover (explicitHostsFor). */
  explicitHosts: string[]
}

/** The http(s) origin of an address; '' when it is not one. */
function originOf(raw: string | null | undefined): string {
  try {
    const u = new URL(String(raw ?? ''))
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : ''
  } catch {
    return ''
  }
}

/** The pins of the allow-list, all or nothing; the ids without a pin. */
export function sharedExtensionPins(
  allowList: string[],
  pins: Record<string, string>
): { pins: Record<string, string>; missing: string[] } {
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const id of [...allowList].sort()) {
    const pin = pins[id]
    if (typeof pin === 'string' && PIN_RE.test(pin)) out[id] = pin
    else missing.push(id)
  }
  return { pins: out, missing }
}

export function renderSharedSpec(input: RenderSharedInput): StackSpec {
  const { shared, edge } = input
  const settings = sharedStackSettings(shared)

  const ext = sharedExtensionPins(shared.extensions, input.extensions)
  if (ext.missing.length)
    throw new SharedRenderError(
      'EXTENSION_UNPINNED',
      `No image pin for extension ${ext.missing.join(', ')}: set extension_pins on the shared deployment (<repo>@sha256:<64 hex>).`
    )

  const hostnames =
    edge === 'traefik' ? explicitHostsFor(input.explicitHosts, shared.host_pattern) : []
  const bad = hostnames.find((h) => !isAgentDnsName(h))
  if (bad !== undefined)
    throw new SharedRenderError(
      'HOSTNAME_INVALID',
      `${bad} is not a DNS name the agent can route (at least two labels: a–z, 0–9, -).`
    )
  if (hostnames.length > MAX_STACK_HOSTNAMES)
    throw new SharedRenderError(
      'TOO_MANY_HOSTNAMES',
      `A stack routes at most ${MAX_STACK_HOSTNAMES} names besides its pattern; ${hostnames.length} placed names are outside ${shared.host_pattern ?? 'a pattern'}.`
    )
  const pattern = edge === 'traefik' && shared.host_pattern ? shared.host_pattern : null
  if (edge === 'traefik' && !pattern && hostnames.length === 0)
    throw new SharedRenderError(
      'NO_ROUTE',
      'The stack would answer on no name: set a host pattern on the shared deployment, or place an app first.'
    )
  if (edge === 'publish' && settings.publish_port == null)
    throw new SharedRenderError(
      'PUBLISH_PORT_REQUIRED',
      'The agent publishes stacks on a port: set publish_port in the shared deployment settings.'
    )
  if (settings.redis === 'external' && !input.secrets.REDIS_URL)
    throw new SharedRenderError(
      'REDIS_URL_MISSING',
      'The shared deployment uses external Redis but has no REDIS_URL secret.'
    )
  const hubUrl = originOf(input.hubPublicUrl)
  if (!hubUrl)
    throw new SharedRenderError(
      'HUB_URL_UNUSABLE',
      'The Hub has no address a shared deployment can call: set HUB_URL on the Hub to its https origin.'
    )

  const ownKey = Object.keys(settings.env).find((k) => SHARED_HUB_ENV_KEYS.includes(k))
  if (ownKey !== undefined)
    throw new SharedRenderError('KEY_REFUSED', `${ownKey} is set by the Hub on a shared stack.`)
  const env: Record<string, string> = {
    // Deployment-wide variables first: the Hub's own keys below are never overridden.
    ...settings.env,
    [SHARED_ENV_KEY]: shared.key,
    HUB_URL: hubUrl,
    HUB_SHARED_EXTENSIONS: Object.keys(ext.pins).sort().join(','),
    TRUST_PROXY: '1',
    REDIS_CHANNEL_PREFIX: sharedRedisPrefix(shared.key),
    NODE_ENV: 'production',
    MIGRATION_SAFE_MODE: 'true'
  }
  if (edge === 'traefik') env.COOKIE_SECURE = 'true'

  const secrets: Record<string, string> = { [SHARED_SECRET_KEY]: input.token }
  // Every process needs both to boot (SESSION_SECRET is required in every mode): never omitted.
  for (const k of ['SESSION_SECRET', 'ENCRYPTION_KEY'] as const) {
    if (!input.secrets[k])
      throw new SharedRenderError(
        'SECRETS_MISSING',
        `The shared deployment has no ${k}: it is made on the first deploy — deploy again.`
      )
    secrets[k] = input.secrets[k]
  }
  if (settings.redis === 'external') secrets.REDIS_URL = input.secrets.REDIS_URL

  // The agent's own rules, as the Hub knows them: every key allowed and not refused, except the
  // two Hub-owned keys in their one place each (agent spec.ts, ruling R12).
  for (const [k, where] of [
    ...Object.keys(env).map((k) => [k, 'env'] as const),
    ...Object.keys(secrets).map((k) => [k, 'secret'] as const)
  ]) {
    if (where === 'env' && k === SHARED_ENV_KEY) continue
    if (where === 'secret' && k === SHARED_SECRET_KEY) continue
    if (!ENV_KEY_RE.test(k) || !agentAcceptsEnvKey(k, settings.redis))
      throw new SharedRenderError('KEY_REFUSED', `The agent would refuse ${k} on a shared stack.`)
  }
  const clash = Object.keys(secrets).find((k) => Object.hasOwn(env, k))
  if (clash !== undefined)
    throw new SharedRenderError('KEY_REFUSED', `${clash} is both an env value and a secret.`)

  const spec: StackSpec = {
    owner: { shared: shared.key },
    environment: SHARED_STACK_ENVIRONMENT,
    image: input.image,
    roles: [
      {
        role: 'all',
        replicas: SHARED_REPLICAS[settings.size],
        cpus: SHARED_CPUS,
        memory_mb: SHARED_MEMORY_MB
      }
    ],
    env,
    secrets,
    hostnames,
    redis: settings.redis,
    extensions: ext.pins
  }
  if (pattern) spec.host_pattern = pattern
  if (edge === 'publish' && settings.publish_port != null) spec.publish_port = settings.publish_port
  return spec
}

/** Any whitespace or control character (code point < 0x21 or 0x7f). */
function hasSpaceOrControl(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c <= 0x20 || c === 0x7f) return true
  }
  return /\s/.test(v)
}

/** The secrets a PATCH of a shared deployment may write (ruling P6-16): external Redis only. */
export const SHARED_WRITABLE_SECRETS = ['REDIS_URL'] as const

/**
 * Checks a PATCH's write-only `secrets` object: only REDIS_URL, a redis:// or rediss:// URL with a
 * host (≤ 2048 characters, no spaces or control characters), or null / '' to clear it. Pure; the
 * value never appears in the refusal.
 */
export function checkSharedSecretsInput(
  raw: unknown
): { ok: true; secrets: Record<string, string | null> } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return bad('secrets is an object: {"REDIS_URL": "rediss://…"}.')
  const out: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SHARED_WRITABLE_SECRETS as readonly string[]).includes(k))
      return bad(`Only ${SHARED_WRITABLE_SECRETS.join(', ')} can be set here.`)
    if (v === null || v === '') {
      out[k] = null
      continue
    }
    if (typeof v !== 'string' || v.length > 2048 || hasSpaceOrControl(v))
      return bad('REDIS_URL is a redis:// or rediss:// URL.')
    let u: URL
    try {
      u = new URL(v)
    } catch {
      return bad('REDIS_URL is a redis:// or rediss:// URL.')
    }
    if ((u.protocol !== 'redis:' && u.protocol !== 'rediss:') || !u.hostname || u.hash)
      return bad('REDIS_URL is a redis:// or rediss:// URL with a host.')
    out[k] = v
  }
  if (!Object.keys(out).length) return bad('secrets names nothing to set.')
  return { ok: true, secrets: out }
}
